import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { RoomState } from '../shared/types.js';

export function saveCheckpoint(db: Database.Database, campaignId: string, sceneNumber: number, turnNumber: number, state: RoomState): void {
  db.prepare(`INSERT INTO checkpoints (id, campaign_id, scene_number, turn_number, game_state) VALUES (?, ?, ?, ?, ?)`)
    .run(randomBytes(16).toString('hex'), campaignId, sceneNumber, turnNumber, JSON.stringify(state));
}

export function loadCheckpoint(db: Database.Database, campaignId: string): RoomState | null {
  const row = db.prepare('SELECT game_state FROM checkpoints WHERE campaign_id = ? ORDER BY turn_number DESC LIMIT 1').get(campaignId) as any;
  if (!row) return null;
  return JSON.parse(row.game_state);
}
