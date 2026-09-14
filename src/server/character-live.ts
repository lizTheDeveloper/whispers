import type Database from 'better-sqlite3';
import type { PendingCharacterRow } from './room.js';
import { deletePendingCharacter, setSessionCharacter } from './room.js';
import { getInterviewBySession, setInterviewStatus } from './character-interview.js';

const INITIAL_STATE = JSON.stringify({
  stress: 0, consequences: [], fatePoints: 3,
  inventory: [], xpMilestones: [], whisperTrust: 0.65,
});

/**
 * The ONE path into the `characters` table.
 *
 * Both approval routes call this — the human host's, and the AI DM's when the
 * host is playing rather than running the table. It is a transaction because
 * the insert, the session claim, the interview status and the pending-row
 * delete have to move together: a half-applied approval leaves a character
 * that exists but nobody owns, or a pending row for a character already live.
 *
 * Socket sends stay with the caller — they are not transactional and must not
 * fire before a commit.
 */
export function makeCharacterLive(db: Database.Database, pending: PendingCharacterRow): void {
  db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO characters (id, campaign_id, player_user_id, definition, state) VALUES (?, ?, ?, ?, ?)')
      .run(pending.id, pending.campaignId, null, JSON.stringify(pending.definition), INITIAL_STATE);

    if (pending.sessionToken) {
      setSessionCharacter(db, pending.sessionToken, pending.id);
      const interview = getInterviewBySession(db, pending.campaignId, pending.sessionToken);
      if (interview) setInterviewStatus(db, interview.id, 'live');
    }

    deletePendingCharacter(db, pending.id);
  })();
}
