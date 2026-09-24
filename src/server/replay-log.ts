import type Database from 'better-sqlite3';
import type { ReplayEntry, ServerMessage } from '../shared/protocol.js';

// Rows kept per campaign in the table. A row is one display line; a long
// solo session runs a few hundred. Past this the oldest rows are deleted —
// the LLM transcript has its own compaction, this log is purely for the
// player's eyes and nobody scrolls back that far.
const DB_ROW_LIMIT = 3000;
// Entries shipped in one 'transcript-replay'. The freshest tail of the log;
// anything older is reported via `omitted` so the client can say so honestly
// instead of silently pretending the session started here.
const REPLAY_WINDOW = 600;

/**
 * Append one display entry to the campaign's replay log.
 *
 * `sessionToken` is the viewer-scope tag, not authorship metadata: rows with
 * a token are ONLY replayed to that session, rows with null go to everyone
 * in the room. Two kinds are tagged: 'whisper-echo' — a player's "You
 * whisper:" line is a local render for the sender alone — and
 * 'character-thought' — a character's inner thought and whisper verdict go
 * only to the seat that plays them. A refresh must restore either for that
 * seat and leak nothing to anyone else.
 *
 * seq comes from MAX(seq)+1 inside the same statement; better-sqlite3 is
 * synchronous on one connection, so appends from the game loop and from
 * socket handlers can never interleave mid-statement.
 */
export function appendReplayEntry(
  db: Database.Database,
  campaignId: string,
  entry: ReplayEntry,
  sessionToken: string | null = null,
): void {
  db.prepare(
    `INSERT INTO replay_log (campaign_id, seq, entry, session_token)
     SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ? FROM replay_log WHERE campaign_id = ?`,
  ).run(campaignId, JSON.stringify(entry), sessionToken, campaignId);
  db.prepare(
    `DELETE FROM replay_log
     WHERE campaign_id = ? AND seq <= (SELECT COALESCE(MAX(seq), 0) - ${DB_ROW_LIMIT} FROM replay_log WHERE campaign_id = ?)`,
  ).run(campaignId, campaignId);
}

/**
 * Record a broadcast the game view paints into #narration-log. This is the
 * list of ServerMessage kinds game-view.ts appends log lines for — dice,
 * character actions, narration, resolutions, scene ends — and nothing else.
 * 'whisper-prompt'/'action-proposals' paint the input panels, 'phase-change'
 * is re-sent by the rejoin handler itself, 'character-state-update' updates
 * the status bar; none of them belong in the transcript.
 */
export function recordReplayBroadcast(db: Database.Database, campaignId: string, msg: ServerMessage): void {
  switch (msg.type) {
    case 'narration':
    case 'resolution':
    case 'dice-roll':
    case 'action-taken':
    case 'scene-end':
      appendReplayEntry(db, campaignId, msg);
      break;
  }
}

/**
 * The freshest window of a campaign's replay log, as one viewer sees it:
 * every public row plus that session's own whisper echoes, and nothing
 * belonging to anyone else. `omitted` counts visible rows trimmed out above
 * the window (against this viewer's own visibility, so another player's
 * whispers never count as "missing" here).
 */
export function loadReplayLog(
  db: Database.Database,
  campaignId: string,
  viewerSessionToken: string | null,
): { entries: ReplayEntry[]; omitted: number } {
  const where = viewerSessionToken
    ? 'campaign_id = ? AND (session_token IS NULL OR session_token = ?)'
    : 'campaign_id = ? AND session_token IS NULL';
  const params: Array<string> = viewerSessionToken ? [campaignId, viewerSessionToken] : [campaignId];

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM replay_log WHERE ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT entry FROM replay_log WHERE ${where} ORDER BY seq DESC LIMIT ${REPLAY_WINDOW}`)
    .all(...params) as Array<{ entry: string }>;

  const entries: ReplayEntry[] = [];
  for (const row of rows.reverse()) {
    try {
      const entry = JSON.parse(row.entry) as ReplayEntry;
      // Rows written before thoughts were split out of action-taken carried
      // them publicly. A public row never replays a character's private mind.
      if (entry.type === 'action-taken') {
        delete entry.innerThought;
        delete entry.whisperInfluence;
      }
      // Likewise scene-end rows written before the influence card became
      // owner-only (scene-stats) carried every character's whisper record.
      if (entry.type === 'scene-end') delete entry.whisperStats;
      entries.push(entry);
    } catch {
      // A corrupt row is a missing display line, not a crashed rejoin.
    }
  }
  return { entries, omitted: Math.max(0, total - entries.length) };
}
