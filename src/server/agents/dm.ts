import { readFileSync } from 'node:fs';
import { callLlm, callProse } from './llm-client.js';
import { DmNarrationSchema, DmResolutionSchema, CharacterValidationSchema, SceneSummarySchema, DmSetupReplySchema, CharInterviewReplySchema, WorldSeedSchema, DmOpeningSchema } from './schemas.js';
import type { DmNarration, DmResolution, CharacterValidation, DmSetupReply, CharInterviewReply, DmOpening } from './schemas.js';
import { searchRules, type RuleChunk } from '../rag/search.js';
import { PLAIN_PROSE_STYLE } from './style.js';
import { safeDataFile } from '../data-paths.js';
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
  return [
    'THE PARTY — the player characters actually at this table (authoritative). Any other player-character names that came up while setting the game up were placeholders: those people are not in this game and must never appear as party members.',
    ...lines,
    hasAges ? 'Characters act their stated ages — a child thinks, talks and is treated like a child.' : '',
    anyUnstated ? 'Never guess a gender this block does not state — not from a name, an age, or the other side of a relation (a mother\'s child is not therefore a son). Where it is not stated, use the character\'s name or "they", and gender-neutral words for them: kid, child, parent, sibling — never son, daughter, boy, girl, he or she.' : '',
    'Characters address each other the way they naturally would — a child calls their mother "Mom", not by her first name.',
    hasAddress ? 'Address terms are personal to the relationship: a term like "Mom" is what one character calls another, never that person\'s name. Only that character uses it, and only in their own dialogue; NPCs and everyone else use the name. Narration uses names too.' : '',
  ].filter(Boolean).join('\n');
}

/** How to refer to a party member, as far as the sheets say: "she/her", the player's own words, or null (not stated). */
export function pronounsFor(member: PartyMember, party: PartyMember[]): string | null {
  if (member.pronouns?.trim()) return member.pronouns.trim();
  const g = statedGender(member, party);
  return g === 'f' ? 'she/her' : g === 'm' ? 'he/him' : g === 'n' ? 'they/them' : null;
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
  const sentences = text.split(/(?<=[.!?])\s+/);
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
  /** The live party. When present, it is stated as authoritative and setup-invented PCs are dropped from the direction. */
  party?: PartyMember[];
}): { systemPrompt: string; criticalReminder: string; narrationHint: string } {
  const sections = composePresetSections(input.preset);
  const partyNames = (input.party ?? []).map(p => p.name);
  const dmCustomPrompt = withoutPlaceholderParty(input.dmCustomPrompt, partyNames);
  const dmInstructions = withoutPlaceholderParty(input.dmInstructions, partyNames);
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
- WHISPER AWARENESS: Characters hear a mysterious voice (the player's whispers). When the transcript shows a character heeded or resisted a whisper, weave that into the narrative. A character following dangerous whispers might attract dark attention; one resisting wise counsel might face harder consequences. The whisper influence is the game's central tension — make it matter in the story.
- CREATE WHISPER MOMENTS: At least once per scene, present a situation where the "right" choice is ambiguous — a locked door that could be forced or bypassed, a suspicious ally, a tempting shortcut through danger. These fork-in-the-road moments give the player interesting whisper decisions. The player is the character's conscience, and the best stories emerge when conscience is tested.
- USE ITEMS BY EXACT NAME: If the world state lists "Unclaimed items" or "Items you could pick up," use their EXACT names in your narration (e.g. "the Crystal Shard" not "a crystal," "Sparks' Blueprint" not "a map"). Describe a character spotting the item, an NPC offering it, or a situation where it would be useful. When resolving actions, if a character's inventory contains a relevant item, acknowledge it BY NAME and grant a narrative advantage. Items are plot hooks — "Sparks' Blueprint" hints at a secret passage, "the Gala Invitation" proves identity, "the Clockwork Lockpick" opens doors. Named items connect to the game's tracking system — paraphrased items get lost.
`;

  if (input.houseRules) prompt += `\nHouse rules: ${input.houseRules}\n`;
  if (dmInstructions) prompt += `\nDM direction: ${dmInstructions}\n`;
  const partyBlock = describeParty(input.party ?? []);
  if (partyBlock) prompt += `\n${partyBlock}\n`;

  if (input.campaignMaterials) {
    prompt += `\nCampaign reference materials:\n${input.campaignMaterials}\n`;
  }

  if (criticalSection) prompt += criticalSection;
  prompt += `\nAlways respond with valid JSON matching the requested format. Never fabricate dice rolls — use only rolls provided to you. ${PLAIN_PROSE_STYLE}`;
  return { systemPrompt: prompt, criticalReminder: criticalSection.trim(), narrationHint };
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
  /** The narration-only opening (arrival + introductions) has just been delivered; this is the first real beat of play. */
  afterOpening?: boolean;
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

    const userMessage = [
      `<scene>`,
      sceneLabel,
      `Session arc: ${sessionArc}`,
      `Pacing: ${pacingHint}${locationHint}${troubleHint}`,
      `</scene>`,
      charBlock ? `\n<party>\n${charBlock.trim()}\n</party>` : '',
      `\n<world>\n${ctx.worldSummary}\n</world>`,
      locationList,
      `\n<transcript>\n${recentTranscript}\n</transcript>`,
      `\n<task>`,
      `Narrate what happens next in 2-4 vivid sentences. Describe ONE moment, not multiple rounds. VARY YOUR OPENING — don't start with the character's name every time. Try starting with: a sound, an NPC speaking, a sensory detail, a shift in the environment, or an action in progress. If UNRESOLVED THREADS appear in the world state, let them echo in the background — an overheard rumor, a shadow of the unfinished business, a ticking clock. Don't resolve them in narration, but keep them alive.\nNPC INITIATIVE: If activeNpcs are present, at least one NPC must SPEAK or ACT in the narration — they approach the party, ask a question, block a path, offer information, make a demand, or reveal something. "The foreman steps from the shadows, voice hoarse: 'You shouldn't be down here.'" NPCs who initiate create drama the characters MUST respond to.${partyHint}`,
      `currentLocationName MUST be COPIED EXACTLY from the <valid_locations> list above. NEVER invent a new location name. If no <valid_locations> section exists, you may introduce a new name.${personalityReminder}`,
      `Respond as JSON: { "narration": "2-4 vivid sentences.${narrationHint}", "currentLocationName": "...", "activeNpcs": ["name1", ...], "isSceneEnd": true|false }`,
      `</task>`,
    ].filter(Boolean).join('\n');

    return callLlm({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      schema: DmNarrationSchema,
      maxTokens: 2048,
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
      `\n<task>`,
      arrivalExpected
        ? `0. arrival: REQUIRED — 1-2 sentences of the moment of arrival itself, happening to ${names}: the lurch or fall or flash, landing or waking up here, blinking, disoriented, realising a moment ago they were somewhere else entirely. This is about THEM, not the place — it must never be scenery alone. The narration below picks up right after it.`
        : `0. arrival: "".`,
      opts.scenarioOpening
        ? `1. narration: "" (the scene is already set).`
        : `1. narration: 3-5 vivid sentences told from the characters' point of view, at the exact moment the premise puts them here. Read the premise and where they come from: if they have just been transported, summoned, isekaied, shipwrecked or otherwise pulled out of their old lives, this scene IS their arrival — the moment they land or wake up here, disoriented, the strangeness of this world hitting people who have never seen it before. If they already belong here, open on them as the situation begins. Show the place as it lands on THEM — not just scenery or a description of the place with nobody in it. Establish ONLY what the characters would perceive right now. Do NOT reveal secrets, hidden motives, twists, who is behind anything, or the answer to any mystery. Do not have anyone demand an item, fact or task the party has never been given. Do not make the characters act, speak or decide — they do that themselves once play begins.`,
      `2. introductions: one per party member, 1-2 sentences each, describing that character as the others would see them on first glance — look, bearing, manner — and stating what they are to each other exactly as the party block says (e.g. "Liz, Biz's mother, ..."). Never invent a relationship that is not stated, and never a gender: use only the relation words and pronouns the party block gives, and where it says gender is not stated, use the name or "they" and words like kid or child. Do not narrate what anyone calls anyone — that shows in their own dialogue. Use the party members' exact names.`,
      `3. currentLocationName: copy one exact name from <places> if the party is at one of them, otherwise "".${personalityReminder}`,
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

  async resolve(ctx: DmContext, action: string, diceResult: DiceResult | null, sceneNumber?: number, characterInfo?: { id: string; name: string; skills: Record<string, number>; stress: number; consequences: string[]; fatePoints: number; aspects?: string[]; highConcept?: string; trouble?: string; inventory?: string[]; partyMembers?: Array<{ id: string; name: string; takenOut?: boolean }> }): Promise<DmResolution> {
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
        charBlock += `\nParty members: ${characterInfo.partyMembers.map(p => `${p.name} (id: ${p.id})${p.takenOut ? ' — TAKEN OUT, down and unable to act or speak' : ''}`).join(', ')}`;
      }
      charBlock += '\n';
    }

    const { systemPrompt, criticalReminder, narrationHint } = this.buildSystemPrompt(ctx);
    const personalityReminder = criticalReminder ? `\n\nPERSONALITY REQUIREMENT: ${criticalReminder}` : '';

    const recentTranscript = ctx.transcript.slice(-6).map(m => `[${m.role}] ${m.content}`).join('\n');

    const userMessage = [
      charBlock ? `<character>\n${charBlock.trim()}\n</character>` : '',
      `\n<action>\n${characterInfo ? characterInfo.name : 'Character'}'s action: "${action}"${diceBlock}\n</action>`,
      ctx.worldSummary ? `\n<world>\n${ctx.worldSummary}\n</world>` : '',
      `\n<context>\n${recentTranscript}\n</context>`,
      ruleContext ? `\n<rules>\n${ruleContext}\n</rules>` : '',
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
      `INVENTORY: If the character's inventory contains an item relevant to their action, acknowledge it in the narration and lower difficulty by 1. If they USE an item destructively (a potion consumed, a key that breaks), add {"field":"inventory","action":"remove","value":"<item name>"} to stateChanges. If they GAIN an item through this action, add {"field":"inventory","action":"add","value":"<item name>"}.`,
      `FATE POINT ECONOMY: If this action touches the character's trouble aspect or a consequence, COMPEL it — add {"field":"fatePoints","action":"set","value":${(characterInfo?.fatePoints ?? 3) + 1}} and narrate the complication. If the character spent effort invoking an aspect (referenced it in their action), spend a fate point: {"field":"fatePoints","action":"set","value":${Math.max(0, (characterInfo?.fatePoints ?? 3) - 1)}}.${consequenceGuide}${personalityReminder}`,
      `Respond as JSON: { "diceExpression": "${diceResult?.expression ?? 'null'}", "difficulty": <number>, "skill": "<skill>", "outcome": "success|failure|tie|success-with-cost", "narration": "2-3 sentences describing what happens.${narrationHint}", "stateChanges": [{"characterId": "${characterInfo?.id ?? '<id>'}", "field": "stress|consequences|fatePoints|inventory", "action": "set|add|remove", "value": <value>}] }`,
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
    });
  }

  async setupChat(opts: {
    preset: string;
    systemId: string;
    history: Array<{ role: string; content: string }>;
    unmet: string[];
    hostTableRole?: TableRole | null;
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
    const spoilerBlock = `

NO SPOILERS: You are building the DM's secrets, not sharing them. In "reply", never reveal a twist, a culprit, who is responsible for anything, a hidden motive, the answer to a mystery, or how the story will unfold. If the host asks a question the story itself should answer ("whose mistake brought us here?"), treat it as a hook you will plant, not a question to answer now: say it will be discovered in play. If the host says they do not want to know what will happen, honour that for the rest of the conversation. You MAY ask about tone, genre, content limits, influences, and what kind of mystery or danger they enjoy. Put the secret answers you invent in dmCustomPrompt only — that is never shown to players.${playingHost}`;

    const systemPrompt = `You are a TTRPG Dungeon Master helping set up a new game. Your base personality is "${opts.preset}".

Have a natural conversation with the game host to build their world with them:
1. What kind of adventure, setting, and tone they want
2. STYLISTIC INFLUENCES — at least three. Books, films, games, records, painters, anything. Ask what this world should FEEL like, and offer candidates drawn from what they have already told you. Three is the minimum because one is a costume and two is a comparison; three forces a specific intersection.
3. Any house rules or special requests

Be conversational and enthusiastic. Ask one or two questions at a time, never a checklist.
Accumulate every influence the host names into "influences" — return the full list every time, not just new ones.
When you have enough to build a world, set "done": true and fill in dmInstructions (a summary of how they want this run) and dmCustomPrompt (your tailored direction for running it).
Until then, set "done": false and leave dmInstructions/dmCustomPrompt null.${spoilerBlock}
${ruleContext ? `\nRules reference for their chosen system:\n${ruleContext}\n` : ''}${unmetBlock}

Respond as JSON: { "reply": "your message", "done": false, "influences": [], "dmInstructions": null, "dmCustomPrompt": null }`;

    return callLlm({
      messages: [{ role: 'system', content: systemPrompt }, ...opts.history],
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
  }): Promise<WorldSeed> {
    const transcript = opts.history.map(m => `[${m.role}] ${m.content}`).join('\n');
    const existingBlock = opts.existing
      ? `\n\nYou previously drafted this world. Revise it — keep what works, change what the conversation asks for:\n${JSON.stringify(opts.existing, null, 2)}`
      : '';

    const systemPrompt = `You are a world builder for a TTRPG. You output ONLY JSON. No prose, no roleplay, no markdown.

Build a starting world from the host's setup conversation.

Stylistic influences to honour (these shape VOICE and texture, not plot): ${opts.influences.join(' × ')}

Requirements:
- premise: one or two sentences naming the situation the players arrive into
- locations: at least 3, each with a name, a concrete description, and a terrain word
- npcs: at least 3, each with a name, a description, a disposition, and a motivation that could put them in someone's way
- plotHooks: at least 3 unresolved situations, phrased as things that are already happening
- items: 0 or more notable objects

Make places and people specific enough to walk into. Avoid generic fantasy furniture unless the influences call for it.

NO SPOILERS: The host reads every field of this world on a card before play — the premise, the location and NPC descriptions, dispositions and motivations, the plotHooks and the items — and the host may be playing. None of it may reveal or hint at a twist, a culprit, who is responsible for anything, who is behind anything, a hidden motive, or the answer to a mystery. Not even obliquely: no "rumors hint at a deliberate cover-up", no "someone wants the truth buried", no "it was no accident". Motivations say what an NPC openly wants; plotHooks say what is happening on the surface, as open questions. If the conversation asks something the story should answer ("whose mistake brought us here?"), leave it an open question — the answers belong to the DM's private direction, never to this world.

Return ONLY: {"premise":"...","locations":[{"name":"...","description":"...","terrain":"..."}],"npcs":[{"name":"...","description":"...","disposition":"...","motivation":"..."}],"plotHooks":["..."],"items":[{"name":"...","description":"..."}]}`;

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
  async introduceWorld(opts: { preset: string; influences: string[]; seed: WorldSeed }): Promise<string> {
    // Plot hooks (and NPC motivations) are DM secrets and are deliberately
    // not given to this prompt: whatever it knows, the player may read.
    const places = opts.seed.locations.slice(0, 4).map(l => `${l.name}: ${l.description}`).join('\n');
    const people = opts.seed.npcs.slice(0, 4).map(n => `${n.name}: ${n.description}`).join('\n');

    const systemPrompt = `You are a TTRPG Dungeon Master ("${opts.preset}" style) introducing a player to a world they are about to make a character for.

Write 120-180 words of second-person present tense. Put them somewhere specific and let them look around. Name real places and real people from the world below. End on something unresolved — a question the world is already asking — without answering it or hinting at who is behind it.

NO SPOILERS: the reader may be the one who has to solve this world's mystery. Never reveal or hint at a twist, a culprit, who is responsible, who is behind anything, a hidden motive, or the answer to any mystery — not even as rumors that hint at a cover-up, a conspiracy or a deliberate act. The open question stays an open question.

Do NOT explain the setting, list factions, or describe mechanics. Do not tell them who their character is; that is the next conversation. No headings, no bullet points, no preamble — just the prose.

${opts.influences.length > 0 ? `Stylistic influences to honour in voice and texture only: ${opts.influences.join(' × ')}\n\n` : ''}Premise: ${opts.seed.premise}

Places:
${places}

People:
${people}`;

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
    tableCharacters?: Array<{ name: string; highConcept: string }>;
  }): Promise<CharInterviewReply> {
    const ruleContext = this.lookupRules(opts.systemId, 'character creation aspects skills stunts');
    // No plot hooks: whatever this prompt knows can end up in the player's
    // backstory, and from there in the character agent's prompt every turn.
    const tableCharacters = (opts.tableCharacters ?? []).filter(c => c.name.trim());
    const tableBlock = tableCharacters.length > 0
      ? `\nAlready at this table (other players' characters):\n${tableCharacters.map(c => `- ${c.name}${c.highConcept ? `: ${c.highConcept}` : ''}`).join('\n')}\nThis character will be playing alongside them. Once you know who this character is, ask — as one of your questions, in plain words — whether they know any of these people and how: family, friends, rivals, strangers? And what do they call each other ("Mom", a nickname, a title, a first name)? Strangers are a fine answer; do not push a connection the player does not want.\n`
      : '';
    const worldBlock = opts.seed
      ? `\nThe world they are joining:\nPremise: ${opts.seed.premise}\nPlaces: ${opts.seed.locations.slice(0, 5).map(l => l.name).join(', ')}\nPeople: ${opts.seed.npcs.slice(0, 5).map(n => `${n.name} (${n.disposition ?? 'unknown'})`).join(', ')}\n`
      : '';
    const unmetBlock = opts.unmet.length > 0
      ? `\nStill needed for their sheet:\n${opts.unmet.map(u => `- ${u}`).join('\n')}\nAsk for these, but ask the way a person would.\n`
      : '';

    const systemPrompt = `You are a character creation API for a TTRPG. You help a player named ${opts.playerName} build a character through conversation, for a world that already exists.

Ask a MIX of two kinds of question, and lead with the second kind:

DIRECT — the plain thing, when you need a specific field. "What do we call them?"

INDIRECT — put the character in a real place from the world below and ask what they do, notice, or want. "You are on the tidal stair as the water comes up. What makes you stop?" Never ask for a game term this way. Infer aspects, skills and a trouble from how they answer, and reflect what you inferred back in plain language so they can correct you.

Open indirect. Use direct questions only to close the gaps listed below. Never present a checklist, never ask for more than two things at once, and never use the words "high concept", "aspect" or "stunt" in a question — describe what you mean instead.

Aim them at characters with INTERNAL TENSION: a clear strength and a clear vulnerability. The trouble should create genuine dilemmas, not minor inconveniences, and it should have somewhere to bite in THIS world.

If age matters to who they are — especially if they are a child or elderly — find out roughly how old they are.
${worldBlock}${tableBlock}${unmetBlock}${ruleContext ? `\nRules reference:\n${ruleContext}\n` : ''}

CRITICAL: respond with ONLY a JSON object. No asterisks, no roleplay actions, no narration outside the JSON.

Every reply carries the sheet as it stands so far, finished or not: {"reply": "your next question, or what you understand about them in plain language", "definition": {"name":"...","highConcept":"...","trouble":"...","aspects":["..."],"personality":"...","backstory":"...","skills":{"Skill":3},"stunts":["..."],"age":null,"pronouns":null,"relationships":[]}}
Fill in every field the player has stated or you have inferred and reflected back; leave the rest empty ("", [], {}). When the player states something outright — a name, what they are, what trouble dogs them, something they can do — record it in the sheet at once, in their words lightly tidied, and do not ask for it again. Include everything from earlier turns too, not just what changed. Only when you know nothing yet may "definition" be null.

"age" is a number or short phrase if you know it, else null. "pronouns" is how this character is referred to ("she/her", "he/him", "they/them") — fill it only if the player said so or plainly stated a gender ("I'm a girl", "my son"); otherwise null. Never assume a gender from a name, an age, a role or anything else, and do not write one into the backstory or personality either — if it matters to the player they will say, and you may ask. "relationships" lists people this character has a stated tie to — each {"to":"their exact name","relation":"what that person is TO THIS CHARACTER","address":"what this character calls them"}. Example: a kid whose mother Liz is at the table gets {"to":"Liz","relation":"mother","address":"Mom"}. Use the player's own relation word: "my kid Biz" is "kid", not "son" — never assume a gender. Fill it from what the player told you — including anything the backstory states, such as "her kid Biz" or "Biz and Mom" — and never invent ties the player did not state. Leave it [] if there are none.`;

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

  async summarizeScene(transcript: TranscriptMessage[], characterNames?: string[], worldState?: string): Promise<string> {
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

    try {
      const result = await callLlm({
        messages: [
          { role: 'system', content: 'You are a JSON API. Summarize TTRPG scenes. Output ONLY a JSON object.' },
          { role: 'user', content: `${text}\n\nSummarize in 3-5 sentences. Cover: what happened, who was involved, what changed, and what's unresolved.${charHint}${compactionHint}${whisperHint}${worldHint} Include any NPC reactions, items found, or locations visited. End with a TRANSITION HOOK — one sentence that creates urgency for the next scene (a sound in the distance, a ticking clock, a choice that can't wait, an NPC who just left with a secret).\n\nRespond as JSON: {"summary": "your summary here"}` },
        ],
        schema: SceneSummarySchema,
      });
      return result.summary;
    } catch {
      const plainText = await callProse({
        messages: [
          { role: 'system', content: 'Summarize this TTRPG scene in 3-5 sentences. Plain text only, no JSON.' },
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
