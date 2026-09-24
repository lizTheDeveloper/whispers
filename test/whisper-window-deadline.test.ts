// The whisper window's length is the server's: whisper-prompt carries it
// (windowMs) and what is left of it (remainingMs), the first window of a
// session is longer — it opens under the arrival, the introductions and the
// first scene all at once — and a tab that rejoins mid-window gets the prompt
// back with the time the server's countdown really has left.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';
import { startPlayingGame, seatOn, sleep, closeWs, endGame, leave } from './lib/playing-game.js';
import type { ServerMessage } from '../src/shared/protocol.js';

process.env.WHISPER_WINDOW_MS ??= '3000';
process.env.FIRST_WHISPER_WINDOW_MS ??= '6000';
const WINDOW = Number(process.env.WHISPER_WINDOW_MS);
const FIRST = Number(process.env.FIRST_WHISPER_WINDOW_MS);

let harness: Harness;
beforeAll(async () => { harness = await startHarness(); }, 30_000);
afterAll(async () => { await harness.stop(); });

type Prompt = Extract<ServerMessage, { type: 'whisper-prompt' }>;

describe('the whisper window', () => {
  it('is sent with the prompt, is longer the first time, and a rejoining tab gets the true time left', async () => {
    const g = await startPlayingGame(harness.port, 'Whisper Window');
    const first = await g.player.q.waitFor('whisper-prompt', 30_000) as Prompt;
    expect(first.windowMs).toBe(FIRST);
    expect(first.remainingMs).toBe(FIRST);

    await sleep(1_500);
    await closeWs(g.player.ws);
    const ws = await connectWs(harness.port);
    const back = seatOn(ws, g.player.token);
    sendMsg(ws, { type: 'rejoin', joinCode: g.joinCode, sessionToken: g.player.token });
    const replayed = await back.q.waitFor('whisper-prompt', 10_000) as Prompt;
    expect(replayed.characterId).toBe(first.characterId);
    expect(replayed.windowMs).toBe(FIRST);
    // ~1.5s of the window has gone: not the full window again, not expired.
    expect(replayed.remainingMs!).toBeLessThanOrEqual(FIRST - 1_400);
    expect(replayed.remainingMs!).toBeGreaterThan(FIRST - 3_000);

    // The window closes unwhispered; the next one is an ordinary one.
    const second = await back.q.waitFor('whisper-prompt', 30_000) as Prompt;
    expect(second.windowMs).toBe(WINDOW);
    expect(second.remainingMs).toBe(WINDOW);

    await endGame(g.host);
    await leave(g.host, back);
  }, 60_000);
});
