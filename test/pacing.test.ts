// "slow down the thinking process it moves very fast". The game loop now
// holds each beat — narration, a character's options (to their owner), the
// chosen action (and thought), the DM's ruling — until the previous one has
// had time to be read: clamp(words / PACE_WORDS_PER_SEC, PACE_MIN_MS,
// PACE_MAX_MS). The wait lives in the loop, so every player stays in step; a
// pause holds it and a stop cuts it short. Here min = max, so every beat's
// reading time is exactly D.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './lib/server-harness.js';
import { readingDelayMs } from '../src/server/pacing.js';
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
async function makeLoop(delayMs: number) {
  process.env.PACE_WORDS_PER_SEC = '3.5';
  process.env.PACE_MIN_MS = String(delayMs);
  process.env.PACE_MAX_MS = String(delayMs);
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
});

describe('the game loop paces its beats', () => {
  it('spaces narration, options, prompt, action and ruling by at least the reading delay', async () => {
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
    const resolution = at(log, m => m.type === 'resolution', firstProposals);
    const nextProposals = at(log, m => m.type === 'action-proposals', firstProposals + 1);

    // The opening (arrival + introduction) arrives as one burst; the first
    // narration of play waits for both to be read.
    const openingEnd = log.findIndex(s => s === sceneNarration);
    const openingBeats = log.slice(0, openingEnd).filter(s => s.msg.type === 'narration');
    if (openingBeats.length > 0) {
      expect(sceneNarration.at - openingBeats[0]!.at).toBeGreaterThanOrEqual(openingBeats.length * D - SLACK);
    }
    expect(proposals.at - sceneNarration.at).toBeGreaterThanOrEqual(D - SLACK);
    expect(prompt.at - proposals.at).toBeGreaterThanOrEqual(D - SLACK);
    expect(thought.private).toBe(true);
    // The action and the owner's thought are both read before the ruling.
    expect(resolution.at - action.at).toBeGreaterThanOrEqual(2 * D - SLACK);
    expect(nextProposals.at - resolution.at).toBeGreaterThanOrEqual(D - SLACK);
  }, 30_000);

  it('a pause during the wait holds it; resume finishes what was left of it', async () => {
    const D = 1200;
    const { loop, log, running } = await makeLoop(D);
    try {
      await until(() => log.some(s => s.msg.type === 'action-proposals'));
      const proposalsAt = log.find(s => s.msg.type === 'action-proposals')!.at;
      expect(loop.pause('host')).toBe(true);
      await new Promise(r => setTimeout(r, D + 600));
      // Held: without the pause the prompt would be out by now.
      expect(log.some(s => s.msg.type === 'whisper-prompt')).toBe(false);
      const resumedAt = Date.now();
      const heldFor = resumedAt - proposalsAt;
      expect(loop.resume('host')).toBe(true);
      await until(() => log.some(s => s.msg.type === 'whisper-prompt'), 10_000);
      const promptAt = log.find(s => s.msg.type === 'whisper-prompt')!.at;
      // What was left of the wait when it paused (~D, the pause came right
      // after the options went out) still runs after the resume.
      expect(promptAt - resumedAt).toBeGreaterThanOrEqual(D - 200 - SLACK);
      expect(heldFor).toBeGreaterThan(D);
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
