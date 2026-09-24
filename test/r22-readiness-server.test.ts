// Round 22 (live BH9P94): after the host's Mature reply the DM's "the game is
// ready" sentence was replaced by a "Before we begin: …" list computed from
// readiness as it stood BEFORE the reply — so it still said "The DM still
// needs a summary of how you want this game run", while the readiness sent
// with the same reply (after the summary was saved) showed it met. The list
// is now computed from the readiness at send time.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';

let harness: Harness;
beforeAll(async () => { harness = await startHarness(); }, 30_000);
afterAll(async () => { await harness.stop(); });

describe('the "Before we begin" list is the readiness at send time', () => {
  it('never lists the summary the same reply just saved', async () => {
    const ws = await connectWs(harness.port);
    const q = new MessageQueue(ws);
    sendMsg(ws, { type: 'create', name: 'R22', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
    await q.waitFor('room-joined', 10_000);
    await q.waitFor('dm-chat-reply', 10_000);
    sendMsg(ws, { type: 'dm-chat', text: 'Mature, please. READY_CLAIM_TRIGGER' });
    const reply = await q.waitFor('dm-chat-reply', 15_000) as any;
    const readiness = await q.waitFor('world-readiness', 10_000) as any;
    expect(reply.done).toBe(true);
    expect(readiness.readiness.unmet).not.toContain('dmInstructions');
    // The unready claim is gone, and what replaced it agrees with the checklist.
    expect(reply.text).not.toMatch(/ready to begin/);
    expect(reply.text).toContain('Before we begin:');
    expect(reply.text).not.toMatch(/still needs a summary/);
    for (const line of readiness.readiness.detail) expect(reply.text).toContain(line);
    ws.close();
  }, 30_000);
});
