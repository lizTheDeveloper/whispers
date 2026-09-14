import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';
import { finishWorldSetup } from './lib/finish-world-setup.js';
import type { CharacterDefinition } from '../src/shared/types.js';
import type { WebSocket } from 'ws';

let harness: Harness;
let port: number;

const CHAR: CharacterDefinition = {
  name: 'Vex Ashgrove', backstory: 'Raised by cartographers.',
  personality: 'Curious, stubborn.', highConcept: 'Runaway Star-Cartographer',
  trouble: 'Owes a debt to the Ledger Cult',
  aspects: ['Maps are promises', 'Never look back'],
  skills: { Notice: 3, Lore: 2 }, stunts: ['Dead Reckoning: +2 to Notice.'],
};

beforeAll(async () => { harness = await startHarness(); port = harness.port; }, 30_000);
afterAll(async () => { await harness.stop(); });

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((r) => { ws.once('close', () => r()); ws.close(); });
}

async function createGame() {
  const ws = await connectWs(port);
  const q = new MessageQueue(ws);
  sendMsg(ws, { type: 'create', name: 'Gate Test', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
  const joined = await q.waitFor('room-joined', 10_000) as any;
  await q.waitFor('dm-chat-reply', 10_000); // the DM's opening greeting
  return { ws, q, joined };
}

describe('Character creation is gated behind the world', () => {
  it('starts a new game in the lobby phase', async () => {
    const { ws, joined } = await createGame();
    expect(joined.phase).toBe('lobby');
    await closeWs(ws);
  }, 20_000);

  it('tells a player joining during world setup that they are waiting', async () => {
    const { ws: hostWs, joined } = await createGame();
    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    const pJoined = await pq.waitFor('room-joined', 10_000) as any;

    expect(pJoined.phase).toBe('lobby');

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 20_000);

  it('refuses a character submitted before the world exists', async () => {
    const { ws: hostWs, joined } = await createGame();
    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);

    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const reply = await pq.waitForAny(['error', 'character-validated'], 10_000) as any;
    expect(reply.type).toBe('error');
    expect(reply.message).toMatch(/world/i);

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 20_000);

  it('refuses a character interview before the world exists', async () => {
    const { ws: hostWs, joined } = await createGame();
    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);

    sendMsg(playerWs, { type: 'char-chat', text: 'I want to play a thief' });
    const reply = await pq.waitForAny(['error', 'char-chat-reply'], 10_000) as any;
    expect(reply.type).toBe('error');

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 20_000);

  it('opens the table when world setup completes, and tells everyone', async () => {
    const { ws: hostWs, q: hostQ, joined } = await createGame();
    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);

    await finishWorldSetup(hostWs, hostQ);

    const phase = await pq.waitFor('phase-change', 10_000) as any;
    expect(phase.phase).toBe('character-creation');

    // And now a submission is accepted.
    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const validated = await pq.waitFor('character-validated', 20_000) as any;
    expect(validated.approved).toBe(true);

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 40_000);

  it('reports character-creation phase to someone who rejoins after the table opens', async () => {
    const { ws: hostWs, q: hostQ, joined } = await createGame();
    await finishWorldSetup(hostWs, hostQ);

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Late' });
    const pJoined = await pq.waitFor('room-joined', 10_000) as any;
    expect(pJoined.phase).toBe('character-creation');

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 40_000);

  // The phase advance moved out of dm-chat (Task 6) and into accept-world-seed,
  // which calls advancePhaseIfLobby exactly like dm-chat used to.
  //
  // What this test actually proves: accept-world-seed does all of its DB
  // work synchronously (no awaits before advancePhaseIfLobby), so two calls
  // fired back to back on the same socket can never truly interleave — the
  // first one runs to completion (including the broadcast) before the
  // second's handler invocation even starts. The second call's own fresh
  // `campaign.phase !== 'lobby'` guard is what stops it, *before* it ever
  // reaches advancePhaseIfLobby — so this test does NOT exercise
  // advancePhaseIfLobby's WHERE-clause atomicity the way the dm-chat version
  // of this test exercised it (that one raced a real network round trip to
  // the stubbed LLM, which is a genuine yield point). What it does prove is
  // the user-visible property that matters here regardless of mechanism: two
  // back-to-back accept-world-seed calls yield exactly one phase-change and
  // one refusal, never two successes and never two broadcasts.
  //
  // This replaces an earlier version of this test that raced two dm-chat
  // calls against each other — dm-chat no longer advances the phase at all.
  it('advances phase exactly once when two accept-world-seed calls race the same transition', async () => {
    const { ws: hostWs, q: hostQ } = await createGame();

    sendMsg(hostWs, { type: 'dm-chat', text: 'A haunted lighthouse, spooky but hopeful.' });
    const draft = await hostQ.waitFor('world-seed-draft', 20_000) as any;

    sendMsg(hostWs, { type: 'choose-table-role', role: 'dm' } as any);
    await hostQ.waitFor('room-joined', 10_000);

    sendMsg(hostWs, { type: 'accept-world-seed', seed: draft.seed } as any);
    sendMsg(hostWs, { type: 'accept-world-seed', seed: draft.seed } as any);

    const first = await hostQ.waitFor('phase-change', 10_000) as any;
    expect(first.phase).toBe('character-creation');

    // The loser of the race gets an explicit refusal, not silence.
    const refused = await hostQ.waitFor('error', 10_000) as any;
    expect(refused.message).toMatch(/already open/i);

    // No second phase-change should ever arrive — the loser must not
    // broadcast.
    await expect(hostQ.waitFor('phase-change', 500)).rejects.toThrow();

    await closeWs(hostWs);
  }, 40_000);

  it('lets the host choose a table role after world setup has completed', async () => {
    const { ws: hostWs, q: hostQ } = await createGame();
    await finishWorldSetup(hostWs, hostQ);

    sendMsg(hostWs, { type: 'choose-table-role', role: 'player' });
    const reply = await hostQ.waitForAny(['room-joined', 'error'], 10_000) as any;

    expect(reply.type).toBe('room-joined');
    expect(reply.tableRole).toBe('player');

    await closeWs(hostWs);
  }, 30_000);
});

describe('Starting a game requires a party', () => {
  it('refuses to start with no approved characters', async () => {
    const { ws: hostWs, q: hostQ } = await createGame();
    await finishWorldSetup(hostWs, hostQ);

    sendMsg(hostWs, { type: 'start-game' });
    const reply = await hostQ.waitForAny(['error', 'phase-change'], 10_000) as any;

    expect(reply.type).toBe('error');
    expect(reply.message).toMatch(/character/i);

    await closeWs(hostWs);
  }, 40_000);

  it('starts once a character is live', async () => {
    const { ws: hostWs, q: hostQ, joined } = await createGame();
    await finishWorldSetup(hostWs, hostQ);

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);
    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
    sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
    await pq.waitFor('character-submitted', 10_000);

    sendMsg(hostWs, { type: 'start-game' });
    const phase = await hostQ.waitFor('phase-change', 15_000) as any;
    expect(phase.phase).toBe('playing');

    // start-game hands off to a GameLoop that recurses on its own (turns,
    // scenes, whispers) with nothing in this test driving it forward. Left
    // alone it keeps making LLM calls against the stub for the rest of the
    // process's life — including after this test file's afterAll closes the
    // harness's http servers, which then makes those calls fail loudly. End
    // the game so the loop's `stopped` flag is set and it unwinds instead of
    // outliving the test.
    sendMsg(hostWs, { type: 'end-game' });
    const ended = await hostQ.waitFor('phase-change', 20_000) as any;
    expect(ended.phase).toBe('ended');

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 60_000);

  // beginPlayIfReady's conditional write (phase = 'character-creation' in the
  // WHERE clause) must let exactly one 'start-game' construct a GameLoop. A
  // second one — e.g. from a stale DM tab, which main.ts's "bookmark this
  // chair" sidebar copy explicitly invites — must be refused, not spawn an
  // orphaned second loop that keeps narrating forever with nothing able to
  // stop it.
  it('refuses a second start-game and never spawns a second GameLoop', async () => {
    const { ws: hostWs, q: hostQ, joined } = await createGame();
    await finishWorldSetup(hostWs, hostQ);

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);
    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
    sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
    await pq.waitFor('character-submitted', 10_000);

    sendMsg(hostWs, { type: 'start-game' });
    sendMsg(hostWs, { type: 'start-game' });

    const started = await hostQ.waitFor('phase-change', 15_000) as any;
    expect(started.phase).toBe('playing');

    const refused = await hostQ.waitFor('error', 10_000) as any;
    expect(refused.message).toMatch(/already started/i);

    // No second 'playing' phase-change should ever arrive.
    await expect(hostQ.waitFor('phase-change', 500)).rejects.toThrow();

    // Clean up so the loop this test did start doesn't outlive it.
    sendMsg(hostWs, { type: 'end-game' });
    const ended = await hostQ.waitFor('phase-change', 20_000) as any;
    expect(ended.phase).toBe('ended');

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 60_000);
});
