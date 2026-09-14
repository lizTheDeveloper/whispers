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

/**
 * dm-chat sends world-readiness TWICE on the path that also drafts a seed —
 * once right after dm-chat-reply (before drafting), and again after the
 * draft is sent. MessageQueue hands back buffered messages before waiting on
 * new ones, so a test that only drains one of the two and then asserts on
 * "the next world-readiness" can silently get handed the stale first one
 * instead of the one produced by whatever it just did. Drain both before any
 * such assertion.
 */
async function drainDmChatReadiness(q: MessageQueue): Promise<void> {
  await q.waitFor('world-readiness', 10_000);
  await q.waitFor('world-readiness', 10_000);
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
    await drainDmChatReadiness(q);

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
    await drainDmChatReadiness(q);
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

  it('accepts an edited seed, not the previously stored draft', async () => {
    // Every other acceptance test sends back the draft byte-identical to
    // what the server stored, so none of them would catch a regression that
    // silently re-read the stored draft instead of the seed in msg.seed. The
    // host can edit a draft before accepting it — the edit must be what
    // lands in the world bible.
    const { ws, q, joined } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse.' });
    const draft = await q.waitFor('world-seed-draft', 20_000) as any;
    await drainDmChatReadiness(q);
    sendMsg(ws, { type: 'choose-table-role', role: 'dm' } as any);
    await q.waitFor('room-joined', 10_000);

    const originalName = draft.seed.locations[0].name;
    const edited = {
      ...draft.seed,
      locations: [
        { ...draft.seed.locations[0], name: 'The Drowned Belfry' },
        ...draft.seed.locations.slice(1),
      ],
    };
    sendMsg(ws, { type: 'accept-world-seed', seed: edited } as any);
    await q.waitFor('phase-change', 15_000);

    const { getDb } = await import('../src/server/db.js');
    const { WorldBible } = await import('../src/server/world-bible.js');
    const wb = new WorldBible(getDb());
    const names = wb.getAllLocationNames(joined.campaignId);
    expect(names).toContain('The Drowned Belfry');
    expect(names).not.toContain(originalName);
    await closeWs(ws);
  }, 40_000);

  it('does not let a regenerate-world-seed clobber a seed accepted while it was in flight', async () => {
    // regenerate-world-seed sits behind a real await (the LLM call that
    // drafts it), same as dm-chat used to. accept-world-seed does not — it
    // is fully synchronous. So a regenerate fired first, followed
    // immediately by an accept of the seed already on screen, lets the
    // accept finish (mark accepted, seed the world bible, advance the
    // phase) entirely before the regenerate's await resolves. The
    // redraft must then be refused, not silently overwrite
    // campaigns.world_seed out from under an already-accepted, already-seeded
    // world.
    const { ws, q, joined } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse.' });
    const draft = await q.waitFor('world-seed-draft', 20_000) as any;
    await drainDmChatReadiness(q);
    sendMsg(ws, { type: 'choose-table-role', role: 'dm' } as any);
    await q.waitFor('room-joined', 10_000);

    sendMsg(ws, { type: 'regenerate-world-seed' } as any);
    sendMsg(ws, { type: 'accept-world-seed', seed: draft.seed } as any);

    // TCP preserves send order on one connection, and accept-world-seed's
    // handler never yields, so these arrive in exactly this order: the
    // accept's own world-seed-draft(accepted: true), its phase-change
    // broadcast, its own readiness — then, once the stubbed LLM call
    // finally resolves, whatever regenerate-world-seed produces.
    const accepted = await q.waitFor('world-seed-draft', 15_000) as any;
    expect(accepted.accepted).toBe(true);
    const phase = await q.waitFor('phase-change', 15_000) as any;
    expect(phase.phase).toBe('character-creation');
    await q.waitFor('world-readiness', 10_000);

    const regenReply = await q.waitForAny(['error', 'world-seed-draft'], 10_000) as any;
    expect(regenReply.type).toBe('error');
    expect(regenReply.message).toMatch(/already accepted/i);

    // And the seed actually in the world bible is the one that was accepted,
    // not a clobber-in-progress from the redraft.
    const { getDb } = await import('../src/server/db.js');
    const { isSeedAccepted } = await import('../src/server/world-seed.js');
    expect(isSeedAccepted(getDb(), joined.campaignId)).toBe(true);

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
