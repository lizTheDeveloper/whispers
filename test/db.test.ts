import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE campaigns (
      id TEXT PRIMARY KEY, join_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      dm_preset TEXT NOT NULL, scenario_id TEXT, system_id TEXT NOT NULL DEFAULT 'fate-core',
      host_user_id TEXT, house_rules TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE characters (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      player_user_id TEXT, definition TEXT NOT NULL, state TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE checkpoints (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      scene_number INTEGER NOT NULL, turn_number INTEGER NOT NULL,
      game_state TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('database schema', () => {
  let db: Database.Database;
  afterEach(() => { db?.close(); });

  it('creates and retrieves a campaign', () => {
    db = createTestDb();
    db.prepare('INSERT INTO campaigns (id, join_code, name, dm_preset) VALUES (?, ?, ?, ?)')
      .run('c1', 'ABC123', 'Test Game', 'chronicler');
    const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get('c1') as any;
    expect(row.name).toBe('Test Game');
    expect(row.join_code).toBe('ABC123');
  });

  it('enforces unique join codes', () => {
    db = createTestDb();
    db.prepare('INSERT INTO campaigns (id, join_code, name, dm_preset) VALUES (?, ?, ?, ?)')
      .run('c1', 'ABC123', 'Game 1', 'chronicler');
    expect(() =>
      db.prepare('INSERT INTO campaigns (id, join_code, name, dm_preset) VALUES (?, ?, ?, ?)')
        .run('c2', 'ABC123', 'Game 2', 'chronicler')
    ).toThrow();
  });

  it('stores and retrieves character JSON', () => {
    db = createTestDb();
    db.prepare('INSERT INTO campaigns (id, join_code, name, dm_preset) VALUES (?, ?, ?, ?)')
      .run('c1', 'ABC123', 'Test', 'chronicler');
    const def = JSON.stringify({ name: 'Sigmund', backstory: 'A thief' });
    const state = JSON.stringify({ stress: 0, whisperTrust: 0.5 });
    db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)')
      .run('ch1', 'c1', def, state);
    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get('ch1') as any;
    expect(JSON.parse(row.definition).name).toBe('Sigmund');
    expect(JSON.parse(row.state).whisperTrust).toBe(0.5);
  });

  it('enforces foreign key from characters to campaigns', () => {
    db = createTestDb();
    expect(() =>
      db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)')
        .run('ch1', 'nonexistent', '{}', '{}')
    ).toThrow();
  });
});
