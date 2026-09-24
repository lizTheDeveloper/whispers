// Round 17 in play (live 5YHBZS, the LLM mocked with its lines). See
// r17-items.test.ts for the pure pieces.
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
type Script = { liz: string; biz: string; lizRuling: Ruling; bizRuling: Ruling; beat?: Ruling & { location?: string; npcs?: string[] }; options?: string[] };
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
    if (all.includes('Propose 2-4 actions')) return { actions: (script.options ?? ['I ask Clerk Ozymandias which form sends us home.', 'I tell my companion to stay close.']).map(description => ({ description, reasoning: 'r' })) };
    if (all.includes('FATE resolution steps')) {
      const ruling = all.includes('ACTING CHARACTER (narrate THEIR action, not another party member\'s): Liz') ? script.lizRuling : script.bizRuling;
      return { diceExpression: '4dF', difficulty: 1, skill: 'Notice', outcome: 'success', narration: ruling.narration, stateChanges: ruling.stateChanges?.(ids) ?? [], ...(ruling.itemMoves ? { itemMoves: ruling.itemMoves } : {}) };
    }
    if (all.includes('Pacing:')) {
      const beat = script.beat ?? { narration: 'The lobby hums.' };
      return { narration: beat.narration, currentLocationName: (beat as any).location ?? '', activeNpcs: (beat as any).npcs ?? [], isSceneEnd: false, ...(beat.itemMoves ? { itemMoves: beat.itemMoves } : {}) };
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
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r17i-'));
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
    items: [{ name: 'The Pen of Perpetual Pondering', description: 'A pen that hums.' }, { name: 'Granola Bar', description: 'Sentimental snack token' }, { name: 'Silver Key', description: 'Shiny key' }, { name: 'Brass Button', description: 'Warm, humming.' }],
  };
  const { campaignId, joinCode } = room.createRoom(db, { name: `R17 ${tag}`, dmPreset: 'chronicler', systemId: 'fate-core' });
  setWorldSeed(db, campaignId, seed);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed);
  ids.liz = `liz-r17-${campaignId}`;
  ids.biz = `biz-r17-${campaignId}`;
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


const SWEEP_ACTION = "Sweep Biz's loose bottle cap into my tote bag pocket while turning back to apologize to the Humming Oak Door.";
const SWEEP_RULING = 'The door’s humming drops from a sharp G-sharp to a low, satisfied hum that vibrates in her chest, but as she takes Biz’s hand, a sudden draft from the missing manual whips her hair across her face, carrying the scent of wet ink and ozone. "The apology is accepted, but the manual\'s draft is still circulating," Prune states dryly, "so consider the next corridor a bit... breezy."';

describe('round 17 in play', () => {
  it('2. the phantom cap: Biz → Liz with no cap in Liz\'s ruling moves nothing', async () => {
    const r = await round('phantom-cap', {
      liz: SWEEP_ACTION, biz: 'I look at the clock.',
      lizRuling: { narration: SWEEP_RULING, itemMoves: [{ item: 'Bottle cap', from: 'Biz', to: 'Liz' }] },
      bizRuling: quiet,
    }, { liz: ['Tote bag', 'Bottle caps ×2', 'Pen'], biz: ['Bottle caps'] });
    expect(r.liz).toEqual(['Tote bag', 'Bottle caps ×2', 'Pen']);
    expect(r.biz).toEqual(['Bottle caps']);
  }, 40_000);

  it('4. "Missing Manual" named as present is not filed as an NPC', async () => {
    const r = await round('manual', {
      liz: 'I read the fine print.', biz: 'I look at the clock.', lizRuling: quiet, bizRuling: quiet,
      beat: { narration: 'A draft from the missing manual riffles the forms on the counter.', location: 'The Lobby of First Impressions', npcs: ['Missing Manual', 'Clerk Ozymandias'] },
    });
    const row = db.prepare('SELECT name FROM entities WHERE campaign_id = ? AND name = ?').get(r.campaignId, 'Missing Manual');
    expect(row).toBeUndefined();
  }, 40_000);

  it('5. an option that has Biz hold the brass button Biz does not hold is dropped', async () => {
    const r = await round('button', {
      liz: 'I read the fine print.', biz: 'I look at the clock.', lizRuling: quiet, bizRuling: quiet,
      options: ['Tell Biz to hold the brass button steady while I read the slot.', 'Ask Clerk Ozymandias which form sends us home.'],
    }, { liz: ['Tote bag', 'Pen'], biz: ['Bottle caps'] });
    const offered = r.seen.filter(m => m.type === 'action-proposals' && m.characterName === 'Liz').flatMap(m => m.actions as string[]);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.some(a => /brass button/.test(a))).toBe(false);
  }, 40_000);

  it('6. the DM is shown plain things in lowercase', async () => {
    const r = await round('case', { liz: 'I read the fine print.', biz: 'I look at the clock.', lizRuling: quiet, bizRuling: quiet }, { liz: ['Tote bag', 'Granola bar', 'Pen'], biz: ['Bottle caps'] });
    const ruling = r.prompts.find(p => p.text.includes('FATE resolution steps'))!;
    expect(ruling.text).toContain('- Liz: tote bag, granola bar, pen');
  }, 40_000);
});
