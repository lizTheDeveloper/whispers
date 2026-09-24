// Round 14 in play: the tone gate wired through the game loop, with the LLM
// mocked with the live 7RAAQ7 lines and the judge mocked. At a table with a
// ten-year-old, every DM output and reflection is judged; a flagged one is
// generated once more with the phrases quoted as feedback in the prompt
// (never the draft), and the table reads the second. The DM is told who the
// party has met, and Biz's reflection calls Liz "Mom".
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

const FEEDBACK = '<tone_feedback>';
const MENACING_OPENING = 'The Lobby of First Impressions hums. You and your companion stand bare-chested before Clerk Ozymandias, who adjusts his glasses.';
const GENTLE_OPENING = 'The Lobby of First Impressions hums. Liz and Biz stand before Clerk Ozymandias, who adjusts his glasses.';
const MENACING_BEAT = 'The Next Pigeon squawks: \'Present Form 88-B, or I shall have to re-file your entire identity under the category of Unresolved Naps.\'';
const GENTLE_BEAT = 'The Next Pigeon squawks: \'Present Form 88-B, please, and mind the bell.\'';
const MENACING_RULING = 'Liz slides the form across. Clerk Ozymandias sniffs, "Mistakes must be filed, perhaps?" and eyes Biz.';
const GENTLE_RULING = 'Liz slides the form across. Clerk Ozymandias sniffs, "A tidy form, perhaps?" and smiles at Biz.';
const LIMBO_EPILOGUE = 'Liz and Biz found the Re-Writing Room. The question of what token will satisfy The Next Pigeon remains unanswered, and the beige ripples on the floor continue their slow, wet pulse.';
const WARM_EPILOGUE = 'Liz and Biz found the Re-Writing Room, and walked out of it together, Biz\'s hand warm in Liz\'s, the lanyard question saved for another day.';
const counts = { epilogue: 0, lizReflection: 0, bizReflection: 0 };

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ kind: 'llm', messages: opts.messages });
    const all = opts.messages.map(m => m.content).join('\n');
    const again = all.includes(FEEDBACK);
    if (all.includes('OPENING OF THE ADVENTURE')) return { arrival: '', narration: again ? GENTLE_OPENING : MENACING_OPENING, introductions: [], currentLocationName: 'The Lobby of First Impressions' };
    if (all.includes('Choose your action now')) {
      return all.includes('You ARE Liz')
        ? { chosenAction: 'Slide the form across to the clerk.', spokenWords: 'Here you are.', innerThought: 'Paperwork.', whisperedInfluence: 'ignored', trustDelta: 0 }
        : { chosenAction: 'Hold Mom\'s hand and look at the pigeon.', spokenWords: 'Hi, pigeon!', innerThought: 'Shiny.', whisperedInfluence: 'ignored', trustDelta: 0 };
    }
    if (all.includes('Propose 2-4 actions')) return { actions: [{ description: 'I look around', reasoning: 'r' }, { description: 'I ask the clerk', reasoning: 'r' }] };
    if (all.includes('FATE resolution steps')) {
      const liz = all.includes('ACTING CHARACTER (narrate THEIR action, not another party member\'s): Liz');
      return { diceExpression: '4dF', difficulty: 0, skill: 'Notice', outcome: 'success', narration: liz ? (again ? GENTLE_RULING : MENACING_RULING) : 'Biz waves at the pigeon, who bobs politely.', stateChanges: [] };
    }
    if (all.includes('Pacing:')) return { narration: again ? GENTLE_BEAT : MENACING_BEAT, currentLocationName: 'The Lobby of First Impressions', activeNpcs: ['The Next Pigeon'], isSceneEnd: false };
    if (all.includes('You extract episodic memories')) return { memories: [{ type: 'social', content: 'I held Mom\'s hand.', emotionalValence: 0, importance: 0.9 }] };
    if (all.includes('Write ONE plain sentence')) return 'I saw them hold hands.';
    if (all.includes('Summarize')) return { summary: 'The lobby hummed.' };
    return 'ok';
  }),
  callProse: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ kind: 'prose', messages: opts.messages });
    const all = opts.messages.map(m => m.content).join('\n');
    const again = all.includes('A reader for this gentle table flagged');
    if (all.includes('closing reflection')) {
      if (all.includes('You are Biz')) {
        counts.bizReflection++;
        return 'SPOKEN: "We did it!"\nTHOUGHT: I am safe in Liz\'s grip, and my bottle caps are safe too.';
      }
      counts.lizReflection++;
      return again
        ? 'SPOKEN: "Let\'s go home, Biz."\nTHOUGHT: We are together, and that is enough for today.'
        : 'SPOKEN: "Stay close, Biz."\nTHOUGHT: The question of the lanyard is still open, and we face it together.';
    }
    if (all.includes('session epilogues')) {
      counts.epilogue++;
      return again ? WARM_EPILOGUE : LIMBO_EPILOGUE;
    }
    return 'ok';
  }),
}));

process.env.WHISPER_WINDOW_MS = '30';
process.env.PACE_MAX_MS = '0';

const judged: Array<{ kind: string; text: string }> = [];
const FLAGS = [
  'stand bare-chested',
  're-file your entire identity under the category of Unresolved Naps',
  'Mistakes must be filed',
  'remains unanswered, and the beige ripples on the floor continue their slow, wet pulse',
  'is still open, and we face it together',
];
const judge: ToneJudge = async (text, kind) => {
  judged.push({ kind, text });
  const phrases = FLAGS.filter(f => text.includes(f));
  return { flagged: phrases.length > 0, phrases };
};

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r14-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
});
afterAll(async () => {
  (await import('../src/server/game-loop.js')).GameLoop.toneJudge = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

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
let prompts: Array<{ kind: string; text: string }> = [];

beforeAll(async () => {
  const room = await import('../src/server/room.js');
  const { makeCharacterLive } = await import('../src/server/character-live.js');
  const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
  const seed = {
    premise: 'Liz and Biz have arrived in Oze with no lanyards.',
    locations: [{ name: 'The Lobby of First Impressions', description: 'Obsidian floor.', terrain: 'indoor' }, { name: 'The Re-Writing Room', description: 'Paper remembers.', terrain: 'indoor' }],
    npcs: [
      { name: 'Clerk Ozymandias', description: 'A tall, thin clerk.', disposition: 'Meticulous', motivation: null, pronouns: 'he/him' },
      { name: 'Mama Pigeon', description: 'A fluffy pigeon in a suit jacket.', disposition: 'Maternal', motivation: null, pronouns: 'she/her' },
    ],
    plotHooks: [], items: [],
  };
  const created = room.createRoom(db, { name: 'R14 play', dmPreset: 'chronicler', systemId: 'fate-core' });
  const campaignId = created.campaignId;
  setWorldSeed(db, campaignId, seed as any);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed as any);
  for (const [id, definition, playerName] of [[`liz-r14-${campaignId}`, LIZ_SHEET, 'Liz'], [`biz-r14-${campaignId}`, BIZ_SHEET, 'Biz']] as const) {
    const session = room.createSession(db, { campaignId, joinCode: created.joinCode, playerName, isHost: playerName === 'Liz' });
    const pending = { id, campaignId, joinCode: created.joinCode, sessionToken: session.token, playerName, definition, aiFeedback: 'ok' };
    room.savePendingCharacter(db, pending);
    makeCharacterLive(db, pending);
  }

  const { GameLoop } = await import('../src/server/game-loop.js');
  GameLoop.toneJudge = judge;
  const gameState = { campaignId, joinCode: created.joinCode, phase: 'playing' as const, currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null };
  let loop!: InstanceType<typeof GameLoop>;
  let resolutions = 0;
  const done = new Promise<void>((resolve) => {
    const on = (m: any) => { seen.push(m); if (m.type === 'resolution' && ++resolutions === 2) setImmediate(() => resolve()); };
    loop = new GameLoop(db, campaignId, on, () => {}, gameState as any, (_id: string, m: any) => on(m));
  });
  const running = loop.start().catch(e => console.error('LOOP FAILED', e));
  await Promise.race([done, new Promise(r => setTimeout(r, 20_000))]);
  await new Promise(r => setTimeout(r, 200));
  await loop.endGame();
  await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
  prompts = calls.map(c => ({ kind: c.kind, text: c.messages.map(m => m.content).join('\n') }));
}, 40_000);

const tableText = () => seen.map(m => [m.text, m.narration, m.action, m.spokenWords].filter(Boolean).join(' ')).join('\n');

describe('round 14 in play: the tone gate at a table with a ten-year-old', () => {
  it('every kind of DM output was judged: opening, narration, ruling, epilogue, reflections', () => {
    const kinds = new Set(judged.map(j => j.kind));
    for (const k of ['opening', 'narration', 'ruling', 'epilogue', 'reflection']) expect(kinds).toContain(k);
  });

  it('none of the flagged lines reached the table', () => {
    const t = tableText();
    for (const f of FLAGS) expect(t).not.toContain(f);
  });

  it('the opening: "You and your companion stand bare-chested" was generated again, with the phrase quoted as feedback', () => {
    const openings = prompts.filter(p => p.text.includes('OPENING OF THE ADVENTURE'));
    expect(openings).toHaveLength(2);
    expect(openings[1]!.text).toContain('"stand bare-chested"');
    expect(openings[1]!.text).not.toContain(MENACING_OPENING);
    expect(seen.find(m => m.type === 'narration' && String(m.text).includes('Lobby of First Impressions hums'))?.text).toContain('Liz and Biz stand before');
  });

  it('the narration beat: "re-file your entire identity…" out, the gentle beat in', () => {
    const beats = prompts.filter(p => p.text.includes('Pacing:'));
    const withFeedback = beats.filter(p => p.text.includes(FEEDBACK));
    expect(withFeedback.length).toBeGreaterThanOrEqual(1);
    expect(withFeedback[0]!.text).toContain('"re-file your entire identity under the category of Unresolved Naps"');
    expect(seen.some(m => m.type === 'narration' && String(m.text).includes('mind the bell'))).toBe(true);
  });

  it('the ruling: "Mistakes must be filed" out; Biz\'s clean ruling was judged once and not regenerated', () => {
    const lizRulings = prompts.filter(p => p.text.includes('FATE resolution steps') && p.text.includes('narrate THEIR action, not another party member\'s): Liz'));
    const bizRulings = prompts.filter(p => p.text.includes('FATE resolution steps') && p.text.includes('narrate THEIR action, not another party member\'s): Biz'));
    // Each of Liz's turns: the flagged draft, then one fresh try with the feedback — never more.
    expect(lizRulings.length).toBeGreaterThanOrEqual(2);
    expect(lizRulings.filter(p => p.text.includes(FEEDBACK)).length).toBe(lizRulings.length / 2);
    expect(lizRulings.filter(p => p.text.includes(FEEDBACK)).every(p => p.text.includes('"Mistakes must be filed"'))).toBe(true);
    expect(bizRulings.length).toBeGreaterThanOrEqual(1);
    expect(bizRulings.some(p => p.text.includes(FEEDBACK))).toBe(false);
    const r = seen.find(m => m.type === 'resolution' && String(m.text).includes('slides the form'));
    expect(r.text).toContain('A tidy form, perhaps?');
  });

  it('the epilogue: the limbo ending was written fresh once with the phrase as feedback, and the warm one is read', () => {
    expect(counts.epilogue).toBe(2);
    const second = prompts.filter(p => p.kind === 'prose' && p.text.includes('session epilogues'))[1]!;
    expect(second.text).toContain('A reader for this gentle table flagged');
    expect(second.text).not.toContain(LIMBO_EPILOGUE);
    expect(seen.find(m => m.type === 'narration' && m.isEpilogue)?.text).toBe(WARM_EPILOGUE);
  });

  it('Liz\'s half-hopeful reflection ("…is still open, and we face it together.") was asked for again; Biz\'s was fine and calls Liz "Mom"', () => {
    expect(counts.lizReflection).toBe(2);
    expect(counts.bizReflection).toBe(1);
    const liz = seen.find(m => m.type === 'action-taken' && m.characterName === 'Liz' && String(m.action).startsWith('[Final reflection]'));
    expect(liz.action).toContain('We are together, and that is enough for today.');
    const biz = seen.find(m => m.type === 'action-taken' && m.characterName === 'Biz' && String(m.action).startsWith('[Final reflection]'));
    expect(biz.action).toContain('I am safe in Mom\'s grip');
  });

  it('once Clerk Ozymandias has been on stage, every later narration and ruling prompt says the party has met him', () => {
    const later = prompts.filter(p => p.text.includes('Pacing:') || p.text.includes('FATE resolution steps'));
    expect(later.length).toBeGreaterThanOrEqual(2);
    for (const p of later) expect(p.text).toMatch(/The party has already met: [^\n]*Clerk Ozymandias/);
  });
});
