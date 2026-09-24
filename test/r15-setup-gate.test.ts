// Round 15 (RZBU7G): the host asked for gentle peril, and the setup chat —
// outside the tone gate — offered "the risk of being filed away in a drawer
// forever" as the danger. Once the host has asked, every setup reply is
// judged like the DM's play prose; a flagged one is written fresh once with
// the phrase as feedback, and the host reads the second.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';

let harness: Harness;
beforeAll(async () => { harness = await startHarness(); }, 30_000);
afterAll(async () => { await harness?.stop(); });

async function hostSays(text: string) {
  const ws = await connectWs(harness.port);
  const q = new MessageQueue(ws);
  sendMsg(ws, { type: 'create', name: 'R15 setup', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
  await q.waitFor('room-joined', 10_000);
  await q.waitFor('dm-chat-reply', 10_000); // the greeting
  const before = harness.receivedBodies.length;
  sendMsg(ws, { type: 'dm-chat', text });
  const reply = await q.waitFor('dm-chat-reply', 10_000) as { text: string };
  const bodies = harness.receivedBodies.slice(before);
  ws.close();
  return { reply, bodies };
}

describe('round 15: the setup chat at a gentle-peril table', () => {
  it('the live danger is flagged, written again with the phrase as feedback, and the host reads the gentle one', async () => {
    const { reply, bodies } = await hostSays('Liz and her kid Biz get misfiled into a Discworld-ish bureaucracy. Gentle peril please. GENTLE_DRAWER_TRIGGER');
    expect(reply.text).not.toContain('drawer forever');
    expect(reply.text).toContain('a queue with opinions');
    const setups = bodies.filter(b => b.includes('helping set up a new game'));
    expect(setups).toHaveLength(2);
    // Both drafts carry the register; only the second the feedback.
    for (const b of setups) expect(b).toContain('GENTLE PERIL register');
    expect(setups[1]).toContain('<tone_feedback>');
    expect(setups[1]).toContain('being filed away in a drawer forever');
    expect(bodies.filter(b => b.includes('TONE JUDGE')).length).toBe(2);
  });

  it('a host who has not asked for gentle peril: no judge, no register', async () => {
    const { bodies } = await hostSays('A grim noir city of rain and debts. GENTLE_DRAWER_TRIGGER');
    expect(bodies.some(b => b.includes('TONE JUDGE'))).toBe(false);
    expect(bodies.find(b => b.includes('helping set up a new game'))).not.toContain('GENTLE PERIL register');
  });
});
