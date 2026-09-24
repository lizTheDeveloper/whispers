/**
 * How DM prose refers to the party, checked in code.
 *
 * Until round 9 this file also REPAIRED pronouns: a deterministic rewrite
 * of he/she for a they/them member, then an LLM rewrite, then a stricter
 * second LLM ask. With qwen that was net-harmful. qwen rarely misgenders
 * on its own, and in the live game E9W9YT seven checks fired, every first
 * rewrite came back unchanged, and the strict second ask produced every
 * error the table saw: "…gaze directly to Liz. They flinches" (Liz is
 * she/her), "Biz's small hand is … wrapped around their fingers" (Liz's
 * fingers), an NPC's "he" turned "she", an NPC's "his" turned "their". The
 * checker attributed Liz's and NPCs' pronouns to Biz; pronoun ownership is
 * too ambiguous to settle in code or in a one-passage prompt.
 *
 * So pronouns are never changed. What is left is:
 *
 *  1. The detector (findPronounConflicts), for the log only: which member a
 *     sentence is about, and a pronoun or gendered word that contradicts
 *     their stated pronouns. It changes nothing.
 *  2. repairGenderedNouns: a deterministic, high-confidence repair of
 *     gendered NOUNS for a party member whose pronouns are they/them (or
 *     unknown, where the caller says so) or the opposite gender — only
 *     where the noun is unambiguously that member: it names them ("her son
 *     Biz", "the boy Biz", "Biz, her son,") or it is "Liz's son" and Liz's
 *     only child in the party is Biz. "her kid Biz", "Liz's kid", "Biz".
 */
import { changedSpan, kinAddressTerms, namesInNarration, quoteRuns } from './narrative-guards.js';
import { SENTENCE_BREAK, splitSentences } from './sentences.js';
import type { CharacterDefinition } from '../shared/types.js';

export interface PronounMember {
  name: string;
  /** As the player stated it ("she/her", "they/them", "xe/xem"). Unset = not stated: never checked. */
  pronouns?: string | null;
  /** Their sheet's ties, for "Liz's son" (who Liz's child in the party is). */
  relationships?: Array<{ to: string; relation: string }>;
}

type Key = 'she' | 'he' | 'they' | 'other';

const FORMS: Record<'she' | 'he' | 'they', string[]> = {
  she: ['she', 'her', 'hers', 'herself'],
  he: ['he', 'him', 'his', 'himself'],
  they: ['they', 'them', 'their', 'theirs', 'themself', 'themselves'],
};
/** Nouns that state a gender about the person they describe. Kept tight: "man" and "woman" are too often someone else. */
const WORDS: Record<'she' | 'he', string[]> = {
  she: ['girl', 'daughter', 'lass', 'young lady', 'young woman'],
  he: ['boy', 'son', 'lad', 'young man'],
};
/** Two-word gendered nouns, read as one word by wordsIn ("young man"). */
const YOUNG_NOUN = /\byoung\s+(man|lady|woman)\b/g;

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

export { splitSentences };

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
  const withoutOptions = sentence.toLowerCase().replace(OPTION_LIST, ' ').replace(YOUNG_NOUN, 'young~$1');
  return (withoutOptions.match(/[a-z~]+/g) ?? []).map(w => w.replace('~', ' '));
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

/**
 * Capitalised words at the start of a sentence (or after an opening quote)
 * that are ordinary words, not names. Anything else capitalised and not a
 * party member's name is taken for someone the NPC list does not know yet.
 */
const COMMON_CAPITALISED = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'so', 'yet', 'nor', 'for', 'i', 'we', 'you', 'he', 'she', 'it', 'they', 'his', 'her', 'its', 'their', 'our', 'my', 'your',
  'this', 'that', 'these', 'those', 'there', 'here', 'then', 'now', 'still', 'even', 'just', 'only', 'also', 'again', 'once', 'soon', 'later', 'finally', 'meanwhile',
  'as', 'at', 'by', 'in', 'on', 'of', 'off', 'to', 'up', 'down', 'out', 'over', 'under', 'into', 'onto', 'from', 'with', 'without', 'within', 'behind', 'beside', 'beyond',
  'above', 'below', 'across', 'along', 'around', 'through', 'toward', 'towards', 'inside', 'outside', 'near', 'past', 'before', 'after', 'during', 'until', 'while', 'when',
  'where', 'what', 'who', 'whom', 'whose', 'why', 'how', 'which', 'if', 'though', 'although', 'because', 'since', 'unless', 'whether', 'somewhere', 'something', 'someone',
  'nothing', 'no', 'not', 'yes', 'oh', 'ah', 'every', 'each', 'all', 'both', 'some', 'any', 'none', 'one', 'two', 'three', 'another', 'other', 'others', 'more', 'most',
  'much', 'many', 'few', 'too', 'very', 'far', 'high', 'low', 'deep', 'far', 'let', 'can', 'could', 'will', 'would', 'should', 'must', 'may', 'might', 'do', 'does', 'did',
  'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'suddenly', 'slowly', 'quickly', 'somehow', 'overhead', 'nearby', 'ahead', 'outside', 'upstairs',
]);

/**
 * Does a sentence name someone who is neither a party member nor on the NPC
 * list — "Odo steps forward, his stormcloud coat…" when Odo only just walked
 * in? Quoted speech, ordinary sentence-openers and a capitalised place after
 * "the" ("the Grand Registry") do not count. Used only to keep the code's
 * own repair away: a wrong "yes" sends a sentence to the model, never the
 * other way round.
 */
function namesSomeoneElse(sentence: string, members: PronounMember[]): boolean {
  const party = new Set(members.map(m => firstName(m.name).toLowerCase()));
  for (const run of quoteRuns(sentence)) {
    if (run.quoted) continue;
    const re = /(?<![\w'’-])([A-Z][a-z'’-]+)/g;
    for (const m of run.text.matchAll(re)) {
      const word = m[1]!.replace(/['’]s$/, '');
      const lower = word.toLowerCase();
      if (party.has(lower) || COMMON_CAPITALISED.has(lower)) continue;
      if (/(?:ly|ing)$/.test(lower) && m.index === run.text.search(/\S/)) continue;
      const before = run.text.slice(0, m.index);
      // "the Grand Registry Hall", "The Lamp Room": a place or a thing.
      if (/\b(?:the|The)\s+(?:[A-Z][\w'’-]*\s+)*$/.test(before)) continue;
      return true;
    }
  }
  return false;
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
 * contradicts them. Logged, never repaired (see the header). Empty in the
 * common case.
 */
export function findPronounConflicts(text: string, members: PronounMember[], opts: ConflictOptions = {}): PronounConflict[] {
  if (!text) return [];
  const { list } = pieces(text);
  return flagConflicts(list.map(p => p.text.trim()), list.map(p => p.sep.includes('\n')), members, opts)
    .map(({ index: _i, ...c }) => c);
}

// ─── Gendered nouns, repaired where the referent is certain ─────────────────

/** The gender each kin noun states, and its counterpart. */
const KIN_NOUNS: Record<string, { gender: 'she' | 'he'; counterpart: string }> = {
  son: { gender: 'he', counterpart: 'daughter' },
  daughter: { gender: 'she', counterpart: 'son' },
  boy: { gender: 'he', counterpart: 'girl' },
  girl: { gender: 'she', counterpart: 'boy' },
  lad: { gender: 'he', counterpart: 'lass' },
  lass: { gender: 'she', counterpart: 'lad' },
};
const KIN = Object.keys(KIN_NOUNS).join('|');

/** A relation on X's sheet saying the other person is X's child. */
const CHILD_RELATION = /\b(?:child|kid|son|daughter|stepchild|stepson|stepdaughter|toddler|baby|boy|girl)\b/i;
/** A relation on C's sheet saying X is C's parent. */
const PARENT_RELATION = /\b(?:mother|mom|mum|mama|mommy|mummy|father|dad|daddy|papa|parent|stepmother|stepfather|stepparent)\b/i;

export interface NounRepairOptions {
  /** Treat a member with no stated pronouns like a they/them member (setup text, sheets). Default false: DM prose repairs only stated pronouns. */
  neutralWhenUnknown?: boolean;
  /** Kin nouns the host used themselves ("my son"): their words, never changed. */
  keepNouns?: Iterable<string>;
}

function matchCase(model: string, word: string): string {
  return /^[A-Z]/.test(model) ? word[0]!.toUpperCase() + word.slice(1) : word;
}

/** What `noun` becomes for `member`, or null when it fits them (or nothing is known). */
function replacementFor(noun: string, member: PronounMember, opts: NounRepairOptions): string | null {
  const info = KIN_NOUNS[noun.toLowerCase()];
  if (!info) return null;
  const key = keyOf(member.pronouns);
  if (!key) return opts.neutralWhenUnknown ? 'kid' : null;
  if (key === info.gender) return null;
  if (key === 'she' || key === 'he') return info.counterpart;
  return 'kid';
}

/**
 * The single party member who is `parent`'s child, or null when there is
 * none or it is not certain (two children, or a child tie to someone
 * outside the party).
 */
function onlyChildInParty(parent: PronounMember, members: PronounMember[]): PronounMember | null {
  const others = members.filter(m => m !== parent);
  const same = (a: string, b: string) => firstName(a).toLowerCase() === firstName(b).toLowerCase();
  const fromParent = (parent.relationships ?? []).filter(r => CHILD_RELATION.test(r.relation));
  // A child tie to someone not at the table: "Liz's son" may be them.
  if (fromParent.some(r => !others.some(o => same(o.name, r.to)))) return null;
  const kids = others.filter(o =>
    fromParent.some(r => same(o.name, r.to))
    || (o.relationships ?? []).some(r => same(r.to, parent.name) && PARENT_RELATION.test(r.relation)));
  return kids.length === 1 ? kids[0]! : null;
}

/**
 * Gendered nouns that refer, beyond doubt, to a party member they do not
 * fit — "her 10-year-old son Biz", "the boy Biz", "Biz, her son,", and
 * "Liz's son" when Liz's only child in the party is Biz — as "kid" (or the
 * counterpart, "daughter", for a she/her member). Pronouns are never
 * touched, and neither is any noun whose referent is not certain ("the boy"
 * alone, "her son" alone).
 */
export function repairGenderedNouns(text: string, members: PronounMember[], opts: NounRepairOptions = {}): string {
  if (!text || members.length === 0 || !new RegExp(`\\b(?:${KIN})\\b`, 'i').test(text)) return text;
  const keep = new Set([...(opts.keepNouns ?? [])].map(n => n.toLowerCase()));
  const replace = (noun: string, member: PronounMember): string | null => {
    if (keep.has(noun.toLowerCase())) return null;
    const r = replacementFor(noun, member, opts);
    return r === null ? null : matchCase(noun, r);
  };
  let out = text;
  for (const m of members) {
    const n = esc(firstName(m.name));
    if (!n) continue;
    // "the boy Biz" → "Biz" (for a kid), "the girl Biz" (counterpart).
    out = out.replace(new RegExp(`\\b([Tt]he)\\s+(${KIN})\\s+(${n})\\b`, 'g'), (whole, the: string, noun: string, name: string) => {
      const r = replace(noun, m);
      if (r === null) return whole;
      return r.toLowerCase() === 'kid' ? name : `${the} ${r} ${name}`;
    });
    // "her ten-year-old son Biz", "Liz's boy Biz", "son Biz".
    out = out.replace(new RegExp(`\\b(${KIN})(\\s+)(${n})\\b`, 'gi'), (whole, noun: string, sp: string, name: string) => {
      if (name !== firstName(m.name)) return whole;
      const r = replace(noun, m);
      return r === null ? whole : `${r}${sp}${name}`;
    });
    // "Biz, her son," / "Biz, Liz's ten-year-old boy".
    out = out.replace(new RegExp(`\\b(${n}),(\\s+(?:her|his|their|[A-Z][\\w-]*['’]s)\\s+(?:[\\w-]+\\s+){0,2}?)(${KIN})\\b`, 'g'), (whole, name: string, mid: string, noun: string) => {
      const r = replace(noun, m);
      return r === null ? whole : `${name},${mid}${r}`;
    });
  }
  // "Liz's son", when Liz's only child in the party is the one it fits badly.
  for (const parent of members) {
    const child = onlyChildInParty(parent, members);
    if (!child) continue;
    const p = esc(firstName(parent.name));
    out = out.replace(new RegExp(`\\b(${p}['’]s\\s+(?:[\\w-]+\\s+){0,2}?)(${KIN})\\b(?!\\s+[A-Z])`, 'g'), (whole, before: string, noun: string) => {
      // "Liz's little boy" but not "Liz's glance at the boy": only adjectives between.
      if (/\b(?:the|a|an|at|to|of|on|in|with|and|but)\s/i.test(before.slice(p.length))) return whole;
      const r = replace(noun, child);
      return r === null ? whole : `${before}${r}`;
    });
  }
  if (out !== text) console.log(`[pronouns] gendered noun repaired: ${changedSpan(text, out)}`);
  return out;
}

// ─── A they/them child, called "her son", "the boy" or "its" ───────────────

/** Words between a possessive or "the" and the noun: "her little son", "the ten-year-old girl". */
const CHILD_ADJ = String.raw`(?:(?:little|young|small|tiny|brave|clever|sweet|poor|youngest|eldest|oldest|only|dear|[\w]+-year-old)\s+){0,2}`;
/** After "the boy": someone the story is introducing, not the child already in the sentence ("the boy behind the counter"). */
const SOMEONE_NEW_AFTER = /^\s+(?:who|that|whom|behind|at|from|in|near|with|on|by|beside|across|next|over|under|outside|inside|of)\b/i;
/** What a they/them child's "its" is always the child's own: their body, their gaze, what they hold close. */
const OWN_THINGS = String.raw`(?:gaze|eyes?|hands?|head|face|fingers?|feet|foot|voice|breath|mind|attention|pockets?|grip|shoulders?|arms?|nose|heart|cheeks?|lips|mouth|chin|knees?|legs?|hair|toes?|thumbs?|palms?|fists?|ears?|sneakers|shoes|sleeves?|smile|frown|brow|forehead|wrists?|neck|stare|focus|bottle\s+caps)`;

function isNeutral(m: PronounMember): boolean {
  const k = keyOf(m.pronouns);
  return k === 'they' || k === 'other';
}

export interface ChildNounOptions {
  /** NPCs by name: a sentence naming one could mean their son, their boy, their "its". */
  npcNames?: string[];
  /**
   * The sheet this text is from: its owner is who "her son" / "my son" means
   * when no one else the possessive fits is named (round 18, 39PF4D: Liz's
   * backstory, "balancing books and her son's needs", Biz they/them). A
   * place ("from Ohio", "of Unfinished Business") is not someone else.
   */
  owner?: PronounMember;
}

/** A capitalised word right after one of these is a place or a thing, not a person: "from Ohio", "in the District of Unfinished Business". */
const PLACE_BEFORE = /\b(?:from|in|of|at|to|into|near|outside|inside|across|through|toward|towards)\s+(?:the\s+)?$/i;

/**
 * Someone the party does not know is named here — sheet text, which is
 * about its owner: a place after "from", "in", "of"… is not a person, and
 * neither is the word a sheet line opens on ("Calm and protective of her
 * son", "Unflappable under pressure").
 */
function namesSomeoneElseInSheet(sentence: string, members: PronounMember[]): boolean {
  const party = new Set(members.map(m => firstName(m.name).toLowerCase()));
  const opening = sentence.search(/\S/);
  for (const run of quoteRuns(sentence)) {
    if (run.quoted) continue;
    for (const m of run.text.matchAll(/(?<![\w'’-])([A-Z][a-z'’-]+)/g)) {
      const lower = m[1]!.replace(/['’]s$/, '').toLowerCase();
      if (party.has(lower) || COMMON_CAPITALISED.has(lower)) continue;
      if (run.text === sentence && m.index === opening) continue;
      const before = run.text.slice(0, m.index);
      if (/\b(?:the|The)\s+(?:[A-Z][\w'’-]*\s+)*$/.test(before)) continue;
      if (PLACE_BEFORE.test(before) || /\b(?:from|in|of|at|to)\s+(?:the\s+)?(?:[A-Z][\w'’-]*\s+)+$/.test(before)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Gendered child nouns for a party member whose stated pronouns are
 * they/them (or another set that is neither he nor she), in DM prose,
 * where no one else could be meant. Live (WXKC2C), all logged and all left
 * in: "she looks down at the pen, then at her son", "Liz's steady hand on
 * Biz's shoulder grounds the boy", "As Biz keeps its gaze locked…".
 *
 *  - "her son" / "Liz's son" (daughter, boy, girl): the possessor is a party
 *    member named in the sentence (for her/his/their, the only one named
 *    whose pronouns fit), and that member's only child in the party is the
 *    they/them member. → "her kid".
 *  - "the boy" / "the girl": the they/them member is named EARLIER in the
 *    same sentence, and "the boy" is not being introduced ("the boy behind
 *    the counter", "the boy who…"). → "the kid".
 *  - "Biz keeps its gaze": the name, one verb, "its", and something only
 *    they could own (gaze, hands, pocket…), with no thing named before it.
 *    → "their".
 *
 * Never in a sentence that names an NPC or anyone the party does not know,
 * never inside quoted speech, and never a pronoun other than that "its".
 */
export function repairChildNouns(text: string, members: PronounMember[], opts: ChildNounOptions = {}): string {
  if (!text || members.length === 0) return text;
  const targets = members.filter(isNeutral);
  if (targets.length === 0) return text;
  const kinTest = /\b(?:son|daughter|boy|girl|its)\b/i;
  if (!kinTest.test(text)) return text;
  const namesNpc = npcMatcher(members, opts.npcNames ?? []);
  const owner = opts.owner ? members.find(m => firstName(m.name).toLowerCase() === firstName(opts.owner!.name).toLowerCase()) ?? opts.owner : undefined;
  const { lead, list } = pieces(text);
  let changed = false;
  const out = list.map(p => {
    const sentence = p.text;
    if (!kinTest.test(sentence) || namesNpc(sentence) || (owner ? namesSomeoneElseInSheet(sentence, members) : namesSomeoneElse(sentence, members))) return p.text + p.sep;
    const named = members.filter(m => mentions(sentence, m));
    const namedTargets = targets.filter(t => named.includes(t));
    let pos = 0;
    const fixed = quoteRuns(sentence).map(run => {
      const start = pos;
      pos += run.text.length;
      if (run.quoted) return run.text;
      let t = run.text;
      // "her son", "Liz's little boy".
      t = t.replace(new RegExp(String.raw`\b([Hh]er|[Hh]is|[Tt]heir|[Mm]y|([A-Z][\w-]*)['’]s)(\s+${CHILD_ADJ})(son|daughter|boy|girl)\b(?!['’]?\s*[A-Z])`, 'g'), (whole, poss: string, possessor: string | undefined, mid: string, noun: string) => {
        let parent: PronounMember | undefined;
        const p = poss.toLowerCase();
        if (possessor) parent = members.find(m => firstName(m.name) === possessor);
        else if (p === 'my') parent = owner;
        else {
          const want: Key = p === 'her' ? 'she' : p === 'his' ? 'he' : 'they';
          const fits = named.filter(m => keyOf(m.pronouns) === want);
          parent = fits.length === 1 ? fits[0] : undefined;
          // A sheet's "her son", nobody else it could be named: the owner's.
          if (!parent && owner && fits.length === 0 && keyOf(owner.pronouns) === want) parent = owner;
        }
        if (!parent) return whole;
        const child = onlyChildInParty(parent, members);
        if (!child || !targets.includes(child)) return whole;
        return `${poss}${mid}${matchCase(noun, 'kid')}`;
      });
      // "grounds the boy, who stops chewing" — Biz named before it.
      if (namedTargets.length === 1) {
        const target = namedTargets[0]!;
        const firstAt = sentence.search(new RegExp(`\\b${esc(firstName(target.name))}\\b`));
        t = t.replace(new RegExp(String.raw`\b([Tt]he\s+${CHILD_ADJ})(boy|girl)\b`, 'g'), (whole, before: string, noun: string, offset: number, all: string) => {
          if (firstAt < 0 || firstAt > start + offset) return whole;
          if (SOMEONE_NEW_AFTER.test(all.slice(offset + whole.length))) return whole;
          return `${before}${matchCase(noun, 'kid')}`;
        });
        // "As Biz keeps its gaze locked" — only their own things, and no thing named before.
        t = t.replace(new RegExp(String.raw`\b(${esc(firstName(target.name))}\s+(?:[a-z]+ly\s+)?[a-z]+\s+)its(\s+${OWN_THINGS}\b)`, 'g'), (whole, before: string, after: string, offset: number, all: string) => {
          if (/^\s*it\b/i.test(target.pronouns ?? '')) return whole;
          const prefix = sentence.slice(0, start + offset);
          if (/\b(?:the|a|an|this|that|these|those)\s+[\w-]+/i.test(prefix)) return whole;
          return `${before}their${after}`;
        });
      }
      return t;
    }).join('');
    if (fixed !== sentence) changed = true;
    return fixed + p.sep;
  }).join('');
  if (!changed) return text;
  const result = lead + out;
  console.log(`[pronouns] child noun repaired: ${changedSpan(text, result)}`);
  return result;
}

/** Relation words that name a child without a gender: the word a speaker's sheet may record for them ("kid"). */
const NEUTRAL_CHILD_WORD = /^(?:kid|child|kiddo|little one|youngster|stepchild|stepkid|baby|toddler|teen|teenager)$/i;

/**
 * The word `speaker` uses for `member` when speaking of them — their own
 * sheet's relation word when it names a child without a gender ("kid",
 * "child"), else "kid" — or null when the speaker's gendered noun fits
 * `member` or nothing says otherwise.
 */
function ownWordFor(speaker: PronounMember, member: PronounMember, noun: string): string | null {
  const info = KIN_NOUNS[noun.toLowerCase()];
  if (!info) return null;
  const tie = (speaker.relationships ?? []).find(r => firstName(r.to).toLowerCase() === firstName(member.name).toLowerCase());
  const recorded = tie?.relation?.trim().toLowerCase().replace(/^(?:my|our)\s+/, '') ?? '';
  const neutralRecorded = NEUTRAL_CHILD_WORD.test(recorded) ? recorded : null;
  const key = keyOf(member.pronouns);
  if (key === info.gender) return null;
  if (key === 'she' || key === 'he') return info.counterpart;
  if (key === 'they' || key === 'other') return neutralRecorded ?? 'kid';
  // Pronouns not stated: only the speaker's own recorded word decides. A
  // sheet that says "son" keeps "my son"; one that says "kid" says "my kid".
  return neutralRecorded;
}

/**
 * A character's OWN words — their action, what they say aloud, what they
 * think — with "my son" / "my daughter" / "my boy" / "my girl" (and "our
 * …", "my little …") that can only mean one companion replaced by the
 * speaker's word for them. Live (N7RQZ7): Liz, whose sheet calls Biz her
 * "kid" and whose Biz is they/them, said "Excuse me. My son is a minor…".
 * The kin noun must be the speaker's, and the speaker must have exactly one
 * child at the table and none elsewhere (see onlyChildInParty). Quoted
 * speech is included: these are the speaker's words. Pronouns are never
 * touched.
 */
export function ownKinNouns(text: string, speaker: PronounMember, members: PronounMember[]): string {
  if (!text || !new RegExp(`\\b(?:my|our)\\b[^.!?]{0,30}\\b(?:${KIN})\\b`, 'i').test(text)) return text;
  const party = members.some(m => firstName(m.name).toLowerCase() === firstName(speaker.name).toLowerCase()) ? members : [speaker, ...members];
  const self = party.find(m => firstName(m.name).toLowerCase() === firstName(speaker.name).toLowerCase())!;
  const child = onlyChildInParty({ ...self, relationships: speaker.relationships ?? self.relationships }, party);
  if (!child) return text;
  const out = text.replace(new RegExp(`\\b(my|our|My|Our)(\\s+(?:(?:little|young|youngest|eldest|oldest|only|dear|sweet|brave|clever|poor)\\s+){0,2})(${KIN})\\b`, 'gi'), (whole, pos: string, adjs: string, noun: string) => {
    const r = ownWordFor(speaker, child, noun);
    return r === null ? whole : `${pos}${adjs}${matchCase(noun, r)}`;
  });
  if (out !== text) console.log(`[pronouns] ${firstName(speaker.name)}'s own kin noun for ${firstName(child.name)}: ${changedSpan(text, out)}`);
  return out;
}

/**
 * Names the host used in their own setup messages, as members with no
 * stated pronouns — the only party the setup chat and world seed know of —
 * and the kin nouns the host used themselves (never changed).
 */
export function setupNounContext(hostMessages: string[]): { members: PronounMember[]; keepNouns: string[] } {
  const all = hostMessages.join('\n');
  const names = [...new Set([...all.matchAll(/(?<![\w'’-])([A-Z][a-z]{1,}(?:['’]s)?)(?![\w'’-])/g)].map(m => m[1]!.replace(/['’]s$/, '')))]
    .filter(w => !COMMON_CAPITALISED.has(w.toLowerCase()));
  const keepNouns = Object.keys(KIN_NOUNS).filter(k => new RegExp(`\\b${k}s?\\b`, 'i').test(all));
  return { members: names.map(name => ({ name, pronouns: null })), keepNouns };
}

/** Text the setup chat or world seed wrote about the host's characters, with the host's relation words: "her son Biz" → "her kid Biz" when the host said "kid". */
export function neutralSetupNouns(text: string, hostMessages: string[]): string {
  if (!text) return text;
  const { members, keepNouns } = setupNounContext(hostMessages);
  return repairGenderedNouns(text, members, { neutralWhenUnknown: true, keepNouns });
}

type SheetText = Pick<CharacterDefinition, 'highConcept' | 'trouble' | 'aspects' | 'personality' | 'backstory' | 'stunts'>;

/** A sheet's prose fields with repairGenderedNouns applied (unknown pronouns read as they/them: nobody has said otherwise). */
export function sheetWithNeutralNouns<T extends Partial<SheetText> & { name?: string | null }>(sheet: T, members: PronounMember[]): T {
  // The sheet's owner is who its "her son" means (round 18, 39PF4D).
  const owner = sheet.name?.trim() ? members.find(m => firstName(m.name).toLowerCase() === firstName(sheet.name!).toLowerCase()) : undefined;
  const fix = (s: string) => repairChildNouns(repairGenderedNouns(s, members, { neutralWhenUnknown: true }), members, { owner });
  let changed = false;
  const out: Partial<SheetText> = {};
  for (const k of ['highConcept', 'trouble', 'personality', 'backstory'] as const) {
    const v = sheet[k];
    if (typeof v === 'string') { const f = fix(v); if (f !== v) { out[k] = f; changed = true; } }
  }
  for (const k of ['aspects', 'stunts'] as const) {
    const v = sheet[k];
    if (Array.isArray(v)) { const f = v.map(s => (typeof s === 'string' ? fix(s) : s)); if (f.some((s, i) => s !== v[i])) { out[k] = f; changed = true; } }
  }
  return changed ? { ...sheet, ...out } : sheet;
}

/** The object pronoun a relation word gives someone ("mom" → her), when their own pronouns are not known yet. */
const RELATION_OBJECT: Array<[RegExp, 'her' | 'him']> = [
  [/\b(?:mother|mom|mum|mama|mommy|mummy|ma|sister|daughter|wife|aunt|auntie|grandmother|grandma|granny|gran|nana|niece|stepmother|stepdaughter|stepsister)\b/i, 'her'],
  [/\b(?:father|dad|daddy|papa|pa|brother|son|husband|uncle|grandfather|grandpa|gramps|nephew|stepfather|stepson|stepbrother)\b/i, 'him'],
];
/** "afraid of losing them", "lose track of them", "lost sight of them". */
const LOSE_THEM = /\b(lose|loses|losing|lost)((?:\s+(?:track|sight)\s+of)?)\s+them\b/i;

/**
 * "…deeply attached to Mom and afraid of losing them." — Biz's (they/them)
 * generated sheet, where "them" is Mom Liz (she/her); round 15, RZBU7G. The
 * interview prompt carries the rule; this is the narrow floor under it: in a
 * sentence of the personality, backstory, trouble, high concept, aspects or
 * stunts that names exactly one person this character is tied to (by name or
 * by what they call them), and whose pronouns are known — stated at the
 * table, or else given by the relation word ("mom" → her) — "losing them"
 * becomes "losing her". "their" is never touched: "losing their way" is the
 * character's own. Two people named, a they/them companion or nobody named:
 * left as written.
 */
export function sheetWithCompanionPronouns<T extends Partial<SheetText> & { relationships?: Array<{ to: string; relation: string; address?: string }> | null }>(
  sheet: T,
  table: Array<{ name: string; pronouns?: string | null }>,
): T {
  const ties = (sheet.relationships ?? []).filter(r => r?.to?.trim());
  if (ties.length === 0) return sheet;
  const tied = ties.map(r => {
    const stated = table.find(t => t.name.trim().toLowerCase() === r.to.trim().toLowerCase())?.pronouns;
    const key = keyOf(stated);
    const object = key === 'she' ? 'her' : key === 'he' ? 'him' : key ? null : (RELATION_OBJECT.find(([re]) => re.test(r.relation ?? ''))?.[1] ?? null);
    const words = [...new Set([r.to.trim(), firstName(r.to), r.address?.trim()].filter((w): w is string => !!w && w.length > 1))];
    return { name: r.to.trim(), object, words };
  });
  // Anyone else at the table the sentence names is a candidate too.
  const others = table
    .filter(t => t.name.trim() && !tied.some(p => p.name.toLowerCase() === t.name.trim().toLowerCase()) && t.name.trim().toLowerCase() !== (sheet as { name?: string }).name?.trim().toLowerCase())
    .map(t => ({ name: t.name.trim(), object: null as 'her' | 'him' | null, words: [...new Set([t.name.trim(), firstName(t.name)])] }));
  const people = [...tied, ...others];
  const fix = (text: string) => text.replace(/[^.!?]+(?:[.!?]+|$)/g, sentence => {
    if (!LOSE_THEM.test(sentence)) return sentence;
    const named = people.filter(p => p.words.some(w => new RegExp(`(?<![\\p{L}\\p{N}])${esc(w)}(?![\\p{L}\\p{N}])`, 'u').test(sentence)));
    if (named.length !== 1 || !named[0]!.object) return sentence;
    const who = named[0]!.object;
    return sentence.replace(new RegExp(LOSE_THEM.source, 'gi'), (_m, verb: string, of: string) => `${verb}${of} ${who}`);
  });
  let changed = false;
  const out: Partial<SheetText> = {};
  for (const k of ['highConcept', 'trouble', 'personality', 'backstory'] as const) {
    const v = sheet[k];
    if (typeof v === 'string') { const f = fix(v); if (f !== v) { out[k] = f; changed = true; } }
  }
  for (const k of ['aspects', 'stunts'] as const) {
    const v = sheet[k];
    if (Array.isArray(v)) { const f = v.map(s => (typeof s === 'string' ? fix(s) : s)); if (f.some((s, i) => s !== v[i])) { out[k] = f; changed = true; } }
  }
  if (!changed) return sheet;
  console.log(`[pronouns] sheet: a companion's pronoun restored (${Object.entries(out).map(([k, v]) => `${k}: "${String(v).slice(0, 80)}"`).join('; ')})`);
  return { ...sheet, ...out };
}

const GENDERED = new Set([...FORMS.he, ...FORMS.she]);

/**
 * An interview reply that calls the character being made he or she before
 * anyone has stated their pronouns: a gendered pronoun in a sentence that
 * names no one else at the table. For the log — the prompt carries the rule;
 * the reply is not rewritten.
 */
export function interviewGendersCharacter(reply: string, otherNames: string[]): boolean {
  return splitSentences(reply).some(s => {
    if (asksAboutPronouns(s)) return false;
    if (otherNames.some(n => n.trim() && new RegExp(`\\b${esc(firstName(n))}\\b`).test(s))) return false;
    return wordsIn(s).some(w => GENDERED.has(w));
  });
}

/**
 * The character interviewer's reply as the player sees it. It is the DM
 * talking, so a companion is called by name ("traveling with Mom Liz" →
 * "traveling with Liz"; quoted speech untouched), and gendered nouns for
 * anyone at the table whose pronouns are unknown or do not fit them become
 * "kid" ("her son Biz" → "her kid Biz"). Pronouns are never rewritten.
 */
export function guardInterviewReply(
  reply: string,
  sheet: Pick<CharacterDefinition, 'name' | 'pronouns' | 'relationships'> | null,
  table: Array<string | PronounMember>,
): string {
  if (!reply) return reply;
  const members = table.map(t => (typeof t === 'string' ? { name: t, pronouns: null } : t)).filter(m => m.name?.trim());
  const tableNames = members.map(m => m.name);
  const own = (sheet?.relationships ?? []).flatMap(r => r.address?.trim() && r.to?.trim() ? [{ name: r.to.trim(), address: r.address.trim() }] : []);
  // "their mom Liz" with a sheet that says "mother" but no address term yet.
  const terms = [...own, ...kinAddressTerms(sheet?.relationships ?? [], tableNames)];
  let out = terms.length > 0 ? namesInNarration(reply, terms) : reply;
  const self: PronounMember[] = sheet?.name?.trim() ? [{ name: sheet.name.trim(), pronouns: sheet.pronouns ?? null, relationships: sheet.relationships }] : [];
  const everyone = [...self, ...members.filter(m => !self.some(s => firstName(s.name).toLowerCase() === firstName(m.name).toLowerCase()))];
  out = repairGenderedNouns(out, everyone, { neutralWhenUnknown: true });
  if (!sheet?.pronouns?.trim()) {
    const otherNames = [...new Set([...tableNames, ...own.map(t => t.name)])].filter(n => !sheet?.name || firstName(n).toLowerCase() !== firstName(sheet.name).toLowerCase());
    if (interviewGendersCharacter(out, otherNames)) console.warn(`[pronouns] interview reply genders ${sheet?.name ?? 'the character'} before pronouns were stated (left as written): "${out.slice(0, 120)}"`);
  }
  return out;
}
