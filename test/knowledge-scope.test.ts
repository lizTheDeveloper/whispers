// test/knowledge-scope.test.ts
//
// Characters are LLM agents. Before this fix, their prompts carried the
// whole campaign world bible: seeded plot hooks as "Open threads", every
// NPC name (unmet ones as "People you've met elsewhere"), NPC motivations
// (leaking through a truncated description), every location as
// "unexplored", and every seeded item, hidden or not. A character knows its
// own sheet, its own memories, what the story has shown so far, and the
// whispers sent to IT — nothing else. These tests pin that down at the
// world-bible level, in the transcript filter every character prompt goes
// through, in the extractor's input, and in the DM prompts that reach
// players (world introduction, character interview, setup chat).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptMessage, WorldSeed } from '../src/shared/types.js';

// Every DM prompt that reaches a player goes through callLlm. Capturing its
// messages is how the prompt-content tests below see exactly what was sent.
const llmCalls: Array<Array<{ role: string; content: string }>> = [];
vi.mock('../src/server/agents/llm-client.js', () => {
  // callProse is the prose-call wrapper around the same request; one fake serves both.
  const fake = vi.fn(async (opts: { messages: Array<{ role: string; content: string }> }) => {
    llmCalls.push(opts.messages);
    const system = opts.messages[0]?.content ?? '';
    if (system.includes('helping set up a new game')) {
      return { reply: 'Tell me more.', done: false, influences: [], dmInstructions: null, dmCustomPrompt: null };
    }
    if (system.includes('character creation API')) {
      return { reply: 'Who are they?', definition: null };
    }
    return 'The lamp is lit.';
  });
  return { callLlm: fake, callProse: fake };
});

let dataDir: string;
let db: Database.Database;
let WorldBible: typeof import('../src/server/world-bible.js').WorldBible;
let seedWorld: typeof import('../src/server/world-seed.js').seedWorld;
let loadStockScenario: typeof import('../src/server/world-seed.js').loadStockScenario;
let createRoom: typeof import('../src/server/room.js').createRoom;

beforeAll(async () => {
  // The database lives in a throwaway STATE_DIR; DATA_DIR stays the repo's
  // own data/ so the stock scenarios load.
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-knowledge-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  const dbMod = await import('../src/server/db.js');
  db = dbMod.getDb();
  ({ WorldBible } = await import('../src/server/world-bible.js'));
  ({ seedWorld, loadStockScenario } = await import('../src/server/world-seed.js'));
  ({ createRoom } = await import('../src/server/room.js'));
});

afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

const masquerade = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'scenarios', 'haunted-masquerade.json'), 'utf-8')) as {
  npcs: Array<{ name: string; motivation: string }>;
  locations: Array<{ name: string }>;
  items: Array<{ name: string }>;
  plotHooks: string[];
};

function seedMasquerade(): { campaignId: string; wb: InstanceType<typeof WorldBible> } {
  const { campaignId } = createRoom(db, { name: 'Masquerade', dmPreset: 'chronicler', systemId: 'fate-core', scenarioId: 'haunted-masquerade' });
  const loaded = loadStockScenario('haunted-masquerade');
  expect(loaded).not.toBeNull();
  seedWorld(db, campaignId, loaded!.seed);
  return { campaignId, wb: new WorldBible(db) };
}

function expectNoneOf(text: string, needles: string[]): void {
  for (const n of needles) expect(text, `leaked: ${n}`).not.toContain(n);
}

describe('WorldBible.getPlayerKnowledge', () => {
  it('reveals nothing from a freshly seeded world: no hooks, unmet NPCs, unmentioned places or items, or motivations', () => {
    const { campaignId, wb } = seedMasquerade();
    const knowledge = wb.getPlayerKnowledge(campaignId);
    expectNoneOf(knowledge, masquerade.plotHooks);
    expectNoneOf(knowledge, masquerade.npcs.map(n => n.name));
    expectNoneOf(knowledge, masquerade.locations.map(l => l.name));
    expectNoneOf(knowledge, masquerade.items.map(i => i.name));
    expectNoneOf(knowledge, masquerade.npcs.map(n => n.motivation));
    expect(knowledge).not.toContain('Motivation');
  });

  it('shows an NPC once the DM has named them in narration, still without their motivation', () => {
    const { campaignId, wb } = seedMasquerade();
    wb.revealMentioned(campaignId, 'A man in a fox mask bows low. "Lord Cassius, at your service."');
    const knowledge = wb.getPlayerKnowledge(campaignId);
    expect(knowledge).toContain('Lord Cassius');
    expectNoneOf(knowledge, ['Duchess Vaelora', 'Mira the Servant', 'The Phantom']);
    expectNoneOf(knowledge, masquerade.npcs.map(n => n.motivation));
    expectNoneOf(knowledge, masquerade.plotHooks);
  });

  it('matches an NPC by their given name, not just their full title', () => {
    const { campaignId, wb } = seedMasquerade();
    wb.revealMentioned(campaignId, 'Vaelora raises her glass to the room.');
    expect(wb.getPlayerKnowledge(campaignId)).toContain('Duchess Vaelora');
  });

  it('shows a location once it is visited, and an item once it is mentioned', () => {
    const { campaignId, wb } = seedMasquerade();
    const cellar = wb.getLocationByName(campaignId, 'The Wine Cellar')!;
    wb.markLocationVisited(campaignId, cellar.id);
    wb.revealMentioned(campaignId, 'Something glints on the parquet: the Duchess\'s Signet Ring.');
    const knowledge = wb.getPlayerKnowledge(campaignId, cellar.id);
    expect(knowledge).toContain('The Wine Cellar');
    expect(knowledge).toContain("Duchess's Signet Ring");
    expectNoneOf(knowledge, ['Poison Vial', 'The Music Gallery', "The Servants' Corridor"]);
  });

  it('marks NPCs the DM puts on stage as known', () => {
    const { campaignId, wb } = seedMasquerade();
    wb.markEntityKnown(campaignId, 'Mira the Servant');
    expect(wb.getPlayerKnowledge(campaignId)).toContain('Mira the Servant');
  });

  it('marks what the extractor pulled from the story as known, and never lists seeded plot hooks', () => {
    const { campaignId, wb } = seedMasquerade();
    wb.applyDiff(campaignId, {
      newLocations: [{ name: 'The Garden Terrace', description: null, terrain: null }],
      newEntities: [{ name: 'The Phantom', type: 'npc', description: 'A blank white mask', disposition: 'unknown' }],
      newItems: [],
      newEvents: [{ sceneNumber: 1, description: 'A glass shattered in the ballroom', participants: [], outcome: null }],
      newRelationships: [],
    }, { markKnown: true });
    const knowledge = wb.getPlayerKnowledge(campaignId);
    expect(knowledge).toContain('The Garden Terrace');
    expect(knowledge).toContain('The Phantom');
    expect(knowledge).toContain('A glass shattered in the ballroom');
    expectNoneOf(knowledge, masquerade.plotHooks);
  });

  it('keeps the DM view whole: getSummary still carries motivations, from their own column', () => {
    const { campaignId, wb } = seedMasquerade();
    const row = db.prepare('SELECT description, motivation FROM entities WHERE campaign_id = ? AND name = ?').get(campaignId, 'Lord Cassius') as any;
    expect(row.description).not.toContain('[Motivation:');
    expect(row.motivation).toBe(masquerade.npcs.find(n => n.name === 'Lord Cassius')!.motivation);
    const summary = wb.getSummary(campaignId);
    expect(summary).toContain('trade contracts');
    expect(summary).toContain(masquerade.plotHooks[0]);
  });
});

describe('migration of existing rows', () => {
  function legacyDb(): Database.Database {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE campaigns (id TEXT PRIMARY KEY, join_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, dm_preset TEXT NOT NULL, scenario_id TEXT, system_id TEXT NOT NULL DEFAULT 'fate-core', host_user_id TEXT, house_rules TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), phase TEXT NOT NULL DEFAULT 'lobby');
      CREATE TABLE entities (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, description TEXT, disposition TEXT, alive INTEGER NOT NULL DEFAULT 1, location_id TEXT, metadata TEXT);
      CREATE TABLE locations (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, terrain TEXT, connections TEXT, coords TEXT, visited INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE items (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, properties TEXT, holder_id TEXT, location_id TEXT);
      CREATE TABLE checkpoints (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, scene_number INTEGER NOT NULL, turn_number INTEGER NOT NULL, game_state TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), transcript TEXT);
      CREATE TABLE scenes (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, scene_number INTEGER NOT NULL, transcript TEXT NOT NULL, summary TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    `);
    return legacy;
  }

  it('splits [Motivation: …] out of descriptions and backfills party knowledge for games already playing', async () => {
    const { migrate } = await import('../src/server/db.js');
    const legacy = legacyDb();
    legacy.prepare("INSERT INTO campaigns (id, join_code, name, dm_preset, phase) VALUES ('live', 'LIVE01', 'Live', 'chronicler', 'playing')").run();
    legacy.prepare("INSERT INTO campaigns (id, join_code, name, dm_preset, phase) VALUES ('new', 'NEW001', 'New', 'chronicler', 'character-creation')").run();
    const ent = legacy.prepare('INSERT INTO entities (id, campaign_id, type, name, description) VALUES (?, ?, ?, ?, ?)');
    ent.run('e1', 'live', 'npc', 'Lord Cassius', 'A fox mask. [Motivation: Wants the trade contracts]');
    ent.run('e2', 'live', 'npc', 'The Phantom', 'A blank mask. [Motivation: Unknown]');
    ent.run('e3', 'new', 'npc', 'Lord Cassius', 'A fox mask. [Motivation: Wants the trade contracts]');
    const loc = legacy.prepare('INSERT INTO locations (id, campaign_id, name, visited) VALUES (?, ?, ?, ?)');
    loc.run('l1', 'live', 'The Grand Ballroom', 1);
    loc.run('l2', 'live', 'The Wine Cellar', 0);
    loc.run('l3', 'live', 'The Music Gallery', 0);
    const item = legacy.prepare('INSERT INTO items (id, campaign_id, name) VALUES (?, ?, ?)');
    item.run('i1', 'live', 'Poison Vial');
    item.run('i2', 'live', 'Ornate Mask');
    const transcript: TranscriptMessage[] = [
      { role: 'dm', content: 'Lord Cassius lifts his fox mask toward the wine cellar.', timestamp: 't' },
      // A whisper is private — it is not the story, so it reveals nothing.
      { role: 'whisper', content: 'Ask about the Poison Vial and The Phantom', characterId: 'c1', timestamp: 't' },
    ];
    legacy.prepare("INSERT INTO checkpoints (id, campaign_id, scene_number, turn_number, game_state, transcript) VALUES ('cp', 'live', 1, 3, '{}', ?)").run(JSON.stringify(transcript));
    legacy.prepare("INSERT INTO scenes (id, campaign_id, scene_number, transcript, summary) VALUES ('s0', 'live', 0, '[]', 'They admired the Ornate Mask.')").run();

    migrate(legacy);

    const e1 = legacy.prepare("SELECT description, motivation, known_to_party FROM entities WHERE id = 'e1'").get() as any;
    expect(e1.description).toBe('A fox mask.');
    expect(e1.motivation).toBe('Wants the trade contracts');
    expect(e1.known_to_party).toBe(1);
    const known = (table: string, id: string) => (legacy.prepare(`SELECT known_to_party FROM ${table} WHERE id = ?`).get(id) as any).known_to_party;
    expect(known('entities', 'e2')).toBe(0);
    expect(known('entities', 'e3')).toBe(0); // not playing yet: starts from nothing, like a fresh seed
    expect(known('locations', 'l1')).toBe(1); // visited
    expect(known('locations', 'l2')).toBe(1); // named by the DM
    expect(known('locations', 'l3')).toBe(0);
    expect(known('items', 'i1')).toBe(0); // only ever whispered
    expect(known('items', 'i2')).toBe(1); // in a scene summary

    // Idempotent: a second boot does not re-run the backfill or re-split.
    legacy.prepare("UPDATE locations SET known_to_party = 0 WHERE id = 'l2'").run();
    migrate(legacy);
    expect(known('locations', 'l2')).toBe(0);
    legacy.close();
  });
});

describe('private whispers', () => {
  const transcript: TranscriptMessage[] = [
    { role: 'dm', content: 'The ballroom hushes.', timestamp: 't' },
    { role: 'whisper', content: 'Trust no one in a fox mask', characterId: 'A', timestamp: 't' },
    { role: 'character', content: 'Ana: I step back.', characterId: 'A', timestamp: 't' },
    { role: 'system', content: '[Ana heeded the whisper, trust: 0.62]', characterId: 'A', timestamp: 't' },
    { role: 'whisper', content: 'Go to the cellar', characterId: 'B', timestamp: 't' },
    { role: 'system', content: '[Bo resisted the whisper, trust: 0.41]', characterId: 'B', timestamp: 't' },
    { role: 'system', content: '[Bo invokes "Stubborn" for +2]', timestamp: 't' },
  ];

  it('a character sees its own whispers and verdicts, never another character\'s', async () => {
    const { transcriptVisibleTo } = await import('../src/server/transcript-visibility.js');
    const forA = transcriptVisibleTo(transcript, 'A').map(m => m.content).join('\n');
    expect(forA).toContain('Trust no one in a fox mask');
    expect(forA).toContain('Ana heeded the whisper');
    expect(forA).not.toContain('Go to the cellar');
    expect(forA).not.toContain('Bo resisted the whisper');
    expect(forA).toContain('I step back');
    expect(forA).toContain('invokes "Stubborn"');

    const forB = transcriptVisibleTo(transcript, 'B').map(m => m.content).join('\n');
    expect(forB).not.toContain('Trust no one in a fox mask');
    expect(forB).not.toContain('heeded the whisper');
    expect(forB).toContain('Go to the cellar');
  });

  it('story lines (what shared scene recaps are built from) carry no whisper text or verdicts', async () => {
    // Scene summaries become the "Previous scene" line every character reads,
    // so a whisper verdict surviving here would leak "2/3 whispers followed,
    // trust 0.55" to the whole table.
    const { storyLines } = await import('../src/server/transcript-visibility.js');
    const story = storyLines(transcript).map(m => m.content).join('\n');
    expect(story).not.toContain('Trust no one in a fox mask');
    expect(story).not.toMatch(/heeded the whisper|resisted the whisper|trust: 0\./);
    expect(story).toContain('The ballroom hushes.');
    expect(story).toContain('invokes "Stubborn"');
  });

  it('the fact extractor never reads whispers', async () => {
    const { ExtractorAgent } = await import('../src/server/agents/extractor.js');
    llmCalls.length = 0;
    await new ExtractorAgent().extractFacts(transcript, 1).catch(() => {});
    const sent = llmCalls.map(m => m.map(x => x.content).join('\n')).join('\n');
    expect(sent).toContain('The ballroom hushes.');
    expect(sent).not.toContain('Trust no one in a fox mask');
    expect(sent).not.toContain('Go to the cellar');
  });
});

describe('player-facing DM prompts keep DM secrets', () => {
  const seed: WorldSeed = {
    premise: 'A lighthouse keeps something out.',
    locations: [{ name: 'The Lamp Room', description: 'Glass and salt.', terrain: 'interior' }],
    npcs: [{ name: 'Maren', description: 'The keeper.', disposition: 'wary', motivation: 'Hide what she let in.' }],
    plotHooks: ['SECRET_HOOK: Maren drowned the relief keeper.'],
    items: [],
  };

  it('introduceWorld does not hand plot hooks to the prose writer', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    llmCalls.length = 0;
    await new DmAgent(db).introduceWorld({ preset: 'chronicler', influences: [], seed });
    const sent = JSON.stringify(llmCalls);
    expect(sent).toContain('introducing a player to a world');
    expect(sent).not.toContain('SECRET_HOOK');
    expect(sent).not.toContain('Hide what she let in');
  });

  it('the character interview does not see plot hooks', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    llmCalls.length = 0;
    await new DmAgent(db).interviewForCharacter({ systemId: 'fate-core', preset: 'chronicler', playerName: 'Wendy', influences: [], seed, history: [{ role: 'user', content: 'hi' }], unmet: [] });
    const sent = JSON.stringify(llmCalls);
    expect(sent).toContain('character creation API');
    expect(sent).not.toContain('SECRET_HOOK');
  });

  it('the setup-chat DM is told not to spoil the mystery for a host who is playing', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    llmCalls.length = 0;
    await new DmAgent(db).setupChat({ preset: 'chronicler', systemId: 'fate-core', history: [], unmet: [], hostTableRole: 'player' });
    const system = llmCalls[0]![0]!.content;
    expect(system).toMatch(/NO SPOILERS/);
    expect(system).toMatch(/host is PLAYING/i);
    expect(system).toMatch(/culprit/i);
  });

  it('keeps the anti-spoiler rule even before the host has chosen a seat', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    llmCalls.length = 0;
    await new DmAgent(db).setupChat({ preset: 'chronicler', systemId: 'fate-core', history: [], unmet: [] });
    const system = llmCalls[0]![0]!.content;
    expect(system).toMatch(/NO SPOILERS/);
  });
});
