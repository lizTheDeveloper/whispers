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
 * dm-chat sends world-readiness on the path that also drafts a seed — once
 * right after dm-chat-reply (before drafting), and again after the draft is
 * sent — so a stale one can already be buffered ahead of the one a later
 * action (e.g. accept-world-seed) produces. Rather than draining a fixed,
 * easily-outdated count of stale messages, keep consuming world-readiness
 * messages until one matches the expected `unmet` list exactly. The
 * accept-refusal readiness this is used for is always computed with
 * `seedAccepted: true`, so its `unmet` never contains 'seedAccepted' —
 * whereas every stale dm-chat readiness does, since the seed has not been
 * accepted yet at the time it is sent. That makes the target message
 * self-identifying: order-independent, count-independent, and immune to a
 * future third stale message.
 */
async function waitForReadinessUnmet(q: MessageQueue, expectedUnmet: string[]): Promise<any> {
  for (;;) {
    const msg = await q.waitFor('world-readiness', 10_000) as any;
    if (JSON.stringify(msg.readiness.unmet) === JSON.stringify(expectedUnmet)) return msg;
  }
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
    const blocked = await waitForReadinessUnmet(q, ['tableRole']);
    expect(blocked.readiness.unmet).toEqual(['tableRole']);

    sendMsg(ws, { type: 'choose-table-role', role: 'dm' } as any);
    await q.waitFor('room-joined', 10_000);

    sendMsg(ws, { type: 'accept-world-seed', seed: draft.seed } as any);
    const phase = await q.waitFor('phase-change', 15_000) as any;
    expect(phase.phase).toBe('character-creation');
    await closeWs(ws);
  }, 40_000);

  it('round-trips the named influences into lobby-state after setup', async () => {
    const { ws, q, joined } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse.' });
    const draft = await q.waitFor('world-seed-draft', 20_000) as any;

    sendMsg(ws, { type: 'choose-table-role', role: 'dm' } as any);
    await q.waitFor('room-joined', 10_000);

    sendMsg(ws, { type: 'accept-world-seed', seed: draft.seed } as any);
    await q.waitFor('phase-change', 15_000);
    await closeWs(ws);

    // Reconnecting is what rebuilds lobby-state from durable storage — this
    // proves the influences named during setup were actually persisted, not
    // just echoed back on the live socket that named them.
    const ws2 = await connectWs(port);
    const q2 = new MessageQueue(ws2);
    sendMsg(ws2, { type: 'rejoin', joinCode: joined.joinCode, sessionToken: joined.sessionToken } as any);
    const lobby = await q2.waitFor('lobby-state', 15_000) as any;
    expect(lobby.influences).toEqual(LLM_STUB_REPLIES.setupDone.influences);
    await closeWs(ws2);
  }, 40_000);

  it('refuses a seed that does not meet the checklist', async () => {
    const { ws, q } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse.' });
    const draft = await q.waitFor('world-seed-draft', 20_000) as any;
    sendMsg(ws, { type: 'choose-table-role', role: 'dm' } as any);
    await q.waitFor('room-joined', 10_000);

    const thin = { ...draft.seed, locations: [draft.seed.locations[0]], npcs: [] };
    sendMsg(ws, { type: 'accept-world-seed', seed: thin } as any);
    const readiness = await waitForReadinessUnmet(q, ['seed']);
    expect(readiness.readiness.unmet).toEqual(['seed']);
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

  it('does not let dm-chat\'s own draft clobber a seed accepted while it was in flight', async () => {
    // dm-chat drafts a world the same way regenerate-world-seed does: a real
    // await (draftWorldSeed) sits between dm-chat-reply being sent and the
    // draft landing. dm-chat-reply is sent BEFORE that await even starts, so
    // a host who accepts the instant they see the reply — the exact shape of
    // the double-send bug this guards against, since the client's Enter-key
    // handler has no disabled check — can finish accepting (mark accepted,
    // seed the world bible, advance the phase) entirely before dm-chat's own
    // draftWorldSeed resolves. That resolution must then be refused, not
    // silently overwrite campaigns.world_seed out from under an
    // already-accepted, already-seeded world.
    const { ws, q, joined } = await createGame();
    sendMsg(ws, { type: 'choose-table-role', role: 'dm' } as any);
    await q.waitFor('room-joined', 10_000);

    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse.' });
    await q.waitFor('dm-chat-reply', 15_000);

    // A hand-built seed, distinct in content from whatever the stub will
    // draft, so a clobber is detectable by what ends up stored rather than
    // merely by presence.
    const acceptedSeed = {
      premise: 'The world the host actually accepted.',
      locations: [
        { name: 'Accepted Hall', description: 'A room that exists because it was accepted.', terrain: null },
        { name: 'Accepted Yard', description: 'A yard that exists because it was accepted.', terrain: null },
      ],
      npcs: [
        { name: 'Accepted Warden', description: 'Exists because accepted.', disposition: null, motivation: null },
        { name: 'Accepted Scribe', description: 'Exists because accepted.', disposition: null, motivation: null },
      ],
      plotHooks: ['A hook that exists because it was accepted.'],
      items: [],
    };
    sendMsg(ws, { type: 'accept-world-seed', seed: acceptedSeed } as any);

    const accepted = await q.waitFor('world-seed-draft', 15_000) as any;
    expect(accepted.accepted).toBe(true);
    expect(accepted.seed.premise).toBe(acceptedSeed.premise);
    const phase = await q.waitFor('phase-change', 15_000) as any;
    expect(phase.phase).toBe('character-creation');

    // Give dm-chat's own in-flight draft time to resolve and, if the guard
    // regressed, clobber the seed that was just accepted.
    await new Promise((r) => setTimeout(r, 500));

    const { getDb } = await import('../src/server/db.js');
    const { getWorldSeed, isSeedAccepted } = await import('../src/server/world-seed.js');
    expect(isSeedAccepted(getDb(), joined.campaignId)).toBe(true);
    expect(getWorldSeed(getDb(), joined.campaignId)?.premise).toBe(acceptedSeed.premise);

    const { WorldBible } = await import('../src/server/world-bible.js');
    const wb = new WorldBible(getDb());
    const names = wb.getAllLocationNames(joined.campaignId);
    expect(names).toContain('Accepted Hall');

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

  // Finding 2: DmSetupReplySchema permits done: true with dmInstructions: null
  // (the model narrates instructions in prose but the structured field comes
  // back empty). The server must not advance state on this reply, and must not
  // tell the client done: true — both would produce the observed contradiction
  // where the chat panel says "DM is ready!" while the readiness checklist
  // still lists the summary as missing.
  it('does not advance or report done when dmInstructions is missing from a done reply', async () => {
    const { ws, q } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse. NO_INSTRUCTIONS_TRIGGER' });

    const reply = await q.waitFor('dm-chat-reply', 15_000) as any;
    // The model's own done: true must not reach the client as done: true —
    // that is exactly what would light up "DM is ready!" dishonestly.
    expect(reply.done).toBe(false);
    // The prose reply itself is still shown — this is not a generic failure
    // message, the host sees what the model actually said.
    expect(reply.text).toEqual(LLM_STUB_REPLIES.setupDoneNoInstructions.reply);

    // The checklist must agree: still missing a summary, and since
    // dmInstructions was never persisted, a seed draft must not have started.
    const readiness = await q.waitFor('world-readiness', 10_000) as any;
    expect(readiness.readiness.unmet).toContain('dmInstructions');
    await expect(q.waitFor('world-seed-draft', 2_000)).rejects.toThrow(/Timeout/);

    await closeWs(ws);
  }, 30_000);

  // A followup finding: DmSetupReplySchema required `done`, and the live
  // model routinely omits the field entirely (not `done: false` — absent).
  // Every attempt then failed Zod validation identically (retrying an
  // omission the prompt never asked for doesn't produce it), burning 4 LLM
  // calls and surfacing the generic "Sorry, I lost my train of thought"
  // apology to the host. `done` now defaults to false on absence, so this
  // reply must be treated exactly like an ordinary done: false turn — no
  // error surfaced, chat continues normally.
  it('treats a reply with done omitted entirely as done: false, not a failure', async () => {
    const { ws, q } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A moody game please. MISSING_DONE_TRIGGER' });

    const reply = await q.waitForAny(['dm-chat-reply', 'error'], 15_000) as any;
    expect(reply.type).toBe('dm-chat-reply');
    expect(reply.done).toBe(false);
    expect(reply.text).toEqual(LLM_STUB_REPLIES.setupOpenNoDoneField.reply);
    // The lost-train-of-thought apology is the tell for the old failure path —
    // must not appear for a reply that parsed successfully.
    expect(reply.text).not.toMatch(/lost my train of thought/i);

    await closeWs(ws);
  }, 30_000);

  // Task 12, Finding F: setupChat's callLlm call had no explicit maxTokens
  // at all, falling through to the proxy's own default — observed
  // truncating mid-sentence during DM setup, same class of bug as the
  // world-seed truncation already fixed on draftWorldSeed (its neighbour in
  // dm.ts). A "done" reply is the heavy case: `reply` PLUS dmInstructions
  // PLUS dmCustomPrompt, two full paragraphs beyond the chat turn itself.
  it('requests explicit headroom for setupChat instead of falling through to the proxy default', async () => {
    // createGame() already drives one setupChat call (the opening greeting
    // sent on 'create', awaited inside createGame() itself) — enough to
    // inspect without sending anything further.
    const { ws } = await createGame();

    const setupBody = harness.receivedBodies.find(b => b.includes('helping set up a new game'));
    expect(setupBody).toBeDefined();
    const parsed = JSON.parse(setupBody!);
    expect(parsed.max_tokens).toBeGreaterThanOrEqual(2048);

    await closeWs(ws);
  }, 30_000);
});
