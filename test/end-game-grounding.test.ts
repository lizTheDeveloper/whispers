// End Game, server side, from a live two-browser playtest: ending during an
// open whisper window must close that window without a turn outcome (no
// silence verdict, no trust change, no status line), and the epilogue must
// be written from what actually happened at the table — the real story
// lines, never the whispers — with unresolved threads left open instead of
// resolved by invention.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg } from './lib/ws-helpers.js';
import { startHarness, slowLlmToken, LLM_STUB_REPLIES, type Harness } from './lib/server-harness.js';
import { startPlayingGame, seatOn, sleep, waitForPhase, endGame, leave } from './lib/playing-game.js';
import type { ServerMessage } from '../src/shared/protocol.js';

process.env.WHISPER_WINDOW_MS ??= '1500';

let harness: Harness;

beforeAll(async () => { harness = await startHarness(); }, 30_000);
afterAll(async () => { await harness.stop(); });

const EPILOGUE_MARKER = 'You write brief TTRPG session epilogues';
const epilogueBodies = () => harness.receivedBodies.filter(b => b.includes(EPILOGUE_MARKER));
const isReflection = (m: ServerMessage) =>
  m.type === 'action-taken' && m.whisperInfluence === 'none' && /^\[(Final reflection|Reflects quietly)/.test(m.action);

describe('End Game during an open whisper window', () => {
  it('closes the window without a turn outcome and tells every client the table is ending first', async () => {
    const g = await startPlayingGame(harness.port, 'End In Window');
    await g.player.q.waitFor('whisper-prompt', 30_000);
    // Both seats have the open window before either log is marked.
    await g.host.q.waitFor('whisper-prompt', 10_000);
    const mark = g.player.log.length;
    const hostMark = g.host.log.length;

    sendMsg(g.host.ws, { type: 'end-game' });
    await waitForPhase(g.player.q, 'ended', 30_000);
    await sleep(2_500); // past when the 1.5s window would have run out

    for (const after of [g.player.log.slice(mark), g.host.log.slice(hostMark)]) {
      const types = after.map(m => m.type);
      expect(types).not.toContain('whisper-prompt');
      expect(types).not.toContain('dice-roll');
      expect(types).not.toContain('resolution');
      expect(types).not.toContain('character-state-update');
      expect(after.filter(m => m.type === 'action-taken' && !isReflection(m))).toEqual([]);
      const endingAt = types.indexOf('game-ending');
      const epilogueAt = after.findIndex(m => m.type === 'narration' && m.isEpilogue);
      expect(endingAt).toBeGreaterThanOrEqual(0);
      expect(endingAt).toBeLessThan(epilogueAt);
    }
    await leave(g.host, g.player);
  }, 120_000);
});

describe('the epilogue is grounded in play', () => {
  it('quotes the actual story lines, never the whisper, and tells the DM not to invent outcomes', async () => {
    const g = await startPlayingGame(harness.port, 'Grounded Epilogue');
    await g.player.q.waitFor('whisper-prompt', 30_000);
    const secret = 'ZQX the cellar key is under the third stair';
    sendMsg(g.player.ws, { type: 'whisper', text: `${slowLlmToken()} ${secret}` });
    await g.player.q.waitFor('action-taken', 30_000);
    await g.player.q.waitFor('resolution', 30_000);

    const before = epilogueBodies().length;
    await endGame(g.host);
    const bodies = epilogueBodies().slice(before);
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    // The one turn that was played, as the table saw it.
    expect(body).toContain(LLM_STUB_REPLIES.slowDecision.chosenAction);
    // Whispers are one player's private voice, not the story.
    expect(body).not.toContain('ZQX');
    expect(body).not.toContain('heeded the whisper');
    // No invention: only what happened, and open threads stay open.
    expect(body).toMatch(/only events that actually occurred/i);
    expect(body).toMatch(/remains unanswered/i);
    // Ended mid-scene-one with a turn played: one scene, not zero.
    expect(body).toMatch(/Session complete: 1 scene\b/);
    await leave(g.host, g.player);
  }, 120_000);

  it('still quotes the story when End Game lands on a restart-stranded table', async () => {
    const g = await startPlayingGame(harness.port, 'Grounded After Restart');
    await g.player.q.waitFor('whisper-prompt', 30_000);
    sendMsg(g.player.ws, { type: 'whisper', text: `${slowLlmToken()} go` });
    await g.player.q.waitFor('resolution', 30_000);
    await harness.restart();

    const host = seatOn(await connectWs(harness.port), g.host.token);
    sendMsg(host.ws, { type: 'rejoin', joinCode: g.joinCode, sessionToken: g.host.token });
    await host.q.waitFor('game-paused', 10_000);
    const before = epilogueBodies().length;
    await endGame(host);
    const body = epilogueBodies().slice(before)[0] ?? '';
    expect(body).toContain(LLM_STUB_REPLIES.slowDecision.chosenAction);
    expect(body).toMatch(/Session complete: 1 scene\b/);
    await leave(host);
  }, 120_000);
});
