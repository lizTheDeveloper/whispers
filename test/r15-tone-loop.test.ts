// Round 15 in play, with the LLM mocked with the live RZBU7G lines and the
// judge mocked: a gentle table (Biz is ten) where
//  - both epilogue drafts are flagged for leaving a thread open, and the one
//    kept still said "remains open for another day" → it now closes warm;
//  - the rulings' quotes came out `in ink!', The air…` and `the word
//    "taxation.'` → tidied in what the table reads;
//  - the memory writers are told who is who (Biz stored "Liz is a child who
//    worries about me too much").
// Plus the prompts: the interview's rule for a companion in the sheet holds
// with nobody else at the table yet, and a gentle seed is drafted in the
// register.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';
import type { ToneJudge } from '../src/server/tone-gate.js';

type Msg = { role: string; content: string };
const calls: Array<{ kind: 'llm' | 'prose'; messages: Msg[] }> = [];

const INK_RULING = "Liz extends the Stamp of Clarity. He looks up, pale and flustered, and stammers, 'It is accepted! But I cannot proceed without a name in ink!', The air in the corridor suddenly feels thicker.";
const TAXATION_RULING = "Clerk 4-B nods rapidly, his voice dropping to a conspiratorial murmur. 'The tubes are in a mood today, so keep your footsteps soft; I have marked the quiet path in my notes, provided you do not mention the word \"taxation.'";
const LIMBO_EPILOGUE = 'Liz and Biz found the Biscuit Archive. The question of who misfiled the original form remains unanswered, and the biscuit shelves still hold their breath for the next sorting.';
const LIVE_EPILOGUE = 'Archivist Mildred’s paper-skinned face settled into a warm, tired smile as the biscuit shelves exhaled a long, flour-dusted sigh. Liz stood firm between the groaning Pneumatic Tubes, holding Biz’s hand tight. The question of the stuck pressure valve remains open for another day, but for now, the amber light on the audit clock glows steady and calm, bathing Liz and Biz in a soft, golden warmth that feels exactly like home.';
const counts = { epilogue: 0 };

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ kind: 'llm', messages: opts.messages });
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('OPENING OF THE ADVENTURE')) return { arrival: '', narration: 'The Pneumatic Post hums politely.', introductions: [], currentLocationName: 'The Pneumatic Post' };
    if (all.includes('Choose your action now')) {
      return all.includes('You ARE Liz')
        ? { chosenAction: 'Hand the Stamp of Clarity to Clerk 4-B.', spokenWords: null, innerThought: 'Paperwork.', whisperedInfluence: 'ignored', trustDelta: 0 }
        : { chosenAction: 'Ask Clerk 4-B which corridor is quiet.', spokenWords: null, innerThought: 'Shiny.', whisperedInfluence: 'ignored', trustDelta: 0 };
    }
    if (all.includes('Propose 2-4 actions')) return { actions: [{ description: 'I look around', reasoning: 'r' }, { description: 'I ask the clerk', reasoning: 'r' }] };
    if (all.includes('FATE resolution steps')) {
      const liz = all.includes('ACTING CHARACTER (narrate THEIR action, not another party member\'s): Liz');
      return { diceExpression: '4dF', difficulty: 0, skill: 'Notice', outcome: 'success', narration: liz ? INK_RULING : TAXATION_RULING, stateChanges: [] };
    }
    if (all.includes('Pacing:')) return { narration: 'The tubes hum a polite little tune.', currentLocationName: 'The Pneumatic Post', activeNpcs: ['Clerk 4-B'], isSceneEnd: false };
    if (all.includes('You extract episodic memories')) return { memories: [{ type: 'social', content: 'I held Mom\'s hand.', emotionalValence: 0, importance: 0.9 }] };
    if (all.includes('Write ONE plain sentence')) return 'I saw Liz hand over the stamp.';
    if (all.includes('Summarize')) return { summary: 'The tubes hummed.' };
    return 'ok';
  }),
  callProse: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ kind: 'prose', messages: opts.messages });
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('closing reflection')) return 'SPOKEN: "We did it!"\nTHOUGHT: Mom\'s hand is warm, and the tubes are singing us home.';
    if (all.includes('session epilogues')) {
      counts.epilogue++;
      return all.includes('A reader for this gentle table flagged') ? LIVE_EPILOGUE : LIMBO_EPILOGUE;
    }
    return 'ok';
  }),
}));

process.env.WHISPER_WINDOW_MS = '30';
process.env.PACE_MAX_MS = '0';

// The live judge flagged both epilogues; everything else passes.
// As live: the judge flagged the first draft's closing sentence and passed
// the second, which bleakEnding flagged on its own ("the stuck pressure
// valve") — one phrase each, so the second was kept, still saying "remains
// open for another day".
const judge: ToneJudge = async (text) => {
  const phrases = text.split(/(?<=[.!?])\s+/).filter(s => /remains unanswered/.test(s));
  return { flagged: phrases.length > 0, phrases };
};

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r15-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
});
afterAll(async () => {
  (await import('../src/server/game-loop.js')).GameLoop.toneJudge = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

const LIZ_SHEET: CharacterDefinition = {
  name: 'Liz', highConcept: 'Unflappable Accountant Mom', trouble: 'Worries about Biz too much',
  aspects: ['Tote bag contains a pen'], personality: 'Calm', backstory: '', skills: { Investigate: 3, Rapport: 3 }, stunts: [], pronouns: 'she/her',
  relationships: [{ to: 'Biz', relation: 'kid', address: 'Biz' }],
};
const BIZ_SHEET: CharacterDefinition = {
  name: 'Biz', highConcept: 'Curious Kid Collector', trouble: 'Wanders off after anything shiny',
  aspects: ['A pocket full of bottle caps'], personality: 'Curious', backstory: '', skills: { Notice: 3, Stealth: 3 }, stunts: [], age: 10, pronouns: 'they/them',
  relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }],
};

const seen: any[] = [];
let prompts: Array<{ kind: string; text: string }> = [];

beforeAll(async () => {
  const room = await import('../src/server/room.js');
  const { makeCharacterLive } = await import('../src/server/character-live.js');
  const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
  const seed = {
    premise: 'Liz and Biz have been misplaced into Annotatia.',
    locations: [{ name: 'The Pneumatic Post', description: 'Copper tubes.', terrain: 'indoor' }, { name: 'The Biscuit Archive', description: 'Shelves of biscuits.', terrain: 'indoor' }],
    npcs: [{ name: 'Clerk 4-B', description: 'A clerk in a bowler hat.', disposition: 'Nervous', motivation: null, pronouns: 'he/him' }],
    plotHooks: [], items: [],
  };
  const created = room.createRoom(db, { name: 'R15 play', dmPreset: 'chronicler', systemId: 'fate-core' });
  const campaignId = created.campaignId;
  setWorldSeed(db, campaignId, seed as any);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed as any);
  for (const [id, definition, playerName] of [[`liz-r15-${campaignId}`, LIZ_SHEET, 'Liz'], [`biz-r15-${campaignId}`, BIZ_SHEET, 'Biz']] as const) {
    const session = room.createSession(db, { campaignId, joinCode: created.joinCode, playerName, isHost: playerName === 'Liz' });
    const pending = { id, campaignId, joinCode: created.joinCode, sessionToken: session.token, playerName, definition, aiFeedback: 'ok' };
    room.savePendingCharacter(db, pending);
    makeCharacterLive(db, pending);
  }

  const { GameLoop } = await import('../src/server/game-loop.js');
  GameLoop.toneJudge = judge;
  const gameState = { campaignId, joinCode: created.joinCode, phase: 'playing' as const, currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null };
  let loop!: InstanceType<typeof GameLoop>;
  // Until both have acted (the turn order is not fixed).
  const both = () => seen.some(m => m.type === 'resolution' && String(m.text).includes('name in ink')) && seen.some(m => m.type === 'resolution' && String(m.text).includes('taxation'));
  const done = new Promise<void>((resolve) => {
    const on = (m: any) => { seen.push(m); if (m.type === 'resolution' && both()) setImmediate(() => resolve()); };
    loop = new GameLoop(db, campaignId, on, () => {}, gameState as any, (_id: string, m: any) => on(m));
  });
  const running = loop.start().catch(e => console.error('LOOP FAILED', e));
  await Promise.race([done, new Promise(r => setTimeout(r, 20_000))]);
  await new Promise(r => setTimeout(r, 200));
  await loop.endGame();
  await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
  prompts = calls.map(c => ({ kind: c.kind, text: c.messages.map(m => m.content).join('\n') }));
}, 40_000);

describe('round 15 in play (RZBU7G)', () => {
  it('the epilogue: both drafts flagged, and the one read closes warm — no "remains open for another day"', () => {
    expect(counts.epilogue).toBe(2);
    const epilogue = seen.find(m => m.type === 'narration' && m.isEpilogue)?.text as string;
    expect(epilogue).toBeTruthy();
    expect(epilogue).not.toMatch(/remains open|another day|remains unanswered/);
    expect(epilogue).toMatch(/For now, the amber light on the audit clock glows steady and calm, bathing Liz and Biz in a soft, golden warmth that feels exactly like home\.$/);
  });

  it('the rulings\' quotes: `in ink!\', The air` and `"taxation.\'` are tidied in what the table reads', () => {
    const rulings = seen.filter(m => m.type === 'resolution').map(m => m.text as string);
    const ink = rulings.find(t => t.includes('name in ink'))!;
    expect(ink).toContain("name in ink!' The air in the corridor");
    const tax = rulings.find(t => t.includes('taxation'))!;
    expect(tax).toContain('the word "taxation."\'');
  });

  it('the memory writers are told who is who: Liz is Biz\'s mother, Biz is Liz\'s kid', () => {
    const memoryPrompts = prompts.filter(p => p.text.includes('You extract episodic memories') || p.text.includes('Write ONE plain sentence'));
    expect(memoryPrompts.length).toBeGreaterThanOrEqual(2);
    for (const p of memoryPrompts) expect(p.text).toContain("Who is who: Biz is Liz's kid; Liz is Biz's mother. Never swap these roles.");
  });
});

describe('round 15: the prompts', () => {
  it('the interview: a companion keeps their own pronouns in the sheet, with nobody else at the table yet (Liz\'s interview had no draft when Biz\'s ran)', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    const before = calls.length;
    await new DmAgent(db).interviewForCharacter({
      systemId: 'fate-core', preset: 'chronicler', playerName: 'Biz', influences: [], seed: null,
      history: [{ role: 'user', content: "I'm Biz, I'm 10 and I use they/them. Liz is my mom, I call her Mom." }], unmet: [], tableCharacters: [],
    }).catch(() => null);
    const prompt = calls.slice(before).map(c => c.messages[0]!.content).join('\n');
    expect(prompt).toContain('SOMEONE ELSE IN THE SHEET');
    expect(prompt).toContain('"afraid of losing her"');
  });

  it('a gentle table\'s world seed is drafted in the register; another table\'s is not', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    const draft = async (gentlePeril: boolean) => {
      const before = calls.length;
      await new DmAgent(db).draftWorldSeed({ preset: 'chronicler', systemId: 'fate-core', influences: [], dmInstructions: '', history: [], existing: null, gentlePeril }).catch(() => null);
      return calls.slice(before).map(c => c.messages[0]!.content).join('\n');
    };
    expect(await draft(true)).toContain('GENTLE PERIL register');
    expect(await draft(false)).not.toContain('GENTLE PERIL register');
  });
});
