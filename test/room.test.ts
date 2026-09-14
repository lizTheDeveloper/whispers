import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { getDb } from '../src/server/db.js';

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
  `);
  return db;
}

describe('room management', () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('createRoom generates a 6-char alphanumeric join code', async () => {
    const { createRoom } = await import('../src/server/room.js');
    const result = createRoom(db, { name: 'Test', dmPreset: 'chronicler', systemId: 'fate-core' });
    expect(result.joinCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(result.campaignId).toBeTruthy();
  });

  it('joinRoom finds a campaign by join code', async () => {
    const { createRoom, joinRoom } = await import('../src/server/room.js');
    const { joinCode } = createRoom(db, { name: 'Test', dmPreset: 'chronicler', systemId: 'fate-core' });
    const campaign = joinRoom(db, joinCode);
    expect(campaign).not.toBeNull();
    expect(campaign!.name).toBe('Test');
  });

  it('joinRoom returns null for invalid code', async () => {
    const { joinRoom } = await import('../src/server/room.js');
    expect(joinRoom(db, 'XXXXXX')).toBeNull();
  });

  it('join codes are unique across campaigns', async () => {
    const { createRoom } = await import('../src/server/room.js');
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const { joinCode } = createRoom(db, { name: `Game ${i}`, dmPreset: 'chronicler', systemId: 'fate-core' });
      codes.add(joinCode);
    }
    expect(codes.size).toBe(20);
  });
});

describe('host table role', () => {
  it('is null on a fresh campaign and survives a round trip once set', async () => {
    const { createRoom, joinRoom, setHostTableRole } = await import('../src/server/room.js');
    const db = getDb();
    const { campaignId, joinCode } = createRoom(db, {
      name: 'Role Test', dmPreset: 'chronicler', systemId: 'fate-core',
    });

    expect(joinRoom(db, joinCode)?.hostTableRole).toBeNull();

    setHostTableRole(db, campaignId, 'player');
    expect(joinRoom(db, joinCode)?.hostTableRole).toBe('player');

    setHostTableRole(db, campaignId, 'dm');
    expect(joinRoom(db, joinCode)?.hostTableRole).toBe('dm');
  });
});
