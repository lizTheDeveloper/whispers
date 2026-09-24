// Round 13 in play: the live WXKC2C lines run through the game loop (the LLM
// mocked with them), so the wiring is tested, not only the pure guards.
//  1. Every prompt that can mention the party carries Biz's pronouns and
//     "never son, daughter, boy or girl".
//  2. What the table sees: "her son" / "the boy" / "its gaze" for Biz fixed,
//     "Mrs. Miller" is Liz, "forget you exist" softened, an empty spoken line
//     dropped, Biz's own "swallows us whole" thought softened.
//  3. The ending: a bleak epilogue and bleak reflections are asked for once
//     more; what is kept is softened; Biz calls Liz "Mom" in theirs.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';

type Msg = { role: string; content: string };
const calls: Array<{ kind: 'llm' | 'prose'; messages: Msg[] }> = [];

const LIZ_RULING = 'Liz’s fingers close around the pen, and she looks down at it, then at her son, a quiet, steady warmth settling in her chest. Clerk Barnaby Twist squeaks, "Hold your horses, Mrs. Miller! The filing system will simply... forget you exist!"';
const BIZ_RULING = 'As Biz keeps its gaze locked on the shiny object, the air grows warm. Liz’s steady hand on Biz’s shoulder grounds the boy, who stops chewing the bottle cap.';
const BLEAK_EPILOGUE = 'Liz and Biz stand in the violet ink, leaving them technically in Ms. Hark’s queue until the ink dries.';
const HOPEFUL_EPILOGUE = 'Liz and Biz walk out of the Intake Atrium together, a stamped form in Biz’s pocket and the queue behind them.';
let epilogueCalls = 0;
const reflectionCalls: Record<string, number> = { Liz: 0, Biz: 0 };

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ kind: 'llm', messages: opts.messages });
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('OPENING OF THE ADVENTURE')) return { arrival: '', narration: 'The Intake Atrium sighs politely underfoot.', introductions: [], currentLocationName: 'The Intake Atrium' };
    if (all.includes('Choose your action now')) {
      return all.includes('You ARE Liz')
        ? { chosenAction: 'Hold the pen out and ask Barnaby for Form 7-C, calmly.', spokenWords: 'Mr. Twist, which form do we need?', innerThought: 'Paperwork.', whisperedInfluence: 'ignored', trustDelta: 0 }
        : { chosenAction: 'Reach up and place the pen directly into Mom\'s hand so she can sign.', spokenWords: '""', innerThought: 'I need to get out of this office before Unit 7-G swallows us whole.', whisperedInfluence: 'ignored', trustDelta: 0 };
    }
    if (all.includes('Propose 2-4 actions')) return { actions: [{ description: 'I look around', reasoning: 'r' }, { description: 'I ask Barnaby', reasoning: 'r' }] };
    if (all.includes('FATE resolution steps')) {
      const liz = all.includes('ACTING CHARACTER (narrate THEIR action, not another party member\'s): Liz');
      return { diceExpression: '4dF', difficulty: 0, skill: 'Notice', outcome: 'success', narration: liz ? LIZ_RULING : BIZ_RULING, stateChanges: [] };
    }
    if (all.includes('Pacing:')) return { narration: 'Unit 7-G hums a low, baritone tune.', currentLocationName: 'The Intake Atrium', activeNpcs: ['Clerk Barnaby Twist'], isSceneEnd: false };
    if (all.includes('You extract episodic memories')) return { memories: [{ type: 'social', content: 'I handed Mom the pen.', emotionalValence: 0, importance: 0.9 }] };
    if (all.includes('Write ONE plain sentence')) return 'I saw them hand over the pen.';
    if (all.includes('Summarize')) return { summary: 'The atrium sighed.' };
    return 'ok';
  }),
  callProse: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ kind: 'prose', messages: opts.messages });
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('closing reflection')) {
      const who = all.includes('You are Biz') ? 'Biz' : 'Liz';
      const n = ++reflectionCalls[who]!;
      if (who === 'Biz') {
        return n === 1
          ? 'SPOKEN: "We are still in the queue, Liz, because the ink is sticky."\nTHOUGHT: We are stuck here.'
          : 'SPOKEN: "Come on, Liz, let\'s go home."\nTHOUGHT: I am glad we are together.';
      }
      // Liz's stays bleak both times: the softened first one is kept.
      return 'SPOKEN: "Hold on to that bottle cap, Biz."\nTHOUGHT: I am grateful Biz is safe, even if we are stuck here until the violet puddle dries.';
    }
    if (all.includes('epilogue')) return ++epilogueCalls === 1 ? BLEAK_EPILOGUE : HOPEFUL_EPILOGUE;
    return 'ok';
  }),
}));

process.env.WHISPER_WINDOW_MS = '30';
process.env.PACE_MAX_MS = '0';

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r13-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

const LIZ_SHEET: CharacterDefinition = {
  name: 'Liz', highConcept: 'Unflappable Accountant Mom', trouble: 'I worry about Biz too much',
  aspects: ['Tote bag contains a pen'], personality: 'Calm', backstory: '', skills: { Investigate: 3, Rapport: 3 }, stunts: [], pronouns: 'she/her',
  relationships: [{ to: 'Biz', relation: 'kid', address: 'Biz' }],
};
const BIZ_SHEET: CharacterDefinition = {
  name: 'Biz', highConcept: 'Curious Kid Collector', trouble: 'Wanders off after anything shiny',
  aspects: ['A pocket full of bottle caps'], personality: 'Curious', backstory: '', skills: { Notice: 3, Stealth: 3 }, stunts: [], age: 10, pronouns: 'they/them',
  relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }],
};

let seen: any[] = [];
let owned: any[] = [];
let prompts: Array<{ kind: string; text: string }> = [];

beforeAll(async () => {
  const room = await import('../src/server/room.js');
  const { makeCharacterLive } = await import('../src/server/character-live.js');
  const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
  const seed = {
    premise: 'Liz and Biz have arrived in Overage because of a clerical error.',
    locations: [{ name: 'The Intake Atrium', description: 'Paper rain.', terrain: 'indoor' }, { name: 'The Overflowing Archive', description: 'Stacks.', terrain: 'indoor' }],
    npcs: [
      { name: 'Clerk Barnaby Twist', description: 'A nervous clerk with a red bow tie.', disposition: 'anxious', motivation: null, pronouns: 'he/him' },
      { name: 'Ms. Prudence Hark', description: 'A small woman in a violet suit.', disposition: 'Formally polite', motivation: null, pronouns: 'she/her' },
      { name: 'Unit 7-G', description: 'A filing cabinet with a face.', disposition: 'opinionated', motivation: null, pronouns: 'it/its' },
    ],
    plotHooks: [],
    items: [{ name: 'The Golden Paperclip', description: 'Shiny.' }],
  };
  const created = room.createRoom(db, { name: 'R13 play', dmPreset: 'chronicler', systemId: 'fate-core' });
  const campaignId = created.campaignId;
  setWorldSeed(db, campaignId, seed as any);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed as any);
  for (const [id, definition, playerName] of [[`liz-r13-${campaignId}`, LIZ_SHEET, 'Liz'], [`biz-r13-${campaignId}`, BIZ_SHEET, 'Biz']] as const) {
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
    loop = new GameLoop(db, campaignId, on, () => {}, gameState as any, (_id: string, m: any) => { owned.push(m); on(m); });
  });
  const running = loop.start().catch(e => console.error('LOOP FAILED', e));
  await Promise.race([done, new Promise(r => setTimeout(r, 20_000))]);
  await new Promise(r => setTimeout(r, 200));
  await loop.endGame();
  await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
  prompts = calls.map(c => ({ kind: c.kind, text: c.messages.map(m => m.content).join('\n') }));
}, 40_000);

const promptsWith = (marker: string) => prompts.filter(p => p.text.includes(marker)).map(p => p.text);
const carriesBiz = (p: string) => {
  expect(p).toContain('Biz: they/them');
  for (const w of ['son', 'daughter', 'boy', 'girl']) expect(p).toMatch(new RegExp(`\\b${w}\\b`));
};

describe('round 13 in play: Biz\'s pronouns and nouns reach every prompt', () => {
  it('the opening, narration and rulings', () => {
    expect(promptsWith('OPENING OF THE ADVENTURE').length).toBe(1);
    const dm = [...promptsWith('OPENING OF THE ADVENTURE'), ...promptsWith('Pacing:'), ...promptsWith('FATE resolution steps')];
    expect(dm.length).toBeGreaterThanOrEqual(2);
    for (const p of dm) carriesBiz(p);
  });

  it('the characters\' proposals and decisions', () => {
    const agent = [...promptsWith('Propose 2-4 actions'), ...promptsWith('Choose your action now')];
    expect(agent.length).toBeGreaterThanOrEqual(2);
    // Liz's prompts talk about Biz; Biz's own name their pronouns too.
    for (const p of agent.filter(t => t.includes('You ARE Liz'))) carriesBiz(p);
  });

  it('scene summaries (read back into every later prompt)', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    const { castPronounLine } = await import('../src/server/npc-pronouns.js');
    const before = calls.length;
    await new DmAgent(db).summarizeScene([{ role: 'dm', content: 'Biz hands Mom the pen.', timestamp: 0 } as any], ['Liz', 'Biz'], '', castPronounLine([{ name: 'Liz', pronouns: 'she/her' }, { name: 'Biz', pronouns: 'they/them' }], []));
    const p = calls.slice(before).map(c => c.messages.map(m => m.content).join('\n')).find(t => t.includes('Summarize TTRPG scenes'));
    expect(p).toBeDefined();
    carriesBiz(p!);
  });

  it('both memory writers', () => {
    const mem = [...promptsWith('You extract episodic memories'), ...promptsWith('Write ONE plain sentence')];
    expect(mem.length).toBeGreaterThanOrEqual(2);
    for (const p of mem) carriesBiz(p);
  });

  it('the epilogue and the closing reflections', () => {
    const ending = [...promptsWith('session epilogues'), ...promptsWith('closing reflection')];
    expect(ending.length).toBeGreaterThanOrEqual(3);
    for (const p of ending) carriesBiz(p);
  });
});

describe('round 13 in play: what the table sees', () => {
  it('Liz\'s ruling: "her son" is "her kid", "Mrs. Miller" is Liz, and nobody is forgotten out of existence', () => {
    const r = seen.find(m => m.type === 'resolution' && m.text.includes('pen'));
    expect(r.text).toContain('then at her kid,');
    expect(r.text).toContain('"Hold your horses, Liz!');
    expect(r.text).not.toMatch(/Miller|forget you exist/);
  });

  it('Biz\'s ruling: "their gaze" and "the kid"', () => {
    const r = seen.find(m => m.type === 'resolution' && m.text.includes('shiny object'));
    expect(r.text).toContain('As Biz keeps their gaze locked');
    expect(r.text).toContain('grounds the kid, who');
  });

  it('Biz\'s empty spoken line ("") is no line', () => {
    const act = seen.find(m => m.type === 'action-taken' && m.characterName === 'Biz' && m.action.includes('pen'));
    expect(act.spokenWords).toBeNull();
  });

  it('Biz\'s own thought — "before Unit 7-G swallows us whole" — is gentle too', () => {
    const t = owned.find(m => m.type === 'character-thought' && m.characterName === 'Biz');
    expect(t.innerThought).not.toMatch(/swallow/);
  });
});

describe('round 13 in play: a gentle ending that lands', () => {
  it('the bleak epilogue was asked for again, and the hopeful one is what the table reads', () => {
    expect(epilogueCalls).toBe(2);
    const ep = seen.find(m => m.type === 'narration' && m.isEpilogue);
    expect(ep.text).toBe(HOPEFUL_EPILOGUE);
  });

  it('Biz\'s bleak reflection was asked for again; theirs calls Liz "Mom"', () => {
    expect(reflectionCalls.Biz).toBe(2);
    const r = seen.find(m => m.type === 'action-taken' && m.characterName === 'Biz' && String(m.action).startsWith('[Final reflection]'));
    expect(r.spokenWords).toBe('Come on, Mom, let\'s go home.');
  });

  it('Liz\'s stayed bleak on the second ask: the first is kept, softened', () => {
    expect(reflectionCalls.Liz).toBe(2);
    const r = seen.find(m => m.type === 'action-taken' && m.characterName === 'Liz' && String(m.action).startsWith('[Final reflection]'));
    expect(r.action).toContain('waiting here until the violet puddle dries');
    expect(r.action).not.toMatch(/stuck/);
  });
});
