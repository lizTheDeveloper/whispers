// test/table-authority.test.ts — persistence half
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

