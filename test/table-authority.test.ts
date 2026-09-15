// test/table-authority.test.ts — persistence half
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFreePort } from './lib/ws-helpers.js';

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

// Task 7, Step 1 + Step 3: windowInterviewHistory is a pure function, so it
// gets a unit test here rather than a socket test in
// table-authority-live-approval.test.ts. It lives in src/server/index.ts
// alongside the WebSocket server, so exercising it still means importing
// that module — but that module's own db.js import reuses the DATA_DIR
// already bound by this file's own beforeAll above (db.js caches a single
// connection at first getDb() call, and that first call already happened
// above), so this shares THIS file's data dir, not another test file's.
// PORT is the one other import-time side effect index.ts has (it calls
// server.listen(PORT) at module scope) — given its own free port so it
// can't collide with anything already bound to the default.
describe('windowInterviewHistory', () => {
  let windowInterviewHistory: (transcript: Array<{ role: string; content: string }>) => Array<{ role: string; content: string }>;
  let indexMod: typeof import('../src/server/index.js');

  beforeAll(async () => {
    process.env.PORT = String(await getFreePort());
    indexMod = await import('../src/server/index.js');
    if (!indexMod.server.listening) {
      await new Promise<void>((r) => indexMod.server.once('listening', () => r()));
    }
    windowInterviewHistory = indexMod.windowInterviewHistory;
  }, 20_000);

  afterAll(async () => {
    await new Promise<void>((r) => indexMod.server.close(() => r()));
  });

  // Mirrors INTERVIEW_HISTORY_WINDOW from src/server/index.ts, which is not
  // exported. A real drift between the two would only make these tests
  // construct a longer-than-necessary transcript — every assertion below is
  // relative to this constant, not a hardcoded length, so it stays correct
  // either way.
  const WINDOW = 40;

  function turns(n: number, roleAt0: 'assistant' | 'user'): Array<{ role: string; content: string }> {
    return Array.from({ length: n }, (_, i) => ({
      role: i === 0 ? roleAt0 : i % 2 === 0 ? 'assistant' : 'user',
      content: i === 0 ? 'INTRO' : `turn-${i}`,
    }));
  }

  it('pins turn 0 at the front of the window when it is the genuine (assistant) world introduction', () => {
    const transcript = turns(WINDOW + 5, 'assistant');
    const result = windowInterviewHistory(transcript);
    expect(result).toHaveLength(WINDOW);
    expect(result[0]).toEqual(transcript[0]);
    expect(result.slice(1)).toEqual(transcript.slice(-(WINDOW - 1)));
  });

  // The role guard this task adds: sendWorldIntroduction can fail (LLM
  // timeout/outage) and send nothing, in which case position 0 is the
  // player's own first real message, not the world introduction —
  // character-creator.ts already guards this client-side (see its
  // interview-replay handler). Before this fix, windowInterviewHistory
  // treated transcript[0] as the introduction unconditionally and would
  // pin this USER turn at the front of every window sent to the model
  // regardless of its role.
  it('does NOT pin turn 0 when it is a user turn, instead of relabeling the player\'s own first message as the world introduction', () => {
    const transcript = turns(WINDOW + 5, 'user');
    const result = windowInterviewHistory(transcript);
    expect(result).toHaveLength(WINDOW - 1);
    expect(result).toEqual(transcript.slice(-(WINDOW - 1)));
    expect(result[0]).not.toEqual(transcript[0]);
  });

  it('returns the transcript unchanged when it is at or under the window', () => {
    const transcript = turns(WINDOW, 'assistant');
    expect(windowInterviewHistory(transcript)).toBe(transcript);
  });
});

