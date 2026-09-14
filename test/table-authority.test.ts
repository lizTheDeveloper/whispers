// test/table-authority.test.ts — persistence half
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';
import { finishWorldSetup } from './lib/finish-world-setup.js';
import type { CharacterDefinition } from '../src/shared/types.js';

let dataDir: string; let db: any;
let mod: typeof import('../src/server/character-live.js');
let room: typeof import('../src/server/room.js');
let interviews: typeof import('../src/server/character-interview.js');

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-authority-'));
  process.env.DATA_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
  mod = await import('../src/server/character-live.js');
  room = await import('../src/server/room.js');
  interviews = await import('../src/server/character-interview.js');
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

const DEF = {
  name: 'Vesper Ash', highConcept: 'Keeper Who Stopped Believing',
  trouble: 'Owes a debt she cannot name', aspects: ['Maps are promises', 'Never looks back'],
  personality: 'Quiet.', backstory: 'Thirty years at the lamp.',
  skills: { Will: 3 }, stunts: ['Steady Hand: +2 to Will against fear.'],
} as any;

function seedPending(token = 'tok') {
  const { campaignId, joinCode } = room.createRoom(db, { name: 'Auth', dmPreset: 'chronicler', systemId: 'fate-core' });
  const session = room.createSession(db, { campaignId, joinCode, playerName: 'Wendy', isHost: false });
  const interview = interviews.getOrCreateInterview(db, campaignId, session.token);
  const pending = { id: 'char-' + token, campaignId, joinCode, sessionToken: session.token, playerName: 'Wendy', definition: DEF, aiFeedback: 'ok' };
  room.savePendingCharacter(db, pending);
  return { campaignId, session, interview, pending };
}

describe('makeCharacterLive', () => {
  it('inserts the character, claims the session, marks the interview live, and clears the pending row', () => {
    const { campaignId, session, pending } = seedPending('a');
    mod.makeCharacterLive(db, pending);

    expect(room.countLiveCharacters(db, campaignId)).toBe(1);
    expect(db.prepare('SELECT character_id FROM campaign_sessions WHERE token = ?').get(session.token).character_id).toBe(pending.id);
    expect(interviews.getInterviewBySession(db, campaignId, session.token)!.status).toBe('live');
    expect(room.listPendingCharacters(db, campaignId)).toHaveLength(0);
  });

  it('propagates a failure without applying the write it failed on', () => {
    const { pending } = seedPending('b');
    // What this proves: characters.campaign_id's FK is the only statement in
    // makeCharacterLive that can throw, and it throws on the FIRST statement
    // inside the transaction — so the throw propagates to the caller (it is
    // not swallowed) and that first insert was not applied for `bad`'s own
    // id, nor was the session claim that would have followed it.
    //
    // What this does NOT prove: rollback of a completed write. A failure
    // that lands AFTER a successful statement — e.g. the pending-row delete
    // failing once the insert and session claim already landed — is not
    // exercised here, and could not be without a schema change:
    // campaign_sessions.character_id has no FK, deletePendingCharacter
    // cannot throw on a missing row, and SQLite cannot add a constraint via
    // ALTER. Removing the `db.transaction(...)` wrapper entirely would not
    // change this test's result.
    const bad = { ...pending, id: 'char-b2', campaignId: 'no-such-campaign' };
    expect(() => mod.makeCharacterLive(db, bad)).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS c FROM characters WHERE id = ?').get(bad.id).c).toBe(0);
    expect(db.prepare('SELECT character_id FROM campaign_sessions WHERE token = ?').get(bad.sessionToken).character_id).toBeNull();
  });
});

describe('revocation', () => {
  it('stops counting toward the party without deleting the row', () => {
    const { campaignId, pending } = seedPending('c');
    mod.makeCharacterLive(db, pending);
    expect(room.countLiveCharacters(db, campaignId)).toBe(1);

    expect(room.revokeCharacter(db, pending.id)).toBe(true);
    expect(room.countLiveCharacters(db, campaignId)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM characters WHERE id = ?').get(pending.id).c).toBe(1);
  });

  it('survives a character that has memories — a hard delete would throw', () => {
    const { campaignId, pending } = seedPending('d');
    mod.makeCharacterLive(db, pending);
    db.prepare("INSERT INTO character_memories (id, character_id, campaign_id, scene_number, turn_number, type, content) VALUES (?,?,?,0,0,'fact','remembered')")
      .run('mem-1', pending.id, campaignId);
    expect(() => room.revokeCharacter(db, pending.id)).not.toThrow();
    expect(room.countLiveCharacters(db, campaignId)).toBe(0);
  });

  it('returns false for a character that does not exist', () => {
    expect(room.revokeCharacter(db, 'no-such-character')).toBe(false);
  });

  it('clears the session claim so the player can build another', () => {
    const { campaignId, session, pending } = seedPending('e');
    mod.makeCharacterLive(db, pending);
    room.clearSessionCharacter(db, session.token);
    expect(db.prepare('SELECT character_id FROM campaign_sessions WHERE token = ?').get(session.token).character_id).toBeNull();
  });
});

// --- table-authority.test.ts — socket half -------------------------------
//
// The host chooses exactly one lane: run the table as DM, or play a
// character in it. When they choose to play, there is no human left to
// approve other players' characters — the AI DM's own validation has to be
// the decision, or a submitted character sits in review forever and the
// game can never start. These prove that path end to end over real sockets,
// and that choosing 'dm' (the default, and every campaign created before
// roles existed) is unaffected.
describe('AI DM approves characters when the host is playing', () => {
  let harness: Harness;
  let port: number;

  beforeAll(async () => { harness = await startHarness(); port = harness.port; }, 30_000);
  afterAll(async () => { await harness.stop(); });

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

  function closeWs(ws: WebSocket): Promise<void> {
    return new Promise((r) => { ws.once('close', () => r()); ws.close(); });
  }

  async function createGame() {
    const ws = await connectWs(port);
    const q = new MessageQueue(ws);
    sendMsg(ws, { type: 'create', name: 'Authority Socket Test', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
    const joined = await q.waitFor('room-joined', 10_000) as any;
    return { ws, q, joined };
  }

  it('goes live with no host action when the host chose to play, and unblocks start-game', async () => {
    const { ws: hostWs, q: hostQ, joined } = await createGame();
    const { joinCode } = joined;

    await finishWorldSetup(hostWs, hostQ, 'player');

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);

    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });

    // No human approver exists on this path — validation IS the decision.
    const validated = await pq.waitFor('character-validated', 15_000) as any;
    expect(validated.approved).toBe(true);

    const submitted = await hostQ.waitFor('character-submitted', 10_000) as any;
    expect(submitted.characterId).toBe(validated.characterId);

    // Nothing was queued for a human, and no negotiation opened — there is
    // no one to negotiate with.
    await expect(
      hostQ.waitForAny(['character-pending-review', 'negotiation-opened'], 2_000)
    ).rejects.toThrow(/Timeout/);

    // Today this stayed refused forever with no live characters. Now it
    // should succeed immediately.
    sendMsg(hostWs, { type: 'start-game' });
    const phase = await hostQ.waitFor('phase-change', 15_000) as any;
    expect(phase.phase).toBe('playing');

    // Unwind the GameLoop so it doesn't keep recursing against the LLM stub
    // after this test's harness is torn down.
    sendMsg(hostWs, { type: 'end-game' });
    await hostQ.waitFor('phase-change', 20_000);

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 60_000);

  it('still routes through host review when the host chose to run the table (default)', async () => {
    const { ws: hostWs, q: hostQ, joined } = await createGame();
    const { joinCode } = joined;

    await finishWorldSetup(hostWs, hostQ); // defaults to 'dm'

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);

    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const review = await hostQ.waitFor('character-pending-review', 20_000) as any;

    // Nothing goes live until the host acts.
    await expect(pq.waitFor('character-submitted', 2_000)).rejects.toThrow(/Timeout/);

    sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
    const submitted = await pq.waitFor('character-submitted', 10_000) as any;
    expect(submitted.characterId).toBe(review.characterId);

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 60_000);
});
