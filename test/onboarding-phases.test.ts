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

/** Drives world setup to completion — the stub returns done:true once the host speaks. */
async function finishWorldSetup(ws: WebSocket, q: MessageQueue) {
  sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse, spooky but hopeful.' });
  const reply = await q.waitFor('dm-chat-reply', 15_000) as any;
  expect(reply.done).toBe(true);
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

  // start-game has no phase gate of its own and does the whole 'playing'
  // write synchronously (no await before it), while dm-chat's phase advance
  // sits behind a real network round trip to the (stubbed) LLM. Firing both
  // back to back on the same socket, without awaiting the first, reproduces
  // exactly the interleaving the review flagged: the dm-chat handler resumes
  // and tries to advance the phase *after* start-game has already moved it
  // to 'playing'. The conditional write in advancePhaseIfLobby must refuse
  // to clobber that with 'character-creation'.
  it('does not let a late-resolving dm-chat roll the phase backwards over a start-game that already ran', async () => {
    const { ws: hostWs, joined } = await createGame();

    sendMsg(hostWs, { type: 'dm-chat', text: 'A haunted lighthouse, spooky but hopeful.' });
    sendMsg(hostWs, { type: 'start-game' });

    // Wait for both in-flight handlers to finish before inspecting state.
    const ws2 = await connectWs(port);
    const q2 = new MessageQueue(ws2);
    sendMsg(ws2, { type: 'join', joinCode: joined.joinCode, playerName: 'Referee' });
    const pJoined = await q2.waitFor('room-joined', 15_000) as any;

    expect(pJoined.phase).toBe('playing');

    await closeWs(ws2);
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
