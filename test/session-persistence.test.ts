import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';
import { finishWorldSetup } from './lib/finish-world-setup.js';
import type { CharacterDefinition } from '../src/shared/types.js';

let harness: Harness;
let port: number;

const CHAR: CharacterDefinition = {
  name: 'Vex Ashgrove',
  backstory: 'Raised by cartographers on a dying moon.',
  personality: 'Curious, stubborn, allergic to authority.',
  highConcept: 'Runaway Star-Cartographer',
  trouble: 'Owes a debt to the Ledger Cult',
  aspects: ['Maps are promises', 'Never look back'],
  skills: { Notice: 3, Lore: 2, Will: 1 },
  stunts: ['Dead Reckoning: +2 to Notice when navigating.'],
};

beforeAll(async () => {
  harness = await startHarness();
  port = harness.port;
}, 30_000);

afterAll(async () => {
  await harness.stop();
});

async function createGame() {
  const ws = await connectWs(port);
  const q = new MessageQueue(ws);
  sendMsg(ws, { type: 'create', name: 'Refresh Test', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
  const joined = await q.waitFor('room-joined', 10_000) as any;
  return { ws, q, joined };
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((r) => { ws.once('close', () => r()); ws.close(); });
}

describe('DM session survives a page refresh', () => {
  it('hands the host a session token it can come back with', async () => {
    const { ws, joined } = await createGame();
    expect(joined.isOwner).toBe(true);
    expect(typeof joined.sessionToken).toBe('string');
    expect((joined.sessionToken as string).length).toBeGreaterThan(16);
    await closeWs(ws);
  }, 20_000);

  it('restores host role on rejoin after the socket is gone (refresh)', async () => {
    const { ws, joined } = await createGame();
    const { joinCode, sessionToken } = joined;
    await closeWs(ws);

    const ws2 = await connectWs(port);
    const q2 = new MessageQueue(ws2);
    sendMsg(ws2, { type: 'rejoin', joinCode, sessionToken } as any);
    const rejoined = await q2.waitFor('room-joined', 10_000) as any;

    expect(rejoined.isOwner).toBe(true);
    expect(rejoined.joinCode).toBe(joinCode);
    await closeWs(ws2);
  }, 20_000);

  it('re-sends DM lobby state (upload token) so the DM screen is usable again', async () => {
    const { ws, joined } = await createGame();
    const { joinCode, sessionToken } = joined;
    await closeWs(ws);

    const ws2 = await connectWs(port);
    const q2 = new MessageQueue(ws2);
    sendMsg(ws2, { type: 'rejoin', joinCode, sessionToken } as any);
    const settings = await q2.waitFor('dm-settings', 10_000) as any;
    expect(typeof settings.uploadToken).toBe('string');
    await closeWs(ws2);
  }, 20_000);
});

describe('Character submissions reach the DM even if the DM is away', () => {
  it('surfaces a character submitted while the host is disconnected once the host returns', async () => {
    const { ws: hostWs, q: hostQ, joined } = await createGame();
    const { joinCode, sessionToken } = joined;

    await finishWorldSetup(hostWs, hostQ);

    // DM refreshes / drops off.
    await closeWs(hostWs);

    // Player joins and submits while no host socket exists.
    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Liz' });
    await pq.waitFor('room-joined', 10_000);
    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const validated = await pq.waitFor('character-validated', 20_000) as any;
    expect(validated.approved).toBe(true);

    // DM comes back — the pending submission must be waiting for them.
    const hostWs2 = await connectWs(port);
    const hq = new MessageQueue(hostWs2);
    sendMsg(hostWs2, { type: 'rejoin', joinCode, sessionToken } as any);
    const pending = await hq.waitFor('character-pending-review', 15_000) as any;

    expect(pending.playerName).toBe('Liz');
    expect(pending.definition.name).toBe(CHAR.name);

    await closeWs(playerWs);
    await closeWs(hostWs2);
  }, 40_000);

  it('lists players who joined while the host was away', async () => {
    const { ws: hostWs, joined } = await createGame();
    const { joinCode, sessionToken } = joined;
    await closeWs(hostWs);

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);

    const hostWs2 = await connectWs(port);
    const hq = new MessageQueue(hostWs2);
    sendMsg(hostWs2, { type: 'rejoin', joinCode, sessionToken } as any);
    const lobby = await hq.waitFor('lobby-state', 15_000) as any;
    expect(lobby.players).toContain('Wendy');

    await closeWs(playerWs);
    await closeWs(hostWs2);
  }, 30_000);
});

describe('Rejoin cannot be used to take over another seat', () => {
  it('refuses a rejoin that carries no session token', async () => {
    const { ws, joined } = await createGame();
    const { joinCode } = joined;

    const attacker = await connectWs(port);
    const aq = new MessageQueue(attacker);
    // The join code is public — it is handed to every player.
    sendMsg(attacker, { type: 'rejoin', joinCode, playerName: 'Host' } as any);
    const reply = await aq.waitForAny(['room-joined', 'error'], 10_000) as any;

    expect(reply.type).toBe('error');
    await closeWs(attacker);
    await closeWs(ws);
  }, 20_000);

  it('does not hand host powers to a name-only rejoin', async () => {
    const { ws, joined } = await createGame();
    const { joinCode } = joined;

    const attacker = await connectWs(port);
    const aq = new MessageQueue(attacker);
    sendMsg(attacker, { type: 'rejoin', joinCode, playerName: 'Host' } as any);
    const reply = await aq.waitForAny(['room-joined', 'error'], 10_000) as any;

    expect(reply.type === 'room-joined' && reply.isOwner).not.toBe(true);
    await closeWs(attacker);
    await closeWs(ws);
  }, 20_000);

  it('leaves the real host connected after a takeover attempt', async () => {
    const { ws: hostWs, q: hostQ, joined } = await createGame();
    const { joinCode } = joined;

    await finishWorldSetup(hostWs, hostQ);

    const attacker = await connectWs(port);
    const aq = new MessageQueue(attacker);
    sendMsg(attacker, { type: 'rejoin', joinCode, playerName: 'Host' } as any);
    await aq.waitForAny(['room-joined', 'error'], 10_000);

    // The genuine host must still own the host socket: a submission has to
    // reach them, not the attacker.
    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);
    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });

    const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
    expect(review.playerName).toBe('Wendy');

    await closeWs(attacker);
    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 40_000);

  it('rejects a session token minted for a different game', async () => {
    const a = await createGame();
    const b = await createGame();

    const ws3 = await connectWs(port);
    const q3 = new MessageQueue(ws3);
    sendMsg(ws3, { type: 'rejoin', joinCode: b.joined.joinCode, sessionToken: a.joined.sessionToken } as any);
    const reply = await q3.waitForAny(['room-joined', 'error'], 10_000) as any;

    expect(reply.type).toBe('error');
    await closeWs(ws3);
    await closeWs(a.ws);
    await closeWs(b.ws);
  }, 30_000);

  it('rejects a fabricated session token', async () => {
    const { ws, joined } = await createGame();
    const ws2 = await connectWs(port);
    const q2 = new MessageQueue(ws2);
    sendMsg(ws2, { type: 'rejoin', joinCode: joined.joinCode, sessionToken: 'f'.repeat(48) } as any);
    const reply = await q2.waitForAny(['room-joined', 'error'], 10_000) as any;

    expect(reply.type).toBe('error');
    await closeWs(ws2);
    await closeWs(ws);
  }, 20_000);
});

describe('A stale socket closing does not evict the reconnected seat', () => {
  it('keeps the host in the room when their previous socket closes late', async () => {
    const { ws: hostWs1, joined } = await createGame();
    const { joinCode, sessionToken } = joined;

    // Reconnect BEFORE the old socket closes — the two overlap, which is what
    // happens when a browser restores a tab.
    const hostWs2 = await connectWs(port);
    const hq2 = new MessageQueue(hostWs2);
    sendMsg(hostWs2, { type: 'rejoin', joinCode, sessionToken } as any);
    await hq2.waitFor('room-joined', 10_000);

    await finishWorldSetup(hostWs2, hq2);

    await closeWs(hostWs1);

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);
    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });

    // The live host socket must still be the room's host.
    const review = await hq2.waitFor('character-pending-review', 20_000) as any;
    expect(review.playerName).toBe('Wendy');

    await closeWs(playerWs);
    await closeWs(hostWs2);
  }, 40_000);
});

describe('Table role governs DM authority', () => {
  it('reports ownership and an unset table role to the creator', async () => {
    const { ws, joined } = await createGame();
    expect(joined.isOwner).toBe(true);
    expect(joined.tableRole).toBeNull();
    await closeWs(ws);
  }, 20_000);

  it('refuses character approval from an owner who chose to play — but the character is already live via the AI DM', async () => {
    const { ws: hostWs, q: hostQ, joined } = await createGame();
    const { joinCode } = joined;

    await finishWorldSetup(hostWs, hostQ);

    sendMsg(hostWs, { type: 'choose-table-role', role: 'player' } as any);
    await hostQ.waitFor('room-joined', 10_000); // re-sent with the new role

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);
    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });

    // There is no human approver on this path — the AI DM's own validation
    // is the decision, and the character goes live immediately, without any
    // host-approve-character ever being sent. This used to be the dead end:
    // a pending row that sat in review forever because the only approver
    // (the host) had no DM authority to act on it.
    const validated = await pq.waitFor('character-validated', 20_000) as any;
    expect(validated.approved).toBe(true);
    // The broadcast reaches everyone in the room, so both queues get their
    // own copy of it — drain each before checking for a SECOND one below.
    const submitted = await hostQ.waitFor('character-submitted', 10_000) as any;
    expect(submitted.characterId).toBe(validated.characterId);
    const submittedToPlayer = await pq.waitFor('character-submitted', 10_000) as any;
    expect(submittedToPlayer.characterId).toBe(validated.characterId);

    // The owner is playing, not running the table, so their own
    // host-approve-character still carries no DM authority — it is refused,
    // same as before. The difference is the character no longer needed it to
    // go live, AND the refusal itself now has to actually arrive: absence of
    // a second character-submitted also holds for a handler that just did
    // nothing, so that alone can't tell a real refusal from the silent-return
    // bug this task removed. The 'error' message is the only thing that can.
    sendMsg(hostWs, { type: 'host-approve-character', characterId: validated.characterId });
    const refusal = await hostQ.waitFor('error', 10_000) as any;
    expect(refusal.message).toMatch(/host/i);
    await expect(pq.waitFor('character-submitted', 3_000)).rejects.toThrow(/Timeout/);

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 40_000);

  it('lets an owner with default (unset) table role approve a character', async () => {
    const { ws: hostWs, q: hostQ, joined } = await createGame();
    const { joinCode } = joined;

    await finishWorldSetup(hostWs, hostQ);
    // finishWorldSetup itself claims the DM chair via choose-table-role (it
    // has to — accepting a seed requires a table role), so host_table_role
    // is no longer unset by the time it returns. Null it back out directly
    // through the shared in-process DB (same module-registry trick used in
    // test/world-setup.test.ts) so this test still proves what its name
    // says: an owner whose table role was never explicitly chosen still gets
    // DM authority by default.
    const { getDb } = await import('../src/server/db.js');
    getDb().prepare('UPDATE campaigns SET host_table_role = NULL WHERE id = ?').run(joined.campaignId);

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);
    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const review = await hostQ.waitFor('character-pending-review', 20_000) as any;

    sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
    const submitted = await pq.waitFor('character-submitted', 10_000) as any;
    expect(submitted.characterId).toBe(review.characterId);

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 40_000);
});
