import { readFileSync } from 'node:fs';
import { callLlm, callProse } from './llm-client.js';
import { DmNarrationSchema, DmResolutionSchema, CharacterValidationSchema, SceneSummarySchema, DmSetupReplySchema, CharInterviewReplySchema, WorldSeedSchema, DmOpeningSchema } from './schemas.js';
import type { DmNarration, DmResolution, CharacterValidation, DmSetupReply, CharInterviewReply, DmOpening } from './schemas.js';
import { searchRules, type RuleChunk } from '../rag/search.js';
import { PLAIN_PROSE_STYLE } from './style.js';
import { repetitionNotes } from '../narrative-guards.js';
import { npcPronounBlock, seedNpcPronouns, neutralPronouns, neutralNounRule, partyPronounLine } from '../npc-pronouns.js';
import { repairGenderedNouns } from '../pronoun-consistency.js';
import { influenceKey } from '../world-readiness.js';
import { wantsNoSpoilers } from '../../shared/spoilers.js';
import { safeDataFile } from '../data-paths.js';
import { SENTENCE_SPLIT } from '../sentences.js';
import { publicDisposition } from '../world-seed.js';
import type Database from 'better-sqlite3';
import type { CharacterDefinition, CharacterRelationship, TranscriptMessage, DiceResult, WorldSeed, TableRole } from '../../shared/types.js';

const presetCache = new Map<string, string>();
function loadPresetText(presetName: string): string | null {
  if (presetCache.has(presetName)) return presetCache.get(presetName)!;
  const p = safeDataFile('dm-presets', presetName, '.txt');
  if (!p) return null;
  const text = readFileSync(p, 'utf-8').trim();
  presetCache.set(presetName, text);
  return text;
}

/**
 * Exported for tests: composes the preset head, its CRITICAL section, and the
 * per-preset narration hint. `dmCustomPrompt` augments this — it must never
 * replace it, or the host's chosen personality silently stops being enforced.
 */
export function composePresetSections(preset: string): { head: string; critical: string; narrationHint: string } {
  let presetText = loadPresetText(preset) ?? '';
  let critical = '';
  let narrationHint = '';
  const criticalIdx = presetText.indexOf('CRITICAL:');
  if (criticalIdx >= 0) {
    critical = '\n' + presetText.slice(criticalIdx);
    presetText = presetText.slice(0, criticalIdx).trimEnd();
    if (preset === 'professor') {
      narrationHint = ' IMPORTANT: End the narration with a parenthetical teaching aside like (Empathy +4 vs Good difficulty = three shifts of success!)';
    } else if (preset === 'chronicler') {
      narrationHint = ' IMPORTANT: Include at least one non-visual sense (sound, smell, touch, or taste) in the narration';
    } else if (preset === 'trickster') {
      narrationHint = ' IMPORTANT: Include dramatic irony, dark humor, or a hidden cost in the narration';
    }
  }
  const head = presetText ? presetText + '\n' : `You are a TTRPG Dungeon Master with the "${preset}" personality.\n`;
  return { head, critical, narrationHint };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The slice of a character sheet the DM needs to know who is actually playing. */
export { wantsNoSpoilers };

/**
 * Mild OpenAI-style penalties for DM prose (narration, rulings). Sent with
 * every request; the shared game proxy does not forward them yet.
 */
const REPETITION_PENALTIES = { frequencyPenalty: 0.3, presencePenalty: 0.3 } as const;

/** The greeting's user turn: the setup chat has no host message yet. */
export const SETUP_GREETING_CUE = '(The host has just opened the setup chat. Greet them and ask your first question.)';
/** Starts the second ask after a reply that repeated an earlier one. */
export const SETUP_REPEAT_NUDGE = 'That reply repeats one you already sent, word for word.';

/**
 * The setup history with the host's latest message marked as the one to
 * answer. Qwen, given a strict no-spoiler system prompt, answered the
 * host's first message over and over; this is the same nudge the character
 * interview gives its last turn. Only the copy sent to the model changes.
 */
export function anchorLatestHostMessage(history: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  const out = [...history];
  const last = out[out.length - 1];
  if (last && last.role === 'user') {
    out[out.length - 1] = { ...last, content: `${last.content}\n\n(Reply to THIS message — what the host just said — and move the setup forward. Never repeat an earlier reply. "influences" lists every influence the host has named so far.)` };
  }
  return out;
}

/** Two replies that say the same thing word for word, ignoring case, spacing and punctuation. */
function sameReplyKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** What to say when the model will only repeat itself: the next thing setup still needs. */
export function nextSetupQuestion(unmet: string[]): string {
  if (unmet.some(u => /influence/i.test(u))) {
    return 'Noted. What should this world feel like? Name at least three influences — books, films, games, records, painters, anything — and I will build from where they meet.';
  }
  if (unmet.some(u => /summary|how you want this game run/i.test(u))) {
    return 'Noted. Tell me how you want this game to run — the tone at the table, anything off limits, anything you are hoping for.';
  }
  return 'Noted. What else should I know about the game you want?';
}

/**
 * Influences the host names outright: "three influences: Discworld, Spirited
 * Away, and Brazil", "my influences are…", "inspired by…". Split on commas
 * (and a final "and" after one); a title with "and" in it and no commas
 * around it stays whole. Anything unsure is left to the model.
 */
export function influencesNamedIn(text: string): string[] {
  const m = text.match(/\binfluences?\b[^:.!?\n]{0,40}?(?::|\bare\b|\bis\b|—|–)\s*([^\n]+)/i)
    ?? text.match(/\binspired by\s+([^\n]+)/i);
  if (!m) return [];
  let list = m[1]!.trim().replace(/[.!?]+$/, '');
  // Stop at a sentence that follows the list ("…and Brazil. Keep it light.").
  list = list.split(/(?<=[a-z0-9)"'”’])[.!?]\s+(?=[A-Z])/)[0]!;
  const parts = list.includes(',') || list.includes(';')
    ? list.split(/\s*[,;]\s*/).flatMap((p, i, all) => {
        if (i !== all.length - 1) return [p];
        // "…, and Brazil" (a serial comma) or "…, Spirited Away and Brazil".
        return /^(?:and|&)\s+/i.test(p) ? [p] : p.split(/\s+(?:and|&)\s+(?=[A-Z0-9"“'‘])/);
      })
    : [list];
  return parts
    .map(p => p.trim().replace(/^(?:and|&)\s+/i, '').replace(/^["“'‘]|["”'’]$/g, '').trim())
    .filter(p => p.length >= 2 && p.length <= 80 && /[A-Za-z]/.test(p));
}

export interface PartyMember {
  name: string;
  highConcept: string;
  age?: number | string;
  /** As the player stated it; unset means unspecified, never "guess". */
  pronouns?: string;
  /** Only the opening reads it — where they come from shapes how they arrive. */
  backstory?: string;
  relationships?: CharacterRelationship[];
  /** Taken out (FATE): down and out of action until they recover. */
  takenOut?: boolean;
  /** The trouble, only for the rule that a trait is never a being. */
  trouble?: string;
}

const FEMININE_RELATIONS = /\b(mother|mom|mum|mama|sister|daughter|wife|aunt|grandmother|grandma|granny|niece|girlfriend|stepmother|stepdaughter|stepsister)\b/i;
const MASCULINE_RELATIONS = /\b(father|dad|papa|brother|son|husband|uncle|grandfather|grandpa|nephew|boyfriend|stepfather|stepson|stepbrother)\b/i;

/** Object pronoun implied by a relation word ("mother" -> her), else "them". */
export function pronounForRelation(relation: string): 'her' | 'him' | 'them' {
  if (FEMININE_RELATIONS.test(relation)) return 'her';
  if (MASCULINE_RELATIONS.test(relation)) return 'him';
  return 'them';
}

export type Gender = 'f' | 'm' | 'n';

/** "she/her" -> f, "he/him" -> m, "they/them" -> n; anything else is not something to build grammar on. */
function genderFromPronouns(pronouns: string | undefined): Gender | null {
  const first = pronouns?.trim().toLowerCase().split(/[\/,\s]+/)[0];
  if (first === 'she' || first === 'her') return 'f';
  if (first === 'he' || first === 'him') return 'm';
  if (first === 'they' || first === 'them') return 'n';
  return null;
}

function sameFirstName(a: string, b: string): boolean {
  const x = a.trim().split(/\s+/)[0]?.toLowerCase();
  const y = b.trim().split(/\s+/)[0]?.toLowerCase();
  return !!x && x === y;
}

/**
 * What a character's gender is, as far as anything a player actually wrote
 * says: their own pronouns, else a gendered word a companion's sheet uses
 * for them ("mother" on Biz's sheet says Liz is a woman). Nothing else — not
 * a name, not an age, and never an inverse the code worked out.
 */
export function statedGender(member: PartyMember, party: PartyMember[]): Gender | null {
  const own = genderFromPronouns(member.pronouns);
  if (own) return own;
  if (member.pronouns?.trim()) return null;
  for (const other of party) {
    if (other === member) continue;
    for (const r of other.relationships ?? []) {
      if (!sameFirstName(r.to, member.name)) continue;
      if (FEMININE_RELATIONS.test(r.relation)) return 'f';
      if (MASCULINE_RELATIONS.test(r.relation)) return 'm';
    }
  }
  return null;
}

/** Relation words that name the same tie, in families with a gendered form and a neutral one. */
const RELATION_FAMILIES: Record<string, { f: string; m: string; n: string; words: string[]; inverse: string }> = {
  parent: { f: 'mother', m: 'father', n: 'parent', words: ['mother', 'mom', 'mum', 'mama', 'mommy', 'mummy', 'father', 'dad', 'papa', 'daddy', 'parent', 'stepmother', 'stepfather'], inverse: 'child' },
  child: { f: 'daughter', m: 'son', n: 'child', words: ['son', 'daughter', 'child', 'kid', 'boy', 'girl', 'stepson', 'stepdaughter', 'stepchild'], inverse: 'parent' },
  sibling: { f: 'sister', m: 'brother', n: 'sibling', words: ['sister', 'brother', 'sibling', 'sis', 'bro', 'twin', 'stepsister', 'stepbrother'], inverse: 'sibling' },
  spouse: { f: 'wife', m: 'husband', n: 'spouse', words: ['wife', 'husband', 'spouse', 'partner'], inverse: 'spouse' },
  grandparent: { f: 'grandmother', m: 'grandfather', n: 'grandparent', words: ['grandmother', 'grandma', 'granny', 'nana', 'grandfather', 'grandpa', 'granddad', 'grandparent'], inverse: 'grandchild' },
  grandchild: { f: 'granddaughter', m: 'grandson', n: 'grandchild', words: ['granddaughter', 'grandson', 'grandchild', 'grandkid'], inverse: 'grandparent' },
  auntuncle: { f: 'aunt', m: 'uncle', n: "parent's sibling", words: ['aunt', 'auntie', 'uncle'], inverse: 'niblings' },
  niblings: { f: 'niece', m: 'nephew', n: "sibling's child", words: ['niece', 'nephew', 'nibling'], inverse: 'auntuncle' },
};

function relationFamily(relation: string): string | null {
  const words = relation.toLowerCase().match(/[a-z']+/g) ?? [];
  for (const [key, fam] of Object.entries(RELATION_FAMILIES)) {
    if (words.some(w => fam.words.includes(w))) return key;
  }
  return null;
}

/**
 * What the sheet's owner is to someone they call `relation`: Biz's "mother"
 * makes Biz her "child". Gendered ("son", "daughter") only when the owner's
 * own `pronouns` say so — a relation word says nothing about the other end.
 */
export function inverseRelation(relation: string, ownerPronouns?: string): string | null {
  const key = relationFamily(relation);
  if (!key) return null;
  const inv = RELATION_FAMILIES[RELATION_FAMILIES[key]!.inverse]!;
  const g = genderFromPronouns(ownerPronouns);
  return g === 'f' ? inv.f : g === 'm' ? inv.m : inv.n;
}

/** Every word that states `relation` or its inverse — "Biz's mother" and "Liz's kid" state the same tie. */
function wordsForTie(relation: string): string[] {
  const key = relationFamily(relation);
  const own = relation.toLowerCase().match(/[a-z']+/g) ?? [];
  if (!key) return own;
  const fam = RELATION_FAMILIES[key]!;
  return [...new Set([...own, ...fam.words, ...RELATION_FAMILIES[fam.inverse]!.words])];
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`, 'i').test(text);
}

/** True if `prose` already says this tie: the other person's name plus the relation word or its inverse. */
function tieIsStated(prose: string, r: CharacterRelationship): boolean {
  const otherFirst = r.to.trim().split(/\s+/)[0] ?? '';
  if (!otherFirst || !hasWord(prose, otherFirst)) return false;
  return wordsForTie(r.relation).some(w => hasWord(prose, w));
}

/**
 * One plain sentence per stated relationship, from the sheet owner's side:
 * "Liz is Biz's mother." Address terms are deliberately NOT here — "Mom" is
 * how Biz talks to Liz, not a fact for narration; describeParty scopes it.
 */
export function describeRelationships(member: PartyMember): string[] {
  return (member.relationships ?? []).map(r => `${r.to} is ${member.name}'s ${r.relation}.`);
}

/** "Biz is here with their mother, Liz." — the tie as a sentence of narration. */
function tieClause(member: PartyMember, r: CharacterRelationship, party: PartyMember[]): string {
  const g = statedGender(member, party);
  const poss = g === 'f' ? 'her' : g === 'm' ? 'his' : 'their';
  return `${member.name} is here with ${poss} ${r.relation.trim()}, ${r.to}.`;
}

/**
 * A character's opening introduction. The DM's prose when it wrote one —
 * with a natural sentence added for any stated tie the prose really left
 * out — otherwise a plain line from the sheet. Never an address term, never
 * a parenthetical: this is narration, read aloud to the table.
 */
export function introduceCharacter(member: PartyMember, dmText: string | undefined, party: PartyMember[]): string {
  const rels = member.relationships ?? [];
  const prose = dmText?.trim();
  if (prose) {
    const missing = rels.filter(r => !tieIsStated(prose, r));
    return missing.length > 0 ? `${prose} ${missing.map(r => tieClause(member, r, party)).join(' ')}` : prose;
  }
  const age = member.age === undefined || !String(member.age).trim() ? ''
    : typeof member.age === 'number' || /^\d+$/.test(String(member.age).trim()) ? `, ${String(member.age).trim()} years old` : `, ${String(member.age).trim()}`;
  const ties = rels.map(r => tieClause(member, r, party));
  return `${member.name} — ${member.highConcept}${age}.${ties.length > 0 ? ' ' + ties.join(' ') : ''}`;
}

/**
 * "Biz calls Liz "Mom"; everyone else, NPCs included, calls her "Liz"." An
 * address term belongs to one relationship. Stated bare, the DM read it as
 * Liz's name and had every NPC call her Mom.
 */
function describeAddressTerms(member: PartyMember, party: PartyMember[]): string[] {
  return (member.relationships ?? []).flatMap(r => {
    const term = r.address?.trim();
    if (!term || term.toLowerCase() === r.to.trim().toLowerCase() || sameFirstName(term, r.to)) return [];
    const target = party.find(p => sameFirstName(p.name, r.to));
    const g = target ? statedGender(target, party) : null;
    const obj = g === 'f' ? 'her' : g === 'm' ? 'him' : r.to;
    return [`${member.name} calls ${r.to} "${term}"; everyone else, NPCs included, calls ${obj} "${r.to}".`];
  });
}

/**
 * The authoritative "who is playing" block for every DM prompt during play.
 * The setup chat sometimes invents placeholder player characters; this block
 * is what tells the DM those were never the players.
 */
export function describeParty(members: PartyMember[]): string {
  if (members.length === 0) return '';
  let anyUnstated = false;
  const lines = members.map(m => {
    const age = m.age !== undefined && String(m.age).trim() ? `; age ${String(m.age).trim()}` : '';
    let gender = '';
    if (m.pronouns?.trim()) {
      gender = `; pronouns: ${m.pronouns.trim()}`;
    } else if (!statedGender(m, members)) {
      anyUnstated = true;
      gender = `; gender and pronouns not stated — refer to ${m.name} by name or as "they"`;
    }
    const rels = describeRelationships(m);
    const address = describeAddressTerms(m, members);
    const out = m.takenOut ? ` ${m.name} is TAKEN OUT: down and out of action — cannot act, move or speak on their own until they recover (a companion helps them up, or the next scene). Do not narrate ${m.name} doing, saying or noticing anything.` : '';
    return `- ${m.name}: ${m.highConcept}${age}${gender}.${[...rels, ...address].map(x => ' ' + x).join('')}${out}`;
  });
  const hasAges = members.some(m => m.age !== undefined && String(m.age).trim());
  const hasAddress = members.some(m => describeAddressTerms(m, members).length > 0);
  // A worked example from this party's own sheets: "Biz steadies Liz", never "Biz steadies Mom".
  const example = members.flatMap(m => (m.relationships ?? [])
    .filter(r => r.address?.trim() && !sameFirstName(r.address, r.to) && r.address.trim().toLowerCase() !== r.to.trim().toLowerCase())
    .map(r => ({ speaker: m.name.trim().split(/\s+/)[0]!, to: r.to.trim().split(/\s+/)[0]!, term: r.address!.trim() })))[0];
  const addressExample = example ? ` ("${example.speaker} steadies ${example.to}", never "${example.speaker} steadies ${example.term}")` : '';
  // Live (WXKC2C): Biz, they/them and ten, was "her son", "the boy" and "its gaze".
  const pronounLine = partyPronounLine(members.map(m => ({ name: m.name, pronouns: pronounsFor(m, members) })));
  const nounRule = pronounLine ? `${pronounLine} Use them in narration and in everyone's speech, NPCs included.` : '';
  const first = members[0]?.name.trim().split(/\s+/)[0];
  return [
    'THE PARTY — the player characters actually at this table (authoritative). Any other player-character names that came up while setting the game up were placeholders: those people are not in this game and must never appear as party members.',
    ...lines,
    hasAges ? 'Characters act their stated ages — a child thinks, talks and is treated like a child.' : '',
    nounRule,
    // Live (WXKC2C): the clerk called Liz "Mrs. Miller" for the whole game.
    `Never give a party member a surname, title or honorific their sheet does not state: NPCs call them by the name above${first ? ` ("${first}" — never "Mrs. Something" or "Mr. Something")` : ''}.`,
    anyUnstated ? 'Never guess a gender this block does not state — not from a name, an age, or the other side of a relation (a mother\'s child is not therefore a son). Where it is not stated, use the character\'s name or "they", and gender-neutral words for them: kid, child, parent, sibling — never son, daughter, boy, girl, he or she.' : '',
    'Characters address each other the way they naturally would — a child calls their mother "Mom", not by her first name.',
    'Do not give a character a chair, a seat, a posture or a prop the story has not set up — if you do not know whether someone is sitting, do not say.',
    `In narration, call each party member by their name, never by their high concept: the phrase after each name above describes them and is not something anyone is called${members[0] ? ` ("${members[0].name.trim().split(/\s+/)[0]} steps forward", never "the ${members[0].highConcept} steps forward")` : ''}.`,
    traitRule(members),
    hasAddress ? `Address terms are personal to the relationship: a term like "Mom" is what one character calls another, never that person\'s name. Only that character uses it, and only in their own dialogue; NPCs and everyone else use the name. In narration, resolutions, scene summaries and the epilogue, characters are called by their NAMES${addressExample} — even when a character\'s own action uses the address term; an address term appears only inside that character\'s quoted speech.` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Troubles and aspects are traits. Live, Biz's trouble "Wanders Off After
 * Anything Shiny" became "a shimmering paper sprite—Wanders Off After
 * Anything Shiny—flits toward a glittering golden stamp".
 */
function traitRule(members: PartyMember[]): string {
  const withTrouble = members.find(m => m.trouble?.trim());
  const example = withTrouble
    ? ` ("${withTrouble.name.trim().split(/\s+/)[0]}'s trouble, ${withTrouble.trouble!.trim()}, pulls at them" — never a creature, spirit or person called "${withTrouble.trouble!.trim()}")`
    : '';
  return `High concepts, troubles, aspects and stunts are character traits — never beings, creatures, objects or places, and never anyone's name. Never invent something that is called by one or embodies one${example}. A character may draw on their own aspect by name; that is the game's mechanic.`;
}

/** How to refer to a party member, as far as the sheets say: "she/her", the player's own words, or null (not stated). */
export function pronounsFor(member: PartyMember, party: PartyMember[]): string | null {
  if (member.pronouns?.trim()) return member.pronouns.trim();
  const g = statedGender(member, party);
  return g === 'f' ? 'she/her' : g === 'm' ? 'he/him' : g === 'n' ? 'they/them' : null;
}

const CHILD_RELATIONS = /\b(child|kid|son|daughter|stepchild|stepson|stepdaughter|toddler|baby)\b/i;

/** A stated age under 13: 10, "10", "9 years old", "about 8". Words and ranges are not guessed at. */
function childAge(age: number | string | undefined): boolean {
  if (age === undefined || age === null) return false;
  const n = typeof age === 'number' ? age : parseInt(String(age).match(/\d+/)?.[0] ?? '', 10);
  return Number.isFinite(n) && n < 13;
}

/**
 * Party members who are children, as the sheets say: a stated age under 13,
 * or a companion's sheet naming them as that companion's child/kid/son/
 * daughter.
 */
export function childrenInParty(party: PartyMember[]): string[] {
  return party.filter(m => childAge(m.age) || party.some(o => o !== m && (o.relationships ?? []).some(r => sameFirstName(r.to, m.name) && CHILD_RELATIONS.test(r.relation))))
    .map(m => m.name);
}

/**
 * Did the host ask for gentle or cozy peril ("gentle peril only, nothing
 * scary or gory", "cozy", "kid-friendly")? Read off what is on record — the
 * host's setup messages and the direction the DM wrote from them — so the
 * wish holds for the whole game, not just the setup chat.
 */
export function wantsGentlePeril(texts: Array<string | null | undefined>): boolean {
  return texts.some(t => !!t && /\b(?:gentle|mild|light|soft|low|cozy|cosy)[- ](?:peril|danger|stakes|scares?|adventure|tension)\b|\bcou?[sz]y\b|\b(?:kid|child|family)[- ]friendly\b|\bnothing (?:too )?(?:scary|gory|frightening|violent)\b|\bno (?:gore|violence|scary)\b/i.test(t));
}

/** How a gentle-peril table is run: what tension is made of, and what it never is. */
const GENTLE_PERIL_REGISTER = 'GENTLE PERIL register: stakes come from mishaps, silliness, lost things, bureaucratic obstacles, muddles, puzzles and things that go wrong — real stakes, told the way a good children\'s book tells them. Nothing comes close to hurting anyone: no near-misses to the body (nothing slams down "missing their ear by a whisker", nothing whizzes past a head), and nothing bites, snaps or nips at anyone — not animals, paperwork or furniture ("the paperwork might bite back" is out). No punishment or countdown threats aimed at the child: nobody threatens detention, arrest, confiscation or being kept behind, and no NPC gives anyone a number of minutes before something bad happens ("you have four minutes before the queue resets", "a five-minute detention") — a queue can move and a clock can tick in the background, but it never counts down at the kid. Nothing is "terrifying" or "horrifying": a goose waddles with great determination, not terrifying determination. Never describe bodily harm or pain (no bones, skulls, jaws, teeth rattling in heads, sharp pain, wounds, blood or gore), no weapons or weapon sounds (no guns, gunshots, blades), nobody is ever hunted, stalked, preyed on or eaten — not by crowds, doors, monsters or anything else — and nothing tightens around anyone\'s body (no ropes, nooses or chains). Threats are grumpy, silly, bureaucratic or mysterious, never predatory — and never permanent: nobody is threatened with being trapped, lost or archived forever, filed away as a permanent fixture, or left with only one terrifying way out, and storms, rooms and paperwork never eat anyone or anything. A person is never the thing being processed: nobody — least of all the child — is threatened with being erased, filed, processed, catalogued, stamped, shredded, alphabetized or swallowed (whole or otherwise), called clutter or an unregistered asset to be put in a drawer, or told the system will forget they exist; the paperwork, the stamps and the queue are the obstacle, never the kid. Never separate the child from their grown-up: no partition, wall, door or gap seals them apart, and no NPC threatens to take either one away; the two of them face every obstacle side by side. And never dismiss the kid\'s feelings: no NPC calls their worry, tears or a hug an "emotional outburst", "noted" as a delay, or a filing error. Do not repeat the same threat beat after beat.';

/**
 * How a gentle table's story ends. Live (Z9JKG2, gentle peril, a
 * ten-year-old): the epilogue opened "Liz and Biz stood frozen as the storm
 * sealed the exit" and Liz's last thought was "holding nothing but my fear".
 */
const GENTLE_ENDING = 'ENDING at a gentle table: the epilogue and every character\'s final words land somewhere safe and hopeful — the party together, safe or safely on their way, an unsolved problem left as a door open for next time, never a doom. Nobody ends trapped, frozen, sealed in, lost or alone, and nobody\'s last word is fear or despair. Warm, a little funny, like the last page of a good children\'s book.';

/**
 * The one tone rule a table with a child gets — or a table whose host asked
 * for gentle peril. Seen live: "'Wanders off' — the words could be Biz's
 * epitaph." about a ten-year-old (E9W9YT), and in N7RQZ7, with the host's
 * "gentle peril only": "a sound like a jaw cracking open… rattles her teeth
 * in her skull", "the crowd turning with hunting intent", "echoing like a
 * gunshot". Stakes stay; the harm, the weapons and the hunting go.
 */
export function childToneRule(party: PartyMember[], opts: { gentlePeril?: boolean; ending?: boolean } = {}): string {
  const kids = childrenInParty(party);
  const ending = opts.ending ? ` ${GENTLE_ENDING}` : '';
  if (kids.length === 0) {
    return opts.gentlePeril ? `GENTLE PERIL: the host asked for gentle peril. Run every scene in the ${GENTLE_PERIL_REGISTER}${ending}` : '';
  }
  const who = kids.length === 1 ? `${kids[0]} is a child` : `${kids.slice(0, -1).join(', ')} and ${kids[kids.length - 1]} are children`;
  const asked = opts.gentlePeril ? ' The host asked for gentle peril too.' : '';
  return `FAMILY TABLE: ${who}, playing at this table.${asked} Peril and stakes are fine, in the ${GENTLE_PERIL_REGISTER} Never frame a child's death or loss morbidly: no epitaphs, graves, funerals, "never came back", or musing on whether they will die. Keep the imagery a ten-year-old can read, for EVERYONE in the scene, NPCs included: no nooses or hanging, no bones cracking or breaking, no blood, wounds or gore, no death imagery (corpses, skulls, "dying" light, graves), no branding or burning skin, nothing "terrifying" or "horrifying".${ending}`;
}

/**
 * The setup chat once the host has asked for gentle peril (round 15,
 * RZBU7G): the chat sat outside the register and offered the host "the
 * risk of being filed away in a drawer forever" as the danger of a gentle
 * table. Only the host's own words count — the DM asking "do you want
 * gentle peril?" is not the host asking for it. '' when the host has not.
 */
export function setupToneRule(history: Array<{ role: string; content: string }>): string {
  if (!wantsGentlePeril(history.filter(m => m.role === 'user').map(m => m.content))) return '';
  return `\n\nGENTLE PERIL: the host asked for gentle peril. Everything you write — "reply", dmInstructions and dmCustomPrompt, and every example dangers you offer the host to choose from — stays in the ${GENTLE_PERIL_REGISTER}`;
}

const PLAYER_REFERENCE = /\b(players?|player[- ]characters?|PCs?|protagonists?|the party|party members?)\b/i;
const NON_NAME_WORDS = new Set(['The', 'They', 'Their', 'A', 'An', 'And', 'But', 'Or', 'I', 'We', 'You', 'He', 'She', 'It', 'This', 'That', 'These', 'Those', 'Keep', 'Make', 'Let', 'Use', 'Run', 'Give', 'When', 'If', 'Both', 'Each', 'All']);

/**
 * Drops setup-invented player characters from free-text DM direction.
 *
 * The setup chat is had before anyone has made a character, so the DM
 * sometimes fills the gap with placeholder PCs ("The players are Marilyn
 * 'Merry' Harper and her son Jasper"). Stored direction keeps those names
 * forever, and the DM kept playing them instead of the real party. For play,
 * a sentence that talks about the players AND names someone who is not in
 * the party is dropped; everything else in the direction is kept verbatim.
 * The stored campaign text is never modified.
 */
export function withoutPlaceholderParty(text: string | null, partyNames: string[]): string | null {
  if (!text || partyNames.length === 0) return text;
  const partyTokens = new Set(partyNames.flatMap(n => n.split(/\s+/)).map(t => t.replace(/[^A-Za-z'-]/g, '').toLowerCase()).filter(Boolean));
  const sentences = text.split(SENTENCE_SPLIT);
  const kept = sentences.filter(sentence => {
    if (!PLAYER_REFERENCE.test(sentence)) return true;
    const names = (sentence.match(/\b[A-Z][a-z]+(?:'[a-z]+)?\b/g) ?? [])
      .filter(w => !NON_NAME_WORDS.has(w) && !partyTokens.has(w.toLowerCase()));
    return names.length === 0;
  });
  const result = kept.join(' ').trim();
  return result || null;
}

/**
 * Pure prompt assembly. Exported so the composition order and — critically —
 * the fact that dmCustomPrompt AUGMENTS rather than replaces the preset are
 * directly testable. The original bug was a branch here, not in
 * composePresetSections, so that is where the guard has to be.
 */
export function assembleSystemPrompt(input: {
  preset: string;
  dmCustomPrompt: string | null;
  houseRules: string | null;
  dmInstructions: string | null;
  campaignMaterials: string | null;
  influences: string[];
  /** The host asked for gentle or cozy peril (wantsGentlePeril). */
  gentlePeril?: boolean;
  /** The live party. When present, it is stated as authoritative and setup-invented PCs are dropped from the direction. */
  party?: PartyMember[];
}): { systemPrompt: string; criticalReminder: string; narrationHint: string } {
  const sections = composePresetSections(input.preset);
  const partyNames = (input.party ?? []).map(p => p.name);
  // The setup chat is had before anyone states pronouns: live, its direction
  // said "her 10-year-old son Biz" for a they/them Biz, in every DM prompt.
  const nounMembers = (input.party ?? []).map(p => ({ name: p.name, pronouns: p.pronouns ?? null, relationships: p.relationships ?? [] }));
  const neutral = (t: string | null) => (t ? repairGenderedNouns(t, nounMembers, { neutralWhenUnknown: true }) : t);
  const dmCustomPrompt = neutral(withoutPlaceholderParty(input.dmCustomPrompt, partyNames));
  const dmInstructions = neutral(withoutPlaceholderParty(input.dmInstructions, partyNames));
  let prompt = sections.head;
  const criticalSection = sections.critical;
  const narrationHint = sections.narrationHint;

  // The setup conversation's tailored prompt is ADDITIONAL direction, not a
  // replacement — replacing it silently dropped the preset's personality
  // enforcement and its narration hint.
  if (dmCustomPrompt) {
    prompt += `\nFor this campaign specifically:\n${dmCustomPrompt}\n`;
  }

  if (input.influences.length > 0) {
    prompt += `\nStylistic influences for this world — these shape VOICE and texture, never plot. Let them show in word choice, rhythm, and what the narration notices:\n${input.influences.map(i => `- ${i}`).join('\n')}\n`;
  }

  prompt += `
Storytelling principles:
- Actions have real consequences. Not every plan works. Failure creates drama.
- NPCs have their own goals and react to the party's actions, even between scenes.
- VOICE YOUR NPCs: When an NPC is present and the scene involves them, give them ACTUAL DIALOGUE in quotation marks. A tavern keeper says "You'll find no friends past the Irongate — just ghosts and the things that eat them." A guard captain barks "State your business or turn back." NPCs who speak feel alive; NPCs who are only described feel like furniture. At least one NPC should speak per narration when NPCs are present.
- QUOTES: every quotation you open, you close. A word quoted inside speech closes before the speech does ('…never mention the word "taxation."'), and a closed quotation is followed by a space and the next sentence — never a comma ('…a name in ink!' The air thickens.).
- The world moves forward whether characters act or not — time pressure matters.
- Introduce complications that force hard choices, not just combat encounters.
- Use the environment as an active element — weather, terrain, crowds, lighting.
- When characters succeed, success should change the situation, not just confirm it.
- WEAVE BACK earlier threads: if the world state lists UNRESOLVED THREADS, advance at least one per narration. Reintroduce NPCs, revisit locations, or reveal consequences of past actions.
- INVOKE TROUBLE ASPECTS: Each character has a "trouble" aspect — a personal flaw or complication. Create situations that TARGET these troubles. If a character's trouble is "Haunted by the War," put them face-to-face with a war memorial or a former comrade. If it's "Visions I Cannot Unsee," show them something that triggers a vision at the worst moment. Trouble compels create the most memorable scenes.
- VARY your imagery: do not repeat the same visual motifs (e.g. "skeletal hands," "black water") more than twice in a scene. Introduce new sensory details — sounds, smells, temperature, texture — to keep the world alive.
- Build toward a dramatic question — each scene should move the story closer to answering: will the party succeed, and at what cost?
- ADVANCE THROUGH LOCATIONS: Check the "Known locations" list in the world state — the party should visit these NAMED locations as the story progresses. Use their EXACT names in your narration (e.g. "The Clockwork Antechamber" not "a chamber"). Don't let them linger in one location for more than 2-3 rounds. Each scene transition should move deeper into the adventure. If the party has been in the same location for 3+ rounds, create a reason to move them forward — a collapsing passage, a discovered exit, an NPC leading them onward.
- PARTY DYNAMICS: When multiple characters are present, create situations that force them to INTERACT — a locked door one can pick while another stands guard, a moral dilemma where their values conflict, an NPC who trusts one character but fears another. Reference each character's last action in your narration. If one character just failed, show how it affects the others. The most interesting party moments come from characters disagreeing about what to do next.
- WHISPER AWARENESS: Characters hear a mysterious voice (the player's whispers). When the transcript shows a character heeded or resisted a whisper, weave the CONSEQUENCES into the narrative. A character following dangerous whispers might attract dark attention; one resisting wise counsel might face harder consequences. The whisper influence is the game's central tension — make it matter in the story.
- Whispers come ONLY from the players, and they are private. You never narrate a whisper or a voice speaking to a character — no voice in anyone's ear, head or mind, no whispered instruction, hint or warning — and you never quote, paraphrase or reveal what a whisper said. Show only what the characters do.
- CREATE WHISPER MOMENTS: At least once per scene, present a situation where the "right" choice is ambiguous — a locked door that could be forced or bypassed, a suspicious ally, a tempting shortcut through danger. These fork-in-the-road moments give the player interesting whisper decisions. The player is the character's conscience, and the best stories emerge when conscience is tested.
- USE ITEMS BY EXACT NAME: If the world state lists "Unclaimed items" or "Items you could pick up," use their EXACT names in your narration (e.g. "the Crystal Shard" not "a crystal," "Sparks' Blueprint" not "a map"). Describe a character spotting the item, an NPC offering it, or a situation where it would be useful. When resolving actions, if a character's inventory contains a relevant item, acknowledge it BY NAME and grant a narrative advantage. Items are plot hooks — "Sparks' Blueprint" hints at a secret passage, "the Gala Invitation" proves identity, "the Clockwork Lockpick" opens doors. Named items connect to the game's tracking system — paraphrased items get lost.
`;

  if (input.houseRules) prompt += `\nHouse rules: ${input.houseRules}\n`;
  if (dmInstructions) prompt += `\nDM direction: ${dmInstructions}\n`;
  const partyBlock = describeParty(input.party ?? []);
  if (partyBlock) prompt += `\n${partyBlock}\n`;
  const toneRule = childToneRule(input.party ?? [], { gentlePeril: input.gentlePeril });
  if (toneRule) prompt += `\n${toneRule}\n`;

  if (input.campaignMaterials) {
    prompt += `\nCampaign reference materials:\n${input.campaignMaterials}\n`;
  }

  if (criticalSection) prompt += criticalSection;
  prompt += `\nAlways respond with valid JSON matching the requested format. Never fabricate dice rolls — use only rolls provided to you. ${PLAIN_PROSE_STYLE}`;
  return { systemPrompt: prompt, criticalReminder: criticalSection.trim(), narrationHint };
}

/**
 * What each player character is carrying, for every ruling and narration
 * beat — "nothing" included. Live (Z9JKG2) the DM was only told about
 * non-empty inventories, so with nothing on record it had Liz pull a bottle
 * cap she had given away out of her tote, and a pen "eaten by the storm"
 * turned up again.
 */
export function itemsOnHandBlock(party: Array<{ name: string; inventory?: string[] }>, extra: { world?: Array<{ name: string; heldBy?: string | null }>; gone?: string[]; eaten?: string[] } = {}): string {
  if (party.length === 0) return '';
  const lines = party.map(p => `- ${p.name}: ${p.inventory && p.inventory.length > 0 ? p.inventory.join(', ') : 'nothing'}`);
  // Live (7RAAQ7): the world's "The Pen of Perpetual Pondering" beside Liz's
  // and Biz's "Pen" — the DM put the world's pen "in Liz's hand". World
  // things are listed as nobody's in the party, and a shared word is spelled out.
  const world = extra.world ?? [];
  const worldBlock = world.length > 0
    ? `\nNot held by anyone in the party (in the world, or kept by the NPC named):\n${world.map(w => `- ${w.name} — ${w.heldBy ? `held by ${w.heldBy}` : 'not held by anyone in the party'}`).join('\n')}`
    : '';
  const clashes = world.flatMap(w => {
    const holders = new Map<string, string[]>();
    for (const p of party) for (const i of p.inventory ?? []) {
      if (itemHeadWord(i) && itemHeadWord(i) === itemHeadWord(w.name) && i.trim().toLowerCase() !== w.name.trim().toLowerCase()) holders.set(i, [...(holders.get(i) ?? []), p.name]);
    }
    return [...holders].map(([i, who]) => `"${i}" (${who.join(', ')}) and "${w.name}" are different things: never call one by the other's name, and never put "${w.name}" in a party member's hand unless an itemMoves entry gives it to them.`);
  });
  // Live (RZBU7G): the clerk ate the granola bar, then went on "chewing on
  // the granola bar he has been hoarding". Eaten is gone from the world too.
  // And one stamp went by four names (The Stamp, Stamp of Clarity, Square
  // Stamp, Ink-Stained Stamp): the NAMES line.
  const eaten = (extra.eaten ?? []).filter(Boolean);
  const gone = (extra.gone ?? []).filter(g => g && !eaten.some(e => e.trim().toLowerCase() === g.trim().toLowerCase()));
  const goneLine = gone.length > 0 ? `\nGone for good (eaten, used up, given away, lost): ${gone.join(', ')} — no one in the party has these; never have one turn up again in anyone's hand, bag or pocket.` : '';
  const eatenLine = eaten.length > 0 ? `\nEaten or used up — these no longer exist anywhere, not even with an NPC: ${eaten.join(', ')}. Never narrate anyone holding, pocketing, hoarding, chewing or offering one again.` : '';
  return `\n<items_on_hand>\nWhat each player character is carrying right now (the record the table keeps):\n${lines.join('\n')}${worldBlock}${goneLine}${eatenLine}${clashes.length > 0 ? `\n${clashes.join('\n')}` : ''}\nNAMES: call every thing by its exact name as listed here, in prose and in itemMoves — never a new name for a thing already listed, not even a fancier or more specific one.\nITEMS ON HAND: a character can only use, show, hand over or drop what is on their line. Something given away, used up, lost or destroyed is gone — never have it turn up again in their hand, bag or pocket. When someone picks something up or is handed it, show it plainly in the prose, naming who now holds it and the thing itself ("the pen lands in Biz's palm", not just "it" or "a soft arc of black plastic"). One from a stack (a bottle cap from "Bottle caps") is one: the giver keeps the rest. Things are held, not eaten: nobody chews or swallows a thing that is not food.\n</items_on_hand>`;
}

/** The last word of an item's name before "of …" or a label: "The Pen of Perpetual Pondering" → pen. */
function itemHeadWord(name: string): string {
  const words = name.split(/[:(]/)[0]!.replace(/\s+of\s+.*$/i, '').toLowerCase().match(/[a-z][a-z'’-]*/g) ?? [];
  return (words[words.length - 1] ?? '').replace(/s$/, '');
}

/**
 * Items as data, for every ruling and narration beat (see item-moves.ts).
 * The server applies these moves and nothing else; the prose is only checked
 * against them.
 */
export const ITEM_MOVES_RULE = `ITEM MOVES: every time your narration moves a thing, list the move in "itemMoves" — someone hands it over, gives it, picks it up, takes it, catches it, drops it, sets it down, loses it, eats it, uses it up or destroys it. Each entry: {"item": "<exact name from <items_on_hand>, or a short plain name for a new thing>", "from": "<who had it>", "to": "<who has it now>"}. "from" and "to" are a player character's exact name, an NPC's name, "world" (lying in the scene: dropped, set down, scattered, or picked up from there), or null ("from": null for a thing that appears from nowhere; "to": null for a thing eaten, used up or destroyed). Eaten is "to": null, never a hand-over: an NPC who is given food and eats it in the same beat takes two entries (giver → NPC, then NPC → null), or one straight to null (giver → null). Use the exact name from <items_on_hand> for a thing already listed, never a new name for it. Add "qty": 1 to move one from a stack ("a bottle cap" from "Bottle caps"). A player character can only give what is on their line. An NPC's thing comes from that NPC — never from a player character who happens to hold one like it. Damaged is not gone: a torn bag, a bent key, a smudged form is still carried and gets no entry; what spills or scatters out of it goes to "world". Nothing moves because someone asks for, offers, points at, looks at or claims a thing — only when your narration shows it change hands. When nothing moves, "itemMoves": [].`;

/**
 * The acting character reaches for something of theirs that is not on their
 * line (usesMissingItems). Live (7MJXE5): the goose ate Liz's granola bar,
 * then "I jam the granola bar from my tote into…" and the ruling went along
 * with it. The action stands; the ruling redirects it gently.
 */
export function itemsNotOnHandBlock(name: string, items: string[]): string {
  if (items.length === 0) return '';
  const list = items.length === 1 ? `the ${items[0]}` : `${items.slice(0, -1).map(i => `the ${i}`).join(', ')} and the ${items[items.length - 1]}`;
  return `\n<items_not_on_hand>\n${name}'s action reaches for ${list}, which is not on ${name}'s line in <items_on_hand>: it is gone — eaten, used up, given away or lost earlier in the story. Do not refuse the action, and do not let the item turn up: narrate ${name} reaching for it and finding it gone (a gentle beat, not a scolding), then resolve what they were trying to do with what they do have or with a quick improvisation.\n</items_not_on_hand>`;
}

export interface ScenePacing {
  sceneNumber: number;
  sceneTurnCount: number;
  characterSummaries: string;
  partySize: number;
  sessionTurnCount?: number;
  locationTurnCount?: number;
  currentLocationName?: string;
  knownLocationNames?: string[];
  unvisitedLocationNames?: string[];
  isFinale?: boolean;
  /** Each player character's inventory, for <items_on_hand>. */
  partyInventories?: Array<{ name: string; inventory: string[] }>;
  /** Items no party member holds (world items, NPCs' things), for <items_on_hand>. */
  worldItems?: Array<{ name: string; heldBy?: string | null }>;
  /** Things gone for good, for <items_on_hand>. */
  goneItems?: string[];
  /** Things eaten or used up — gone from the world, NPCs included — for <items_on_hand>. */
  eatenItems?: string[];
  /** The narration-only opening (arrival + introductions) has just been delivered; this is the first real beat of play. */
  afterOpening?: boolean;
  /** An earlier beat the last draft repeated nearly word for word: this one must move on from it. */
  repeatedBeat?: string;
}

interface DmContext {
  preset: string;
  houseRules: string | null;
  dmInstructions: string | null;
  dmCustomPrompt: string | null;
  campaignId: string;
  worldSummary: string;
  transcript: TranscriptMessage[];
  systemId: string;
  influences: string[];
  /** The live party. Optional so older callers keep working; play always passes it. */
  party?: PartyMember[];
  /** The host asked for gentle or cozy peril: the tone rule goes into every turn's prompt, not only the system prompt. */
  gentlePeril?: boolean;
  /**
   * The tone gate flagged the last draft (tone-gate.ts): the phrases,
   * quoted, for this one fresh try. Never the draft itself.
   */
  toneFeedback?: string;
  /**
   * NPCs the party has already met (round 14, 7RAAQ7: "I am Clerk
   * Ozymandias," he announced in scene 3, long after they had met).
   */
  metNpcs?: string[];
}

/**
 * The tone rule again, in the turn's own message: a system-prompt rule alone
 * drifted by mid-session (live N7RQZ7, a ten-year-old at the table and a
 * host who asked for gentle peril). '' when the table has neither.
 */
function turnToneBlock(ctx: DmContext): string {
  const rule = childToneRule(ctx.party ?? [], { gentlePeril: ctx.gentlePeril });
  const feedback = ctx.toneFeedback?.trim() ? `\n<tone_feedback>\n${ctx.toneFeedback.trim()}\n</tone_feedback>` : '';
  return (rule ? `\n<tone>\n${rule}\n</tone>` : '') + feedback;
}

/**
 * The NPCs the party already knows, so nobody introduces themselves twice
 * (7RAAQ7: "I am Clerk Ozymandias," in scene 3, met in scene 1). '' when
 * the party has met no one yet.
 */
export function metNpcsBlock(names: string[] | undefined): string {
  const met = [...new Set((names ?? []).map(n => n.trim()).filter(Boolean))];
  if (met.length === 0) return '';
  return `\n<already_met>\nThe party has already met: ${met.join(', ')}. These people know the party and the party knows them: none of them introduces themselves again ("I am ${met[0]}", "my name is…", "allow me to introduce myself") or is described as if seen for the first time. They pick up where they left off.\n</already_met>`;
}

export class DmAgent {
  constructor(private db: Database.Database) {}

  async narrate(ctx: DmContext, pacing?: ScenePacing): Promise<DmNarration> {
    const recentTranscript = ctx.transcript.slice(-20).map(m => `[${m.role}${m.characterId ? ':' + m.characterId : ''}] ${m.content}`).join('\n');

    const turnCount = pacing?.sceneTurnCount ?? 0;
    const partySize = pacing?.partySize ?? 1;
    const roundCount = Math.floor(turnCount / partySize);
    const sceneNum = pacing?.sceneNumber ?? 1;

    const sessionTurn = pacing?.sessionTurnCount ?? 0;

    const isFinale = pacing?.isFinale ?? (sceneNum >= 4 && sessionTurn >= 18);

    let sessionArc: string;
    if (sceneNum <= 1) {
      sessionArc = 'ACT I (Setup): Establish the world, introduce the central mystery or threat. Plant clues and introduce key NPCs. The dramatic question should be clear by scene end.';
    } else if (sceneNum <= 3) {
      sessionArc = 'ACT II (Confrontation): Escalate complications. Alliances are tested, secrets are revealed, the threat becomes personal. Make the characters pay a cost for progress.';
    } else if (!isFinale) {
      sessionArc = 'ACT III (Resolution): Drive toward the climax. The dramatic question MUST be answered this act. Converge all threads toward a final confrontation or revelation. Stop introducing new complications — use what exists.';
    } else {
      sessionArc = `SESSION FINALE (scene ${sceneNum}): This is the LAST scene. Let it play out over multiple turns — do NOT try to narrate several rounds in one response. Each narration is ONE moment: describe what happens, let the character act, then you narrate again. No new locations or mysteries. Use established NPCs, items, and threads. Build toward a decisive confrontation, then end with a denouement. Do NOT set isSceneEnd on the opening narration.`;
    }

    if (isFinale) {
      if (roundCount >= 5) {
        sessionArc += ` WRAP UP NOW (turn ${sessionTurn}, round ${roundCount}): narrate the final outcome — victory, defeat, or bittersweet resolution — and set isSceneEnd to true. The story must end.`;
      } else if (roundCount >= 3) {
        sessionArc += ` (Turn ${sessionTurn}, round ${roundCount} — the climax should land THIS round. After one more decisive action, narrate the resolution and end the scene.)`;
      } else {
        sessionArc += ` (Turn ${sessionTurn} of session — converge toward resolution, but give the ending room to breathe.)`;
      }
    } else if (sessionTurn >= 16 && sceneNum >= 3) {
      sessionArc += ` (Turn ${sessionTurn} of session — the story is approaching its climax. Start converging threads toward a resolution.)`;
    }

    const developThreshold = partySize <= 1 ? 3 : 3;
    const escalateThreshold = partySize <= 1 ? 6 : Math.max(4, 7 - partySize);

    const hasPreviousScene = sceneNum > 1;

    const developBeats = [
      'Introduce an NPC with a secret agenda — they want something from the party and will offer something tempting in exchange.',
      'Add an environmental complication: a door locks behind them, a storm rolls in, lights go out, a passage collapses. The terrain itself becomes an obstacle.',
      'A clue or discovery reframes the situation — what seemed safe is dangerous, what seemed simple is layered. Reveal that an assumption was wrong.',
    ];
    const escalateBeats = [
      'An NPC betrays expectations — an ally reveals a hidden motive, an enemy offers help with strings attached, or a neutral party picks a side.',
      'Time pressure arrives: a countdown starts, a threat approaches, an ally calls for help from elsewhere. The party must choose between competing urgent needs.',
      'A consequence from an earlier action catches up — someone they offended returns with backup, a shortcut they took has a hidden cost, a promise comes due.',
      'Force a hard choice between two things the party cares about: save the hostage or catch the villain, protect the secret or warn the village, keep the item or trade it for passage.',
    ];

    let pacingHint: string;
    if (roundCount === 0 && !hasPreviousScene && pacing?.afterOpening) {
      pacingHint = 'The opening — the party\'s arrival and each character\'s introduction — has JUST been read to the table (see the transcript). Do NOT repeat or re-describe the arrival, and do NOT re-introduce the characters. Continue from that exact moment with the first thing that happens: something the party can see, hear or be approached about, and respond to. The characters know only what they have perceived so far — do not assume they hold items, facts or tasks nobody has given them, and do not reveal secrets or the answer to the mystery. Hint at the dramatic question; do not state it.';
    } else if (roundCount === 0) {
      pacingHint = hasPreviousScene
        ? 'This is the opening of a NEW scene. Bridge from the previous scene — acknowledge what changed, what was won or lost, and why the party is in a different situation now. Then set the new stage: describe the new location, atmosphere, and sensory details. If UNRESOLVED THREADS exist in the world state, weave at least one into this scene opening as a hook or complication. The scene transition should feel like a chapter break, not a jump cut.'
        : 'This is the opening of the FIRST scene. Set the stage vividly — describe the location, atmosphere, and any sensory details. Introduce the dramatic question. Hint at trouble or opportunity.';
    } else if (roundCount < developThreshold) {
      const beat = developBeats[(roundCount - 1) % developBeats.length]!;
      pacingHint = `The scene is developing (round ${roundCount}). ${beat} Do NOT set isSceneEnd — the scene has barely started.`;
    } else if (roundCount < escalateThreshold) {
      const beat = escalateBeats[(roundCount - developThreshold) % escalateBeats.length]!;
      pacingHint = `The scene is escalating (round ${roundCount}). ${beat} Do NOT set isSceneEnd yet — let the tension build toward a climax.`;
    } else if (roundCount < escalateThreshold + 3) {
      pacingHint = `The scene has run for ${roundCount} rounds. Actively look for a climactic moment to end the scene. If a dramatic beat just landed, tension peaked, the party reached a new location, combat concluded, or a key revelation dropped — set isSceneEnd to true. Transition to keep the narrative moving.`;
    } else {
      pacingHint = `SCENE OVERRUN: ${roundCount} rounds. You MUST end this scene NOW. Narrate a dramatic climax or cliffhanger and set isSceneEnd to true. Do not continue — the story needs to move forward.`;
    }

    const locTurns = pacing?.locationTurnCount ?? 0;
    const locationHint = locTurns >= 4
      ? `\nLOCATION WARNING: The party has been at "${pacing?.currentLocationName ?? 'this location'}" for ${locTurns} turns. You MUST move them to a DIFFERENT location from the "Known locations" list. Create a reason to leave — a sound from another room, a discovered passage, an NPC leading them away, or danger forcing retreat.`
      : locTurns >= 3
      ? `\n(The party has been at "${pacing?.currentLocationName ?? 'this location'}" for ${locTurns} turns. Consider moving them to keep the story dynamic.)`
      : '';

    const charBlock = pacing?.characterSummaries ? `\n\nParty status:\n${pacing.characterSummaries}` : '';
    const partyHint = (pacing?.partySize ?? 1) > 1
      ? ' With multiple characters, react to how their actions affect each other — a warrior\'s charge creates openings, a healer\'s work changes who can act, a scholar\'s discovery reshapes the situation for everyone.'
      : '';
    const sceneLabel = pacing ? `Scene ${pacing.sceneNumber}, round ${roundCount + 1} (turn ${turnCount + 1})` : 'Scene';

    const { systemPrompt, criticalReminder, narrationHint } = this.buildSystemPrompt(ctx);
    const personalityReminder = criticalReminder ? `\n\nPERSONALITY REQUIREMENT: ${criticalReminder}` : '';

    const unvisitedSet = new Set(pacing?.unvisitedLocationNames ?? []);
    const hasUnvisited = unvisitedSet.size > 0;
    const locationList = pacing?.knownLocationNames && pacing.knownLocationNames.length > 0
      ? `\n<valid_locations>\nYou MUST pick one of these EXACT names for currentLocationName:\n${pacing.knownLocationNames.map((n, i) => {
          const marker = unvisitedSet.has(n) ? ' ← UNVISITED (move the story here!)' : '';
          return `${i + 1}. ${n}${marker}`;
        }).join('\n')}${hasUnvisited ? '\nPrioritize UNVISITED locations — each holds unique content the players haven\'t seen yet.' : ''}\n</valid_locations>`
      : '';

    const troubleHint = pacing && roundCount > 0 && roundCount % 3 === 1
      ? this.buildTroubleHint(pacing.characterSummaries)
      : '';

    // qwen repeats itself: an NPC's exact line came back 50s later (and
    // another NPC echoed it), and the same few sensory words recurred.
    const repetition = repetitionNotes(ctx.transcript.filter(m => m.role === 'dm').slice(-6).map(m => m.content));

    const userMessage = [
      `<scene>`,
      sceneLabel,
      `Session arc: ${sessionArc}`,
      `Pacing: ${pacingHint}${locationHint}${troubleHint}`,
      `</scene>`,
      charBlock ? `\n<party>\n${charBlock.trim()}\n</party>` : '',
      pacing?.partyInventories ? itemsOnHandBlock(pacing.partyInventories, { world: pacing.worldItems, gone: pacing.goneItems, eaten: pacing.eatenItems }) : '',
      `\n<world>\n${ctx.worldSummary}\n</world>`,
      locationList,
      `\n<transcript>\n${recentTranscript}\n</transcript>`,
      repetition ? `\n<already_said>\n${repetition}\n</already_said>` : '',
      metNpcsBlock(ctx.metNpcs),
      turnToneBlock(ctx),
      pacing?.repeatedBeat ? `\n<repeated>\nYour last draft repeated this earlier beat almost word for word — the table has already read it:\n"${pacing.repeatedBeat}"\nDo NOT reuse its sentences, its NPC lines or its images. Write what happens NEXT, after it.\n</repeated>` : '',
      `\n<task>`,
      `Narrate what happens next in 2-4 vivid sentences. Describe ONE moment, not multiple rounds. VARY YOUR OPENING — don't start with the character's name every time. Try starting with: a sound, an NPC speaking, a sensory detail, a shift in the environment, or an action in progress. If UNRESOLVED THREADS appear in the world state, let them echo in the background — an overheard rumor, a shadow of the unfinished business, a ticking clock. Don't resolve them in narration, but keep them alive.\nNPC INITIATIVE: If activeNpcs are present, at least one NPC must SPEAK or ACT in the narration — they approach the party, ask a question, block a path, offer information, make a demand, or reveal something. "The foreman steps from the shadows, voice hoarse: 'You shouldn't be down here.'" NPCs who initiate create drama the characters MUST respond to.${partyHint}`,
      `currentLocationName MUST be COPIED EXACTLY from the <valid_locations> list above. NEVER invent a new location name. If no <valid_locations> section exists, you may introduce a new name.${personalityReminder}`,
      pacing?.partyInventories ? ITEM_MOVES_RULE : '',
      `Respond as JSON: { "narration": "2-4 vivid sentences.${narrationHint}", "currentLocationName": "...", "activeNpcs": ["name1", ...], "isSceneEnd": true|false${pacing?.partyInventories ? ', "itemMoves": [{"item": "<exact name>", "from": "<who had it>", "to": "<who has it now>"}]' : ''} }`,
      `</task>`,
    ].filter(Boolean).join('\n');

    return callLlm({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      schema: DmNarrationSchema,
      maxTokens: 2048,
      ...REPETITION_PENALTIES,
    });
  }

  /**
   * The narration-only opening of a fresh game: the arrival, then each
   * character as the others would see them. Nobody acts during it.
   *
   * It deliberately sees only what the characters could perceive — the
   * premise, the party, and the places — never NPC motives or plot hooks,
   * because an opening that knows the twist tends to narrate it. When a stock
   * scenario already has an openingNarration, that text is used verbatim by
   * the caller and this only writes the introductions.
   */
  async openScene(ctx: DmContext, opts: {
    premise: string;
    scenarioOpening: string | null;
    places: Array<{ name: string; description: string | null }>;
    /** The premise or backstories transport the party here: the arrival beat is required. */
    arrivalExpected?: boolean;
    /** What each character carries (their starting kit): the only props the opening may put on them. */
    inventories?: Array<{ name: string; inventory: string[] }>;
    /** Every NPC's fixed pronouns (npcPronounBlock): the opening can put anyone on stage. */
    npcPronouns?: string;
  }): Promise<DmOpening> {
    const { systemPrompt, criticalReminder } = this.buildSystemPrompt(ctx);
    const personalityReminder = criticalReminder ? `\n\nPERSONALITY REQUIREMENT: ${criticalReminder}` : '';
    const party = ctx.party ?? [];
    const names = party.map(p => p.name).join(' and ') || 'the party';
    const arrivalExpected = !!opts.arrivalExpected && !opts.scenarioOpening;
    const placeList = opts.places.slice(0, 8)
      .map(p => `- ${p.name}${p.description ? `: ${p.description}` : ''}`).join('\n');

    const userMessage = [
      `<opening>`,
      `This is the OPENING OF THE ADVENTURE. Nothing has happened yet and no one has acted.`,
      opts.premise ? `Premise — the situation the party is arriving into: ${opts.premise}` : '',
      opts.scenarioOpening
        ? `This opening has already been read aloud to the table and will be used as-is — do not rewrite it, and set "narration" to "":\n"${opts.scenarioOpening}"`
        : '',
      `</opening>`,
      party.length > 0 ? `\n<party>\n${describeParty(party)}\n</party>` : '',
      party.some(p => p.backstory?.trim())
        ? `\n<where they come from>\n${party.filter(p => p.backstory?.trim()).map(p => `- ${p.name}: ${clip(p.backstory!.trim(), 400)}`).join('\n')}\n</where they come from>`
        : '',
      placeList ? `\n<places>\n${placeList}\n</places>` : '',
      // Live (7MJXE5): with no record in the prompt, the opening put a coffee
      // mug in Liz's hand and a juice box in Biz's — neither was theirs.
      opts.inventories ? itemsOnHandBlock(opts.inventories) : '',
      opts.npcPronouns ? `\n<npc_pronouns>\n${opts.npcPronouns}\n</npc_pronouns>` : '',
      turnToneBlock(ctx),
      `\n<task>`,
      arrivalExpected
        ? `0. arrival: REQUIRED — 1-2 sentences of the moment of arrival itself, happening to ${names}: the lurch or fall or flash, landing or waking up here, blinking, disoriented, realising a moment ago they were somewhere else entirely. This is about THEM, not the place — it must never be scenery alone. The transport is told HERE and only here; the narration below picks up right after it.`
        : `0. arrival: "".`,
      opts.scenarioOpening
        ? `1. narration: "" (the scene is already set).`
        : arrivalExpected
        ? `1. narration: 3-5 vivid sentences that begin AFTER the arrival above, told from the characters' point of view. ${names} have ALREADY landed and are here now — do NOT narrate the transport again: no flash, no fall, no being pulled, hurled or swept out of anywhere, no "one moment… the next". Describe where they now stand and what hits them first, the strangeness of this world landing on people who have never seen it before — not scenery with nobody in it. Establish ONLY what the characters would perceive right now. Do NOT reveal secrets, hidden motives, twists, who is behind anything, or the answer to any mystery. Do not have anyone demand an item, fact or task the party has never been given. Do not make the characters act, speak or decide — they do that themselves once play begins.`
        : `1. narration: 3-5 vivid sentences told from the characters' point of view, at the exact moment the premise puts them here. Read the premise and where they come from: if they have just been transported, summoned, isekaied, shipwrecked or otherwise pulled out of their old lives, this scene IS their arrival — the moment they land or wake up here, disoriented, the strangeness of this world hitting people who have never seen it before. If they already belong here, open on them as the situation begins. Show the place as it lands on THEM — not just scenery or a description of the place with nobody in it. Establish ONLY what the characters would perceive right now. Do NOT reveal secrets, hidden motives, twists, who is behind anything, or the answer to any mystery. Do not have anyone demand an item, fact or task the party has never been given. Do not make the characters act, speak or decide — they do that themselves once play begins.`,
      `2. introductions: one per party member, 1-2 sentences each, describing that character as the others would see them on first glance — look, bearing, manner — and stating what they are to each other exactly as the party block says (e.g. "Liz, Biz's mother, ..."). Never invent a relationship that is not stated, and never a gender: use only the relation words and pronouns the party block gives, and where it says gender is not stated, use the name or "they" and words like kid or child. Do not narrate what anyone calls anyone — that shows in their own dialogue. Use the party members' exact names. If you show what someone is holding or carrying, show only what <items_on_hand> lists for them.`,
      `3. currentLocationName: copy one exact name from <places> if the party is at one of them, otherwise "".`,
      opts.inventories ? `PROPS: in the arrival, the narration and the introductions, a character holds, carries or was just holding only what <items_on_hand> lists for them — never invent a prop for them (a mug, a drink, a phone, a snack, a toy), not even one from the life they came from. Empty hands are fine.` : '',
      personalityReminder.trim(),
      `Respond as JSON: { "arrival": "${arrivalExpected ? '...' : ''}", "narration": "...", "introductions": [{ "name": "exact character name", "text": "..." }], "currentLocationName": "..." }`,
      `</task>`,
    ].filter(Boolean).join('\n');

    return callLlm({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      schema: DmOpeningSchema,
      maxTokens: 2048,
    });
  }

  async resolve(ctx: DmContext, action: string, diceResult: DiceResult | null, sceneNumber?: number, characterInfo?: { id: string; name: string; skills: Record<string, number>; stress: number; consequences: string[]; fatePoints: number; aspects?: string[]; highConcept?: string; trouble?: string; inventory?: string[]; partyMembers?: Array<{ id: string; name: string; takenOut?: boolean; inventory?: string[] }>; missingItems?: string[]; worldItems?: Array<{ name: string; heldBy?: string | null }>; goneItems?: string[]; eatenItems?: string[] }): Promise<DmResolution> {
    const ruleContext = this.lookupRules(ctx.systemId, action);

    const skillList = characterInfo ? Object.entries(characterInfo.skills).map(([k, v]) => `${k}:+${v}`).join(', ') : '';
    const diceBlock = diceResult
      ? `\nDice result: ${diceResult.description} (total: ${diceResult.total}). FATE resolution steps:
1. Pick the MOST relevant skill from the character's list${skillList ? ` (${skillList})` : ''}
2. Set difficulty using the FATE ladder: 0=Mediocre, 1=Average, 2=Fair, 3=Good, 4=Great, 5=Superb. DIFFICULTY FLOOR: difficulty MUST be >= the chosen skill rank minus 1. A +4 skill means minimum difficulty 3; a +3 skill means minimum difficulty 2. Easy victories kill drama — the story needs ties, costs, and failures. When in doubt, set difficulty EQUAL to the skill rank (50% chance of clean success). Only set difficulty below the floor for truly trivial actions that don't advance the plot.
3. Calculate effort = dice total (${diceResult.total}) + skill rank
4. Calculate shifts = effort - difficulty
5. Map shifts to outcome:
   - shifts >= 1: "success" (clear victory)
   - shifts == 0: "tie" (succeed but at a minor cost — you get what you want BUT something goes wrong too)
   - shifts == -1 or -2: "success-with-cost" (you can succeed BUT pay a heavy price — stress, a consequence, or a dangerous complication)
   - shifts <= -3: "failure" (you don't get what you want, and something bad happens)
IMPORTANT: "tie" and "success-with-cost" create the most interesting stories. A clean "success" should only happen when effort clearly exceeds difficulty. When in doubt between success and tie, choose tie.`
      : '';

    const consequenceGuide = (sceneNumber ?? 1) >= 4
      ? ' In Act III, failures should feel final and successes should resolve plot threads decisively.'
      : '';

    let charBlock = '';
    if (characterInfo) {
      const aspectList = [
        characterInfo.highConcept ? `High Concept: "${characterInfo.highConcept}"` : '',
        characterInfo.trouble ? `Trouble: "${characterInfo.trouble}"` : '',
        ...(characterInfo.aspects ?? []).map(a => `"${a}"`),
      ].filter(Boolean).join(', ');
      const inventoryLine = characterInfo.inventory && characterInfo.inventory.length > 0
        ? `\nInventory: ${characterInfo.inventory.join(', ')}`
        : '';
      charBlock = `\nACTING CHARACTER (narrate THEIR action, not another party member's): ${characterInfo.name} (id: ${characterInfo.id})\nAspects: ${aspectList}\nSkills: ${Object.entries(characterInfo.skills).map(([k, v]) => `${k}:+${v}`).join(', ')}\nStress: ${characterInfo.stress}/3 | Consequences: ${characterInfo.consequences.join(', ') || 'none'} | Fate Points: ${characterInfo.fatePoints}${inventoryLine}`;
      if (characterInfo.partyMembers && characterInfo.partyMembers.length > 0) {
        charBlock += `\nParty members: ${characterInfo.partyMembers.map(p => `${p.name} (id: ${p.id})${p.inventory && p.inventory.length > 0 ? ` carrying ${p.inventory.join(', ')}` : ''}${p.takenOut ? ' — TAKEN OUT, down and unable to act or speak' : ''}`).join(', ')}`;
      }
      charBlock += '\n';
    }

    const { systemPrompt, criticalReminder, narrationHint } = this.buildSystemPrompt(ctx);
    const personalityReminder = criticalReminder ? `\n\nPERSONALITY REQUIREMENT: ${criticalReminder}` : '';

    const recentTranscript = ctx.transcript.slice(-6).map(m => `[${m.role}] ${m.content}`).join('\n');
    const repetition = repetitionNotes(ctx.transcript.filter(m => m.role === 'dm').slice(-6).map(m => m.content));

    const userMessage = [
      charBlock ? `<character>\n${charBlock.trim()}\n</character>` : '',
      characterInfo ? itemsOnHandBlock([{ name: characterInfo.name, inventory: characterInfo.inventory }, ...(characterInfo.partyMembers ?? [])], { world: characterInfo.worldItems, gone: characterInfo.goneItems, eaten: characterInfo.eatenItems }) : '',
      characterInfo?.missingItems?.length ? itemsNotOnHandBlock(characterInfo.name, characterInfo.missingItems) : '',
      `\n<action>\n${characterInfo ? characterInfo.name : 'Character'}'s action: "${action}"${diceBlock}\n</action>`,
      ctx.worldSummary ? `\n<world>\n${ctx.worldSummary}\n</world>` : '',
      `\n<context>\n${recentTranscript}\n</context>`,
      repetition ? `\n<already_said>\n${repetition}\n</already_said>` : '',
      metNpcsBlock(ctx.metNpcs),
      ruleContext ? `\n<rules>\n${ruleContext}\n</rules>` : '',
      turnToneBlock(ctx),
      `\n<task>`,
      `Resolve ${characterInfo ? characterInfo.name + "'s" : 'this'} action using the FATE steps above. A wounded character (high stress, existing consequences) should face HIGHER difficulty (+1 per consequence). Apply meaningful state changes:`,
      `- "tie": minor cost (1 stress, or reveal information to an enemy, or lose time)`,
      `- "success-with-cost": serious cost (2 stress, or a new consequence like "Twisted Ankle" or "Shaken Confidence", or an NPC turns hostile)`,
      `- "failure": bad outcome (stress to max, a severe consequence, enemy gains advantage, or the situation gets worse)`,
      `Do NOT leave stateChanges empty on ties, costs, or failures — the mechanical cost IS the story.`,
      `NARRATION RULES: Write the result in THIRD PERSON using the ACTING CHARACTER's name (NOT another party member's name). NEVER echo the action text — not even paraphrased with "manages to" or "tries to" prepended. Instead, describe the CONSEQUENCES and WORLD REACTION: what changes in the environment, how NPCs respond, what the character sees/hears/feels. BAD: "Kael manages to swing his sword at the ghost." GOOD: "Kael's blade arcs through the spectral figure — it shrieks, recoiling into the shadows, but a chill crawls up Kael's sword arm where the ghost's essence grazed him." Start with the character's name, then show what HAPPENS, not what they ATTEMPTED. 2-3 vivid sentences.`,
      `NPC DIALOGUE: If the action involves talking to, questioning, persuading, or confronting an NPC, the narration MUST include the NPC's spoken response in quotation marks. NPCs who respond with actual words create real drama — "I'll tell you nothing, sellsword" hits harder than "the merchant refuses."`,
      `COOPERATIVE ACTIONS: If the action references a party member by name (coordinating, protecting, assisting), lower the difficulty by 1 and narrate how the teamwork helps. If the action HARMS or abandons a party member, add stress to BOTH characters — betrayal costs everyone.`,
      `PARTY DIALOGUE: If the action includes spoken words addressed to a companion (quoted dialogue), show a BRIEF physical reaction from that companion in your narration — a nod, a glare, a flinch, a skeptical eyebrow, a hand on their weapon. Do NOT put words in the companion's mouth (they speak on their own turn), but show they HEARD and REACTED. Dead-eyed companions who ignore each other kill immersion. A companion who is TAKEN OUT does not react, speak or act at all — they are down until they recover.`,
      `INVENTORY: If the character's inventory contains an item relevant to their action, acknowledge it in the narration and lower difficulty by 1. Items never go in stateChanges: every thing that changes hands, is picked up, dropped, eaten, used up or destroyed in your narration — this character's, a companion's or an NPC's — goes in "itemMoves". If the action takes, picks up, hands over or drops something and your ruling lets it happen, that is a move too.`,
      ITEM_MOVES_RULE,
      `FATE POINT ECONOMY: If this action touches the character's trouble aspect or a consequence, COMPEL it — add {"field":"fatePoints","action":"set","value":${(characterInfo?.fatePoints ?? 3) + 1}} and narrate the complication. If the character spent effort invoking an aspect (referenced it in their action), spend a fate point: {"field":"fatePoints","action":"set","value":${Math.max(0, (characterInfo?.fatePoints ?? 3) - 1)}}.${consequenceGuide}${personalityReminder}`,
      `Respond as JSON: { "diceExpression": "${diceResult?.expression ?? 'null'}", "difficulty": <number>, "skill": "<skill>", "outcome": "success|failure|tie|success-with-cost", "narration": "2-3 sentences describing what happens.${narrationHint}", "stateChanges": [{"characterId": "${characterInfo?.id ?? '<id>'}", "field": "stress|consequences|fatePoints", "action": "set|add|remove", "value": <value>}], "itemMoves": [{"item": "<exact name>", "from": "<who had it>", "to": "<who has it now>"}] }`,
      `stateChanges must be objects, not strings. Use [] if no mechanical changes apply.`,
      `</task>`,
    ].filter(Boolean).join('\n');

    return callLlm({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      schema: DmResolutionSchema,
      maxTokens: 1536,
      ...REPETITION_PENALTIES,
    });
  }

  async setupChat(opts: {
    preset: string;
    systemId: string;
    history: Array<{ role: string; content: string }>;
    unmet: string[];
    hostTableRole?: TableRole | null;
    /** The tone gate flagged the last reply (tone-gate.ts): the phrases, quoted, for one fresh try. */
    toneFeedback?: string;
  }): Promise<DmSetupReply> {
    const ruleContext = this.lookupRules(opts.systemId, 'setting tone genre campaign');
    const unmetBlock = opts.unmet.length > 0
      ? `\n\nStill missing before this game can open:\n${opts.unmet.map(u => `- ${u}`).join('\n')}\nWork these into the conversation naturally. Do not present them as a form.`
      : '';
    // The host may sit at the table as a player, and anything said in
    // `reply` has then been said to a player. Secrets belong in
    // dmCustomPrompt (the DM's private direction), never in the chat.
    const playingHost = opts.hostTableRole === 'player'
      ? `\nThe host is PLAYING in this game, not running it. Everything in "reply" is read by a player. Keep every secret out of it without exception.`
      : `\nThe host may end up playing in this game rather than running it, so treat "reply" as something a player will read.`;
    // Live: "No spoilers for me please, I'm playing in it too." — and the
    // next replies laid out the NPCs and the plot hook anyway. For a host
    // who plays or asked, the rule is spelled out for every reply.
    const strict = opts.hostTableRole === 'player' || wantsNoSpoilers(opts.history)
      ? `\n\nSPOILER-FREE HOST: this host ${opts.hostTableRole === 'player' ? 'is playing' : 'asked for no spoilers'}. This holds for EVERY reply in this conversation, not only the world you build. In "reply" you may ask about tone, themes, genre, content limits and influences, and confirm the premise in a sentence. You may NOT list or describe the NPCs you have in mind, their secrets or motives, the plot hooks, twists, or what will happen — not as a preview, a summary, a teaser or "here is what I'm thinking". If you have ideas for them, put them in dmCustomPrompt and say only that the rest will be discovered in play.`
      : '';
    const spoilerBlock = `

NO SPOILERS: You are building the DM's secrets, not sharing them. In "reply", never reveal a twist, a culprit, who is responsible for anything, a hidden motive, the answer to a mystery, or how the story will unfold. If the host asks a question the story itself should answer ("whose mistake brought us here?"), treat it as a hook you will plant, not a question to answer now: say it will be discovered in play. If the host says they do not want to know what will happen, honour that for the rest of the conversation. You MAY ask about tone, genre, content limits, influences, and what kind of mystery or danger they enjoy. Put the secret answers you invent in dmCustomPrompt only — that is never shown to players.${playingHost}${strict}`;

    const systemPrompt = `You are a TTRPG Dungeon Master helping set up a new game. Your base personality is "${opts.preset}".

Have a natural conversation with the game host to build their world with them:
1. What kind of adventure, setting, and tone they want
2. STYLISTIC INFLUENCES — at least three. Books, films, games, records, painters, anything. Ask what this world should FEEL like, and offer candidates drawn from what they have already told you. Three is the minimum because one is a costume and two is a comparison; three forces a specific intersection.
3. Any house rules or special requests

Be conversational and enthusiastic. Ask one or two questions at a time, never a checklist.
Accumulate every influence the host names into "influences" — return the full list every time, not just new ones.
When you have enough to build a world, set "done": true and fill in dmInstructions (a summary of how they want this run) and dmCustomPrompt (your tailored direction for running it).
Until then, set "done": false and leave dmInstructions/dmCustomPrompt null.
"reply" is only what you SAY to the host, in plain conversation. Never copy dmInstructions or dmCustomPrompt into it, and never lay out a field-by-field draft there (no "Plot Hook:", "Key NPCs:", "Current Situation:", "Secrets:" or "Twist:" headings) — the host sees the drafted world on its own card. You do not draft that card in this chat and cannot make it appear by saying so: the server drafts it after a reply with "done": true and dmInstructions, once three influences are recorded, and the host sees it arrive. Never say you have drafted a world or ask the host to review a world card.
PLAYER CHARACTERS: never give the host's player characters a gender the host has not stated — not in "reply", dmInstructions, dmCustomPrompt or anywhere else. Use the host's own relation words: if the host says "my kid Biz", write "her kid Biz" or "Biz", never "son", "daughter", "boy" or "girl"; if the host gave no pronouns for a character, use their name.${spoilerBlock}
${ruleContext ? `\nRules reference for their chosen system:\n${ruleContext}\n` : ''}${unmetBlock}

Respond as JSON: { "reply": "your message", "done": false, "influences": [], "dmInstructions": null, "dmCustomPrompt": null }${setupToneRule(opts.history)}${opts.toneFeedback?.trim() ? `\n\n<tone_feedback>\n${opts.toneFeedback.trim()}\n</tone_feedback>` : ''}`;

    // The greeting (no history yet) has a user turn of its own: Qwen's chat
    // template refuses a request without one, and live the greeting failed
    // with a 400 every time. Otherwise the host's latest message is anchored
    // (see anchorLatestHostMessage).
    const history = opts.history.length === 0
      ? [{ role: 'user', content: SETUP_GREETING_CUE }]
      : anchorLatestHostMessage(opts.history);
    const messages = [{ role: 'system', content: systemPrompt }, ...history];
    const first = await this.setupReply(messages);
    let reply = first;
    // Live (EV94GS, a no-spoiler host): four different host messages got the
    // same reply word for word, and no influence was ever recorded. A reply
    // identical to one already sent is never accepted: ask once more, naming
    // the host's latest message, and if it repeats again say something that
    // moves the setup on instead of sending it a fifth time.
    const sent = new Set(opts.history.filter(m => m.role === 'assistant').map(m => sameReplyKey(m.content)));
    if (sent.has(sameReplyKey(first.reply))) {
      const latest = [...opts.history].reverse().find(m => m.role === 'user')?.content ?? '';
      console.warn(`[dm-setup] reply repeats one already sent, word for word ("${first.reply.slice(0, 60)}"); asking again`);
      const retry = await this.setupReply([
        ...messages,
        { role: 'assistant', content: JSON.stringify(first) },
        { role: 'user', content: `${SETUP_REPEAT_NUDGE} The host's latest message was:\n"${latest}"\nAnswer THAT message: react to what it says, record anything it tells you (a premise, a tone, influences), and ask the next thing you need. Keep every secret out of "reply" as before. Respond with the JSON object only.` },
      ]).catch(e => { console.error('[dm-setup] retry after a repeated reply failed:', e); return null; });
      if (retry && !sent.has(sameReplyKey(retry.reply))) {
        reply = { ...retry, influences: [...(first.influences ?? []), ...(retry.influences ?? [])] };
      } else {
        console.warn('[dm-setup] the retry repeated itself too; replying with the next setup question instead');
        reply = { ...(retry ?? first), reply: nextSetupQuestion(opts.unmet) };
      }
    }
    // Influences the host named outright are recorded even when the model
    // leaves them out of "influences".
    const named = opts.history.filter(m => m.role === 'user').flatMap(m => influencesNamedIn(m.content));
    if (named.length > 0) {
      const all = [...(reply.influences ?? []), ...named];
      const seen = new Set<string>();
      reply = { ...reply, influences: all.filter(i => { const k = influenceKey(i); if (!k || seen.has(k)) return false; seen.add(k); return true; }) };
    }
    return reply;
  }

  private setupReply(messages: Array<{ role: string; content: string }>): Promise<DmSetupReply> {
    return callLlm({
      messages,
      schema: DmSetupReplySchema,
      // Left unset, this fell through to the proxy's own default and was
      // observed truncating mid-sentence — the same class of bug already
      // fixed on draftWorldSeed's neighbouring call below. A "done" reply is
      // the heavy case: `reply` (a conversational paragraph) PLUS
      // dmInstructions (a summary of the whole setup conversation) PLUS
      // dmCustomPrompt (the DM's own tailored running direction) — two full
      // paragraphs beyond the chat reply itself, not just a short
      // conversational turn. A truncated dmInstructions/dmCustomPrompt here
      // desyncs the readiness panel from what the DM actually said and can
      // corrupt the direction the rest of the campaign runs on, so this
      // needs real headroom, not the ordinary chat-turn budget.
      maxTokens: 2048,
    });
  }

  /**
   * Turn the setup conversation into a starting world. The host reviews this
   * before anyone plays, so err toward concrete and specific — a place with a
   * name and a problem beats a genre.
   */
  async draftWorldSeed(opts: {
    preset: string;
    systemId: string;
    influences: string[];
    dmInstructions: string;
    history: Array<{ role: string; content: string }>;
    existing: WorldSeed | null;
    /** The host asked for gentle peril: the premise, NPCs and hooks are drafted in the register too. */
    gentlePeril?: boolean;
  }): Promise<WorldSeed> {
    const transcript = opts.history.map(m => `[${m.role}] ${m.content}`).join('\n');
    // Round 14 (7RAAQ7): Button's pronouns were it/its and its description
    // said "no one remembers hiring them". A redraft keeps each NPC's
    // pronouns, stated as fixed.
    const locked = opts.existing ? seedNpcPronouns(opts.existing.npcs ?? []) : [];
    const lockedBlock = locked.length > 0
      ? `\n\nNPC pronouns — fixed (keep them for any NPC you keep, and write their descriptions in them):\n${locked.map(n => `- ${n.name}: ${n.pronouns}`).join('\n')}`
      : '';
    const existingBlock = opts.existing
      ? `\n\nYou previously drafted this world. Revise it — keep what works, change what the conversation asks for:\n${JSON.stringify(opts.existing, null, 2)}${lockedBlock}`
      : '';

    const systemPrompt = `You are a world builder for a TTRPG. You output ONLY JSON. No prose, no roleplay, no markdown.

Build a starting world from the host's setup conversation.

Stylistic influences to honour (these shape VOICE and texture, not plot): ${opts.influences.join(' × ')}

Requirements:
- premise: one or two sentences naming the situation the players arrive into
- locations: at least 3, each with a name, a concrete description, and a terrain word
- npcs: at least 3, each with a name, a description, a disposition, and a motivation that could put them in someone's way; and "pronouns" — how the story refers to them ("she/her", "he/him", "they/them", "it/its"), used for the whole game. Every sentence of the description, disposition and motivation refers to that NPC with exactly those pronouns: an it/its NPC is "it" and "its" throughout ("no one remembers hiring it", never "hiring them"); a she/her NPC is never "it".
- plotHooks: at least 3 unresolved situations, phrased as things that are already happening
- items: 0 or more notable objects

Make places and people specific enough to walk into. Avoid generic fantasy furniture unless the influences call for it.

PLAYER CHARACTERS: never give the host's player characters a gender the host has not stated — not in the premise or anywhere else in this world. Use the host's own relation words: if the host says "my kid Biz", write "her kid Biz" or "Biz", never "son", "daughter", "boy" or "girl"; if the host gave no pronouns for a character, use their name.

NO SPOILERS: The host reads every field of this world on a card before play — the premise, the location and NPC descriptions, dispositions and motivations, the plotHooks and the items — and the host may be playing. None of it may reveal or hint at a twist, a culprit, who is responsible for anything, who is behind anything, a hidden motive, or the answer to a mystery. Not even obliquely: no "rumors hint at a deliberate cover-up", no "someone wants the truth buried", no "it was no accident". Motivations say what an NPC openly wants; plotHooks say what is happening on the surface, as open questions. If the conversation asks something the story should answer ("whose mistake brought us here?"), leave it an open question — the answers belong to the DM's private direction, never to this world.

${opts.gentlePeril ? `${childToneRule([], { gentlePeril: true })} This holds for the premise, every NPC's motivation and every plot hook: they are the dangers the story will be made of.\n\n` : ''}Return ONLY: {"premise":"...","locations":[{"name":"...","description":"...","terrain":"..."}],"npcs":[{"name":"...","description":"...","disposition":"...","motivation":"...","pronouns":"..."}],"plotHooks":["..."],"items":[{"name":"...","description":"..."}]}`;

    return callLlm({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Setup conversation:\n${transcript}\n\nDM direction: ${opts.dmInstructions}${existingBlock}\n\nBuild the world.` },
      ],
      schema: WorldSeedSchema,
      temperature: 0.8,
      // This is the largest structured payload any prompt in this file produces —
      // it needs the highest ceiling, not a copied one. The schema requires a premise
      // plus at least 3 locations (name/description/terrain), 3 npcs
      // (name/description/disposition/motivation), 3 plotHooks, and 0+ items, but the
      // model routinely returns more than the minimum. A realistic generous draft —
      // 6 locations, 6 npcs, 6 hooks, 4 items, each with a few sentences of prose —
      // runs to roughly 1,500-2,000 tokens of JSON including field-name/quote/brace
      // overhead. 2048 (setupChat's neighbour, `resolve`, uses this) would leave the
      // response with almost no headroom and risks the exact mid-`npcs`/`plotHooks`
      // truncation this fix exists to stop. 4096 gives ~2x headroom above the
      // generous estimate so a verbose model still finishes inside the ceiling.
      maxTokens: 4096,
    });
  }

  /**
   * The player's first sight of the world. Written in the fiction, not as a
   * briefing — they should want to be somewhere in it before they are asked
   * who they are. Keep the influences in the prose and out of the content.
   */
  async introduceWorld(opts: { preset: string; influences: string[]; seed: WorldSeed; /** The host asked for gentle peril: the register holds from the first sight of the world. */ gentlePeril?: boolean; /** The tone gate's feedback on the last draft (tone-gate.ts). */ toneFeedback?: string }): Promise<string> {
    // Plot hooks (and NPC motivations) are DM secrets and are deliberately
    // not given to this prompt: whatever it knows, the player may read.
    const places = opts.seed.locations.slice(0, 4).map(l => `${l.name}: ${l.description}`).join('\n');
    const npcs = opts.seed.npcs.slice(0, 4);
    const pronouns = seedNpcPronouns(npcs);
    const people = npcs.map(n => {
      const p = pronouns.find(x => x.name === n.name)?.pronouns;
      return `${n.name}${p ? ` (${p})` : ''}: ${n.description}`;
    }).join('\n');
    // Live (7MJXE5): Barnaby's seed said it/its and both players' first
    // sight of the world said "his oversized briefcase… He looks you in the eye".
    const pronounRule = npcPronounBlock(pronouns);
    const toneRule = opts.gentlePeril ? `\n\n${childToneRule([], { gentlePeril: true })}` : '';
    const feedback = opts.toneFeedback?.trim() ? `\n\n${opts.toneFeedback.trim()}` : '';

    const systemPrompt = `You are a TTRPG Dungeon Master ("${opts.preset}" style) introducing a player to a world they are about to make a character for.

Write 120-180 words of second-person present tense. Put them somewhere specific and let them look around. Name real places and real people from the world below. End on something unresolved — a question the world is already asking — without answering it or hinting at who is behind it.

NO SPOILERS: the reader may be the one who has to solve this world's mystery. Never reveal or hint at a twist, a culprit, who is responsible, who is behind anything, a hidden motive, or the answer to any mystery — not even as rumors that hint at a cover-up, a conspiracy or a deliberate act. The open question stays an open question.

Do NOT explain the setting, list factions, or describe mechanics. Do not tell them who their character is; that is the next conversation. Never describe the reader's body or their companion's — no bare skin, no state of dress (7RAAQ7: "You and your companion stand bare-chested"): a missing lanyard is a missing lanyard. No headings, no bullet points, no preamble — just the prose.

${opts.influences.length > 0 ? `Stylistic influences to honour in voice and texture only: ${opts.influences.join(' × ')}\n\n` : ''}Premise: ${opts.seed.premise}

Places:
${places}

People:
${people}${pronounRule ? `\n\n${pronounRule}` : ''}${toneRule}${feedback}`;

    return callProse({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Introduce them to this world.' },
      ],
      temperature: 0.9,
      // The first prose a player reads about the world, seen cut off live
      // twice ("...before midnight doubles the", "...twirls a feathered hat
      // that blushes"). The model behind the proxy is a reasoning model and
      // its hidden reasoning spends this same budget before a word of the
      // 120-180 word (~250 token) reply is written, so 1024 left too little.
      // 3072 leaves ~2.5k for reasoning plus 2x output overshoot; callProse
      // retries a cut-off reply at double that and never returns half a
      // sentence.
      maxTokens: 3072,
    });
  }

  async interviewForCharacter(opts: {
    systemId: string;
    preset: string;
    playerName: string;
    influences: string[];
    seed: WorldSeed | null;
    history: Array<{ role: string; content: string }>;
    unmet: string[];
    /** Characters already at this table (live, awaiting approval, or being made by another player). */
    tableCharacters?: Array<{ name: string; highConcept: string; pronouns?: string | null }>;
  }): Promise<CharInterviewReply> {
    const ruleContext = this.lookupRules(opts.systemId, 'character creation aspects skills stunts');
    // No plot hooks: whatever this prompt knows can end up in the player's
    // backstory, and from there in the character agent's prompt every turn.
    const tableCharacters = (opts.tableCharacters ?? []).filter(c => c.name.trim());
    const tableBlock = tableCharacters.length > 0
      ? `\nAlready at this table (other players' characters):\n${tableCharacters.map(c => `- ${c.name}${c.highConcept ? `: ${c.highConcept}` : ''} — ${c.pronouns?.trim() ? `pronouns ${c.pronouns.trim()}${neutralPronouns(c.pronouns) ? ` — ${neutralNounRule(c.name, c.pronouns)}` : ''}` : `pronouns NOT known to you: call ${c.name} by name, never he/him/his or she/her, and never "son", "daughter", "boy" or "girl"`}`).join('\n')}\nWhen you talk about one of these people, use only the pronouns listed for them; where none are listed, use their name every time ("Biz is your kid, and Biz calls you Mom" — never "she calls you Mom"). The same holds in the sheet you write — the personality, backstory, aspects and trouble: a person listed here keeps their own pronouns there too, whatever this character's are (Liz listed as she/her: a they/them kid is "afraid of losing her", never "afraid of losing them"). Use the relation word the player used ("kid" stays "kid").\nThis character will be playing alongside them. Once you know who this character is, ask — as one of your questions, in plain words — whether they know any of these people and how: family, friends, rivals, strangers? And what do they call each other ("Mom", a nickname, a title, a first name)? Strangers are a fine answer; do not push a connection the player does not want. When your reply mentions one of these people, call them by their name ("Liz") — never a relation word stacked on the name ("Mom Liz", "traveling with Mom Liz"): an address term like "Mom" is only what this character says to them, inside their own words.\n`
      : '';
    const worldBlock = opts.seed
      ? `\nThe world they are joining:\nPremise: ${opts.seed.premise}\nPlaces: ${opts.seed.locations.slice(0, 5).map(l => l.name).join(', ')}\nPeople: ${opts.seed.npcs.slice(0, 5).map(n => { const p = seedNpcPronouns([n])[0]?.pronouns; return `${n.name} (${[p, publicDisposition(n.disposition) ?? 'unknown'].filter(Boolean).join(', ')})`; }).join(', ')}\n${npcPronounBlock(seedNpcPronouns(opts.seed.npcs.slice(0, 5)))}\n`
      : '';
    const unmetBlock = opts.unmet.length > 0
      ? `\nStill needed for their sheet:\n${opts.unmet.map(u => `- ${u}`).join('\n')}\nEvery reply asks about at least one of these — the way a person would, one or two at a time.\n`
      : '';

    const systemPrompt = `You are a character creation API for a TTRPG. You help a player named ${opts.playerName} build a character through conversation, for a world that already exists.

THIS IS CHARACTER CREATION, NOT PLAY. The game has not started and nothing is happening to the character yet. The first message in this conversation may be a short look at the world written as a scene — that was a preview, not the start of play. Never write as if play has begun: never "You stand in…", never narrate what happens next, never end on "What do you do?" or "what catches your attention?". Every question is ABOUT the character, and reads that way — say "your character", or their name once you know it.

Ask a MIX of two kinds of question, and lead with the second kind:

DIRECT — the plain thing, when you need a specific field. "What do we call them?"

INDIRECT — imagine the character in a real place from the world below and ask what they WOULD do, notice, or want there. "Picture your character on the tidal stair as the water comes up — what would make them stop?" It is a hypothetical about who they are, not a scene they are in. Never ask for a game term this way. Infer aspects, skills and a trouble from how they answer, and reflect what you inferred back in plain language so they can correct you.

PRONOUNS — early on, as soon as you know their name, ask how the character should be referred to: she/her, he/him, they/them, or something else. One plain, friendly question, asked once. Until the player answers, never call the character he, him, his, she or her — not in your reply (including the very message that asks: "what would catch Liz's attention?" or "their attention", never "her attention") and not anywhere in the sheet: use their name, or "they".

Open indirect. Use direct questions only to close the gaps listed below. Never present a checklist, never ask for more than two things at once, and never use the words "high concept", "aspect" or "stunt" in a question — describe what you mean instead.

Aim them at characters with INTERNAL TENSION: a clear strength and a clear vulnerability. The trouble should create genuine dilemmas, not minor inconveniences, and it should have somewhere to bite in THIS world.

If age matters to who they are — especially if they are a child or elderly — find out roughly how old they are.
${worldBlock}${tableBlock}${unmetBlock}${ruleContext ? `\nRules reference:\n${ruleContext}\n` : ''}

CRITICAL: respond with ONLY a JSON object. No asterisks, no roleplay actions, no narration outside the JSON.

Every reply carries the sheet as it stands so far, finished or not: {"reply": "your next question, or what you understand about them in plain language", "definition": {"name":"...","highConcept":"...","trouble":"...","aspects":["..."],"personality":"...","backstory":"...","skills":{"Skill":3},"stunts":["..."],"age":null,"pronouns":null,"relationships":[]}}
Fill in every field the player has stated or you have inferred and reflected back; leave the rest empty ("", [], {}). When the player states something outright — a name, what they are, what trouble dogs them, something they can do — record it in the sheet at once, in their words lightly tidied, and do not ask for it again. Include everything from earlier turns too, not just what changed. Only when you know nothing yet may "definition" be null.

Each stunt is its name AND what it does, in one string ("Tiny and Quick — can squeeze through gaps grown-ups cannot fit through"), keeping the description the player gave — never just the name.
"age" is a number or short phrase if you know it, else null. "pronouns" is how this character is referred to ("she/her", "he/him", "they/them", or the player's own words) — fill it only with what the player told you when asked, or said outright about pronouns; otherwise null. Do not work it out from a gendered word ("mom", "boy") — ask instead. Never assume a gender from a name, an age, a role or anything else, and until "pronouns" is filled, no field of the sheet (high concept, trouble, aspects, stunts, personality, backstory) may call the character he, him, his, she or her — write "Fast on their feet", not "Fast on his feet". "relationships" lists people this character has a stated tie to — each {"to":"their exact name","relation":"what that person is TO THIS CHARACTER","address":"what this character calls them"}. Example: a kid whose mother Liz is at the table gets {"to":"Liz","relation":"mother","address":"Mom"}. Use the player's own relation word: "my kid Biz" is "kid", not "son" — never assume a gender. Fill it from what the player told you — including anything the backstory states, such as "her kid Biz" or "Biz and Mom" — and never invent ties the player did not state. Leave it [] if there are none.
SOMEONE ELSE IN THE SHEET: the personality, backstory, aspects and trouble are about this character, but when they mention someone this character is tied to, that person keeps their OWN pronouns — the ones listed for them at the table, or else the ones the player's relation word gives them ("Mom", "mother" → she/her; "Dad" → he/him) — never this character's. A they/them kid whose mom is Liz is "afraid of losing her" or "afraid of losing Mom", never "afraid of losing them". When in doubt, use the person's name or the player's word for them.`;

    const messages = [{ role: 'system', content: systemPrompt }, ...opts.history];
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') {
      messages[messages.length - 1] = { ...last, content: `${last.content}\n\n(Remember: respond with ONLY a JSON object, no other text)` };
    }

    return callLlm({
      messages,
      schema: CharInterviewReplySchema,
      temperature: 0.5,
      // A reply plus a whole draft sheet, after reasoning over a long system
      // prompt (world, table, rules). The 2048 default was seen cutting the
      // reply mid-sentence ("...You glance toward"), and JSON repair then
      // closed it without the definition, so nothing the player said landed.
      // callLlm also retries a cut-off JSON reply once at double this.
      maxTokens: 4096,
    });
  }

  /**
   * By the time this runs, the server's own checkCharacterReadiness has
   * already required a name, a high concept, a trouble, at least 2 aspects,
   * at least 1 rated skill, and at least 1 stunt — the exact six things an
   * earlier version of this prompt asked the model to re-check. That made
   * the model's approval a foregone conclusion: it could not fail criteria
   * it was never actually the gate for. Its real job is a judgment call the
   * server's structural check cannot make — does this character fit the
   * world and rules system this table is running — plus the feedback
   * sentence and any modifications it wants to propose.
   */
  async validateCharacter(definition: CharacterDefinition, systemId: string): Promise<CharacterValidation> {
    const ruleContext = this.lookupRules(systemId, 'character creation skills aspects');

    return callLlm({
      messages: [
        { role: 'system', content: `You are a character sheet validation API. You output ONLY JSON. No roleplay, no asterisks, no prose.${ruleContext ? `\n\nRules reference:\n${ruleContext}` : ''}\n\nThis sheet has already passed the game's own required-fields check AND its mechanical/structural validation — every field is present, and every numeric or structural rule this system defines (skill ranks, point totals, refresh, pyramid shape, or anything else along those lines) has already been checked and enforced by the server before this ever reached you. Do NOT re-check, re-litigate, or invent any mechanical or structural rule of your own — including ones that sound plausible but appear nowhere above, like a "refresh" field or a "standard" skill-point limit. If a rule is not stated in the reference above, it is not yours to enforce. Your ONLY job is a judgment call the server cannot make: does this character actually FIT the world this campaign is running and its tone — do the concept, trouble, personality, and backstory read as belonging at this table, or as dropped in from somewhere else entirely? Reject only for a genuine world-fit or tone problem, never a mechanical one and never a matter of taste. If a small tweak would fix it, propose that in modifications instead of rejecting outright.` },
        { role: 'user', content: `Validate:\n${JSON.stringify(definition, null, 2)}\n\nRespond as JSON: {"approved": <your judgement, true or false>, "feedback": "one sentence explaining it", "modifications": null, or an object with only the fields you want changed}` },
      ],
      schema: CharacterValidationSchema,
      temperature: 0.2,
    });
  }

  /** `pronounNote`: everyone's pronouns (castPronounLine) — a summary is read back into every later prompt. */
  async summarizeScene(transcript: TranscriptMessage[], characterNames?: string[], worldState?: string, pronounNote?: string): Promise<string> {
    const text = transcript.map(m => `[${m.role}] ${m.content}`).join('\n');
    const charHint = characterNames && characterNames.length > 0
      ? ` For each character (${characterNames.join(', ')}), note their last action and current situation.`
      : '';
    const worldHint = worldState
      ? `\n\nThe world bible already tracks these facts (do NOT repeat them — focus on narrative, character emotions, and unresolved tension instead):\n${worldState}`
      : '';
    const hasRecap = transcript.some(m => m.content.startsWith('[Session recap]') || m.content.startsWith('[Previous scene]'));
    const compactionHint = hasRecap
      ? '\nIMPORTANT: The transcript begins with a prior recap or scene summary. Preserve ALL named characters, NPCs, locations, and plot threads from it. Add new developments from recent events. Do not lose earlier details.'
      : '';

    const whisperHint = this.buildWhisperSummaryHint(transcript);

    const namesRule = ` Call every character by their name. A word one character calls another ("Mom", a nickname) belongs only inside that character's quoted speech, never in your own sentences.${pronounNote ? ` ${pronounNote}` : ''}`;
    try {
      const result = await callLlm({
        messages: [
          { role: 'system', content: `You are a JSON API. Summarize TTRPG scenes. Output ONLY a JSON object.${namesRule}` },
          { role: 'user', content: `${text}\n\nSummarize in 3-5 sentences. Cover: what happened, who was involved, what changed, and what's unresolved.${charHint}${compactionHint}${whisperHint}${worldHint} Include any NPC reactions, items found, or locations visited. End with a TRANSITION HOOK — one sentence that creates urgency for the next scene (a sound in the distance, a ticking clock, a choice that can't wait, an NPC who just left with a secret).\n\nRespond as JSON: {"summary": "your summary here"}` },
        ],
        schema: SceneSummarySchema,
      });
      return result.summary;
    } catch {
      const plainText = await callProse({
        messages: [
          { role: 'system', content: `Summarize this TTRPG scene in 3-5 sentences. Plain text only, no JSON.${namesRule}` },
          { role: 'user', content: `${text}\n\nCover: what happened, who was involved, what changed.${charHint}` },
        ],
        // 3-5 sentences (~200 tokens) after reasoning over a whole scene's
        // transcript: 512 left the reasoning model almost nothing to write with.
        maxTokens: 2048,
      });
      return plainText.trim() || 'The scene draws to a close.';
    }
  }

  private buildWhisperSummaryHint(transcript: TranscriptMessage[]): string {
    const whisperMsgs = transcript.filter(m => m.role === 'system' && /\b(heeded|resisted|partially heeded) the whisper\b/.test(m.content));
    if (whisperMsgs.length === 0) return '';

    const stats = new Map<string, { followed: number; partial: number; ignored: number; lastTrust: number }>();
    for (const m of whisperMsgs) {
      const nameMatch = m.content.match(/^(?:\[)?(\S+)/);
      const name = nameMatch?.[1] ?? 'unknown';
      const trustMatch = m.content.match(/trust:\s*([\d.]+)/);
      const trust = trustMatch ? parseFloat(trustMatch[1]!) : 0.5;
      if (!stats.has(name)) stats.set(name, { followed: 0, partial: 0, ignored: 0, lastTrust: trust });
      const s = stats.get(name)!;
      s.lastTrust = trust;
      if (m.content.includes('heeded the whisper') && !m.content.includes('partially')) s.followed++;
      else if (m.content.includes('partially heeded')) s.partial++;
      else if (m.content.includes('resisted the whisper')) s.ignored++;
    }

    const lines: string[] = [];
    for (const [name, s] of stats) {
      const total = s.followed + s.partial + s.ignored;
      const trustWord = s.lastTrust >= 0.7 ? 'trusting' : s.lastTrust >= 0.4 ? 'wary' : 'distrustful';
      lines.push(`${name}: ${s.followed}/${total} whispers followed, ${trustWord} (trust ${s.lastTrust.toFixed(2)})`);
    }
    return `\nWhisper influence (preserve this): ${lines.join('; ')}.`;
  }

  private buildSystemPrompt(ctx: DmContext): { systemPrompt: string; criticalReminder: string; narrationHint: string } {
    const campaignMaterials = this.lookupRules(`campaign:${ctx.campaignId}`, ctx.transcript.slice(-5).map(m => m.content).join(' '));
    return assembleSystemPrompt({
      preset: ctx.preset,
      dmCustomPrompt: ctx.dmCustomPrompt,
      houseRules: ctx.houseRules,
      dmInstructions: ctx.dmInstructions,
      campaignMaterials: campaignMaterials || null,
      influences: ctx.influences,
      party: ctx.party,
      gentlePeril: ctx.gentlePeril,
    });
  }

  private buildTroubleHint(charSummaries: string): string {
    const troubles: string[] = [];
    for (const line of charSummaries.split('\n')) {
      const match = line.match(/^([^:]+):.+\(trouble: "([^"]+)"\)/);
      if (match) troubles.push(`${match[1]}'s trouble is "${match[2]}"`);
    }
    if (troubles.length === 0) return '';
    const target = troubles[Math.floor(Math.random() * troubles.length)]!;
    return `\nCOMPEL OPPORTUNITY: ${target}. Create a situation THIS narration that directly confronts this trouble — a person from their past, a temptation that exploits their flaw, or a dilemma where their weakness is the path of least resistance. The best compels feel inevitable, not forced.`;
  }

  /**
   * Returns '' — never a sentinel string — when the system has no ingested
   * rules. A fabricated placeholder like '(No rules found for this query)'
   * interpolated into a prompt reads to the model as content, not as an
   * absence; every call site below must be able to omit its "Rules
   * reference" section entirely instead. Task 7 Step 4's campaign-creation
   * notice (src/server/index.ts) only tells the HOST once, at creation —
   * this is what stops the same leak from reaching every setup reply,
   * character interview, validation, and action resolution for the rest of
   * the campaign.
   */
  private lookupRules(systemId: string, query: string): string {
    const chunks = searchRules(this.db, systemId, query, 3);
    if (chunks.length === 0) return '';
    return chunks.map((c: RuleChunk) => `[${c.section}] ${c.content}`).join('\n\n');
  }
}
