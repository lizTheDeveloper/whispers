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
  /**
   * The sheet so far — every field the player has stated, merged turn by
   * turn. Unlike `definition` it may be unfinished; it is what the checklist
   * and the interviewer's "still needed" list are computed from.
   */
  draft: CharacterDefinition | null;
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

function parseDefinition(raw: unknown, id: string, column: string): CharacterDefinition | null {
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw); }
  catch { console.warn(`[interview] corrupt ${column} JSON for interview ${id}`); return null; }
}

function rowToRecord(row: any): InterviewRecord {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    sessionToken: row.session_token,
    transcript: parseTranscript(row.transcript, row.id),
    definition: parseDefinition(row.definition, row.id, 'definition'),
    draft: parseDefinition(row.draft, row.id, 'draft'),
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
  return { id, campaignId, sessionToken, transcript: [], definition: null, draft: null, status: 'open' };
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

/**
 * Every call here means "the interview just derived a (possibly new) sheet" —
 * so it always resets status back to 'open'. Without this, confirming once
 * would stay confirmed forever: a player can keep talking after confirming
 * (they are allowed to change their mind), the model derives a different
 * ready sheet, and that new sheet must require its own confirmation rather
 * than silently inheriting the old confirmation.
 */
export function setInterviewDefinition(db: Database.Database, id: string, definition: CharacterDefinition): void {
  db.prepare("UPDATE character_interviews SET definition = ?, status = 'open', updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(definition), id);
}

export function setInterviewDraft(db: Database.Database, id: string, draft: CharacterDefinition): void {
  db.prepare("UPDATE character_interviews SET draft = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(draft), id);
}

/** The sheet as it stands: the running draft, else the last finished sheet. */
export function interviewSheet(interview: InterviewRecord | null): CharacterDefinition | null {
  return interview?.draft ?? interview?.definition ?? null;
}

const hasText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * Fold one interview turn's reported sheet into the draft so far. The model
 * reports the whole sheet as it understands it, so a field it filled in
 * replaces the old value and a field it left empty keeps it — a stated name
 * is never lost because a later reply only asked a question.
 */
export function mergeCharacterDraft(base: Partial<CharacterDefinition> | null, update: Partial<CharacterDefinition> | null): CharacterDefinition {
  const b = base ?? {};
  const u = update ?? {};
  const text = (k: 'name' | 'highConcept' | 'trouble' | 'personality' | 'backstory') =>
    hasText(u[k]) ? u[k]!.trim() : (hasText(b[k]) ? b[k]! : '');
  const list = (k: 'aspects' | 'stunts') => {
    const next = Array.isArray(u[k]) ? u[k]!.filter(hasText) : [];
    return next.length > 0 ? next : (Array.isArray(b[k]) ? b[k]! : []);
  };
  const skills = u.skills && Object.keys(u.skills).length > 0 ? u.skills : (b.skills ?? {});
  const merged: CharacterDefinition = {
    name: text('name'),
    highConcept: text('highConcept'),
    trouble: text('trouble'),
    aspects: list('aspects'),
    personality: text('personality'),
    backstory: text('backstory'),
    skills,
    stunts: list('stunts'),
  };
  const age = u.age ?? b.age;
  if (age !== undefined) merged.age = age;
  const pronouns = u.pronouns ?? b.pronouns;
  if (pronouns !== undefined) merged.pronouns = pronouns;
  const relationships = u.relationships && u.relationships.length > 0 ? u.relationships : b.relationships;
  if (relationships && relationships.length > 0) merged.relationships = relationships;
  return merged;
}

export function setInterviewStatus(db: Database.Database, id: string, status: InterviewStatus): void {
  db.prepare("UPDATE character_interviews SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, id);
}

/**
 * Everyone already at this table, as the interviewer needs them: characters
 * in play, characters waiting on approval, and sheets other players are
 * still shaping in their own interviews. Each player is interviewed alone,
 * so without this a mother and her son could be built in parallel with
 * neither interview knowing the other exists. Excludes the asking session's
 * own sheet; deduped by name, first source wins.
 */
export function listTableCharacters(db: Database.Database, campaignId: string, excludeSessionToken: string): Array<{ name: string; highConcept: string }> {
  const out: Array<{ name: string; highConcept: string }> = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== 'string' || !raw) return;
    let def: Partial<CharacterDefinition>;
    try { def = JSON.parse(raw); } catch { return; }
    const name = typeof def?.name === 'string' ? def.name.trim() : '';
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    out.push({ name, highConcept: typeof def.highConcept === 'string' ? def.highConcept.trim() : '' });
  };
  const ownCharacter = db.prepare('SELECT character_id FROM campaign_sessions WHERE token = ?').get(excludeSessionToken) as { character_id: string | null } | undefined;
  for (const row of db.prepare('SELECT id, definition FROM characters WHERE campaign_id = ? AND revoked_at IS NULL ORDER BY created_at').all(campaignId) as Array<{ id: string; definition: string }>) {
    if (row.id === ownCharacter?.character_id) continue;
    add(row.definition);
  }
  for (const row of db.prepare('SELECT definition FROM pending_characters WHERE campaign_id = ? AND session_token != ? ORDER BY created_at').all(campaignId, excludeSessionToken) as Array<{ definition: string }>) {
    add(row.definition);
  }
  for (const row of db.prepare("SELECT definition FROM character_interviews WHERE campaign_id = ? AND session_token != ? AND definition IS NOT NULL AND status != 'revoked' ORDER BY created_at").all(campaignId, excludeSessionToken) as Array<{ definition: string }>) {
    add(row.definition);
  }
  return out;
}
