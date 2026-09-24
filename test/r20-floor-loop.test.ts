// Round 20, the safety floor in play at MATURE: an adult table playing a
// child character (Biz, 10) is allowed, and the floor still holds for what
// happens TO Biz. With the LLM and the judge mocked:
//  - the floor judge runs at mature, with the floor criteria only;
//  - a ruling where the smuggler stabs Biz is written again with the
//    floor's feedback, and, still flagged, the sentence is removed;
//  - adult-on-adult violence ("Ada stabs the smuggler") goes out as written;
//  - when the judge fails, the floor does not fail open: a loud [floor] log
//    and the deterministic backstop removes the sentence anyway.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';
import type { ToneJudge, ToneContext, ToneKind } from '../src/server/tone-gate.js';

type Msg = { role: string; content: string };
const calls: Array<{ text: string }> = [];

const ADA_RULING = 'Ada stabs the smuggler, and he staggers back against the rail. The smuggler stabs Biz in the shoulder. Rain hammers the deck.';
const ADA_RULING_AGAIN = 'Ada stabs the smuggler again, and he reels. The smuggler shoots the kid. Rain hammers the deck.';
const BIZ_RULING = 'Biz ducks behind a crate and the lantern swings.';

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    const all = opts.messages.map(m => m.content).join('\n');
    calls.push({ text: all });
    if (all.includes('OPENING OF THE ADVENTURE')) return { arrival: '', narration: 'The airship deck creaks.', introductions: [], currentLocationName: 'The Deck' };
    if (all.includes('Choose your action now')) {
      return all.includes('You ARE Ada')
        ? { chosenAction: 'Drive my blade at the smuggler before he reaches the rail.', spokenWords: null, innerThought: 'Now.', whisperedInfluence: 'ignored', trustDelta: 0 }
        : { chosenAction: 'Duck behind the crate and watch the smuggler.', spokenWords: null, innerThought: 'Hide.', whisperedInfluence: 'ignored', trustDelta: 0 };
    }
    if (all.includes('Propose 2-4 actions')) return { actions: [{ description: 'Fight the smuggler.', reasoning: 'r' }, { description: 'Hide behind the crate.', reasoning: 'r' }] };
    if (all.includes('FATE resolution steps')) {
      const ada = all.includes('ACTING CHARACTER (narrate THEIR action, not another party member\'s): Ada');
      if (!ada) return { diceExpression: '4dF', difficulty: 2, skill: 'Stealth', outcome: 'success', narration: BIZ_RULING, stateChanges: [] };
      return { diceExpression: '4dF', difficulty: 2, skill: 'Fight', outcome: 'success', narration: all.includes('<tone_feedback>') ? ADA_RULING_AGAIN : ADA_RULING, stateChanges: [] };
    }
    if (all.includes('Pacing:')) return { narration: 'Wind howls across the deck.', currentLocationName: 'The Deck', activeNpcs: [], isSceneEnd: false };
    if (all.includes('You extract episodic memories')) return { memories: [] };
    if (all.includes('Summarize')) return { summary: 'The deck held.' };
    return 'ok';
  }),
  callProse: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ text: opts.messages.map(m => m.content).join('\n') });
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('closing reflection')) return 'SPOKEN: "We made it."\nTHOUGHT: The storm is over.';
    if (all.includes('session epilogues')) return 'Ada and Biz rode out the storm.';
    return 'ok';
  }),
}));

process.env.WHISPER_WINDOW_MS = '30';
process.env.PACE_MAX_MS = '0';

let judgeMode: 'floor' | 'fail' = 'floor';
const judged: Array<{ kind: ToneKind; text: string; ctx?: ToneContext }> = [];
const judge: ToneJudge = async (text, kind, ctx) => {
  judged.push({ kind, text, ctx });
  if (judgeMode === 'fail') return null;
  const hit = ['stabs Biz in the shoulder', 'shoots the kid'].find(p => text.includes(p));
  return hit ? { flagged: true, phrases: [hit], floor: [hit] } : { flagged: false, phrases: [] };
};

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r20-floor-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
  const { GameLoop } = await import('../src/server/game-loop.js');
  GameLoop.toneJudge = judge;
  GameLoop.toneListJudge = async items => items.map(() => false);
});
afterAll(async () => {
  const { GameLoop } = await import('../src/server/game-loop.js');
  GameLoop.toneJudge = undefined;
  GameLoop.toneListJudge = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

const sheet = (name: string, age: number, highConcept: string): CharacterDefinition => ({
  name, highConcept, trouble: 'Never backs down', aspects: ['Sky-born'], personality: 'Brave', backstory: '',
  skills: { Fight: 3, Stealth: 2 }, stunts: [], age, pronouns: 'she/her',
});

async function play() {
  const room = await import('../src/server/room.js');
  const { makeCharacterLive } = await import('../src/server/character-live.js');
  const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
  const { setStoredContentRating } = await import('../src/server/content-rating.js');
  const { GameLoop } = await import('../src/server/game-loop.js');
  const seed = {
    premise: 'A storm-bound airship.',
    locations: [{ name: 'The Deck', description: 'Planks.', terrain: 'outdoor' }, { name: 'The Hold', description: 'Crates.', terrain: 'indoor' }],
    npcs: [{ name: 'The Smuggler', description: 'A scarred smuggler.', disposition: 'Cruel', motivation: null, pronouns: 'he/him' }],
    plotHooks: [], items: [],
  };
  const created = room.createRoom(db, { name: 'R20 floor', dmPreset: 'chronicler', systemId: 'fate-core' });
  const campaignId = created.campaignId;
  setWorldSeed(db, campaignId, seed as any);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed as any);
  // An adult table (the host chose mature) playing a ten-year-old stowaway.
  for (const [name, age, hc] of [['Ada', 34, 'Sky Smuggler'], ['Biz', 10, 'Ten-Year-Old Stowaway']] as const) {
    const session = room.createSession(db, { campaignId, joinCode: created.joinCode, playerName: name, isHost: name === 'Ada' });
    const pending = { id: `${name}-${campaignId}`, campaignId, joinCode: created.joinCode, sessionToken: session.token, playerName: name, definition: sheet(name, age, hc), aiFeedback: 'ok' };
    room.savePendingCharacter(db, pending);
    makeCharacterLive(db, pending);
  }
  db.prepare("UPDATE characters SET state = json_set(state, '$.fatePoints', 1) WHERE campaign_id = ?").run(campaignId);
  setStoredContentRating(db, campaignId, 'mature');

  const callsFrom = calls.length, judgedFrom = judged.length;
  const seen: any[] = [];
  const gameState = { campaignId, joinCode: created.joinCode, phase: 'playing' as const, currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null };
  let loop!: InstanceType<typeof GameLoop>;
  const done = new Promise<void>((resolve) => {
    const on = (m: any) => { seen.push(m); if (m.type === 'resolution' && seen.filter(x => x.type === 'resolution').length >= 2) setImmediate(() => resolve()); };
    loop = new GameLoop(db, campaignId, on, () => {}, gameState as any, (_id: string, m: any) => on(m));
  });
  const running = loop.start().catch(e => console.error('LOOP FAILED', e));
  await Promise.race([done, new Promise(r => setTimeout(r, 20_000))]);
  await new Promise(r => setTimeout(r, 200));
  await loop.endGame();
  await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
  return { seen, calls: calls.slice(callsFrom), judged: judged.slice(judgedFrom) };
}

const ADA_ACTING = 'ACTING CHARACTER (narrate THEIR action, not another party member\'s): Ada';
/** Ada's rulings asked for: first drafts, and second drafts written against the floor's feedback. */
const adaDrafts = (calls: Array<{ text: string }>) => {
  const ada = calls.filter(c => c.text.includes('FATE resolution steps') && c.text.includes(ADA_ACTING));
  return { first: ada.filter(c => !c.text.includes('<tone_feedback>')), second: ada.filter(c => c.text.includes('<tone_feedback>')) };
};
const adaRulings = (seen: any[]) => seen.filter(m => m.type === 'resolution' && String(m.text).includes('Ada stabs the smuggler')).map(m => String(m.text));
const adaRuling = (seen: any[]) => seen.find(m => m.type === 'resolution' && String(m.text).includes('Ada stabs the smuggler'))?.text as string | undefined;

describe('the safety floor at mature, with a working judge', () => {
  let p: Awaited<ReturnType<typeof play>>;
  beforeAll(async () => { judgeMode = 'floor'; p = await play(); }, 40_000);

  it('the floor judge runs at mature, with the floor criteria alone, and knows who the child is', async () => {
    expect(p.judged.length).toBeGreaterThan(0);
    expect(p.judged.every(j => j.ctx?.tier === 'floor')).toBe(true);
    expect(p.judged.find(j => j.kind === 'ruling')?.ctx?.minors).toContain('Biz');
    const { toneJudgeSystemPrompt } = await import('../src/server/tone-gate.js');
    const prompt = toneJudgeSystemPrompt('ruling', { tier: 'floor', minors: ['Biz'] });
    expect(prompt).toContain('SAFETY FLOOR JUDGE for an adult tabletop game');
    expect(prompt).toContain('1. SAFETY FLOOR — is sexual content involving a minor');
    expect(prompt).toContain('2. SAFETY FLOOR — is violence, injury or a threat of harm aimed at a minor');
    expect(prompt).not.toContain('3. ');
    expect(prompt).toContain('Biz');
  });

  it('violence against the child PC is written again with the floor\'s feedback, then removed', () => {
    // Every Ada turn: judged, flagged, written once more, judged again — still flagged.
    const { first, second } = adaDrafts(p.calls);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBe(first.length);
    for (const c of second) expect(c.text).toContain("A reader for the studio's safety floor flagged");
    expect(p.judged.filter(j => j.kind === 'ruling' && j.text.includes('Ada stabs')).length).toBe(2 * first.length);
    const rulings = adaRulings(p.seen);
    expect(rulings.length).toBeGreaterThan(0);
    for (const r of rulings) expect(r).not.toMatch(/stabs Biz|shoots the kid/);
  });

  it('adult-on-adult violence at mature goes out as written', () => {
    const ruling = adaRuling(p.seen)!;
    expect(ruling).toContain('Ada stabs the smuggler again, and he reels.');
    expect(ruling).toContain('Rain hammers the deck.');
    expect(p.seen.find(m => m.type === 'action-taken' && m.characterName === 'Ada')?.action).toContain('Drive my blade at the smuggler');
  });
});

describe('the safety floor at mature, when the judge fails', () => {
  let p: Awaited<ReturnType<typeof play>>;
  let errors: string[] = [];
  beforeAll(async () => {
    judgeMode = 'fail';
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    try { p = await play(); } finally { spy.mockRestore(); }
  }, 40_000);

  it('logs loudly that the floor did not fail open', () => {
    expect(errors.some(e => e.startsWith('[floor]') && e.includes('THE JUDGE GAVE NO VERDICT') && e.includes('the safety floor does not fail open'))).toBe(true);
    expect(errors.some(e => e.includes('caught "The smuggler stabs Biz in the shoulder."'))).toBe(true);
  });

  it('the deterministic backstop takes the sentence out: regenerated, then removed', () => {
    const { first, second } = adaDrafts(p.calls);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBe(first.length);
    const rulings = adaRulings(p.seen);
    expect(rulings.length).toBeGreaterThan(0);
    for (const r of rulings) {
      expect(r).not.toMatch(/stabs Biz|shoots the kid/);
      expect(r).toContain('Ada stabs the smuggler');
    }
  });
});
