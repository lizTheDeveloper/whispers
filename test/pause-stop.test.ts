// "There's no way to pause or stop it?" — host Pause/Resume, a real Stop,
// and an auto-pause when nobody is at the table. Real sockets, canned LLM
// stub. The stub's receivedBodies is the meter: a paused table must not
// spend a single LLM request.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg } from './lib/ws-helpers.js';
import { startHarness, slowLlmToken, type Harness } from './lib/server-harness.js';
import {
  startPlayingGame, seatOn, sleep, waitUntil, closeWs, waitForPhase, endGame, leave,
} from './lib/playing-game.js';
import type { ServerMessage } from '../src/shared/protocol.js';

// Short whisper windows so a whisper-less turn takes ~a second, not 30.
process.env.WHISPER_WINDOW_MS ??= '1500';

let harness: Harness;
let port: number;

beforeAll(async () => { harness = await startHarness(); port = harness.port; }, 30_000);
afterAll(async () => { await harness.stop(); });

async function db() {
  return (await import('../src/server/db.js')).getDb();
}
async function pauseRow(campaignId: string): Promise<{ paused_at: string | null; paused_reason: string | null }> {
  return (await db()).prepare('SELECT paused_at, paused_reason FROM campaigns WHERE id = ?').get(campaignId) as any;
}
async function checkpointTurns(campaignId: string): Promise<number[]> {
  const rows = (await db()).prepare('SELECT turn_number FROM checkpoints WHERE campaign_id = ? ORDER BY turn_number').all(campaignId) as Array<{ turn_number: number }>;
  return rows.map(r => r.turn_number);
}
function typesSince(log: ServerMessage[], mark: number): string[] {
  return log.slice(mark).map(m => m.type);
}

describe('host pause / resume', () => {
  it('pausing mid-decision stops all LLM traffic and applies nothing; resume finishes the same turn without skipping or repeating a turn number', async () => {
    const g = await startPlayingGame(port, 'Pause Mid Turn');
    await g.player.q.waitFor('whisper-prompt', 30_000);

    const token = slowLlmToken();
    sendMsg(g.player.ws, { type: 'whisper', text: `${token} try the lamp room door` });
    const ack = await g.player.q.waitFor('whisper-ack', 10_000) as any;
    expect(ack.status).toBe('delivered');
    // decideAction is now in flight (the stub holds it for 2.5s).
    await waitUntil(() => harness.receivedBodies.some(b => b.includes(token)), 15_000, 'decideAction request');

    sendMsg(g.host.ws, { type: 'pause-game' });
    const paused = await g.player.q.waitFor('game-paused', 10_000) as any;
    expect(paused).toMatchObject({ paused: true, reason: 'host' });
    expect((await pauseRow(g.campaignId)).paused_reason).toBe('host');

    const bodiesAtPause = harness.receivedBodies.length;
    const mark = g.player.log.length;
    await sleep(3_500); // well past when the held decision would have answered
    expect(harness.receivedBodies.length).toBe(bodiesAtPause);
    const quiet = typesSince(g.player.log, mark);
    expect(quiet).not.toContain('action-taken');
    expect(quiet).not.toContain('resolution');
    expect(quiet).not.toContain('dice-roll');
    expect(await checkpointTurns(g.campaignId)).toEqual([]);

    sendMsg(g.host.ws, { type: 'resume-game' });
    const resumed = await g.player.q.waitFor('game-paused', 10_000) as any;
    expect(resumed.paused).toBe(false);
    expect((await pauseRow(g.campaignId)).paused_at).toBeNull();

    const resumeMark = g.player.log.length;
    const action = await g.player.q.waitFor('action-taken', 30_000) as any;
    // The whisper the window already took is still the one the redone decision hears.
    expect(action.whisperInfluence).not.toBe('none');
    await g.player.q.waitFor('resolution', 30_000);
    expect(typesSince(g.player.log, resumeMark).filter(t => t === 'action-taken')).toHaveLength(1);
    expect(await checkpointTurns(g.campaignId)).toEqual([1]);

    // The next turn is turn 2 — nothing skipped, nothing doubled.
    await g.player.q.waitFor('action-taken', 30_000);
    await g.player.q.waitFor('resolution', 30_000);
    expect(await checkpointTurns(g.campaignId)).toEqual([1, 2]);

    await endGame(g.host);
    await leave(g.host, g.player);
  }, 120_000);

  it('holds an open whisper window while paused instead of timing it out', async () => {
    const g = await startPlayingGame(port, 'Pause Holds Window');
    await g.player.q.waitFor('whisper-prompt', 30_000);
    sendMsg(g.host.ws, { type: 'pause-game' });
    await g.player.q.waitFor('game-paused', 10_000);

    const bodiesAtPause = harness.receivedBodies.length;
    const mark = g.player.log.length;
    await sleep(2_500); // longer than the 1.5s window
    expect(typesSince(g.player.log, mark)).not.toContain('action-taken');
    expect(harness.receivedBodies.length).toBe(bodiesAtPause);

    // The window is still open for this character, so the words land in it.
    sendMsg(g.player.ws, { type: 'whisper', text: 'Wait for the tide.' });
    const ack = await g.player.q.waitFor('whisper-ack', 10_000) as any;
    expect(ack.status).toBe('delivered');
    await sleep(500);
    expect(typesSince(g.player.log, mark)).not.toContain('action-taken');

    sendMsg(g.host.ws, { type: 'resume-game' });
    const action = await g.player.q.waitFor('action-taken', 30_000) as any;
    expect(action.whisperInfluence).not.toBe('none');

    await endGame(g.host);
    await leave(g.host, g.player);
  }, 120_000);

  it('refuses pause-game and resume-game from a non-host seat', async () => {
    const g = await startPlayingGame(port, 'Pause Refused');
    await g.player.q.waitFor('whisper-prompt', 30_000);

    sendMsg(g.player.ws, { type: 'pause-game' });
    const err = await g.player.q.waitFor('error', 10_000) as any;
    expect(err.message).toMatch(/host/i);
    await sleep(300);
    expect(g.host.log.some(m => m.type === 'game-paused')).toBe(false);
    expect((await pauseRow(g.campaignId)).paused_at).toBeNull();

    sendMsg(g.host.ws, { type: 'pause-game' });
    await g.host.q.waitFor('game-paused', 10_000);
    sendMsg(g.player.ws, { type: 'resume-game' });
    const err2 = await g.player.q.waitFor('error', 10_000) as any;
    expect(err2.message).toMatch(/host/i);
    await sleep(300);
    expect((await pauseRow(g.campaignId)).paused_reason).toBe('host');
    expect(g.host.log.filter(m => m.type === 'game-paused')).toHaveLength(1);

    await endGame(g.host);
    await leave(g.host, g.player);
  }, 120_000);

  it('a refreshed tab learns the table is paused', async () => {
    const g = await startPlayingGame(port, 'Pause Rejoin');
    await g.player.q.waitFor('whisper-prompt', 30_000);
    sendMsg(g.host.ws, { type: 'pause-game' });
    await g.player.q.waitFor('game-paused', 10_000);

    await closeWs(g.player.ws);
    const again = seatOn(await connectWs(port), g.player.token);
    sendMsg(again.ws, { type: 'rejoin', joinCode: g.joinCode, sessionToken: g.player.token });
    await again.q.waitFor('room-joined', 10_000);
    const state = await again.q.waitFor('game-paused', 10_000) as any;
    expect(state).toMatchObject({ paused: true, reason: 'host' });

    await endGame(g.host);
    await leave(g.host, again);
  }, 120_000);
});

describe('end game', () => {
  it('ending during decideAction aborts the turn — no resolution — and still delivers the epilogue', async () => {
    const g = await startPlayingGame(port, 'End Mid Turn');
    await g.player.q.waitFor('whisper-prompt', 30_000);
    const token = slowLlmToken();
    sendMsg(g.player.ws, { type: 'whisper', text: `${token} run` });
    await g.player.q.waitFor('whisper-ack', 10_000);
    await waitUntil(() => harness.receivedBodies.some(b => b.includes(token)), 15_000, 'decideAction request');

    const mark = g.player.log.length;
    sendMsg(g.host.ws, { type: 'end-game' });
    await waitForPhase(g.player.q, 'ended', 30_000);
    await sleep(3_000); // past when the held decision would have answered

    const after = g.player.log.slice(mark);
    const types = after.map(m => m.type);
    expect(types).not.toContain('resolution');
    expect(types).not.toContain('dice-roll');
    expect(after.some(m => m.type === 'narration' && m.isEpilogue)).toBe(true);
    const endedAt = types.indexOf('phase-change');
    const epilogueAt = after.findIndex(m => m.type === 'narration' && m.isEpilogue);
    expect(epilogueAt).toBeLessThan(endedAt);
    await leave(g.host, g.player);
  }, 120_000);
});

describe('auto-pause with nobody at the table', () => {
  it('keeps a deliberate host pause as a host pause when everyone then leaves', async () => {
    const g = await startPlayingGame(port, 'Host Pause Then Empty');
    await g.player.q.waitFor('whisper-prompt', 30_000);
    sendMsg(g.host.ws, { type: 'pause-game' });
    await g.host.q.waitFor('game-paused', 10_000);
    await leave(g.host, g.player);
    await sleep(200);
    expect((await pauseRow(g.campaignId)).paused_reason).toBe('host');

    const host = seatOn(await connectWs(port), g.host.token);
    sendMsg(host.ws, { type: 'rejoin', joinCode: g.joinCode, sessionToken: g.host.token });
    expect(await host.q.waitFor('game-paused', 10_000)).toMatchObject({ paused: true, reason: 'host' });
    await endGame(host);
    await leave(host);
  }, 120_000);

  it('pauses (reason no-players) once the table stays empty, spends nothing, and the host can resume on return', async () => {
    const g = await startPlayingGame(port, 'Empty Table');
    await g.player.q.waitFor('whisper-prompt', 30_000);

    await closeWs(g.player.ws);
    await closeWs(g.host.ws);
    // Not instant (a refresh must not pause the table — see below), but no
    // later than the room teardown, which must never strand an unpaused game.
    const deadline = Date.now() + 5_000;
    while ((await pauseRow(g.campaignId)).paused_reason !== 'no-players' && Date.now() < deadline) await sleep(50);
    const row = await pauseRow(g.campaignId);
    expect(row.paused_reason).toBe('no-players');
    expect(row.paused_at).not.toBeNull();

    const bodiesAtPause = harness.receivedBodies.length;
    await sleep(2_500);
    expect(harness.receivedBodies.length).toBe(bodiesAtPause);

    // Past the teardown grace the loop is gone; the host's Resume rebuilds it.
    const host = seatOn(await connectWs(port), g.host.token);
    sendMsg(host.ws, { type: 'rejoin', joinCode: g.joinCode, sessionToken: g.host.token });
    await host.q.waitFor('room-joined', 10_000);
    const state = await host.q.waitFor('game-paused', 10_000) as any;
    expect(state).toMatchObject({ paused: true, reason: 'no-players' });
    await sleep(500);
    expect(harness.receivedBodies.length).toBe(bodiesAtPause);

    sendMsg(host.ws, { type: 'resume-game' });
    const resumed = await host.q.waitFor('game-paused', 10_000) as any;
    expect(resumed.paused).toBe(false);
    await host.q.waitFor('whisper-prompt', 30_000);

    await endGame(host);
    await closeWs(host.ws);
  }, 120_000);
  it('a refresh (the last tab disconnects and comes straight back) does not pause the table', async () => {
    const g = await startPlayingGame(port, 'Refresh Table');
    await g.player.q.waitFor('whisper-prompt', 30_000);
    await closeWs(g.player.ws); // one tab left: the host's

    // Refresh the host's tab: the old socket closes, the new one rejoins at once.
    const fresh = seatOn(await connectWs(port), g.host.token);
    await closeWs(g.host.ws);
    sendMsg(fresh.ws, { type: 'rejoin', joinCode: g.joinCode, sessionToken: g.host.token });
    await fresh.q.waitFor('room-joined', 10_000);

    await sleep(1_500); // well past the (test) teardown grace
    expect((await pauseRow(g.campaignId)).paused_at).toBeNull();
    expect(fresh.log.some(m => m.type === 'game-paused' && (m as any).paused)).toBe(false);

    await endGame(fresh);
    await closeWs(fresh.ws);
  }, 120_000);
});
