// Round 8, live finding 1 (game EV94GS): after Whispers moved to
// qwen/qwen3.8-27b the DM's setup greeting failed — "[dm-setup] greeting
// failed: LLM proxy returned 400", the proxy saying "raise_exception: No user
// query found in messages". The greeting (dm.setupChat with an empty
// history) sent a system message and nothing else, and Qwen's chat template
// needs a user turn. The harness's LLM stub now refuses such a request the
// same way; this walks the flows the harness drives and checks every body.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, templateViolations, chatTemplateViolation, type Harness } from './lib/server-harness.js';
import { startPlayingGame, endGame, leave, waitUntil, sleep, seatOn, PLAYING_CHAR } from './lib/playing-game.js';
import { connectWs, sendMsg } from './lib/ws-helpers.js';
import { finishWorldSetup } from './lib/finish-world-setup.js';

let harness: Harness;
// Imported after the harness has pointed LLM_PROXY_URL at its stub (the
// client reads it at import time).
let withUserTurn: typeof import('../src/server/agents/llm-client.js').withUserTurn;
let DmAgent: typeof import('../src/server/agents/dm.js').DmAgent;
let getDb: typeof import('../src/server/db.js').getDb;
beforeAll(async () => {
  harness = await startHarness();
  ({ withUserTurn } = await import('../src/server/agents/llm-client.js'));
  ({ DmAgent } = await import('../src/server/agents/dm.js'));
  ({ getDb } = await import('../src/server/db.js'));
}, 30_000);
afterAll(async () => { await harness.stop(); });

describe('every request the server sends has a user turn', () => {
  it('the setup greeting (an empty history) is answered, not refused with a 400', async () => {
    // index.ts's create handler: dm.setupChat with history [] — the live
    // "[dm-setup] greeting failed: LLM proxy returned 400".
    const reply = await new DmAgent(getDb()).setupChat({ preset: 'chronicler', systemId: 'fate-core', history: [], unmet: [] });
    expect(reply.reply).toBe('What kind of game are we running?');
    const body = JSON.parse(harness.receivedBodies[harness.receivedBodies.length - 1]!);
    expect(body.messages.some((m: any) => m.role === 'user')).toBe(true);
  });

  it('setup, character creation, play and the epilogue: no body without a user message, no system message after the first', async () => {
    const before = harness.receivedBodies.length;
    const refusedBefore = templateViolations.length;
    const g = await startPlayingGame(harness.port, 'User Turns');
    // The opening and the first beats of play (the stub has no canned play
    // replies, so the loop falls back as it would on a bad reply — the
    // requests are what this checks).
    await waitUntil(() => g.player.log.filter(m => m.type === 'narration').length >= 1, 30_000, 'play to begin');
    await sleep(1500);
    await endGame(g.host);
    await waitUntil(() => g.player.log.some(m => m.type === 'narration' && (m as any).isEpilogue), 30_000, 'the epilogue');
    await leave(g.host, g.player);

    const bodies = harness.receivedBodies.slice(before);
    expect(bodies.length).toBeGreaterThan(5);
    const bad = bodies.map(b => chatTemplateViolation(b)).filter(Boolean);
    expect(bad).toEqual([]);
    expect(templateViolations.slice(refusedBefore)).toEqual([]);

    // Live finding 8: the epilogue narrated a dropped ruler nobody dropped.
    // It is told to narrate only the record, at a lower temperature.
    const epilogue = bodies.map(b => JSON.parse(b)).find(b => b.messages[0].content.includes('You write brief TTRPG session epilogues'));
    expect(epilogue).toBeDefined();
    expect(epilogue.messages[0].content).toContain('Do not narrate any action that is not in the record');
    expect(epilogue.temperature).toBeLessThanOrEqual(0.5);
  }, 90_000);
});

describe('withUserTurn: callLlm guarantees a user turn centrally', () => {
  it('a system-only request gets a minimal user turn after it', () => {
    expect(withUserTurn([{ role: 'system', content: 'You are a DM.' }])).toEqual([
      { role: 'system', content: 'You are a DM.' },
      { role: 'user', content: 'Begin.' },
    ]);
  });
  it('system + assistant only (a history that opens with the DM) gets one at the end', () => {
    const out = withUserTurn([{ role: 'system', content: 's' }, { role: 'assistant', content: 'Hello!' }]);
    expect(out.map(m => m.role)).toEqual(['system', 'assistant', 'user']);
  });
  it('a request that already has one is sent as it is', () => {
    const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
    expect(withUserTurn(msgs)).toBe(msgs);
  });
  it('a stray system message after the first is folded into the first', () => {
    expect(withUserTurn([{ role: 'system', content: 'A' }, { role: 'user', content: 'u' }, { role: 'system', content: 'B' }])).toEqual([
      { role: 'system', content: 'A\n\nB' },
      { role: 'user', content: 'u' },
    ]);
  });
});

// Live finding 6: "Please keep 'calls Liz Mom' in the sheet" — and the sheet
// dropped it. The player's own words put the address term on the sheet.
describe('an address term the player states in the interview reaches the sheet', () => {
  it('"calls Vex Mom" is on the proposed sheet even though the model left it out', async () => {
    const hostWs = await connectWs(harness.port);
    const host = seatOn(hostWs);
    sendMsg(hostWs, { type: 'create', name: 'Address Terms', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
    const joined = await host.q.waitFor('room-joined', 10_000) as any;
    await host.q.waitFor('dm-chat-reply', 10_000);
    await finishWorldSetup(hostWs, host.q);

    // Vex Ashgrove is at the table first.
    const aWs = await connectWs(harness.port);
    const a = seatOn(aWs);
    sendMsg(aWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    await a.q.waitFor('room-joined', 10_000);
    sendMsg(aWs, { type: 'submit-character', definition: PLAYING_CHAR });
    const review = await host.q.waitFor('character-pending-review', 20_000) as any;
    sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
    await a.q.waitFor('character-submitted', 10_000);

    const bWs = await connectWs(harness.port);
    const b = seatOn(bWs);
    sendMsg(bWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Kid' });
    await b.q.waitFor('room-joined', 10_000);
    sendMsg(bWs, { type: 'char-chat', text: "My kid is Vex's child. Please keep 'calls Vex Mom' in the sheet." });
    await b.q.waitFor('char-chat-reply', 15_000);
    sendMsg(bWs, { type: 'char-chat', text: 'That is everything.' });
    const preview = await b.q.waitFor('character-preview', 15_000) as any;
    expect(preview.definition.relationships).toEqual([{ to: 'Vex Ashgrove', relation: 'mother', address: 'Mom' }]);
    await leave(host, a, b);
  }, 60_000);
});
