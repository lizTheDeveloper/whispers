import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../shared/types.js';

export type InterviewStatus = 'open' | 'confirmed' | 'live' | 'revoked';

export interface InterviewTurn { role: string; content: string }

export interface InterviewRecord {
  id: string;
  campaignId: string;
  sessionToken: string;
  transcript: InterviewTurn[];
  definition: CharacterDefinition | null;
  status: InterviewStatus;
}

function parseTranscript(raw: unknown, id: string): InterviewTurn[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is InterviewTurn =>
      Boolean(t) && typeof t === 'object' && typeof t.role === 'string' && typeof t.content === 'string');
  } catch {
    console.warn(`[interview] corrupt transcript JSON for interview ${id}`);
    return [];
  }
}

function rowToRecord(row: any): InterviewRecord {
  let definition: CharacterDefinition | null = null;
  if (row.definition) {
    try { definition = JSON.parse(row.definition); }
    catch { console.warn(`[interview] corrupt definition JSON for interview ${row.id}`); }
  }
  return {
    id: row.id,
    campaignId: row.campaign_id,
    sessionToken: row.session_token,
    transcript: parseTranscript(row.transcript, row.id),
    definition,
    status: row.status,
  };
}

/**
 * One interview per player per campaign, keyed on the durable session token.
 *
 * The transcript lived in process memory until now, so a browser refresh threw
 * away the whole conversation. It is also worth keeping for its own sake: the
 * raw answers say things about a character that the derived sheet does not.
 *
 * This does a read then a conditional write, same shape as appendInterviewTurn
 * below — see that function's docstring for why it is safe here too.
 */
export function getOrCreateInterview(db: Database.Database, campaignId: string, sessionToken: string): InterviewRecord {
  const existing = getInterviewBySession(db, campaignId, sessionToken);
  if (existing) return existing;
  const id = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO character_interviews (id, campaign_id, session_token) VALUES (?, ?, ?)')
    .run(id, campaignId, sessionToken);
  return { id, campaignId, sessionToken, transcript: [], definition: null, status: 'open' };
}

export function getInterviewBySession(db: Database.Database, campaignId: string, sessionToken: string): InterviewRecord | null {
  const row = db.prepare('SELECT * FROM character_interviews WHERE campaign_id = ? AND session_token = ?')
    .get(campaignId, sessionToken) as any;
  return row ? rowToRecord(row) : null;
}

/**
 * Reads the transcript, appends one turn, writes it back — a read-modify-write
 * with no locking around it. That is safe only because better-sqlite3 is fully
 * synchronous and this function never awaits: once called, it runs to
 * completion before Node processes anything else, so no other message handler
 * can interleave a read or write in between. This is a different situation from
 * the races this project already fixed (advancePhaseIfLobby, room.ts;
 * setWorldSeedIfNotAccepted, world-seed.ts) — those had an `await` sitting
 * between the read and the write, which is what let a second call interleave.
 * If this function (or getOrCreateInterview above) ever becomes internally
 * async, or this service ever runs as more than one process against the same
 * database file, that guarantee breaks and this needs real locking.
 */
export function appendInterviewTurn(db: Database.Database, id: string, turn: InterviewTurn): void {
  const row = db.prepare('SELECT transcript FROM character_interviews WHERE id = ?').get(id) as any;
  if (!row) return;
  const transcript = parseTranscript(row.transcript, id);
  transcript.push(turn);
  db.prepare("UPDATE character_interviews SET transcript = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(transcript), id);
}

export function setInterviewDefinition(db: Database.Database, id: string, definition: CharacterDefinition): void {
  db.prepare("UPDATE character_interviews SET definition = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(definition), id);
}

export function setInterviewStatus(db: Database.Database, id: string, status: InterviewStatus): void {
  db.prepare("UPDATE character_interviews SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, id);
}
