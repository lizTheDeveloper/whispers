// Round 13 in play (live WXKC2C, the LLM mocked with its lines):
//  1. The pen toss: the ruling removed the Pen from Liz and added it for Biz,
//     its prose said "a soft arc of black plastic … landing perfectly in Biz’s
//     waiting palm", and the add was dropped — the pen vanished.
//  2. The hand-back "guides it firmly into Liz’s waiting palm" (no state
//     changes in the ruling) left Liz without the pen.
//  3. "the golden paperclip glinting in Biz’s pocket" never gave Biz the paperclip.
//  4. "Slip a bottle cap into Mom's palm": the ruling moved the whole stack,
//     and prose tracking added a second "Bottle Cap".
//  5. The character prompts never had the party's items or what was gone:
//     "I use the granola bar to bribe Unit 7-G…", "I swallow the metal cap…".
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';

type Msg = { role: string; content: string };
const calls: Array<{ messages: Msg[] }> = [];

const TOSS_ACTION = 'Reach into my tote bag, pull out the pen, and toss it gently toward Biz through the narrowing gap.';
const TOSS = "Liz’s toss is gentle, a soft arc of black plastic that glides through the narrowing air with a faint, satisfying whoosh, landing perfectly in Biz’s waiting palm. From the other side, Biz’s voice comes back, slightly muffled but steady, “Got it, Mom. I’m right here.”";
const HANDBACK_ACTION = "Reach up and place the pen directly into Mom's hand so she can sign Form 7-C.";
const HANDBACK = "Biz’s small hand closes around the cool, smooth barrel of the pen and guides it firmly into Liz’s waiting palm, the metal clicking softly against her knuckles with a reassuring, metallic chime. Liz’s fingers close around the instrument with the practiced ease of a woman who has signed thousands of invoices, and she looks down at the pen, then at her son, a quiet, steady warmth settling in her chest.";
const CALM_ACTION = 'Step firmly between Biz and Ms. Hark, holding up the pen to signal calm.';
const PAPERCLIP = "Liz's pen taps a sharp, rhythmic code against her palm, the click cutting through the dusty air like a metronome in a silent room. Ms. Hark’s pen stops mid-tap, her eyes flickering between Liz’s unflappable stance and the golden paperclip glinting in Biz’s pocket, before she sighs with the heavy resignation of a woman who has been interrupted by a tax audit.";
const CAP_ACTION = "Slip a bottle cap into Mom's palm and squeeze her hand, smiling up at her to anchor her against the rain.";
const CAP_RULING = "Biz slips a bottle cap into Liz's palm and squeezes her hand. Liz’s eyes widen, and for a heartbeat, the rain seems to pause, her expression softening into a fierce, protective smile as she feels the promise in that grip.";
const BRIBE = 'I use the granola bar to bribe Unit 7-G into sliding away from the door.';
const SWALLOW = 'I swallow the metal cap and ask Barnaby Twist where the Archive is calling us.';

const ids = { liz: '', biz: '' };
type Ruling = { narration: string; stateChanges: (i: typeof ids) => unknown[] };
type Script = { liz: string; biz: string; lizRuling: Ruling; bizRuling: Ruling; lizOptions?: string[]; bizOptions?: string[] };
const quiet: Ruling = { narration: 'Ms. Hark blinks slowly at the clock.', stateChanges: () => [] };
let script: Script = { liz: 'I read the fine print.', biz: 'I look at the clock.', lizRuling: quiet, bizRuling: quiet };

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push(opts);
    const all = opts.messages.map(m => m.content).join('\n');
    const isLiz = all.includes('You ARE Liz');
    if (all.includes('OPENING OF THE ADVENTURE')) return { narration: 'The Intake Atrium hums.', introductions: [], currentLocationName: '' };
    if (all.includes('Choose your action now')) {
      return { chosenAction: isLiz ? script.liz : script.biz, spokenWords: null, innerThought: 'Stay close.', whisperedInfluence: 'ignored', trustDelta: 0 };
    }
    if (all.includes('Propose 2-4 actions')) {
      const extra = (isLiz ? script.lizOptions : script.bizOptions) ?? [];
      return { actions: [...extra, 'I ask Barnaby Twist which form sends two people home.', 'I tell my companion to stay close.'].map(description => ({ description, reasoning: 'r' })) };
    }
    if (all.includes('FATE resolution steps')) {
      const ruling = /ACTING CHARACTER[^\n]*\n?\s*Liz/.test(all) || all.includes('ACTING CHARACTER (narrate THEIR action, not another party member\'s): Liz') ? script.lizRuling : script.bizRuling;
      return { diceExpression: '4dF', difficulty: 1, skill: 'Notice', outcome: 'success', narration: ruling.narration, stateChanges: ruling.stateChanges(ids) };
    }
    if (all.includes('Pacing:')) return { narration: 'The atrium hums.', currentLocationName: '', activeNpcs: [], isSceneEnd: false };
    if (all.includes('Summarize')) return { summary: 'The atrium spun.' };
    return 'ok';
  }),
}));

process.env.WHISPER_WINDOW_MS = '30';
process.env.PACE_MAX_MS = '0';

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r13i-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

const LIZ_SHEET: CharacterDefinition = {
  name: 'Liz', highConcept: 'Unflappable Accountant Mom', trouble: 'I worry about Biz too much',
  aspects: ['Always carries a tote bag', 'Tote bag contains a granola bar', 'Tote bag contains a pen', 'Resourceful and calm under pressure'],
  personality: 'Calm, resourceful, and protective.', backstory: 'A mom from Ohio misfiled by the Bureau.', skills: { Investigate: 3, Rapport: 3, Will: 2, Notice: 2 }, stunts: ['Fine Print'], pronouns: 'she/her',
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
    premise: 'Liz and Biz have been misfiled into the Bureau of Unprocessed Things.',
    locations: [{ name: 'The Intake Atrium', description: 'Mahogany and falling paper.', terrain: 'indoor' }, { name: 'The Overflowing Archive', description: 'Shelves that breathe.', terrain: 'indoor' }],
    npcs: [{ name: 'Ms. Prudence Hark', description: 'Clipboard.', disposition: 'stern', motivation: 'Order.', pronouns: 'she/her' }, { name: 'Clerk Barnaby Twist', description: 'Red bow tie.', disposition: 'anxious', motivation: 'The right form.', pronouns: 'he/him' }],
    plotHooks: ['The exit log is unsigned.'],
    items: [{ name: 'Golden Paperclip', description: 'Shiny object on floor' }, { name: 'Red-ink Pen', description: "Hark's hovering writing tool" }, { name: 'Bottle Cap', description: 'Warm metal personal effect' }],
  };
  const { campaignId, joinCode } = room.createRoom(db, { name: `R13 ${tag}`, dmPreset: 'chronicler', systemId: 'fate-core' });
  setWorldSeed(db, campaignId, seed);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed);
  ids.liz = `liz-r13-${campaignId}`;
  ids.biz = `biz-r13-${campaignId}`;
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

async function round(tag: string, s: Script, inventories?: { liz?: string[]; biz?: string[] }) {
  const { campaignId, joinCode } = await setUp(tag);
  if (inventories?.liz) setInventory(ids.liz, inventories.liz);
  if (inventories?.biz) setInventory(ids.biz, inventories.biz);
  script = s;
  const out = await playOneRound(campaignId, joinCode);
  return { ...out, liz: inventoryOf(ids.liz), biz: inventoryOf(ids.biz) };
}

describe('round 13 in play: items', () => {
  it('1. the pen toss: remove from Liz + add for Biz, prose "black plastic … in Biz’s waiting palm": Biz has the pen', async () => {
    const r = await round('toss', {
      liz: TOSS_ACTION, biz: 'I look at the clock.',
      lizRuling: { narration: TOSS, stateChanges: i => [{ characterId: i.liz, field: 'inventory', action: 'remove', value: 'Pen' }, { characterId: i.biz, field: 'inventory', action: 'add', value: 'Pen' }] },
      bizRuling: quiet,
    });
    expect(r.liz).not.toContain('Pen');
    expect(r.biz).toContain('Pen');
  }, 40_000);

  it('1b. the same toss with only the remove in the ruling: the pen still moves to Biz', async () => {
    const r = await round('toss-remove-only', {
      liz: TOSS_ACTION, biz: 'I look at the clock.',
      lizRuling: { narration: TOSS, stateChanges: i => [{ characterId: i.liz, field: 'inventory', action: 'remove', value: 'Pen' }] },
      bizRuling: quiet,
    });
    expect(r.liz).not.toContain('Pen');
    expect(r.biz).toContain('Pen');
  }, 40_000);

  it('2. the hand-back "guides it firmly into Liz’s waiting palm" gives Liz the pen back', async () => {
    const r = await round('handback', {
      liz: 'I read the fine print on Form 7-C.', biz: HANDBACK_ACTION,
      lizRuling: quiet, bizRuling: { narration: HANDBACK, stateChanges: () => [] },
    }, { liz: ['Tote bag'], biz: ['Bottle caps', 'Pen'] });
    expect(r.liz).toContain('Pen');
    expect(r.biz).not.toContain('Pen');
  }, 40_000);

  it('3. "the golden paperclip glinting in Biz’s pocket" puts it in Biz\'s inventory', async () => {
    const r = await round('paperclip', {
      liz: CALM_ACTION, biz: 'I look at the clock.',
      lizRuling: { narration: PAPERCLIP, stateChanges: () => [] }, bizRuling: quiet,
    });
    expect(r.biz).toContain('Golden Paperclip');
  }, 40_000);

  it('4. one bottle cap slipped into Mom\'s palm: Liz has one cap, Biz keeps the stack, no duplicates', async () => {
    const r = await round('cap', {
      liz: 'I look at the clock.', biz: CAP_ACTION,
      lizRuling: quiet,
      bizRuling: { narration: CAP_RULING, stateChanges: i => [{ characterId: i.biz, field: 'inventory', action: 'remove', value: 'Bottle caps' }, { characterId: i.liz, field: 'inventory', action: 'add', value: 'Bottle caps' }] },
    }, { liz: ['Tote bag'] });
    expect(r.biz).toEqual(['Bottle caps']);
    expect(r.liz).toEqual(['Tote bag', 'Bottle cap']);
  }, 40_000);

  describe('5. the characters\' own prompts carry the items, and options never reach for gone things', () => {
    let r: Awaited<ReturnType<typeof round>>;
    beforeAll(async () => {
      r = await round('gone', {
        liz: 'I read the fine print.', biz: 'I look at the clock.',
        lizRuling: quiet, bizRuling: quiet, lizOptions: [BRIBE], bizOptions: [SWALLOW],
      }, { liz: ['Tote bag', 'Pen'] });
    }, 40_000);

    it('proposal and decision prompts list each member\'s things and the gone granola bar', () => {
      for (const task of ['Propose 2-4 actions', 'Choose your action now']) {
        const p = r.prompts.find(x => x.includes(task) && x.includes('You ARE Liz'));
        expect(p, task).toBeDefined();
        const onHand = p!.match(/<items_on_hand>([\s\S]*?)<\/items_on_hand>/)?.[1] ?? '';
        expect(onHand).toMatch(/^- Liz \(you\): Tote bag, Pen$/m);
        expect(onHand).toMatch(/^- Biz: Bottle caps$/m);
        const gone = p!.match(/<items_not_on_hand>([\s\S]*?)<\/items_not_on_hand>/)?.[1] ?? '';
        expect(gone).toMatch(/Granola bar/);
        expect(gone).toMatch(/never propose or choose/i);
        expect(p).toMatch(/held, carried, shown and handed over — not eaten/);
      }
      const biz = r.prompts.find(x => x.includes('Choose your action now') && x.includes('You ARE Biz'));
      expect(biz).toMatch(/^- Biz \(you\): Bottle caps$/m);
      expect(biz).toMatch(/Granola bar/);
    });

    it('"I use the granola bar to bribe…" and "I swallow the metal cap…" never reach the table', () => {
      const offered = r.seen.filter(m => m.type === 'action-proposals').flatMap(m => m.actions as string[]);
      expect(offered.length).toBeGreaterThan(0);
      expect(offered).not.toContain(BRIBE);
      expect(offered).not.toContain(SWALLOW);
    });
  });
});
