import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, '..', '..', 'data');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(join(DATA_DIR, 'whispers.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function getDataDir(): string {
  return DATA_DIR;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      join_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      dm_preset TEXT NOT NULL,
      scenario_id TEXT,
      system_id TEXT NOT NULL DEFAULT 'fate-core',
      host_user_id TEXT,
      house_rules TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      player_user_id TEXT,
      definition TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      disposition TEXT,
      alive INTEGER NOT NULL DEFAULT 1,
      location_id TEXT,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      name TEXT NOT NULL,
      description TEXT,
      terrain TEXT,
      connections TEXT,
      coords TEXT,
      visited INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      name TEXT NOT NULL,
      description TEXT,
      properties TEXT,
      holder_id TEXT,
      location_id TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      scene_number INTEGER NOT NULL,
      description TEXT NOT NULL,
      participants TEXT,
      outcome TEXT
    );

    CREATE TABLE IF NOT EXISTS relationships (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      entity_a_id TEXT NOT NULL,
      entity_b_id TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      PRIMARY KEY (campaign_id, entity_a_id, entity_b_id)
    );

    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      scene_number INTEGER NOT NULL,
      transcript TEXT NOT NULL,
      summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      scene_number INTEGER NOT NULL,
      turn_number INTEGER NOT NULL,
      game_state TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS rule_chunks USING fts5(
      system_id,
      source_book,
      section,
      content,
      tokenize='porter'
    );

    CREATE TABLE IF NOT EXISTS campaign_materials (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      filename TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS character_memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id),
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      scene_number INTEGER NOT NULL,
      turn_number INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      emotional_valence REAL NOT NULL DEFAULT 0.0,
      importance REAL NOT NULL DEFAULT 0.5,
      decay_rate REAL NOT NULL DEFAULT 0.05,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_char_memories_char ON character_memories(character_id);
    CREATE INDEX IF NOT EXISTS idx_char_memories_importance ON character_memories(importance DESC);

    CREATE TABLE IF NOT EXISTS campaign_sessions (
      token TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      join_code TEXT NOT NULL,
      player_name TEXT NOT NULL,
      is_host INTEGER NOT NULL DEFAULT 0,
      character_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_campaign ON campaign_sessions(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_join_code ON campaign_sessions(join_code);

    CREATE TABLE IF NOT EXISTS pending_characters (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      join_code TEXT NOT NULL,
      session_token TEXT NOT NULL,
      player_name TEXT NOT NULL,
      definition TEXT NOT NULL,
      ai_feedback TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pending_chars_campaign ON pending_characters(campaign_id);
  `);

  const cols = db.pragma('table_info(campaigns)') as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));
  if (!colNames.has('dm_instructions')) {
    db.exec('ALTER TABLE campaigns ADD COLUMN dm_instructions TEXT');
  }
  if (!colNames.has('dm_custom_prompt')) {
    db.exec('ALTER TABLE campaigns ADD COLUMN dm_custom_prompt TEXT');
  }
  if (!colNames.has('setup_chat')) {
    db.exec('ALTER TABLE campaigns ADD COLUMN setup_chat TEXT');
  }
  if (!colNames.has('phase')) {
    db.exec("ALTER TABLE campaigns ADD COLUMN phase TEXT NOT NULL DEFAULT 'lobby'");
    // Every campaign created before this column existed now reads as 'lobby',
    // which gates char-chat/submit-character behind a world that was already
    // built — locking players out of games mid-flight. dm_instructions being
    // set is this branch's own trigger for advancing out of 'lobby'
    // (advancePhaseIfLobby fires right after it's written), so any pre-
    // existing campaign that already has it is backfilled straight to
    // 'character-creation' instead of being stuck waiting on a DM chat that
    // already happened.
    db.exec("UPDATE campaigns SET phase = 'character-creation' WHERE dm_instructions IS NOT NULL AND phase = 'lobby'");
  }
  if (!colNames.has('host_table_role')) {
    db.exec('ALTER TABLE campaigns ADD COLUMN host_table_role TEXT');
  }
  if (!colNames.has('influences')) {
    db.exec('ALTER TABLE campaigns ADD COLUMN influences TEXT');
  }
  if (!colNames.has('world_seed')) {
    db.exec('ALTER TABLE campaigns ADD COLUMN world_seed TEXT');
  }
  if (!colNames.has('seed_accepted_at')) {
    db.exec('ALTER TABLE campaigns ADD COLUMN seed_accepted_at TEXT');
  }

  const cpCols = db.pragma('table_info(checkpoints)') as Array<{ name: string }>;
  if (!cpCols.some(c => c.name === 'transcript')) {
    db.exec('ALTER TABLE checkpoints ADD COLUMN transcript TEXT');
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
