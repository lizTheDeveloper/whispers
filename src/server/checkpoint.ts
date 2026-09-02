import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { RoomState, TranscriptMessage } from '../shared/types.js';

export function saveCheckpoint(db: Database.Database, campaignId: string, sceneNumber: number, turnNumber: number, state: RoomState, transcript?: TranscriptMessage[]): void {
  db.prepare(`INSERT INTO checkpoints (id, campaign_id, scene_number, turn_number, game_state, transcript) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(randomBytes(16).toString('hex'), campaignId, sceneNumber, turnNumber, JSON.stringify(state), transcript ? JSON.stringify(transcript) : null);
}

export interface CheckpointData {
  state: RoomState;
  transcript: TranscriptMessage[] | null;
}

export function loadCheckpoint(db: Database.Database, campaignId: string): CheckpointData | null {
  const row = db.prepare('SELECT game_state, transcript FROM checkpoints WHERE campaign_id = ? ORDER BY turn_number DESC LIMIT 1').get(campaignId) as any;
  if (!row) return null;
  return {
    state: JSON.parse(row.game_state),
    transcript: row.transcript ? JSON.parse(row.transcript) : null,
  };
}
