import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';
import { finishWorldSetup } from './lib/finish-world-setup.js';
import type { CharacterDefinition } from '../src/shared/types.js';
import type { ReplayEntry } from '../src/shared/protocol.js';
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

const WHISPER_TEXT = 'Try the lamp room door first.';

async function driveOneTurn(playerQ: MessageQueue): Promise<void> {
  await playerQ.waitFor('narration', 30_000);
  await playerQ.waitFor('whisper-prompt', 30_000);
}

describe('Rejoin during playing replays the session transcript (MUL-74)', () => {
  it('restores the narration log for a refreshed player — public lines and their own whisper — and keeps other players\' whispers private', async () => {
    // --- setup: table with a live game and one completed turn ---
    const hostWs = await connectWs(port);
    const hostQ = new MessageQueue(hostWs);
    sendMsg(hostWs, { type: 'create', name: 'Replay Test', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
    const hostJoined = await hostQ.waitFor('room-joined', 10_000) as any;
    const joinCode = hostJoined.joinCode;
    const hostToken = hostJoined.sessionToken;
    await hostQ.waitFor('dm-chat-reply', 10_000);
    await finishWorldSetup(hostWs, hostQ);

    const playerWs = await connectWs(port);
    const playerQ = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
    const playerJoined = await playerQ.waitFor('room-joined', 10_000) as any;
    const playerToken = playerJoined.sessionToken;

    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
    sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
    await playerQ.waitFor('character-submitted', 10_000);

    sendMsg(hostWs, { type: 'start-game' });
    const playing = await playerQ.waitFor('phase-change', 15_000) as any;
    expect(playing.phase).toBe('playing');

    await driveOneTurn(playerQ);
    sendMsg(playerWs, { type: 'whisper', text: WHISPER_TEXT });
    await playerQ.waitFor('action-taken', 30_000);
    await playerQ.waitFor('dice-roll', 30_000);
    await playerQ.waitFor('resolution', 30_000);

    // --- the reload: drop the socket, rejoin with the stored token ---
    await closeWs(playerWs);
    const rejoinWs = await connectWs(port);
    const rejoinQ = new MessageQueue(rejoinWs);
    sendMsg(rejoinWs, { type: 'rejoin', joinCode, sessionToken: playerToken });
    const rejoined = await rejoinQ.waitFor('room-joined', 10_000) as any;
    expect(rejoined.phase).toBe('playing');

    const replay = await rejoinQ.waitFor('transcript-replay', 10_000) as any;
    const entries: ReplayEntry[] = replay.entries;
    const types = entries.map(e => e.type);
    expect(types).toContain('narration');
    expect(types).toContain('action-taken');
    expect(types).toContain('dice-roll');
    expect(types).toContain('resolution');
    expect(replay.omitted).toBe(0);

    // The player's own whisper echo comes back, before the action it fed.
    const echo = entries.find(e => e.type === 'whisper-echo') as any;
    expect(echo).toBeTruthy();
    expect(echo.text).toBe(WHISPER_TEXT);
    expect(types.indexOf('whisper-echo')).toBeLessThan(types.indexOf('action-taken'));

    // The replayed lines carry their content, not just their kinds.
    const action = entries.find(e => e.type === 'action-taken') as any;
    expect(action.characterName).toBe('Vex Ashgrove');
    expect(typeof action.innerThought).toBe('string');
    const dice = entries.find(e => e.type === 'dice-roll') as any;
    expect(dice.result.description).toBeTruthy();

    // --- the host's view of the same game: every public line, zero whispers ---
    await closeWs(rejoinWs);
    const hostRejoinWs = await connectWs(port);
    const hostRejoinQ = new MessageQueue(hostRejoinWs);
    sendMsg(hostRejoinWs, { type: 'rejoin', joinCode, sessionToken: hostToken });
    await hostRejoinQ.waitFor('room-joined', 10_000);
    const hostReplay = await hostRejoinQ.waitFor('transcript-replay', 10_000) as any;
    const hostTypes = (hostReplay.entries as ReplayEntry[]).map(e => e.type);
    expect(hostTypes).toContain('narration');
    expect(hostTypes).toContain('action-taken');
    expect(hostTypes).not.toContain('whisper-echo');

    // --- after end-game the loop is gone from gameLoops; the DB copy must
    // still refill a rejoining player's log (crash-recovery posture) ---
    sendMsg(hostRejoinWs, { type: 'end-game' });
    // The host rejoin above already answered with a 'playing' phase-change
    // (same drain pattern finishWorldSetup uses for its own rejoin echo).
    let ended: any;
    let endedAttempts = 0;
    do {
      ended = await hostRejoinQ.waitFor('phase-change', 30_000);
      endedAttempts++;
    } while (ended.phase !== 'ended' && endedAttempts < 5);
    expect(ended.phase).toBe('ended');
    await new Promise(r => setTimeout(r, 300)); // let endGame()'s .then drop the loop

    await closeWs(hostRejoinWs);
    const lateWs = await connectWs(port);
    const lateQ = new MessageQueue(lateWs);
    sendMsg(lateWs, { type: 'rejoin', joinCode, sessionToken: playerToken });
    await lateQ.waitFor('room-joined', 10_000);
    const lateReplay = await lateQ.waitFor('transcript-replay', 10_000) as any;
    const lateTypes = (lateReplay.entries as ReplayEntry[]).map(e => e.type);
    for (const t of ['narration', 'action-taken', 'dice-roll', 'resolution', 'whisper-echo']) {
      expect(lateTypes).toContain(t);
    }
    expect(lateReplay.entries.length).toBeGreaterThanOrEqual(entries.length);
    const lateEcho = (lateReplay.entries as ReplayEntry[]).find(e => e.type === 'whisper-echo') as any;
    expect(lateEcho.text).toBe(WHISPER_TEXT);

    await closeWs(lateWs);
    await closeWs(hostWs);
  }, 120_000);
});
