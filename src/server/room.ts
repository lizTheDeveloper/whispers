import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Campaign, CharacterDefinition, TableRole } from '../shared/types.js';

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
    dmInstructions: row.dm_instructions ?? null,
    dmCustomPrompt: row.dm_custom_prompt ?? null,
    phase: row.phase ?? 'lobby',
    hostTableRole: row.host_table_role ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CampaignSession {
  token: string;
  campaignId: string;
  joinCode: string;
  playerName: string;
  isHost: boolean; // durable column name; the in-memory equivalent is `isOwner` (ConnectedPlayer.isOwner)
  characterId: string | null;
}

/**
 * Sessions are the durable proof of "who you are in this room". The in-memory
 * socket list cannot carry that across a refresh — a closed socket is removed
 * from the room before the reconnecting page gets a chance to identify itself,
 * so host-ness has to survive in the database or it is lost for good.
 */
export function createSession(
  db: Database.Database,
  opts: { campaignId: string; joinCode: string; playerName: string; isHost: boolean }
): CampaignSession {
  const token = randomBytes(24).toString('hex');
  db.prepare(`
    INSERT INTO campaign_sessions (token, campaign_id, join_code, player_name, is_host)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, opts.campaignId, opts.joinCode, opts.playerName, opts.isHost ? 1 : 0);
  return { token, campaignId: opts.campaignId, joinCode: opts.joinCode, playerName: opts.playerName, isHost: opts.isHost, characterId: null };
}

export function getSession(db: Database.Database, token: string): CampaignSession | null {
  const row = db.prepare('SELECT * FROM campaign_sessions WHERE token = ?').get(token) as any;
  if (!row) return null;
  return {
    token: row.token,
    campaignId: row.campaign_id,
    joinCode: row.join_code,
    playerName: row.player_name,
    isHost: row.is_host === 1,
    characterId: row.character_id ?? null,
  };
}

export function touchSession(db: Database.Database, token: string): void {
  db.prepare("UPDATE campaign_sessions SET last_seen_at = datetime('now') WHERE token = ?").run(token);
}

export function setSessionCharacter(db: Database.Database, token: string, characterId: string): void {
  db.prepare('UPDATE campaign_sessions SET character_id = ? WHERE token = ?').run(characterId, token);
}

export interface PendingCharacterRow {
  id: string;
  campaignId: string;
  joinCode: string;
  sessionToken: string;
  playerName: string;
  definition: CharacterDefinition;
  aiFeedback: string;
}

export function savePendingCharacter(db: Database.Database, row: PendingCharacterRow): void {
  db.prepare(`
    INSERT OR REPLACE INTO pending_characters (id, campaign_id, join_code, session_token, player_name, definition, ai_feedback)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.campaignId, row.joinCode, row.sessionToken, row.playerName, JSON.stringify(row.definition), row.aiFeedback);
}

export function listPendingCharacters(db: Database.Database, campaignId: string): PendingCharacterRow[] {
  const rows = db.prepare('SELECT * FROM pending_characters WHERE campaign_id = ? ORDER BY created_at ASC').all(campaignId) as any[];
  return rows.map(r => ({
    id: r.id,
    campaignId: r.campaign_id,
    joinCode: r.join_code,
    sessionToken: r.session_token,
    playerName: r.player_name,
    definition: JSON.parse(r.definition) as CharacterDefinition,
    aiFeedback: r.ai_feedback,
  }));
}

export function deletePendingCharacter(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM pending_characters WHERE id = ?').run(id);
}

export function saveSetupChat(db: Database.Database, campaignId: string, chat: Array<{ role: string; content: string }>): void {
  db.prepare("UPDATE campaigns SET setup_chat = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(chat), campaignId);
}

export function loadSetupChat(db: Database.Database, campaignId: string): Array<{ role: string; content: string }> {
  const row = db.prepare('SELECT setup_chat FROM campaigns WHERE id = ?').get(campaignId) as any;
  if (!row?.setup_chat) return [];
  try { return JSON.parse(row.setup_chat); } catch { return []; }
}

export function setCampaignPhase(db: Database.Database, campaignId: string, phase: string): void {
  db.prepare("UPDATE campaigns SET phase = ?, updated_at = datetime('now') WHERE id = ?").run(phase, campaignId);
}

/**
 * With no live characters, GameLoop.start() sets initiativeOrder to an empty
 * array, so the per-character turn loop that advances currentTurn and
 * sceneTurnCount never runs — and every safety valve in runScene
 * (roundCount, forceSceneEnd, allowSceneEnd, the session hard limit) is
 * keyed off exactly those counters. Nothing can stop it. start-game must
 * refuse before that loop is ever created.
 */
export function countLiveCharacters(db: Database.Database, campaignId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM characters WHERE campaign_id = ?').get(campaignId) as { c: number };
  return row.c;
}

/**
 * Atomically advances a campaign out of 'lobby' into 'character-creation',
 * but only if it is still in 'lobby' at the moment of the write. Message
 * handlers on a socket are not serialized, so a stale in-handler read of
 * campaign.phase is not safe to gate a write on — two dm-chat calls in
 * flight, or a dm-chat racing a start-game, could otherwise both believe
 * they own the transition, or clobber a later phase with an earlier one.
 * Returns whether this call was the one that actually advanced the phase,
 * so the caller only broadcasts a phase-change once, from the write that
 * really happened.
 */
export function advancePhaseIfLobby(db: Database.Database, campaignId: string): boolean {
  const result = db.prepare(
    "UPDATE campaigns SET phase = 'character-creation', updated_at = datetime('now') WHERE id = ? AND phase = 'lobby'"
  ).run(campaignId);
  return result.changes === 1;
}

/**
 * Atomically advances a campaign out of 'character-creation' into 'playing',
 * but only if it is still in 'character-creation' at the moment of the write.
 * Mirrors advancePhaseIfLobby: a second 'start-game' (e.g. from a stale DM
 * tab that main.ts's "bookmark this chair" flow explicitly invites) must not
 * be allowed to construct a second GameLoop against the same campaign — the
 * old loop's `stopped` flag is per-instance, so an orphaned loop would keep
 * narrating and writing turns/scenes forever with nothing able to stop it.
 * Returns whether this call was the one that actually advanced the phase, so
 * the caller only constructs and starts a GameLoop from the write that
 * really happened.
 */
export function beginPlayIfReady(db: Database.Database, campaignId: string): boolean {
  const result = db.prepare(
    "UPDATE campaigns SET phase = 'playing', updated_at = datetime('now') WHERE id = ? AND phase = 'character-creation'"
  ).run(campaignId);
  return result.changes === 1;
}

export function setHostTableRole(db: Database.Database, campaignId: string, role: TableRole): void {
  db.prepare("UPDATE campaigns SET host_table_role = ?, updated_at = datetime('now') WHERE id = ?")
    .run(role, campaignId);
}

export function getInfluences(db: Database.Database, campaignId: string): string[] {
  const row = db.prepare('SELECT influences FROM campaigns WHERE id = ?').get(campaignId) as any;
  if (!row?.influences) return [];
  try {
    const parsed = JSON.parse(row.influences);
    return Array.isArray(parsed) ? parsed.filter((x: unknown): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

export function setInfluences(db: Database.Database, campaignId: string, list: string[]): void {
  db.prepare("UPDATE campaigns SET influences = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(list), campaignId);
}
