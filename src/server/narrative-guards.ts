/**
 * Narrative guards: the things a prompt ASKS the model for, enforced in code.
 *
 * A live table (c54792c) showed the model ignoring four prompt instructions:
 * an isekai opening with nobody arriving, a kid of unstated gender called
 * "he" from round one, "Liz" where the kid calls her "Mom", and a character
 * declared TAKEN OUT who leaned in and whispered one line later. Everything
 * here is deterministic and pure — no LLM call — so it runs on every piece of
 * outgoing text without cost, and it is tuned to leave text alone whenever
 * it is not sure. A missed repair is a cosmetic slip; a wrong repair (an NPC
 * turned into "they", dialogue rewritten) is a bug the players can see.
 */

// ─── Arrival ───────────────────────────────────────────────────────────────

/**
 * A premise or backstory that moves the characters from somewhere else into
 * this world. Simple on purpose: the words people actually use for it.
 */
const ARRIVAL_PREMISE = new RegExp([
  String.raw`\bisekai\w*`,
  String.raw`\bportals?\b`,
  String.raw`\bsummon(?:s|ed|ing)?\b`,
  String.raw`\btransport(?:s|ed|ing)?\b`,
  String.raw`\bteleport(?:s|ed|ing)?\b`,
  String.raw`\b(?:woke|wake|wakes|waking|awake[ns]?|awoke) up (?:in|on|at|inside|aboard)\b`,
  String.raw`\b(?:fell|fall|falls|falling|fallen) (?:into|through)\b`,
  String.raw`\b(?:pulled|pull|pulls|dragged|yanked|sucked|swept|whisked|spirited|dropped|flung|thrown|hurled|beamed|sent|carried|stolen|abducted) (?:away |off )?(?:in|into|to|through|across|out of)\b`,
  String.raw`\breincarnat\w*`,
  String.raw`\breborn (?:in|into|as)\b`,
  String.raw`\b(?:another|other|different) world\b`,
  String.raw`\bshipwreck\w*`,
  String.raw`\bcrash[- ]?land\w*`,
  String.raw`\bstranded\b`,
  String.raw`\barriv(?:e|es|ed|ing|al)\b`,
].join('|'), 'i');

export function premiseImpliesArrival(...texts: Array<string | null | undefined>): boolean {
  return texts.some(t => !!t && ARRIVAL_PREMISE.test(t));
}

/**
 * Prose that actually narrates an arrival happening to someone: the landing,
 * the waking, the blinking and reeling — not a room with nobody in it.
 */
const ARRIVAL_BEAT = new RegExp([
  String.raw`\barriv(?:e|es|ed|ing|al)\b`,
  String.raw`\bland(?:s|ed|ing)? (?:hard|on|in|with|face|flat|sprawl)`,
  String.raw`\b(?:wake|wakes|woke|waking|awake[ns]?|awoke|come to|comes to|came to)\b`,
  String.raw`\bblink(?:s|ed|ing)?\b`,
  String.raw`\bdisorient\w*`,
  String.raw`\bdizz\w*`,
  String.raw`\breel(?:s|ed|ing)?\b`,
  String.raw`\blurch(?:es|ed|ing)?\b`,
  String.raw`\b(?:stumble|stumbles|stumbled|stumbling|tumble|tumbles|tumbled|tumbling)\b`,
  String.raw`\b(?:fell|fall|falls|falling) (?:into|through|out of|onto)\b`,
  String.raw`\b(?:spat|spit|dropped|drops|thrown|flung|dumped|deposited) (?:out |onto |into |on )`,
  String.raw`\bmaterializ\w*`,
  String.raw`\b(?:find|finds|found) themselves\b`,
  String.raw`\bone moment\b`,
  String.raw`\b(?:a )?(?:moment|heartbeat|second|breath)s? (?:ago|before)\b`,
  String.raw`\bnever seen\b`,
  String.raw`\b(?:pulled|yanked|sucked|whisked|summoned|transported|isekaied) (?:in|into|through|here|across|out)\b`,
].join('|'), 'i');

export function hasArrivalBeat(text: string | null | undefined): boolean {
  return !!text && ARRIVAL_BEAT.test(text);
}

function joinNames(names: string[]): string {
  if (names.length === 0) return 'The party';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "the Bureau of Misfiled Souls" out of "…has isekaied a mother and child into the Bureau of Misfiled Souls, a kingdom…". */
function destinationFrom(premise: string): string | null {
  const m = premise.match(/\b(?:into|to|through|in|inside|onto)\s+((?:the\s+)?[A-Z][\w'’-]*(?:\s+(?:of|the|de|du|la|le|and|&|[A-Z][\w'’-]*))*)/);
  if (!m) return null;
  const dest = m[1]!.replace(/\s+(?:of|the|de|du|la|le|and|&)$/i, '').trim();
  return dest.length >= 3 ? dest : null;
}

/**
 * The arrival beat when the DM did not write one: plain, built from the
 * premise, names the party, and invents nothing beyond "they were somewhere
 * else a moment ago" — which the premise itself already says.
 */
export function fallbackArrival(premise: string, names: string[]): string {
  const who = joinNames(names);
  const dest = destinationFrom(premise);
  const where = dest ? `they have landed in ${dest}` : 'they are somewhere else entirely';
  return `${who} land hard. One moment they were in their own lives; the next, ${where}. They blink, disoriented, at a place they have never seen before.`;
}

// ─── Pronouns ──────────────────────────────────────────────────────────────

export type Gender = 'f' | 'm' | 'n';

export interface GuardPerson {
  name: string;
  /** From the sheets (own pronouns, or a companion's gendered relation word); null = nobody said. */
  gender: Gender | null;
  /** Other words the party uses for this person ("Mom"); a mention of these is a mention of them. */
  aliases: string[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** Nouns that put another person in the sentence — a pronoun there might be theirs. */
const PERSON_NOUNS = new Set([
  'man', 'men', 'woman', 'women', 'boy', 'boys', 'girl', 'girls', 'lady', 'ladies', 'gentleman', 'gentlemen', 'guy', 'fellow',
  'king', 'queen', 'prince', 'princess', 'lord', 'duke', 'duchess', 'knight', 'sir', 'madam', 'madame', 'mister', 'miss',
  'clerk', 'clerks', 'guard', 'guards', 'official', 'officials', 'officer', 'stranger', 'strangers', 'figure', 'person', 'someone', 'somebody',
  'anyone', 'everyone', 'nobody', 'merchant', 'keeper', 'priest', 'priestess', 'attendant', 'registrar', 'secretary', 'bureaucrat',
  'scribe', 'archivist', 'captain', 'soldier', 'servant', 'butler', 'maid', 'witch', 'wizard', 'sorcerer', 'sorceress', 'monk', 'nun',
  'innkeeper', 'shopkeeper', 'bartender', 'barkeep', 'driver', 'sailor', 'pirate', 'thief', 'villain', 'boss', 'manager', 'supervisor',
  'teacher', 'doctor', 'nurse', 'child', 'kid', 'baby', 'father', 'mother', 'dad', 'mom', 'brother', 'sister', 'husband', 'wife',
  'uncle', 'aunt', 'grandmother', 'grandfather', 'grandma', 'grandpa', 'son', 'daughter', 'friend', 'enemy', 'owner', 'creature',
  'ghost', 'spirit', 'giant', 'dwarf', 'elf', 'goblin', 'troll', 'orc', 'wanderer', 'traveler', 'traveller', 'elder', 'chief', 'master', 'mistress',
  'patron', 'customer', 'applicant', 'petitioner', 'inspector', 'auditor', 'examiner', 'notary', 'judge', 'magistrate', 'mayor', 'queue-keeper',
  'golem', 'automaton', 'statue', 'beast', 'dragon', 'dog', 'cat', 'horse', 'bird', 'crane', 'wolf', 'voice', 'stranger', 'crowd', 'people',
]);
/**
 * Relation words that name a party member when they appear in that member's
 * own sentence ("her son Biz") — the kid rule rewrites them, so they must not
 * count as a second person.
 */
const CHILD_WORDS = /\b(son|daughter|stepson|stepdaughter)(s?)\b/gi;
const HAS_CHILD_WORD = /\b(son|daughter|stepson|stepdaughter)s?\b/i;

/** Capitalised words that are not a person. */
const NOT_A_NAME = new Set([
  'the', 'a', 'an', 'and', 'but', 'or', 'nor', 'so', 'yet', 'for', 'if', 'when', 'while', 'as', 'then', 'there', 'here', 'now', 'still',
  'i', 'we', 'you', 'he', 'she', 'it', 'they', 'his', 'her', 'hers', 'him', 'its', 'their', 'them', 'my', 'our', 'your', 'me', 'us',
  'this', 'that', 'these', 'those', 'one', 'no', 'not', 'yes', 'with', 'without', 'in', 'on', 'at', 'to', 'from', 'into', 'onto', 'by',
  'of', 'off', 'up', 'down', 'over', 'under', 'behind', 'beside', 'before', 'after', 'above', 'below', 'across', 'through', 'around',
  'somewhere', 'nowhere', 'everywhere', 'something', 'nothing', 'everything', 'suddenly', 'slowly', 'quietly', 'finally', 'meanwhile',
  'outside', 'inside', 'beyond', 'near', 'far', 'again', 'once', 'twice', 'every', 'each', 'all', 'both', 'some', 'most', 'few', 'many',
  'what', 'who', 'why', 'how', 'where', 'which', 'whose', 'only', 'even', 'just', 'already', 'somehow', 'perhaps', 'maybe', 'too',
  'form', 'forms', 'stamp', 'ok', 'okay', 'oh', 'ah', 'hey', 'well', 'mr', 'mrs', 'ms',
  'together', 'beneath', 'within', 'overhead', 'nearby', 'soon', 'later', 'eventually', 'instead', 'behind', 'ahead', 'at', 'for',
]);

const MASC = /\b(he|him|his|himself|he's|he'd|he'll)\b/i;
const FEM = /\b(she|her|hers|herself|she's|she'd|she'll)\b/i;

/** Words that, right after an object "her", say it was an object pronoun ("pull her close"). */
const AFTER_OBJECT = new Set(['close', 'closer', 'to', 'into', 'up', 'down', 'back', 'away', 'off', 'out', 'over', 'with', 'and', 'or', 'in', 'on', 'at', 'from', 'for', 'by', 'as', 'aside', 'along', 'forward', 'toward', 'towards', 'tight', 'tightly', 'gently', 'again', 'too', 'onto', 'through', 'around', 'behind', 'beside', 'near', 'than', 'that', 'what', 'how', 'why', 'if', 'about', 'across', 'free', 'safe', 'go', 'be', 'a', 'an', 'the', 'this', 'there', 'here']);

const matchCase = (orig: string, repl: string) => (orig[0] === orig[0]!.toUpperCase() ? repl[0]!.toUpperCase() + repl.slice(1) : repl);

/**
 * Rewrite every he/him/his (or she/her/hers) in an unquoted stretch for
 * `who`. A subject pronoun becomes their name ("as he leans" → "as Biz
 * leans"): always grammatical, where "they" would need every following verb
 * re-agreed ("they works … and heaves"). The rest become they-forms, which
 * need no agreement: them, their, theirs, themself, they'd, they'll.
 */
function neutralize(segment: string, g: 'm' | 'f', who: string): string {
  const re = g === 'm'
    ? /\b(he's|he'd|he'll|himself|him|his|he)\b/gi
    : /\b(she's|she'd|she'll|herself|hers|her|she)\b/gi;
  return segment.replace(re, (word: string, _w: string, offset: number, whole: string) => {
    const nextWord = whole.slice(offset + word.length).match(/^\s+([A-Za-z'-]+)/)?.[1]?.toLowerCase();
    // "her son" / "his kid": that possessive is the PARENT's, not the child's.
    if (nextWord && /^(?:step)?(?:son|daughter|child|kid)s?$|^children$/.test(nextWord) && /^(his|her)$/i.test(word)) return word;
    switch (word.toLowerCase()) {
      case 'he': case 'she': return who;
      case "he's": case "she's": return `${who}'s`;
      case "he'd": case "she'd": return matchCase(word, "they'd");
      case "he'll": case "she'll": return matchCase(word, "they'll");
      case 'himself': case 'herself': return matchCase(word, 'themself');
      case 'him': return matchCase(word, 'them');
      case 'hers': return matchCase(word, 'theirs');
      case 'his': return matchCase(word, nextWord && !AFTER_OBJECT.has(nextWord) ? 'their' : 'theirs');
      case 'her': return matchCase(word, nextWord && !AFTER_OBJECT.has(nextWord) ? 'their' : 'them');
      default: return word;
    }
  });
}

/** Split into [text, isQuoted] runs so dialogue is never rewritten. */
function quoteRuns(sentence: string): Array<{ text: string; quoted: boolean }> {
  const runs: Array<{ text: string; quoted: boolean }> = [];
  const re = /"[^"]*"?|“[^”]*”?/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence))) {
    if (m.index > last) runs.push({ text: sentence.slice(last, m.index), quoted: false });
    runs.push({ text: m[0], quoted: true });
    last = m.index + m[0].length;
  }
  if (last < sentence.length) runs.push({ text: sentence.slice(last), quoted: false });
  return runs;
}

function splitSentences(text: string): string[] {
  // Keep closing quotes/brackets with their sentence, and the whitespace after it.
  return text.match(/[^.!?…\n]+(?:[.!?…]+["'”’)\]]*|$)\s*|\n+/g) ?? [text];
}

function mentions(text: string, p: GuardPerson): boolean {
  return [firstName(p.name), p.name, ...p.aliases].filter(Boolean)
    .some(n => new RegExp(`\\b${esc(n)}\\b`).test(text));
}

/**
 * Anyone in the (unquoted) sentence who is not a party member: a capitalised
 * word that is not a party name or alias, not a known place or thing, and not
 * a common word; or a noun for a person ("the clerk").
 */
function hasOtherReferent(unquoted: string, people: GuardPerson[], nonPersonWords: Set<string>): boolean {
  const partyWords = new Set(people.flatMap(p => [...p.name.split(/\s+/), ...p.aliases.flatMap(a => a.split(/\s+/))]).map(w => w.toLowerCase()));
  const words = unquoted.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const raw = words[i]!.replace(/['’]s$/, '');
    const lower = raw.toLowerCase();
    if (partyWords.has(lower)) continue;
    if (PERSON_NOUNS.has(lower)) return true;
    if (raw[0] === raw[0]!.toUpperCase() && raw[0] !== raw[0]!.toLowerCase()) {
      if (NOT_A_NAME.has(lower) || nonPersonWords.has(lower)) continue;
      // All caps is emphasis or a game term ("TAKEN OUT"), not a name.
      if (raw.length > 1 && raw === raw.toUpperCase()) continue;
      // A sentence usually opens on a capital; a participle or adverb there is not a name.
      if (i === 0 && /(?:ing|ed|ly)$/.test(lower)) continue;
      return true;
    }
  }
  return false;
}

export interface PronounGuardOptions {
  /** Lower-cased words of known place and item names ("intake", "hall") — capitalised, but not people. */
  nonPersonWords?: Set<string>;
}

/**
 * Repair he/she (and son/daughter) written for a party member whose gender
 * nobody stated, or who uses they/them.
 *
 * Only high-confidence cases, per sentence, outside quotation marks:
 *  - the sentence names exactly one such member, and
 *  - nobody else in it could own that pronoun — no party member with that
 *    stated gender, no other capitalised name, no person noun ("the clerk").
 * "Liz pulls Biz close and places her hand on his shoulder": "her" has a
 * stated owner (Liz), "his" has only Biz → "their". A sentence that names no
 * one inherits the previous sentence's subject only when that sentence OPENED
 * with the member's name and this one opens with the pronoun ("Biz leans
 * over. He squints." → "Biz squints."). Everything else is left alone.
 * Characters with a stated he/him or she/her are never touched, even if the
 * prose uses the other set — which of two people a pronoun means is not
 * something this can know.
 */
export function repairPronouns(text: string, people: GuardPerson[], opts: PronounGuardOptions = {}): string {
  const unstated = people.filter(p => p.gender === null || p.gender === 'n');
  if (!text || unstated.length === 0) return text;
  const nonPersonWords = opts.nonPersonWords ?? new Set<string>();
  const sentences = splitSentences(text);
  let prevSubject: GuardPerson | null = null;
  const out = sentences.map(sentence => {
    const runs = quoteRuns(sentence);
    const unquoted = runs.filter(r => !r.quoted).map(r => r.text).join(' ');
    const named = people.filter(p => mentions(unquoted, p));
    const namedUnstated = named.filter(p => p.gender === null || p.gender === 'n');
    const other = hasOtherReferent(unquoted.replace(CHILD_WORDS, ''), people, nonPersonWords);

    let target: GuardPerson | null = null;
    let carried = false;
    if (named.length > 0) {
      if (namedUnstated.length === 1) target = namedUnstated[0]!;
    } else if (prevSubject && !other && /^\s*(he|she|his|her|him)\b/i.test(sentence)) {
      target = prevSubject;
      carried = true;
    }

    const opener = unquoted.trimStart();
    const startsWith = named.find(p => [firstName(p.name), ...p.aliases].some(n => opener.startsWith(n)));
    prevSubject = named.length === 1 && startsWith && (startsWith.gender === null || startsWith.gender === 'n') && !other ? startsWith : null;

    if (!target || other) return sentence;
    const statedHere = (g: Gender) => named.some(p => p !== target && p.gender === g);
    const fixMasc = MASC.test(unquoted) && !statedHere('m');
    const fixFem = FEM.test(unquoted) && !statedHere('f');
    const fixKid = !carried && HAS_CHILD_WORD.test(unquoted);
    if (!fixMasc && !fixFem && !fixKid) return sentence;
    const fixed = runs.map(r => {
      if (r.quoted) return r.text;
      let t = r.text;
      if (fixMasc) t = neutralize(t, 'm', firstName(target!.name));
      if (fixFem) t = neutralize(t, 'f', firstName(target!.name));
      if (fixKid) t = t.replace(CHILD_WORDS, (w, word: string, plural: string) => matchCase(w, (word.toLowerCase().startsWith('step') ? 'stepchild' : 'child') + (plural ? 'ren' : '')));
      return t;
    }).join('');
    if (carried) prevSubject = target;
    return fixed;
  });
  return out.join('');
}

// ─── Address terms ─────────────────────────────────────────────────────────

export interface AddressTerm {
  /** The companion's name ("Liz"). */
  name: string;
  /** What the speaker calls them ("Mom"). */
  address: string;
}

const VOCATIVE_LEAD = String.raw`(?:hey|oh|please|okay|ok|look|listen|come on|thanks|thank you|sorry|yes|no|right|wait|so|and|but|well)`;

/**
 * A speaker with an address term for a companion uses it: "Mom Liz" is always
 * collapsed to "Mom", and — with `vocative` (the speaker's own spoken words
 * only) — the companion's bare first name used to call to them ("Liz, can
 * you…", "…help me, Liz?", "Hey Liz,") becomes the address term. A name used
 * to talk ABOUT them ("Liz's handwriting", "Liz is right") is left alone.
 */
export function repairAddress(text: string, terms: AddressTerm[], opts: { vocative: boolean }): string {
  if (!text) return text;
  let out = text;
  for (const t of terms) {
    const first = firstName(t.name);
    const address = t.address.trim();
    if (!address || address.toLowerCase() === first.toLowerCase() || address.toLowerCase() === t.name.trim().toLowerCase()) continue;
    const name = `(?:${esc(t.name.trim())}|${esc(first)})`;
    // "Mom Liz" / "Mom, Liz" → "Mom"
    out = out.replace(new RegExp(`\\b(${esc(address)})(?:,)?\\s+${name}\\b(?!['’]s)`, 'g'), '$1');
    if (!opts.vocative) continue;
    // Sentence-initial vocative: "Liz, can you…" / "Liz! Look."
    out = out.replace(new RegExp(`(^|[.!?…]\\s+|["“(]\\s*)${name}(?=\\s*[,!?])`, 'g'), `$1${address}`);
    // After a lead-in: "Hey Liz," / "Please, Liz,"
    out = out.replace(new RegExp(`(\\b${VOCATIVE_LEAD},?\\s+)${name}(?=\\s*[,.!?…]|$)`, 'gi'), `$1${address}`);
    // Trailing vocative: "…help me, Liz?" / "…, Liz."
    out = out.replace(new RegExp(`(,\\s*)${name}(?=\\s*[.!?…]|\\s*$)`, 'g'), `$1${address}`);
  }
  return out;
}

// ─── Taken out ─────────────────────────────────────────────────────────────

/** The consequence that marks a character as taken out until they recover. */
export const TAKEN_OUT = 'Taken Out (recovering)';

export function isTakenOut(state: { consequences: string[] }): boolean {
  return state.consequences.includes(TAKEN_OUT);
}

/**
 * Recovery at a scene break. Being taken out lasts until the next scene (the
 * FATE sense: out of THIS conflict), so it always clears here. Other
 * consequences keep the loop's existing rule: a lone consequence heals, and
 * when a character carries more than one (being taken out included) the
 * others are kept — those are lasting injuries.
 */
export function recoverAtSceneBreak(consequences: string[]): { kept: string[]; recovered: string[] } {
  const others = consequences.filter(c => c !== TAKEN_OUT);
  const recovered = consequences.includes(TAKEN_OUT) ? [TAKEN_OUT] : [];
  if (consequences.length > 1) return { kept: others, recovered };
  return { kept: [], recovered: [...recovered, ...others] };
}

/**
 * Party members a piece of DM prose declares taken out ("Liz is TAKEN OUT",
 * "Liz is taken out by the cabinet"), so the mechanics follow the story.
 * Requires the name as the subject of "is/was/… taken out" or the name
 * followed closely by the all-caps game term — never "have Liz taken out of
 * the queue" or "takes out a bottle cap".
 */
export function declaredTakenOut(text: string, names: string[]): string[] {
  return names.filter(n => {
    const first = esc(firstName(n));
    return new RegExp(`\\b${first}\\b\\s+(?:is|was|has been|gets|got|goes|went|lies)\\s+(?:now\\s+|utterly\\s+|completely\\s+|finally\\s+)?taken out\\b(?!\\s+of\\b)`, 'i').test(text)
      || new RegExp(`\\b${first}\\b[^.!?]{0,40}\\bTAKEN OUT\\b`).test(text);
  });
}

/** An action that helps a downed companion back up. */
const AID = /\b(?:help(?:s|ed|ing)?|tend(?:s|ed|ing)?|reviv(?:e|es|ed|ing)|rous(?:e|es|ed|ing)|wak(?:e|es|ing)|woke|shak(?:e|es|ing)|shook|lift(?:s|ed|ing)?|pull(?:s|ed|ing)? \w+ up|haul(?:s|ed|ing)? \w+ up|drag(?:s|ged|ging)?|carr(?:y|ies|ied|ying)|bandag(?:e|es|ed|ing)|heal(?:s|ed|ing)?|stead(?:y|ies|ied|ying)|kneel(?:s|ing)?|knelt|check(?:s|ed|ing)? on|comfort(?:s|ed|ing)?|support(?:s|ed|ing)?|cradl(?:e|es|ed|ing)|brac(?:e|es|ed|ing)|rush(?:es|ed|ing)? to)\b/i;

/** Does `text` (an action, maybe with spoken words) aid someone called any of `names`? */
export function aidsCharacter(text: string, names: string[]): boolean {
  if (!AID.test(text)) return false;
  return names.filter(Boolean).some(n => new RegExp(`\\b${esc(n)}\\b`, 'i').test(text));
}
