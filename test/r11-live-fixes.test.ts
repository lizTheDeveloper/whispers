// Round 11: what the round-10 live verification (game Z9JKG2; qwen/qwen3.8-27b;
// Liz she/her, Biz they/them, Biz calls Liz "Mom", host asked for gentle
// peril) still got wrong. Each block quotes the live line.
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { WorldBible } from '../src/server/world-bible.js';
import { seedWorld, withoutFalseDraftClaim, setupUnmetForModel } from '../src/server/world-seed.js';
import { pronounsInDescription, pronounsInNarration } from '../src/server/npc-pronouns.js';
import {
  withoutRepeatedSentences, withoutWhisperMentions, softenForChildren, softenEnding, bleakEnding,
} from '../src/server/narrative-guards.js';
import { childToneRule } from '../src/server/agents/dm.js';
import { publicReflection } from '../src/server/game-loop.js';
import { observerOwnWords } from '../src/server/character-memory.js';
import { checkCharacterReadiness, checkInterviewReadiness } from '../src/server/character-readiness.js';
import { withStatedStuntDescriptions } from '../src/server/character-interview.js';
import { checkWorldReadiness } from '../src/server/world-readiness.js';
import type { WorldSeed } from '../src/shared/types.js';

const LIZ = { name: 'Liz', pronouns: 'she/her', relationships: [{ to: 'Biz', relation: 'child', address: 'Biz' }] };
const BIZ = { name: 'Biz', pronouns: 'they/them', relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }] };
const PARTY = [LIZ, BIZ];

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE campaigns (id TEXT PRIMARY KEY, join_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, dm_preset TEXT NOT NULL, scenario_id TEXT, system_id TEXT NOT NULL DEFAULT 'fate-core', host_user_id TEXT, house_rules TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE entities (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), type TEXT NOT NULL, name TEXT NOT NULL, description TEXT, disposition TEXT, alive INTEGER NOT NULL DEFAULT 1, location_id TEXT, metadata TEXT);
    CREATE TABLE locations (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), name TEXT NOT NULL, description TEXT, terrain TEXT, connections TEXT, coords TEXT);
    CREATE TABLE items (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), name TEXT NOT NULL, description TEXT, properties TEXT, holder_id TEXT, location_id TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), scene_number INTEGER NOT NULL, description TEXT NOT NULL, participants TEXT, outcome TEXT);
    CREATE TABLE relationships (campaign_id TEXT NOT NULL REFERENCES campaigns(id), entity_a_id TEXT NOT NULL, entity_b_id TEXT NOT NULL, type TEXT NOT NULL, description TEXT, PRIMARY KEY (campaign_id, entity_a_id, entity_b_id));
    CREATE TABLE characters (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), player_user_id TEXT, definition TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  db.prepare('INSERT INTO campaigns (id, join_code, name, dm_preset) VALUES (?, ?, ?, ?)').run('c1', 'Z9JKG2', 'Test', 'chronicler');
  return db;
}

// The live seed (Z9JKG2), trimmed.
const SEED: WorldSeed = {
  premise: 'Liz and Biz have been physically stamped into the Department of Misfiled Reality due to a clerical error.',
  locations: [
    { name: 'The Intake Hall', description: 'A vast, circular room made of pale glass and warm wood.', terrain: 'indoor' },
    { name: 'The Archive of Unsent Letters', description: 'A towering library where books float in lazy spirals.', terrain: 'indoor' },
  ],
  npcs: [
    { name: 'Clerk Marni', description: 'A small, round figure with spectacles that magnify their eyes to the size of saucers. They wear a uniform of crisp white and carry a rubber stamp the size of a dinner plate, which they polish obsessively.', disposition: 'Cheerful and overly polite.', motivation: 'To file every form in order.' },
    { name: 'Odo the Owl', description: 'A large, fluffy owl with feathers the color of aged parchment, perched atop a stack of ledgers. They wear a tiny monocle and hold a fountain pen in one wing.', disposition: 'Stern and precise.', motivation: "To audit the players' 'Visitation Status'." },
    { name: 'The Postman’s Shadow', description: 'A tall, slender silhouette that moves independently of its owner, wearing a tiny, perfectly tailored hat.', disposition: 'Quiet and observant.', motivation: 'To deliver a delayed package.' },
  ],
  plotHooks: ['The ink on the Purpose of Visit form is fading.'],
  items: [],
};

// ─── 1. NPC pronouns drift ──────────────────────────────────────────────────

describe('1. an NPC keeps the pronouns they were given', () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('read off a seed description: Marni and Odo are "their", the Shadow is "its"', () => {
    expect(pronounsInDescription(SEED.npcs[0]!.description)).toBe('they/them');
    expect(pronounsInDescription(SEED.npcs[1]!.description)).toBe('they/them');
    expect(pronounsInDescription(SEED.npcs[2]!.description)).toBe('it/its');
    expect(pronounsInDescription('A tall clerk with a green visor.')).toBeNull();
  });

  it('seeding stores them, and the DM\'s world summary carries them every turn', () => {
    seedWorld(db, 'c1', SEED);
    const wb = new WorldBible(db);
    expect(wb.getNpcPronouns('c1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Clerk Marni', pronouns: 'they/them' }),
      // Round 19: with the kind the seed gives, when it gives one.
      { name: 'Odo the Owl', pronouns: 'they/them', kind: 'owl' },
      expect.objectContaining({ name: 'The Postman’s Shadow', pronouns: 'it/its' }),
    ]));
    const summary = wb.getSummary('c1');
    expect(summary).toMatch(/NPC pronouns/);
    expect(summary).toContain('Clerk Marni: they/them');
    expect(summary).toContain('Odo the Owl: they/them');
  });

  it('a seed that states pronouns outright wins over the description', () => {
    const seed: WorldSeed = { ...SEED, npcs: [{ ...SEED.npcs[0]!, pronouns: 'she/her' }, SEED.npcs[1]!] };
    seedWorld(db, 'c1', seed);
    expect(new WorldBible(db).getNpcPronouns('c1')).toContainEqual({ name: 'Clerk Marni', pronouns: 'she/her' });
  });

  it('an NPC with none set gets the pronouns of the first narration that shows them — and keeps them after', () => {
    const wb = new WorldBible(db);
    wb.addEntity({ id: 'e1', campaignId: 'c1', type: 'npc', name: 'Clerk Pim', description: 'A clerk.', disposition: null, alive: true, locationId: null, metadata: {} });
    // Live (Z9JKG2 seq 48): the first narration to show Marni's pronouns.
    const first = 'Clerk Pim leans over the edge, her saucer eyes wide and her rubber stamp tapping against the wood.';
    expect(wb.learnNpcPronouns('c1', first, ['Liz', 'Biz'])).toEqual([{ name: 'Clerk Pim', pronouns: 'she/her' }]);
    // A later beat that drifts does not move them.
    wb.learnNpcPronouns('c1', 'Clerk Pim adjusts his visor and he sighs.', ['Liz', 'Biz']);
    expect(wb.getNpcPronouns('c1')).toContainEqual({ name: 'Clerk Pim', pronouns: 'she/her' });
  });

  it('a sentence that also names another NPC or a party member is not evidence', () => {
    expect(pronounsInNarration('Odo the Owl', 'Odo the Owl lands beside Liz and she smiles.', ['Liz', 'Biz'])).toBeNull();
    expect(pronounsInNarration('Odo the Owl', 'Odo the Owl descends from his shelf and he lands on the counter.', ['Liz', 'Biz'])).toBe('he/him');
  });
});

// ─── 2. Repeated DM beats ──────────────────────────────────────────────────

describe('2. a sentence the DM already said is not said again', () => {
  // Live Z9JKG2 seq 76 (scene opening) then seq 81 (the next ruling).
  const OPENING = "The mist at the threshold tastes of wet ink and old glue, curling around Liz's ankles as she tugs Biz from beneath the spinning counter. The Postman’s Shadow tilts its tiny hat, its static voice crackling like a radio losing signal: 'The file for the Unsent is open, but the key is sticky with yesterday’s mail.' Biz’s hand jerks toward the Shiny Object, the tag humming with a scent that is exactly the back of the library.";
  const RULING = "Liz steps across the threshold, her foot sinking into the mist which tastes of wet ink and old glue, curling around her ankles like cold water. The Fading Form in her grip shudders, its ink thinning to a faint violet haze that smells distinctly of lavender. The Postman’s Shadow tilts its tiny hat, its static voice crackling like a radio losing signal: 'The file for the Unsent is open, but the key is sticky with yesterday’s mail.' Liz finds a way through.";

  it('the live ruling loses the repeated line and the repeated mist; the rest stands', () => {
    const out = withoutRepeatedSentences(RULING, [OPENING]);
    expect(out).not.toContain('sticky with yesterday');
    expect(out).not.toContain('wet ink and old glue');
    expect(out).toContain('The Fading Form in her grip shudders');
    expect(out).toContain('Liz finds a way through.');
  });

  it('an NPC line said again by another speaker goes too', () => {
    const before = 'Marni peers over the counter. "Every form must be filed in its proper drawer before the chime, dear," Marni says.';
    const now = 'Odo ruffles their feathers. "Every form must be filed in its proper drawer before the chime, dear," Odo hoots. Biz giggles.';
    const out = withoutRepeatedSentences(now, [before]);
    expect(out).toBe('Odo ruffles their feathers. Biz giggles.');
  });

  it('fresh prose, short lines and shared place names are left alone', () => {
    const before = 'The party walks into the Archive of Unsent Letters. Biz grins.';
    const now = 'Liz follows Biz into the Archive of Unsent Letters, counting the floating books. Biz grins.';
    expect(withoutRepeatedSentences(now, [before])).toBe(now);
  });

  it('when every sentence repeats, nothing is left (the caller\'s whole-beat fallback takes over)', () => {
    expect(withoutRepeatedSentences(OPENING, [OPENING])).toBe('');
  });
});

// ─── 3. "I've drafted a starting world" with no world drafted ──────────────

describe('3. the setup DM never claims a world card that does not exist', () => {
  const LIVE = 'That trio of influences is perfect. Pratchett gives us the satirical edge, Ghibli adds the dreamlike magic, and The Phantom Tollbooth brings the playful discovery. I’ve drafted a starting world based on the \'wrong box\' premise, including specific locations, NPCs, and a plot hook. I’m keeping all the secrets and twists hidden in the DM notes so you can discover them in play. Please review the world card I’ve drafted. If it looks good and you’re ready to start, just let me know!';

  it('the claim comes out when no draft is on its way', () => {
    const out = withoutFalseDraftClaim(LIVE, { draftComing: false, fallback: 'Tell me how you want this game to run.' });
    expect(out).not.toMatch(/drafted/i);
    expect(out).not.toMatch(/world card/i);
    expect(out).toContain('That trio of influences is perfect.');
  });

  it('left alone when a draft is really coming', () => {
    expect(withoutFalseDraftClaim(LIVE, { draftComing: true, fallback: 'x' })).toBe(LIVE);
  });

  it('a reply that is nothing but the claim becomes the fallback question', () => {
    const only = 'I have drafted the world based on your influences. Please review the world card.';
    expect(withoutFalseDraftClaim(only, { draftComing: false, fallback: 'Tell me how you want this game to run.' })).toBe('Tell me how you want this game to run.');
  });

  it('the model is not told to have the host "review the world" before one exists', () => {
    const r = checkWorldReadiness({ influences: ['a', 'b', 'c'], seed: null, dmInstructions: null, hostTableRole: 'player', seedAccepted: false });
    const told = setupUnmetForModel(r).join('\n');
    expect(told).not.toMatch(/Review and accept/i);
    expect(told).toMatch(/not been drafted yet/i);
    expect(told).toMatch(/never (?:say|tell)/i);
  });
});

// ─── 4. Whispers in a public reflection ─────────────────────────────────────

describe('4. a closing reflection never mentions the whisper', () => {
  const BIZ_LIVE = 'SPOKEN: "Mom, look, the Blue Whale Cap is just sitting right there on the stone floor."\nTHOUGHT: The ink on the Fading Form is probably gone by now, but I am glad I told Odo to help Marni find the pen because the Postman’s Shadow is still flickering behind her and I do not know if the voice that told me to stay next to Mom was right to trust.';

  it('the live line: the clause about the voice is cut, the rest stays', () => {
    const r = publicReflection(BIZ_LIVE, { self: BIZ, members: PARTY, familyTable: true });
    expect(r.thought).not.toMatch(/voice|whisper/i);
    expect(r.thought).toContain('I am glad I told Odo to help Marni find the pen');
    expect(r.spoken).toBe('Mom, look, the Blue Whale Cap is just sitting right there on the stone floor.');
  });

  it('"the voices", "a voice that told me" and "the whisper" are all caught', () => {
    expect(withoutWhisperMentions('I kept thinking about the voices, and I stayed close to Mom.')).toBe('I stayed close to Mom.');
    expect(withoutWhisperMentions('A voice told me to wait, so I held Mom\'s hand.')).toBe('I held Mom\'s hand.');
    // Someone's actual voice is fine.
    expect(withoutWhisperMentions("Marni's voice was kind when she found the pen.")).toBe("Marni's voice was kind when she found the pen.");
  });
});

// ─── 5. Gentle peril: endings and repeated threats ──────────────────────────

describe('5. a gentle table ends somewhere safe, and its threats stay gentle', () => {
  it('the live threats, softened', () => {
    expect(softenForChildren('just get us out before that storm eats the whole room!')).toBe('just get us out before that storm rolls over the whole room!');
    expect(softenForChildren('A cold realization that the only way out is a tube the size of a shoebox settles over Liz.'))
      .toBe('A sudden realization that the quickest way out is a tube the size of a shoebox settles over Liz.');
    expect(softenForChildren("if you touch that cap again, I'm filing you as a permanent fixture of this room!"))
      .toBe("if you touch that cap again, I'm filing you under 'Lost and Found' for the afternoon!");
    expect(softenForChildren('or the Recall Form will be lost forever!')).toBe('or the Recall Form will be lost for a good long while!');
  });

  it('ordinary adventure is not sanitized', () => {
    expect(softenForChildren('Biz ate the whole cake.')).toBe('Biz ate the whole cake.');
    expect(softenForChildren('The only road north is washed out.')).toBe('The only road north is washed out.');
  });

  it('the live ending reads as bleak, and softens', () => {
    const LIVE = 'In the misty stone halls of the Archive of Unsent Letters, Liz and Biz stood frozen as the storm sealed the exit, leaving the question of the Catastrophic Filing Error hanging in the air.';
    expect(bleakEnding(LIVE)).toBe(true);
    const soft = softenEnding(LIVE);
    expect(soft).not.toMatch(/frozen|sealed/);
    expect(soft).toContain('Liz and Biz stood still as the storm hid the exit for now');
    expect(bleakEnding('Liz squeezes Biz\'s hand; the next form can wait until tomorrow.')).toBe(false);
  });

  it('"holding nothing but my fear" is bleak', () => {
    expect(bleakEnding('I am standing in the Archive, holding nothing but my fear.')).toBe(true);
  });

  it('the ending rule: gentle tables end hopeful and safe', () => {
    const rule = childToneRule([{ name: 'Liz', highConcept: 'x', trouble: 'y' }], { gentlePeril: true, ending: true });
    expect(rule).toMatch(/ENDING/);
    expect(rule).toMatch(/hope/i);
    expect(rule).toMatch(/safe/i);
    // Not for the ordinary turn, and not for a table that asked for nothing.
    expect(childToneRule([{ name: 'Liz', highConcept: 'x', trouble: 'y' }], { gentlePeril: true })).not.toMatch(/ENDING/);
    expect(childToneRule([{ name: 'Liz', highConcept: 'x', trouble: 'y' }], { ending: true })).toBe('');
  });

  it('the register names the live threats: trapped forever, filed away for good, weather that eats rooms', () => {
    const rule = childToneRule([{ name: 'Liz', highConcept: 'x', trouble: 'y' }], { gentlePeril: true });
    expect(rule).toMatch(/forever/);
    expect(rule).toMatch(/permanent/);
  });

  it('a gentle reflection that lands on fear is softened', () => {
    const LIZ_LIVE = 'SPOKEN: "Just breathe, Biz."\nTHOUGHT: I am standing in the Archive of Unsent Letters with the exit sealed by the storm, holding nothing but my fear that the Catastrophic Filing Error was my fault.';
    const r = publicReflection(LIZ_LIVE, { self: LIZ, members: PARTY, familyTable: true });
    expect(r.thought).not.toMatch(/sealed|nothing but my fear/);
  });
});

// ─── 6. Liz's own memory calls her "Mom" ────────────────────────────────────

describe('6. an observer\'s memory is in their own words', () => {
  it('the live line: "Mom\'s hand" in Liz\'s memory is her own hand', () => {
    expect(observerOwnWords("I watched Biz squeeze Mom's hand to stop the shuffling, but their eyes stayed on the cap.", 'Liz', ['Mom']))
      .toBe("I watched Biz squeeze my hand to stop the shuffling, but their eyes stayed on the cap.");
  });

  it('her own name, and "Mom" as a person, too', () => {
    expect(observerOwnWords("I saw Biz grip Liz's sleeve tighter.", 'Liz', ['Mom'])).toBe('I saw Biz grip my sleeve tighter.');
    expect(observerOwnWords('I watched Biz run to Mom.', 'Liz', ['Mom'])).toBe('I watched Biz run to me.');
    expect(observerOwnWords('I noticed Mom smiled at Biz.', 'Liz', ['Mom'])).toBe('I noticed Liz smiled at Biz.');
    // Quoted speech is the actor's own words.
    expect(observerOwnWords('I heard Biz shout "Mom, look!" at the cap.', 'Liz', ['Mom'])).toBe('I heard Biz shout "Mom, look!" at the cap.');
  });

  it('another observer is left alone', () => {
    expect(observerOwnWords("I watched Biz squeeze Mom's hand.", 'Odo', [])).toBe("I watched Biz squeeze Mom's hand.");
  });
});

// ─── 7. "They need at least 1 stunt" for she/her Liz ────────────────────────

describe('7. the readiness hint uses the character\'s pronouns', () => {
  it('she/her Liz: "She needs…"', () => {
    const r = checkInterviewReadiness({ name: 'Liz', pronouns: 'she/her', highConcept: 'Tired mom', trouble: 'Worries', aspects: ['a', 'b'], skills: { Notice: 3 }, stunts: [] });
    expect(r.detail).toContain('She needs at least 1 stunt — something she can do that others cannot.');
  });

  it('they/them keeps "They need"; no pronouns uses the name', () => {
    expect(checkCharacterReadiness({ name: 'Biz', pronouns: 'they/them', stunts: [] }).detail).toContain('They need at least 1 stunt — something they can do that others cannot.');
    expect(checkCharacterReadiness({ name: 'Biz', stunts: [] }).detail).toContain('Biz needs at least 1 stunt — something Biz can do that others cannot.');
    expect(checkCharacterReadiness({ name: 'Liz', pronouns: 'she/her' }).detail).toContain('What complicates her life? A trouble that creates real dilemmas.');
  });
});

// ─── 8. A stunt saved without the player's description ──────────────────────

describe('8. a stunt keeps the description the player gave it', () => {
  const PLAYER = [
    "I'm Biz, I'm 10, they/them. My trouble is: Wanders off after anything shiny. My stunt: Tiny and Quick — I can squeeze through small gaps and under counters where grown-ups can't fit. I have a pocket full of bottle caps.",
  ];

  it('the live sheet: "Tiny and Quick" gets its description back', () => {
    const out = withStatedStuntDescriptions({ name: 'Biz', stunts: ['Tiny and Quick'] }, PLAYER);
    expect(out.stunts).toEqual(["Tiny and Quick — I can squeeze through small gaps and under counters where grown-ups can't fit."]);
  });

  it('a stunt that already has its description, or one the player never described, is left alone', () => {
    const lizLines = ["Liz's stunt: Found It! — once per scene she can find exactly the lost thing she needs in any pile."];
    const full = { name: 'Liz', stunts: ['Found It! — once per scene she can find exactly the lost thing she needs in any pile.'] };
    expect(withStatedStuntDescriptions(full, lizLines)).toBe(full);
    const other = { name: 'Biz', stunts: ['Pocket Science'] };
    expect(withStatedStuntDescriptions(other, PLAYER)).toBe(other);
  });

  it('"Found It!" (a name with its own "!") is read whole', () => {
    const lizLines = ["Liz's stunt: Found It! — once per scene she can find exactly the lost thing she needs in any pile. That's everything."];
    expect(withStatedStuntDescriptions({ name: 'Liz', stunts: ['Found It!'] }, lizLines).stunts)
      .toEqual(['Found It! — once per scene she can find exactly the lost thing she needs in any pile.']);
  });
});
