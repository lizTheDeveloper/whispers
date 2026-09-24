// "slow down the thinking process it moves very fast". The game loop holds
// each PUBLIC beat — narration, the chosen action, the dice, the DM's ruling
// — until the previous one has had time to be read: clamp(words /
// PACE_WORDS_PER_SEC, PACE_MIN_MS, PACE_MAX_MS) of that beat's own text (the
// dice get the minimum). A character's private options and thought go to one
// seat and hold no one. The wait lives in the loop, so every player stays in
// step; a pause holds it and a stop cuts it short. Where min = max, every
// beat's reading time is exactly D.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './lib/server-harness.js';
import { ReadingClock, pacingFromEnv, readingDelayMs } from '../src/server/pacing.js';
import type { CharacterDefinition, RoomState } from '../src/shared/types.js';
import type { ServerMessage } from '../src/shared/protocol.js';

process.env.WHISPER_WINDOW_MS = '100';
process.env.FIRST_WHISPER_WINDOW_MS = '100';

let harness: Harness;
beforeAll(async () => { harness = await startHarness(); }, 30_000);
afterAll(async () => { await harness.stop(); });

const SLACK = 25; // timer jitter

interface Stamped { msg: ServerMessage; at: number; private: boolean }

let seq = 0;
async function makeLoop(delayMs: number, opts: { minMs?: number; maxMs?: number; wordsPerSec?: number } = {}) {
  process.env.PACE_WORDS_PER_SEC = String(opts.wordsPerSec ?? 3.5);
  process.env.PACE_MIN_MS = String(opts.minMs ?? delayMs);
  process.env.PACE_MAX_MS = String(opts.maxMs ?? delayMs);
  const { getDb } = await import('../src/server/db.js');
  const { createRoom } = await import('../src/server/room.js');
  const { GameLoop } = await import('../src/server/game-loop.js');
  const db = getDb();
  const { campaignId, joinCode } = createRoom(db, { name: `Pacing ${++seq}`, dmPreset: 'chronicler', systemId: 'fate-core', scenarioId: null });
  const def: CharacterDefinition = {
    name: 'Vex Ashgrove', backstory: 'Raised by cartographers.', personality: 'Curious.', highConcept: 'Star-Cartographer',
    trouble: 'Owes the Ledger Cult', aspects: ['Maps are promises'], skills: { Notice: 3 }, stunts: [],
  };
  const id = `pace-${seq}`;
  db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)')
    .run(id, campaignId, JSON.stringify(def), JSON.stringify({ stress: 0, consequences: [], fatePoints: 3, inventory: [], xpMilestones: [], whisperTrust: 0.5 }));
  const log: Stamped[] = [];
  const state: RoomState = {
    campaignId, joinCode, phase: 'playing', currentScene: 1, currentTurn: 0, initiativeOrder: [id],
    activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null,
  };
  const loop = new GameLoop(
    db, campaignId,
    (msg) => log.push({ msg, at: Date.now(), private: false }),
    () => {},
    state,
    (_characterId, msg) => log.push({ msg, at: Date.now(), private: true }),
  );
  const running = loop.start().catch((e) => { console.error('loop failed', e); });
  return { loop, log, running };
}

async function until(cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}

const at = (log: Stamped[], pred: (m: ServerMessage) => boolean, from = 0): Stamped => {
  const hit = log.slice(from).find(s => pred(s.msg));
  if (!hit) throw new Error('beat not found');
  return hit;
};

describe('reading-time delay', () => {
  it('is words / rate, clamped, and zero when pacing is off', () => {
    const p = { wordsPerSec: 3.5, minMs: 2000, maxMs: 12000 };
    expect(readingDelayMs('one two', p)).toBe(2000);
    expect(readingDelayMs(Array(21).fill('word').join(' '), p)).toBe(6000);
    expect(readingDelayMs(Array(500).fill('word').join(' '), p)).toBe(12000);
    expect(readingDelayMs('', p)).toBe(0);
    expect(readingDelayMs('lots of words here', { ...p, minMs: 0, maxMs: 0 })).toBe(0);
  });

  // Live: 1.5s min, 8s max, 3.5 words a second (see pacingFromEnv).
  it('defaults: a one-liner gets a short pause, a paragraph at most 8s', () => {
    const p = pacingFromEnv({});
    expect(p).toEqual({ wordsPerSec: 3.5, minMs: 1500, maxMs: 8000 });
    expect(readingDelayMs('[Vex is still down.]', p)).toBe(1500);
    expect(readingDelayMs(Array(14).fill('word').join(' '), p)).toBe(4000);
    expect(readingDelayMs(Array(120).fill('word').join(' '), p)).toBe(8000);
  });
});

// Live, two players: the action, the inner thought, the verdict and the dice
// landed in one instant; the ruling 18-24s later; then every gap a flat 12s,
// a one-line status as long as a paragraph. The causes: the owner-only
// options and thought (whole paragraphs, clamped to the 12s max) held the
// public table — the other player waited 12s on text they never saw, and
// action + thought stacked two max-length waits before the ruling — and the
// dice had no pause of their own. The table now waits only on public beats,
// each for its own text.
describe('the reading clock', () => {
  const P = { wordsPerSec: 10, minMs: 500, maxMs: 8000 };
  const words = (n: number) => Array(n).fill('word').join(' ');
  function clockAt(t0 = 1_000_000) {
    let now = t0;
    const clock = new ReadingClock(P, () => now);
    return { clock, advance: (ms: number) => { now += ms; } };
  }

  it('each beat waits for its own text only: a short beat after a long one gets a short pause', () => {
    const { clock, advance } = clockAt();
    clock.mark({ type: 'resolution', text: words(40) });
    expect(clock.remainingMs()).toBe(4000);
    advance(4000);
    expect(clock.remainingMs()).toBe(0);
    clock.mark({ type: 'narration', text: 'Vex is still down.', sceneNumber: 1 });
    expect(clock.remainingMs()).toBe(500);
  });

  it('beats in one burst add up — both must be read', () => {
    const { clock } = clockAt();
    clock.mark({ type: 'narration', text: words(20), sceneNumber: 1 });
    clock.mark({ type: 'narration', text: words(30), sceneNumber: 1 });
    expect(clock.remainingMs()).toBe(5000);
  });

  it('a character\'s private options and thought hold no one', () => {
    const { clock } = clockAt();
    clock.mark({ type: 'action-proposals', characterId: 'c', characterName: 'Liz', actions: [words(40)], actionReasons: [words(40)], whisperTrust: 0.5 });
    clock.mark({ type: 'character-thought', characterId: 'c', characterName: 'Liz', innerThought: words(40), whisperInfluence: 'followed' });
    clock.mark({ type: 'whisper-guidance', characterId: 'c', mood: words(20), suggestions: [words(10)] });
    expect(clock.remainingMs()).toBe(0);
  });

  it('the dice are a glance: the minimum pause, before the ruling', () => {
    const { clock } = clockAt();
    clock.mark({ type: 'dice-roll', result: { expression: '4dF', rolls: [1, 0, -1, 1], total: 1, description: '4dF: +1' } as any, context: words(40) });
    expect(clock.remainingMs()).toBe(500);
  });

  it('no double count: an LLM call longer than the reading time adds no wait after it', () => {
    const { clock, advance } = clockAt();
    clock.mark({ type: 'action-taken', characterId: 'c', characterName: 'Liz', action: words(20) });
    expect(clock.remainingMs()).toBe(2000);
    advance(3500); // the ruling took longer than the action takes to read
    expect(clock.remainingMs()).toBe(0);
    advance(-2000); // …or shorter: only the rest of the reading time is left
    expect(clock.remainingMs()).toBe(500);
  });

  it('a hold freezes what is left; release resumes it; beats while held add to it', () => {
    const { clock, advance } = clockAt();
    clock.mark({ type: 'resolution', text: words(30) });
    advance(1000);
    clock.hold();
    advance(60_000);
    expect(clock.remainingMs()).toBe(2000);
    clock.mark({ type: 'narration', text: words(10), sceneNumber: 1 });
    clock.release();
    expect(clock.remainingMs()).toBe(3000);
  });

  it('is off entirely when PACE_MAX_MS is 0', () => {
    let now = 0;
    const clock = new ReadingClock({ wordsPerSec: 3.5, minMs: 0, maxMs: 0 }, () => now);
    clock.mark({ type: 'resolution', text: words(40) });
    clock.mark({ type: 'dice-roll', result: {} as any, context: '' });
    expect(clock.remainingMs()).toBe(0);
  });
});

describe('the game loop paces its beats', () => {
  it('spaces narration, prompt, action, dice and ruling by the public beats\' reading time', async () => {
    const D = 300;
    const { loop, log, running } = await makeLoop(D);
    try {
      await until(() => log.filter(s => s.msg.type === 'action-proposals').length >= 2);
    } finally {
      loop.stop();
      await running;
    }
    const firstProposals = log.findIndex(s => s.msg.type === 'action-proposals');
    const sceneNarration = log.slice(0, firstProposals).filter(s => s.msg.type === 'narration').at(-1)!;
    const proposals = log[firstProposals]!;
    expect(proposals.private).toBe(true);
    const prompt = at(log, m => m.type === 'whisper-prompt', firstProposals);
    const action = at(log, m => m.type === 'action-taken', firstProposals);
    const thought = at(log, m => m.type === 'character-thought', firstProposals);
    const dice = at(log, m => m.type === 'dice-roll', firstProposals);
    const resolution = at(log, m => m.type === 'resolution', firstProposals);
    const nextProposals = at(log, m => m.type === 'action-proposals', firstProposals + 1);

    // The opening (arrival + introduction) arrives as one burst; the first
    // narration of play waits for both to be read.
    const openingEnd = log.findIndex(s => s === sceneNarration);
    const openingBeats = log.slice(0, openingEnd).filter(s => s.msg.type === 'narration');
    if (openingBeats.length > 0) {
      expect(sceneNarration.at - openingBeats[0]!.at).toBeGreaterThanOrEqual(openingBeats.length * D - SLACK);
    }
    // The table reads the narration before anyone is asked to decide…
    expect(prompt.at - sceneNarration.at).toBeGreaterThanOrEqual(D - SLACK);
    // …and the owner's private options hold no one: the prompt follows them at once.
    expect(prompt.at - proposals.at).toBeLessThan(D / 2);
    expect(thought.private).toBe(true);
    // The action is read before the dice appear; the owner's thought adds no wait.
    expect(dice.at - action.at).toBeGreaterThanOrEqual(D - SLACK);
    expect(dice.at - action.at).toBeLessThan(1.5 * D);
    // The dice get their own glance before the ruling.
    expect(resolution.at - dice.at).toBeGreaterThanOrEqual(D - SLACK);
    expect(nextProposals.at - resolution.at).toBeGreaterThanOrEqual(D - SLACK);
  }, 30_000);

  it('each gap is that beat\'s own reading time: the short dice pause follows a longer action pause', async () => {
    // 20 words a second, 50ms floor, a high ceiling: every beat's wait is
    // its own words, and nothing is clamped to the max.
    const P = { wordsPerSec: 20, minMs: 50, maxMs: 20_000 };
    const { loop, log, running } = await makeLoop(0, P);
    try {
      await until(() => log.filter(s => s.msg.type === 'resolution').length >= 2);
    } finally {
      loop.stop();
      await running;
    }
    const pacing = { wordsPerSec: P.wordsPerSec, minMs: P.minMs, maxMs: P.maxMs };
    for (const [i, s] of log.entries()) {
      if (s.msg.type !== 'action-taken') continue;
      const dice = at(log, m => m.type === 'dice-roll', i);
      const resolution = at(log, m => m.type === 'resolution', i);
      const actionRead = readingDelayMs(`${s.msg.action} ${s.msg.spokenWords ?? ''}`, pacing);
      expect(actionRead).toBeGreaterThan(P.minMs);
      // The action's own reading time — not the transcript's, not the max.
      expect(dice.at - s.at).toBeGreaterThanOrEqual(actionRead - SLACK);
      expect(dice.at - s.at).toBeLessThan(actionRead + 150);
      // The dice: a short glance, not the action's wait again.
      expect(resolution.at - dice.at).toBeGreaterThanOrEqual(P.minMs - SLACK);
      expect(resolution.at - dice.at).toBeLessThan(P.minMs + 150);
    }
  }, 30_000);

  it('no double count: a ruling slower than the reading time arrives when it is ready, with no wait on top', async () => {
    const D = 400;
    const LLM = 1500;
    const { loop, log, running } = await makeLoop(D);
    const dm = (loop as any).dm;
    const resolve = dm.resolve.bind(dm);
    dm.resolve = async (...args: unknown[]) => {
      await new Promise(r => setTimeout(r, LLM));
      return resolve(...args);
    };
    try {
      await until(() => log.some(s => s.msg.type === 'resolution'));
    } finally {
      loop.stop();
      await running;
    }
    const actionIdx = log.findIndex(s => s.msg.type === 'action-taken');
    const action = log[actionIdx]!;
    const dice = at(log, m => m.type === 'dice-roll', actionIdx);
    const resolution = at(log, m => m.type === 'resolution', actionIdx);
    // The dice did not wait on the ruling; the ruling was being written
    // while the action and the dice were read.
    expect(dice.at - action.at).toBeLessThan(D + 150);
    expect(resolution.at - action.at).toBeGreaterThanOrEqual(LLM - SLACK);
    // Not LLM + action + dice (2300ms): the reading time ran under the call.
    expect(resolution.at - action.at).toBeLessThan(LLM + 250);
  }, 30_000);

  it('a pause during the wait holds it; resume finishes what was left of it', async () => {
    const D = 1200;
    const { loop, log, running } = await makeLoop(D);
    try {
      await until(() => log.some(s => s.msg.type === 'action-taken'));
      const actionAt = log.find(s => s.msg.type === 'action-taken')!.at;
      expect(loop.pause('host')).toBe(true);
      await new Promise(r => setTimeout(r, D + 600));
      // Held: without the pause the dice would be out by now.
      expect(log.some(s => s.msg.type === 'dice-roll')).toBe(false);
      const resumedAt = Date.now();
      const heldFor = resumedAt - actionAt;
      expect(loop.resume('host')).toBe(true);
      await until(() => log.some(s => s.msg.type === 'dice-roll'), 10_000);
      const diceAt = log.find(s => s.msg.type === 'dice-roll')!.at;
      // What was left of the wait when it paused (~D, the pause came right
      // after the action went out) still runs after the resume.
      expect(diceAt - resumedAt).toBeGreaterThanOrEqual(D - 200 - SLACK);
      expect(heldFor).toBeGreaterThan(D);
      // The ruling the pause interrupted is redone and still follows.
      await until(() => log.some(s => s.msg.type === 'resolution'), 10_000);
    } finally {
      loop.stop();
      await running;
    }
  }, 30_000);

  it('stop cuts a wait short: the loop ends at once and shows nothing more', async () => {
    const D = 10_000;
    const { loop, log, running } = await makeLoop(D);
    // The opening burst is being read; wait until the loop is parked on it.
    await until(() => log.some(s => s.msg.type === 'narration'));
    await new Promise(r => setTimeout(r, 200));
    const count = log.length;
    const stoppedAt = Date.now();
    loop.stop();
    await running;
    expect(Date.now() - stoppedAt).toBeLessThan(1_000);
    expect(log.slice(count).filter(s => ['narration', 'action-proposals', 'whisper-prompt', 'action-taken', 'resolution'].includes(s.msg.type))).toEqual([]);
  }, 30_000);
});
