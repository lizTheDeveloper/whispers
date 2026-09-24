// Round 11 in play: the live Z9JKG2 lines run through the game loop (the LLM
// mocked with them), so the wiring is tested, not only the pure guards.
//  1. Characters made live through the one approval path start with their kit
//     (Liz's tote bag, granola bar and pen; Biz's bottle caps), aspects kept.
//  2. Marni "sliding a blank form across the polished wood" in Liz's ruling
//     lets that ruling's add of "The Provisional Exit Form" stand.
//  3. "Liz hurls the pen …, and Biz snatches it out of the air": Biz holds
//     the pen, Liz no longer does.
//  4. Liz's own "Scoop up the Fading Form and tuck it into my tote bag",
//     confirmed by her ruling's "The Fading Form in her grip shudders":
//     Liz holds it.
//  5. The DM sees every PC's inventory each turn, "nothing" included, and is
//     told the lists are the truth.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';

type Msg = { role: string; content: string };
const calls: Array<{ messages: Msg[] }> = [];

const MARNI_SLIDES_FORM = "Clerk Marni adjusts their saucer-sized spectacles, the lenses catching the amber light, and taps a rubber stamp the size of a dinner plate against the counter with a rhythmic, hollow thud. \"A 'Recall' is a very specific category, Liz, and quite frankly, a bit messy for a Tuesday,\" Marni chirps, sliding a blank form across the polished wood while the air around them smells faintly of ozone and old ink. \"However, since you are holding a child who is currently trying to lick the counter, I will grant you a 'Provisional Exit'—provided you can find the correct filing cabinet before the next chime.\"";
const PEN_THROWN = 'Liz hurls the pen with the precise, desperate arc of a mother who has been up since five a.m., and Biz snatches it out of the air with a sharp *fwip* that cuts through the lemon-scented fog. But the order is already losing the war; Biz’s eyes are locked on the distant glint of The Shiny Object, and as they bring the pen to the fading form, their hand trembles, scratching out a signature that looks less like a name and more like a small, jagged hiccup.';
const FORM_IN_HER_GRIP = 'The Fading Form in her grip shudders, its ink thinning to a faint violet haze that smells distinctly of lavender and regret.';
const ODO_LANDS = 'A heavy, papery rustle cuts through the silence as Odo the Owl descends from the high ledgers, their parchment-colored feathers ruffling like the pages of an ancient book, and lands with a soft *thump* on the counter beside the Fading Form.';

const ids = { liz: '', biz: '' };

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push(opts);
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('OPENING OF THE ADVENTURE')) return { narration: 'The Intake Hall hums.', introductions: [], currentLocationName: '' };
    if (all.includes('Choose your action now')) {
      return all.includes('You ARE Liz')
        ? { chosenAction: 'Scoop up the Fading Form and tuck it into my tote bag, then step forward to Marni, asking for the home form.', spokenWords: 'Excuse me, Clerk Marni. We need to go home. Which form do we fill out to leave?', innerThought: 'Home.', whisperedInfluence: 'ignored', trustDelta: 0 }
        : { chosenAction: 'Catch the pen Mom throws and sign the form.', spokenWords: 'Got it, Mom!', innerThought: 'Shiny.', whisperedInfluence: 'ignored', trustDelta: 0 };
    }
    if (all.includes('Propose 2-4 actions')) return { actions: [{ description: 'I read the fine print', reasoning: 'r' }, { description: 'I ask Marni', reasoning: 'r' }] };
    if (all.includes('FATE resolution steps')) {
      return all.includes('ACTING CHARACTER (narrate THEIR action, not another party member\'s): Liz')
        ? { diceExpression: '4dF', difficulty: 1, skill: 'Notice', outcome: 'success', narration: `${MARNI_SLIDES_FORM} ${FORM_IN_HER_GRIP}`, stateChanges: [{ characterId: ids.liz, field: 'inventory', action: 'add', value: 'The Provisional Exit Form' }] }
        : { diceExpression: '4dF', difficulty: 1, skill: 'Notice', outcome: 'success', narration: PEN_THROWN, stateChanges: [] };
    }
    if (all.includes('Pacing:')) return { narration: ODO_LANDS, currentLocationName: '', activeNpcs: [], isSceneEnd: false };
    if (all.includes('Summarize')) return { summary: 'The hall spun.' };
    return 'ok';
  }),
}));

process.env.WHISPER_WINDOW_MS = '30';
process.env.PACE_MAX_MS = '0';

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r11-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

const LIZ_SHEET: CharacterDefinition = {
  name: 'Liz', highConcept: 'Tired but resourceful mom navigating bureaucratic reality with a pen and a granola bar', trouble: 'She worries too much about Biz',
  aspects: ['Great at paperwork', 'Very good at finding lost things', 'Carrying a tote bag with a granola bar and a pen'],
  personality: 'Tired, resourceful', backstory: '', skills: { Notice: 3, Will: 3 }, stunts: ['Found It!'], pronouns: 'she/her',
  relationships: [{ to: 'Biz', relation: 'child', address: 'Biz' }],
};
const BIZ_SHEET: CharacterDefinition = {
  name: 'Biz', highConcept: 'Shiny-Obsessed 10-Year-Old Explorer', trouble: 'Wanders off after anything shiny',
  aspects: ['Pocket full of bottle caps', 'Eager to show finds to Mom'], personality: 'Super curious', backstory: '',
  skills: { Notice: 3, Athletics: 3 }, stunts: ['Tiny and Quick'], age: 10, pronouns: 'they/them',
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

describe('round 11 in play: items', () => {
  let prompts: string[] = [];
  let startLiz: string[] = [];
  let startBiz: string[] = [];
  beforeAll(async () => {
    const { campaignId, joinCode } = await setUp();
    startLiz = inventoryOf(ids.liz);
    startBiz = inventoryOf(ids.biz);
    ({ prompts } = await playOneRound(campaignId, joinCode));
  }, 40_000);

  it('1. the kit from character creation is the starting inventory; the aspects stay', () => {
    expect(startLiz).toEqual(['Tote bag', 'Granola bar', 'Pen']);
    expect(startBiz).toEqual(['Bottle caps']);
    expect(definitionOf(ids.liz).aspects).toContain('Carrying a tote bag with a granola bar and a pen');
    expect(definitionOf(ids.biz).aspects).toContain('Pocket full of bottle caps');
  });

  it('2. the form Marni slid across the counter in Liz\'s ruling is Liz\'s', () => {
    expect(inventoryOf(ids.liz)).toContain('The Provisional Exit Form');
  });

  it('3. the pen Liz threw is Biz\'s now, and no longer Liz\'s', () => {
    expect(inventoryOf(ids.biz)).toContain('Pen');
    expect(inventoryOf(ids.liz)).not.toContain('Pen');
  });

  it('4. Liz\'s declared scoop, confirmed by "The Fading Form in her grip", puts it in her inventory', () => {
    expect(inventoryOf(ids.liz)).toContain('The Fading Form');
  });

  it('5. every ruling and narration prompt carries each PC\'s inventory and the rule that it is the truth', () => {
    const rulings = prompts.filter(p => p.includes('FATE resolution steps'));
    const beats = prompts.filter(p => p.includes('Pacing:'));
    expect(rulings.length).toBeGreaterThanOrEqual(2);
    expect(beats.length).toBeGreaterThanOrEqual(1);
    for (const p of [...rulings, ...beats]) {
      const block = p.match(/<items_on_hand>([\s\S]*?)<\/items_on_hand>/)?.[1] ?? '';
      expect(block).toMatch(/^- Liz: [^\n]*Granola bar/m);
      expect(block).toMatch(/^- Biz: [^\n]*Bottle caps/m);
      expect(block).toMatch(/never have it turn up again/);
    }
  });

  it('5b. an empty inventory is stated as "nothing", not left out', async () => {
    const { itemsOnHandBlock } = await import('../src/server/agents/dm.js');
    const block = itemsOnHandBlock([{ name: 'Liz', inventory: [] }, { name: 'Biz', inventory: ['Pen'] }]);
    expect(block).toMatch(/^- Liz: nothing$/m);
    expect(block).toMatch(/^- Biz: Pen$/m);
  });
});
