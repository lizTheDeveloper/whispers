// "only show the agent's considerations to the player who is playing (don't
// show the other players thinking process)". A character's private thinking
// — the options they weigh (action-proposals), the whisper panel's mood line,
// goals and suggestion chips (whisper-guidance), and their inner thought and
// whisper verdict (character-thought) — goes only to the seat that plays that
// character. The host running the table does not see it either. What stays
// public: who is deciding (whisper-prompt), the action and spoken words, the
// dice, and the DM's narration and ruling. A rejoin replays the same split.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';
import { startPlayingGame, seatOn, sleep, endGame, leave, type Seat } from './lib/playing-game.js';
import type { ReplayEntry, ServerMessage } from '../src/shared/protocol.js';

let harness: Harness;
beforeAll(async () => { harness = await startHarness(); }, 30_000);
afterAll(async () => { await harness.stop(); });

const PRIVATE_TYPES = ['action-proposals', 'whisper-guidance', 'character-thought'];
const PRIVATE_PROMPT_FIELDS = ['mood', 'trustHint', 'suggestions', 'goals'];

function ofType<T extends ServerMessage['type']>(log: ServerMessage[], type: T): Array<Extract<ServerMessage, { type: T }>> {
  return log.filter(m => m.type === type) as Array<Extract<ServerMessage, { type: T }>>;
}

async function rejoin(port: number, joinCode: string, token: string): Promise<Seat> {
  const seat = seatOn(await connectWs(port), token);
  sendMsg(seat.ws, { type: 'rejoin', joinCode, sessionToken: token });
  await seat.q.waitFor('room-joined', 10_000);
  return seat;
}

describe('a character\'s considerations reach only the seat that plays them', () => {
  it('the owner sees options, chips and thoughts; the host sees only the public turn — live and on rejoin', async () => {
    const g = await startPlayingGame(harness.port, 'Private Minds');

    // --- the decision window: options and chips are the owner's ---
    const prompt = await g.player.q.waitFor('whisper-prompt', 30_000) as Extract<ServerMessage, { type: 'whisper-prompt' }>;
    expect(prompt.characterId).toBe(g.characterId);
    const guidance = await g.player.q.waitFor('whisper-guidance', 10_000) as Extract<ServerMessage, { type: 'whisper-guidance' }>;
    expect(guidance.characterId).toBe(g.characterId);
    expect(typeof guidance.mood).toBe('string');
    const proposals = ofType(g.player.log, 'action-proposals');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.characterId).toBe(g.characterId);
    expect(proposals[0]!.actions.length).toBeGreaterThan(0);

    // The host got the prompt (someone is deciding) and nothing private.
    await g.host.q.waitFor('whisper-prompt', 10_000);
    const hostPrompt = ofType(g.host.log, 'whisper-prompt');
    expect(hostPrompt.length).toBeGreaterThan(0);
    for (const p of [...hostPrompt, ...ofType(g.player.log, 'whisper-prompt')]) {
      for (const field of PRIVATE_PROMPT_FIELDS) expect(p, `whisper-prompt carried ${field}`).not.toHaveProperty(field);
    }

    // --- the turn: the action is public, the thought is not ---
    sendMsg(g.player.ws, { type: 'whisper', text: 'Try the lamp room door first.' });
    const thought = await g.player.q.waitFor('character-thought', 30_000) as Extract<ServerMessage, { type: 'character-thought' }>;
    expect(thought.characterId).toBe(g.characterId);
    expect(thought.innerThought.length).toBeGreaterThan(0);
    expect(thought.whisperInfluence).not.toBe('none');
    await g.player.q.waitFor('resolution', 30_000);
    await g.host.q.waitFor('resolution', 30_000);

    const hostActions = ofType(g.host.log, 'action-taken');
    const playerActions = ofType(g.player.log, 'action-taken');
    expect(hostActions).toHaveLength(1);
    expect(playerActions).toHaveLength(1);
    for (const a of [...hostActions, ...playerActions]) {
      expect(a.characterId).toBe(g.characterId);
      expect(a.action.length).toBeGreaterThan(0);
      expect(a).not.toHaveProperty('innerThought');
      expect(a).not.toHaveProperty('whisperInfluence');
    }
    expect(ofType(g.host.log, 'dice-roll')).toHaveLength(1);
    for (const t of PRIVATE_TYPES) expect(g.host.log.map(m => m.type), `host received ${t}`).not.toContain(t);

    // --- the next window is open: rejoin both seats mid-window ---
    await g.player.q.waitFor('whisper-guidance', 30_000);
    await leave(g.player, g.host);

    const player = await rejoin(harness.port, g.joinCode, g.player.token);
    const replay = await player.q.waitFor('transcript-replay', 10_000) as Extract<ServerMessage, { type: 'transcript-replay' }>;
    const entries: ReplayEntry[] = replay.entries;
    const replayedThought = entries.find(e => e.type === 'character-thought') as Extract<ReplayEntry, { type: 'character-thought' }> | undefined;
    expect(replayedThought?.innerThought).toBe(thought.innerThought);
    // The thought follows the action it belongs to.
    expect(entries.findIndex(e => e.type === 'character-thought')).toBeGreaterThan(entries.findIndex(e => e.type === 'action-taken'));
    for (const e of entries.filter(e => e.type === 'action-taken')) expect(e).not.toHaveProperty('innerThought');
    await player.q.waitFor('whisper-prompt', 10_000);
    const rejoinGuidance = await player.q.waitFor('whisper-guidance', 10_000) as Extract<ServerMessage, { type: 'whisper-guidance' }>;
    expect(rejoinGuidance.characterId).toBe(g.characterId);

    const host = await rejoin(harness.port, g.joinCode, g.host.token);
    const hostReplay = await host.q.waitFor('transcript-replay', 10_000) as Extract<ServerMessage, { type: 'transcript-replay' }>;
    const hostTypes = hostReplay.entries.map(e => e.type);
    expect(hostTypes).toContain('action-taken');
    expect(hostTypes).not.toContain('character-thought');
    for (const e of hostReplay.entries.filter(e => e.type === 'action-taken')) expect(e).not.toHaveProperty('innerThought');
    await host.q.waitFor('whisper-prompt', 10_000);
    await sleep(300);
    for (const t of PRIVATE_TYPES) expect(host.log.map(m => m.type), `host rejoin received ${t}`).not.toContain(t);

    await endGame(host);
    await leave(host, player);
  }, 120_000);
});
