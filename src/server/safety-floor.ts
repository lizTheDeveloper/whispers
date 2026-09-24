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
 *
 * Round 21 (live FYXZTP): who is protected is sticky and read from anything
 * the story says (childReferencesIn — the game loop keeps the list, with
 * why, for the whole game); a pronoun or an addressed "you" that means the
 * protected person is them; and a clause that clearly refuses or denies
 * the violence ("I am not a monster who hurts children") passes.
 *
 * Round 22 (live BH9P94): precision. An apposition never crosses a quote
 * or takes a possessive ("Captain Vane, 'Your boy…'" is not Vane); "the
 * boy" in a sentence about an adult NPC is the protected child already in
 * the story; a weak inference never protects someone whose own seed or
 * sheet makes them an adult; and a refusal ("wants me to…, but that's a
 * death sentence") or a warning ("Fire, and you kill the boy", "…ensures
 * Vane shoots Pip") passes, while a threat does not.
 */
import { childrenInParty, type PartyMember } from './agents/dm.js';
import { splitSentences } from './sentences.js';

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen'];
const AGE = new RegExp(String.raw`\b(\d{1,3}|${NUMBER_WORDS.join('|')})[- ]years?[- ]old\b`, 'gi');
/** A word that makes someone a child. */
const CHILD_WORD = /\b(?:child|children|kid|kids|boy|girl|toddler|baby|infant|urchin|youngster|schoolchild|schoolboy|schoolgirl|little one|minor|teen|teenager|adolescent|little (?:son|daughter|brother|sister))\b/gi;
/**
 * Round 21 (FYXZTP): "A young man, barely out of boyhood" — Silas was called
 * "the cabin boy" and "a ten-year-old" in play, and the draft's own words
 * said it. Out of (or not yet out of) boyhood, not yet grown: a child.
 */
const CHILDHOOD = /\b(?:(?:barely|scarcely|hardly|just|only\s+just|not\s+long|fresh|newly|not\s+yet)\s+out\s+of\s+(?:boy|girl|child)hood|still\s+in\s+(?:his|her|their)\s+(?:boy|girl|child)hood|not\s+yet\s+(?:a\s+(?:grown\s+)?(?:man|woman)|grown|of\s+age|an\s+adult))\b/i;
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
  if (CHILDHOOD.test(text)) return true;
  for (const m of text.matchAll(CHILD_WORD)) {
    if (!SOMEONE_ELSES.test(text.slice(0, m.index))) return true;
  }
  return false;
}

/** Head nouns that make a description's subject a grown-up ("A broad-shouldered man…"). */
const ADULT_NOUN = /^(?:man|men|woman|women|gentleman|gentlewoman|lady|adult|grown-?up|veteran|widow|widower|matron|crone|hag|patriarch|matriarch|grandfather|grandmother|greybeard|graybeard|elder|old-timer|husband|wife|father|mother)$/i;
/** Words in that noun phrase that only a grown-up is ("A grizzled sailor", "a bearded cook"). */
const ADULT_ADJ = /^(?:grizzled|elderly|middle-aged|bearded|grey-bearded|gray-bearded|white-bearded|grey-haired|gray-haired|white-haired|silver-haired|balding|bald|wizened|aged|old|ancient|weathered|wrinkled|venerable)$/i;
/** An age of 18 or more: "a 45-year-old", "in his fifties", "aged 60". */
const ADULT_AGE = /\b(?:(?:1[89]|[2-9]\d|1\d\d)[- ]years?[- ]old|in\s+(?:his|her|their)\s+(?:(?:early|mid|late)[- ])?(?:twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)|aged\s+(?:1[89]|[2-9]\d))\b/i;
/** Where a description's first noun phrase ends. */
const NP_END = /^(?:with|who|whom|whose|that|which|in|of|from|and|but|on|at|by|whose|carrying|wearing|holding|named|called)$/i;

/**
 * Does this description explicitly make its subject an adult (round 22)?
 * "A broad-shouldered man with a beard", "A man carved from iron", "a
 * grizzled sailor", "a 45-year-old". Read off the first noun phrase only,
 * so "the old man's son" is not the old man; and never when anything in it
 * makes them a child. "A young man" is not enough — the live FYXZTP child
 * was "a young man, barely out of boyhood".
 */
export function describesAdult(text: string | null | undefined): boolean {
  if (!text?.trim() || describesChild(text)) return false;
  if (ADULT_AGE.test(text)) return true;
  const first = text.trim().split(/(?<=[.!?])\s+/)[0] ?? '';
  const np: string[] = [];
  for (const raw of first.replace(/^(?:(?:he|she|they)\s+(?:is|was|are|were)\s+)/i, '').split(/\s+/)) {
    const w = raw.replace(/^[^\p{L}]+/u, '');
    const bare = w.replace(/[^\p{L}'’-]+$/u, '');
    if (np.length > 0 && NP_END.test(bare)) break;
    np.push(bare);
    // A possessive or a clause break ends the phrase: "The old man's son", "A man, carved…".
    if (/['’]s$/.test(bare) || /[,;:—–]$/.test(w)) break;
  }
  const words = np.map(w => w.toLowerCase()).filter(w => !/^(?:a|an|the|this|that)$/.test(w));
  if (words.some(w => /['’]s$/.test(w))) return false;
  const young = words.includes('young') || words.includes('younger');
  if (!young && words.some(w => ADULT_NOUN.test(w))) return true;
  return words.some(w => ADULT_ADJ.test(w));
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

/** Someone the floor protects, and why (round 21: the judge is told both). */
export interface ProtectedPerson {
  name: string;
  why: string;
}

export interface FloorContext {
  /** Minors and child characters by name: child PCs and NPCs described as children. */
  minors?: string[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const UNDER_18 = String.raw`(?:1[0-7]|[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)`;
/** "the cabin boy", "a stable girl": a job that makes the noun a child (round 21, FYXZTP: "Cut the cabin boy"). */
const BOY_JOB = String.raw`(?:(?:cabin|stable|errand|kitchen|ship['’]s|serving|farm|shop|paper|messenger|street|powder|school)[- ])`;
const CHILD_NOUN = String.raw`(?:child|children|kids?|minors?|${BOY_JOB}?boys?|${BOY_JOB}?girls?|bab(?:y|ies)|toddlers?|infants?|little\s+ones?|youngsters?|urchins?|${UNDER_18}[- ]years?[- ]olds?)`;
const DETERMINER = String.raw`(?:(?:the|a|an|that|this|those|these|his|her|their|my|your|our|its|some|two|three|little|young|poor|small|tiny|terrified|frightened|screaming|sleeping|crying|helpless|scared|trembling|chained)\s+){0,3}`;
const BODY = String.raw`(?:arms?|hands?|fingers?|legs?|feet|foot|face|head|neck|throat|windpipe|chest|back|side|belly|stomach|guts?|eyes?|skull|ribs?|skin|body|heart|ears?|nose|jaw|teeth|tongue)`;

/** Honorifics and ranks: never the part of a name the story calls someone by ("Crewman Silas" is Silas). */
const TITLES = new Set(['sir', 'lady', 'lord', 'dame', 'master', 'mistress', 'miss', 'mister', 'madam', 'captain', 'capt', 'crewman', 'crewmate', 'bosun', 'boatswain', 'mate', 'first', 'second', 'deckhand', 'sailor', 'seaman', 'cabin', 'young', 'old', 'little', 'big', 'the', 'a', 'an', 'mr', 'mrs', 'ms', 'mx', 'dr', 'doctor', 'professor', 'prof', 'father', 'mother', 'brother', 'sister', 'uncle', 'aunt', 'auntie', 'grandma', 'grandpa', 'king', 'queen', 'prince', 'princess', 'duke', 'duchess', 'baron', 'baroness', 'count', 'countess', 'sergeant', 'sgt', 'officer', 'corporal', 'private', 'lieutenant', 'lt', 'commander', 'admiral', 'general', 'colonel', 'major', 'guard', 'clerk', 'boy', 'girl', 'kid', 'child']);

/**
 * The words a protected name is called by: the whole name, and each of its
 * capitalised words that is not a title — "Crewman Silas" is "Crewman
 * Silas" and "Silas" (round 21: the first word alone was "Crewman").
 */
export function protectedNameWords(names: string[]): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const name = (raw ?? '').trim().replace(/^(?:the|a|an)\s+/i, '');
    if (!name) continue;
    if (/^\p{Lu}/u.test(name)) out.add(name);
    for (const w of name.split(/\s+/)) {
      const word = w.replace(/[^\p{L}'’-]/gu, '');
      if (/^\p{Lu}[\p{L}'’-]+$/u.test(word) && !TITLES.has(word.toLowerCase())) out.add(word);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** The names of a protected list, whichever form it came in. */
export function protectedNames(list: Array<string | ProtectedPerson> | undefined): string[] {
  return [...new Set((list ?? []).map(p => (typeof p === 'string' ? p : p?.name ?? '').trim()).filter(Boolean))];
}

function nameAlternatives(minors: string[]): string {
  return protectedNameWords(minors).map(esc).join('|');
}

function childRef(minors: string[]): string {
  const names = nameAlternatives(minors);
  return names ? String.raw`(?:(?:${names})\b|${DETERMINER}${CHILD_NOUN}\b)` : String.raw`(?:${DETERMINER}${CHILD_NOUN}\b)`;
}

const VIOLENT = String.raw`(?:hit(?:s|ting)?|stab(?:s|bed|bing)?|shoot(?:s|ing)?|shot|kill(?:s|ed|ing)?|strangl(?:e|es|ed|ing)|beat(?:s|ing|en)?|cut(?:s|ting)?|burn(?:s|ed|t|ing)?|drown(?:s|ed|ing)?|punch(?:es|ed|ing)?|kick(?:s|ed|ing)?|slap(?:s|ped|ping)?|chok(?:e|es|ed|ing)|murder(?:s|ed|ing)?|slash(?:es|ed|ing)?|whip(?:s|ped|ping)?|tortur(?:e|es|ed|ing)|maim(?:s|ed|ing)?|behead(?:s|ed|ing)?|smother(?:s|ed|ing)?|strik(?:e|es|ing)|struck|attack(?:s|ed|ing)?|wound(?:s|ed|ing)?|injur(?:e|es|ed|ing)|hurt(?:s|ing)?|harm(?:s|ed|ing)?|bludgeon(?:s|ed|ing)?|butcher(?:s|ed|ing)?|execut(?:e|es|ed|ing)|hanged|impal(?:e|es|ed|ing)|skewer(?:s|ed|ing)?|throttl(?:e|es|ed|ing)|pummel(?:s|led|ling)?|batter(?:s|ed|ing)?|bit(?:e|es|ing|ten)|gut(?:s|ted|ting)?|slit(?:s|ting)?|gouge[sd]?|gouging|maul(?:s|ed|ing)?|savag(?:e|es|ed|ing)|(?:lung|charg)(?:e|es|ed|ing)\s+at|(?:leap|spring|launch|rush|swing|com)(?:s|es|ed|t|ing|e)?\s+at|sprang\s+at|swung\s+at|came\s+at)`;
const PARTICIPLE = String.raw`(?:hit|stabbed|shot|killed|strangled|beaten|cut|burned|burnt|drowned|punched|kicked|slapped|choked|murdered|slashed|whipped|tortured|maimed|beheaded|smothered|struck|attacked|wounded|injured|hurt|harmed|bludgeoned|butchered|executed|hanged|impaled|skewered|throttled|pummelled|pummeled|battered|bitten|gutted|mauled)`;
const THREAT = String.raw`\bthreat(?:en(?:s|ed|ing)?)?\s+(?:to\s+)?`;
const WEAPON = String.raw`(?:a\s+|an\s+|his\s+|her\s+|their\s+|the\s+|my\s+|your\s+)?(?:knife|blade|dagger|gun|pistol|rifle|sword|axe|club|spear|crossbow|bow|death|violence|fire|razor|cutlass|steel|musket|hook)`;
/** Grabbing or seizing someone BY THE THROAT — a grab alone is not violence ("grab the kid's hand to pull them clear"). */
const GRAB = String.raw`(?:grab(?:s|bed|bing)?|seiz(?:e|es|ed|ing)|clutch(?:es|ed|ing)?|squeez(?:e|es|ed|ing)|grip(?:s|ped|ping)?|clamp(?:s|ed|ing)?|go(?:es|ing)?\s+for|went\s+for|tear(?:s|ing)?\s+(?:at|out)|rip(?:s|ped|ping)?\s+(?:at|out))`;
const THROAT = String.raw`(?:throat|neck|windpipe)`;

/** What follows the object that makes it play, not violence: "cuts the kid some slack", "beat Biz at chess", "shoots Biz a look", "hits Biz with a pillow". */
const NOT_VIOLENCE_AFTER = /^\s*(?:some\s+slack|(?:at|in)\s+(?:chess|cards|checkers|a\s+race|the\s+race|a\s+game|the\s+game|tag|arm[- ]wrestling|\w+ing\b)|(?:a|one|another)\s+(?:look|glance|smile|grin|wink|glare|question|query|nod)|with\s+(?:a\s+|the\s+)?(?:pillow|snowball|water\s+balloon|foam|feather|pool\s+noodle|tickle))/i;
const NOT_VIOLENCE_BEFORE = /\b(?:pillow|snowball|tickle|tag)\s*$/i;

const SEXUAL = /\b(?:sex|sexual(?:ly|ity)?|sexy|naked|nude|nudity|undress(?:es|ed|ing)?|aroused|arousal|erotic(?:ally)?|fondl(?:e|es|ed|ing)|molest\w*|grop(?:e|es|ed|ing)|intercourse|orgasm\w*|genital\w*|lewd(?:ly)?|lust(?:s|ed|ing|ful|fully)?|seduc(?:e|es|ed|ing|tion|tive)|rap(?:e|es|ed|ing|ist)|sensual(?:ly)?|lingerie|strip(?:s|ped)?\s+(?:her|him|them|naked))\b/gi;
/** "the naked flame", "naked ambition": not about a body. */
const NOT_SEXUAL_AFTER = /^\s*(?:flames?|eyes?|blades?|steel|truth|ambition|greed|fear|light|bulbs?|wires?|branches|trees|rock|stone|sword)\b/i;

// ─── Refusals (round 21) ─────────────────────────────────────────────────────
//
// Live FYXZTP: the backstop removed Mara's refusals — "…I am not a monster
// who hurts children for leverage." and "If I wanted to cut the boy, I
// wouldn't be standing here with my hands open." A clause that clearly
// NEGATES the violence, or puts it in a counterfactual it then denies,
// passes. Narrow on purpose: "does not hesitate and stabs the boy", "never
// stops until he has killed the boy" and "didn't mean to hurt the boy" are
// still violence.

/** A negation bound to the verb that follows it. */
const NEGATION = /(?:\b(?:not|never)\b|n['’]t\b|\bcannot\b|\brefus(?:e|es|ed|ing)\s+to\b|\bwill\s+not\b|\b(?:no\s*one|nobody|no\s+man)\s+(?:will|shall|is\s+going\s+to)\b)/gi;
/** Words between a negation and the verb that break the negation's hold on it. */
const NEGATION_BREAK = /\b(?:and|but|then|so|yet|or|until|unless|before|after|while|once|hesitat\w*|wait\w*|stop\w*|paus\w*|flinch\w*|mind\w*|care\w*|fail\w*|think\w*|only|hold\w*\s+back|mean|meant|intend\w*|bother\w*|matter\w*|regret\w*|sure)\b/i;
/** "If I wanted to cut the boy, …" — the if-clause of a counterfactual… */
const COUNTERFACTUAL_IF = /\bif\s+(?:I|we|you|he|she|they|it)\s+(?:had\s+)?(?:really\s+)?(?:wanted|meant|intended|wished|planned|was\s+going|were\s+going)\s+to\b/i;
/** …that the rest of the sentence denies: "…, I wouldn't be standing here". */
const COUNTERFACTUAL_DENIAL = /\b(?:wouldn['’]t|would\s+not|would\s+never|couldn['’]t\s+be|wouldn['’]t\s+be)\b/i;
/** "The voice wants me to…", "tells me to…": an instruction to the speaker… */
const INSTRUCTED = /\b(?:wants?|wanted|tells?|told|urges?|urged|asks?|asked|begs?|begged|whispers?\s+(?:for|at)|orders?|ordered|commands?|commanded|expects?|expected)\s+(?:me|us)\s+to\b/i;
/** …that the speaker then refuses: "…, but I am not a monster", "and I won't". */
const REFUSAL = /(?:,|;|—|–|\bbut\b|\band\b)[^.!?]*\b(?:I|we)\s*(?:will\s+not|won['’]t|refuse|cannot|can['’]t|will\s+never|would\s+never|do\s+not|don['’]t|never|(?:am|are|['’]m|['’]re)\s+not\s+(?:a|an|going|gonna|that|the|some|about|doing|hurting|harming|here\s+to))\b/i;

/**
 * Round 22 (BH9P94): "The voice wants me to grab Pip by the throat, but
 * that's a death sentence…" was removed; "…break Pip's arm, but I'm too
 * rattled" was kept. After an instruction to the speaker, a "but" that
 * declines it — the speaker cannot, will not, is too…, has nothing to do it
 * with, or calls it death, madness or wrong — is a refusal. A "but" that
 * does not decline ("but first I bar the door") is not.
 */
const DECLINE = /\bbut\b[^.!?;]{0,40}?\b(?:(?:I|we)\s*(?:['’]m|am|are|['’]re)\s+(?:too|not|no|unarmed|carrying\s+nothing)\b|(?:I|we)\s+(?:have|['’]ve\s+got|['’]ve|got|hold|carry)\s+(?:no|nothing)\b|(?:I|we)\s+(?:can['’]t|cannot|won['’]t|will\s+not|refuse|don['’]t|do\s+not|never|wouldn['’]t|would\s+never|couldn['’]t|could\s+never|shan['’]t)\b|(?:that|this|it)(?:['’]s|\s+is|\s+would\s+be|['’]d\s+be|\s+will\s+be|['’]ll\s+be|\s+means|\s+would\s+mean)\s+(?:a\s+|an\s+|my\s+|our\s+|certain\s+|sure\s+)*(?:death|suicide|madness|insan\w*|folly|foolish\w*|mistake|wrong|monstrous|murder|evil|unthinkable|out\s+of\s+the\s+question|never\s+going\s+to\s+happen|not\s+happening|not\s+who\s+I\s+am)\b|not\s+(?:today|now|this|like\s+this|a\s+child|a\s+kid)\b|no(?:\s*[,.!—–]|\s+way\b))/i;

/**
 * Round 22 (BH9P94): a warning is not a threat. "Fire, and you kill the
 * boy you need to keep quiet" and "…killing him ensures Vane shoots Pip"
 * were removed. A threat is "do X or I'll hurt the boy"; a warning is "if
 * you do X, you kill the boy" or "X means Vane shoots Pip". Exempt only
 * these shapes, in the present or future, with "you" or a third party —
 * never the speaker (I, we, my men) — as the one who would do it.
 */
const MODAL = String.raw`(?:(?:will|['’]ll|would|['’]d|could|might|may|can|is\s+going\s+to|are\s+going\s+to|['’]s\s+going\s+to|['’]re\s+going\s+to)\s+(?:only\s+|just\s+|probably\s+|surely\s+)?)?`;
/**
 * "If you fire, you…", "the moment you move, you…", and (BPWLEL) the same
 * with a third party: "If he fires, he'll hit the kid". Never I/we.
 */
const WARN_SUBJECT = String.raw`(?:you|he|she|they|the\s+[\p{L}'’-]+)`;
const WARN_IF_YOU = new RegExp(String.raw`\b(?:if|once|when|the\s+moment|the\s+second|as\s+soon\s+as)\s+${WARN_SUBJECT}\b[^.!?;]*,\s*${WARN_SUBJECT}\s*${MODAL}$`, 'iu');
/** "You aim at the thief, you shoot the child." (BPWLEL, spoken to the shooter): a warning with no "if". */
const WARN_YOU_COMMA = new RegExp(String.raw`^\s*["“‘']?\s*you\s+[^.!?;,]*,\s*you\s*${MODAL}$`, 'i');
/** "Fire, and you…", "Pull that trigger and you'll…": a short imperative, then "and you". */
const WARN_AND_YOU = new RegExp(String.raw`^\s*["“‘']?\s*((?:[\p{L}'’-]+\s+){0,5}[\p{L}'’-]+)\s*,?\s+(?:and|or)\s+you\s*${MODAL}$`, 'iu');
/** "…ensures Vane shoots Pip", "…means Grell stabs the boy": a prediction with someone else as the harmer. */
const WARN_PREDICTS = new RegExp(String.raw`\b(?:[Ee]nsures?|[Mm]eans|[Gg]uarantees?|(?:will|would)\s+(?:mean|ensure|guarantee))\s+(?:that\s+)?(?:you|he|she|they|the\s+\p{Ll}[\p{Ll}'’-]*|\p{Lu}[\p{Ll}'’-]+(?:\s+\p{Lu}[\p{Ll}'’-]+)?)\s*${MODAL}$`, 'u');
/** The speaker, or their own people, doing it: a threat, never a warning. */
const SPEAKER_SIDE = /\b(?:I|we|my|our|me|us)\b/i;
/**
 * A verb that is only ever past: what happened, not a warning of what would.
 * BPWLEL: the old ending test read "shoot" (…ot) and "hit"/"cut" as past, so
 * "You aim at the thief, you shoot the child" lost its warning exemption.
 * Forms that are also present (hit, cut, beat, slit, hurt) are not listed.
 */
const PAST_VERB = /(?:ed|ew)$|^(?:shot|struck|stuck|stung|slung|flung|hung|sprang|slew|smote|bit|stabbed|fought|caught|brought|thought)$/i;

function warned(sentence: string, index: number, verb: string): boolean {
  if (PAST_VERB.test(verb.trim().split(/\s+/)[0] ?? '')) return false;
  const lead = sentence.slice(0, index);
  if (WARN_IF_YOU.test(lead)) return true;
  if (WARN_YOU_COMMA.test(lead)) return true;
  const and = WARN_AND_YOU.exec(lead);
  // The imperative is the whole lead: not "You lunge and you…", not "Grell lunges, and you…" narrated.
  if (and && !/^(?:I|you|he|she|we|they|it)$/i.test(and[1]!.trim().split(/\s+/)[0] ?? '') && !SPEAKER_SIDE.test(and[1]!)) return true;
  const from = clauseStart(sentence, index);
  const clause = sentence.slice(from, index);
  const pred = WARN_PREDICTS.exec(clause);
  if (pred && !SPEAKER_SIDE.test(clause.slice(0, pred.index).split(/\s+/).slice(-2).join(' ')) && !SPEAKER_SIDE.test(pred[0])) return true;
  return false;
}

/** "…anyone who'd hurt him", "whoever tries to harm the boy": a would-be attacker, named to guard against. */
const WOULD_BE = /\b(?:anyone|anybody|whoever|those|any\s+[\p{L}'’-]+|someone|somebody)(?:\s+(?:who|that))?(?:['’]d|\s+would|\s+might|\s+could|\s+tries\s+to|\s+try\s+to|\s+dares?\s+to|\s+wants?\s+to|\s+means?\s+to|\s+thinks?\s+(?:about|of)|\s+who)\s*$/iu;

/** The clause around `index`: back to the last , ; : — or the start of the sentence. */
function clauseStart(sentence: string, index: number): number {
  const before = sentence.slice(0, index);
  const m = [...before.matchAll(/[,;:—–]/g)].pop();
  return m ? m.index! + 1 : 0;
}

/** Is the violence at `index` clearly negated, counterfactual and denied, an instruction the speaker refuses, or a warning against it? */
function refused(sentence: string, index: number, verb = ''): boolean {
  if (verb && warned(sentence, index, verb)) return true;
  const from = clauseStart(sentence, index);
  const lead = sentence.slice(from, index);
  if (WOULD_BE.test(lead)) return true;
  // A negation within a few words of the verb, with nothing between that breaks its hold.
  for (const m of lead.matchAll(NEGATION)) {
    const between = lead.slice(m.index! + m[0].length);
    if (between.trim().split(/\s+/).filter(Boolean).length <= 4 && !NEGATION_BREAK.test(between)) return true;
  }
  // "If I wanted to cut the boy, I wouldn't…": the violence inside the if-clause, and the rest denies it.
  const whole = sentence.slice(0, index);
  const cf = [...whole.matchAll(new RegExp(COUNTERFACTUAL_IF.source, 'gi'))].pop();
  if (cf && !/[.;!?]/.test(whole.slice(cf.index!))) {
    const rest = sentence.slice(index);
    const comma = rest.search(/[,;—–]/);
    if (comma >= 0 && COUNTERFACTUAL_DENIAL.test(rest.slice(comma))) return true;
  }
  // "The voice wants me to put a knife to his throat, but … I am not a monster…".
  const ins = [...whole.matchAll(new RegExp(INSTRUCTED.source, 'gi'))].pop();
  if (ins && (REFUSAL.test(sentence.slice(index)) || DECLINE.test(sentence.slice(index)))) return true;
  return false;
}

// ─── Who a pronoun is (round 21) ─────────────────────────────────────────────
//
// Live FYXZTP: "I lunge at Silas, grabbing his throat" was offered to Aldric,
// and Mara's closing words were "Silas, keep your hands where I can see them,
// or I will bite your throat out." The backstop only knew a name or a child
// noun as the object. A pronoun after the only protected person in the
// sentence is that person — unless the protected person is the one doing it
// ("Biz kicks his legs", "the boy cuts his hand on the rope"), or someone
// else is named in between. "you"/"your" is the protected person when the
// sentence addresses them ("Silas, …") and the speaker threatens ("or I will…").

const OBJ_PRONOUN = String.raw`(?:him|her|them)`;
const POSS_PRONOUN = String.raw`(?:his|her|their)`;
/** The speaker's own threat: "or I will", "I'll", "I'm going to". */
const SPEAKER_THREAT = /\bI(?:['’]ll|\s+will|\s+shall|\s+am\s+going\s+to|['’]m\s+going\s+to|['’]m\s+gonna|\s+swear\s+I['’]ll|\s+swear\s+I\s+will)\b/i;
/** A subject word: someone else doing the verb. */
const OTHER_SUBJECT = /(?:^|[^\p{L}])(?:I|he|she|they|we|you|someone|somebody|anyone|\p{Lu}[\p{Ll}'’-]+)(?![\p{L}])/u;

interface Ref { start: number; end: number; text: string }

function refsIn(sentence: string, ref: string): Ref[] {
  return [...sentence.matchAll(new RegExp(ref, 'gi'))].map(m => ({ start: m.index!, end: m.index! + m[0].length, text: m[0] }));
}

/** The protected people a sentence names: distinct names (a child noun counts as one "someone"). */
function distinctProtected(refs: Ref[], names: string[]): number {
  const seen = new Set<string>();
  for (const r of refs) {
    const name = names.find(n => r.text.toLowerCase() === n.toLowerCase());
    seen.add(name ? name.toLowerCase() : '(child)');
  }
  return seen.size;
}

/**
 * Does the pronoun at `at` refer back to a protected person? Only when the
 * sentence names exactly one, before the pronoun, with nobody else named
 * in between, and the protected person is not the subject of this clause.
 */
function pronounIsProtected(sentence: string, at: number, verbAt: number, refs: Ref[], names: string[]): boolean {
  if (refs.length === 0 || distinctProtected(refs, names) !== 1) return false;
  const prior = refs.filter(r => r.end <= at);
  if (prior.length === 0) return false;
  const last = prior[prior.length - 1]!;
  // Someone else named between the protected person and the pronoun.
  // (Not the one doing it: "Silas screams as Grell punches him" — Grell is the subject.)
  const between = sentence.slice(last.end, at);
  const others = [...between.matchAll(/(?<![\p{L}'’])(\p{Lu}[\p{Ll}'’-]+)(?![\p{L}])/gu)]
    .filter(m => m[1] !== 'I' && !names.some(n => n.toLowerCase() === m[1]!.toLowerCase()))
    .filter(m => !/^\s+(?:\w+ly\s+)?$/.test(sentence.slice(last.end + m.index! + m[0].length, verbAt)));
  if (others.length > 0) return false;
  // The protected person doing it to themselves: they are the subject of the verb's clause.
  const from = clauseStart(sentence, verbAt);
  const lead = sentence.slice(from, verbAt);
  const own = refs.find(r => r.start >= from && r.end <= verbAt);
  if (own) {
    const rest = lead.slice(0, own.start - from) + lead.slice(own.end - from);
    if (!OTHER_SUBJECT.test(rest)) return false;
  }
  return true;
}

/** Where someone is addressed: the start, after a quote or colon, or after a comma (", and Silas, …"). */
const VOCATIVE_BEFORE = /(?:^|["“‘'(:]\s*|[.!?]\s+|[,;—–]\s*(?:(?:and|but|or|so|now|then|oh|hey)\s+)?)$/;

/**
 * Is "you" at `at` a protected person? The last one addressed before it
 * ("Silas, …", "…, and Silas, …", "…, boy, …") must be protected — "Kael,
 * hold that ladder, and Silas, keep your hands…, or I will bite your throat
 * out" is Silas; "Silas, get below, and Grell, drop the knife or I will cut
 * your throat" is Grell.
 */
function youAreProtected(sentence: string, at: number, refs: Ref[]): boolean {
  const addressedAt = (start: number, end: number) => VOCATIVE_BEFORE.test(sentence.slice(0, start)) && /^\s*[,!]/.test(sentence.slice(end));
  const vocatives: Array<{ at: number; protected: boolean }> = [];
  for (const r of refs) if (addressedAt(r.start, r.end)) vocatives.push({ at: r.start, protected: true });
  for (const m of sentence.matchAll(/(?<![\p{L}'’-])(\p{Lu}[\p{L}'’-]+)(?![\p{L}'’-])/gu)) {
    const start = m.index!, end = start + m[0].length;
    if (refs.some(r => start >= r.start && start < r.end)) continue;
    if (addressedAt(start, end)) vocatives.push({ at: start, protected: false });
  }
  const last = vocatives.filter(v => v.at < at).sort((a, b) => b.at - a.at)[0];
  return !!last?.protected;
}

/** Does this one sentence cross the floor? */
function sentenceBreaches(sentence: string, minors: string[]): boolean {
  const ref = childRef(minors);
  const names = protectedNameWords(minors);
  const refs = refsIn(sentence, ref);
  // "you" can be a protected person only when the speaker threatens ("or I will…").
  const threatens = refs.length > 0 && SPEAKER_THREAT.test(sentence);
  const pronouns = threatens ? String.raw`${OBJ_PRONOUN}|you` : OBJ_PRONOUN;
  const possessives = threatens ? String.raw`${POSS_PRONOUN}|your` : POSS_PRONOUN;
  /** A pronoun object at `at` that is not the protected person: the match does not count. */
  const pronounOk = (text: string, at: number, verbAt: number): boolean => {
    if (/^(?:you|your)$/i.test(text)) return threatens && youAreProtected(sentence, at, refs);
    return pronounIsProtected(sentence, at, verbAt, refs, names);
  };
  const isPronoun = (text: string) => new RegExp(String.raw`^(?:${pronouns}|${possessives})$`, 'i').test(text.trim());

  // Violence with a child as its object, active or passive, or a threat with a weapon.
  const active = new RegExp(String.raw`\b(${VIOLENT})\s+(?:(?:at|into|on|upon|down|out)\s+)?(${ref}|\b(?:${pronouns})\b|\b(?:${possessives})\b(?=\s+(?:\w+\s+)?${BODY}\b))(?:(['’]s)\s+(?:\w+\s+)?(${BODY})\b)?`, 'gi');
  for (const m of sentence.matchAll(active)) {
    const obj = m[2]!;
    const objAt = m.index! + m[0].indexOf(obj, m[1]!.length);
    if (isPronoun(obj) && !pronounOk(obj, objAt, m.index!)) continue;
    const after = sentence.slice(m.index! + m[0].length);
    const possessive = /^['’]s\b/.test(after) && !m[4];
    if (possessive) continue; // "burns Biz's map": the thing, not the child
    if (NOT_VIOLENCE_AFTER.test(after) || NOT_VIOLENCE_BEFORE.test(sentence.slice(0, m.index))) continue;
    if (refused(sentence, m.index!, m[1]!)) continue;
    return true;
  }
  // Seized by the throat: "grabbing his throat", "grabs Silas by the neck", "goes for the boy's throat".
  const throat = new RegExp(String.raw`\b${GRAB}\s+(?:(?:(${ref})['’]s|\b(${possessives}))\s+(?:\w+\s+)?${THROAT}\b|(${ref}|\b(?:${pronouns})\b)\s+by\s+(?:the|${possessives})\s+${THROAT}\b)`, 'gi');
  for (const m of sentence.matchAll(throat)) {
    const pron = m[2] ?? (m[3] && isPronoun(m[3]) ? m[3] : undefined);
    if (pron && !pronounOk(pron, m.index! + m[0].indexOf(pron), m.index!)) continue;
    if (refused(sentence, m.index!, m[0])) continue;
    return true;
  }
  // Round 22: a limb or bone broken — "break Pip's arm", "snaps the boy's wrist", "twisting his arm".
  const broken = new RegExp(String.raw`\b(?:break|breaks|breaking|broke|snap|snaps|snapped|snapping|twist|twists|twisted|twisting|crush|crushes|crushed|crushing|shatter|shatters|shattered|shattering)\s+(?:(${ref})['’]s|\b(${possessives}))\s+(?:\w+\s+)?(?:arms?|legs?|wrists?|fingers?|hands?|ankles?|knees?|necks?|jaw|nose|ribs?|bones?|spine|skull|collarbone|elbows?|shoulders?)\b`, 'gi');
  for (const m of sentence.matchAll(broken)) {
    if (m[2] && !pronounOk(m[2], m.index! + m[0].lastIndexOf(m[2]), m.index!)) continue;
    if (refused(sentence, m.index!, m[0])) continue;
    return true;
  }
  // A blade at the throat: "put a knife to his throat", "holds the dagger against the kid's neck".
  const blade = new RegExp(String.raw`${WEAPON}\s+(?:to|against|at|across)\s+(?:(${ref})['’]s|\b(${possessives}))\s+(?:\w+\s+)?(?:${THROAT}|head|temple|chest|heart|eye)\b`, 'gi');
  for (const m of sentence.matchAll(blade)) {
    if (m[2] && !pronounOk(m[2], m.index! + m[0].lastIndexOf(m[2]), m.index!)) continue;
    if (refused(sentence, m.index!)) continue;
    return true;
  }
  const passive = new RegExp(String.raw`(${ref})\s+(?:is|was|were|are|gets|got|get|has\s+been|had\s+been|have\s+been|being|is\s+being|was\s+being)\s+(?:\w+ly\s+)?${PARTICIPLE}\b`, 'gi');
  for (const m of sentence.matchAll(passive)) {
    const after = sentence.slice(m.index! + m[0].length);
    if (/^\s+(?:by|with)\s+(?:a\s+|the\s+)?(?:pillow|snowball|water\s+balloon|feather|ball|idea|thought|realization|inspiration|wave\s+of)/i.test(after)) continue;
    if (refused(sentence, m.index!)) continue;
    return true;
  }
  const threat = new RegExp(String.raw`${THREAT}(${ref})\s+with\s+${WEAPON}\b`, 'i').exec(sentence);
  if (threat && !refused(sentence, threat.index)) return true;
  // A weapon aimed at a child: "raises his pistol at the kid", "levels a crossbow at Biz".
  const aimed = new RegExp(String.raw`\b(?:rais|aim|point|level|swing|throw|train|draw)(?:s|es|ed|ing)?\s+${WEAPON}\s+(?:\w+\s+){0,2}(?:at|toward|towards)\s+(${ref})`, 'i').exec(sentence);
  if (aimed && !refused(sentence, aimed.index)) return true;
  // Sexual content and a child in the same sentence.
  if (refs.length > 0) {
    for (const m of sentence.matchAll(SEXUAL)) {
      if (/^(?:naked|nude)$/i.test(m[0]) && NOT_SEXUAL_AFTER.test(sentence.slice(m.index! + m[0].length))) continue;
      return true;
    }
  }
  return false;
}

// ─── Who the floor protects: sticky, from anything the story says (round 21) ─
//
// Live FYXZTP: the world draft called Silas "a young man, barely out of
// boyhood"; play called him "the cabin boy" and "the boy", and the whispers
// "a ten-year-old". The floor read only the draft, so Silas was not on the
// list: "I lunge at Silas, grabbing his throat" was offered, and Mara's
// "Silas, … or I will bite your throat out" went out. Now anything the story,
// a whisper, a sheet or a description says that makes someone a child puts
// them on the list — and nothing takes them off it for the rest of the game.

/** Someone the story can mean: a PC or NPC, with their pronouns when known. */
export interface FloorCandidate {
  name: string;
  pronouns?: string | null;
  /** An NPC (only an NPC is protected on a sentence's "the boy" alone). */
  npc?: boolean;
  /**
   * Round 22: their own seed or sheet explicitly makes them an adult ("A
   * broad-shouldered man with a beard", a sheet aged 18 or more). A weak
   * inference — an apposition, or the lone-NPC rule — never protects them;
   * an explicit age, a predicate ("X is just a boy") or a person's own words
   * still do.
   */
  adult?: boolean;
}

/** Someone already protected, as childReferencesIn weighs "the boy" against them. */
export interface KnownChild {
  name: string;
  pronouns?: string | null;
}

export interface ChildReferenceOptions {
  /** Round 22: who is protected already — "the boy" in a sentence about an adult is them, when they are in the story. */
  protected?: KnownChild[];
  /** The recent story (the last transcript lines): a protected child named there is "in the scene". */
  recent?: string;
  /** A person's own words (a whisper, the host): any shape protects, whatever a seed says. */
  human?: boolean;
  /** Told of every weak inference not acted on because the seed or sheet makes the person an adult. */
  onDeclined?: (d: ProtectedPerson) => void;
}

/** A child-sense word for someone: "the cabin boy", "a ten-year-old", "barely out of boyhood". */
const CHILD_TERM = String.raw`(?:(?:(?:little|young|small|tiny|scrawny|skinny|frightened|terrified|scared|poor|trembling)\s+)*${BOY_JOB}?(?:child|kid|boy|girl|toddler|baby|infant|urchin|youngster|schoolchild|schoolboy|schoolgirl|minor|teen|teenager|adolescent)(?![\p{L}'’-])(?!\s*['’]s\b)|${UNDER_18}[- ]years?[- ]old(?![\p{L}-])|(?:barely|scarcely|hardly|just|only\s+just|not\s+long|fresh|newly)\s+out\s+of\s+(?:boy|girl|child)hood|not\s+yet\s+(?:a\s+(?:grown\s+)?(?:man|woman)|grown|of\s+age|an\s+adult))`;
/** Words that never sit between a name and what it is called (they start a new clause). */
const FILLER_STOP = /^(?:who|whom|whose|which|that|and|but|or|then|as|while|with|without|at|to|from|into|of|for|by|on|in|near|beside|behind|toward|towards|not|no|never|is|was|has|had|he|she|they|his|her|their|him|them|your|my|our|its|yours|mine|ours|you|I|we)$/i;
/**
 * Round 22 (BH9P94): "I call out to Captain Vane, 'Your boy is a rat…'" —
 * a quote between a name and a child word means someone is speaking TO or
 * ABOUT the named person; the child is someone else. A quote mark, or an
 * apostrophe that is not inside a word ("Silas's" is), is a boundary.
 */
function crossesQuote(between: string): boolean {
  return /["“”«»‘]/.test(between) || /(?<![\p{L}])['’]|['’](?![\p{L}])/u.test(between);
}
/** A possessive before the child word: "your boy", "his girl", "her son" is someone else's child, never the named person. */
const POSSESSED_TERM = /\b(?:your|my|our|his|her|their|its)\s+(?:(?:little|young|small|tiny|own|poor)\s+)*\S+$/i;
/** A child word that is strong evidence on its own: an age, or out of (or not yet out of) childhood. */
const STRONG_TERM = new RegExp(String.raw`^(?:${UNDER_18}[- ]years?[- ]old|(?:barely|scarcely|hardly|just|only\s+just|not\s+long|fresh|newly)\s+out\s+of|not\s+yet)`, 'i');
const QUALIFIER = String.raw`(?:(?:just|only|barely|still|merely|but|hardly|no\s+more\s+than|little\s+more\s+than|hardly\s+more\s+than|scarcely\s+more\s+than)\s+)`;
const AGE_BARE = String.raw`(?:aged\s+)?${UNDER_18}(?:\s+years?\s+old)?`;

const FEMININE_TERM = /\b(?:girl|schoolgirl)\b/i;
const MASCULINE_TERM = /\b(?:boy|schoolboy|boyhood)\b/i;

/** Could this candidate be the child `term` names ("the boy" is never a she)? */
function genderFits(term: string, pronouns: string | null | undefined): boolean {
  const p = (pronouns ?? '').trim().toLowerCase().split(/[\/,\s]+/)[0] ?? '';
  if (MASCULINE_TERM.test(term) && (p === 'she' || p === 'her')) return false;
  if (FEMININE_TERM.test(term) && (p === 'he' || p === 'him')) return false;
  return true;
}

/** The fillers of an appositive are description words, never a new clause ("Silas, the man who hit the boy"). */
function fillersOk(fillers: string | undefined): boolean {
  if (!fillers?.trim()) return true;
  return fillers.trim().split(/\s+/).every(w => !FILLER_STOP.test(w.replace(/[^\p{L}'’-]/gu, '')));
}

const clip = (s: string) => (s.length > 90 ? `${s.slice(0, 87)}…` : s).trim();

/**
 * Who this text says is a child, and why: a name called a child in apposition
 * ("Silas, the cabin boy", "the cabin boy Silas", "Silas, ten,"), by a
 * predicate ("Silas is just a boy", "Silas is twelve"), or — an NPC only —
 * a sentence about them that goes on to call them "the boy" ("Silas's
 * fingers release, but the boy does not retreat"). Errs toward protecting.
 *
 * Round 22 (BH9P94) — the evidence is tiered:
 *  - strong: an age under 18, a childhood phrase ("barely out of boyhood"),
 *    a predicate ("Pip is just a boy"), or a person's own words (a whisper,
 *    the host: `opts.human`). Strong evidence always protects.
 *  - weak: an apposition ("Calloway, the cabin boy"), or the lone-NPC rule.
 *    Weak evidence never protects someone whose own seed or sheet makes them
 *    an adult (`candidate.adult`); that is logged through `opts.onDeclined`.
 * An apposition never crosses a quote, and never takes a possessive child
 * word ("Captain Vane, 'Your boy is a rat…'" is about someone else's boy).
 * The lone-NPC rule is not used when a protected child whom "the boy" fits
 * is named in this text or in `opts.recent`: "the boy" is them.
 */
export function childReferencesIn(text: string, candidates: FloorCandidate[], source = 'the story', opts: ChildReferenceOptions = {}): ProtectedPerson[] {
  if (!text?.trim() || candidates.length === 0) return [];
  const found = new Map<string, ProtectedPerson>();
  const declined = new Set<string>();
  const cands = candidates.filter(c => c.name?.trim()).map(c => ({ ...c, words: protectedNameWords([c.name]) })).filter(c => c.words.length > 0);
  const nameRe = (words: string[]) => String.raw`(?<![\p{L}'’-])(?:${words.map(esc).join('|')})(?![\p{L}-])(?!['’]s\b)`;
  const capitalised = (m: string, words: string[]) => words.some(w => m.includes(w));
  const named = (words: string[], where: string) => words.length > 0 && new RegExp(String.raw`(?<![\p{L}'’-])(?:${words.map(esc).join('|')})(?![\p{L}-])`, 'u').test(where);
  // Protected children in the story now: named in this text or the recent story.
  const already = (opts.protected ?? []).filter(p => p?.name?.trim()).map(p => ({ ...p, words: protectedNameWords([p.name]) }));
  const inStory = already.filter(p => named(p.words, text) || (opts.recent ? named(p.words, opts.recent) : false));
  /** Protect `c`, unless the evidence is weak and their own seed or sheet makes them an adult. */
  const protect = (c: typeof cands[number], why: string, weak: boolean): boolean => {
    if (weak && c.adult && !opts.human) {
      if (!declined.has(c.name)) {
        declined.add(c.name);
        opts.onDeclined?.({ name: c.name, why: `${why} — a weak inference, and their own description makes them an adult` });
      }
      return false;
    }
    found.set(c.name, { name: c.name, why });
    return true;
  };
  for (const sentence of splitSentences(text)) {
    const present = cands.filter(c => named(c.words, sentence));
    for (const c of present) {
      if (found.has(c.name)) continue;
      const N = nameRe(c.words);
      const patterns: Array<{ re: RegExp; weak: boolean }> = [
        // "Silas, a young man barely out of boyhood", "Silas, the cabin boy".
        { re: new RegExp(String.raw`${N}\s*,\s*${QUALIFIER}?(?:(?:a|an|the|this|that|our|their)\s+)?((?:[\p{L}'’-]+\s+){0,3}?)(${CHILD_TERM})`, 'giu'), weak: true },
        // "Silas, ten, …", "Silas, aged 12".
        { re: new RegExp(String.raw`${N}\s*,\s*(${AGE_BARE})\s*[,.;)]`, 'giu'), weak: false },
        // "the cabin boy Silas", "ten-year-old Silas", "the boy, Silas, …".
        { re: new RegExp(String.raw`(${CHILD_TERM})(?:\s+|\s*,\s*)${N}(?=\s*(?:[,.;!?)]|$)|\s+\p{Ll})`, 'giu'), weak: true },
        // "Silas is just a boy", "Silas was barely out of boyhood", "Silas is twelve".
        { re: new RegExp(String.raw`${N}\s+(?:is|was|seems|looks|remains|is\s+still|was\s+still)\s+${QUALIFIER}*(?:(?:a|an)\s+)?((?:[\p{L}'’-]+\s+){0,2}?)(${CHILD_TERM}|${UNDER_18}(?:\s+years?\s+old)?(?![\p{L}-])(?!\s+(?:feet|foot|inches|hands|paces|yards|meters|metres|miles|minutes|hours|days|weeks|months|men|of|times|steps|strides)))`, 'giu'), weak: false },
      ];
      for (const [i, { re, weak }] of patterns.entries()) {
        for (const m of sentence.matchAll(re)) {
          if (!capitalised(m[0], c.words)) continue;
          const term = m[m.length - 1] ?? m[0];
          const fillers = m.length > 2 ? m[1] : undefined;
          if (fillers !== undefined && i !== 2 && !fillersOk(fillers)) continue;
          if (!genderFits(m[0], c.pronouns)) continue;
          // Round 22: never across a quote ("Captain Vane, 'Your boy…'"), never someone's possessed child ("Vane, your boy").
          const termAt = m[0].toLowerCase().lastIndexOf(String(term).toLowerCase());
          if (crossesQuote(m[0])) continue;
          if (i !== 2 && POSSESSED_TERM.test(m[0].slice(0, termAt) + String(term).split(/\s+/).pop())) continue;
          // "…of a kid", "mother of…": the child is someone else.
          if (SOMEONE_ELSES.test(m[0].slice(0, Math.max(0, termAt)))) continue;
          const strong = !weak || STRONG_TERM.test(String(term).trim());
          if (protect(c, `${source} calls them "${clip(m[0])}"`, !strong)) break;
        }
        if (found.has(c.name)) break;
      }
    }
    // An NPC named in the sentence, the only one of anyone, and then "the boy".
    if (present.length === 1 && present[0]!.npc && !found.has(present[0]!.name)) {
      const c = present[0]!;
      const first = sentence.search(new RegExp(String.raw`(?<![\p{L}'’-])(?:${c.words.map(esc).join('|')})(?![\p{L}-])`, 'u'));
      const later = sentence.slice(first);
      // "Silas, the man who hit the boy": the sentence itself calls them grown.
      const grown = new RegExp(String.raw`(?<![\p{L}'’-])(?:${c.words.map(esc).join('|')})\s*,\s*(?:a|an|the)\s+(?:[\p{L}'’-]+\s+)?(?:man|woman|adult|grown-?up)\b`, 'iu').test(sentence);
      const the = grown ? null : later.match(new RegExp(String.raw`\b(?:the|that)\s+((?:(?:little|young|small|frightened|terrified|scared|poor|trembling)\s+)*${BOY_JOB}?(?:boy|girl|kid|child|youngster|urchin)|${UNDER_18}[- ]years?[- ]old)(?![\p{L}-])`, 'iu'));
      // Round 22: "the boy" in a sentence about an adult is the protected child already in the story, when one fits.
      const theirs = the ? inStory.find(p => genderFits(the[0], p.pronouns)) : undefined;
      // …and never across a quote ("Captain Vane, 'The boy is mine.'").
      const quoted = the ? crossesQuote(later.slice(0, the.index)) : false;
      if (the && !theirs && !quoted && genderFits(the[0], c.pronouns)) {
        const strong = STRONG_TERM.test(the[1] ?? '');
        protect(c, `${source} calls them "${clip(the[0])}" ("${clip(sentence)}")`, !strong);
      }
    }
  }
  return [...found.values()];
}

/** Add `person` to `list` unless they are on it already (by name). True when added: nobody ever comes off. */
export function addProtected(list: ProtectedPerson[], person: ProtectedPerson): boolean {
  const key = person.name.trim().toLowerCase();
  if (!key || list.some(p => p.name.trim().toLowerCase() === key)) return false;
  list.push({ name: person.name.trim(), why: person.why });
  return true;
}

/** The sentences of `text` that cross the floor, exactly as they appear in it. */
export function floorBackstop(text: string, ctx: FloorContext = {}): string[] {
  if (!text?.trim()) return [];
  const minors = protectedNames(ctx.minors);
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
