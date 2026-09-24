// Round 12 in play: the live 7MJXE5 lines run through the game loop (the LLM
// mocked with them), so the wiring is tested, not only the pure guards.
//  1. Every prompt that can mention an NPC carries the locked pronouns:
//     opening, narration, ruling, the characters' proposals and decisions,
//     both memory writers, the epilogue and the closing reflections.
//  2. What the table sees and what is remembered has Barnaby (it/its) as
//     "its": the ruling, Biz's own words, Liz's memory, a reflection.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';

type Msg = { role: string; content: string };
const calls: Array<{ kind: 'llm' | 'prose'; messages: Msg[] }> = [];

const OPENING_NARRATION = 'The Filing Atrium squeaks underfoot. Barnaby the Bureaucratic Goose waddles past, its tiny briefcase swinging.';
const LIZ_RULING = 'Barnaby waddles up to Liz, his tiny briefcase bumping her knee as he ignores the pen entirely.';
const BIZ_RULING = 'A paper drifts down and Biz catches it; the goose honks approvingly.';
const BIZ_WORDS = 'Mom, look! Barnaby didn’t steal it, he’s showing us!';
const LIZ_MEMORY = 'Barnaby waddled up to me, his tiny briefcase bumping my knee as he completely ignored me.';

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ kind: 'llm', messages: opts.messages });
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('OPENING OF THE ADVENTURE')) return { arrival: '', narration: OPENING_NARRATION, introductions: [], currentLocationName: 'The Filing Atrium' };
    if (all.includes('Choose your action now')) {
      return all.includes('You ARE Liz')
        ? { chosenAction: 'Hold the pen out of reach and ask Pudding for the exit form.', spokenWords: 'Excuse me, which form sends two people home?', innerThought: 'Home.', whisperedInfluence: 'ignored', trustDelta: 0 }
        : { chosenAction: 'Point at the goose and tug Mom’s sleeve.', spokenWords: BIZ_WORDS, innerThought: 'Shiny.', whisperedInfluence: 'ignored', trustDelta: 0 };
    }
    if (all.includes('Propose 2-4 actions')) return { actions: [{ description: 'I look around', reasoning: 'r' }, { description: 'I ask Pudding', reasoning: 'r' }] };
    if (all.includes('FATE resolution steps')) {
      const liz = all.includes('ACTING CHARACTER (narrate THEIR action, not another party member\'s): Liz');
      return { diceExpression: '4dF', difficulty: 0, skill: 'Notice', outcome: 'success', narration: liz ? LIZ_RULING : BIZ_RULING, stateChanges: [] };
    }
    if (all.includes('Pacing:')) return { narration: 'Archivist Pudding hums a lullaby while the papers drift.', currentLocationName: 'The Filing Atrium', activeNpcs: ['Archivist Pudding'], isSceneEnd: false };
    if (all.includes('You extract episodic memories')) {
      return all.includes('named Liz')
        ? { memories: [{ type: 'social', content: LIZ_MEMORY, emotionalValence: 0, importance: 0.9 }] }
        : { memories: [{ type: 'social', content: 'I pointed at the goose.', emotionalValence: 0, importance: 0.9 }] };
    }
    if (all.includes('Write ONE plain sentence')) return 'I saw them point at the goose.';
    if (all.includes('Summarize')) return { summary: 'The atrium squeaked.' };
    return 'ok';
  }),
  callProse: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ kind: 'prose', messages: opts.messages });
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('closing reflection')) return 'SPOKEN: "Barnaby, he was the best goose."\nTHOUGHT: I will miss the atrium.';
    if (all.includes('epilogue')) return 'Liz and Biz left the Filing Atrium together, the goose honking goodbye.';
    return 'ok';
  }),
}));

process.env.WHISPER_WINDOW_MS = '30';
process.env.PACE_MAX_MS = '0';

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r12-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

const LIZ_SHEET: CharacterDefinition = {
  name: 'Liz', highConcept: 'Unflappable Accountant Mom', trouble: 'I worry about Biz too much',
  aspects: ['Ledger-balancing precision'], personality: 'Calm', backstory: '', skills: { Notice: 3, Will: 3 }, stunts: [], pronouns: 'she/her',
  relationships: [{ to: 'Biz', relation: 'child', address: 'Biz' }],
};
const BIZ_SHEET: CharacterDefinition = {
  name: 'Biz', highConcept: 'Shiny-Obsessed 10-Year-Old Explorer', trouble: 'Wanders off after anything shiny',
  aspects: ['Pocket full of bottle caps'], personality: 'Curious', backstory: '', skills: { Notice: 3, Athletics: 3 }, stunts: [], age: 10, pronouns: 'they/them',
  relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }],
};

const ids = { liz: '', biz: '' };
let campaignId = '';
let seen: any[] = [];
let prompts: Array<{ kind: string; text: string }> = [];

beforeAll(async () => {
  const room = await import('../src/server/room.js');
  const { makeCharacterLive } = await import('../src/server/character-live.js');
  const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
  const seed = {
    premise: 'A misplaced stapler has glued Liz and Biz to the wrong plane of existence.',
    locations: [{ name: 'The Filing Atrium', description: 'Floors of compressed stamps.', terrain: 'indoor' }, { name: 'The Queue of Minor Inconveniences', description: 'A line that moves backward.', terrain: 'indoor' }],
    npcs: [
      { name: 'Archivist Pudding', description: 'A figure of warm custard. They hum when stressed.', disposition: 'helpful', motivation: null, pronouns: 'they/them' },
      { name: 'Officer Tick-Tock', description: 'A brass automaton with a clock face.', disposition: 'punctual', motivation: null, pronouns: 'it/its' },
      { name: 'Barnaby the Bureaucratic Goose', description: 'A goose with a tiny briefcase too big for its beak.', disposition: 'distractible', motivation: null, pronouns: 'it/its' },
    ],
    plotHooks: [],
    items: [{ name: 'The Stapler of Intent', description: 'A red stapler.' }],
  };
  const created = room.createRoom(db, { name: 'R12 play', dmPreset: 'chronicler', systemId: 'fate-core' });
  campaignId = created.campaignId;
  setWorldSeed(db, campaignId, seed as any);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed as any);
  ids.liz = `liz-r12-${campaignId}`;
  ids.biz = `biz-r12-${campaignId}`;
  for (const [id, definition, playerName] of [[ids.liz, LIZ_SHEET, 'Liz'], [ids.biz, BIZ_SHEET, 'Biz']] as const) {
    const session = room.createSession(db, { campaignId, joinCode: created.joinCode, playerName, isHost: playerName === 'Liz' });
    const pending = { id, campaignId, joinCode: created.joinCode, sessionToken: session.token, playerName, definition, aiFeedback: 'ok' };
    room.savePendingCharacter(db, pending);
    makeCharacterLive(db, pending);
  }

  const { GameLoop } = await import('../src/server/game-loop.js');
  const gameState = { campaignId, joinCode: created.joinCode, phase: 'playing' as const, currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null };
  let loop!: InstanceType<typeof GameLoop>;
  let resolutions = 0;
  const done = new Promise<void>((resolve) => {
    const on = (m: any) => { seen.push(m); if (m.type === 'resolution' && ++resolutions === 2) setImmediate(() => resolve()); };
    loop = new GameLoop(db, campaignId, on, () => {}, gameState as any, (_id: string, m: any) => on(m));
  });
  const running = loop.start().catch(e => console.error('LOOP FAILED', e));
  await Promise.race([done, new Promise(r => setTimeout(r, 20_000))]);
  // Memories are written in the background after each ruling.
  await new Promise(r => setTimeout(r, 200));
  await loop.endGame();
  await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
  prompts = calls.map(c => ({ kind: c.kind, text: c.messages.map(m => m.content).join('\n') }));
}, 40_000);

const BARNABY_LINE = /Barnaby the Bureaucratic Goose:? it\/its/;
const promptsWith = (marker: string) => prompts.filter(p => p.text.includes(marker)).map(p => p.text);

describe('round 12 in play: NPC pronouns reach every prompt', () => {
  it('the opening', () => {
    const opening = promptsWith('OPENING OF THE ADVENTURE');
    expect(opening.length).toBe(1);
    expect(opening[0]).toMatch(/<npc_pronouns>[\s\S]*Barnaby the Bureaucratic Goose: it\/its/);
  });

  it('narration and rulings', () => {
    const dm = [...promptsWith('Pacing:'), ...promptsWith('FATE resolution steps')];
    expect(dm.length).toBeGreaterThanOrEqual(3);
    for (const p of dm) expect(p).toMatch(BARNABY_LINE);
  });

  it('the characters\' proposals and decisions', () => {
    const agent = [...promptsWith('Propose 2-4 actions'), ...promptsWith('Choose your action now')];
    expect(agent.length).toBeGreaterThanOrEqual(4);
    for (const p of agent) expect(p).toMatch(BARNABY_LINE);
  });

  it('both memory writers, with the party\'s pronouns too', () => {
    const mem = [...promptsWith('You extract episodic memories'), ...promptsWith('Write ONE plain sentence')];
    expect(mem.length).toBeGreaterThanOrEqual(4);
    for (const p of mem) {
      expect(p).toMatch(BARNABY_LINE);
      expect(p).toContain('Biz: they/them');
    }
  });

  it('the epilogue and the closing reflections', () => {
    const ending = [...promptsWith('session epilogues'), ...promptsWith('closing reflection')];
    expect(ending.length).toBeGreaterThanOrEqual(3);
    for (const p of ending) expect(p).toMatch(BARNABY_LINE);
  });
});

describe('round 12 in play: what the table sees and remembers', () => {
  it('Liz\'s ruling: "his tiny briefcase… as he ignores" is "its… it"', () => {
    const ruling = seen.find(m => m.type === 'resolution' && m.text.includes('tiny briefcase'));
    expect(ruling.text).toContain('its tiny briefcase bumping her knee as it ignores the pen');
  });

  it('Biz\'s own words: "Barnaby didn’t steal it, it’s showing us!"', () => {
    const act = seen.find(m => m.type === 'action-taken' && m.characterName === 'Biz' && m.spokenWords?.includes('showing us'));
    expect(act.spokenWords).toBe('Mom, look! Barnaby didn’t steal it, it’s showing us!');
  });

  it('Liz\'s memory is stored with "its"', () => {
    const rows = (db.prepare('SELECT content FROM character_memories WHERE character_id = ?').all(ids.liz) as Array<{ content: string }>).map(r => r.content);
    expect(rows).toContain('Barnaby waddled up to me, its tiny briefcase bumping my knee as it completely ignored me.');
  });

  it('a closing reflection: "Barnaby, he was the best goose." is "it was"', () => {
    const reflections = seen.filter(m => m.type === 'action-taken' && m.spokenWords?.includes('best goose'));
    expect(reflections.length).toBeGreaterThan(0);
    for (const r of reflections) expect(r.spokenWords).toBe('Barnaby, it was the best goose.');
  });
});
