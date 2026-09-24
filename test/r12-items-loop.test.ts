// Round 12 in play (live 7MJXE5, the LLM mocked with its lines):
//  1. Liz's "Tote bag contains a granola bar" / "Tote bag contains a pen" are
//     in her starting inventory with the canvas tote.
//  3. With the granola bar gone (eaten by the goose), Liz's "I jam the
//     granola bar from my tote into…" reaches the DM's ruling with a note
//     that it is gone, so the ruling redirects instead of going along.
//  4. The opening (arrival, scene, per-character introductions) is told
//     what each character carries and to use nothing else — live it put a
//     coffee mug in Liz's hand and a juice box in Biz's.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';

type Msg = { role: string; content: string };
const calls: Array<{ messages: Msg[] }> = [];

const JAM_GRANOLA = "I jam the granola bar from my tote into the Shiny Pen's glint to block Pudding's view, then hiss at Biz to stay still.";

const ids = { liz: '', biz: '' };

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push(opts);
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('OPENING OF THE ADVENTURE')) return { narration: 'The Intake Hall hums.', introductions: [], currentLocationName: '' };
    if (all.includes('Choose your action now')) {
      return all.includes('You ARE Liz')
        ? { chosenAction: JAM_GRANOLA, spokenWords: 'Biz, stay still.', innerThought: 'Hide it.', whisperedInfluence: 'ignored', trustDelta: 0 }
        : { chosenAction: 'Look for shiny bottle caps under the cabinet.', spokenWords: 'Ooh!', innerThought: 'Shiny.', whisperedInfluence: 'ignored', trustDelta: 0 };
    }
    if (all.includes('Propose 2-4 actions')) return { actions: [{ description: 'I read the fine print', reasoning: 'r' }, { description: 'I ask Marni', reasoning: 'r' }] };
    if (all.includes('FATE resolution steps')) {
      return { diceExpression: '4dF', difficulty: 1, skill: 'Notice', outcome: 'success', narration: 'Pudding blinks.', stateChanges: [] };
    }
    if (all.includes('Pacing:')) return { narration: 'The atrium hums.', currentLocationName: '', activeNpcs: [], isSceneEnd: false };
    if (all.includes('Summarize')) return { summary: 'The hall spun.' };
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
  aspects: ['Always carries a canvas tote bag', 'Tote bag contains a granola bar', 'Tote bag contains a pen', 'Resourceful and calm under pressure', 'Tired but dedicated'],
  personality: 'Calm, resourceful, and protective.', backstory: 'A mom from Ohio who was misplaced in Ombrosclera due to a stapler error.', skills: { Investigate: 3, Rapport: 3, Will: 2, Notice: 2 }, stunts: ['Fine Print'], pronouns: 'she/her',
  relationships: [{ to: 'Biz', relation: 'kid', address: 'Biz' }],
};
const BIZ_SHEET: CharacterDefinition = {
  name: 'Biz', highConcept: 'Curious Kid Collector', trouble: 'Wanders off after anything shiny',
  aspects: ['Pocket full of bottle caps', 'Mom is my home base'], personality: '', backstory: '',
  skills: { Notice: 3, Stealth: 3, Athletics: 2, Rapport: 2 }, stunts: ['Tiny and Quick'], age: 10, pronouns: 'they/them',
  relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }],
};

const inventoryOf = (id: string) => (JSON.parse((db.prepare('SELECT state FROM characters WHERE id = ?').get(id) as { state: string }).state).inventory as string[]);
const definitionOf = (id: string) => JSON.parse((db.prepare('SELECT definition FROM characters WHERE id = ?').get(id) as { definition: string }).definition) as CharacterDefinition;

async function setUp(): Promise<{ campaignId: string; joinCode: string }> {
  const room = await import('../src/server/room.js');
  const { makeCharacterLive } = await import('../src/server/character-live.js');
  const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
  const seed = {
    premise: 'Liz and Biz have been stamped into the Department of Misfiled Reality.',
    locations: [{ name: 'The Intake Hall', description: 'Glass and wood.', terrain: 'indoor' }, { name: 'The Archive of Unsent Letters', description: 'Floating books.', terrain: 'indoor' }],
    npcs: [{ name: 'Clerk Marni', description: 'Saucer spectacles.', disposition: 'cheerful', motivation: 'Order.' }, { name: 'Odo the Owl', description: 'Monocle.', disposition: 'stern', motivation: 'Audit.' }],
    plotHooks: ['The ink is fading.'],
    items: [{ name: 'The Fading Form', description: 'Cream paper dissolving into mist.' }, { name: 'The Shiny Object', description: 'A glowing stone.' }],
  };
  const { campaignId, joinCode } = room.createRoom(db, { name: 'R11 play', dmPreset: 'chronicler', systemId: 'fate-core' });
  setWorldSeed(db, campaignId, seed);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed);
  ids.liz = `liz-r11-${campaignId}`;
  ids.biz = `biz-r11-${campaignId}`;
  for (const [id, definition, playerName] of [[ids.liz, LIZ_SHEET, 'Liz'], [ids.biz, BIZ_SHEET, 'Biz']] as const) {
    const session = room.createSession(db, { campaignId, joinCode, playerName, isHost: playerName === 'Liz' });
    const pending = { id, campaignId, joinCode, sessionToken: session.token, playerName, definition, aiFeedback: 'ok' };
    room.savePendingCharacter(db, pending);
    makeCharacterLive(db, pending);
  }
  return { campaignId, joinCode };
}

async function playOneRound(campaignId: string, joinCode: string): Promise<{ seen: any[]; prompts: string[] }> {
  const { GameLoop } = await import('../src/server/game-loop.js');
  const gameState = { campaignId, joinCode, phase: 'playing' as const, currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null };
  const seen: any[] = [];
  const before = calls.length;
  let loop!: InstanceType<typeof GameLoop>;
  let resolutions = 0;
  const done = new Promise<void>((resolve) => {
    const on = (m: any) => { seen.push(m); if (m.type === 'resolution' && ++resolutions === 2) setImmediate(() => { loop.stop(); resolve(); }); };
    loop = new GameLoop(db, campaignId, on, () => {}, gameState as any, (_id: string, m: any) => on(m));
  });
  const running = loop.start().catch(e => console.error('LOOP FAILED', e));
  await Promise.race([done, new Promise(r => setTimeout(r, 20_000))]);
  loop.stop();
  await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
  return { seen, prompts: calls.slice(before).map(c => c.messages.map(m => m.content).join('\n')) };
}

describe('round 12 in play: items', () => {
  let prompts: string[] = [];
  let startLiz: string[] = [];
  let startBiz: string[] = [];
  beforeAll(async () => {
    const { campaignId, joinCode } = await setUp();
    startLiz = inventoryOf(ids.liz);
    startBiz = inventoryOf(ids.biz);
    // The goose ate the granola bar before this round.
    const state = JSON.parse((db.prepare('SELECT state FROM characters WHERE id = ?').get(ids.liz) as { state: string }).state);
    state.inventory = state.inventory.filter((i: string) => i !== 'Granola bar');
    db.prepare('UPDATE characters SET state = ? WHERE id = ?').run(JSON.stringify(state), ids.liz);
    ({ prompts } = await playOneRound(campaignId, joinCode));
  }, 40_000);

  it('1. "Tote bag contains a granola bar" and "…a pen" are in the starting inventory', () => {
    expect(startLiz).toEqual(['Canvas tote bag', 'Granola bar', 'Pen']);
    expect(startBiz).toEqual(['Bottle caps']);
  });

  it('3. Liz reaching for the eaten granola bar: her ruling is told it is gone, and to redirect gently', () => {
    const ruling = prompts.find(p => p.includes('FATE resolution steps') && p.includes(JAM_GRANOLA));
    expect(ruling).toBeDefined();
    const note = ruling!.match(/<items_not_on_hand>([\s\S]*?)<\/items_not_on_hand>/)?.[1] ?? '';
    expect(note).toMatch(/Granola bar/);
    expect(note).toMatch(/gone/i);
    expect(note).toMatch(/do not refuse/i);
  });

  it('3b. Biz\'s ruling (nothing missing) carries no such note', () => {
    const ruling = prompts.find(p => p.includes('FATE resolution steps') && p.includes('Look for shiny bottle caps'));
    expect(ruling).toBeDefined();
    expect(ruling).not.toMatch(/<items_not_on_hand>/);
  });

  it('4. the opening prompt carries each character\'s items and forbids props that are not on them', () => {
    const opening = prompts.find(p => p.includes('OPENING OF THE ADVENTURE'));
    expect(opening).toBeDefined();
    const block = opening!.match(/<items_on_hand>([\s\S]*?)<\/items_on_hand>/)?.[1] ?? '';
    expect(block).toMatch(/^- Liz: Canvas tote bag, Pen$/m);
    expect(block).toMatch(/^- Biz: Bottle caps$/m);
    expect(opening).toMatch(/PROPS:/);
    expect(opening).toMatch(/introductions[^\n]*only what <items_on_hand> lists/i);
  });
});
