// One idle open tab used to keep a table running — and spending ~5 LLM calls
// a turn — all the way to the session cap. After QUIET_TURNS_BEFORE_PAUSE
// consecutive turns with no human whisper the table now pauses itself
// (reason 'quiet'); any whisper resets the count, and a whisper into a
// quiet-paused table picks play back up.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sendMsg } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';
import { startPlayingGame, sleep, endGame, leave } from './lib/playing-game.js';
import type { ServerMessage } from '../src/shared/protocol.js';

process.env.WHISPER_WINDOW_MS ??= '300';

let harness: Harness;
let port: number;

beforeAll(async () => { harness = await startHarness(); port = harness.port; }, 30_000);
afterAll(async () => { await harness.stop(); });

type ActionTaken = Extract<ServerMessage, { type: 'action-taken' }>;
function actions(log: ServerMessage[], from = 0): ActionTaken[] {
  return log.slice(from).filter((m): m is ActionTaken => m.type === 'action-taken');
}

describe('quiet-turn auto-pause', () => {
  it('exports the threshold as a named constant, 6 by default', async () => {
    const { QUIET_TURNS_BEFORE_PAUSE } = await import('../src/server/game-loop.js');
    expect(QUIET_TURNS_BEFORE_PAUSE).toBe(6);
  });

  it('pauses after 6 whisper-less turns, spends nothing while paused, and a whisper resumes it', async () => {
    const g = await startPlayingGame(port, 'Quiet Table');
    const paused = await g.player.q.waitFor('game-paused', 60_000) as any;
    expect(paused).toMatchObject({ paused: true, reason: 'quiet' });

    const before = actions(g.player.log);
    expect(before).toHaveLength(6);
    expect(before.every(a => a.whisperInfluence === 'none')).toBe(true);

    // The last turn's memory extraction was fired just before the pause
    // aborted it; let that request land, then nothing more may follow.
    await sleep(300);
    const bodiesAtPause = harness.receivedBodies.length;
    const mark = g.player.log.length;
    await sleep(2_000);
    expect(harness.receivedBodies.length).toBe(bodiesAtPause);
    expect(actions(g.player.log, mark)).toHaveLength(0);

    // "Paused after 6 quiet turns — whisper or resume to continue."
    g.player.q.clear(); // drop the six buffered action-takens above
    sendMsg(g.player.ws, { type: 'whisper', text: 'Wake up. The tide is turning.' });
    const ack = await g.player.q.waitFor('whisper-ack', 10_000) as any;
    expect(ack.status).not.toBe('rejected');
    expect(await g.player.q.waitFor('game-paused', 10_000)).toMatchObject({ paused: false });
    const next = await g.player.q.waitFor('action-taken', 30_000) as any;
    expect(next.whisperInfluence).not.toBe('none');

    await endGame(g.host);
    await leave(g.host, g.player);
  }, 120_000);

  it('a whisper resets the count: six more quiet turns are needed after it', async () => {
    const g = await startPlayingGame(port, 'Quiet Reset');
    for (let i = 0; i < 3; i++) await g.player.q.waitFor('action-taken', 30_000);
    sendMsg(g.player.ws, { type: 'whisper', text: 'Look at the harbour lights.' });
    const ack = await g.player.q.waitFor('whisper-ack', 10_000) as any;
    expect(ack.status).not.toBe('rejected');

    const paused = await g.player.q.waitFor('game-paused', 90_000) as any;
    expect(paused.reason).toBe('quiet');
    const all = actions(g.player.log);
    const lastHeard = all.map(a => a.whisperInfluence !== 'none').lastIndexOf(true);
    expect(lastHeard).toBeGreaterThanOrEqual(3);
    expect(all.length - 1 - lastHeard).toBe(6);

    await endGame(g.host);
    await leave(g.host, g.player);
  }, 150_000);
});
