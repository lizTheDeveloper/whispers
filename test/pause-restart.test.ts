// Every deploy restarts the server, and a restart used to strand every
// running game: the DB still said 'playing', no loop existed, and whispers
// got "There is no game running". Now boot marks those games paused
// (reason 'restart'), nothing spends an LLM call until the host says so, and
// the host's Resume rebuilds the loop from its last checkpoint.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';
import { startPlayingGame, seatOn, sleep, endGame, leave } from './lib/playing-game.js';

process.env.WHISPER_WINDOW_MS ??= '800';

let harness: Harness;

beforeAll(async () => { harness = await startHarness(); }, 30_000);
afterAll(async () => { await harness.stop(); });

// Imported fresh on every call: after harness.restart() the server runs on
// a new copy of the module graph, and this must read through the same one.
async function db() {
  return (await import('../src/server/db.js')).getDb();
}
async function maxCheckpointTurn(campaignId: string): Promise<number> {
  const row = (await db()).prepare('SELECT MAX(turn_number) AS t FROM checkpoints WHERE campaign_id = ?').get(campaignId) as { t: number | null };
  return row.t ?? 0;
}

describe('server restart with a game in play', () => {
  it('comes back paused (reason restart) with no LLM traffic, and the host resumes it from the checkpoint', async () => {
    const g = await startPlayingGame(harness.port, 'Restart Test');
    // Let two whisper-less turns land so there is a real checkpoint.
    await g.player.q.waitFor('resolution', 30_000);
    await g.player.q.waitFor('resolution', 30_000);

    await harness.restart();
    // A request the old process fired a moment before it died can still be
    // in the stub's inbox; let it land, then nothing more may follow.
    await sleep(300);
    const bodiesAtBoot = harness.receivedBodies.length;
    // Read after the old process is gone, so no late checkpoint can race it.
    const turnBefore = await maxCheckpointTurn(g.campaignId);
    expect(turnBefore).toBeGreaterThanOrEqual(2);

    const row = (await db()).prepare('SELECT phase, paused_at, paused_reason FROM campaigns WHERE id = ?').get(g.campaignId) as any;
    expect(row.phase).toBe('playing');
    expect(row.paused_reason).toBe('restart');
    expect(row.paused_at).not.toBeNull();

    const host = seatOn(await connectWs(harness.port), g.host.token);
    sendMsg(host.ws, { type: 'rejoin', joinCode: g.joinCode, sessionToken: g.host.token });
    const joined = await host.q.waitFor('room-joined', 10_000) as any;
    expect(joined.phase).toBe('playing');
    const state = await host.q.waitFor('game-paused', 10_000) as any;
    expect(state).toMatchObject({ paused: true, reason: 'restart' });

    const player = seatOn(await connectWs(harness.port), g.player.token);
    sendMsg(player.ws, { type: 'rejoin', joinCode: g.joinCode, sessionToken: g.player.token });
    await player.q.waitFor('room-joined', 10_000);
    expect(await player.q.waitFor('game-paused', 10_000)).toMatchObject({ paused: true, reason: 'restart' });

    // A whisper into the stranded game is told why, not "no game running".
    sendMsg(player.ws, { type: 'whisper', text: 'Are we still here?' });
    const ack = await player.q.waitFor('whisper-ack', 10_000) as any;
    expect(ack.status).toBe('rejected');
    expect(ack.message).toMatch(/paused/i);

    await sleep(1_500);
    expect(harness.receivedBodies.length).toBe(bodiesAtBoot);

    sendMsg(host.ws, { type: 'resume-game' });
    expect(await player.q.waitFor('game-paused', 10_000)).toMatchObject({ paused: false });
    await player.q.waitFor('resolution', 30_000);
    // The rebuilt loop picked up the story where the checkpoint left it.
    expect(await maxCheckpointTurn(g.campaignId)).toBe(turnBefore + 1);
    const pausedAfter = (await db()).prepare('SELECT paused_at FROM campaigns WHERE id = ?').get(g.campaignId) as any;
    expect(pausedAfter.paused_at).toBeNull();

    await endGame(host);
    await leave(host, player);
  }, 120_000);

  it('End Game on a restart-stranded table still writes the epilogue', async () => {
    const g = await startPlayingGame(harness.port, 'Restart Then End');
    await g.player.q.waitFor('resolution', 30_000);
    await harness.restart();

    const host = seatOn(await connectWs(harness.port), g.host.token);
    sendMsg(host.ws, { type: 'rejoin', joinCode: g.joinCode, sessionToken: g.host.token });
    await host.q.waitFor('game-paused', 10_000);
    const mark = host.log.length;
    await endGame(host);
    expect(host.log.slice(mark).some(m => m.type === 'narration' && m.isEpilogue)).toBe(true);
    const row = (await db()).prepare('SELECT phase, paused_at FROM campaigns WHERE id = ?').get(g.campaignId) as any;
    expect(row).toMatchObject({ phase: 'ended', paused_at: null });
    await leave(host);
  }, 120_000);
});
