import type { WebSocket } from 'ws';
import { connectWs, sendMsg, MessageQueue } from './ws-helpers.js';
import { finishWorldSetup } from './finish-world-setup.js';
import type { CharacterDefinition } from '../../src/shared/types.js';
import type { ServerMessage } from '../../src/shared/protocol.js';

export const PLAYING_CHAR: CharacterDefinition = {
  name: 'Vex Ashgrove', backstory: 'Raised by cartographers.',
  personality: 'Curious, stubborn.', highConcept: 'Runaway Star-Cartographer',
  trouble: 'Owes a debt to the Ledger Cult',
  aspects: ['Maps are promises', 'Never look back'],
  skills: { Notice: 3, Lore: 2 }, stunts: ['Dead Reckoning: +2 to Notice.'],
};

/** One seat at a live table: its socket, a waitable queue, and a full log of everything it received. */
export interface Seat {
  ws: WebSocket;
  q: MessageQueue;
  log: ServerMessage[];
  token: string;
}

export interface PlayingGame {
  joinCode: string;
  campaignId: string;
  characterId: string;
  host: Seat;
  player: Seat;
}

export function seatOn(ws: WebSocket, token = ''): Seat {
  const log: ServerMessage[] = [];
  ws.on('message', (d: Buffer) => log.push(JSON.parse(d.toString())));
  return { ws, q: new MessageQueue(ws), log, token };
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function waitUntil(cond: () => boolean, timeoutMs = 15_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(25);
  }
}

export function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((r) => {
    if (ws.readyState === ws.CLOSED) { r(); return; }
    ws.once('close', () => r());
    ws.close();
  });
}

/** Drain phase-change messages until one for `phase` arrives (rejoins echo the current phase first). */
export async function waitForPhase(q: MessageQueue, phase: string, timeoutMs = 30_000): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const m = await q.waitFor('phase-change', timeoutMs) as Extract<ServerMessage, { type: 'phase-change' }>;
    if (m.phase === phase) return;
  }
  throw new Error(`never saw phase-change ${phase}`);
}

/** A host-DM table with one approved player character, started and playing. */
export async function startPlayingGame(port: number, name = 'Pause Test'): Promise<PlayingGame> {
  const hostWs = await connectWs(port);
  const host = seatOn(hostWs);
  sendMsg(hostWs, { type: 'create', name, dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
  const hostJoined = await host.q.waitFor('room-joined', 10_000) as any;
  host.token = hostJoined.sessionToken;
  await host.q.waitFor('dm-chat-reply', 10_000);
  await finishWorldSetup(hostWs, host.q);

  const playerWs = await connectWs(port);
  const player = seatOn(playerWs);
  sendMsg(playerWs, { type: 'join', joinCode: hostJoined.joinCode, playerName: 'Wendy' });
  const playerJoined = await player.q.waitFor('room-joined', 10_000) as any;
  player.token = playerJoined.sessionToken;

  sendMsg(playerWs, { type: 'submit-character', definition: PLAYING_CHAR });
  const review = await host.q.waitFor('character-pending-review', 20_000) as any;
  sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
  await player.q.waitFor('character-submitted', 10_000);

  sendMsg(hostWs, { type: 'start-game' });
  await waitForPhase(player.q, 'playing', 15_000);
  return { joinCode: hostJoined.joinCode, campaignId: hostJoined.campaignId, characterId: review.characterId, host, player };
}

/** End the table and wait for it to say so — leaves no loop spending LLM calls behind the next test. */
export async function endGame(seat: Seat): Promise<void> {
  sendMsg(seat.ws, { type: 'end-game' });
  await waitForPhase(seat.q, 'ended', 30_000);
}

/** Close every seat's socket — the harness's server.close() waits on open ones. */
export async function leave(...seats: Seat[]): Promise<void> {
  await Promise.all(seats.map(seat => closeWs(seat.ws)));
}
