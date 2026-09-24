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
 *  2. When it fires, one LLM call with a tiny prompt: rewrite the passage so
 *     each LISTED party member has their stated pronouns; everyone else,
 *     the NPCs present by name, keeps theirs.
 *  3. The rewrite is used sentence by sentence (spliceRewrite): only the
 *     sentences the pre-filter flagged take the model's wording, and inside
 *     them every pronoun option list stays as written. The rest keep the
 *     original — live, the model turned an NPC's "she chirps, her voice"
 *     into "they chirp, their voice" and an imp's "He holds up" into "They
 *     hold up". A rewrite that changed anything beyond pronouns and verb
 *     agreement, lost a sentence, lost a party name or moved the length by
 *     more than 15% is rejected whole: a missed repair is a slip, a
 *     rewritten scene is a bug.
 */
import { callLlm, isLlmAbort } from './agents/llm-client.js';
import { kinAddressTerms, namesInNarration } from './narrative-guards.js';
import type { CharacterDefinition } from '../shared/types.js';

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
  const partyFirst = new Set(members.map(m => firstName(m.name).toLowerCase()));
  const npcs = (opts.npcNames ?? []).map(n => n.trim()).filter(n => n && !partyFirst.has(firstName(n).toLowerCase()));
  // An NPC is named by their full name or any capitalised word of it ("Pell",
  // "Tilly") — never an article ("The Registrar" is not every "The").
  const npcWords = [...new Set(npcs.flatMap(n => [n, ...n.split(/\s+/).filter(w => /^[A-Z]/.test(w) && w.length >= 3 && !NOT_A_NAME.has(w.toLowerCase()))]))];
  const npcRe = npcWords.length > 0 ? new RegExp(`(?<![\\w'’-])(?:${npcWords.map(esc).join('|')})(?![\\w'’-])`) : null;
  const namesNpc = (sentence: string) => !!npcRe && npcRe.test(sentence);
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
    .map(w => w.replace(/’/g, "'"))
    .filter(w => !ALL_FORMS.has(w))
    .map(w => AGREEMENT[w] ?? w)
    .map(w => w.replace(/(?:es|s)$/, ''))
    .join(' ');
}

/** The pronoun option lists in a sentence, in order. */
const optionLists = (sentence: string) => sentence.match(OPTION_LIST) ?? [];

/**
 * The rewrite, taken sentence by sentence: flagged sentences get the
 * model's wording (with every pronoun option list put back as the original
 * wrote it), all others keep the original. Null — reject it whole — when the
 * sentence count differs or any sentence changed beyond pronouns and verb
 * agreement.
 */
export function spliceRewrite(original: string, rewritten: string, flagged: Set<number>): string | null {
  const o = pieces(original);
  const r = pieces(rewritten.trim());
  if (o.list.length !== r.list.length) return null;
  const out: string[] = [o.lead];
  for (let i = 0; i < o.list.length; i++) {
    const before = o.list[i]!.text;
    let after = r.list[i]!.text;
    if (skeleton(before) !== skeleton(after)) return null;
    if (!flagged.has(i) || asksAboutPronouns(before)) after = before;
    else {
      const lists = optionLists(before);
      const got = optionLists(after);
      if (lists.length !== got.length) after = before;
      else if (lists.length > 0) {
        let k = 0;
        after = after.replace(OPTION_LIST, () => lists[k++]!);
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
  const spliced = acceptRewrite(text, cleaned, names) ? spliceRewrite(text, cleaned, flagged) : null;
  if (spliced === null || !acceptRewrite(text, spliced, names)) {
    console.warn(`[pronouns] ${label} rewrite rejected (changed too much); keeping the original`);
    return text;
  }
  if (spliced !== text) console.log(`[pronouns] ${label}: "${text.slice(0, 80)}" → "${spliced.slice(0, 80)}"`);
  return spliced;
}

/**
 * DM prose with every party member referred to by their stated pronouns.
 * No LLM call unless the pre-filter finds something; only the sentences it
 * flagged can change.
 */
export async function withConsistentPronouns(text: string, members: PronounMember[], opts: ConflictOptions & { llm?: Llm } = {}): Promise<string> {
  if (!text) return text;
  const { list: ps } = pieces(text);
  const conflicts = flagConflicts(ps.map(p => p.text.trim()), ps.map(p => p.sep.includes('\n')), members, opts);
  if (conflicts.length === 0) return text;
  const stated = members.filter(m => keyOf(m.pronouns));
  const list = stated.map(m => `- ${m.name}: ${m.pronouns!.trim()}`).join('\n');
  const partyFirst = new Set(members.map(m => firstName(m.name).toLowerCase()));
  const others = [...new Set((opts.npcNames ?? []).map(n => n.trim()).filter(n => n && !partyFirst.has(firstName(n).toLowerCase()) && text.includes(firstName(n))))];
  const othersLine = others.length > 0 ? ` Everyone else keeps their pronouns exactly as written — including ${others.join(', ')}.` : '';
  const system = `${PRONOUN_REWRITE_MARKER}. Rewrite this passage so that each party member listed is referred to with their stated pronouns. Change pronouns for only the listed party members, and only where the word refers to that member.${othersLine} ${REWRITE_RULES}`;
  const user = `Party members and their stated pronouns:\n${list}\n\nPassage:\n${text}`;
  console.log(`[pronouns] ${conflicts.map(c => `"${c.word}" near ${c.name} (${c.pronouns})`).join('; ')} — asking for a rewrite`);
  return rewrite(text, system, user, members.map(m => m.name), new Set(conflicts.map(c => c.index)), opts.llm ?? defaultLlm, 'narration');
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
