import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';
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

/**
 * Drives world setup to completion — the stub returns done:true once the
 * host speaks. The server broadcasts the resulting phase-change to
 * everyone in the room, including the host's own socket, and it arrives
 * *before* the dm-chat-reply (the broadcast is sent first in the handler).
 * Draining it here too keeps it from sitting unread in `q`'s buffer, where
 * it would otherwise be handed back — stale — to a later, unrelated
 * `q.waitFor('phase-change')`/`waitForAny([..., 'phase-change'])` call.
 */
async function finishWorldSetup(ws: WebSocket, q: MessageQueue) {
  sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse, spooky but hopeful.' });
  const reply = await q.waitFor('dm-chat-reply', 15_000) as any;
  expect(reply.done).toBe(true);
  const phase = await q.waitFor('phase-change', 15_000) as any;
  expect(phase.phase).toBe('character-creation');
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

  // dm-chat's phase advance sits behind a real network round trip to the
  // (stubbed) LLM, so two dm-chat calls fired back to back on the same
  // socket, without awaiting the first, both resume believing 'lobby' is
  // still current and both try to advance the phase. advancePhaseIfLobby's
  // conditional write (phase = 'lobby' in the WHERE clause) must let exactly
  // one of them win, and the handler must broadcast phase-change only from
  // the write that actually happened — otherwise the phase could be pushed
  // through twice, or a losing racer could clobber a later phase.
  //
  // This replaces an earlier version of this test that raced dm-chat against
  // start-game and depended on start-game succeeding with zero approved
  // characters. Task 6 makes that a hard error, so the property is now
  // proven with two concurrent dm-chat calls instead — same mechanism
  // (advancePhaseIfLobby), no dependency on start-game or party size.
  it('advances phase exactly once when two dm-chat calls race the same transition', async () => {
    const { ws: hostWs, q: hostQ } = await createGame();

    sendMsg(hostWs, { type: 'dm-chat', text: 'A haunted lighthouse, spooky but hopeful.' });
    sendMsg(hostWs, { type: 'dm-chat', text: 'Two messages, same beat.' });

    // Both handlers must still resolve their reply.
    await hostQ.waitFor('dm-chat-reply', 15_000);
    await hostQ.waitFor('dm-chat-reply', 15_000);

    const first = await hostQ.waitFor('phase-change', 10_000) as any;
    expect(first.phase).toBe('character-creation');

    // No second phase-change should ever arrive — the loser of the race
    // must not broadcast.
    await expect(hostQ.waitFor('phase-change', 500)).rejects.toThrow();

    await closeWs(hostWs);
  }, 30_000);

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
});
