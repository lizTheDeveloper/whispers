import { npcPronounInNarration } from './whisper-suggestions.js';
import { quoteRuns } from './narrative-guards.js';
import { pluralVerb } from '../shared/pronouns.js';
import { TITLE } from './sentences.js';

/**
 * An NPC's pronouns, fixed once and handed to the DM every turn. Live
 * (Z9JKG2): the seed called Clerk Marni and Odo the Owl "their"; by
 * mid-game Marni was "her saucer eyes" and Odo "his shelf… he lands". Every
 * narrate call started from nothing, so each one picked again.
 *
 * Deterministic only: the pronouns are read from the seed (a stated field,
 * else its description) or from the first narration that shows them, and
 * stored. Nothing here rewrites prose — the LLM pronoun rewrite was removed
 * in round 9 for misgendering more than it fixed.
 */

export type PronounWord = 'he' | 'she' | 'it' | 'they';

const FULL: Record<PronounWord, string> = { he: 'he/him', she: 'she/her', it: 'it/its', they: 'they/them' };

export function pronounsFromWord(w: PronounWord): string {
  return FULL[w];
}

/**
 * The pronouns a seed description uses for the NPC it describes ("…magnify
 * their eyes… They wear a uniform…" → they/them). The whole description is
 * about them. Null when it uses none, or two equally.
 */
export function pronounsInDescription(description: string | null | undefined): string | null {
  if (!description?.trim()) return null;
  const words = description.toLowerCase().replace(/"[^"]*"|“[^”]*”/g, ' ').match(/[a-z']+/g) ?? [];
  const counts: Record<PronounWord, number> = { he: 0, she: 0, it: 0, they: 0 };
  for (const w of words) {
    if (['he', 'him', 'his', 'himself'].includes(w)) counts.he++;
    else if (['she', 'her', 'hers', 'herself'].includes(w)) counts.she++;
    else if (['its', 'itself'].includes(w)) counts.it++;
    else if (['they', 'them', 'their', 'theirs', 'themself', 'themselves'].includes(w)) counts.they++;
  }
  const ranked = (Object.entries(counts) as Array<[PronounWord, number]>).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[1]![1] === ranked[0]![1]) return null;
  return FULL[ranked[0]![0]];
}

/**
 * The pronouns a stretch of narration uses for `name`, read only from
 * sentences that name them and no one else in `otherNames` (a party member
 * or another NPC — "Odo lands beside Liz and she smiles" is not evidence
 * about Odo). Null when it never says, or says two things.
 */
export function pronounsInNarration(name: string, text: string, otherNames: string[] = []): string | null {
  const w = npcPronounInNarration(name, text, otherNames);
  return w ? FULL[w] : null;
}

/** The DM's standing instruction: each NPC's pronouns, to be used every time. '' when none are set. */
export function npcPronounBlock(list: Array<{ name: string; pronouns: string }>): string {
  if (list.length === 0) return '';
  return `NPC pronouns — fixed; use exactly these for each NPC every time, in narration and in anyone's speech (never switch an NPC's pronouns mid-game): ${list.map(n => `${n.name}: ${n.pronouns}`).join('; ')}.`;
}

/** Pronouns that are neither he nor she: they/them, xe/xem, … */
export function neutralPronouns(pronouns: string | null | undefined): boolean {
  const first = pronouns?.trim().toLowerCase().split(/[\s/,]+/)[0] ?? '';
  return !!first && !['he', 'him', 'she', 'her'].includes(first);
}

/**
 * The gendered words never to use for a party member whose pronouns are
 * they/them (or another set that is neither he nor she). Live (WXKC2C):
 * Biz, they/them and ten, was "her son", "the boy" and "its gaze".
 */
export function neutralNounRule(name: string, pronouns?: string | null): string {
  const itsOwn = /^\s*it\b/i.test(pronouns ?? '');
  return `${name} is never "son", "daughter", "boy" or "girl" (say "kid" or "child")${itsOwn ? '' : ' and never "it" or "its"'}`;
}

/** "Party pronouns: Liz: she/her; Biz: they/them. Biz is never "son"…" — '' when nobody has stated any. */
export function partyPronounLine(party: Array<{ name: string; pronouns?: string | null }>): string {
  const stated = party.filter(p => p.pronouns?.trim());
  if (stated.length === 0) return '';
  const neutral = stated.filter(p => neutralPronouns(p.pronouns));
  const nouns = neutral.length > 0 ? ` ${neutral.map(p => neutralNounRule(p.name.trim().split(/\s+/)[0] ?? p.name, p.pronouns)).join('; ')}.` : '';
  return `Party pronouns: ${stated.map(p => `${p.name}: ${p.pronouns!.trim()}`).join('; ')}.${nouns}`;
}

/** "Liz: she/her" etc. for every party member, and the NPC line — the whole cast, for prompts that are not the DM's (memories, reflections). */
export function castPronounLine(party: Array<{ name: string; pronouns?: string | null }>, npcs: Array<{ name: string; pronouns: string }>): string {
  const parts: string[] = [];
  const partyLine = partyPronounLine(party);
  if (partyLine) parts.push(partyLine);
  const unstated = party.filter(p => !p.pronouns?.trim());
  if (unstated.length > 0) parts.push(`${unstated.map(p => p.name).join(', ')}: pronouns not stated — use the name or "they".`);
  const npcLine = npcPronounBlock(npcs);
  if (npcLine) parts.push(npcLine);
  return parts.join(' ');
}

// ─── The one deterministic correction ──────────────────────────────────────

/** Role and title words that come before a name and are not what narration calls someone by. */
const ROLE_WORDS = new Set(['dame', 'sir', 'lord', 'lady', 'prince', 'princess', 'king', 'queen', 'duke', 'duchess', 'count', 'countess', 'baron', 'baroness', 'master', 'captain', 'elder', 'chief', 'sister', 'brother', 'father', 'mother', 'doctor', 'professor', 'the', 'a', 'an', 'of', 'clerk', 'officer', 'agent', 'mister', 'mr', 'mrs', 'ms', 'miss', 'madam', 'madame', 'dr', 'auntie', 'aunt', 'uncle', 'old', 'young', 'little', 'great', 'granny', 'grandpa', 'grandma']);

/** The word narration calls an NPC by: "Marni" for "Clerk Marni", "Odo" for "Odo the Owl", "Postman’s" for "The Postman’s Shadow". */
export function npcKeyName(name: string): string {
  const words = name.trim().split(/\s+/);
  return words.find(w => !ROLE_WORDS.has(w.toLowerCase().replace(/[^\p{L}]/gu, ''))) ?? words[0] ?? name;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The ways prose names someone: the whole name, the name without its
 * article, and each capitalised word of it that is not a title ("Barnaby",
 * "Goose" for "Barnaby the Bureaucratic Goose"; "Pudding" for "Archivist
 * Pudding"). Case-sensitive, so "the goose" is not a mention.
 */
function nameForms(name: string): string[] {
  const full = name.trim();
  const forms = new Set<string>([full, full.replace(/^(?:the|a|an)\s+/i, '')]);
  for (const w of full.split(/\s+/)) {
    const bare = w.replace(/['’]s$/u, '').replace(/^[^\p{L}]+|[^\p{L}\p{N}'’-]+$/gu, '');
    if (bare.length >= 3 && /^\p{Lu}/u.test(bare) && !ROLE_WORDS.has(bare.toLowerCase())) forms.add(bare);
  }
  return [...forms].filter(Boolean).sort((a, b) => b.length - a.length);
}

/** Where `name` is mentioned in `text`: [start, end) spans, possessive "’s" included. */
function mentionSpans(text: string, name: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const f of nameForms(name)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}'’-])${escapeRe(f)}(?:['’]s)?(?![\\p{L}\\p{N}-])`, 'gu');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const s = m.index, e = m.index + m[0].length;
      if (!spans.some(([a, b]) => s < b && e > a)) spans.push([s, e]);
    }
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

function pronounKey(pronouns: string | null | undefined): PronounWord | null {
  const w = pronouns?.trim().toLowerCase().split(/[\s/,]+/)[0] ?? '';
  if (w === 'he' || w === 'him' || w === 'his') return 'he';
  if (w === 'she' || w === 'her' || w === 'hers') return 'she';
  if (w === 'it' || w === 'its') return 'it';
  if (w === 'they' || w === 'them' || w === 'their') return 'they';
  return null;
}

// Nouns for a person who is not named: any of these in the sentence and a
// pronoun might be theirs. Gendered ones block only their own gender.
const PERSON_ANY = /\b(?:clerks?|guards?|officers?|strangers?|figures?|persons?|people|someone|somebody|anyone|attendants?|officials?|workers?|customers?|travell?ers?|visitors?|child|children|kids?|toddlers?|teens?|clients?|passengers?|citizens?|residents?|keepers?|owners?|drivers?|managers?|bosses?|supervisors?|archivists?|librarians?|janitors?|postm[ae]n|shopkeepers?|merchants?|innkeepers?|bartenders?|servants?|soldiers?|knights?|priests?|wizards?|witches?|creatures?)\b/i;
const PERSON_HE = /\b(?:m[ae]n|boys?|guys?|gentlem[ae]n|kings?|princes?|fathers?|dads?|papa|brothers?|sons?|husbands?|uncles?|grandfathers?|grandpas?|nephews?|sirs?|mister|mr|lords?|dukes?|monks?)\b/i;
const PERSON_SHE = /\b(?:wom[ae]n|girls?|lad(?:y|ies)|queens?|princess(?:es)?|mothers?|moms?|mums?|mama|sisters?|daughters?|wives|wife|aunts?|grandmothers?|grandmas?|nieces?|madam|madame|miss|mrs|ms|dames?|duchess(?:es)?|nuns?)\b/i;

const HE_FORMS = new Set(['he', 'him', 'his', 'himself']);
const SHE_FORMS = new Set(['she', 'her', 'hers', 'herself']);

// After "her"/"his", these mean the word is not a possessive ("gave it to her and", "the choice is his.").
const NOT_A_NOUN = new Set(['and', 'or', 'but', 'nor', 'so', 'yet', 'as', 'to', 'with', 'from', 'at', 'in', 'on', 'into', 'onto', 'by', 'for', 'of', 'off', 'up', 'down', 'away', 'back', 'out', 'over', 'again', 'too', 'now', 'then', 'that', 'if', 'when', 'while', 'the', 'a', 'an', 'this', 'these', 'those', 'before', 'after', 'until', 'because', 'it', 'them', 'him', 'her', 'me', 'us', 'you', 'is', 'was', 'are', 'were', 'just', 'enough', 'once', 'twice', 'aside', 'along', 'around', 'through', 'toward', 'towards', 'about', 'across', 'behind', 'beside', 'past', 'closer', 'here', 'there', 'anyway', 'instead', 'entirely', 'completely', 'gently', 'softly', 'quickly', 'slowly']);

// A word after "he"/"she" that reads the same after "they".
const SAME_AFTER_THEY = new Set(['can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'said', 'went', 'took', 'made', 'saw', 'felt', 'held', 'kept', 'left', 'ran', 'got', 'gave', 'came', 'knew', 'thought', 'stood', 'sat', 'fell', 'found', 'began', 'caught', 'drew', 'threw', 'spun', 'swung', 'told', 'heard', 'let', 'put', 'set', 'cut', 'hit', 'shut', 'brought', 'bought', 'lost', 'meant', 'sent', 'spent', 'stuck', 'struck', 'taught', 'understood', 'wore', 'woke', 'wrote', 'rose', 'shook', 'slid', 'led', 'fled', 'flew', 'blew', 'grew', 'hid', 'bit', 'did', 'had', "didn't", "didn’t", "couldn't", "couldn’t", "wouldn't", "wouldn’t", "won't", "won’t", "can't", "can’t", 'never', 'also', 'still', 'always', 'only', 'even', 'just']);

function capitalLike(model: string, word: string): string {
  return /^\p{Lu}/u.test(model) ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

interface Swap { start: number; end: number; to: string }

/**
 * The replacement for one mismatched pronoun at `at` in `text`, as swaps
 * (the pronoun, and for "they" the verb after it), or null when it cannot be
 * done with certainty — the caller then leaves the whole sentence alone.
 */
function swapFor(text: string, at: number, word: string, contraction: string, target: PronounWord): Swap[] | null {
  const end = at + word.length + contraction.length;
  const low = word.toLowerCase();
  const after = text.slice(end);
  const nextTok = after.match(/^(\s+)([\p{L}'’-]+)/u);
  const next = nextTok ? nextTok[2]!.toLowerCase() : null;
  const possessive = !!next && !NOT_A_NOUN.has(next);
  const one = (to: string): Swap[] => [{ start: at, end, to: capitalLike(word, to) }];
  const apos = contraction ? contraction.charAt(0) : '';
  const cont = contraction.slice(1).toLowerCase();

  if (contraction) {
    if (low !== 'he' && low !== 'she') return null;
    if (target === 'it') return one(`it${apos}${cont}`);
    if (target === 'he' || target === 'she') return one(`${target}${apos}${cont}`);
    // they: 'd and 'll carry over; 's only as "is" before an -ing word.
    if (cont === 'd' || cont === 'll') return one(`they${apos}${cont}`);
    if (cont === 's' && next && /ing$/.test(next)) return one(`they${apos}re`);
    return null;
  }

  switch (target) {
    case 'it':
      if (low === 'he' || low === 'she' || low === 'him') return one('it');
      if (low === 'himself' || low === 'herself') return one('itself');
      if (low === 'his' || low === 'her') return low === 'her' && !possessive ? one('it') : possessive ? one('its') : null;
      return null; // hers
    case 'he':
      if (low === 'she') return one('he');
      if (low === 'herself') return one('himself');
      if (low === 'hers') return one('his');
      if (low === 'her') return one(possessive ? 'his' : 'him');
      return null;
    case 'she':
      if (low === 'he') return one('she');
      if (low === 'him') return one('her');
      if (low === 'himself') return one('herself');
      if (low === 'his') return one(possessive ? 'her' : 'hers');
      return null;
    case 'they': {
      if (low === 'him') return one('them');
      if (low === 'himself' || low === 'herself') return one('themself');
      if (low === 'hers') return one('theirs');
      if (low === 'his') return one(possessive ? 'their' : 'theirs');
      if (low === 'her') return one(possessive ? 'their' : 'them');
      // Subject: the verb after it has to agree. Adverbs in between are skipped.
      const verbRe = /^((?:\s+(?:[\p{L}-]+ly|always|never|still|also|just|even|then|now|soon))*\s+)([\p{L}'’-]+)/u;
      const vm = after.match(verbRe);
      if (!vm) return null;
      const verb = vm[2]!;
      const vStart = end + vm[1]!.length;
      if (/ed$/i.test(verb) || SAME_AFTER_THEY.has(verb.toLowerCase())) return one('they');
      const plural = pluralVerb(verb);
      if (plural.toLowerCase() !== verb.toLowerCase()) return [...one('they'), { start: vStart, end: vStart + verb.length, to: plural }];
      return null;
    }
  }
}

export interface NpcPronounFix { name: string; from: string; to: string }

/** Any unnamed person (or, for `g`, a man or a woman) in already-blanked text, or a capitalised word that is not a name we know. */
function personIn(blankedText: string, g: 'he' | 'she', accounted: Set<string>): boolean {
  if (PERSON_ANY.test(blankedText) || (g === 'he' ? PERSON_HE : PERSON_SHE).test(blankedText)) return true;
  return [...blankedText.matchAll(/(?<=[\p{Ll},;]\s+)(\p{Lu}[\p{L}'’-]*)/gu)]
    .map(m => m[1]!.replace(/['’]s$/u, '').toLowerCase())
    .some(w => w !== 'i' && !/^i['’]/.test(w) && !accounted.has(w));
}

/**
 * Fixes an NPC's pronoun in the one case where there is no doubt whose it
 * is. Live (7MJXE5), Barnaby (it/its) was "his tiny briefcase… as he
 * completely ignored me" in a memory and "Barnaby didn’t steal it, he’s
 * showing us!" in Biz's words. A sentence is changed only when:
 *   - it names exactly one NPC, and that NPC's pronouns are fixed;
 *   - the pronoun comes AFTER the name, and is he/him/his or she/her that
 *     contradicts them (a "they" or an "it" is never touched — it may be
 *     plural, or a thing);
 *   - nobody else who could be "he" (or "she") is present: no party member
 *     with those pronouns or with none stated, no other NPC with them named
 *     in the passage, no unnamed man or woman in the sentence — checked per
 *     gender, so Liz's "her knee" beside Barnaby's "his briefcase" keeps
 *     "her" and fixes "his" — and no unnamed clerk or stranger, or other
 *     capitalised name the caller did not account for, at all;
 *   - every pronoun it would change can be changed cleanly.
 * Otherwise the sentence is left as written (and reported in `flagged`).
 * Quoted speech inside narration is never touched; `speech` says the whole
 * text is someone's own words (a character's spokenWords).
 */
export function correctNpcPronouns(
  text: string,
  npcs: Array<{ name: string; pronouns: string | null | undefined }>,
  party: Array<{ name: string; pronouns?: string | null }>,
  opts: { speech?: boolean; otherNames?: string[] } = {},
): { text: string; fixes: NpcPronounFix[]; flagged: string[] } {
  const none = { text, fixes: [], flagged: [] };
  if (!text?.trim() || npcs.length === 0) return none;
  const known = npcs.filter(n => n.name?.trim());
  if (known.length === 0) return none;

  // Quoted spans (character offsets) — narration only.
  const quoted: Array<[number, number]> = [];
  if (!opts.speech) {
    let pos = 0;
    for (const r of quoteRuns(text)) {
      if (r.quoted) quoted.push([pos, pos + r.text.length]);
      pos += r.text.length;
    }
  }
  const inQuote = (i: number) => quoted.some(([a, b]) => i >= a && i < b);

  // Genders someone else could be: party members with those pronouns or none stated.
  const partyKeys = party.map(p => pronounKey(p.pronouns));
  const partyBlocks = (g: 'he' | 'she') => partyKeys.some(k => k === g || k === null);
  // …and NPCs with those pronouns named anywhere in the passage.
  const npcSpansAll = known.map(n => ({ n, key: pronounKey(n.pronouns), spans: mentionSpans(text, n.name) }));
  const npcBlocks = (g: 'he' | 'she', self: string) => npcSpansAll.some(x => x.n.name !== self && x.key === g && x.spans.length > 0);

  const accounted = new Set<string>();
  for (const n of [...known.map(k => k.name), ...party.map(p => p.name), ...(opts.otherNames ?? [])]) {
    for (const w of n.split(/\s+/)) accounted.add(w.replace(/['’]s$/u, '').replace(/[^\p{L}\p{N}'’-]/gu, '').toLowerCase());
  }

  const anyoneBefore = (before: string, g: 'he' | 'she') => personIn(before, g, accounted);
  const swaps: Swap[] = [];
  const fixes: NpcPronounFix[] = [];
  const flagged: string[] = [];
  const partySpans = party.map(p => mentionSpans(text, p.name));
  // The NPC the last sentence was about, when it named them alone: a next
  // sentence that opens on a pronoun and names nobody is still about them
  // ("Barnaby… waddles closer. He looks you in the eye").
  let carry: (typeof npcSpansAll)[number] | null = null;
  // The whole passage with every named NPC, party member and (in narration)
  // quoted speech blanked out: what is left that could be a person?
  const blanked = (() => {
    const chars = text.split('');
    for (const sp of [...npcSpansAll.flatMap(x => x.spans), ...partySpans.flat()]) for (let k = sp[0]; k < sp[1]; k++) chars[k] = ' ';
    if (!opts.speech) for (const [a, b] of quoted) for (let k = a; k < b; k++) chars[k] = ' ';
    return chars.join('');
  })();
  // A title's full stop ("Ms. Hark") does not end the sentence.
  const sentenceRe = new RegExp(String.raw`(?:(?<![\w'’-])${TITLE}\.|[^.!?…\n])+(?:[.!?…]+["”’']?|(?=\n)|$)`, 'gu');
  let sm: RegExpExecArray | null;
  while ((sm = sentenceRe.exec(text))) {
    const sStart = sm.index;
    const sentence = sm[0];
    const sEnd = sStart + sentence.length;
    if (!sentence.trim()) continue;
    const inSentence = ([a]: [number, number]) => a >= sStart && a < sEnd;
    const here = npcSpansAll
      .map(x => ({ ...x, local: x.spans.filter(inSentence) }))
      .filter(x => x.local.length > 0);
    const namesParty = partySpans.some(sp => sp.some(inSentence));
    // Wrong-gender candidates in this sentence, outside quotes.
    const pronRe = /(?<![\p{L}\p{N}'’-])(he|him|his|himself|she|her|hers|herself)((?:['’])(?:s|d|ll))?(?![\p{L}\p{N}-])/giu;
    const found: Array<{ at: number; word: string; contraction: string; g: 'he' | 'she' }> = [];
    let pm: RegExpExecArray | null;
    while ((pm = pronRe.exec(sentence))) {
      const at = sStart + pm.index;
      if (inQuote(at)) continue;
      const low = pm[1]!.toLowerCase();
      found.push({ at, word: pm[1]!, contraction: pm[2] ?? '', g: HE_FORMS.has(low) ? 'he' : 'she' });
    }
    // Unnamed people and unknown names in the sentence, the NPC's own name masked out.
    // The sentence with the NPC's own name (and, in narration, quoted speech) blanked out.
    const plainOf = (maskSpans: Array<[number, number]>): string => {
      let masked = sentence;
      for (const [a, b] of maskSpans) masked = masked.slice(0, a - sStart) + ' '.repeat(b - a) + masked.slice(b - sStart);
      return opts.speech ? masked : masked.split('').map((ch, k) => (inQuote(sStart + k) ? ' ' : ch)).join('');
    };
    // An unnamed person, or a capitalised name nobody accounted for: anyone could be meant.
    const anyoneElse = (plain: string): string | null => {
      if (PERSON_ANY.test(plain)) return 'someone else is in the sentence';
      const strangers = [...plain.matchAll(/(?<=[\p{Ll},;]\s+)(\p{Lu}[\p{L}'’-]*)/gu)].map(m => m[1]!.replace(/['’]s$/u, '').toLowerCase()).filter(w => w !== 'i' && !/^i['’]/.test(w) && !accounted.has(w));
      return strangers.length > 0 ? `an unknown name (${strangers[0]})` : null;
    };

    let npc: (typeof npcSpansAll)[number];
    let local: Array<[number, number]>;
    if (here.length === 1 && here[0]!.key) {
      npc = here[0]!;
      local = here[0]!.local;
    } else if (here.length === 0 && !namesParty && carry && found.length > 0 && found[0]!.at - sStart === sentence.length - sentence.trimStart().length
      && !anyoneBefore(blanked.slice(0, sStart), found[0]!.g)) {
      // Carried over only when nobody else who could be "he" (or "she") has
      // appeared anywhere earlier in the passage ("A tall man enters.
      // Barnaby honks. He frowns." is left alone).
      npc = carry;
      local = [];
    } else {
      carry = null;
      continue;
    }
    const target = npc.key!;
    const plain = plainOf(local);
    const blocker = anyoneElse(plain);
    // Only a sentence about this NPC alone hands them on to the next one.
    carry = !namesParty && !blocker && !PERSON_HE.test(plain) && !PERSON_SHE.test(plain) ? npc : null;
    const wrong = found.filter(f => f.g !== target);
    if (wrong.length === 0) continue;
    const label = sentence.trim().slice(0, 80);
    const why = (reason: string) => flagged.push(`${npc.n.name} (${npc.n.pronouns}): "${label}" — ${reason}`);
    if (blocker) { why(blocker); continue; }
    // Per gender: a "her" in a sentence with Liz (she/her) in the party may
    // be Liz's ("bumping her knee"), and is left alone; the "his" beside it
    // can only be the NPC's.
    const genderFree = (g: 'he' | 'she') => !partyBlocks(g) && !npcBlocks(g, npc.n.name) && !(g === 'he' ? PERSON_HE : PERSON_SHE).test(plain);
    const fixable = wrong.filter(f => genderFree(f.g));
    if (fixable.length === 0) { why('someone else with those pronouns could be meant'); continue; }
    const firstEnd = local.length > 0 ? local[0]![1] : sStart;
    if (fixable.some(f => f.at < firstEnd)) { why('pronoun before the name'); continue; }
    const planned: Swap[] = [];
    let ok = true;
    for (const f of fixable) {
      const sw = swapFor(text, f.at, f.word, f.contraction, target);
      if (!sw) { ok = false; break; }
      planned.push(...sw);
    }
    if (!ok) { why('no clean replacement'); continue; }
    swaps.push(...planned);
    for (const f of fixable) fixes.push({ name: npc.n.name, from: `${f.word}${f.contraction}`, to: planned.find(x => x.start === f.at)!.to });
  }
  if (swaps.length === 0) return { text, fixes, flagged };
  let out = text;
  for (const s of swaps.sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + s.to + out.slice(s.end);
  return { text: out, fixes, flagged };
}

/**
 * `short` is another way of naming `full`: "Barnaby" for "Barnaby the
 * Bureaucratic Goose", "Pudding" for "Archivist Pudding". Live (7MJXE5) the
 * fact extractor filed "Barnaby" and "Pudding" as NPCs of their own, with no
 * pronouns, so their pronouns had to be guessed again from narration.
 */
export function namesSameNpc(short: string, full: string): boolean {
  const a = short.trim(), b = full.trim();
  if (!a || !b) return false;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const words = (n: string) => new Set(nameForms(n).filter(f => !/\s/.test(f)).map(f => f.toLowerCase()));
  const key = (n: string) => npcKeyName(n).replace(/['’]s$/u, '').replace(/[^\p{L}\p{N}'’-]/gu, '').toLowerCase();
  return (key(a).length >= 3 && words(b).has(key(a))) || (key(b).length >= 3 && words(a).has(key(b)));
}

/** Whether `text` names this NPC (any of the ways prose names them). */
export function npcMentioned(text: string, name: string): boolean {
  return !!text && mentionSpans(text, name).length > 0;
}

/** A seed's NPCs with their pronouns — stated, else read off the description (as seedWorld stores them). */
export function seedNpcPronouns(npcs: Array<{ name: string; description?: string | null; pronouns?: string | null }>): Array<{ name: string; pronouns: string }> {
  return npcs.flatMap(n => {
    const p = n.pronouns?.trim() || pronounsInDescription(n.description);
    return p ? [{ name: n.name, pronouns: p }] : [];
  });
}

/**
 * The NPCs the story has already put in front of the party: named in any of
 * `texts` (the DM's beats, earlier scene summaries), in any of the ways
 * prose names them. Round 14 (7RAAQ7): Clerk Ozymandias, met in scene 1,
 * announced "I am Clerk Ozymandias" in scene 3.
 */
export function npcsMet(names: string[], texts: string[]): string[] {
  const story = texts.filter(Boolean).join('\n');
  if (!story) return [];
  return [...new Set(names.filter(n => n?.trim() && npcMentioned(story, n)))];
}
