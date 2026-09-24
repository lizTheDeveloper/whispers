// Round 14 in play (live 7RAAQ7, the LLM mocked with its lines): the DM's
// itemMoves are the record; prose is a cross-check. See r14-items.test.ts
// for the pure pieces.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';

type Msg = { role: string; content: string };
const calls: Array<{ kind: 'llm' | 'prose'; messages: Msg[] }> = [];

const OFFER = 'Mama Pigeon hops forward, her tiny talons clicking a rapid staccato against the linoleum as she offers a granola bar to Biz, her eyes wide with anxious anticipation. \'The ghosts are very polite,\' she whispers, tilting her head until her beak nearly touches Liz’s tote bag.';
const EATEN = 'Biz holds the granola bar up with both hands, the wrapper crinkling loudly in the quiet corridor, and watches as Clerk Ozymandias’s ink-stained fingers twitch toward it with surprising speed. The clerk takes the snack, and for a moment his fogged spectacles fog further as he takes a bite, the sound of crunching oats filling the room like rain on a tin roof.';
const HOLDS_AGAIN = 'Biz holds the granola bar up with both hands, and Mama Pigeon clucks approvingly.';
const TOTE = 'Liz spots the Lanyard of Unassigned Color peeking out from behind a stack of unfiled memos, but her tote bag snagged on the doorframe, tearing a long strip of canvas and scattering her pen across the metal floor.';
const SLIP = 'The pigeon recoils, a high-pitched squeak of offense vibrating through the counter, and the Silver Key slips from Biz\'s fingers to clatter loudly against the metal surface.';
const SCOOP_ACTION = 'I scoop up the Silver Key from the counter, tuck it into my pocket, and pull Biz close to my side, facing Mama Pigeon with a calm, apologetic smile.';
const SCOOP = 'Liz’s apologetic tone softens the air, and Mama Pigeon’s indignation deflates with a long, huffing sigh that smells faintly of peppermint and old library dust.';
const PONDER = 'The Pen of Perpetual Pondering in Liz\'s hand begins to hum, a low, vibrating drone that rattles the glass on the nearby kiosk.';

const ids = { liz: '', biz: '' };
type Ruling = { narration: string; stateChanges?: (i: typeof ids) => unknown[]; itemMoves?: unknown[] };
type Script = { liz: string; biz: string; lizRuling: Ruling; bizRuling: Ruling; beat?: Ruling };
const quiet: Ruling = { narration: 'Button squeaks at the clock.' };
let script: Script = { liz: 'I read the fine print.', biz: 'I look at the clock.', lizRuling: quiet, bizRuling: quiet };

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ kind: 'llm', messages: opts.messages });
    const all = opts.messages.map(m => m.content).join('\n');
    const isLiz = all.includes('You ARE Liz');
    if (all.includes('OPENING OF THE ADVENTURE')) return { narration: 'The Lobby hums.', introductions: [], currentLocationName: '' };
    if (all.includes('Choose your action now')) {
      return { chosenAction: isLiz ? script.liz : script.biz, spokenWords: null, innerThought: 'Stay close.', whisperedInfluence: 'ignored', trustDelta: 0 };
    }
    if (all.includes('Propose 2-4 actions')) return { actions: ['I ask Clerk Ozymandias which form sends us home.', 'I tell my companion to stay close.'].map(description => ({ description, reasoning: 'r' })) };
    if (all.includes('FATE resolution steps')) {
      const ruling = all.includes('ACTING CHARACTER (narrate THEIR action, not another party member\'s): Liz') ? script.lizRuling : script.bizRuling;
      return { diceExpression: '4dF', difficulty: 1, skill: 'Notice', outcome: 'success', narration: ruling.narration, stateChanges: ruling.stateChanges?.(ids) ?? [], ...(ruling.itemMoves ? { itemMoves: ruling.itemMoves } : {}) };
    }
    if (all.includes('Pacing:')) {
      const beat = script.beat ?? { narration: 'The lobby hums.' };
      return { narration: beat.narration, currentLocationName: '', activeNpcs: [], isSceneEnd: false, ...(beat.itemMoves ? { itemMoves: beat.itemMoves } : {}) };
    }
    if (all.includes('You extract episodic memories')) return { memories: [{ type: 'social', content: 'I kept close to my family.', emotionalValence: 0, importance: 0.9 }] };
    if (all.includes('Summarize')) return { summary: 'The lobby spun.' };
    return 'ok';
  }),
  callProse: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ kind: 'prose', messages: opts.messages });
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('closing reflection')) return 'SPOKEN: "Let\'s go home."\nTHOUGHT: We are together.';
    return 'Liz and Biz walk out of the lobby together, the queue behind them.';
  }),
}));

process.env.WHISPER_WINDOW_MS = '30';
process.env.PACE_MAX_MS = '0';

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r14i-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

const LIZ_SHEET: CharacterDefinition = {
  name: 'Liz', highConcept: 'Unflappable Accountant Mom', trouble: 'I worry about Biz too much',
  aspects: ['Always carries a tote bag', 'Tote bag contains a granola bar', 'Tote bag contains a pen', 'Resourceful and calm under pressure'],
  personality: 'Calm.', backstory: 'A mom from Ohio.', skills: { Investigate: 3, Rapport: 3, Will: 2, Notice: 2 }, stunts: ['Fine Print'], pronouns: 'she/her',
  relationships: [{ to: 'Biz', relation: 'kid', address: 'Biz' }],
};
const BIZ_SHEET: CharacterDefinition = {
  name: 'Biz', highConcept: 'Curious Kid Collector', trouble: 'Wanders off after anything shiny',
  aspects: ['Pocket full of bottle caps', 'Mom is my home base'], personality: '', backstory: '',
  skills: { Notice: 3, Stealth: 3, Athletics: 2, Rapport: 2 }, stunts: ['Tiny and Quick'], age: 10, pronouns: 'they/them',
  relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }],
};

const inventoryOf = (id: string) => (JSON.parse((db.prepare('SELECT state FROM characters WHERE id = ?').get(id) as { state: string }).state).inventory as string[]);
const setInventory = (id: string, inventory: string[]) => {
  const state = JSON.parse((db.prepare('SELECT state FROM characters WHERE id = ?').get(id) as { state: string }).state);
  state.inventory = inventory;
  db.prepare('UPDATE characters SET state = ? WHERE id = ?').run(JSON.stringify(state), id);
};

async function setUp(tag: string): Promise<{ campaignId: string; joinCode: string }> {
  const room = await import('../src/server/room.js');
  const { makeCharacterLive } = await import('../src/server/character-live.js');
  const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
  const seed = {
    premise: 'Liz and Biz have been misfiled into a very gentle bureaucracy.',
    locations: [{ name: 'The Lobby of First Impressions', description: 'Obsidian floors.', terrain: 'indoor' }, { name: 'The Queue of Gentle Stalls', description: 'Stalls.', terrain: 'indoor' }],
    npcs: [
      { name: 'Clerk Ozymandias', description: 'Sliding glasses.', disposition: 'mild', motivation: 'Order.', pronouns: 'he/him' },
      { name: 'Mama Pigeon', description: 'A pigeon in a suit.', disposition: 'anxious', motivation: 'Help.', pronouns: 'she/her' },
      { name: 'Button', description: 'A bouncing button.', disposition: 'chaotic', motivation: 'Shiny.', pronouns: 'it/its' },
    ],
    plotHooks: ['The Lanyard is unassigned.'],
    // "Granola Bar" is what the extractor made of the party's bar live; "Silver Key" a world item.
    items: [{ name: 'The Pen of Perpetual Pondering', description: 'A pen that hums.' }, { name: 'Granola Bar', description: 'Sentimental snack token' }, { name: 'Silver Key', description: 'Shiny key' }],
  };
  const { campaignId, joinCode } = room.createRoom(db, { name: `R14 ${tag}`, dmPreset: 'chronicler', systemId: 'fate-core' });
  setWorldSeed(db, campaignId, seed);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed);
  ids.liz = `liz-r14-${campaignId}`;
  ids.biz = `biz-r14-${campaignId}`;
  for (const [id, definition, playerName] of [[ids.liz, LIZ_SHEET, 'Liz'], [ids.biz, BIZ_SHEET, 'Biz']] as const) {
    const session = room.createSession(db, { campaignId, joinCode, playerName, isHost: playerName === 'Liz' });
    const pending = { id, campaignId, joinCode, sessionToken: session.token, playerName, definition, aiFeedback: 'ok' };
    room.savePendingCharacter(db, pending);
    makeCharacterLive(db, pending);
  }
  return { campaignId, joinCode };
}

async function playOneRound(campaignId: string, joinCode: string, opts: { end?: boolean } = {}): Promise<{ seen: any[]; prompts: Array<{ kind: string; text: string }> }> {
  const { GameLoop } = await import('../src/server/game-loop.js');
  const gameState = { campaignId, joinCode, phase: 'playing' as const, currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null };
  const seen: any[] = [];
  const before = calls.length;
  let loop!: InstanceType<typeof GameLoop>;
  let resolutions = 0;
  const done = new Promise<void>((resolve) => {
    const on = (m: any) => { seen.push(m); if (m.type === 'resolution' && ++resolutions === 2) setImmediate(() => { if (!opts.end) loop.stop(); resolve(); }); };
    loop = new GameLoop(db, campaignId, on, () => {}, gameState as any, (_id: string, m: any) => on(m));
  });
  const running = loop.start().catch(e => console.error('LOOP FAILED', e));
  await Promise.race([done, new Promise(r => setTimeout(r, 20_000))]);
  if (opts.end) { await new Promise(r => setTimeout(r, 200)); await loop.endGame(); }
  loop.stop();
  await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
  return { seen, prompts: calls.slice(before).map(c => ({ kind: c.kind, text: c.messages.map(m => m.content).join('\n') })) };
}

async function round(tag: string, s: Script, inventories?: { liz?: string[]; biz?: string[] }, opts: { end?: boolean } = {}) {
  const { campaignId, joinCode } = await setUp(tag);
  if (inventories?.liz) setInventory(ids.liz, inventories.liz);
  if (inventories?.biz) setInventory(ids.biz, inventories.biz);
  script = s;
  const out = await playOneRound(campaignId, joinCode, opts);
  return { ...out, campaignId, liz: inventoryOf(ids.liz), biz: inventoryOf(ids.biz) };
}

const worldHolder = (campaignId: string, name: string) => db.prepare('SELECT holder_id FROM items WHERE campaign_id = ? AND name = ? COLLATE NOCASE').get(campaignId, name) as { holder_id: string | null } | undefined;

describe('round 14 in play: the DM\'s itemMoves are the record', () => {
  it('1. "Mama Pigeon … offers a granola bar to Biz" (no moves in the beat): Liz keeps her bar', async () => {
    const r = await round('offer', { liz: 'I read the fine print.', biz: 'I look at the clock.', lizRuling: quiet, bizRuling: quiet, beat: { narration: OFFER } });
    expect(r.liz).toContain('Granola bar');
    expect(r.biz).not.toContainEqual(expect.stringMatching(/granola/i));
  }, 40_000);

  it('1b. the same beat with itemMoves [] and Biz taking it in the ruling from Mama Pigeon: Biz has one, Liz keeps hers', async () => {
    const r = await round('offer-moves', {
      liz: 'I read the fine print.', biz: 'Take the granola bar from Mama Pigeon and step toward the Chalk-Dust Threshold.',
      lizRuling: quiet,
      bizRuling: { narration: 'Biz accepts the granola bar, the wrapper crinkling loudly in the sudden silence.', itemMoves: [{ item: 'Granola bar', from: 'Mama Pigeon', to: 'Biz' }] },
      beat: { narration: OFFER, itemMoves: [] },
    });
    expect(r.liz).toContain('Granola bar');
    expect(r.biz.filter(i => /granola bar/i.test(i))).toHaveLength(1);
  }, 40_000);

  it('2. eaten by the clerk (itemMoves): gone, and "Biz holds the granola bar up" in the next beat never brings it back', async () => {
    const r = await round('eaten', {
      liz: 'I read the fine print.', biz: 'Give the granola bar to Mr. Ozymandias.',
      lizRuling: { narration: HOLDS_AGAIN },
      bizRuling: { narration: EATEN, itemMoves: [{ item: 'Granola Bar', from: 'Biz', to: 'Clerk Ozymandias' }] },
    }, { liz: ['Tote bag', 'Pen'], biz: ['Bottle caps', 'Granola bar'] });
    expect(r.biz).toEqual(['Bottle caps']);
    expect(r.liz).toEqual(['Tote bag', 'Pen']);
  }, 40_000);

  it('2b. the live shape: the ruling removed it in stateChanges and its own prose "holds the granola bar up" — not re-added as "Granola Bar"', async () => {
    const r = await round('eaten-legacy', {
      liz: 'I read the fine print.', biz: 'Give the granola bar to Mr. Ozymandias.',
      lizRuling: { narration: HOLDS_AGAIN },
      bizRuling: { narration: EATEN, stateChanges: i => [{ characterId: i.biz, field: 'inventory', action: 'remove', value: 'Granola bar' }] },
    }, { liz: ['Tote bag', 'Pen'], biz: ['Bottle caps', 'Granola bar'] });
    expect(r.biz).toEqual(['Bottle caps']);
    expect(r.liz).toEqual(['Tote bag', 'Pen']);
  }, 40_000);

  it('3. the tote snags and tears: the tote stays, the pen goes to the floor and shows as a world item', async () => {
    const r = await round('tote', {
      liz: 'I reach for the Lanyard.', biz: 'I look at the clock.',
      lizRuling: { narration: TOTE, itemMoves: [{ item: 'Pen', from: 'Liz', to: 'world' }], stateChanges: i => [{ characterId: i.liz, field: 'inventory', action: 'remove', value: 'Tote bag' }] },
      bizRuling: quiet,
    });
    expect(r.liz).toEqual(['Tote bag', 'Granola bar']);
    expect(worldHolder(r.campaignId, 'Pen')).toEqual({ holder_id: null });
  }, 40_000);

  it('4. the key slips from Biz\'s fingers (beat), Liz scoops it up (ruling): Liz has it, Biz does not', async () => {
    const r = await round('key', {
      liz: SCOOP_ACTION, biz: 'I squeeze Mom\'s hand.',
      lizRuling: { narration: SCOOP, itemMoves: [{ item: 'Silver Key', from: 'world', to: 'Liz' }] },
      bizRuling: quiet,
      beat: { narration: SLIP, itemMoves: [{ item: 'Silver Key', from: 'Biz', to: 'world' }] },
    }, { liz: ['Pen'], biz: ['Bottle caps', 'Silver Key'] });
    expect(r.liz).toEqual(['Pen', 'Silver Key']);
    expect(r.biz).toEqual(['Bottle caps']);
    expect(worldHolder(r.campaignId, 'Silver Key')?.holder_id).toBe(ids.liz);
  }, 40_000);

  describe('5. the DM\'s prompts: exact inventories, world items held by nobody, the moves rule', () => {
    let r: Awaited<ReturnType<typeof round>>;
    beforeAll(async () => {
      r = await round('prompts', { liz: 'I read the fine print.', biz: 'I look at the clock.', lizRuling: { narration: PONDER, itemMoves: [] }, bizRuling: quiet }, { liz: ['Tote bag', 'Pen'], biz: ['Bottle caps', 'Pen'] });
    }, 40_000);
    it('rulings and narration beats', () => {
      const dm = r.prompts.filter(p => p.text.includes('FATE resolution steps') || p.text.includes('Pacing:'));
      expect(dm.length).toBeGreaterThanOrEqual(3);
      for (const p of dm) {
        expect(p.text).toMatch(/^- Liz: Tote bag, Pen$/m);
        expect(p.text).toMatch(/^- The Pen of Perpetual Pondering — not held by anyone in the party$/m);
        expect(p.text).toMatch(/"Pen" \((?:Liz, Biz|Biz, Liz)\) and "The Pen of Perpetual Pondering" are different things/);
        expect(p.text).toMatch(/"itemMoves"/);
      }
    });
    it('"The Pen of Perpetual Pondering in Liz\'s hand" (moves: []) gives Liz no second pen', () => {
      expect(r.liz).toEqual(['Tote bag', 'Pen']);
    });
  });

  describe('6. the ending: reflections and the epilogue get what each holds and what is gone', () => {
    let r: Awaited<ReturnType<typeof round>>;
    beforeAll(async () => {
      r = await round('ending', {
        liz: 'I read the fine print.', biz: 'Give the granola bar to Mr. Ozymandias.',
        lizRuling: quiet,
        bizRuling: { narration: EATEN, itemMoves: [{ item: 'Granola bar', from: 'Biz', to: 'Clerk Ozymandias' }] },
      }, { liz: ['Tote bag', 'Pen'], biz: ['Bottle caps', 'Granola bar'] }, { end: true });
    }, 40_000);
    it('both prompts', () => {
      const reflections = r.prompts.filter(p => p.kind === 'prose' && p.text.includes('closing reflection'));
      const epilogue = r.prompts.filter(p => p.kind === 'prose' && p.text.includes('session epilogues'));
      expect(reflections.length).toBe(2);
      expect(epilogue.length).toBeGreaterThanOrEqual(1);
      for (const p of [...reflections, ...epilogue]) {
        expect(p.text).toMatch(/^- Liz: Tote bag, Pen$/m);
        expect(p.text).toMatch(/^- Biz: Bottle caps$/m);
        expect(p.text).toMatch(/Gone[^\n]*Granola bar/);
      }
    });
  });
});
