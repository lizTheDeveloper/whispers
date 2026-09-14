import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, type Harness, LLM_STUB_REPLIES } from './lib/server-harness.js';
import type { WebSocket } from 'ws';

let harness: Harness;
let port: number;

beforeAll(async () => { harness = await startHarness(); port = harness.port; }, 30_000);
afterAll(async () => { await harness.stop(); });

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((r) => { ws.once('close', () => r()); ws.close(); });
}

async function createGame() {
  const ws = await connectWs(port);
  const q = new MessageQueue(ws);
  sendMsg(ws, { type: 'create', name: 'World Test', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
  const joined = await q.waitFor('room-joined', 10_000) as any;
  await q.waitFor('dm-chat-reply', 10_000);
  return { ws, q, joined };
}

describe('World setup gates the table', () => {
  it('does not open the table when the model says done', async () => {
    const { ws, q, joined } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse.' });
    await q.waitFor('dm-chat-reply', 15_000);

    // The model asserted done, but the seed has not been accepted.
    await expect(q.waitFor('phase-change', 2_000)).rejects.toThrow(/Timeout/);

    const readiness = await q.waitFor('world-readiness', 10_000) as any;
    expect(readiness.readiness.ready).toBe(false);
    expect(readiness.readiness.unmet).toContain('seedAccepted');
    expect(readiness.influences).toEqual(LLM_STUB_REPLIES.setupDone.influences);
    expect(joined.phase).toBe('lobby');
    await closeWs(ws);
  }, 30_000);

  it('sends a world seed draft once the conversation has what it needs', async () => {
    const { ws, q } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse.' });
    const draft = await q.waitFor('world-seed-draft', 20_000) as any;
    expect(draft.accepted).toBe(false);
    expect(draft.seed.premise.length).toBeGreaterThan(0);
    expect(draft.seed.locations.length).toBeGreaterThanOrEqual(2);
    await closeWs(ws);
  }, 30_000);

  it('opens the table only after a role is chosen and the seed accepted', async () => {
    const { ws, q } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse.' });
    const draft = await q.waitFor('world-seed-draft', 20_000) as any;

    // Accepting without a table role must be refused.
    sendMsg(ws, { type: 'accept-world-seed', seed: draft.seed } as any);
    const blocked = await q.waitFor('world-readiness', 10_000) as any;
    expect(blocked.readiness.unmet).toContain('tableRole');

    sendMsg(ws, { type: 'choose-table-role', role: 'dm' } as any);
    await q.waitFor('room-joined', 10_000);

    sendMsg(ws, { type: 'accept-world-seed', seed: draft.seed } as any);
    const phase = await q.waitFor('phase-change', 15_000) as any;
    expect(phase.phase).toBe('character-creation');
    await closeWs(ws);
  }, 40_000);

  it('refuses a seed that does not meet the checklist', async () => {
    const { ws, q } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse.' });
    const draft = await q.waitFor('world-seed-draft', 20_000) as any;
    sendMsg(ws, { type: 'choose-table-role', role: 'dm' } as any);
    await q.waitFor('room-joined', 10_000);

    const thin = { ...draft.seed, locations: [draft.seed.locations[0]], npcs: [] };
    sendMsg(ws, { type: 'accept-world-seed', seed: thin } as any);
    const readiness = await q.waitFor('world-readiness', 10_000) as any;
    expect(readiness.readiness.unmet).toContain('seed');
    await expect(q.waitFor('phase-change', 2_000)).rejects.toThrow(/Timeout/);
    await closeWs(ws);
  }, 40_000);

  it('writes the accepted seed into the world bible', async () => {
    const { ws, q, joined } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse.' });
    const draft = await q.waitFor('world-seed-draft', 20_000) as any;
    sendMsg(ws, { type: 'choose-table-role', role: 'dm' } as any);
    await q.waitFor('room-joined', 10_000);
    sendMsg(ws, { type: 'accept-world-seed', seed: draft.seed } as any);
    await q.waitFor('phase-change', 15_000);

    // The test file and the harness-imported server share a module registry,
    // so getDb() here returns the same handle the server just wrote through.
    const { getDb } = await import('../src/server/db.js');
    const { WorldBible } = await import('../src/server/world-bible.js');
    const wb = new WorldBible(getDb());
    const names = wb.getAllLocationNames(joined.campaignId);
    for (const loc of draft.seed.locations) {
      expect(names).toContain(loc.name);
    }
    await closeWs(ws);
  }, 40_000);

  it('refuses dm-chat once the world is accepted', async () => {
    const { ws, q } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse.' });
    // Drain the reply to this dm-chat before proceeding — otherwise it sits
    // unread in the buffer and would be handed back, stale, to the
    // waitForAny(['error', 'dm-chat-reply']) below instead of the response
    // to the *second* dm-chat this test actually cares about.
    await q.waitFor('dm-chat-reply', 15_000);
    const draft = await q.waitFor('world-seed-draft', 20_000) as any;
    sendMsg(ws, { type: 'choose-table-role', role: 'dm' } as any);
    await q.waitFor('room-joined', 10_000);
    sendMsg(ws, { type: 'accept-world-seed', seed: draft.seed } as any);
    await q.waitFor('phase-change', 15_000);

    sendMsg(ws, { type: 'dm-chat', text: 'anything' });
    const reply = await q.waitForAny(['error', 'dm-chat-reply'], 10_000) as any;
    expect(reply.type).toBe('error'); // dm-chat is closed once the world is accepted
    await closeWs(ws);
  }, 40_000);
});
