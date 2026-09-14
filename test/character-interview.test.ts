import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';
import { finishWorldSetup } from './lib/finish-world-setup.js';

let dataDir: string;
let db: any;
let mod: typeof import('../src/server/character-interview.js');
let createRoom: typeof import('../src/server/room.js').createRoom;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-interview-'));
  process.env.DATA_DIR = dataDir;
  // DATA_DIR is bound at module load, so import after setting it.
  db = (await import('../src/server/db.js')).getDb();
  mod = await import('../src/server/character-interview.js');
  ({ createRoom } = await import('../src/server/room.js'));
});

afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

function newCampaign() {
  return createRoom(db, { name: 'Interview Test', dmPreset: 'chronicler', systemId: 'fate-core' }).campaignId;
}

describe('interview persistence', () => {
  it('creates one record per session and returns the same one afterwards', () => {
    const c = newCampaign();
    const a = mod.getOrCreateInterview(db, c, 'token-a');
    const b = mod.getOrCreateInterview(db, c, 'token-a');
    expect(b.id).toBe(a.id);
    expect(mod.getOrCreateInterview(db, c, 'token-b').id).not.toBe(a.id);
  });

  it('appends turns in order and survives a fresh read', () => {
    const c = newCampaign();
    const rec = mod.getOrCreateInterview(db, c, 'tok');
    mod.appendInterviewTurn(db, rec.id, { role: 'assistant', content: 'What are you thinking about?' });
    mod.appendInterviewTurn(db, rec.id, { role: 'user', content: 'The dust.' });

    const read = mod.getInterviewBySession(db, c, 'tok')!;
    expect(read.transcript.map(t => t.content)).toEqual(['What are you thinking about?', 'The dust.']);
  });

  it('stores a derived definition and a status', () => {
    const c = newCampaign();
    const rec = mod.getOrCreateInterview(db, c, 'tok');
    expect(rec.definition).toBeNull();
    expect(rec.status).toBe('open');

    mod.setInterviewDefinition(db, rec.id, { name: 'Vesper Ash' } as any);
    mod.setInterviewStatus(db, rec.id, 'confirmed');

    const read = mod.getInterviewBySession(db, c, 'tok')!;
    expect(read.definition?.name).toBe('Vesper Ash');
    expect(read.status).toBe('confirmed');
  });

  it('keeps the transcript after the definition is derived — the raw conversation is the point', () => {
    const c = newCampaign();
    const rec = mod.getOrCreateInterview(db, c, 'tok');
    mod.appendInterviewTurn(db, rec.id, { role: 'user', content: 'I never look back.' });
    mod.setInterviewDefinition(db, rec.id, { name: 'Vesper Ash' } as any);
    mod.setInterviewStatus(db, rec.id, 'live');

    const read = mod.getInterviewBySession(db, c, 'tok')!;
    expect(read.transcript).toHaveLength(1);
    expect(read.transcript[0]!.content).toBe('I never look back.');
  });

  it('degrades to an empty transcript rather than throwing on corrupt JSON', () => {
    const c = newCampaign();
    const rec = mod.getOrCreateInterview(db, c, 'tok');
    db.prepare('UPDATE character_interviews SET transcript = ? WHERE id = ?').run('not json{', rec.id);
    const read = mod.getInterviewBySession(db, c, 'tok')!;
    expect(read.transcript).toEqual([]);
  });

  it('degrades to a null definition rather than throwing on corrupt JSON', () => {
    const c = newCampaign();
    const rec = mod.getOrCreateInterview(db, c, 'tok');
    db.prepare('UPDATE character_interviews SET definition = ? WHERE id = ?').run('not json{', rec.id);
    const read = mod.getInterviewBySession(db, c, 'tok')!;
    expect(read.definition).toBeNull();
  });

  it('returns null for a session that has no interview', () => {
    expect(mod.getInterviewBySession(db, newCampaign(), 'nobody')).toBeNull();
  });
});

describe('the interview end-to-end, over the wire', () => {
  let harness: Harness;
  let port: number;

  beforeAll(async () => { harness = await startHarness(); port = harness.port; }, 30_000);
  afterAll(async () => { await harness.stop(); });

  function closeWs(ws: WebSocket): Promise<void> {
    return new Promise((r) => { ws.once('close', () => r()); ws.close(); });
  }

  async function openTable() {
    const hostWs = await connectWs(port);
    const hostQ = new MessageQueue(hostWs);
    sendMsg(hostWs, { type: 'create', name: 'Interview E2E', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
    const joined = await hostQ.waitFor('room-joined', 10_000) as any;
    await hostQ.waitFor('dm-chat-reply', 10_000); // the DM's opening greeting
    await finishWorldSetup(hostWs, hostQ);
    return { hostWs, hostQ, joined };
  }

  it('takes a player from world introduction through a confirmed, submittable character, surviving a reconnect', async () => {
    const { hostWs, joined } = await openTable();

    // A player who joins after the table is already open meets the world.
    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    const roomJoined = await pq.waitFor('room-joined', 10_000) as any;
    expect(roomJoined.phase).toBe('character-creation');

    const intro = await pq.waitFor('world-introduction', 10_000) as any;
    expect(typeof intro.text).toBe('string');
    expect(intro.text.trim().length).toBeGreaterThan(0);
    // Regression guard for the landmine fixed at the top of this task: the
    // stub must hand back prose, not a JSON blob presented to the player as
    // the world's first sight.
    expect(intro.text.trim().startsWith('{')).toBe(false);

    // A first char-chat is not enough to finish the sheet — the reply carries
    // no definition, and every unmet item comes back on its own message.
    sendMsg(playerWs, { type: 'char-chat', text: 'I want to play a scavenger with a grudge against the company.' });
    const reply1 = await pq.waitFor('char-chat-reply', 15_000) as any;
    expect(reply1.definition).toBeNull();
    const readiness1 = await pq.waitFor('character-readiness', 10_000) as any;
    expect(readiness1.readiness.ready).toBe(false);
    expect(readiness1.readiness.unmet).toEqual(
      expect.arrayContaining(['name', 'highConcept', 'trouble', 'aspects', 'skills', 'stunts'])
    );

    // A second turn is what the harness's stub treats as "done" — the model
    // now believes the sheet is finished, so a preview arrives...
    sendMsg(playerWs, { type: 'char-chat', text: 'She lost her sister to the dust and never forgave the company for it.' });
    const reply2 = await pq.waitFor('char-chat-reply', 15_000) as any;
    expect(reply2.definition).not.toBeNull();
    const preview = await pq.waitFor('character-preview', 10_000) as any;
    expect(preview.readiness.ready).toBe(true);
    expect(preview.definition.name).toBeTruthy();

    // ...but the model does not get to finish the interview by itself: an
    // unconfirmed submission is refused even though the sheet is complete.
    sendMsg(playerWs, { type: 'submit-character', definition: preview.definition });
    const refused = await pq.waitFor('error', 10_000) as any;
    expect(refused.message).toMatch(/confirm/i);

    // Confirming unlocks exactly that submission.
    sendMsg(playerWs, { type: 'confirm-character' });
    sendMsg(playerWs, { type: 'submit-character', definition: preview.definition });
    const validated = await pq.waitFor('character-validated', 20_000) as any;
    expect(validated.approved).toBe(true);

    // The transcript survives a disconnect and rejoin.
    await closeWs(playerWs);

    const rejoinWs = await connectWs(port);
    const rq = new MessageQueue(rejoinWs);
    sendMsg(rejoinWs, { type: 'rejoin', joinCode: joined.joinCode, sessionToken: roomJoined.sessionToken });
    await rq.waitFor('room-joined', 10_000);
    const replay = await rq.waitFor('interview-replay', 10_000) as any;
    expect(replay.transcript.length).toBeGreaterThanOrEqual(4);
    expect(replay.definition?.name).toBeTruthy();

    await closeWs(rejoinWs);
    await closeWs(hostWs);
  }, 60_000);

  it('refuses a character interview AND a character submission once the game is playing, not only while it is in the lobby', async () => {
    const CHAR = {
      name: 'Vex Ashgrove', backstory: 'Raised by cartographers.',
      personality: 'Curious, stubborn.', highConcept: 'Runaway Star-Cartographer',
      trouble: 'Owes a debt to the Ledger Cult',
      aspects: ['Maps are promises', 'Never look back'],
      skills: { Notice: 3, Lore: 2 }, stunts: ['Dead Reckoning: +2 to Notice.'],
    };

    const { hostWs, hostQ, joined } = await openTable();

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);

    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
    sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
    await pq.waitFor('character-submitted', 10_000);

    sendMsg(hostWs, { type: 'start-game' });
    const phase = await hostQ.waitFor('phase-change', 15_000) as any;
    expect(phase.phase).toBe('playing');

    // The game is running now — an interview message must be refused, where
    // before this task it would have been silently accepted.
    sendMsg(playerWs, { type: 'char-chat', text: 'Can I make another character?' });
    const refused = await pq.waitFor('error', 10_000) as any;
    expect(refused.message).toMatch(/not open/i);

    // submit-character used to check only `phase === 'lobby'`, so a
    // pasted/form-built character (no interview record) could still be
    // submitted mid-game and flow straight to host approval. It must now be
    // refused on the same terms as char-chat above.
    sendMsg(playerWs, { type: 'submit-character', definition: { ...CHAR, name: 'A Second Character' } });
    const submitRefused = await pq.waitFor('error', 10_000) as any;
    expect(submitRefused.message).toMatch(/not open/i);

    sendMsg(hostWs, { type: 'end-game' });
    await hostQ.waitFor('phase-change', 20_000);

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 60_000);

  // This is the property the whole readiness-coercion design exists for: the
  // model can hand back a definition it believes is finished, but a thin one
  // (only `name` filled in) must never reach the client as `definition` —
  // the server re-derives readiness itself and coerces toward "not ready".
  // A test that only checks a NULL-definition reply against a stub that
  // already defaults to null proves passthrough, not coercion — this one
  // uses a stub fixture with a non-null but incomplete definition so a
  // regression (e.g. deleting the readiness check on the ready branch) would
  // actually fail it.
  it('coerces a thin, model-declared-done definition to definition: null plus the real unmet list', async () => {
    const { hostWs, joined } = await openTable();

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);
    await pq.waitFor('world-introduction', 10_000);

    // THIN_SHEET_TRIGGER selects a stub fixture whose definition has only
    // `name` filled in — everything else is empty — while the model's own
    // reply text frames it as if it were satisfied.
    sendMsg(playerWs, { type: 'char-chat', text: 'THIN_SHEET_TRIGGER give me whatever you have so far.' });

    const reply = await pq.waitFor('char-chat-reply', 15_000) as any;
    expect(reply.definition).toBeNull();

    const readiness = await pq.waitFor('character-readiness', 10_000) as any;
    expect(readiness.readiness.ready).toBe(false);
    // `name` is the one field the thin fixture actually filled in — it must
    // NOT appear as unmet. Everything else must.
    expect(readiness.readiness.unmet).not.toContain('name');
    expect(readiness.readiness.unmet).toEqual(
      expect.arrayContaining(['highConcept', 'trouble', 'aspects', 'skills', 'stunts'])
    );

    // And no character-preview should ever have been sent for this turn.
    await expect(pq.waitFor('character-preview', 300)).rejects.toThrow();

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 60_000);

  // The single hole in submit-character's completeness guarantee: the DM's
  // validateCharacter reply carries an entirely unvalidated `modifications`
  // record that gets spread over the definition AFTER both shape and
  // readiness have already passed. A bad model edit here must not reach the
  // pending character — it must be dropped, with the player's own already-
  // validated definition submitted instead.
  it('discards a DM modification that would empty out skills, rather than persisting a hollow character', async () => {
    const { hostWs, hostQ, joined } = await openTable();

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);

    const CHAR = {
      // The stub selects its "bad modifications" fixture off this marker,
      // the same way THIN_SHEET_TRIGGER selects the thin-sheet fixture above.
      name: 'MODIFICATIONS_TRIGGER Vex Ashgrove',
      backstory: 'Raised by cartographers.',
      personality: 'Curious, stubborn.',
      highConcept: 'Runaway Star-Cartographer',
      trouble: 'Owes a debt to the Ledger Cult',
      aspects: ['Maps are promises', 'Never look back'],
      skills: { Notice: 3, Lore: 2 },
      stunts: ['Dead Reckoning: +2 to Notice.'],
    };

    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const review = await hostQ.waitFor('character-pending-review', 20_000) as any;

    // The stub's validation reply proposes modifications: { skills: {} } —
    // merged in unchecked, this would pass shape (skills is still an
    // object) but fail readiness (no skill entries) and produce a live
    // character that cannot roll anything. It must be discarded: the
    // pending character the host sees still carries the player's own
    // validated skills, untouched.
    expect(review.definition.skills).toEqual(CHAR.skills);
    expect(Object.keys(review.definition.skills).length).toBeGreaterThan(0);
    expect(review.definition.name).toBe(CHAR.name);

    sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
    await pq.waitFor('character-submitted', 10_000);

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 60_000);

  // validateCharacterDefinitionShape bounded name/highConcept/trouble/
  // backstory/personality/aspects/stunts but never checked skills at all —
  // not type, not key length, not entry count, not value range — despite it
  // being client-reachable, persisted, and injected into every DM prompt.
  it('refuses a character with a skill rating outside the FATE ladder this game implements', async () => {
    const { hostWs, joined } = await openTable();

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);

    sendMsg(playerWs, {
      type: 'submit-character',
      definition: {
        name: 'Overclocked Vex', backstory: '', personality: '',
        highConcept: 'Runaway Star-Cartographer', trouble: 'Owes a debt',
        aspects: ['Maps are promises', 'Never look back'],
        skills: { Notice: 99 }, // ladder tops out at 8 (Legendary)
        stunts: ['Dead Reckoning: +2 to Notice.'],
      },
    });
    const refused = await pq.waitFor('error', 10_000) as any;
    expect(refused.message).toMatch(/skills/i);

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 30_000);
});
