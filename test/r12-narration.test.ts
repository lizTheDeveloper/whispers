// Round 12: what the round-11 live game (7MJXE5; qwen; Liz she/her, Biz
// they/them and ten, Biz calls Liz "Mom", the host asked for gentle peril)
// still got wrong in the narration. Each block quotes the live line.
//  1. NPC pronouns drifted: Barnaby (it/its) was "his… he" in the world
//     introduction, in the characters' words and in their memories;
//     Tick-Tock (it/its) was "his voice cracking".
//  2. The server's fate-point lines repeated word for word, and the DM kept
//     reaching for the same phrases.
//  3. The repeat guard dropped the attribution between two quotes.
//  4. Peril spiked at a gentle table.
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

type Msg = { role: string; content: string };
const llmCalls: Msg[][] = [];
const proseCalls: Msg[][] = [];
let llmReply: unknown = {};

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => { llmCalls.push(opts.messages); return llmReply; }),
  callProse: vi.fn(async (opts: { messages: Msg[] }) => { proseCalls.push(opts.messages); return 'You stand in the Filing Atrium.'; }),
}));

import { correctNpcPronouns, castPronounLine, namesSameNpc } from '../src/server/npc-pronouns.js';
import { WorldBible } from '../src/server/world-bible.js';
import { seedWorld } from '../src/server/world-seed.js';
import { DmAgent, childToneRule } from '../src/server/agents/dm.js';
import { CharacterAgent } from '../src/server/agents/character.js';
import { CharacterMemoryStore } from '../src/server/character-memory.js';
import { worldIntroductionAsShown } from '../src/server/game-loop.js';
import { LineRotation, invokeLines, compelLines } from '../src/server/template-lines.js';
import { recentPhrases, repetitionNotes, withoutRepeatedSentences, softenForChildren } from '../src/server/narrative-guards.js';
import type { WorldSeed, CharacterDefinition, CharacterState } from '../src/shared/types.js';

const PARTY = [{ name: 'Liz', pronouns: 'she/her' }, { name: 'Biz', pronouns: 'they/them' }];
const BARNABY = { name: 'Barnaby the Bureaucratic Goose', pronouns: 'it/its' };
const PUDDING = { name: 'Archivist Pudding', pronouns: 'they/them' };
const TICKTOCK = { name: 'Officer Tick-Tock', pronouns: 'it/its' };
const NPCS = [PUDDING, TICKTOCK, BARNABY];

// The live seed (7MJXE5), as the host accepted it.
const SEED: WorldSeed = {
  premise: 'A misplaced stapler in the Department of Arrivals has glued Liz and Biz to the wrong plane of existence.',
  locations: [
    { name: 'The Filing Atrium', description: 'Floors of compressed stamps; documents drift like jellyfish.', terrain: 'indoor' },
    { name: 'The Queue of Minor Inconveniences', description: 'A line that moves backward.', terrain: 'indoor' },
  ],
  npcs: [
    { name: 'Archivist Pudding', description: 'A tall, gelatinous figure made of what looks like warm custard, wearing a bow tie that floats independently. They have a habit of humming a lullaby when stressed.', disposition: 'overly helpful but disorganized', motivation: null, pronouns: 'they/them' },
    { name: 'Officer Tick-Tock', description: 'A small, brass automaton with a clock face for a head and legs that move in a jerky, metronome-like rhythm.', disposition: 'rigidly punctual', motivation: null, pronouns: 'it/its' },
    { name: 'Barnaby the Bureaucratic Goose', description: "A large, white goose with a small badge that reads 'Temporary Associate.' Barnaby carries a tiny briefcase that is too big for its beak. It walks with a determined waddle.", disposition: 'confident but easily distracted by shiny things', motivation: null, pronouns: 'it/its' },
  ],
  plotHooks: [],
  items: [{ name: 'The Stapler of Intent', description: 'A red stapler.' }],
};

function worldDb(): Database.Database {
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
  db.prepare('INSERT INTO campaigns (id, join_code, name, dm_preset) VALUES (?, ?, ?, ?)').run('c1', '7MJXE5', 'Test', 'chronicler');
  return db;
}

const fix = (text: string, opts: { speech?: boolean } = {}, party: Array<{ name: string; pronouns?: string | null }> = PARTY) =>
  correctNpcPronouns(text, NPCS, party, { ...opts, otherNames: ['The Filing Atrium', 'Form 7-B'] }).text;

// ─── 1. NPC pronouns ────────────────────────────────────────────────────────

describe('1a. an NPC\'s fixed pronoun is put back where nobody else could be meant', () => {
  it('Liz\'s memory: "Barnaby waddled up to me, his tiny briefcase… as he completely ignored me"', () => {
    const out = fix('Barnaby waddled up to me, his tiny briefcase bumping my knee as he completely ignored me to stare fixatedly at the pen I was holding.', { speech: true });
    expect(out).toBe('Barnaby waddled up to me, its tiny briefcase bumping my knee as it completely ignored me to stare fixatedly at the pen I was holding.');
  });

  it('"toss a granola bar to Barnaby, distracting him" — Biz (they) is named too, but "him" cannot be Biz', () => {
    expect(fix('I used my ledger-balancing precision to toss a granola bar to Barnaby, distracting him just enough to yank Biz under the static field.', { speech: true }))
      .toBe('I used my ledger-balancing precision to toss a granola bar to Barnaby, distracting it just enough to yank Biz under the static field.');
  });

  it('Biz\'s words: "Barnaby didn’t steal it, he’s showing us!"', () => {
    expect(fix('Mom, look! It’s the same duck as Pudding. Barnaby didn’t steal it, he’s showing us!', { speech: true }))
      .toBe('Mom, look! It’s the same duck as Pudding. Barnaby didn’t steal it, it’s showing us!');
  });

  it('Biz\'s memory: "Officer Tick-Tock’s brass head whirred…, his voice cracking as he complained"', () => {
    expect(fix('Liz’s eyes narrowed at my pocket with a promise of future audits, while Officer Tick-Tock’s brass head whirred in confused distress, his voice cracking as he complained about the static.', { speech: true }))
      .toBe('Liz’s eyes narrowed at my pocket with a promise of future audits, while Officer Tick-Tock’s brass head whirred in confused distress, its voice cracking as it complained about the static.');
  });

  it('the world introduction: "his oversized briefcase bumping against his legs. He looks you in the eye"', () => {
    const intro = 'Nearby, Barnaby the Bureaucratic Goose waddles with great determination, his oversized briefcase bumping against his legs. He looks you in the eye and honks a distinct question mark into the humid silence.';
    expect(correctNpcPronouns(intro, NPCS, []).text)
      .toBe('Nearby, Barnaby the Bureaucratic Goose waddles with great determination, its oversized briefcase bumping against its legs. It looks you in the eye and honks a distinct question mark into the humid silence.');
  });

  it('the DM\'s ruling: Liz\'s "her knee" stays, Barnaby\'s "his… he" is fixed', () => {
    expect(fix('Barnaby waddles up to Liz, his tiny briefcase bumping her knee as he ignores the pen entirely.'))
      .toBe('Barnaby waddles up to Liz, its tiny briefcase bumping her knee as it ignores the pen entirely.');
  });

  it('a they/them NPC: the verb agrees', () => {
    expect(fix('Archivist Pudding hums, and he adjusts his bow tie.')).toBe('Archivist Pudding hums, and they adjust their bow tie.');
    expect(fix('Pudding wobbles closer; he is worried.')).toBe('Pudding wobbles closer; they are worried.');
    // "she" could be Liz (she/her): left alone.
    expect(fix('Archivist Pudding hums, and she adjusts her bow tie.')).toBe('Archivist Pudding hums, and she adjusts her bow tie.');
  });
});

describe('1b. …and nowhere else', () => {
  const same = (text: string, opts: { speech?: boolean } = {}, party = PARTY as Array<{ name: string; pronouns?: string | null }>) => expect(fix(text, opts, party)).toBe(text);

  it('two NPCs in the sentence: "I tried to give Barnaby a bottle cap, but he missed it… into Officer Tick-Tock"', () => {
    same('I tried to give Barnaby a bottle cap, but he missed it entirely and knocked into Officer Tick-Tock, making the automaton stutter.', { speech: true });
    const r = correctNpcPronouns('I tried to give Barnaby a bottle cap, but he missed it entirely and knocked into Officer Tick-Tock.', NPCS, PARTY, { speech: true });
    expect(r.fixes).toEqual([]);
  });

  it('a party member who is he/him, or whose pronouns are not stated, could be meant', () => {
    same('Barnaby honks at the pen and his briefcase snaps shut.', {}, [...PARTY, { name: 'Sam', pronouns: 'he/him' }]);
    same('Barnaby honks at the pen and his briefcase snaps shut.', {}, [...PARTY, { name: 'Sam', pronouns: null }]);
  });

  it('an unnamed man, clerk or stranger in the sentence could be meant', () => {
    same('Barnaby waddles past a clerk and he frowns at the queue.');
    same('Barnaby honks at an old man, and he laughs.');
  });

  it('an unknown name in the sentence could be meant', () => {
    same('Barnaby honks at Gerald and he drops the file.');
  });

  it('a next sentence opening on "He" is not carried over when someone else appeared before', () => {
    same('A tall man enters the atrium. Barnaby honks at the door. He frowns at the goose.');
    same('Barnaby honks at the door. Liz sighs. He frowns.');
  });

  it('a pronoun before the name is left alone', () => {
    same('Before he could honk, Barnaby dropped the pen.');
  });

  it('quoted speech inside narration is never touched', () => {
    same('Officer Tick-Tock whirs, "Barnaby said he would file it."');
  });

  it('"it" and "they" are never changed — they may be a thing, or several people', () => {
    same('Archivist Pudding’s bow tie snaps straight, and it chirps a greeting.');
    same('Officer Tick-Tock taps the form while they wait.');
  });

  it('a pronoun that matches is left alone', () => {
    same('Barnaby waddles past, its briefcase swinging.');
  });
});

describe('1c. the pronouns reach everyone who could mention the NPC', () => {
  let db: Database.Database;
  beforeEach(() => { db = worldDb(); llmCalls.length = 0; proseCalls.length = 0; });
  afterEach(() => { db.close(); });

  // Round 14: a short name is no longer filed as an NPC of its own at all —
  // it IS the seed's NPC (WorldBible.findSameNpc), pronouns and all.
  it('a short name the extractor files later ("Barnaby") is the seed\'s NPC, with the seed\'s pronouns', () => {
    seedWorld(db, 'c1', SEED);
    const wb = new WorldBible(db);
    wb.applyDiff('c1', { newLocations: [], newEntities: [{ name: 'Barnaby', type: 'npc', description: 'A goose.', disposition: null }, { name: 'Pudding', type: 'npc', description: null, disposition: null }], newItems: [], newEvents: [], newRelationships: [] });
    const all = wb.getNpcPronouns('c1');
    expect(all.map(n => n.name)).not.toContain('Barnaby');
    expect(all.map(n => n.name)).not.toContain('Pudding');
    expect(all).toContainEqual({ name: 'Barnaby the Bureaucratic Goose', pronouns: 'it/its' });
    expect(all).toContainEqual({ name: 'Archivist Pudding', pronouns: 'they/them' });
    expect(wb.findSameNpc('c1', 'Barnaby')?.name).toBe('Barnaby the Bureaucratic Goose');
    expect(namesSameNpc('Barnaby', 'Barnaby the Bureaucratic Goose')).toBe(true);
    expect(namesSameNpc('Pudding', 'Officer Tick-Tock')).toBe(false);
  });

  it('a character is told the pronouns of an NPC in the scene they have not met, and of one the scene names', () => {
    seedWorld(db, 'c1', SEED);
    const wb = new WorldBible(db);
    const atrium = wb.getLocationByName('c1', 'The Filing Atrium')!;
    wb.updateEntityLocation('c1', 'Officer Tick-Tock', atrium.id);
    const list = wb.getNpcPronounsForParty('c1', atrium.id, 'A goose waddles by. Barnaby honks.');
    expect(list).toContainEqual(TICKTOCK);
    expect(list).toContainEqual(BARNABY);
    // Pudding: not met, not here, not named — a character has no reason to know them yet.
    expect(list.map(n => n.name)).not.toContain('Archivist Pudding');
    expect(wb.getPlayerKnowledge('c1', atrium.id)).toMatch(/Officer Tick-Tock it\/its/);
  });

  it('the world introduction prompt lists each NPC with their pronouns and the fixed-pronoun rule; gentle peril goes in too', async () => {
    await new DmAgent(db).introduceWorld({ preset: 'chronicler', influences: [], seed: SEED, gentlePeril: true });
    const system = proseCalls[0]!.map(m => m.content).join('\n');
    expect(system).toContain('Barnaby the Bureaucratic Goose (it/its)');
    expect(system).toContain('Archivist Pudding (they/them)');
    expect(system).toMatch(/NPC pronouns — fixed/);
    expect(system).toMatch(/GENTLE PERIL/);
  });

  it('the world introduction as shown: Barnaby is "its", and the gentle table gets no "terrifying"', () => {
    const live = 'Nearby, Barnaby the Bureaucratic Goose waddles with terrifying determination, his oversized briefcase bumping against his legs. He looks you in the eye and honks a distinct question mark into the humid silence. Across the hall, Archivist Pudding hums a lullaby. Their custard-like form jiggles softly.';
    const out = worldIntroductionAsShown(live, SEED, true);
    expect(out).toContain('its oversized briefcase bumping against its legs. It looks you in the eye');
    expect(out).not.toMatch(/terrifying|\bhis\b|\bHe\b/);
    expect(out).toContain('Their custard-like form');
  });

  it('the opening prompt carries the NPC pronoun line', async () => {
    llmReply = { arrival: '', narration: 'x', introductions: [], currentLocationName: '' };
    await new DmAgent(db).openScene(
      { preset: 'chronicler', houseRules: null, dmInstructions: null, dmCustomPrompt: null, campaignId: 'c1', worldSummary: '', transcript: [], systemId: 'fate-core', influences: [], party: [] },
      { premise: SEED.premise, scenarioOpening: null, places: [], npcPronouns: 'NPC pronouns — fixed; use exactly these: Barnaby the Bureaucratic Goose: it/its.' },
    );
    expect(llmCalls[0]!.map(m => m.content).join('\n')).toMatch(/<npc_pronouns>[\s\S]*Barnaby the Bureaucratic Goose: it\/its/);
  });

  it('the character-creation chat names each NPC\'s pronouns', async () => {
    llmReply = { reply: 'Hi', definition: null };
    await new DmAgent(db).interviewForCharacter({ systemId: 'fate-core', preset: 'chronicler', playerName: 'Biz', influences: [], seed: SEED, history: [{ role: 'user', content: 'hi' }], unmet: [] });
    expect(llmCalls[0]!.map(m => m.content).join('\n')).toMatch(/Barnaby the Bureaucratic Goose \(it\/its/);
  });

  const BIZ: CharacterDefinition = { name: 'Biz', highConcept: 'Shiny-Obsessed 10-Year-Old Explorer', trouble: 'Wanders off after anything shiny', aspects: ['Pocket full of bottle caps'], personality: 'curious', backstory: '', skills: { Notice: 3 }, stunts: [], pronouns: 'they/them' };
  const STATE: CharacterState = { stress: 0, consequences: [], fatePoints: 3, whisperTrust: 0.6, inventory: [] } as unknown as CharacterState;
  const ctx = { definition: BIZ, state: STATE, sceneNarration: 'Barnaby waddles past.', transcript: [], npcPronouns: [BARNABY, PUDDING] };

  it('the character\'s decision prompt — where spoken words come from — has the NPC pronouns', async () => {
    llmReply = { chosenAction: 'Point at the goose', spokenWords: null, innerThought: 'Shiny.', whisperedInfluence: 'ignored', trustDelta: 0 };
    await new CharacterAgent().decideAction(ctx, null);
    const prompt = llmCalls[0]!.map(m => m.content).join('\n');
    expect(prompt).toContain('Barnaby the Bureaucratic Goose: it/its');
    expect(prompt).toContain('Archivist Pudding: they/them');
  });

  it('…and so does the proposal prompt', async () => {
    llmReply = { actions: [{ description: 'Look', reasoning: 'r' }] };
    await new CharacterAgent().proposeActions(ctx);
    expect(llmCalls[0]!.map(m => m.content).join('\n')).toContain('Barnaby the Bureaucratic Goose: it/its');
  });

  it('the cast line names the party and the NPCs', () => {
    const line = castPronounLine(PARTY, [BARNABY]);
    expect(line).toContain('Liz: she/her');
    expect(line).toContain('Biz: they/them');
    expect(line).toContain('Barnaby the Bureaucratic Goose: it/its');
  });
});

describe('1d. memories are written with everyone\'s pronouns, and repaired before they are kept', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE character_memories (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, campaign_id TEXT NOT NULL, scene_number INTEGER NOT NULL, turn_number INTEGER NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, emotional_valence REAL NOT NULL DEFAULT 0.0, importance REAL NOT NULL DEFAULT 0.5, decay_rate REAL NOT NULL DEFAULT 0.05, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    llmCalls.length = 0;
  });
  afterEach(() => { db.close(); });
  const note = castPronounLine(PARTY, NPCS);
  const repair = (t: string) => correctNpcPronouns(t, NPCS, PARTY, { speech: true }).text;
  const stored = () => (db.prepare('SELECT content FROM character_memories').all() as Array<{ content: string }>).map(r => r.content);

  it('the episodic memory', async () => {
    llmReply = { memories: [{ type: 'social', content: 'Barnaby waddled up to me, his tiny briefcase bumping my knee as he completely ignored me.', emotionalValence: 0, importance: 0.5 }] };
    await new CharacterMemoryStore(db).extractAndStore('liz', 'c1', 'Liz', 'Toss the pen', 'Barnaby waddles up.', null, 1, 1, { pronounNote: note, repair });
    expect(llmCalls[0]!.map(m => m.content).join('\n')).toContain('Barnaby the Bureaucratic Goose: it/its');
    expect(llmCalls[0]!.map(m => m.content).join('\n')).toContain('Biz: they/them');
    expect(stored()).toEqual(['Barnaby waddled up to me, its tiny briefcase bumping my knee as it completely ignored me.']);
  });

  it('the observation', async () => {
    llmReply = 'I noticed Officer Tick-Tock’s brass head whirring, his voice cracking as he complained about the static.';
    await new CharacterMemoryStore(db).storeObservation('biz', 'c1', 'Biz', 'Liz', 'Frown at the pocket', 'Tick-Tock whirs.', 1, 1, [], { pronounNote: note, repair });
    expect(llmCalls[0]!.map(m => m.content).join('\n')).toContain('Officer Tick-Tock: it/its');
    expect(stored()[0]).toContain('its voice cracking as it complained');
  });
});

// ─── 2. Stock lines and DM tics ─────────────────────────────────────────────

describe('2. the server\'s own lines do not repeat, for anyone', () => {
  it('"Something shifts — "Unflappable Accountant Mom" — and Liz finds a way through." is not said twice', () => {
    const lines = new LineRotation();
    const picks = Array.from({ length: 6 }, () => lines.pick('invoke', invokeLines('Liz', 'Unflappable Accountant Mom')));
    expect(new Set(picks).size).toBe(6);
  });

  it('a compel line used for Liz is not the next one Biz gets: "crosses X\'s path", "X\'s motto", "the pull of old habits" rotate across speakers', () => {
    const lines = new LineRotation();
    const skeleton = (s: string, name: string, trouble: string) => s.split(name).join('X').split(trouble).join('T');
    const said: string[] = [];
    const who: Array<[string, string]> = [['Liz', 'I worry about Biz too much'], ['Biz', 'Wanders off after anything shiny']];
    for (let i = 0; i < 8; i++) {
      const [name, trouble] = who[i % 2]!;
      said.push(skeleton(lines.pick('compel', compelLines(name, trouble)), name, trouble));
    }
    expect(new Set(said).size).toBe(8);
    expect(compelLines('Liz', 'x').length).toBeGreaterThanOrEqual(6);
    expect(invokeLines('Liz', 'x').length).toBeGreaterThanOrEqual(6);
  });

  it('a line already in the recent story is passed over (a resumed game has an empty rotation)', () => {
    const lines = new LineRotation();
    const variants = compelLines('Liz', 'I worry about Biz too much');
    const recent = `Pudding sighs. ${variants[0]}`;
    expect(lines.pick('compel', variants, recent)).not.toBe(variants[0]);
  });
});

describe('2b. the DM is told the phrases it keeps reusing', () => {
  const BEATS = [
    'Liz stiffens, her hand instinctively reaching out to pull Biz back as Officer Tick-Tock’s metronome legs jerking in a confused rhythm squeak on the stamps. The filing cabinet rattles.',
    'The air smells of vanilla. Liz grips the pen, and her hand instinctively shoots out to grab Biz’s sleeve. The filing cabinet hums.',
    'Somewhere a bell rings, and Tick-Tock’s metronome legs jerking again, it chimes, "Your hand instinctively reaches for the form, citizen!"',
  ];

  it('three- and four-word tics used in two or more beats are listed', () => {
    const phrases = recentPhrases(BEATS);
    expect(phrases).toEqual(expect.arrayContaining(['her hand instinctively', 'metronome legs jerking']));
  });

  it('names, things with an article, and quoted dialogue are not tics', () => {
    const phrases = recentPhrases(BEATS);
    expect(phrases.join(' | ')).not.toMatch(/tick-tock|filing cabinet|citizen/i);
  });

  it('the DM prompt\'s repetition notes carry them', () => {
    expect(repetitionNotes(BEATS)).toMatch(/Phrases you have already used[\s\S]*"metronome legs jerking"/);
  });

  it('fresh beats list nothing', () => {
    expect(recentPhrases(['A bell rings far away.', 'The goose honks twice.'])).toEqual([]);
  });
});

// ─── 3. The repeat guard keeps who is speaking ──────────────────────────────

describe('3. an attribution between two quotes is never dropped', () => {
  const EARLIER = '"Hold your forms!" Tick-Tock chimes, its voice sounding like a wind-up toy running out of steam, "The witness cannot be accessed until the duplicate insignia is properly filed."';

  it('the live ruling: "The static is a violation!" [attribution] "And the witness…" keeps its attribution', () => {
    const ruling = 'Officer Tick-Tock’s brass fingers scrabble against the damp form with a sound like rain on a tin roof. "The static is a violation!" Tick-Tock chimes, its voice sounding like a wind-up toy running out of steam. "And the witness in the Filing Atrium is waking up!"';
    const out = withoutRepeatedSentences(ruling, [EARLIER]);
    expect(out).toContain('"The static is a violation!" Tick-Tock chimes, its voice sounding like a wind-up toy running out of steam. "And the witness');
  });

  it('a sentence with a NEW line of dialogue is kept even when its attribution was said before', () => {
    const ruling = 'Tick-Tock chimes, its voice sounding like a wind-up toy running out of steam, "Form 7-B belongs in the blue drawer, citizen."';
    expect(withoutRepeatedSentences(ruling, [EARLIER])).toBe(ruling);
  });

  it('a repeated description with no dialogue next to it still goes', () => {
    const earlier = 'The mist tastes of wet ink and old glue, curling around their ankles like cold water.';
    const ruling = 'Biz sneezes. The mist tastes of wet ink and old glue, curling around their ankles like cold water.';
    expect(withoutRepeatedSentences(ruling, [earlier])).toBe('Biz sneezes.');
  });

  it('a line of dialogue said again still goes, attribution and all', () => {
    const ruling = 'Pudding wobbles. "Hold your forms!" Tick-Tock chimes, its voice sounding like a wind-up toy running out of steam, "The witness cannot be accessed until the duplicate insignia is properly filed."';
    const out = withoutRepeatedSentences(ruling, [EARLIER]);
    expect(out).toMatch(/^Pudding wobbles\./);
    expect(out).not.toContain('The witness cannot be accessed');
  });
});

// ─── 4. Gentle peril ────────────────────────────────────────────────────────

describe('4. gentle peril stays gentle', () => {
  it('the live near-miss on the child: "missing their ear by a whisker"', () => {
    const out = softenForChildren('Biz squeezes through the gap just as a heavy stamp slams down from above, missing their ear by a whisker.');
    expect(out).not.toMatch(/whisker|missing their ear/);
    expect(out).toBe('Biz squeezes through the gap just as a heavy stamp slams down from above, well clear of everyone.');
    expect(softenForChildren('A stapler whizzes past, narrowly missing Biz’s head by inches.')).not.toMatch(/missing|inches/);
    expect(softenForChildren('I squeezed through just as a heavy stamp slammed down, missing my ear by a whisker and landing with a wet thwack.')).not.toMatch(/whisker/);
  });

  it('"the paperwork might breathe and bite back"', () => {
    expect(softenForChildren('Pudding warns that the paperwork might breathe and bite back.')).toBe('Pudding warns that the paperwork might breathe and grumble back.');
  });

  it('"waddles with terrifying determination"', () => {
    expect(softenForChildren('Barnaby waddles with terrifying determination.')).toBe('Barnaby waddles with great determination.');
  });

  it('ordinary adventure is not sanitized', () => {
    for (const s of [
      'Liz bites back a laugh as the goose honks.',
      'Biz bit back a grin.',
      'The heavy door slams shut behind them.',
      'The stamp misses the form entirely and lands on the floor.',
      'The queue moves forward one step.',
    ]) expect(softenForChildren(s)).toBe(s);
  });

  it('the register rules out near-misses to the body, biting, and detention or countdown threats at the kid', () => {
    const rule = childToneRule([{ name: 'Biz', highConcept: 'kid', trouble: 't', age: 10, pronouns: 'they/them' } as any], { gentlePeril: true });
    expect(rule).toMatch(/near-miss/i);
    expect(rule).toMatch(/whisker/);
    expect(rule).toMatch(/bite/);
    expect(rule).toMatch(/detention/);
    expect(rule).toMatch(/minutes/);
    expect(rule).not.toMatch(/ticking clocks, puzzles and near-misses/);
  });
});
