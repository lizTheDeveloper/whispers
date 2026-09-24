/**
 * Pronoun consistency for DM-authored prose, checked in code and repaired by
 * a small, focused LLM rewrite.
 *
 * A live table (Liz = she/her, Biz = they/them, both stated in the
 * interview) still got "give way under his finger… tingles on his skin" in a
 * resolution and "a tingling stain on his palm" in the epilogue. The prompts
 * carry every stated pronoun; the model does not always follow them. A
 * rule-based rewrite of he/she was tried once and wrote clumsy, mixed prose
 * ("…clinging to their boots as Biz steps…"), so the repair here is the
 * model's, and the code only decides WHEN to ask and whether to KEEP it:
 *
 *  1. A cheap deterministic pre-filter (findPronounConflicts). It follows
 *     who each sentence is about: a sentence naming one party member is
 *     theirs, and so are the sentences after it that name nobody, up to the
 *     next party member, a known NPC, or a paragraph break. A resolution
 *     starts out about its actor even before they are named. A conflicting
 *     pronoun or gendered word in the naming sentence, or in the one right
 *     after it, is a conflict; further along the run it takes two or more
 *     (one stray "his" three sentences on may be an NPC's; "her eyes… her
 *     fingertips… she hoped" is about the subject). A word another named
 *     party member or a named NPC could own is not a conflict. Members with
 *     no stated pronouns are never checked. A sentence that asks about
 *     pronouns, and lists of options ("she/her, he/him"), are never read.
 *  2. The simple case is repaired in code (deterministicRepairs): a
 *     sentence naming only a they/them member, no NPC in it or just before
 *     it, and he- or she-words nobody else at the table could own — "Biz's
 *     voice rings clear as he declares…" → "…as they declare…".
 *  3. Anything else: one LLM call with a tiny prompt: rewrite the passage so
 *     each LISTED party member has their stated pronouns; everyone else,
 *     the NPCs present by name, keeps theirs.
 *  4. The rewrite is used sentence by sentence (spliceRewrite): only the
 *     sentences the pre-filter flagged take the model's wording, and inside
 *     them every pronoun option list stays as written. The rest keep the
 *     original — live, the model turned an NPC's "she chirps, her voice"
 *     into "they chirp, their voice" and an imp's "He holds up" into "They
 *     hold up". A flagged sentence changed beyond pronouns and verb
 *     agreement keeps its original; a rewrite that lost a sentence, lost a
 *     party name or moved the length by more than 15% is rejected whole: a
 *     missed repair is a slip, a rewritten scene is a bug.
 */
import { callLlm, isLlmAbort } from './agents/llm-client.js';
import { kinAddressTerms, namesInNarration, quoteRuns } from './narrative-guards.js';
import type { CharacterDefinition } from '../shared/types.js';
import { agree, pluralVerb, pronounSet } from '../shared/pronouns.js';

export interface PronounMember {
  name: string;
  /** As the player stated it ("she/her", "they/them", "xe/xem"). Unset = not stated: never checked. */
  pronouns?: string | null;
}

type Key = 'she' | 'he' | 'they' | 'other';

const FORMS: Record<'she' | 'he' | 'they', string[]> = {
  she: ['she', 'her', 'hers', 'herself'],
  he: ['he', 'him', 'his', 'himself'],
  they: ['they', 'them', 'their', 'theirs', 'themself', 'themselves'],
};
/** Nouns that state a gender about the person they describe. Kept tight: "man" and "woman" are too often someone else. */
const WORDS: Record<'she' | 'he', string[]> = {
  she: ['girl', 'daughter', 'lass'],
  he: ['boy', 'son', 'lad'],
};

function keyOf(pronouns: string | null | undefined): Key | null {
  const first = pronouns?.trim().toLowerCase().split(/[\/,\s]+/).filter(Boolean)[0];
  if (!first) return null;
  if (first === 'she' || first === 'her') return 'she';
  if (first === 'he' || first === 'him') return 'he';
  if (first === 'they' || first === 'them') return 'they';
  return 'other';
}

/** Words that misgender someone with these pronouns. "they" is never one: it is also the plural. */
function conflictingWords(key: Key): Set<string> {
  switch (key) {
    case 'she': return new Set([...FORMS.he, ...WORDS.he]);
    case 'he': return new Set([...FORMS.she, ...WORDS.she]);
    default: return new Set([...FORMS.he, ...FORMS.she, ...WORDS.he, ...WORDS.she]);
  }
}

/** Words that could belong to this member. Unstated pronouns could own any of them. */
function couldOwn(member: PronounMember, word: string): boolean {
  const key = keyOf(member.pronouns);
  if (!key) return true;
  return !conflictingWords(key).has(word);
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mentions(sentence: string, member: PronounMember): boolean {
  return new RegExp(`\\b${esc(firstName(member.name))}\\b`).test(sentence);
}

const SENTENCE_BREAK = /(?<=[.!?…]["”’']?)\s+|\n+/g;

/** Sentences, split after terminal punctuation (and any closing quote) or a line break. */
export function splitSentences(text: string): string[] {
  return text.split(SENTENCE_BREAK).map(s => s.trim()).filter(Boolean);
}

interface Piece {
  text: string;
  /** The whitespace after it, as written (so the passage can be put back together exactly). */
  sep: string;
}

/** The passage as sentences with their separators: pieces.map(p => p.text + p.sep).join('') === text minus leading space. */
function pieces(text: string): { lead: string; list: Piece[] } {
  const lead = text.match(/^\s*/)?.[0] ?? '';
  const body = text.slice(lead.length);
  const list: Piece[] = [];
  let last = 0;
  const push = (t: string, sep: string) => {
    // Nothing but space between two breaks: part of the separator before it.
    if (t.trim().length === 0 && list.length > 0) list[list.length - 1]!.sep += t + sep;
    else list.push({ text: t, sep });
  };
  for (const m of body.matchAll(SENTENCE_BREAK)) {
    push(body.slice(last, m.index), m[0]);
    last = m.index! + m[0].length;
  }
  if (last < body.length) push(body.slice(last), '');
  return { lead, list };
}

/** Pronoun sets written as options: "she/her", "he/him/his", "they / them". */
const OPTION_LIST = /\b[a-z]+(?:\s*\/\s*[a-z]+)+\b/gi;

/** A sentence about pronouns themselves — the interview's question. Never read, never rewritten. */
function asksAboutPronouns(sentence: string): boolean {
  return /\bpronouns?\b/i.test(sentence);
}

/**
 * The words of a sentence, minus pronoun sets written as options ("she/her",
 * "he/him/his", "they / them"): asking which pronouns to use is not using one.
 */
function wordsIn(sentence: string): string[] {
  const withoutOptions = sentence.toLowerCase().replace(OPTION_LIST, ' ');
  return (withoutOptions.match(/[a-z]+/g) ?? []);
}

export interface PronounConflict {
  name: string;
  pronouns: string;
  word: string;
  sentence: string;
}

export interface ConflictOptions {
  /** Whose action this passage resolves: it is about them until someone else is named. */
  actor?: string | null;
  /** NPCs by name. A sentence naming one is theirs, and a word they could own is not a conflict. */
  npcNames?: string[];
}

/** Capitalised words in an NPC's name that are not how anyone refers to them alone. */
const NOT_A_NAME = new Set(['the', 'and', 'of', 'old', 'young', 'great', 'little', 'lady', 'lord', 'sir', 'dame', 'mister', 'miss', 'madam', 'master']);

/** Does a sentence name one of these NPCs (by full name or any capitalised word of it)? */
function npcMatcher(members: PronounMember[], npcNames: string[]): (sentence: string) => boolean {
  const partyFirst = new Set(members.map(m => firstName(m.name).toLowerCase()));
  const npcs = npcNames.map(n => n.trim()).filter(n => n && !partyFirst.has(firstName(n).toLowerCase()));
  // An NPC is named by their full name or any capitalised word of it ("Pell",
  // "Tilly") — never an article ("The Registrar" is not every "The").
  const npcWords = [...new Set(npcs.flatMap(n => [n, ...n.split(/\s+/).filter(w => /^[A-Z]/.test(w) && w.length >= 3 && !NOT_A_NAME.has(w.toLowerCase()))]))];
  const npcRe = npcWords.length > 0 ? new RegExp(`(?<![\\w'’-])(?:${npcWords.map(esc).join('|')})(?![\\w'’-])`) : null;
  return (sentence: string) => !!npcRe && npcRe.test(sentence);
}

interface Flagged extends PronounConflict {
  index: number;
}

function flagConflicts(list: string[], breaks: boolean[], members: PronounMember[], opts: ConflictOptions): Flagged[] {
  const out: Flagged[] = [];
  const seen = new Set<string>();
  const add = (m: PronounMember, word: string, index: number) => {
    const k = `${m.name}|${word}|${index}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ name: m.name, pronouns: m.pronouns!.trim(), word, sentence: list[index]!, index });
  };
  const namesNpc = npcMatcher(members, opts.npcNames ?? []);
  const bad = (m: PronounMember) => conflictingWords(keyOf(m.pronouns)!);

  // The current run: whose sentences these are, and the conflicts found in
  // them (immediate: in the sentence right after the naming one).
  let run: { member: PronounMember; hits: Array<{ word: string; index: number; immediate: boolean }>; sinceNamed: number } | null = null;
  const flush = () => {
    if (run && run.hits.length > 0) {
      const strong = run.hits.length >= 2;
      for (const h of run.hits) if (h.immediate || strong) add(run.member, h.word, h.index);
    }
    run = null;
  };
  const stated = (m: PronounMember | undefined) => (m && keyOf(m.pronouns) ? m : undefined);
  const actor = stated(members.find(m => opts.actor && firstName(m.name).toLowerCase() === firstName(opts.actor).toLowerCase()));
  if (actor) run = { member: actor, hits: [], sinceNamed: 2 };

  list.forEach((sentence, i) => {
    if (asksAboutPronouns(sentence)) return;
    const named = members.filter(m => mentions(sentence, m));
    const npcHere = namesNpc(sentence);
    if (named.length > 0) {
      flush();
      for (const m of named) {
        if (!stated(m)) continue;
        const b = bad(m);
        for (const w of wordsIn(sentence)) {
          if (!b.has(w)) continue;
          // "Liz takes Biz's hand in her own": the word is Liz's to own.
          if (named.some(o => o !== m && couldOwn(o, w))) continue;
          // "Biz shows Squeak-Ink the stamp, and he grins": the imp's.
          if (npcHere) continue;
          add(m, w, i);
        }
      }
      const only = named.length === 1 && !npcHere ? stated(named[0]) : undefined;
      if (only) run = { member: only, hits: [], sinceNamed: 0 };
    } else if (npcHere) {
      flush();
    } else if (run) {
      run.sinceNamed++;
      const b = bad(run.member);
      for (const w of wordsIn(sentence)) if (b.has(w)) run.hits.push({ word: w, index: i, immediate: run.sinceNamed === 1 });
    }
    if (breaks[i]) flush();
  });
  flush();
  return out;
}

/**
 * Every place a party member with stated pronouns is called by a word that
 * contradicts them. Empty when there is nothing to fix — the common case,
 * which costs no LLM call.
 */
export function findPronounConflicts(text: string, members: PronounMember[], opts: ConflictOptions = {}): PronounConflict[] {
  if (!text) return [];
  const { list } = pieces(text);
  return flagConflicts(list.map(p => p.text.trim()), list.map(p => p.sep.includes('\n')), members, opts)
    .map(({ index: _i, ...c }) => c);
}

/**
 * A rewrite is kept only when it is the same passage: within ±15% of the
 * original's length, and still naming every party member the original named.
 */
export function acceptRewrite(original: string, rewrite: string | null | undefined, names: string[]): boolean {
  const r = rewrite?.trim();
  if (!r) return false;
  const o = original.trim();
  if (Math.abs(r.length - o.length) > o.length * 0.15) return false;
  for (const n of names) {
    const re = new RegExp(`\\b${esc(firstName(n))}\\b`);
    if (re.test(o) && !re.test(r)) return false;
  }
  return true;
}

type Llm = (messages: Array<{ role: string; content: string }>) => Promise<string>;

const defaultLlm: Llm = async (messages) => String(await callLlm({
  messages,
  temperature: 0.2,
  // Short passage out, but the reasoning model spends this budget thinking first.
  maxTokens: 2048,
}));

/** The marker the rewrite prompt starts with (tests key their stubs on it). */
export const PRONOUN_REWRITE_MARKER = 'You correct how people are referred to in a passage';

const REWRITE_RULES = 'Change NOTHING else: keep every other word, sentence, name, line break and punctuation mark as it is, apart from the pronoun and whatever verb agreement it needs ("they are", not "they is"). Pronouns and words for anyone else — NPCs, creatures, objects — stay exactly as written. A list of pronoun options ("she/her, he/him, they/them") is never changed. Reply with the passage only: no preamble, no quotation marks around it, no notes.';

const ALL_FORMS = new Set([...FORMS.she, ...FORMS.he, ...FORMS.they, ...WORDS.she, ...WORDS.he]);
/** Verb agreement a pronoun change brings with it. */
const AGREEMENT: Record<string, string> = { are: 'is', were: 'was', have: 'has', do: 'does', "they're": "is", "she's": 'is', "he's": 'is' };

/**
 * A sentence with its pronouns (and gendered words) taken out and verb
 * agreement undone: "she chirps, her voice" and "they chirp, their voice"
 * read the same; "Tilly Tink, the thief, grabs the seal" does not.
 */
function skeleton(sentence: string): string {
  return (sentence.toLowerCase().replace(OPTION_LIST, ' / ').match(/[a-z'’/]+/g) ?? [])
    // A quotation mark is not part of a word: 'A letter.' and "A letter." read the same.
    .map(w => w.replace(/’/g, "'").replace(/^'+|'+$/g, ''))
    .filter(w => w && !ALL_FORMS.has(w))
    .map(w => AGREEMENT[w] ?? w)
    // Verb agreement both ways: "he declares" and "they declare" are the
    // same sentence. (Stripping a bare -s/-es made "declares" "declar" but
    // "declare" "declare" — live, that rejected every repair of a sentence
    // like "Biz's voice rings clear as he declares…".)
    .map(w => pluralVerb(w))
    .join(' ');
}

/** The pronoun option lists in a sentence, in order. */
const optionLists = (sentence: string) => sentence.match(OPTION_LIST) ?? [];

/**
 * The rewrite, taken sentence by sentence: a flagged sentence gets the
 * model's wording when it differs from the original only in pronouns and
 * verb agreement (with every pronoun option list put back as the original
 * wrote it); a flagged sentence the model changed beyond that, and every
 * sentence that was not flagged, keep the original. Null — reject it whole —
 * only when the sentence count differs (the sentences cannot be lined up).
 *
 * Per sentence, not all-or-nothing: live, one flagged sentence the check
 * could not accept threw away the good repair of every other one, and the
 * table read "he declares… around him… his shoulder" as written.
 */
export function spliceRewrite(original: string, rewritten: string, flagged: Set<number>): string | null {
  const o = pieces(original);
  const r = pieces(rewritten.trim());
  if (o.list.length !== r.list.length) return null;
  const out: string[] = [o.lead];
  for (let i = 0; i < o.list.length; i++) {
    const before = o.list[i]!.text;
    let after = before;
    if (flagged.has(i) && !asksAboutPronouns(before)) {
      const candidate = r.list[i]!.text;
      if (skeleton(before) !== skeleton(candidate)) {
        console.warn(`[pronouns] sentence ${i + 1} was rewritten beyond pronouns; kept as written: "${before.slice(0, 100)}" → "${candidate.slice(0, 100)}"`);
      } else {
        const lists = optionLists(before);
        const got = optionLists(candidate);
        if (lists.length === got.length) {
          let k = 0;
          after = lists.length > 0 ? candidate.replace(OPTION_LIST, () => lists[k++]!) : candidate;
        }
      }
    }
    out.push(after + o.list[i]!.sep);
  }
  return out.join('');
}

/**
 * Run the rewrite and keep only what spliceRewrite and acceptRewrite allow.
 * Never throws for a failed or bad rewrite (the original is returned); a
 * cancelled call (pause, End Game) is re-thrown so the loop's pause
 * handling sees it.
 */
async function rewrite(text: string, system: string, user: string, names: string[], flagged: Set<number>, llm: Llm, label: string): Promise<string> {
  let out: string;
  try {
    out = await llm([{ role: 'system', content: system }, { role: 'user', content: user }]);
  } catch (e) {
    if (isLlmAbort(e)) throw e;
    console.error(`[pronouns] ${label} rewrite failed; keeping the original:`, e);
    return text;
  }
  const cleaned = out.trim();
  if (!acceptRewrite(text, cleaned, names)) {
    console.warn(`[pronouns] ${label} rewrite rejected (length moved more than 15% or a party name was lost); keeping the original`);
    return text;
  }
  const spliced = spliceRewrite(text, cleaned, flagged);
  if (spliced === null || !acceptRewrite(text, spliced, names)) {
    console.warn(`[pronouns] ${label} rewrite rejected (${spliced === null ? `${splitSentences(cleaned).length} sentences for ${splitSentences(text).length}` : 'changed too much'}); keeping the original`);
    return text;
  }
  if (spliced !== text) console.log(`[pronouns] ${label}: "${text.slice(0, 80)}" → "${spliced.slice(0, 80)}"`);
  return spliced;
}

// ─── The simple case, repaired in code ─────────────────────────────────────

const HE_FAMILY = new Set(FORMS.he);
const SHE_FAMILY = new Set(FORMS.she);
/** After an object "her", these words mean it was not a possessive: "gives her the key", "to her.", "her again". */
const AFTER_OBJECT_HER = new Set(['the', 'a', 'an', 'to', 'and', 'or', 'but', 'as', 'with', 'into', 'onto', 'from', 'at', 'in', 'on', 'up', 'down', 'out', 'off', 'back', 'away', 'over', 'under', 'of', 'for', 'by', 'this', 'that', 'these', 'those', 'some', 'any', 'every', 'again', 'too', 'once', 'close', 'closer', 'aside', 'forward', 'through', 'toward', 'towards', 'along', 'around', 'about', 'behind', 'beside', 'while', 'when', 'until', 'so', 'if', 'than', 'is', 'was', 'are', 'were', 'will', 'would', 'can', 'could', 'no', 'one', 'something', 'nothing', 'everything', 'anything', 'what', 'how', 'why', 'where', 'who', 'enough', 'now', 'then', 'here', 'there']);
/** Words that may sit between a subject and its verb ("he quickly declares", "she still hopes"). */
const BETWEEN_SUBJECT_AND_VERB = String.raw`(?:[a-z]+ly|still|just|also|then|now|only|always|never|even|already|too)`;

function matchCase(model: string, word: string): string {
  return /^[A-Z]/.test(model) ? word[0]!.toUpperCase() + word.slice(1) : word;
}

/**
 * A they/them member's he- or she-words, outside quoted speech, as they-words,
 * with the verb right after a subject pronoun agreeing: "as he declares" →
 * "as they declare", "around him" → "around them", "his shoulder" → "their
 * shoulder", "she is" → "they are". Only for the high-confidence case (see
 * deterministicRepairs); anything unsure goes to the model.
 */
export function toTheyThem(sentence: string): string {
  const they = pronounSet('they/them')!;
  return quoteRuns(sentence).map(run => {
    if (run.quoted) return run.text;
    return run.text.replace(/\b(he|she|him|his|her|hers|himself|herself)(['’](?:s|d|ll))?\b/gi, (match: string, word: string, contraction: string | undefined, offset: number, whole: string) => {
      const w = word.toLowerCase();
      const rest = whole.slice(offset + match.length);
      if (w === 'he' || w === 'she') {
        if (contraction) {
          const c = contraction.slice(1).toLowerCase();
          const apos = contraction[0]!;
          if (c === 's') return matchCase(word, /^\s+(?:been|got|gotten|had)\b/i.test(rest) ? `they${apos}ve` : `they${apos}re`);
          return matchCase(word, `they${contraction}`);
        }
        return matchCase(word, 'they');
      }
      if (contraction) return match; // "his's" does not happen; leave anything odd alone
      if (w === 'him') return matchCase(word, 'them');
      if (w === 'himself' || w === 'herself') return matchCase(word, 'themself');
      if (w === 'hers') return matchCase(word, 'theirs');
      const next = rest.match(/^\s+([A-Za-z][\w'’-]*)/)?.[1];
      if (w === 'his') return matchCase(word, next ? 'their' : 'theirs');
      // her: "her hand" is possessive; "to her", "gives her the key", "her." are not.
      return matchCase(word, next && !AFTER_OBJECT_HER.has(next.toLowerCase()) ? 'their' : 'them');
    }).replace(new RegExp(`\\b([Tt]hey)((?:\\s+${BETWEEN_SUBJECT_AND_VERB})*)\\s+([A-Za-z][\\w'’]*)`, 'g'), (_m: string, pron: string, between: string, verb: string) =>
      // The caller passes only sentences with no "they" of their own, so
      // every "they" here was a he or she a moment ago: its verb agrees.
      `${pron}${between} ${agree(they, verb, pluralVerb(verb))}`);
  }).join('');
}

/**
 * Flagged sentences that code can repair on its own, by index: the sentence
 * names exactly one party member — a they/them member, and the one every
 * conflict in it belongs to — names no NPC (nor does the sentence before
 * it), has no "they" of its own, and its he/she-words, outside quotes, are
 * all of one family that nobody else at the table could own. "Biz's voice
 * rings clear as he declares 'A letter.'" is the case; "her hand on his
 * shoulder" (two people) is not, and goes to the model.
 */
function deterministicRepairs(list: string[], conflicts: Flagged[], members: PronounMember[], npcNames: string[]): Map<number, string> {
  const out = new Map<number, string>();
  const namesNpc = npcMatcher(members, npcNames);
  const byIndex = new Map<number, Flagged[]>();
  for (const c of conflicts) byIndex.set(c.index, [...(byIndex.get(c.index) ?? []), c]);
  for (const [i, cs] of byIndex) {
    const sentence = list[i]!;
    const owner = members.find(m => m.name === cs[0]!.name);
    if (!owner || keyOf(owner.pronouns) !== 'they' || cs.some(c => c.name !== owner.name)) continue;
    const named = members.filter(m => mentions(sentence, m));
    if (named.length !== 1 || named[0] !== owner) continue;
    if (namesNpc(sentence) || (i > 0 && namesNpc(list[i - 1]!))) continue;
    const unquoted = quoteRuns(sentence).filter(r => !r.quoted).map(r => r.text).join(' ');
    const words = wordsIn(unquoted);
    if (words.some(w => FORMS.they.includes(w))) continue;
    const he = words.some(w => HE_FAMILY.has(w));
    const she = words.some(w => SHE_FAMILY.has(w));
    if (he === she) continue; // none, or both: two people
    const family: Key = he ? 'he' : 'she';
    // "Biz leans into her embrace" at a table with Liz (she/her): hers, maybe.
    if (members.some(m => m !== owner && keyOf(m.pronouns) !== 'they' && keyOf(m.pronouns) !== (family === 'he' ? 'she' : 'he'))) continue;
    const fixed = toTheyThem(sentence);
    if (fixed !== sentence && skeleton(fixed) === skeleton(sentence)) out.set(i, fixed);
  }
  return out;
}

/**
 * DM prose with every party member referred to by their stated pronouns.
 * No LLM call unless the pre-filter finds something the code cannot repair
 * itself; only the sentences it flagged can change.
 */
export async function withConsistentPronouns(text: string, members: PronounMember[], opts: ConflictOptions & { llm?: Llm } = {}): Promise<string> {
  if (!text) return text;
  const { lead, list: ps } = pieces(text);
  const trimmed = ps.map(p => p.text.trim());
  const conflicts = flagConflicts(trimmed, ps.map(p => p.sep.includes('\n')), members, opts);
  if (conflicts.length === 0) return text;
  console.log(`[pronouns] ${conflicts.map(c => `"${c.word}" near ${c.name} (${c.pronouns}) in sentence ${c.index + 1}`).join('; ')}`);

  // The simple case first, in code: no model, nothing to reject.
  const fixed = deterministicRepairs(trimmed, conflicts, members, opts.npcNames ?? []);
  let current = text;
  if (fixed.size > 0) {
    current = lead + ps.map((p, i) => {
      const f = fixed.get(i);
      return (f !== undefined ? p.text.replace(trimmed[i]!, f) : p.text) + p.sep;
    }).join('');
    console.log(`[pronouns] repaired in code: ${[...fixed.entries()].map(([i, f]) => `"${trimmed[i]!.slice(0, 60)}" → "${f.slice(0, 60)}"`).join('; ')}`);
  }
  const remaining = new Set(conflicts.map(c => c.index).filter(i => !fixed.has(i)));
  if (remaining.size === 0) return current;

  const stated = members.filter(m => keyOf(m.pronouns));
  const list = stated.map(m => `- ${m.name}: ${m.pronouns!.trim()}`).join('\n');
  const partyFirst = new Set(members.map(m => firstName(m.name).toLowerCase()));
  const others = [...new Set((opts.npcNames ?? []).map(n => n.trim()).filter(n => n && !partyFirst.has(firstName(n).toLowerCase()) && current.includes(firstName(n))))];
  const othersLine = others.length > 0 ? ` Everyone else keeps their pronouns exactly as written — including ${others.join(', ')}.` : '';
  const system = `${PRONOUN_REWRITE_MARKER}. Rewrite this passage so that each party member listed is referred to with their stated pronouns. Change pronouns for only the listed party members, and only where the word refers to that member.${othersLine} ${REWRITE_RULES}`;
  const user = `Party members and their stated pronouns:\n${list}\n\nPassage:\n${current}`;
  console.log(`[pronouns] asking for a rewrite of sentence${remaining.size === 1 ? '' : 's'} ${[...remaining].map(i => i + 1).join(', ')}`);
  return rewrite(current, system, user, members.map(m => m.name), remaining, opts.llm ?? defaultLlm, 'narration');
}

const GENDERED = new Set([...FORMS.he, ...FORMS.she]);

/**
 * An interview reply about a character whose pronouns nobody has stated yet
 * uses their name or "they" — never he or she. The pre-filter: a gendered
 * pronoun in a sentence that names no one else at the table (a sentence
 * about Liz, whose player said she/her, may call her "her").
 */
export function interviewGendersCharacter(reply: string, otherNames: string[]): boolean {
  return gendersIn(splitSentences(reply), otherNames).size > 0;
}

/** Which sentences call the character being made he or she — never the one asking for pronouns. */
function gendersIn(sentences: string[], otherNames: string[]): Set<number> {
  const out = new Set<number>();
  sentences.forEach((s, i) => {
    if (asksAboutPronouns(s)) return;
    if (otherNames.some(n => n.trim() && new RegExp(`\\b${esc(firstName(n))}\\b`).test(s))) return;
    if (wordsIn(s).some(w => GENDERED.has(w))) out.add(i);
  });
  return out;
}

/**
 * The interview reply with the character being made referred to by name or
 * "they" until their pronouns are stated. No LLM call unless a gendered
 * pronoun appears in a sentence that could only be about them.
 */
export async function interviewReplyWithoutGuessedGender(reply: string, character: { name?: string | null; otherNames: string[] }, opts: { llm?: Llm } = {}): Promise<string> {
  if (!reply) return reply;
  const flagged = gendersIn(pieces(reply).list.map(p => p.text.trim()), character.otherNames);
  if (flagged.size === 0) return reply;
  const who = character.name?.trim() ? `the character being created, ${character.name.trim()}` : 'the character being created (the player\'s character)';
  const system = `${PRONOUN_REWRITE_MARKER}. Nobody has said yet how ${who} should be referred to. Rewrite this passage so that every word referring to that character uses their name or they/them/their — never he, him, his, she or her. ${REWRITE_RULES}`;
  const user = `Passage:\n${reply}`;
  const names = [...(character.name?.trim() ? [character.name.trim()] : []), ...character.otherNames];
  return rewrite(reply, system, user, names, flagged, opts.llm ?? defaultLlm, 'interview');
}

/**
 * The character interviewer's reply as the player sees it. It is the DM
 * talking, so a companion is called by name ("traveling with Mom Liz" →
 * "traveling with Liz"; quoted speech untouched), and until the sheet
 * states pronouns the character being made is never he or she.
 */
export async function guardInterviewReply(
  reply: string,
  sheet: Pick<CharacterDefinition, 'name' | 'pronouns' | 'relationships'> | null,
  tableNames: string[],
  opts: { llm?: Llm } = {},
): Promise<string> {
  if (!reply) return reply;
  const own = (sheet?.relationships ?? []).flatMap(r => r.address?.trim() && r.to?.trim() ? [{ name: r.to.trim(), address: r.address.trim() }] : []);
  // "their mom Liz" with a sheet that says "mother" but no address term yet.
  const terms = [...own, ...kinAddressTerms(sheet?.relationships ?? [], tableNames)];
  let out = terms.length > 0 ? namesInNarration(reply, terms) : reply;
  if (!sheet?.pronouns?.trim()) {
    const otherNames = [...new Set([...tableNames, ...own.map(t => t.name)])].filter(n => !sheet?.name || firstName(n).toLowerCase() !== firstName(sheet.name).toLowerCase());
    out = await interviewReplyWithoutGuessedGender(out, { name: sheet?.name ?? null, otherNames }, opts);
  }
  return out;
}
