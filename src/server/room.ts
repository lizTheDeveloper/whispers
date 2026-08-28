import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Campaign } from '../shared/types.js';

function generateJoinCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

export function createRoom(
  db: Database.Database,
  opts: { name: string; dmPreset: string; systemId: string; scenarioId?: string; houseRules?: string; hostUserId?: string }
): { campaignId: string; joinCode: string } {
  const id = randomBytes(16).toString('hex');
  let joinCode!: string;
  for (let attempt = 0; attempt < 10; attempt++) {
    joinCode = generateJoinCode();
    try {
      db.prepare(`
        INSERT INTO campaigns (id, join_code, name, dm_preset, scenario_id, system_id, host_user_id, house_rules)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, joinCode, opts.name, opts.dmPreset, opts.scenarioId ?? null, opts.systemId, opts.hostUserId ?? null, opts.houseRules ?? null);
      return { campaignId: id, joinCode };
    } catch (e: unknown) {
      if (e instanceof Error && 'code' in e && (e as any).code === 'SQLITE_CONSTRAINT_UNIQUE') continue;
      throw e;
    }
  }
  throw new Error('Failed to generate unique join code after 10 attempts');
}

export function joinRoom(db: Database.Database, joinCode: string): Campaign | null {
  const row = db.prepare('SELECT * FROM campaigns WHERE join_code = ?').get(joinCode) as any;
  if (!row) return null;
  return {
    id: row.id,
    joinCode: row.join_code,
    name: row.name,
    dmPreset: row.dm_preset,
    scenarioId: row.scenario_id,
    systemId: row.system_id,
    hostUserId: row.host_user_id,
    houseRules: row.house_rules,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
