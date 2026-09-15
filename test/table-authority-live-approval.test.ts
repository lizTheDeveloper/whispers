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
  });
});
