// Round 18 in play and in the prompts (live 39PF4D, the LLM mocked with its
// lines). See r18-misc.test.ts for the pure pieces.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';

type Msg = { role: string; content: string };
const calls: Array<{ kind: 'llm' | 'prose'; messages: Msg[] }> = [];

const SWEEP_ACTION = 'Lunge to catch the sliding tote bag, scoop up the spilled bottle caps, and secure them inside.';
const SWEEP = 'Liz lunges, her body a blur of efficient motion as she snags the tote bag’s strap with one hand while the other sweeps a frantic arc across the tilting glass, catching the scattered bottle caps with a satisfying, metallic clatter. The bag is secured against her hip.';
const SLIP_ACTION = 'Slip a second bottle cap into Mom\'s tote bag pocket while asking Mabel about the bow tie knot.';
const SLIP = 'Biz slips a second bottle cap into the tote bag pocket and asks, "Mabel, if the knot is wrong, how do we know the right one? Mom, hold the form flat so it doesn\'t turn into a bird again." Liz’s hand tightens on the Mismatched Form, flattening the paper with a protective grip.';
const HORROR_FEEDBACK = 'The character fits the tone of a grounded, bureaucratic horror campaign where an ordinary person is thrust into an uncanny administrative nightmare.';

const ids = { liz: '', biz: '' };
type Ruling = { narration: string; itemMoves?: unknown[] };
type Script = { liz: string; biz: string; lizRuling: Ruling; bizRuling: Ruling; beat?: { narration: string; location?: string; npcs?: string[] }; options?: string[] };
const quiet: Ruling = { narration: 'Mabel hums at the clock.' };
let script: Script = { liz: 'I read the fine print.', biz: 'I look at the clock.', lizRuling: quiet, bizRuling: quiet };

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ kind: 'llm', messages: opts.messages });
    const all = opts.messages.map(m => m.content).join('\n');
    const isLiz = all.includes('You ARE Liz');
    if (all.includes('character sheet validation API')) return { approved: true, feedback: HORROR_FEEDBACK, modifications: null };
    if (all.includes('character creation API')) return { reply: 'Picture your character in the Botanical Garden — what would they notice?', definition: null };
    if (all.includes('OPENING OF THE ADVENTURE')) return { narration: 'The Lobby hums.', introductions: [], currentLocationName: '' };
    if (all.includes('Choose your action now')) {
      return { chosenAction: isLiz ? script.liz : script.biz, spokenWords: null, innerThought: 'Stay close.', whisperedInfluence: 'ignored', trustDelta: 0 };
    }
    if (all.includes('Propose 2-4 actions')) return { actions: (script.options ?? ['I ask Mabel which form sends us home.', 'I tell my companion to stay close.']).map(description => ({ description, reasoning: 'r' })) };
    if (all.includes('FATE resolution steps')) {
      const ruling = all.includes('ACTING CHARACTER (narrate THEIR action, not another party member\'s): Liz') ? script.lizRuling : script.bizRuling;
      return { diceExpression: '4dF', difficulty: 1, skill: 'Notice', outcome: 'success', narration: ruling.narration, stateChanges: [], ...(ruling.itemMoves ? { itemMoves: ruling.itemMoves } : {}) };
    }
    if (all.includes('Pacing:')) {
      const beat = script.beat ?? { narration: 'The lobby hums.' };
      return { narration: beat.narration, currentLocationName: beat.location ?? '', activeNpcs: beat.npcs ?? [], isSceneEnd: false };
    }
    if (all.includes('You extract episodic memories')) return { memories: [{ type: 'social', content: 'I kept close to my family.', emotionalValence: 0, importance: 0.9 }] };
    if (all.includes('Summarize')) return { summary: 'The lobby spun.' };
    return 'ok';
  }),
  callProse: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ kind: 'prose', messages: opts.messages });
    return 'Liz and Biz walk out of the lobby together.';
  }),
}));

process.env.WHISPER_WINDOW_MS = '30';
process.env.PACE_MAX_MS = '0';

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r18m-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

const LIZ_SHEET: CharacterDefinition = {
  name: 'Liz', highConcept: 'Unflappable Accountant Mom', trouble: 'Worries about Biz too much',
  aspects: ['Tote bag contains a granola bar', 'Tote bag contains a pen'], personality: 'Calm.', backstory: 'A mom from Ohio.',
  skills: { Investigate: 3, Rapport: 3, Will: 1, Notice: 1 }, stunts: ['Fine Print'], pronouns: 'she/her',
  relationships: [{ to: 'Biz', relation: 'kid', address: 'Biz' }],
};
const BIZ_SHEET: CharacterDefinition = {
  name: 'Biz', highConcept: 'Curious Kid Collector', trouble: 'Wanders off after anything shiny',
  aspects: ['A pocket full of bottle caps', 'Mom is my home base'], personality: '', backstory: '',
  skills: { Notice: 3, Stealth: 3 }, stunts: ['Tiny and Quick'], age: 10, pronouns: 'they/them',
  relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }],
};

const SEED = {
  premise: 'Liz and Biz have been misfiled into a gentle Municipal District of Unfinished Business.',
  locations: [{ name: 'The Department of Lost Things', description: 'Glass floors.', terrain: 'indoor' }, { name: 'The Filing Cabinet House', description: 'Cabinets.', terrain: 'indoor' }],
  npcs: [
    { name: 'Mabel', description: 'A clerk with a bow tie.', disposition: 'kind', motivation: 'Order.', pronouns: 'she/her' },
    { name: 'The Dust Bunny', description: 'A velvety dust bunny.', disposition: 'shy', motivation: 'Crumbs.', pronouns: 'it/its' },
    { name: 'The Pigeon', description: 'A pigeon.', disposition: 'grumpy', motivation: 'Seeds.', pronouns: 'it/its' },
  ],
  plotHooks: ['The form is mismatched.'],
  items: [{ name: 'The Mismatched Form', description: 'A form.' }],
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
  const { campaignId, joinCode } = room.createRoom(db, { name: `R18 ${tag}`, dmPreset: 'chronicler', systemId: 'fate-core' });
  setWorldSeed(db, campaignId, SEED);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, SEED);
  ids.liz = `liz-r18-${campaignId}`;
  ids.biz = `biz-r18-${campaignId}`;
  for (const [id, definition, playerName] of [[ids.liz, LIZ_SHEET, 'Liz'], [ids.biz, BIZ_SHEET, 'Biz']] as const) {
    const session = room.createSession(db, { campaignId, joinCode, playerName, isHost: playerName === 'Liz' });
    const pending = { id, campaignId, joinCode, sessionToken: session.token, playerName, definition, aiFeedback: 'ok' };
    room.savePendingCharacter(db, pending);
    makeCharacterLive(db, pending);
  }
  return { campaignId, joinCode };
}

async function playOneRound(campaignId: string, joinCode: string): Promise<{ seen: any[]; prompts: Array<{ kind: string; text: string }> }> {
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
  return { seen, prompts: calls.slice(before).map(c => ({ kind: c.kind, text: c.messages.map(m => m.content).join('\n') })) };
}

async function round(tag: string, s: Script, inventories?: { liz?: string[]; biz?: string[] }, before?: (campaignId: string) => Promise<void>) {
  const { campaignId, joinCode } = await setUp(tag);
  if (inventories?.liz) setInventory(ids.liz, inventories.liz);
  if (inventories?.biz) setInventory(ids.biz, inventories.biz);
  if (before) await before(campaignId);
  script = s;
  const out = await playOneRound(campaignId, joinCode);
  return { ...out, campaignId, liz: inventoryOf(ids.liz), biz: inventoryOf(ids.biz) };
}

const LOST_THINGS = 'The Department of Lost Things';
const capLyingHere = async (campaignId: string) => {
  const { WorldBible } = await import('../src/server/world-bible.js');
  const wb = new WorldBible(db);
  const loc = wb.getLocationByName(campaignId, LOST_THINGS)!;
  wb.placeItem(campaignId, 'Bottle cap', { scene: 0, locationId: loc.id });
};

describe('round 18 in play', () => {
  it('2. Liz sweeps up Biz\'s dropped cap with no itemMove: her Bottle caps ×2 become ×3, and the cap is hers', async () => {
    const r = await round('sweep', {
      liz: SWEEP_ACTION, biz: 'I look at the clock.',
      lizRuling: { narration: SWEEP },
      bizRuling: quiet,
      beat: { narration: 'The glass floor tilts gently.', location: LOST_THINGS, npcs: ['Mabel'] },
    }, { liz: ['Tote bag', 'The Mismatched Form', 'Pen', 'Bottle caps ×2'], biz: ['Bottle caps'] }, capLyingHere);
    expect(r.liz).toContain('Bottle caps ×3');
    expect(r.biz).toEqual(['Bottle caps']);
    const row = db.prepare('SELECT holder_id FROM items WHERE campaign_id = ? AND name = ?').get(r.campaignId, 'Bottle cap') as { holder_id: string | null };
    expect(row.holder_id).toBe(ids.liz);
  }, 40_000);

  it('2. …and when the actor holds none, the cap is simply theirs', async () => {
    const r = await round('sweep-none', {
      liz: SWEEP_ACTION, biz: 'I look at the clock.',
      lizRuling: { narration: SWEEP },
      bizRuling: quiet,
      beat: { narration: 'The glass floor tilts gently.', location: LOST_THINGS, npcs: ['Mabel'] },
    }, { liz: ['Tote bag', 'Pen'], biz: ['Bottle caps'] }, capLyingHere);
    expect(r.liz.some(i => /^Bottle cap/.test(i))).toBe(true);
  }, 40_000);

  it('2. "Card Door" and "Filing Cabinets" named as present, silent, are not filed as NPCs', async () => {
    const r = await round('door', {
      liz: 'I read the fine print.', biz: 'I look at the clock.', lizRuling: quiet, bizRuling: quiet,
      beat: { narration: 'The Card Door stands shut beside a row of filing cabinets.', location: LOST_THINGS, npcs: ['Card Door', 'Filing Cabinets', 'Mabel'] },
    });
    for (const name of ['Card Door', 'Filing Cabinets']) {
      expect(db.prepare('SELECT name FROM entities WHERE campaign_id = ? AND name = ?').get(r.campaignId, name)).toBeUndefined();
    }
  }, 40_000);

  it('3. the echoed ruling never opens mid-quote, and Mom in speech is never turned into Liz', async () => {
    const r = await round('echo', {
      liz: 'I read the fine print.', biz: SLIP_ACTION,
      lizRuling: quiet, bizRuling: { narration: SLIP },
    });
    const texts = r.seen.filter(m => m.type === 'resolution').map(m => m.text as string);
    const biz = texts.find(t => /Mismatched Form/.test(t))!;
    expect(biz).toBeDefined();
    expect(biz).not.toMatch(/^Liz, hold/);
    expect(biz).not.toMatch(/^[^"“]*["”]/);
  }, 40_000);

  it('3. "A small, velvety The Dust Bunny" reads "A small, velvety Dust Bunny"', async () => {
    const r = await round('bunny', {
      liz: 'I read the fine print.', biz: 'I look at the clock.', lizRuling: quiet, bizRuling: quiet,
      beat: { narration: 'A small, velvety The Dust Bunny trotted out from behind a row of humming filing cabinets.', location: LOST_THINGS, npcs: ['The Dust Bunny'] },
    });
    const narr = r.seen.filter(m => m.type === 'narration').map(m => m.text as string).join('\n');
    expect(narr).toContain('A small, velvety Dust Bunny trotted out');
  }, 40_000);

  it('3. options: "Circled the exit code…" is offered as "Circle the exit code…", and the prompt asks for the present', async () => {
    const r = await round('options', {
      liz: 'I read the fine print.', biz: 'I look at the clock.', lizRuling: quiet, bizRuling: quiet,
      options: ['Circled the exit code in blue ink while asking Mabel for the pen cap.', 'Ask The Pigeon to clarify the queue shift.'],
    });
    const offered = r.seen.filter(m => m.type === 'action-proposals').flatMap(m => m.actions as string[]);
    expect(offered).toContain('Circle the exit code in blue ink while asking Mabel for the pen cap.');
    expect(offered.some(a => /^Circled/.test(a))).toBe(false);
    const prompt = r.prompts.find(p => p.text.includes('Propose 2-4 actions'))!.text;
    expect(prompt).toMatch(/present tense/i);
  }, 40_000);

  it('3. the memory writers are told to keep who did what', async () => {
    const r = await round('memory', { liz: 'I read the fine print.', biz: 'I look at the clock.', lizRuling: quiet, bizRuling: quiet });
    const memory = r.prompts.find(p => p.text.includes('You extract episodic memories'))!.text;
    expect(memory).toMatch(/whoever did it/);
    expect(memory).toContain('Mabel: she/her');
  }, 40_000);
});

describe('round 18: setup', () => {
  it('1. another player\'s interview draft is at the table, with their pronouns, before it is finished', async () => {
    const room = await import('../src/server/room.js');
    const { getOrCreateInterview, setInterviewDraft, listTableCharacters } = await import('../src/server/character-interview.js');
    const { campaignId, joinCode } = room.createRoom(db, { name: 'R18 drafts', dmPreset: 'chronicler', systemId: 'fate-core' });
    const liz = room.createSession(db, { campaignId, joinCode, playerName: 'Liz', isHost: true });
    const biz = room.createSession(db, { campaignId, joinCode, playerName: 'Biz', isHost: false });
    getOrCreateInterview(db, campaignId, liz.token);
    const bizInterview = getOrCreateInterview(db, campaignId, biz.token);
    setInterviewDraft(db, bizInterview.id, { ...BIZ_SHEET, stunts: [], skills: {} } as CharacterDefinition);
    const table = listTableCharacters(db, campaignId, liz.token);
    expect(table.map(c => [c.name, c.pronouns])).toEqual([['Biz', 'they/them']]);
  });

  it('1. the interview at a gentle table: every example scenario is gentle; another table is not told', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    const ask = async (gentlePeril: boolean) => {
      const before = calls.length;
      await new DmAgent(db).interviewForCharacter({
        systemId: 'fate-core', preset: 'chronicler', playerName: 'Liz', influences: [], seed: null,
        history: [{ role: 'user', content: "I'm Liz (she/her), a mom. My kid Biz is 10." }], unmet: [],
        tableCharacters: [{ name: 'Biz', highConcept: 'Curious Kid Collector', pronouns: 'they/them' }], gentlePeril,
      });
      return calls.slice(before).map(c => c.messages[0]!.content).join('\n');
    };
    const gentle = await ask(true);
    expect(gentle).toContain('GENTLE TABLE');
    expect(gentle).toMatch(/coiling/);
    expect(gentle).toContain('Biz is never "son"');
    expect(gentle).toMatch(/"her son's needs"/);
    expect(await ask(false)).not.toContain('GENTLE TABLE');
  });

  it('1. the approval: the table\'s register and premise, a player character never an NPC, and "horror" never shown at a gentle table', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    const before = calls.length;
    const v = await new DmAgent(db).validateCharacter(LIZ_SHEET, 'fate-core', { gentlePeril: true, premise: SEED.premise });
    const prompt = calls.slice(before).map(c => c.messages.map(m => m.content).join('\n')).join('\n');
    expect(prompt).toContain('PLAYER CHARACTER');
    expect(prompt).toContain('GENTLE PERIL register');
    expect(prompt).toContain(SEED.premise);
    expect(v.feedback).not.toMatch(/horror|nightmare|uncanny/i);
    const plain = await new DmAgent(db).validateCharacter(LIZ_SHEET, 'fate-core');
    expect(plain.feedback).toBe(HORROR_FEEDBACK);
  });
});
