// test/table-authority-live-approval.test.ts — socket half
//
// The host chooses exactly one lane: run the table as DM, or play a
// character in it. When they choose to play, there is no human left to
// approve other players' characters — the AI DM's own validation has to be
// the decision, or a submitted character sits in review forever and the
// game can never start. These prove that path end to end over real sockets,
// and that choosing 'dm' (the default, and every campaign created before
// roles existed) is unaffected.
//
// Kept in its own file (not alongside table-authority.test.ts's
// persistence-half describes, which import src/server/db.js at module scope)
// so this file's first import of db.js — transitively, via startHarness() —
// is the one that sets DATA_DIR. The first test below asserts against
// harness.dataDir directly, so a regression here fails loudly on its own.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { WebSocket } from 'ws';
import { readdirSync } from 'node:fs';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';
import { finishWorldSetup } from './lib/finish-world-setup.js';
import type { CharacterDefinition } from '../src/shared/types.js';

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

  const CHAR2: CharacterDefinition = {
    name: 'Rin Osei',
    backstory: 'Grew up running cargo between orbital stations.',
    personality: 'Loyal, blunt, terrible at sitting still.',
    highConcept: 'Reformed Smuggler',
    trouble: "Family still owes the people she used to run for",
    aspects: ['Knows every back route', 'Never leaves a debt unpaid'],
    skills: { Athletics: 3, Deceive: 2, Will: 1 },
    stunts: ['Quick Hands: +2 to Athletics to get somewhere fast.'],
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

    // Proof the server actually wrote through the harness's own throwaway
    // data dir, not a database singleton some other test file already
    // opened: the sqlite file (plus its WAL/SHM siblings, since db.ts turns
    // on journal_mode=WAL) must exist inside harness.dataDir once activity
    // like the submission above has happened.
    const files = readdirSync(harness.dataDir);
    expect(files).toContain('whispers.db');

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

  it("acknowledges a successful host-reject-character to the host's own socket, not just the player's", async () => {
    // character-validated (approved: false) already told the player. Before
    // this fix round, the host who clicked Reject got nothing back at all —
    // the client painted "Rejected" on the click itself, a claim the server
    // had not yet made good on. This is the acknowledgement that closes that
    // gap: sent to the rejecting host once the pending row is actually gone.
    const { ws: hostWs, q: hostQ, joined } = await createGame();
    const { joinCode } = joined;

    await finishWorldSetup(hostWs, hostQ); // host runs the table (default)

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);
    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
    // Drain the AI DM's own approved:true confirmation — sent to the player
    // the moment it validates the submission, before host review even
    // starts — so the assertion below observes the host's decision, not
    // this earlier one.
    await pq.waitFor('character-validated', 10_000);

    sendMsg(hostWs, { type: 'host-reject-character', characterId: review.characterId, reason: 'Not a fit for this table' });

    const ack = await hostQ.waitFor('character-rejected', 10_000) as any;
    expect(ack.characterId).toBe(review.characterId);
    expect(ack.reason).toBe('Not a fit for this table');

    const validated = await pq.waitFor('character-validated', 10_000) as any;
    expect(validated.approved).toBe(false);

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 60_000);

  describe('host review guards refuse with a message, not silence', () => {
    it('refuses host-approve-character from a host without DM authority, with a message naming that', async () => {
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ, 'player'); // host chose to play, not run the table

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);
      sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
      // AI DM approves on its own here — there is no human approver on this
      // path — but the host's own socket still has no DM authority, and
      // sending host-approve-character anyway must be refused with a reason,
      // not dropped.
      const validated = await pq.waitFor('character-validated', 15_000) as any;
      await hostQ.waitFor('character-submitted', 10_000);

      sendMsg(hostWs, { type: 'host-approve-character', characterId: validated.characterId });
      const refusal = await hostQ.waitFor('error', 10_000) as any;
      expect(refusal.message).toMatch(/host/i);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);

    it('refuses host-reject-character from a host without DM authority, with a message naming that', async () => {
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ, 'player'); // host chose to play, not run the table

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);
      sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
      const validated = await pq.waitFor('character-validated', 15_000) as any;
      await hostQ.waitFor('character-submitted', 10_000);

      sendMsg(hostWs, { type: 'host-reject-character', characterId: validated.characterId, reason: 'no' });
      const refusal = await hostQ.waitFor('error', 10_000) as any;
      expect(refusal.message).toMatch(/host/i);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);

    it('refuses host-approve-character for a characterId that is not pending review', async () => {
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ); // host runs the table (default) — has DM authority

      sendMsg(hostWs, { type: 'host-approve-character', characterId: 'no-such-character' });
      const refusal = await hostQ.waitFor('error', 10_000) as any;
      expect(refusal.message).toMatch(/pending review|already have been decided/i);

      await closeWs(hostWs);
    }, 60_000);

    it('refuses host-reject-character for a characterId that is not pending review', async () => {
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ); // host runs the table (default) — has DM authority

      sendMsg(hostWs, { type: 'host-reject-character', characterId: 'no-such-character', reason: 'n/a' });
      const refusal = await hostQ.waitFor('error', 10_000) as any;
      expect(refusal.message).toMatch(/pending review|already have been decided/i);

      await closeWs(hostWs);
    }, 60_000);

    it('refuses host-approve-character a second time for a character already decided, instead of re-broadcasting', async () => {
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ); // host runs the table (default)

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);
      sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
      const review = await hostQ.waitFor('character-pending-review', 20_000) as any;

      sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
      await hostQ.waitFor('character-submitted', 10_000);
      await pq.waitFor('character-submitted', 10_000);

      // The pending row is gone now — a second approve of the same id must
      // be refused, not silently re-run (which would re-broadcast
      // character-submitted a second time for an already-live character).
      sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
      const refusal = await hostQ.waitFor('error', 10_000) as any;
      expect(refusal.message).toMatch(/pending review|already have been decided/i);
      await expect(pq.waitFor('character-submitted', 2_000)).rejects.toThrow(/Timeout/);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);

    it("refuses choose-table-role with an invalid role value", async () => {
      const { ws: hostWs, q: hostQ } = await createGame();

      sendMsg(hostWs, { type: 'choose-table-role', role: 'wizard' } as any);
      const refusal = await hostQ.waitFor('error', 10_000) as any;
      expect(refusal.message).toMatch(/table role|'dm'|'player'/i);

      await closeWs(hostWs);
    }, 20_000);

    it('refuses an oversized host-reject-character reason with a message, instead of broadcasting it', async () => {
      // reason is unbounded on the wire but ends up on the player's own
      // screen (character-validated.feedback) and, via that broadcast, in
      // every later LLM prompt that quotes it back. Same bound as
      // revoke-character's reason (isValidLongField / MAX_LONG_FIELD), just
      // never enforced here before this fix.
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ); // host runs the table (default)

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);
      sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
      const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
      await pq.waitFor('character-validated', 10_000);

      sendMsg(hostWs, { type: 'host-reject-character', characterId: review.characterId, reason: 'x'.repeat(5001) });
      const refusal = await hostQ.waitFor('error', 10_000) as any;
      expect(refusal.message).toMatch(/reason.*most|most.*characters/i);

      // Nothing reached the player — the oversized reason never broadcasts.
      await expect(pq.waitFor('character-validated', 2_000)).rejects.toThrow(/Timeout/);
      await expect(hostQ.waitFor('character-rejected', 2_000)).rejects.toThrow(/Timeout/);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);
  });

  /**
   * The host owns the world whether they are running the table or playing in
   * it, so they keep a silent, non-blocking veto over a character even after
   * it went live: they can remove it after the fact. Gets a campaign with one
   * live, host-approved character and both sockets' queues drained of the
   * traffic that produced it, ready for a revoke-character test to act on.
   */
  async function createApprovedCharacter() {
    const { ws: hostWs, q: hostQ, joined } = await createGame();
    const { joinCode, campaignId } = joined;

    await finishWorldSetup(hostWs, hostQ); // host runs the table (default)

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
    const playerJoined = await pq.waitFor('room-joined', 10_000) as any;

    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
    await pq.waitFor('character-validated', 10_000);

    sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
    await hostQ.waitFor('character-submitted', 10_000);
    await pq.waitFor('character-submitted', 10_000);

    return {
      hostWs, hostQ, playerWs, pq, joinCode,
      campaignId: campaignId as string,
      characterId: review.characterId as string,
      playerSessionToken: playerJoined.sessionToken as string,
    };
  }

  describe("the host's veto", () => {
    it('lets the owner revoke a live character: it drops out of the party count, the whole room is told, and the interview reopens', async () => {
      const { hostWs, hostQ, playerWs, pq, campaignId, characterId, playerSessionToken } = await createApprovedCharacter();

      const room = await import('../src/server/room.js');
      const interviews = await import('../src/server/character-interview.js');
      const db = (await import('../src/server/db.js')).getDb();

      // Exact count before, not just "a revoke happened" — a revoke that hit
      // the wrong row, or double-counted, would still let a looser assertion
      // pass.
      expect(room.countLiveCharacters(db, campaignId)).toBe(1);
      expect(interviews.getInterviewBySession(db, campaignId, playerSessionToken)!.status).toBe('live');

      sendMsg(hostWs, { type: 'revoke-character', characterId, reason: 'Breaking trust at the table' });

      // The room is told — both the host's own socket and the revoked
      // player's socket receive the broadcast, with the reason carried
      // through.
      const hostSaw = await hostQ.waitFor('character-revoked', 10_000) as any;
      expect(hostSaw.characterId).toBe(characterId);
      expect(hostSaw.reason).toBe('Breaking trust at the table');
      const playerSaw = await pq.waitFor('character-revoked', 10_000) as any;
      expect(playerSaw.characterId).toBe(characterId);
      expect(playerSaw.reason).toBe('Breaking trust at the table');

      // Exact count after — the party actually shrank, not merely "a row
      // somewhere got touched".
      expect(room.countLiveCharacters(db, campaignId)).toBe(0);

      // The player can build another: their interview is open again, not
      // stuck on the revoked character's 'live' status.
      expect(interviews.getInterviewBySession(db, campaignId, playerSessionToken)!.status).toBe('open');

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);

    it("refuses a non-owner's revoke with a message instead of silently succeeding", async () => {
      const { hostWs, hostQ, playerWs, pq, campaignId, characterId } = await createApprovedCharacter();

      const room = await import('../src/server/room.js');
      const db = (await import('../src/server/db.js')).getDb();

      sendMsg(playerWs, { type: 'revoke-character', characterId, reason: 'I want out' });

      // The refusal message itself must actually arrive at the sender — not
      // merely "the state stayed the same", which would also be true of a
      // handler that just did nothing at all.
      const refusal = await pq.waitFor('error', 10_000) as any;
      expect(refusal.message).toMatch(/host/i);

      // Nothing was broadcast to the room over this.
      await expect(hostQ.waitFor('character-revoked', 2_000)).rejects.toThrow(/Timeout/);

      // And the character is still exactly as live as it was.
      expect(room.countLiveCharacters(db, campaignId)).toBe(1);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);

    it('refuses to revoke an unknown character id with a message', async () => {
      const { hostWs, hostQ, playerWs } = await createApprovedCharacter();

      sendMsg(hostWs, { type: 'revoke-character', characterId: 'no-such-character', reason: 'n/a' });
      const refusal = await hostQ.waitFor('error', 10_000) as any;
      expect(refusal.message).toMatch(/already gone|cannot be revoked/i);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);

    // C9: characterId went straight into room.ts's raw SQL bind
    // (`UPDATE characters SET revoked_at = ... WHERE id = ?`) with no
    // validation, unlike `reason` on this same message (validated a few
    // lines above it) or `role` on choose-table-role. better-sqlite3 binds a
    // bare `undefined` characterId as SQL NULL without complaint (harmless —
    // it just falls into the ordinary "not pending" refusal), but an object
    // payload — e.g. `{}`, plausible from a malformed or adversarial client —
    // makes better-sqlite3 try to resolve it as NAMED parameters against a
    // statement that only has a positional `?`, finds none, and throws
    // RangeError: Too few parameter values were provided. Nothing downstream
    // catches that, so it becomes an unhandled rejection: the global handler
    // (index.ts) logs it and the process survives, but the host who sent the
    // revoke gets nothing back at all — on a branch whose whole theme is
    // that refusals speak.
    it('refuses a malformed (object) characterId with a message instead of an unhandled rejection', async () => {
      const { hostWs, hostQ, playerWs } = await createApprovedCharacter();

      sendMsg(hostWs, { type: 'revoke-character', characterId: { not: 'a string' }, reason: 'n/a' } as any);
      const refusal = await hostQ.waitFor('error', 10_000) as any;
      expect(refusal.message).toMatch(/character id/i);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);

    it('refuses to revoke an already-revoked character a second time, rather than silently succeeding again', async () => {
      const { hostWs, hostQ, playerWs, pq, campaignId, characterId } = await createApprovedCharacter();

      const room = await import('../src/server/room.js');
      const db = (await import('../src/server/db.js')).getDb();

      sendMsg(hostWs, { type: 'revoke-character', characterId, reason: 'First revoke' });
      await hostQ.waitFor('character-revoked', 10_000);
      await pq.waitFor('character-revoked', 10_000);
      expect(room.countLiveCharacters(db, campaignId)).toBe(0);

      sendMsg(hostWs, { type: 'revoke-character', characterId, reason: 'Second revoke' });
      const refusal = await hostQ.waitFor('error', 10_000) as any;
      expect(refusal.message).toMatch(/already gone|cannot be revoked/i);

      // Only the first revoke ever produced a broadcast — the second refusal
      // did not also fire one.
      await expect(pq.waitFor('character-revoked', 2_000)).rejects.toThrow(/Timeout/);
      expect(room.countLiveCharacters(db, campaignId)).toBe(0);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);

    it('revokes a character whose player is offline: durable state updates even though nobody is connected to receive it', async () => {
      // This is the case a "self-heals on reconnect" claim would paper over:
      // rejoin (src/server/index.ts) trusts session.characterId with no
      // revoked check, and nothing else reconciles a session pointed at a
      // revoked row. So the durable writes below — not the in-memory seat,
      // which no longer exists once the socket is closed — are the only
      // thing standing between this player and reconnecting still holding a
      // revoked character with an interview stuck on 'live'.
      const { hostWs, hostQ, playerWs, campaignId, characterId, playerSessionToken } = await createApprovedCharacter();

      const room = await import('../src/server/room.js');
      const interviews = await import('../src/server/character-interview.js');
      const db = (await import('../src/server/db.js')).getDb();

      await closeWs(playerWs);

      sendMsg(hostWs, { type: 'revoke-character', characterId, reason: 'Gone before the ruling landed' });
      const hostSaw = await hostQ.waitFor('character-revoked', 10_000) as any;
      expect(hostSaw.characterId).toBe(characterId);

      expect(room.countLiveCharacters(db, campaignId)).toBe(0);

      const sessionRow = db.prepare('SELECT character_id FROM campaign_sessions WHERE token = ?').get(playerSessionToken) as any;
      expect(sessionRow.character_id).toBeNull();
      expect(interviews.getInterviewBySession(db, campaignId, playerSessionToken)!.status).toBe('open');

      await closeWs(hostWs);
    }, 60_000);

    it("uses isWorldAuthor, not hasDmAuthority: the owner can still veto while seated as a player", async () => {
      // The one scenario that actually distinguishes the two guard functions.
      // Every other test in this describe block runs with the host in the
      // 'dm' seat (finishWorldSetup's default), where isWorldAuthor and
      // hasDmAuthority agree — a suite built entirely out of those cannot
      // tell the right guard from the brief-violating one. This is the host
      // who chose to PLAY: hasDmAuthority(seat, 'player') is false for them,
      // so a handler that swapped to it would refuse their own veto.
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ, 'player');

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);

      sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
      const validated = await pq.waitFor('character-validated', 15_000) as any;
      expect(validated.approved).toBe(true);
      const submitted = await hostQ.waitFor('character-submitted', 10_000) as any;

      sendMsg(hostWs, { type: 'revoke-character', characterId: submitted.characterId, reason: 'Still my table even while I play in it' });
      const revoked = await hostQ.waitFor('character-revoked', 10_000) as any;
      expect(revoked.characterId).toBe(submitted.characterId);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);

    it('stops a revoked character mid-session: the live loop drops them from its party size and never gives them another turn', async () => {
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ); // host runs the table

      const playerAWs = await connectWs(port);
      const aq = new MessageQueue(playerAWs);
      sendMsg(playerAWs, { type: 'join', joinCode, playerName: 'Ada' });
      await aq.waitFor('room-joined', 10_000);
      sendMsg(playerAWs, { type: 'submit-character', definition: CHAR });
      const reviewA = await hostQ.waitFor('character-pending-review', 20_000) as any;
      sendMsg(hostWs, { type: 'host-approve-character', characterId: reviewA.characterId });
      await aq.waitFor('character-submitted', 10_000);
      await hostQ.waitFor('character-submitted', 10_000);

      const playerBWs = await connectWs(port);
      const bq = new MessageQueue(playerBWs);
      sendMsg(playerBWs, { type: 'join', joinCode, playerName: 'Rin' });
      await bq.waitFor('room-joined', 10_000);
      sendMsg(playerBWs, { type: 'submit-character', definition: CHAR2 });
      const reviewB = await hostQ.waitFor('character-pending-review', 20_000) as any;
      sendMsg(hostWs, { type: 'host-approve-character', characterId: reviewB.characterId });
      await bq.waitFor('character-submitted', 10_000);
      await hostQ.waitFor('character-submitted', 10_000);

      sendMsg(hostWs, { type: 'start-game' });
      const phase = await hostQ.waitFor('phase-change', 15_000) as any;
      expect(phase.phase).toBe('playing');

      // gameLoops is exported from src/server/index.ts specifically so a test
      // can look at the live loop's own view of the party, not just the
      // durable rows loadCharacters() read once at start() — that one-time
      // read is exactly why a revoke needs its own path into the running
      // loop instead of relying on the database alone.
      const serverMod = await import('../src/server/index.js');
      const loop = serverMod.gameLoops.get(joinCode);
      expect(loop).toBeDefined();
      expect(loop!.partySize).toBe(2);

      sendMsg(hostWs, { type: 'revoke-character', characterId: reviewB.characterId, reason: 'Cut from the scene' });
      await hostQ.waitFor('character-revoked', 10_000);

      // Exact count, not "a revoke happened somewhere" — the live loop's own
      // party actually shrank.
      expect(loop!.partySize).toBe(1);

      // And the revoked character never takes another turn: collect a
      // handful of turn events (responding to each whisper-prompt so the
      // round completes and the next one starts) and assert B's id never
      // shows up, while A's — the survivor — does.
      const seenCharacterIds = new Set<string>();
      let turnsCompleted = 0;
      while (turnsCompleted < 3) {
        let msg: any;
        try {
          msg = await hostQ.waitForAny(['action-proposals', 'whisper-prompt'], 5_000);
        } catch {
          break;
        }
        seenCharacterIds.add(msg.characterId);
        if (msg.type === 'whisper-prompt') {
          sendMsg(hostWs, { type: 'whisper', text: 'Push forward.' });
          turnsCompleted++;
        }
      }
      expect(seenCharacterIds.has(reviewA.characterId)).toBe(true);
      expect(seenCharacterIds.has(reviewB.characterId)).toBe(false);

      sendMsg(hostWs, { type: 'end-game' });
      await hostQ.waitFor('phase-change', 20_000);

      await closeWs(playerAWs);
      await closeWs(playerBWs);
      await closeWs(hostWs);
    }, 60_000);

    // C2: GameLoop.revokeCharacter deleted from `this.characters` and
    // filtered `initiativeOrder` with no check for reaching zero. An empty
    // initiativeOrder means processTurn is never called, so currentTurn/
    // sceneTurnCount (only incremented inside it) freeze forever — the exact
    // counters sessionHardLimit and every round-count guard in runScene are
    // keyed off of — while runScene's tail recursion has no idea any of that
    // happened and keeps calling the DM for narration every pass, unbounded
    // (measured live at ~520 LLM calls/second), stoppable only by end-game.
    // This is the same "nothing left to stop it" hole start-game's own
    // countLiveCharacters === 0 guard exists to prevent, reached mid-game
    // instead of before it starts. Proven here against the real LLM stub by
    // counting requests it actually received, not by inferring a stop from
    // a flag: if the loop were still spinning, even a short wait below would
    // show the count climbing by dozens: at ~520/sec it would not merely
    // grow, it would run away.
    it('stops the live loop instead of spinning when a revoke empties the party entirely', async () => {
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ); // host runs the table

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);
      sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
      const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
      sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
      await pq.waitFor('character-submitted', 10_000);
      await hostQ.waitFor('character-submitted', 10_000);

      sendMsg(hostWs, { type: 'start-game' });
      const phase = await hostQ.waitFor('phase-change', 15_000) as any;
      expect(phase.phase).toBe('playing');

      const serverMod = await import('../src/server/index.js');
      const loop = serverMod.gameLoops.get(joinCode);
      expect(loop).toBeDefined();
      expect(loop!.partySize).toBe(1);

      // Let the sole character's turn actually reach the point of pausing
      // for a whisper — genuinely mid-game, not "revoked before the loop
      // did anything" — then revoke instead of answering it.
      await hostQ.waitFor('whisper-prompt', 15_000);

      sendMsg(hostWs, { type: 'revoke-character', characterId: review.characterId, reason: 'Table is done' });
      await hostQ.waitFor('character-revoked', 10_000);
      expect(loop!.partySize).toBe(0);

      // endGame() (the same path end-game itself drives) broadcasts this —
      // proof the loop actually ran its stop sequence, not just that
      // revokeCharacter returned.
      const ended = await hostQ.waitFor('phase-change', 20_000) as any;
      expect(ended.phase).toBe('ended');

      // Zombie-loop check: a stopped loop left parked in gameLoops would
      // still hold a reference nothing ever cleans up.
      await new Promise((r) => setTimeout(r, 300));
      expect(serverMod.gameLoops.get(joinCode)).toBeUndefined();

      // The falsifiable core: sample the LLM stub's own received-request
      // count twice, a full second apart, well after the phase already
      // flipped to 'ended'. A live loop still spinning at ~520 calls/sec
      // would show hundreds of new requests in that window; a stopped one
      // shows zero.
      const countA = harness.receivedBodies.length;
      await new Promise((r) => setTimeout(r, 1_000));
      const countB = harness.receivedBodies.length;
      expect(countB).toBe(countA);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);

    it('does not reopen the interview on a mid-game revoke — the rebuild path stays honest', async () => {
      // revoke-character used to reopen the revoked player's interview
      // unconditionally. That is a promise submit-character and char-chat
      // both break once phase has left character-creation (both refuse
      // outside it) — a revoke mid-game left the interview 'open' with no
      // handler that would ever honor it. The fix: only reopen while still
      // in character-creation, where the promise is actually kept.
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ); // host runs the table

      const playerAWs = await connectWs(port);
      const aq = new MessageQueue(playerAWs);
      sendMsg(playerAWs, { type: 'join', joinCode, playerName: 'Ada' });
      const aJoined = await aq.waitFor('room-joined', 10_000) as any;
      sendMsg(playerAWs, { type: 'submit-character', definition: CHAR });
      const reviewA = await hostQ.waitFor('character-pending-review', 20_000) as any;
      sendMsg(hostWs, { type: 'host-approve-character', characterId: reviewA.characterId });
      await aq.waitFor('character-submitted', 10_000);
      await hostQ.waitFor('character-submitted', 10_000);

      const playerBWs = await connectWs(port);
      const bq = new MessageQueue(playerBWs);
      sendMsg(playerBWs, { type: 'join', joinCode, playerName: 'Rin' });
      await bq.waitFor('room-joined', 10_000);
      sendMsg(playerBWs, { type: 'submit-character', definition: CHAR2 });
      const reviewB = await hostQ.waitFor('character-pending-review', 20_000) as any;
      sendMsg(hostWs, { type: 'host-approve-character', characterId: reviewB.characterId });
      await bq.waitFor('character-submitted', 10_000);
      await hostQ.waitFor('character-submitted', 10_000);

      sendMsg(hostWs, { type: 'start-game' });
      const phase = await hostQ.waitFor('phase-change', 15_000) as any;
      expect(phase.phase).toBe('playing');

      // Revoke A, not B, so the party doesn't empty and the game keeps
      // running — this test is about the interview, not about end-of-game.
      sendMsg(hostWs, { type: 'revoke-character', characterId: reviewA.characterId, reason: 'Recast' });
      await hostQ.waitFor('character-revoked', 10_000);

      const interviews = await import('../src/server/character-interview.js');
      const db = (await import('../src/server/db.js')).getDb();
      const interview = interviews.getInterviewBySession(db, joined.campaignId, aJoined.sessionToken);
      // Not 'open' — makeCharacterLive set it to 'live' when A was approved,
      // and the mid-game revoke must not have moved it off that.
      expect(interview!.status).not.toBe('open');

      // And the state isn't just labeled honestly — it behaves that way:
      // both routes a reopened interview would need still refuse.
      sendMsg(playerAWs, { type: 'char-chat', text: 'Can I build someone new?' });
      const chatRefusal = await aq.waitFor('error', 10_000) as any;
      expect(chatRefusal.message).toMatch(/character creation/i);

      sendMsg(playerAWs, { type: 'submit-character', definition: CHAR });
      const submitRefusal = await aq.waitFor('error', 10_000) as any;
      expect(submitRefusal.message).toMatch(/character creation/i);

      sendMsg(hostWs, { type: 'end-game' });
      await hostQ.waitFor('phase-change', 20_000);

      await closeWs(playerAWs);
      await closeWs(playerBWs);
      await closeWs(hostWs);
    }, 60_000);

    it('broadcasts the live party roster when the game starts, to host and player alike', async () => {
      // The only source the host's mid-game revoke UI (and a room-wide
      // character-revoked notice, which needs a name to show) has for who is
      // actually at the table.
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ); // host runs the table

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);
      sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
      const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
      sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
      await pq.waitFor('character-submitted', 10_000);
      await hostQ.waitFor('character-submitted', 10_000);

      sendMsg(hostWs, { type: 'start-game' });
      await hostQ.waitFor('phase-change', 15_000);

      const hostRoster = await hostQ.waitFor('character-roster', 10_000) as any;
      expect(hostRoster.characters).toEqual([{ id: review.characterId, name: CHAR.name }]);
      const playerRoster = await pq.waitFor('character-roster', 10_000) as any;
      expect(playerRoster.characters).toEqual([{ id: review.characterId, name: CHAR.name }]);

      sendMsg(hostWs, { type: 'end-game' });
      await hostQ.waitFor('phase-change', 20_000);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);
  });

  describe('a negotiation that can end', () => {
    it('caps agent turns at the round limit, broadcasts a closure, and does not auto-approve', async () => {
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ); // host runs the table (default) — a human approver exists

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);

      sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
      const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
      await pq.waitFor('character-validated', 10_000);

      await hostQ.waitFor('negotiation-opened', 10_000);
      const opening = await hostQ.waitFor('negotiation-message', 15_000) as any;
      expect(opening.sender).toBe('dm-agent');

      const { MAX_NEGOTIATION_ROUNDS } = await import('../src/server/negotiation.js');

      // Drive one round past the cap. Each round in-bounds must produce
      // exactly one dm-agent turn and one char-agent turn; the round that
      // crosses the cap must produce neither — only a closure notice — which
      // is the falsifiable core of this test: a handler that kept calling
      // runAgentTurns regardless of the cap would still pass a weaker
      // assertion like "a message was sent," but fails this one on the
      // round MAX_NEGOTIATION_ROUNDS + 1's missing char-agent turn.
      let charAgentTurns = 0;
      for (let round = 1; round <= MAX_NEGOTIATION_ROUNDS + 1; round++) {
        sendMsg(hostWs, { type: 'negotiation-message', characterId: review.characterId, text: `Host says round ${round}` });
        const hostEcho = await hostQ.waitFor('negotiation-message', 10_000) as any;
        expect(hostEcho.sender).toBe('host');

        sendMsg(playerWs, { type: 'negotiation-message', characterId: review.characterId, text: `Player says round ${round}` });
        const playerEcho = await hostQ.waitFor('negotiation-message', 10_000) as any;
        expect(playerEcho.sender).toBe('player');

        if (round <= MAX_NEGOTIATION_ROUNDS) {
          const dmTurn = await hostQ.waitFor('negotiation-message', 15_000) as any;
          expect(dmTurn.sender).toBe('dm-agent');
          const charTurn = await hostQ.waitFor('negotiation-message', 15_000) as any;
          expect(charTurn.sender).toBe('char-agent');
          charAgentTurns++;
        } else {
          const closure = await hostQ.waitFor('negotiation-message', 15_000) as any;
          expect(closure.sender).toBe('dm-agent');
          expect(closure.text).toMatch(/closed|limit/i);
          // No char-agent turn ran for the round that crossed the cap.
          await expect(hostQ.waitFor('negotiation-message', 2_000)).rejects.toThrow(/Timeout/);

          // Structured, alongside the prose above — this is what a client
          // actually switches on to disable its input box; the prose line is
          // free text a client can only ever log, never act on. Sent to both
          // sides (sendToBoth), not just the host.
          const hostClosed = await hostQ.waitFor('negotiation-closed', 5_000) as any;
          expect(hostClosed.characterId).toBe(review.characterId);
          const playerClosed = await pq.waitFor('negotiation-closed', 5_000) as any;
          expect(playerClosed.characterId).toBe(review.characterId);
        }
      }
      expect(charAgentTurns).toBe(MAX_NEGOTIATION_ROUNDS);

      // The negotiation is fully closed, not merely "quiet": a further
      // exchange produces no broadcast of any kind, not even the human
      // messages' own echo.
      sendMsg(hostWs, { type: 'negotiation-message', characterId: review.characterId, text: 'still there?' });
      await expect(hostQ.waitFor('negotiation-message', 2_000)).rejects.toThrow(/Timeout/);

      // Do NOT auto-approve at the cap — the decision stays with the host.
      await expect(pq.waitFor('character-submitted', 2_000)).rejects.toThrow(/Timeout/);
      await expect(hostQ.waitFor('character-submitted', 2_000)).rejects.toThrow(/Timeout/);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 90_000);

    it('refuses an oversized negotiation-message with a message, instead of broadcasting it to the other side', async () => {
      // text is unbounded on the wire but reaches the other participant's
      // screen via broadcast AND the DM/character agent prompts on the next
      // round — same bound as revoke-character's reason and
      // host-reject-character's reason.
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ); // host runs the table (default)

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);
      sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
      const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
      await pq.waitFor('character-validated', 10_000);
      await hostQ.waitFor('negotiation-opened', 10_000);
      await hostQ.waitFor('negotiation-message', 15_000); // the DM's opening line, host side
      await pq.waitFor('negotiation-message', 15_000); // same opening line, player side — drain both before asserting on silence below

      sendMsg(hostWs, { type: 'negotiation-message', characterId: review.characterId, text: 'y'.repeat(5001) });
      const refusal = await hostQ.waitFor('error', 10_000) as any;
      expect(refusal.message).toMatch(/most.*characters/i);

      // Nothing was broadcast to the player over this — not even an echo.
      await expect(pq.waitFor('negotiation-message', 2_000)).rejects.toThrow(/Timeout/);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);

    it('room teardown clears a stale negotiation so a replacement can open for the same character', async () => {
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;
      const hostSessionToken = joined.sessionToken as string;

      await finishWorldSetup(hostWs, hostQ); // host runs the table (default)

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);

      sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
      const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
      await pq.waitFor('character-validated', 10_000);
      await hostQ.waitFor('negotiation-opened', 10_000);
      await hostQ.waitFor('negotiation-message', 15_000); // the DM's opening turn

      const serverMod = await import('../src/server/index.js');
      const originalNegotiation = serverMod.negotiations.get(review.characterId);
      expect(originalNegotiation).toBeDefined();

      await closeWs(playerWs);
      await closeWs(hostWs);

      // Past the (test-shortened, see server-harness.ts) room-teardown grace
      // period, which clears rooms/gameLoops/negotiations together.
      await new Promise((r) => setTimeout(r, 900));

      // The map itself shrank — not merely "the room emptied".
      expect(serverMod.negotiations.has(review.characterId)).toBe(false);

      // The consequence a shrunk-but-not-checked map would miss: reconnect
      // must actually be able to open a REPLACEMENT negotiation for this
      // still-pending character. Before this fix, has() being permanently
      // true blocked openNegotiation from ever running again for this
      // characterId — not just a memory leak, a dead feature for anyone who
      // reconnects. A fresh NegotiationRoom instance (not the same
      // reference) proves openNegotiation actually ran, as opposed to
      // replayTo() quietly resending the old, dead one.
      const hostWs2 = await connectWs(port);
      const hostQ2 = new MessageQueue(hostWs2);
      sendMsg(hostWs2, { type: 'rejoin', joinCode, sessionToken: hostSessionToken } as any);
      await hostQ2.waitFor('room-joined', 10_000);
      await hostQ2.waitFor('negotiation-opened', 10_000);
      await hostQ2.waitFor('negotiation-message', 15_000); // the replacement's own opening turn

      const replacementNegotiation = serverMod.negotiations.get(review.characterId);
      expect(replacementNegotiation).toBeDefined();
      expect(replacementNegotiation).not.toBe(originalNegotiation);

      await closeWs(hostWs2);
    }, 30_000);

    it('does not reopen a negotiation on reconnect once the host has switched to playing — no approver, no negotiation', async () => {
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;
      const campaignId = joined.campaignId as string;
      const hostSessionToken = joined.sessionToken as string;

      await finishWorldSetup(hostWs, hostQ); // host runs the table (default) — needed so submission creates a pending row + negotiation instead of auto-approving

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);

      sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
      await hostQ.waitFor('character-pending-review', 20_000);
      await pq.waitFor('character-validated', 10_000);
      await hostQ.waitFor('negotiation-opened', 10_000);
      await hostQ.waitFor('negotiation-message', 15_000); // the DM's opening turn

      // "Host switches to playing WHILE a character is still under
      // negotiation" is no longer reachable through the protocol — this
      // task's own guard now refuses choose-table-role once any pending or
      // live character exists, precisely to prevent this. But that guard
      // only protects table roles chosen from here forward; a campaign that
      // already reached hostTableRole = 'player' with a character still
      // pending — the exact state this permissive code used to allow —
      // does not get retroactively fixed. Its row sits in the database
      // exactly as it always did, and reconnecting into it must still be
      // safe. So this seeds that state directly, bypassing the protocol
      // guard the same way an old campaign row does, rather than reaching
      // it through choose-table-role (which now refuses the attempt). The
      // pending row, and the now-abandoned negotiation object, are both
      // still sitting there either way.
      const { getDb } = await import('../src/server/db.js');
      const { setHostTableRole } = await import('../src/server/room.js');
      setHostTableRole(getDb(), campaignId, 'player');

      await closeWs(playerWs);
      await closeWs(hostWs);
      // Past the (test-shortened) room-teardown grace period — this task's
      // own leak fix clears the stale negotiation entry, which is exactly
      // what makes the reconnect loop's `else openNegotiation(...)` branch
      // reachable again below. Without the hasDmAuthority gate this is
      // testing, that branch would happily reopen a negotiation for a table
      // that now has nobody able to approve or reject anything.
      await new Promise((r) => setTimeout(r, 900));

      const hostWs2 = await connectWs(port);
      const hostQ2 = new MessageQueue(hostWs2);
      sendMsg(hostWs2, { type: 'rejoin', joinCode, sessionToken: hostSessionToken } as any);
      await hostQ2.waitFor('room-joined', 10_000);

      // The pending character is still reported — there is still a row to
      // act on eventually — but no negotiation panel opens for a table with
      // no one able to end it.
      await hostQ2.waitFor('character-pending-review', 10_000);
      await expect(hostQ2.waitFor('negotiation-opened', 3_000)).rejects.toThrow(/Timeout/);

      await closeWs(hostWs2);
    }, 30_000);

    it('a close landing mid-round does not append or broadcast the reply that was already in flight', async () => {
      // close() can land from host-approve-character, host-reject-character,
      // or room teardown while runAgentTurns()'s own await is still
      // outstanding — all three run independently of this negotiation's
      // control flow. Checking `closed` only between the DM call and the
      // character call (the original shape of this method) leaves the
      // window right after EACH await resolves unguarded: a close landing
      // there still appended to history and broadcast, onto sockets this
      // task's own leak fix now lets a fresh negotiation for the same
      // character legitimately reuse. This drives exactly that interleaving
      // over real sockets, using the RACE_DELAY_TRIGGER marker (see
      // server-harness.ts) to hold the DM's reply open long enough to land
      // an approve underneath it.
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ); // host runs the table (default)

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);

      sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
      const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
      await pq.waitFor('character-validated', 10_000);
      await hostQ.waitFor('negotiation-opened', 10_000);
      await hostQ.waitFor('negotiation-message', 15_000); // the DM's opening turn — unaffected, no marker in it yet

      // The marker rides into history via this message, so it lands in the
      // round call's own prompt ("Conversation so far: ${transcript}") and
      // the stub holds THAT reply open.
      sendMsg(hostWs, { type: 'negotiation-message', characterId: review.characterId, text: 'RACE_DELAY_TRIGGER — thoughts on the stunt?' });
      await hostQ.waitFor('negotiation-message', 10_000); // host's own echo

      sendMsg(playerWs, { type: 'negotiation-message', characterId: review.characterId, text: 'Sounds fine to me.' });
      await hostQ.waitFor('negotiation-message', 10_000); // player's own echo — this is what triggers runAgentTurns()

      // The DM's reply is now in flight and deliberately held open. Close
      // the negotiation out from under it before that reply lands.
      sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
      await hostQ.waitFor('character-submitted', 10_000);
      await pq.waitFor('character-submitted', 10_000);

      // hostQ has been drained of exactly the opening turn plus the two
      // human echoes above — nothing else has arrived on it. The negotiation
      // is now closed (approve calls neg.close() synchronously) while the
      // delayed DM reply is still outstanding. Wait comfortably past the
      // stub's artificial 600ms hold: if the post-await `closed` re-check is
      // missing, that reply still lands here.
      await expect(hostQ.waitFor('negotiation-message', 3_000)).rejects.toThrow(/Timeout/);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 30_000);
  });

  describe('a host who is playing meets their own world', () => {
    it('sends the world introduction to the host, not just to other players, once the table opens', async () => {
      // accept-world-seed used to build its post-open introduction list by
      // filtering out every seat with isOwner === true — correct when the
      // host runs the table, wrong when the host chose to play: that host
      // has no one else to hand them their own first sight of the world.
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ, 'player');

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);

      // The other player gets theirs regardless — this proves the fix adds
      // the host rather than replacing the existing broadcast.
      const playerIntro = await pq.waitFor('world-introduction', 15_000) as any;
      expect(playerIntro.text.length).toBeGreaterThan(0);

      const hostIntro = await hostQ.waitFor('world-introduction', 15_000) as any;
      expect(hostIntro.text.length).toBeGreaterThan(0);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);
  });

  describe('the table role locks once a character exists at the table', () => {
    it('refuses choose-table-role while a character is pending review, naming the real reason, and leaves hostTableRole unchanged', async () => {
      // Switching lanes is harmless right up until a character's fate
      // depends on who holds authority — not merely "once the table has
      // opened," which can happen with zero characters at the table and
      // costs nothing. A PENDING character is the sharpest case: DM review
      // ran once, at submit-character time, and nothing retroactively
      // approves the queue — a host who swaps away from 'dm' while one is
      // queued strands it, since hasDmAuthority then refuses both the AI's
      // path and the human's, with no one left who could ever act on it.
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ); // host runs the table (default) — a human approver exists, so submission queues instead of auto-approving

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);

      sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
      await hostQ.waitFor('character-pending-review', 20_000);
      await pq.waitFor('character-validated', 10_000);

      sendMsg(hostWs, { type: 'choose-table-role', role: 'player' } as any);
      const refusal = await hostQ.waitFor('error', 10_000) as any;
      // The real reason is the character, not the phase — a message blaming
      // the phase would be false under this rule.
      expect(refusal.message).toMatch(/character/i);

      // Not just "no success message arrived" — the stored role must
      // actually still be 'dm', not silently changed underneath a refusal
      // that only failed to notify.
      const room = await import('../src/server/room.js');
      const db = (await import('../src/server/db.js')).getDb();
      const campaign = room.joinRoom(db, joinCode);
      expect(campaign?.hostTableRole).toBe('dm');

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);

    it('also refuses choose-table-role once a character is LIVE (not merely pending) — the hasLiveCharacter half of the guard', async () => {
      // The guard is `hasPendingCharacter || hasLiveCharacter`. A character
      // that has already been approved is no longer pending — approval
      // deletes its pending row (see makeCharacterLive) — so this exercises
      // hasLiveCharacter in isolation from hasPendingCharacter: disabling
      // hasLiveCharacter alone, with hasPendingCharacter left correct, makes
      // this refusal vanish while every other test in this file still
      // passes.
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      await finishWorldSetup(hostWs, hostQ); // host runs the table (default)

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);
      sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
      const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
      await pq.waitFor('character-validated', 10_000);

      sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
      await hostQ.waitFor('character-submitted', 10_000);
      await pq.waitFor('character-submitted', 10_000);

      // No pending characters remain — the row was deleted on approval — so
      // a refusal here can only come from hasLiveCharacter.
      const room2 = await import('../src/server/room.js');
      const db2 = (await import('../src/server/db.js')).getDb();
      expect(room2.listPendingCharacters(db2, joined.campaignId).length).toBe(0);

      sendMsg(hostWs, { type: 'choose-table-role', role: 'player' } as any);
      const refusal2 = await hostQ.waitFor('error', 10_000) as any;
      expect(refusal2.message).toMatch(/character/i);
      expect(room2.joinRoom(db2, joinCode)?.hostTableRole).toBe('dm');

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);
  });

  // Task 7, Step 4: dnd5e is selectable but data/systems/dnd5e does not
  // exist, so every rules lookup for it returns the sentinel
  // '(No rules found for this query)' — before this fix that sentinel got
  // interpolated into prompts as if it were the rulebook, with nothing
  // telling the host. The harness's DATA_DIR is a bare tmpdir with no
  // systems/ subdirectory at all (see server-harness.ts), so bootstrapRules
  // (src/server/index.ts) never finds fate-core/srd.txt to ingest either —
  // rule_chunks is empty for EVERY systemId in this harness, 'fate-core'
  // included. So the control test below seeds a row for a made-up systemId
  // directly, rather than relying on 'fate-core' actually having one.
  describe('a system with no ingested rulebook is announced, not silently degraded', () => {
    it("tells the host plainly at creation, instead of a normal LLM-generated greeting", async () => {
      const ws = await connectWs(port);
      const q = new MessageQueue(ws);
      sendMsg(ws, { type: 'create', name: 'No Rulebook Test', dmPreset: 'chronicler', scenarioId: null, systemId: 'dnd5e', houseRules: null });
      await q.waitFor('room-joined', 10_000);

      const greeting = await q.waitFor('dm-chat-reply', 10_000) as any;
      expect(greeting.text).toMatch(/rulebook/i);
      expect(greeting.text).toMatch(/upload|sidebar/i);
      // Still a normal, non-terminal setup message — the option was not
      // taken away, and setup can still proceed.
      expect(greeting.done).toBe(false);

      await closeWs(ws);
    }, 20_000);

    it('is unaffected for a system that DOES have an ingested rulebook — the normal LLM greeting still runs, not the notice', async () => {
      // Without this, a broken guard that always fires (e.g. one that
      // checks systemId === 'dnd5e' as a string, or one whose COUNT query is
      // wrong and always reads 0 regardless of systemId) would pass the test
      // above for the wrong reason.
      const { getDb } = await import('../src/server/db.js');
      const db = getDb();
      db.prepare('INSERT INTO rule_chunks (system_id, source_book, section, content) VALUES (?, ?, ?, ?)')
        .run('rulebook-present-test-system', 'Test Rulebook', 'Intro', 'Some rules text.');

      const ws = await connectWs(port);
      const q = new MessageQueue(ws);
      sendMsg(ws, { type: 'create', name: 'Rulebook Present Test', dmPreset: 'chronicler', scenarioId: null, systemId: 'rulebook-present-test-system', houseRules: null });
      await q.waitFor('room-joined', 10_000);

      const greeting = await q.waitFor('dm-chat-reply', 10_000) as any;
      // The stub's ordinary setupOpen fixture — see LLM_STUB_REPLIES in
      // server-harness.ts — not the no-rulebook notice.
      expect(greeting.text).toBe('What kind of game are we running?');

      await closeWs(ws);
    }, 20_000);
  });

  // Task 7, Step 1 (server half) + Step 3's empty-introduction-guard test.
  // sendWorldIntroduction persists whatever introduceWorld returns as turn 0
  // of the interview PERMANENTLY (it is never regenerated once `stored`
  // exists — see the comment on that function in src/server/index.ts). An
  // LLM outage/hiccup that returns '' or whitespace must not get persisted
  // as a blank "first sight of the world" that then rides into every later
  // interviewForCharacter call forever. This carry-forward guard already
  // existed; this is its first test.
  describe('sendWorldIntroduction discards an empty introduction instead of persisting it', () => {
    it('sends nothing and stores nothing when the LLM returns whitespace-only text', async () => {
      const ws = await connectWs(port);
      const q = new MessageQueue(ws);
      // EMPTY_INTRO_TRIGGER as the campaign's dmPreset selects the stub's
      // whitespace-only introduceWorld reply — see server-harness.ts.
      sendMsg(ws, { type: 'create', name: 'Empty Intro Test', dmPreset: 'EMPTY_INTRO_TRIGGER', scenarioId: null, systemId: 'fate-core', houseRules: null });
      const joined = await q.waitFor('room-joined', 10_000) as any;
      const { joinCode, campaignId } = joined;

      await finishWorldSetup(ws, q); // host runs the table (default)

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      const playerJoined = await pq.waitFor('room-joined', 10_000) as any;
      expect(playerJoined.phase).toBe('character-creation');

      // Nothing is sent to the joining player.
      await expect(pq.waitFor('world-introduction', 3_000)).rejects.toThrow(/Timeout/);

      // And nothing is persisted — the interview's transcript must still be
      // empty, so a real attempt can run next time instead of replaying a
      // permanently blank introduction forever.
      const { getDb } = await import('../src/server/db.js');
      const { getInterviewBySession } = await import('../src/server/character-interview.js');
      const db = getDb();
      const interview = getInterviewBySession(db, campaignId, playerJoined.sessionToken);
      expect(interview?.transcript ?? []).toHaveLength(0);

      await closeWs(playerWs);
      await closeWs(ws);
    }, 60_000);
  });

  // Task 7, Step 2 + Step 3's readiness-fallback-branch test. The char-chat
  // handler's displayed readiness must never contradict a ready sheet
  // already stored on the interview — see the comment above this branch in
  // src/server/index.ts.
  describe('char-chat readiness display never contradicts a ready stored sheet', () => {
    // Drives an interview to a stored, ready definition (the harness's stub
    // turns "done" on the second char-chat turn — see server-harness.ts),
    // then drains the character-preview that produces so a later assertion
    // observes only the THIRD turn's messages.
    async function readyInterview() {
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;
      await finishWorldSetup(hostWs, hostQ);

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);
      await pq.waitFor('world-introduction', 10_000);

      sendMsg(playerWs, { type: 'char-chat', text: 'I want to play a scavenger with a grudge against the company.' });
      await pq.waitFor('char-chat-reply', 15_000);
      await pq.waitFor('character-readiness', 10_000);

      sendMsg(playerWs, { type: 'char-chat', text: 'She lost her sister to the dust and never forgave the company for it.' });
      const reply2 = await pq.waitFor('char-chat-reply', 15_000) as any;
      const readyPreview = await pq.waitFor('character-preview', 10_000) as any;
      expect(readyPreview.readiness.ready).toBe(true);
      expect(reply2.definition).not.toBeNull();

      return { hostWs, playerWs, pq, readyDefinition: readyPreview.definition };
    }

    it('falls back to the stored ready definition, not a contradicting checklist, when a later turn proposes nothing new', async () => {
      const { hostWs, playerWs, pq, readyDefinition } = await readyInterview();

      // NULL_DEFINITION_TRIGGER forces the model's reply on this turn back
      // to a plain clarifying-question shape (definition: null), the same
      // as it gives on turn one — proving the carry-forward fallback that
      // re-reads the STORED definition when nothing new was proposed.
      sendMsg(playerWs, { type: 'char-chat', text: 'NULL_DEFINITION_TRIGGER can she be called Ash?' });
      const reply3 = await pq.waitFor('char-chat-reply', 15_000) as any;
      expect(reply3.definition).toBeNull();

      const preview = await pq.waitFor('character-preview', 10_000) as any;
      expect(preview.readiness.ready).toBe(true);
      expect(preview.definition.name).toBe(readyDefinition.name);

      // The screen must not ALSO be told the sheet is unfinished.
      await expect(pq.waitFor('character-readiness', 300)).rejects.toThrow();

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);

    it('falls back to the stored ready definition, not a contradicting checklist, when a later turn proposes a thin non-null one', async () => {
      // This is Task 7 Step 2's own dead end: THIN_SHEET_TRIGGER makes the
      // model hand back a definition object with only `name` filled in —
      // non-null, so the old code's `reply.definition ?? interview.definition`
      // fallback never engaged, and the player's already-finished, already-
      // stored character was told it was missing every field, with neither
      // the preview nor the confirm affordance shown. Reusing
      // THIN_SHEET_TRIGGER here (rather than a new marker) is deliberate —
      // it is already proven unique to this same branch in
      // character-interview.test.ts.
      const { hostWs, playerWs, pq, readyDefinition } = await readyInterview();

      sendMsg(playerWs, { type: 'char-chat', text: 'THIN_SHEET_TRIGGER can she be called Ash?' });
      const reply3 = await pq.waitFor('char-chat-reply', 15_000) as any;
      expect(reply3.definition).toBeNull();

      const preview = await pq.waitFor('character-preview', 10_000) as any;
      expect(preview.readiness.ready).toBe(true);
      expect(preview.definition.name).toBe(readyDefinition.name);

      // Before the Step 2 fix, this turn produced a 'character-readiness'
      // message claiming every field was missing instead.
      await expect(pq.waitFor('character-readiness', 300)).rejects.toThrow();

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 60_000);
  });

  // Code-review finding 1 on this task: the Step 4 notice tells the HOST
  // once, at creation, that their chosen system has no ingested rulebook —
  // but it does not by itself stop the underlying sentinel from reaching
  // every OTHER prompt this server sends for the rest of the campaign.
  // lookupRules (src/server/agents/dm.ts) used to return the literal string
  // '(No rules found for this query)' on zero chunks, and four call sites
  // interpolated it raw: setupChat (re-invoked on every dm-chat),interviewForCharacter, validateCharacter, and resolve()'s <rules> block
  // for in-game action resolution. This drives one full campaign through
  // ALL FOUR of those call sites — setup chat (via finishWorldSetup's
  // dm-chat), a two-turn character interview, submission/validation, and
  // one full action-resolution turn — against a system with zero
  // rule_chunks (every systemId in this harness, since its DATA_DIR has no
  // systems/ subdirectory to bootstrap from — see the describe block above
  // this one), then asserts the sentinel appears in NONE of the raw prompt
  // bodies the LLM stub received across the whole flow.
  describe('the "(No rules found for this query)" sentinel never reaches a prompt', () => {
    it('is absent from every prompt body across setup chat, interview, validation, and resolution', async () => {
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;

      // Drives setupChat: once for the 'create' greeting (intercepted by
      // the Step 4 notice, so no LLM call), and once for real via the
      // host's own dm-chat message below.
      await finishWorldSetup(hostWs, hostQ); // host runs the table (default)

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);
      await pq.waitFor('world-introduction', 10_000);

      // Drives interviewForCharacter twice — the harness's stub turns
      // "done" on the second turn (see server-harness.ts).
      sendMsg(playerWs, { type: 'char-chat', text: 'I want to play a scavenger with a grudge against the company.' });
      await pq.waitFor('char-chat-reply', 15_000);
      await pq.waitFor('character-readiness', 10_000);
      sendMsg(playerWs, { type: 'char-chat', text: 'She lost her sister to the dust and never forgave the company for it.' });
      await pq.waitFor('char-chat-reply', 15_000);
      const preview = await pq.waitFor('character-preview', 10_000) as any;

      // Drives validateCharacter.
      sendMsg(playerWs, { type: 'confirm-character' });
      sendMsg(playerWs, { type: 'submit-character', definition: preview.definition });
      const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
      await pq.waitFor('character-validated', 10_000);

      sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
      await pq.waitFor('character-submitted', 10_000);
      await hostQ.waitFor('character-submitted', 10_000);

      // Drives resolve() via one full action-resolution turn.
      sendMsg(hostWs, { type: 'start-game' });
      await hostQ.waitFor('phase-change', 15_000);
      await hostQ.waitFor('action-proposals', 15_000);
      await hostQ.waitFor('whisper-prompt', 15_000);
      sendMsg(hostWs, { type: 'whisper', text: 'Push forward.' });
      await hostQ.waitFor('resolution', 20_000);

      sendMsg(hostWs, { type: 'end-game' });
      await hostQ.waitFor('phase-change', 20_000);

      const offenders = harness.receivedBodies.filter(b => b.includes('(No rules found for this query)'));
      expect(offenders).toHaveLength(0);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 90_000);
  });

  // Code-review finding 2 on this task: `interview` in the char-chat handler
  // (src/server/index.ts) is fetched BEFORE `await dm.interviewForCharacter`.
  // The Step 2 fix now reads `.definition` off that pre-await snapshot in
  // two places after the await — a gating condition and the payload sent to
  // the client — instead of re-reading the database. This proves the fix:
  // a concurrent write that lands during the round trip (simulated directly
  // against the DB, held open with RACE_DELAY_TRIGGER — see
  // server-harness.ts) must be reflected in this turn's response.
  describe('char-chat re-reads the interview after the LLM round trip, not a stale pre-await snapshot', () => {
    it('reflects a concurrent clear of the stored definition, not the definition fetched before the round trip', async () => {
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode, campaignId } = joined;
      await finishWorldSetup(hostWs, hostQ);

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      const playerJoined = await pq.waitFor('room-joined', 10_000) as any;
      await pq.waitFor('world-introduction', 10_000);

      sendMsg(playerWs, { type: 'char-chat', text: 'I want to play a scavenger with a grudge against the company.' });
      await pq.waitFor('char-chat-reply', 15_000);
      await pq.waitFor('character-readiness', 10_000);

      sendMsg(playerWs, { type: 'char-chat', text: 'She lost her sister to the dust and never forgave the company for it.' });
      await pq.waitFor('char-chat-reply', 15_000);
      const readyPreview = await pq.waitFor('character-preview', 10_000) as any;
      expect(readyPreview.readiness.ready).toBe(true);

      // RACE_DELAY_TRIGGER holds this turn's LLM reply open ~600ms.
      // THIN_SHEET_TRIGGER makes the model's OWN proposal thin/not-ready
      // too, so the only way this turn could still come back "ready" is by
      // reusing the stale pre-await snapshot rather than re-reading the DB.
      sendMsg(playerWs, { type: 'char-chat', text: 'RACE_DELAY_TRIGGER THIN_SHEET_TRIGGER can she be called Ash?' });

      // Land a concurrent write directly against the database while that
      // reply is still held open — the same shape of interleaving a second,
      // faster char-chat (or a revoke) could produce for real.
      await new Promise((r) => setTimeout(r, 150));
      const { getDb } = await import('../src/server/db.js');
      const { getInterviewBySession, setInterviewDefinition } = await import('../src/server/character-interview.js');
      const db = getDb();
      const stale = getInterviewBySession(db, campaignId, playerJoined.sessionToken);
      expect(stale?.definition).not.toBeNull(); // sanity: was ready before the concurrent write
      setInterviewDefinition(db, stale!.id, null);

      const reply3 = await pq.waitFor('char-chat-reply', 15_000) as any;
      expect(reply3.definition).toBeNull();

      // Must reflect the concurrent clear — not ready, a checklist — rather
      // than the ready snapshot fetched before the LLM call started.
      const readiness = await pq.waitFor('character-readiness', 10_000) as any;
      expect(readiness.readiness.ready).toBe(false);
      await expect(pq.waitFor('character-preview', 300)).rejects.toThrow();

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 30_000);
  });

  // C1: submit-character snapshots the campaign BEFORE its
  // dm.validateCharacter await (a multi-second LLM call) and used to read
  // hostTableRole off that STALE snapshot afterward — both for its own
  // AI-approves-vs-host-reviews decision and for the openNegotiation guard
  // it calls with the same object. choose-table-role's lane guard only sees
  // characters written via savePendingCharacter — which does not run until
  // AFTER that same await — so a host who flips lanes mid-validation used
  // to slip straight through it. The stale pre-flip role then went on to
  // decide the approval path anyway: a pending row got written and a
  // negotiation opened under a hostTableRole nobody could act on any
  // longer. Every exit was closed — host-approve/host-reject re-read the DB
  // and refuse (no DM authority under the new role), revoke-character has
  // no LIVE row yet to act on (this character never made it past pending),
  // and flipping back to 'dm' is refused because a pending row now exists.
  // The fix re-reads the campaign from the database right after the await,
  // before either decision, matching the precedent host-approve-character
  // already set with its own fresh joinRoom() call.
  describe('submit-character re-reads the campaign after the validation round trip, not a stale pre-await snapshot', () => {
    it('does not strand a character when the host flips lanes mid-validation', async () => {
      const { ws: hostWs, q: hostQ, joined } = await createGame();
      const { joinCode } = joined;
      await finishWorldSetup(hostWs, hostQ); // host starts as 'dm' (default)

      const playerWs = await connectWs(port);
      const pq = new MessageQueue(playerWs);
      sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
      await pq.waitFor('room-joined', 10_000);

      // RACE_DELAY_TRIGGER (see server-harness.ts) holds dm.validateCharacter's
      // reply open ~600ms — ample time to land the lane flip below before
      // that await resolves.
      const raceChar: CharacterDefinition = {
        ...CHAR,
        backstory: `${CHAR.backstory} RACE_DELAY_TRIGGER`,
      };
      sendMsg(playerWs, { type: 'submit-character', definition: raceChar });

      // Let the submit handler snapshot the campaign and issue the (delayed)
      // validation request before the flip below lands — mirrors the
      // char-chat race test above's own 150ms margin against the same
      // 600ms stub delay.
      await new Promise((r) => setTimeout(r, 150));

      // The lane guard (listPendingCharacters + countLiveCharacters) sees
      // nothing yet — savePendingCharacter has not run — so this flip goes
      // through.
      sendMsg(hostWs, { type: 'choose-table-role', role: 'player' } as any);
      await hostQ.waitFor('room-joined', 10_000);

      // Validation resolves ~450ms later. Fixed behaviour: the approval
      // decision re-reads the campaign, sees the host is now a player, and
      // the AI DM's own validation IS the decision — the character goes
      // straight live, exactly like the "host chose to play" path (first
      // test in this file), not into review/negotiation limbo under the
      // stale 'dm' role.
      const validated = await pq.waitFor('character-validated', 15_000) as any;
      expect(validated.approved).toBe(true);
      expect(validated.feedback).toMatch(/in the game/i);

      const submitted = await hostQ.waitFor('character-submitted', 10_000) as any;
      expect(submitted.characterId).toBe(validated.characterId);

      // Must not be stranded: no pending-review queued for a host who no
      // longer has DM authority, and no negotiation opened for a player to
      // sit in front of dead Approve/Reject buttons.
      await expect(
        hostQ.waitForAny(['character-pending-review', 'negotiation-opened'], 500)
      ).rejects.toThrow(/Timeout/);

      await closeWs(playerWs);
      await closeWs(hostWs);
    }, 30_000);
  });
});
