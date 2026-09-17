import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR/DATA_DIR are read once at module load time (same pattern as
// PORT/DATA_DIR elsewhere in this server — see db.ts, index.ts). To test
// several different STATE_DIR/DATA_DIR combinations we have to force a
// fresh module evaluation for each one via vi.resetModules() before every
// dynamic import.
async function freshDbModule() {
  vi.resetModules();
  return import('../src/server/db.js');
}

describe('legacy database migration (DATA_DIR -> STATE_DIR)', () => {
  let dataDir: string;
  let stateDir: string;
  let prevDataDir: string | undefined;
  let prevStateDir: string | undefined;

  function setup() {
    dataDir = mkdtempSync(join(tmpdir(), 'whispers-legacy-'));
    stateDir = mkdtempSync(join(tmpdir(), 'whispers-state-'));
    prevDataDir = process.env.DATA_DIR;
    prevStateDir = process.env.STATE_DIR;
    process.env.DATA_DIR = dataDir;
    process.env.STATE_DIR = stateDir;
  }

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    if (prevStateDir === undefined) delete process.env.STATE_DIR;
    else process.env.STATE_DIR = prevStateDir;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('moves a real database plus its uncheckpointed WAL data, with nothing lost', async () => {
    setup();

    // Build a genuine SQLite fixture that mirrors production's actual
    // shape: a tiny main file with the real data sitting mostly in the WAL
    // (production's live whispers.db was 4KB next to a 449KB WAL). We
    // never call fixtureDb.close() — SQLite auto-checkpoints the WAL into
    // the main file when the last connection to it closes, which would
    // defeat the point of this fixture. Leaving it open (an open fd on a
    // file we're about to copy/rename/delete out from under it) is exactly
    // what a killed container leaves behind, and is safe on POSIX: the fd
    // keeps the original data alive independently of the new copies.
    const legacyDbPath = join(dataDir, 'whispers.db');
    const fixtureDb = new Database(legacyDbPath);
    fixtureDb.pragma('journal_mode = WAL');
    fixtureDb.pragma('wal_autocheckpoint = 0');
    fixtureDb.exec('CREATE TABLE campaigns (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
    fixtureDb.prepare('INSERT INTO campaigns (id, name) VALUES (?, ?)').run('c1', 'Real Campaign In The WAL');
    expect(existsSync(legacyDbPath + '-wal')).toBe(true);

    const { getDb, closeDb } = await freshDbModule();
    const migrated = getDb();
    const row = migrated.prepare('SELECT name FROM campaigns WHERE id = ?').get('c1') as { name: string } | undefined;
    expect(row?.name).toBe('Real Campaign In The WAL');
    closeDb();
    fixtureDb.close();

    expect(existsSync(join(stateDir, 'whispers.db'))).toBe(true);
    expect(existsSync(legacyDbPath)).toBe(false);
    expect(existsSync(legacyDbPath + '-wal')).toBe(false);
    expect(existsSync(legacyDbPath + '-shm')).toBe(false);
  });

  it('does not clobber an existing STATE_DIR database when a legacy one also exists', async () => {
    setup();
    writeFileSync(join(dataDir, 'whispers.db'), 'LEGACY-BYTES-MUST-NOT-WIN');
    writeFileSync(join(stateDir, 'whispers.db'), 'ALREADY-MIGRATED-REAL-DATA');

    const { migrateLegacyDatabase } = await freshDbModule();
    migrateLegacyDatabase();

    expect(readFileSync(join(stateDir, 'whispers.db'), 'utf-8')).toBe('ALREADY-MIGRATED-REAL-DATA');
    expect(readFileSync(join(dataDir, 'whispers.db'), 'utf-8')).toBe('LEGACY-BYTES-MUST-NOT-WIN');
  });

  it('starts clean with no database anywhere', async () => {
    setup();
    const { getDb, closeDb } = await freshDbModule();
    expect(() => getDb()).not.toThrow();
    closeDb();
    expect(existsSync(join(stateDir, 'whispers.db'))).toBe(true);
    expect(existsSync(join(dataDir, 'whispers.db'))).toBe(false);
  });

  it('converges when a previous attempt crashed mid-copy, leaving stale staging debris', async () => {
    setup();
    writeFileSync(join(dataDir, 'whispers.db'), 'MAIN-DB-BYTES');
    writeFileSync(join(dataDir, 'whispers.db-wal'), 'WAL-BYTES');
    writeFileSync(join(dataDir, 'whispers.db-shm'), 'SHM-BYTES');

    const stagingDir = join(stateDir, '.whispers-db-migration-tmp');
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, 'whispers.db'), 'GARBAGE-FROM-ABORTED-ATTEMPT');
    writeFileSync(join(stagingDir, 'whispers.db-wal'), 'GARBAGE-WAL');

    const { migrateLegacyDatabase } = await freshDbModule();
    migrateLegacyDatabase();

    expect(readFileSync(join(stateDir, 'whispers.db'), 'utf-8')).toBe('MAIN-DB-BYTES');
    expect(readFileSync(join(stateDir, 'whispers.db-wal'), 'utf-8')).toBe('WAL-BYTES');
    expect(existsSync(join(dataDir, 'whispers.db'))).toBe(false);
    expect(existsSync(stagingDir)).toBe(false);
  });

  it('converges when an earlier attempt committed sidecars but crashed before the main db file landed', async () => {
    setup();
    writeFileSync(join(dataDir, 'whispers.db'), 'MAIN-DB-BYTES');
    writeFileSync(join(dataDir, 'whispers.db-wal'), 'WAL-BYTES');
    writeFileSync(join(dataDir, 'whispers.db-shm'), 'SHM-BYTES');

    // Simulate the exact interruption window the design's ordering is
    // meant to make safe: sidecars already landed at STATE_DIR, but the
    // main .db file (what existsSync() gates on) never did — so per the
    // migration's own guarantee, the legacy source must still be fully
    // intact, and this stale partial commit must be safely overwritable.
    writeFileSync(join(stateDir, 'whispers.db-wal'), 'STALE-PARTIAL-COMMIT-WAL');
    writeFileSync(join(stateDir, 'whispers.db-shm'), 'STALE-PARTIAL-COMMIT-SHM');

    const { migrateLegacyDatabase } = await freshDbModule();
    migrateLegacyDatabase();

    expect(readFileSync(join(stateDir, 'whispers.db'), 'utf-8')).toBe('MAIN-DB-BYTES');
    expect(readFileSync(join(stateDir, 'whispers.db-wal'), 'utf-8')).toBe('WAL-BYTES');
    expect(readFileSync(join(stateDir, 'whispers.db-shm'), 'utf-8')).toBe('SHM-BYTES');
    expect(existsSync(join(dataDir, 'whispers.db'))).toBe(false);
  });

  it('is a no-op when STATE_DIR is not configured (defaults to DATA_DIR)', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'whispers-legacy-'));
    stateDir = dataDir; // afterEach removes both; keep equal so cleanup only removes once
    prevDataDir = process.env.DATA_DIR;
    prevStateDir = process.env.STATE_DIR;
    process.env.DATA_DIR = dataDir;
    delete process.env.STATE_DIR;

    writeFileSync(join(dataDir, 'whispers.db'), 'MAIN-DB-BYTES');

    const { migrateLegacyDatabase, getStateDir, getDataDir } = await freshDbModule();
    expect(getStateDir()).toBe(dataDir);
    expect(getDataDir()).toBe(dataDir);

    migrateLegacyDatabase();

    expect(readFileSync(join(dataDir, 'whispers.db'), 'utf-8')).toBe('MAIN-DB-BYTES');
  });
});
