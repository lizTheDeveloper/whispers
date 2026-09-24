/**
 * The studio's bright lines (round 20): at EVERY content rating, mature
 * included —
 *  - no sexual content involving a minor or a child character;
 *  - no violence, injury or threat of harm aimed at a minor or a child
 *    character (PC or NPC).
 * An adult table may play a child character; the character is not
 * blocked, but the floor holds for what happens TO them.
 *
 * The judge (tone-gate.ts, the 'floor' criteria) reads for these at every
 * rating. This module is the deterministic half: the cheap first pass on
 * every gated text, and the floor itself when the judge cannot answer — the
 * floor never fails open. It is deliberately narrow (a violent verb whose
 * OBJECT is a child; a sexual term in the same sentence as a child): "the
 * kid kills time", "beat the level" and "shoots Biz a look" pass.
 */
import { childrenInParty, type PartyMember } from './agents/dm.js';
import { splitSentences } from './sentences.js';

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen'];
const AGE = new RegExp(String.raw`\b(\d{1,3}|${NUMBER_WORDS.join('|')})[- ]years?[- ]old\b`, 'gi');
/** A word that makes someone a child. */
const CHILD_WORD = /\b(?:child|children|kid|kids|boy|girl|toddler|baby|infant|urchin|youngster|schoolchild|schoolboy|schoolgirl|little one|minor|teen|teenager|adolescent|little (?:son|daughter|brother|sister))\b/gi;
/** "…of a kid", "Mom of…", "raising a child": the child word is someone else. */
const SOMEONE_ELSES = /\b(?:of|with|to|for|raising|mom|mum|mother|dad|father|parent|guardian|babysitter|nanny|teacher)\b[^,.;:!?]*$/i;

/** An age under 18 in words or digits ("seven-year-old", "15 years old"). */
function statesMinorAge(text: string): boolean {
  for (const m of text.matchAll(AGE)) {
    const raw = m[1]!.toLowerCase();
    const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS.indexOf(raw);
    if (n >= 0 && n < 18) return true;
  }
  return false;
}

/** Does this description make its subject a child? ("A ragged urchin", "the duke's seven-year-old daughter"; not "mother of a curious kid".) */
export function describesChild(text: string | null | undefined): boolean {
  if (!text) return false;
  if (statesMinorAge(text)) return true;
  for (const m of text.matchAll(CHILD_WORD)) {
    if (!SOMEONE_ELSES.test(text.slice(0, m.index))) return true;
  }
  return false;
}

/** A stated age under 18. */
function minorAge(age: number | string | undefined): boolean {
  if (age === undefined || age === null) return false;
  const n = typeof age === 'number' ? age : parseInt(String(age).match(/\d+/)?.[0] ?? '', 10);
  return Number.isFinite(n) && n < 18;
}

/**
 * The party members the floor protects: the existing child detection
 * (childrenInParty: under 13, or a companion's child), plus any age under 18
 * and any sheet that calls them a kid or a child. Wider than the gentle
 * default on purpose — the default rating still reads childrenInParty.
 */
export function minorsInParty(party: Array<Pick<PartyMember, 'name' | 'highConcept' | 'age' | 'relationships'>>): string[] {
  const kids = new Set(childrenInParty(party as PartyMember[]));
  return party.filter(m => kids.has(m.name) || minorAge(m.age) || describesChild(m.highConcept)).map(m => m.name);
}

export interface FloorContext {
  /** Minors and child characters by name: child PCs and NPCs described as children. */
  minors?: string[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CHILD_NOUN = String.raw`(?:child|children|kids?|minors?|boys?|girls?|bab(?:y|ies)|toddlers?|infants?|little\s+ones?|youngsters?|urchins?)`;
const DETERMINER = String.raw`(?:(?:the|a|an|that|this|those|these|his|her|their|my|your|our|its|some|two|three|little|young|poor|small|tiny|terrified|frightened|screaming|sleeping|crying|helpless)\s+){0,3}`;
const BODY = String.raw`(?:arms?|hands?|fingers?|legs?|feet|foot|face|head|neck|throat|chest|back|side|belly|stomach|eyes?|skull|ribs?|skin|body|heart)`;

/** First names only, each at least two letters, never a common word. */
function nameAlternatives(minors: string[]): string {
  const names = [...new Set(minors.flatMap(n => n.trim().split(/\s+/).slice(0, 1)).filter(n => /^\p{Lu}[\p{L}'’-]+$/u.test(n)))];
  return names.map(esc).join('|');
}

function childRef(minors: string[]): string {
  const names = nameAlternatives(minors);
  return names ? String.raw`(?:(?:${names})\b|${DETERMINER}${CHILD_NOUN}\b)` : String.raw`(?:${DETERMINER}${CHILD_NOUN}\b)`;
}

const VIOLENT = String.raw`(?:hit(?:s|ting)?|stab(?:s|bed|bing)?|shoot(?:s|ing)?|shot|kill(?:s|ed|ing)?|strangl(?:e|es|ed|ing)|beat(?:s|ing|en)?|cut(?:s|ting)?|burn(?:s|ed|t|ing)?|drown(?:s|ed|ing)?|punch(?:es|ed|ing)?|kick(?:s|ed|ing)?|slap(?:s|ped|ping)?|chok(?:e|es|ed|ing)|murder(?:s|ed|ing)?|slash(?:es|ed|ing)?|whip(?:s|ped|ping)?|tortur(?:e|es|ed|ing)|maim(?:s|ed|ing)?|behead(?:s|ed|ing)?|smother(?:s|ed|ing)?|strik(?:e|es|ing)|struck|attack(?:s|ed|ing)?|wound(?:s|ed|ing)?|injur(?:e|es|ed|ing)|hurt(?:s|ing)?|harm(?:s|ed|ing)?|bludgeon(?:s|ed|ing)?|butcher(?:s|ed|ing)?|execut(?:e|es|ed|ing)|hanged|impal(?:e|es|ed|ing)|skewer(?:s|ed|ing)?|throttl(?:e|es|ed|ing)|pummel(?:s|led|ling)?|batter(?:s|ed|ing)?)`;
const PARTICIPLE = String.raw`(?:hit|stabbed|shot|killed|strangled|beaten|cut|burned|burnt|drowned|punched|kicked|slapped|choked|murdered|slashed|whipped|tortured|maimed|beheaded|smothered|struck|attacked|wounded|injured|hurt|harmed|bludgeoned|butchered|executed|hanged|impaled|skewered|throttled|pummelled|pummeled|battered)`;
const THREAT = String.raw`\bthreat(?:en(?:s|ed|ing)?)?\s+(?:to\s+)?`;
const WEAPON = String.raw`(?:a\s+|an\s+|his\s+|her\s+|their\s+|the\s+)?(?:knife|blade|dagger|gun|pistol|rifle|sword|axe|club|spear|crossbow|bow|death|violence|fire)`;

/** What follows the object that makes it play, not violence: "cuts the kid some slack", "beat Biz at chess", "shoots Biz a look", "hits Biz with a pillow". */
const NOT_VIOLENCE_AFTER = /^\s*(?:some\s+slack|(?:at|in)\s+(?:chess|cards|checkers|a\s+race|the\s+race|a\s+game|the\s+game|tag|arm[- ]wrestling|\w+ing\b)|(?:a|one|another)\s+(?:look|glance|smile|grin|wink|glare|question|query|nod)|with\s+(?:a\s+|the\s+)?(?:pillow|snowball|water\s+balloon|foam|feather|pool\s+noodle|tickle))/i;
const NOT_VIOLENCE_BEFORE = /\b(?:pillow|snowball|tickle|tag)\s*$/i;

const SEXUAL = /\b(?:sex|sexual(?:ly|ity)?|sexy|naked|nude|nudity|undress(?:es|ed|ing)?|aroused|arousal|erotic(?:ally)?|fondl(?:e|es|ed|ing)|molest\w*|grop(?:e|es|ed|ing)|intercourse|orgasm\w*|genital\w*|lewd(?:ly)?|lust(?:s|ed|ing|ful|fully)?|seduc(?:e|es|ed|ing|tion|tive)|rap(?:e|es|ed|ing|ist)|sensual(?:ly)?|lingerie|strip(?:s|ped)?\s+(?:her|him|them|naked))\b/gi;
/** "the naked flame", "naked ambition": not about a body. */
const NOT_SEXUAL_AFTER = /^\s*(?:flames?|eyes?|blades?|steel|truth|ambition|greed|fear|light|bulbs?|wires?|branches|trees|rock|stone|sword)\b/i;

/** Does this one sentence cross the floor? */
function sentenceBreaches(sentence: string, minors: string[]): boolean {
  const ref = childRef(minors);
  // Violence with a child as its object, active or passive, or a threat with a weapon.
  const active = new RegExp(String.raw`\b${VIOLENT}\s+(?:(?:at|into|on|upon|down)\s+)?(${ref})(?:(['’]s)\s+(?:\w+\s+)?(${BODY})\b)?`, 'gi');
  for (const m of sentence.matchAll(active)) {
    const after = sentence.slice(m.index! + m[0].length);
    const possessive = /^['’]s\b/.test(after) && !m[3];
    if (possessive) continue; // "burns Biz's map": the thing, not the child
    if (NOT_VIOLENCE_AFTER.test(after) || NOT_VIOLENCE_BEFORE.test(sentence.slice(0, m.index))) continue;
    return true;
  }
  const passive = new RegExp(String.raw`(${ref})\s+(?:is|was|were|are|gets|got|get|has\s+been|had\s+been|have\s+been|being|is\s+being|was\s+being)\s+(?:\w+ly\s+)?${PARTICIPLE}\b`, 'gi');
  for (const m of sentence.matchAll(passive)) {
    const after = sentence.slice(m.index! + m[0].length);
    if (/^\s+(?:by|with)\s+(?:a\s+|the\s+)?(?:pillow|snowball|water\s+balloon|feather|ball|idea|thought|realization|inspiration|wave\s+of)/i.test(after)) continue;
    return true;
  }
  if (new RegExp(String.raw`${THREAT}(${ref})\s+with\s+${WEAPON}\b`, 'i').test(sentence)) return true;
  // A weapon aimed at a child: "raises his pistol at the kid", "levels a crossbow at Biz".
  if (new RegExp(String.raw`\b(?:rais|aim|point|level|swing|throw|train|draw)(?:s|es|ed|ing)?\s+${WEAPON}\s+(?:\w+\s+){0,2}(?:at|toward|towards)\s+(${ref})`, 'i').test(sentence)) return true;
  // Sexual content and a child in the same sentence.
  const child = new RegExp(ref, 'i');
  if (child.test(sentence)) {
    for (const m of sentence.matchAll(SEXUAL)) {
      if (/^(?:naked|nude)$/i.test(m[0]) && NOT_SEXUAL_AFTER.test(sentence.slice(m.index! + m[0].length))) continue;
      return true;
    }
  }
  return false;
}

/** The sentences of `text` that cross the floor, exactly as they appear in it. */
export function floorBackstop(text: string, ctx: FloorContext = {}): string[] {
  if (!text?.trim()) return [];
  const minors = (ctx.minors ?? []).filter(Boolean);
  return splitSentences(text).filter(s => sentenceBreaches(s, minors));
}

/** `text` without the sentences that cross the floor (logged with [floor]). */
export function withoutFloorBreaches(text: string, ctx: FloorContext = {}, label = 'text'): { text: string; removed: string[] } {
  const removed = floorBackstop(text, ctx);
  if (removed.length === 0) return { text, removed };
  let out = text;
  for (const s of removed) {
    const at = out.indexOf(s);
    if (at < 0) continue;
    out = `${out.slice(0, at).replace(/[ \t]+$/, '')} ${out.slice(at + s.length).replace(/^[ \t]+/, '')}`;
  }
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
  for (const s of removed) console.warn(`[floor] ${label}: removed by the deterministic backstop: "${s.slice(0, 160)}"`);
  return { text: out, removed };
}
