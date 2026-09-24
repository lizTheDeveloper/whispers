// Round 19 in play (live KAZQX3, the LLM mocked with its lines). See
// r19-items.test.ts and r19-misc.test.ts for the pure pieces.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';

type Msg = { role: string; content: string };
const calls: Array<{ kind: 'llm' | 'prose'; messages: Msg[] }> = [];

const ids = { liz: '', biz: '' };
type Ruling = { narration: string; stateChanges?: (i: typeof ids) => unknown[]; itemMoves?: unknown[] };
type Script = { liz: string; biz: string; lizRuling: Ruling; bizRuling: Ruling; beat?: Ruling; beforeBiz?: () => void };
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
      if (!isLiz) script.beforeBiz?.();
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
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r19-'));
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
      { name: 'Hazel', description: 'A kind, friendly hedgehog with spectacles perched on a very straight nose and a waistcoat full of pencils. She speaks in a low, warm voice.', disposition: 'kind', motivation: 'Order.', pronouns: 'she/her' },
      { name: 'Button', description: 'A bouncing button.', disposition: 'chaotic', motivation: 'Shiny.', pronouns: 'it/its' },
    ],
    plotHooks: ['The Lanyard is unassigned.'],
    // No world record of the party's granola bar (live KAZQX3).
    items: [{ name: 'The Pen of Perpetual Pondering', description: 'A pen that hums.' }, { name: 'Silver Key', description: 'Shiny key' }],
  };
  const { campaignId, joinCode } = room.createRoom(db, { name: `R19 ${tag}`, dmPreset: 'chronicler', systemId: 'fate-core' });
  setWorldSeed(db, campaignId, seed);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed);
  ids.liz = `liz-r19-${campaignId}`;
  ids.biz = `biz-r19-${campaignId}`;
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

const itemRow = (campaignId: string, name: string) => db.prepare('SELECT name, holder_id, properties FROM items WHERE campaign_id = ? AND name = ? COLLATE NOCASE').get(campaignId, name) as { name: string; holder_id: string | null; properties: string } | undefined;

const ROLL_OUT = 'Liz flattens the Fresh Sheet against the counter, and a single, small bottle cap rolls out of her tote bag, clattering loudly against the wooden counter.';
const LUNGE = 'Biz lunges for the rolling bottle cap, their small fingers brushing the smooth, cold metal just as it tumbles off the counter\'s edge, landing squarely in the spreading ink puddle.';

describe('round 19 in play', () => {
  it('b. one cap rolled out of Liz\'s tote, told again in Biz\'s ruling: Liz loses one, not two', async () => {
    const r = await round('twice', {
      liz: 'I unfold the Fresh Sheet on the counter.', biz: 'I lunge for the rolling bottle cap.',
      lizRuling: { narration: ROLL_OUT, itemMoves: [{ item: 'Bottle cap', from: 'Liz', to: 'world' }] },
      bizRuling: { narration: LUNGE, itemMoves: [{ item: 'Bottle cap', from: 'Liz', to: 'world' }] },
    }, { liz: ['Tote bag', 'Bottle caps ×3', 'Fresh Sheet'], biz: ['Bottle caps'] });
    expect(r.liz).toEqual(['Tote bag', 'Bottle caps ×2', 'Fresh Sheet']);
  }, 40_000);

  it('a. the cap Biz set by Mom\'s feet, picked up after the party moved on, is that cap — no new one', async () => {
    let campaign = '';
    const r = await round('carried', {
      liz: 'I keep Biz close.', biz: 'I point at the cap by Mom\'s feet.',
      lizRuling: { narration: 'Biz sets a bottle cap down by Liz\'s feet with a small, proud nod.', itemMoves: [{ item: 'Bottle cap', from: 'Biz', to: 'world' }] },
      // The scene moved on: the record has the cap at the lobby, the party elsewhere.
      beforeBiz: () => {
        const row = db.prepare("SELECT id, properties FROM items WHERE name = 'Bottle cap' AND campaign_id = (SELECT campaign_id FROM characters WHERE id = ?)").get(ids.liz) as { id: string; properties: string } | undefined;
        if (!row) return;
        campaign = row.id;
        db.prepare('UPDATE items SET properties = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.properties), locationId: 'the-lobby-behind-us' }), row.id);
      },
      bizRuling: { narration: 'Liz pockets the bottle cap Biz had set by her feet with a soft, satisfying clink.', itemMoves: [{ item: 'bottle cap', from: 'world', to: 'Liz' }] },
    }, { liz: ['Tote bag', 'Bottle caps ×2'], biz: ['Bottle caps ×3'] });
    expect(campaign).not.toBe('');
    expect(r.biz).toEqual(['Bottle caps ×2']);
    expect(r.liz).toEqual(['Tote bag', 'Bottle caps ×3']);
    const row = itemRow(r.campaignId, 'Bottle cap')!;
    expect(row.holder_id).toBe(ids.liz);
  }, 40_000);

  it('d. the granola bar pressed into Hazel\'s wing and eaten is gone from the record, not lying anywhere', async () => {
    const r = await round('eaten', {
      liz: 'Pull the granola bar from my tote bag and press it into Hazel\'s wing.', biz: 'I look at the clock.',
      lizRuling: { narration: 'The bird’s beak clicks shut around it, and her shoulders drop two inches, the frantic drumming in her chest slowing to a steady, grateful thump.', itemMoves: [{ item: 'Granola bar', from: 'Liz', to: 'Hazel' }] },
      bizRuling: quiet,
    }, { liz: ['Tote bag', 'Granola bar', 'Pen'], biz: ['Bottle caps'] });
    expect(r.liz).toEqual(['Tote bag', 'Pen']);
    const row = itemRow(r.campaignId, 'Granola bar')!;
    expect(row.holder_id).toBeNull();
    const props = JSON.parse(row.properties);
    expect(props.gone).toBe(1);
    expect(props.locationId).toBeUndefined();
  }, 40_000);

  it('3. the DM hears Hazel\'s kind with her pronouns: "Hazel (she/her, hedgehog)"', async () => {
    const r = await round('kind', { liz: 'I read the fine print.', biz: 'I look at the clock.', lizRuling: quiet, bizRuling: quiet });
    const dm = r.prompts.filter(p => p.text.includes('FATE resolution steps') || p.text.includes('Pacing:'));
    expect(dm.length).toBeGreaterThan(0);
    for (const p of dm) expect(p.text).toContain('Hazel (she/her, hedgehog)');
  }, 40_000);

  it('4b. the closing reflection is told its thought is a first-person monologue: companions by name, never "you"', async () => {
    const r = await round('reflection', { liz: 'I read the fine print.', biz: 'I look at the clock.', lizRuling: quiet, bizRuling: quiet }, undefined, { end: true });
    const reflection = r.prompts.find(p => p.text.includes('closing reflection'));
    expect(reflection).toBeDefined();
    expect(reflection!.text).toMatch(/THOUGHT is your own inner monologue/);
    expect(reflection!.text).toMatch(/never "you" or "your"/);
  }, 40_000);
});
