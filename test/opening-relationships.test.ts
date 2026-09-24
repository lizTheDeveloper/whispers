// test/opening-relationships.test.ts
//
// Two reports from a live table where Liz (a mom) and Biz (her kid) were
// cast together:
//   "they just drop in, there's no preamble"
//   "biz refers to liz as liz instead of mom"
//
// The opening: play now opens with a narration-only beat — the scene is set
// (the stock scenario's openingNarration verbatim, or a DM opening built from
// the accepted premise and the ACTUAL party) and every character is
// introduced as the others would see them, relationships included — before
// any agent proposes or takes an action. A checkpoint resume never replays it.
//
// Relationships: a character sheet can carry who someone is to you and what
// you call them. That reaches the character's own prompt (with the backstory
// that used to be dropped), replaces the "MUST reference X BY NAME"
// directives, and the interview can see who else is already at the table.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WebSocket } from 'ws';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, slowLlmToken, type Harness } from './lib/server-harness.js';
import { finishWorldSetup } from './lib/finish-world-setup.js';
import type { CharacterDefinition, RoomState, WorldSeed } from '../src/shared/types.js';
import type { ServerMessage } from '../src/shared/protocol.js';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
  // The harness points DATA_DIR at an empty temp dir; the stock-scenario
  // opening needs the real scenario file to be loadable from there.
  mkdirSync(join(harness.dataDir, 'scenarios'), { recursive: true });
  copyFileSync(
    resolve(import.meta.dirname, '../data/scenarios/collapsed-mine.json'),
    join(harness.dataDir, 'scenarios', 'collapsed-mine.json'),
  );
}, 30_000);
afterAll(async () => { await harness.stop(); });

const LIZ: CharacterDefinition = {
  name: 'Liz',
  backstory: 'Liz has raised her son Biz on her own since he was born; the two of them against the world.',
  personality: 'Organised, wry, fiercely protective.',
  highConcept: 'Overworked Mom With a Clipboard Heart',
  trouble: 'Cannot Stop Managing Everyone',
  aspects: ['Always Has Snacks', 'Reads the Fine Print'],
  skills: { Will: 3, Rapport: 2, Notice: 1 },
  stunts: ['Mom Voice: +2 to Provoke when someone is endangering a child.'],
  age: 38,
  relationships: [{ to: 'Biz', relation: 'son', address: 'Biz' }],
};

const BIZ: CharacterDefinition = {
  name: 'Biz',
  backstory: 'Biz and Mom have always been a team. He collects bottle caps and questions.',
  personality: 'Curious, restless, brave in the way small kids are.',
  highConcept: 'Ten-Year-Old Who Asks Why',
  trouble: 'Wanders Off When Something Glows',
  aspects: ['Pocket Full of Bottle Caps', 'Fits Where Adults Cannot'],
  skills: { Notice: 3, Athletics: 2, Stealth: 1 },
  stunts: ['Small and Quick: +2 to Stealth in tight spaces.'],
  age: 10,
  relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }],
};

const STATE = { stress: 0, consequences: [], fatePoints: 3, inventory: [], xpMilestones: [], whisperTrust: 0.65 };

const IMPROVISED_SEED: WorldSeed = {
  premise: 'A clerical paperwork error has isekaied a mother and child into the Bureau of Misfiled Souls, a kingdom run entirely on forms.',
  locations: [
    { name: 'The Intake Hall', description: 'Endless queues under humming lamps.', terrain: 'interior' },
    { name: 'The Stamp Gardens', description: 'Hedges trimmed into rubber stamps.', terrain: 'garden' },
    { name: 'Archive Nine', description: 'Shelves that rearrange at night.', terrain: 'interior' },
  ],
  npcs: [
    { name: 'Clerk Oswin Pell', description: 'A tired clerk with ink-stained cuffs.', disposition: 'wary', motivation: 'Hide the error that brought them here.' },
    { name: 'The Registrar', description: 'Never seen, only signed.', disposition: 'unknown', motivation: 'Unknown.' },
    { name: 'Dot', description: 'A paper crane that delivers memos.', disposition: 'friendly', motivation: 'Deliver everything.' },
  ],
  plotHooks: ['Form 27-B was signed by someone who does not exist.', 'The Registrar wants the error buried.', 'Archive Nine is missing a drawer.'],
  items: [{ name: 'Blank Form 27-B', description: 'Warm, as if recently printed.' }],
};

let seq = 0;

async function makeLoop(opts: { scenarioId?: string; seed: WorldSeed; dmInstructions?: string; dmCustomPrompt?: string; checkpointTurn?: number }) {
  const { getDb } = await import('../src/server/db.js');
  const { createRoom } = await import('../src/server/room.js');
  const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
  const { saveCheckpoint } = await import('../src/server/checkpoint.js');
  const { GameLoop } = await import('../src/server/game-loop.js');
  const db = getDb();
  const { campaignId, joinCode } = createRoom(db, { name: `Opening ${++seq}`, dmPreset: 'chronicler', systemId: 'fate-core', scenarioId: opts.scenarioId });
  db.prepare('UPDATE campaigns SET dm_instructions = ?, dm_custom_prompt = ? WHERE id = ?')
    .run(opts.dmInstructions ?? 'Keep it warm and funny.', opts.dmCustomPrompt ?? null, campaignId);
  setWorldSeed(db, campaignId, opts.seed);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, opts.seed);

  const lizId = `liz-${seq}`;
  const bizId = `biz-${seq}`;
  for (const [id, def] of [[lizId, LIZ], [bizId, BIZ]] as const) {
    db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)')
      .run(id, campaignId, JSON.stringify(def), JSON.stringify(STATE));
  }

  const state: RoomState = {
    campaignId, joinCode, phase: 'playing', currentScene: 0, currentTurn: 0,
    initiativeOrder: [], activeCharacterId: null,
    awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null,
  };
  if (opts.checkpointTurn) {
    saveCheckpoint(db, campaignId, 1, opts.checkpointTurn, { ...state, currentScene: 1, currentTurn: opts.checkpointTurn, sceneTurnCount: 1 }, [
      { role: 'dm', content: 'Earlier, the queue shuffled forward.', timestamp: new Date().toISOString() },
    ]);
  }

  const broadcasts: ServerMessage[] = [];
  const bodiesBefore = harness.receivedBodies.length;
  let loop!: InstanceType<typeof GameLoop>;
  // Stop the loop at the first whisper window: by then the opening (if any)
  // is over and an agent is already mid-turn, which is all these tests need.
  const firstWindow = new Promise<void>((done) => {
    loop = new GameLoop(db, campaignId, (m) => {
      broadcasts.push(m);
      if (m.type === 'whisper-prompt') setImmediate(() => { loop.stop(); done(); });
    }, () => {}, state);
  });
  const running = loop.start().catch(() => {});
  await Promise.race([firstWindow, new Promise(r => setTimeout(r, 20_000))]);
  loop.stop();
  await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
  const bodies = harness.receivedBodies.slice(bodiesBefore);
  return { broadcasts, bodies, campaignId, lizId, bizId, db };
}

function firstIndex(broadcasts: ServerMessage[], pred: (m: ServerMessage) => boolean): number {
  return broadcasts.findIndex(pred);
}

describe('the opening: arrival and introductions before anyone acts', () => {
  it('opens a stock scenario with its openingNarration, then introduces the party, before any action', async () => {
    const { loadStockScenario } = await import('../src/server/world-seed.js');
    const stock = loadStockScenario('collapsed-mine');
    expect(stock?.openingNarration).toBeTruthy();

    const { broadcasts } = await makeLoop({ scenarioId: 'collapsed-mine', seed: stock!.seed });

    const narrations = broadcasts.filter(m => m.type === 'narration') as Array<Extract<ServerMessage, { type: 'narration' }>>;
    expect(narrations.length).toBeGreaterThan(0);
    expect(narrations[0]!.text).toContain(stock!.openingNarration!.slice(0, 80));

    const introIdx = firstIndex(broadcasts, m => m.type === 'narration' && m.text.includes('Biz') && /mother/i.test(m.text));
    expect(introIdx).toBeGreaterThan(-1);
    const introLiz = firstIndex(broadcasts, m => m.type === 'narration' && m.text.includes('Liz') && m.text.includes('Clipboard'));
    expect(introLiz).toBeGreaterThan(-1);

    const firstAction = firstIndex(broadcasts, m => m.type === 'action-proposals' || m.type === 'action-taken');
    expect(firstAction).toBeGreaterThan(-1); // play did go on to round 1
    expect(firstAction).toBeGreaterThan(introIdx);
    expect(firstAction).toBeGreaterThan(introLiz);
  }, 60_000);

  it('builds an improvised opening from the premise and the ACTUAL party, not setup-invented PCs', async () => {
    const { bodies, broadcasts } = await makeLoop({
      seed: IMPROVISED_SEED,
      dmInstructions: "The players are Marilyn 'Merry' Harper, a harried single mother, and her 10-year-old son Jasper. Keep it whimsical.",
      dmCustomPrompt: 'Run a bureaucratic isekai. The players are Marilyn Harper and Jasper Harper.',
    });

    const opening = bodies.find(b => b.includes('OPENING OF THE ADVENTURE'));
    expect(opening, 'the DM was asked to open the adventure').toBeTruthy();
    expect(opening).toContain(IMPROVISED_SEED.premise);
    expect(opening).toContain('Liz');
    expect(opening).toContain('Biz');
    expect(opening).not.toContain('Marilyn');
    expect(opening).not.toContain('Jasper');
    // The arrival must only establish what the characters perceive.
    expect(opening).toMatch(/only what the characters (would )?perceive/i);

    // The ongoing play prompts carry the real party too.
    const narrate = bodies.find(b => b.includes('Pacing:'));
    expect(narrate).toBeTruthy();
    expect(narrate).toContain('Biz');
    expect(narrate).not.toContain('Marilyn');

    const firstAction = firstIndex(broadcasts, m => m.type === 'action-proposals' || m.type === 'action-taken');
    const introIdx = firstIndex(broadcasts, m => m.type === 'narration' && m.text.includes('Biz') && /mother/i.test(m.text));
    expect(introIdx).toBeGreaterThan(-1);
    expect(firstAction).toBeGreaterThan(introIdx);
  }, 60_000);

  it('does not replay the opening when resuming from a checkpoint', async () => {
    const { loadStockScenario } = await import('../src/server/world-seed.js');
    const stock = loadStockScenario('collapsed-mine')!;
    const { broadcasts, bodies } = await makeLoop({ scenarioId: 'collapsed-mine', seed: stock.seed, checkpointTurn: 4 });

    const texts = broadcasts.filter(m => m.type === 'narration').map(m => (m as any).text as string);
    expect(texts.some(t => t.includes(stock.openingNarration!.slice(0, 80)))).toBe(false);
    expect(texts.some(t => t.includes('Clipboard'))).toBe(false);
    expect(bodies.some(b => b.includes('OPENING OF THE ADVENTURE'))).toBe(false);
    // …and play itself did resume.
    expect(broadcasts.some(m => m.type === 'action-proposals')).toBe(true);
  }, 60_000);

  it('seeds stated relationships into the world bible so the DM sees them', async () => {
    const { bodies, campaignId, db } = await makeLoop({ seed: IMPROVISED_SEED });
    const { WorldBible } = await import('../src/server/world-bible.js');
    const rels = new WorldBible(db).getRelationships(campaignId);
    expect(rels).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityAName: 'Biz', entityBName: 'Liz', type: 'mother' }),
      expect.objectContaining({ entityAName: 'Liz', entityBName: 'Biz', type: 'son' }),
    ]));
    const bizToLiz = rels.find(r => r.entityAName === 'Biz' && r.entityBName === 'Liz')!;
    expect(bizToLiz.description).toMatch(/Liz is Biz's mother/);
    // …and the DM's play prompt states the real party with those ties.
    const narrate = bodies.find(b => b.includes('Pacing:'));
    expect(narrate).toBeTruthy();
    expect(narrate).toMatch(/Liz is Biz's mother\./);
    // The address term is scoped to Biz — it is not Liz's name for everyone.
    expect(narrate).toMatch(/Biz calls Liz \\"Mom\\"; everyone else, NPCs included, calls her \\"Liz\\"/);
  }, 60_000);
});

describe('how characters see and address each other', () => {
  it("puts relation, address term and backstory in the character's prompt, not a BY NAME directive", async () => {
    const { CharacterAgent } = await import('../src/server/agents/character.js');
    const agent = new CharacterAgent();
    const before = harness.receivedBodies.length;
    await agent.proposeActions({
      definition: BIZ,
      state: STATE,
      sceneNarration: 'The Intake Hall hums.',
      transcript: [
        { role: 'dm', content: 'The Intake Hall hums.', timestamp: new Date().toISOString() },
        { role: 'character', characterId: 'liz', content: 'Liz: I take a numbered ticket from the dispenser', timestamp: new Date().toISOString() },
      ],
      partyMembers: [{ name: 'Liz', highConcept: LIZ.highConcept, trouble: LIZ.trouble, relation: 'mother', address: 'Mom' }],
    }).catch(() => {});
    const body = harness.receivedBodies.slice(before).find(b => b.includes('You ARE Biz'));
    expect(body).toBeTruthy();
    expect(body).toContain('mother');
    expect(body).toContain('Mom');
    expect(body).toContain('Biz and Mom have always been a team');
    expect(body).toContain('Small and Quick');
    expect(body).toMatch(/10/);
    expect(body).not.toContain('MUST reference Liz BY NAME');
    // NPCs/places may still be named; companions are addressed, not "BY NAME".
    expect(body).not.toMatch(/Liz BY NAME|Reference them by name|at least one action MUST name them/);
    expect(body).toMatch(/address them the way your character naturally would/);
  }, 30_000);

  it('lets the interview see the characters already at the table', async () => {
    const { getDb } = await import('../src/server/db.js');
    const { joinRoom } = await import('../src/server/room.js');
    const { getOrCreateInterview, setInterviewDefinition } = await import('../src/server/character-interview.js');
    const db = getDb();

    const hostWs = await connectWs(harness.port);
    const hostQ = new MessageQueue(hostWs);
    sendMsg(hostWs, { type: 'create', name: 'Interview Table', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
    const joined = await hostQ.waitFor('room-joined', 10_000) as any;
    await hostQ.waitFor('dm-chat-reply', 10_000);
    await finishWorldSetup(hostWs, hostQ);
    const campaign = joinRoom(db, joined.joinCode)!;

    // One character already live, one still being interviewed by someone else.
    db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)')
      .run(`live-liz-${campaign.id}`, campaign.id, JSON.stringify(LIZ), JSON.stringify(STATE));
    const other = getOrCreateInterview(db, campaign.id, 'someone-elses-token');
    setInterviewDefinition(db, other.id, { ...BIZ, name: 'Grandpa Oskar', highConcept: 'Retired Lighthouse Mechanic', relationships: [] });

    const playerWs: WebSocket = await connectWs(harness.port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Kiddo' });
    await pq.waitFor('room-joined', 10_000);

    const before = harness.receivedBodies.length;
    sendMsg(playerWs, { type: 'char-chat', text: 'I want to play her kid.' });
    await pq.waitFor('char-chat-reply', 15_000);
    const body = harness.receivedBodies.slice(before).find(b => b.includes('character creation API'));
    expect(body).toBeTruthy();
    expect(body).toContain('Liz');
    expect(body).toContain('Overworked Mom With a Clipboard Heart');
    expect(body).toContain('Grandpa Oskar');
    expect(body).toMatch(/relationships/);

    playerWs.close();
    hostWs.close();
  }, 60_000);
});

describe('the opening respects pause', () => {
  it('pausing while the opening is being written holds it; resume delivers it exactly once', async () => {
    const { getDb } = await import('../src/server/db.js');
    const { createRoom } = await import('../src/server/room.js');
    const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
    const { GameLoop } = await import('../src/server/game-loop.js');
    const db = getDb();
    const { campaignId, joinCode } = createRoom(db, { name: `Opening pause ${++seq}`, dmPreset: 'chronicler', systemId: 'fate-core' });
    // The premise is in the opening prompt, so the token makes the stub hold
    // exactly that request for 2.5s — long enough to pause inside it.
    const token = slowLlmToken();
    const seed: WorldSeed = { ...IMPROVISED_SEED, premise: `${IMPROVISED_SEED.premise} ${token}` };
    setWorldSeed(db, campaignId, seed);
    markSeedAccepted(db, campaignId);
    seedWorld(db, campaignId, seed);
    const lizId = `liz-p-${seq}`;
    db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)')
      .run(lizId, campaignId, JSON.stringify(LIZ), JSON.stringify(STATE));
    const state: RoomState = {
      campaignId, joinCode, phase: 'playing', currentScene: 0, currentTurn: 0,
      initiativeOrder: [], activeCharacterId: null,
      awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null,
    };

    const broadcasts: ServerMessage[] = [];
    const loop = new GameLoop(db, campaignId, (m) => broadcasts.push(m), () => {}, state);
    const running = loop.start().catch(() => {});
    const waitFor = async (cond: () => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 25)); }
    };
    try {
      await waitFor(() => harness.receivedBodies.some(b => b.includes(token)), 15_000);
      expect(loop.pause('host')).toBe(true);

      const narrationsAtPause = broadcasts.filter(m => m.type === 'narration').length;
      await new Promise(r => setTimeout(r, 3_500)); // past when the held opening would have answered
      expect(broadcasts.filter(m => m.type === 'narration').length).toBe(narrationsAtPause);
      expect(broadcasts.some(m => m.type === 'action-proposals' || m.type === 'action-taken')).toBe(false);

      expect(loop.resume()).toBe(true);
      await waitFor(() => broadcasts.some(m => m.type === 'whisper-prompt'), 30_000);
      // Liz is introduced exactly once — the opening was redone, not doubled.
      const intros = broadcasts.filter(m => m.type === 'narration' && (m as any).text.includes('Liz'));
      expect(intros.length).toBeGreaterThan(0);
      const introTexts = intros.map(m => (m as any).text);
      expect(new Set(introTexts).size).toBe(introTexts.length);
    } finally {
      loop.stop();
      await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
    }
  }, 60_000);
});
