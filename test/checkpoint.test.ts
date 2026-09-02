import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE campaigns (id TEXT PRIMARY KEY, join_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, dm_preset TEXT NOT NULL, scenario_id TEXT, system_id TEXT NOT NULL DEFAULT 'fate-core', host_user_id TEXT, house_rules TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE checkpoints (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), scene_number INTEGER NOT NULL, turn_number INTEGER NOT NULL, game_state TEXT NOT NULL, transcript TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  db.prepare('INSERT INTO campaigns (id, join_code, name, dm_preset) VALUES (?, ?, ?, ?)').run('c1', 'ABC123', 'Test', 'chronicler');
  return db;
}

describe('checkpoint system', () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('saves and loads a checkpoint', async () => {
    const { saveCheckpoint, loadCheckpoint } = await import('../src/server/checkpoint.js');
    const state = { campaignId: 'c1', joinCode: 'ABC123', phase: 'playing' as const, currentScene: 1, currentTurn: 3, initiativeOrder: ['ch1'], activeCharacterId: 'ch1', awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null };
    saveCheckpoint(db, 'c1', 1, 3, state);
    const loaded = loadCheckpoint(db, 'c1');
    expect(loaded).not.toBeNull();
    expect(loaded!.state.currentTurn).toBe(3);
    expect(loaded!.transcript).toBeNull();
  });

  it('saves and loads checkpoint with transcript', async () => {
    const { saveCheckpoint, loadCheckpoint } = await import('../src/server/checkpoint.js');
    const state = { campaignId: 'c1', joinCode: 'ABC123', phase: 'playing' as const, currentScene: 2, currentTurn: 8, initiativeOrder: ['ch1'], activeCharacterId: 'ch1', awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null };
    const transcript = [
      { role: 'dm' as const, content: 'The scene opens...', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'character' as const, content: 'Kael: I investigate the room', characterId: 'ch1', timestamp: '2026-01-01T00:01:00Z' },
    ];
    saveCheckpoint(db, 'c1', 2, 8, state, transcript);
    const loaded = loadCheckpoint(db, 'c1');
    expect(loaded).not.toBeNull();
    expect(loaded!.state.currentTurn).toBe(8);
    expect(loaded!.transcript).not.toBeNull();
    expect(loaded!.transcript!.length).toBe(2);
    expect(loaded!.transcript![0]!.role).toBe('dm');
  });

  it('loads the most recent checkpoint', async () => {
    const { saveCheckpoint, loadCheckpoint } = await import('../src/server/checkpoint.js');
    const base = { campaignId: 'c1', joinCode: 'ABC123', phase: 'playing' as const, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null };
    saveCheckpoint(db, 'c1', 1, 1, { ...base, currentScene: 1, currentTurn: 1 });
    saveCheckpoint(db, 'c1', 1, 5, { ...base, currentScene: 1, currentTurn: 5 });
    const loaded = loadCheckpoint(db, 'c1');
    expect(loaded!.state.currentTurn).toBe(5);
  });

  it('returns null for campaign with no checkpoints', async () => {
    const { loadCheckpoint } = await import('../src/server/checkpoint.js');
    expect(loadCheckpoint(db, 'c1')).toBeNull();
  });
});
