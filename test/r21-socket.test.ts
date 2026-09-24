// Round 21 (live, game B): a second WebSocket with the same seat token took
// the seat over, and when it closed the original tab — still open — got
// nothing more: it missed the switch to play, and the table paused as
// "quiet" until a reload. Now every open socket of a seat hears the room's
// broadcasts, and when the newest closes an older one still open becomes
// the seat's live socket again (private sends included).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';
import { seatOn, waitUntil, closeWs, sleep } from './lib/playing-game.js';
import { finishWorldSetup } from './lib/finish-world-setup.js';
import type { ServerMessage } from '../src/shared/protocol.js';

let harness: Harness;
beforeAll(async () => { harness = await startHarness(); }, 30_000);
afterAll(async () => { await harness.stop(); }, 30_000);

describe('two sockets on one seat', () => {
  it('the older tab keeps hearing the room while a newer one is open, and is the live seat again once it closes', async () => {
    const a = seatOn(await connectWs(harness.port));
    sendMsg(a.ws, { type: 'create', name: 'R21 sockets', dmPreset: 'chronicler', systemId: 'fate-core', scenarioId: null, houseRules: null } as any);
    const joined = await a.q.waitFor('room-joined', 10_000) as Extract<ServerMessage, { type: 'room-joined' }>;
    const { joinCode, sessionToken } = joined;

    // A second tab takes the same seat.
    const b = seatOn(await connectWs(harness.port), sessionToken);
    sendMsg(b.ws, { type: 'rejoin', joinCode, sessionToken });
    await b.q.waitFor('room-joined', 10_000);

    // While both are open, both hear a broadcast.
    const p1 = seatOn(await connectWs(harness.port));
    sendMsg(p1.ws, { type: 'join', joinCode, playerName: 'Wren' });
    await waitUntil(() => a.log.some(m => m.type === 'player-joined' && (m as any).playerName === 'Wren'), 10_000, 'A hears Wren join');
    await waitUntil(() => b.log.some(m => m.type === 'player-joined' && (m as any).playerName === 'Wren'), 10_000, 'B hears Wren join');

    // The newer tab closes; the older one is still open.
    await closeWs(b.ws);
    await sleep(100);

    // A broadcast still reaches the older tab…
    const p2 = seatOn(await connectWs(harness.port));
    sendMsg(p2.ws, { type: 'join', joinCode, playerName: 'Tam' });
    await waitUntil(() => a.log.some(m => m.type === 'player-joined' && (m as any).playerName === 'Tam'), 10_000, 'A hears Tam join after B closed');
    // …and nobody was told the host left.
    expect(p2.log.some(m => m.type === 'player-left')).toBe(false);
    expect(p1.log.some(m => m.type === 'player-left' && (m as any).playerName === 'Host')).toBe(false);

    // The switch to character creation reaches the older tab, and so does a
    // private send to the seat: the host's review of a submitted character.
    await finishWorldSetup(a.ws, a.q);
    await waitUntil(() => p2.log.some(m => m.type === 'phase-change' && (m as any).phase === 'character-creation'), 10_000, 'the table opens');
    sendMsg(p2.ws, { type: 'submit-character', definition: {
      name: 'Tam', pronouns: 'they/them', backstory: 'Grew up on the docks.', personality: 'Quick.', highConcept: 'Dockside Runner', trouble: 'Owes the harbourmaster',
      aspects: ['Knows every alley', 'Never still'], skills: { Athletics: 3, Notice: 2 }, stunts: ['Rooftop: +2 to Athletics on roofs.'],
    } } as any);
    await a.q.waitFor('character-pending-review', 20_000);

    for (const s of [a, p1, p2]) await closeWs(s.ws);
  }, 60_000);
});
