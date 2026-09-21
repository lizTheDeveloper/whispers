// test/whisper-window.test.ts — MUL-73
//
// The bug: a whisper arriving while no 30s decision window was open was
// discarded without a word — no error, no queue, no verdict — while the
// client had already painted "You whisper: …" into the log, so the player
// believed the table had heard them. A second bug lived in the same lines:
// delivery went to WHOEVER's window happened to be open, so any player
// could steer any character.
//
// The fix, asserted here on two levels:
//  - unit (GameLoop.handleWhisper against the harness's real db): routing
//    by the sender's seat, delivered/queued/rejected outcomes, the queue
//    cap, and the loud flush when a table dies holding saved words.
//  - e2e (real sockets, canned LLM stub): an in-window whisper acked
//    delivered, an out-of-window whisper acked queued and then ACTUALLY
//    heard at the next window (carryingQueued + a verdict), the DM-seat
//    driver path kept alive for playtest harnesses, and a seat without a
//    character refused out loud.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { WebSocket } from 'ws';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';
import { finishWorldSetup } from './lib/finish-world-setup.js';
import type { CharacterDefinition, RoomState } from '../src/shared/types.js';
import type { ServerMessage } from '../src/shared/protocol.js';

let harness: Harness;
let port: number;

beforeAll(async () => { harness = await startHarness(); port = harness.port; }, 30_000);
afterAll(async () => { await harness.stop(); });

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((r) => { ws.once('close', () => r()); ws.close(); });
}

// ───────────────────────────── unit ─────────────────────────────

const CHAR_A: CharacterDefinition = {
  name: 'Mara Voss', backstory: 'B', personality: 'P', highConcept: 'H', trouble: 'T',
  aspects: [], skills: {}, stunts: [],
};
const CHAR_B: CharacterDefinition = {
  name: 'Odun Rai', backstory: 'B', personality: 'P', highConcept: 'H', trouble: 'T',
  aspects: [], skills: {}, stunts: [],
};
const CHAR_STATE = { stress: 1, consequences: [], fatePoints: 2, inventory: [], xpMilestones: [], whisperTrust: 0.5 };

describe('GameLoop.handleWhisper routing (unit)', () => {
  let seq = 0;
  async function makeLoop() {
    const { getDb } = await import('../src/server/db.js');
    const { createRoom } = await import('../src/server/room.js');
    const { GameLoop } = await import('../src/server/game-loop.js');
    const db = getDb();
    const { campaignId, joinCode } = createRoom(db, { name: `Whisper Routing ${++seq}`, dmPreset: 'chronicler', systemId: 'fate-core' });
    // ids are primary keys against the shared harness db — fresh per loop.
    const charA = `charA-${seq}`;
    const charB = `charB-${seq}`;
    for (const [id, def] of [[charA, CHAR_A], [charB, CHAR_B]] as const) {
      db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)')
        .run(id, campaignId, JSON.stringify(def), JSON.stringify(CHAR_STATE));
    }
    const broadcasts: ServerMessage[] = [];
    const state: RoomState = {
      campaignId, joinCode, phase: 'playing', currentScene: 1, currentTurn: 0,
      initiativeOrder: [charA, charB], activeCharacterId: null,
      awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null,
    };
    const loop = new GameLoop(db, campaignId, (m) => broadcasts.push(m), () => {}, state);
    loop.loadCharacters();
    return { loop, broadcasts, charA, charB };
  }

  it('delivers into the sender\'s own open window and resolves the wait', async () => {
    const { loop, charA } = await makeLoop();
    const opened = (loop as any).waitForWhisper(charA, 5_000) as Promise<string | null>;
    const ack = loop.handleWhisper('check the lock first', { characterId: charA, isOwner: false });
    expect(ack.status).toBe('delivered');
    expect(ack.characterId).toBe(charA);
    await expect(opened).resolves.toBe('check the lock first');
  });

  it('never cross-delivers: a whisper to a settling character queues for its OWN voice', async () => {
    const { loop, charA, charB } = await makeLoop();
    const player = { characterId: charA, isOwner: false };
    const opened = (loop as any).waitForWhisper(charB, 400) as Promise<string | null>;
    const ack = loop.handleWhisper('not for you', player); // charA's owner, charB's window
    expect(ack.status).toBe('queued');
    expect(ack.characterName).toBe('Mara Voss');
    await expect(opened).resolves.toBeNull(); // charB was not hijacked
    // …and the saved words surface at charA's next window.
    const openedA = (loop as any).waitForWhisper(charA, 5_000) as Promise<string | null>;
    const ack2 = loop.handleWhisper('again, live', player);
    expect(ack2.status).toBe('delivered'); // live text delivered while the queue waits
    await expect(openedA).resolves.toBe('again, live');
  });

  it('queues out-of-window whispers up to the cap, then refuses with a reason', async () => {
    const { loop, charA } = await makeLoop();
    const player = { characterId: charA, isOwner: false };
    for (let i = 1; i <= 3; i++) {
      expect(loop.handleWhisper(`saved ${i}`, player).status).toBe('queued');
    }
    const fourth = loop.handleWhisper('one too many', player);
    expect(fourth.status).toBe('rejected');
    expect(fourth.message).toMatch(/still carrying/i);
  });

  it('keeps the DM-seat driver path: deliver into whoever is deciding, refuse when nobody is', async () => {
    const { loop, charB } = await makeLoop();
    const dmSeat = { characterId: null, isOwner: true };
    const noWindow = loop.handleWhisper('push forward', dmSeat);
    expect(noWindow.status).toBe('rejected');
    expect(noWindow.message).toMatch(/no one is deciding/i);
    const opened = (loop as any).waitForWhisper(charB, 5_000) as Promise<string | null>;
    const ack = loop.handleWhisper('push forward', dmSeat);
    expect(ack.status).toBe('delivered');
    expect(ack.characterId).toBe(charB);
    await expect(opened).resolves.toBe('push forward');
  });

  it('refuses, out loud, a seat that is no one\'s voice and a character no longer at the table', async () => {
    const { loop, charB } = await makeLoop();
    (loop as any).waitForWhisper(charB, 400);
    const homelessAck = loop.handleWhisper('hello?', { characterId: null, isOwner: false });
    expect(homelessAck.status).toBe('rejected');
    expect(homelessAck.message).toMatch(/not the voice of anyone/i);
    const ghostAck = loop.handleWhisper('hello?', { characterId: 'nobody', isOwner: false });
    expect(ghostAck.status).toBe('rejected');
    expect(ghostAck.message).toMatch(/no longer at this table/i);
  });

  it('drops saved whispers loudly on stop, and per-character on revoke', async () => {
    const { loop, broadcasts, charA, charB } = await makeLoop();
    const player = { characterId: charA, isOwner: false };
    const otherPlayer = { characterId: charB, isOwner: false };
    loop.handleWhisper('kept 1', player);
    loop.handleWhisper('kept 2', player);
    loop.handleWhisper('kept for odun', otherPlayer);
    await loop.revokeCharacter(charA);
    const droppedA = broadcasts.filter(m => m.type === 'whisper-dropped' && m.characterId === charA);
    expect(droppedA.length).toBe(1);
    expect((droppedA[0] as any).count).toBe(2);
    loop.stop();
    const droppedB = broadcasts.filter(m => m.type === 'whisper-dropped' && m.characterId === charB);
    expect(droppedB.length).toBe(1);
    const after = loop.handleWhisper('too late', player);
    expect(after.status).toBe('rejected');
    expect(after.message).toMatch(/game has ended/i);
  });
});

// ───────────────────────────── e2e ─────────────────────────────

const VEX: CharacterDefinition = {
  name: 'Vex Ashgrove',
  backstory: 'Raised by cartographers on a dying moon.',
  personality: 'Curious, stubborn, allergic to authority.',
  highConcept: 'Runaway Star-Cartographer',
  trouble: 'Owes a debt to the Ledger Cult',
  aspects: ['Maps are promises', 'Never look back'],
  skills: { Notice: 3, Lore: 2, Will: 1 },
  stunts: ['Dead Reckoning: +2 to Notice when navigating.'],
};

describe('whisper window end to end (sockets, canned LLM)', () => {
  it('acks in-window whispers, carries queued ones to the next decision, and refuses a seat with no voice', async () => {
    const hostWs = await connectWs(port);
    const hostQ = new MessageQueue(hostWs);
    sendMsg(hostWs, { type: 'create', name: 'Whisper Window E2E', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
    const joined = await hostQ.waitFor('room-joined', 10_000) as any;
    expect(joined.characterId).toBeNull(); // a host seat has no voice of its own
    await finishWorldSetup(hostWs, hostQ); // host runs the table

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    const playerJoined = await pq.waitFor('room-joined', 10_000) as any;
    expect(playerJoined.characterId).toBeNull();
    sendMsg(playerWs, { type: 'submit-character', definition: VEX });
    const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
    sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
    await pq.waitFor('character-submitted', 10_000);
    const charId = review.characterId;

    const specWs = await connectWs(port);
    const sq = new MessageQueue(specWs);
    sendMsg(specWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Spec' });
    await sq.waitFor('room-joined', 10_000);

    sendMsg(hostWs, { type: 'start-game' });
    const phase = await hostQ.waitFor('phase-change', 15_000) as any;
    expect(phase.phase).toBe('playing');

    // Turn 1 — the window is open for Vex: in-window whisper is heard NOW.
    const prompt1 = await pq.waitFor('whisper-prompt', 90_000) as any;
    expect(prompt1.characterId).toBe(charId);
    expect(prompt1.carryingQueued).toBeUndefined();
    sendMsg(playerWs, { type: 'whisper', text: 'Check the lock before you touch it.' });
    const ack1 = await pq.waitFor('whisper-ack', 10_000) as any;
    expect(ack1.status).toBe('delivered');
    expect(ack1.characterId).toBe(charId);

    // Between moments — the slot is gone, but the words are SAVED, not lost.
    sendMsg(playerWs, { type: 'whisper', text: 'Hold the lantern low.' });
    const ack2 = await pq.waitFor('whisper-ack', 10_000) as any;
    expect(ack2.status).toBe('queued');
    expect(ack2.characterName).toBe('Vex Ashgrove');
    expect(ack2.message).toMatch(/carry your whisper into their next choice/i);

    // The spectator seat has no voice: refused out loud, never silently.
    sendMsg(specWs, { type: 'whisper', text: 'anyone hear me?' });
    const ackSpec = await sq.waitFor('whisper-ack', 10_000) as any;
    expect(ackSpec.status).toBe('rejected');
    expect(ackSpec.message).toMatch(/not the voice of anyone/i);

    // Turn 1 lands with a real verdict for the in-window whisper — the
    // trust marker MUL-73's dropped whispers never produced.
    const act1 = await pq.waitFor('action-taken', 90_000) as any;
    expect(act1.characterId).toBe(charId);
    expect(act1.whisperInfluence).not.toBe('none');

    // Turn 2 — the saved whisper is carried INTO the next window (the
    // prompt says so) and adjudicated like a live one: the turn ends with
    // a real influence verdict instead of MUL-73's permanent silence.
    const prompt2 = await pq.waitFor('whisper-prompt', 90_000) as any;
    expect(prompt2.characterId).toBe(charId);
    expect(prompt2.carryingQueued).toBe(1);
    const act2 = await pq.waitFor('action-taken', 90_000) as any;
    expect(act2.characterId).toBe(charId);
    expect(act2.whisperInfluence).not.toBe('none');

    // The DM-seat driver path (what every playtest harness and solo table
    // uses) still delivers into the open window — with no character of
    // their own, the world author reaches whoever is deciding RIGHT NOW.
    // The host's queue holds every broadcast so far (including the
    // carried-queue prompt, whose window resolves without waiting), so
    // retry against each fresh window until one accepts the delivery.
    let ackHost: any = null;
    for (let attempt = 0; attempt < 3 && !ackHost; attempt++) {
      let prompt: any;
      do {
        prompt = await hostQ.waitFor('whisper-prompt', 90_000) as any;
      } while (prompt.carryingQueued && prompt.carryingQueued > 0);
      expect(prompt.characterId).toBe(charId);
      sendMsg(hostWs, { type: 'whisper', text: 'Push forward.' });
      const ack: any = await hostQ.waitFor('whisper-ack', 10_000);
      if (ack.status === 'delivered') ackHost = ack;
    }
    expect(ackHost, 'driver whisper was never delivered into a live window').toBeTruthy();
    expect(ackHost.characterId).toBe(charId);

    sendMsg(hostWs, { type: 'end-game' });
    await hostQ.waitFor('phase-change', 30_000);

    await closeWs(specWs);
    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 180_000);
});
