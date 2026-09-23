import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { WorldBible } from './world-bible.js';
import type { TranscriptMessage } from '../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, '..', '..', 'data');
// DATA_DIR holds both the image's static content (scenarios/, dm-presets/,
// systems/) and, historically, the live database — which meant mounting a
// volume at DATA_DIR to persist the database would shadow the static
// content shipped in the image. STATE_DIR is a separate, dedicated home for
// the database so it can be volume-mounted without touching DATA_DIR at
// all. Defaulting it to DATA_DIR keeps local dev and the test harness
// working with zero config: STATE_DIR only needs to be set where the two
// must diverge (production).
const STATE_DIR = process.env.STATE_DIR ?? DATA_DIR;

const DB_FILENAME = 'whispers.db';
const DB_SIDECAR_SUFFIXES = ['-wal', '-shm'];
const MIGRATION_STAGING_DIRNAME = '.whispers-db-migration-tmp';

let db: Database.Database | null = null;

/**
 * Boot-time, one-shot migration off the legacy layout (database co-located
 * with static content in DATA_DIR) onto STATE_DIR. This is what carries a
 * production database onto a freshly-mounted volume the first time this
 * code runs there — get it wrong and real campaigns are lost, so every step
 * is ordered to make an interrupted run safe to retry:
 *
 *  1. Never touches anything if a database already exists at STATE_DIR —
 *     that's the signal migration already happened (or STATE_DIR/DATA_DIR
 *     are the same directory and there's nothing to separate).
 *  2. Does nothing if there's no legacy database either — a clean start.
 *  3. Otherwise, COPIES (not moves) the legacy files into a scratch staging
 *     directory under STATE_DIR. The legacy files are untouched by this
 *     step, so a crash here just leaves discardable debris in staging.
 *  4. "Commits" by renaming staged files into their final STATE_DIR paths —
 *     sidecars (-wal, -shm) first, the main .db file LAST. Renames within
 *     one directory are atomic, and `existsSync(newDbPath)` above is what
 *     every caller (including a retried migration) uses to decide whether
 *     migration already happened — so nothing is considered "migrated"
 *     until that final rename of the main .db file lands. A crash at any
 *     point before that leaves the legacy source fully intact and staging
 *     safely re-runnable; a crash after it is a no-op on the next boot.
 *  5. Only once the new database is fully in place does it delete the
 *     legacy files. If that cleanup itself is interrupted, the leftover
 *     legacy files are inert — the guard in step 1 will skip migration on
 *     every subsequent boot.
 */
export function migrateLegacyDatabase(): void {
  const newDbPath = join(STATE_DIR, DB_FILENAME);
  const legacyDbPath = join(DATA_DIR, DB_FILENAME);

  if (STATE_DIR === DATA_DIR) return;

  mkdirSync(STATE_DIR, { recursive: true });

  if (existsSync(newDbPath)) return;
  if (!existsSync(legacyDbPath)) return;

  const suffixesPresent = DB_SIDECAR_SUFFIXES.filter(suffix => existsSync(legacyDbPath + suffix));
  console.log(
    `[db] Legacy database found at ${legacyDbPath} (plus sidecars: ${suffixesPresent.join(', ') || 'none'}). ` +
    `Migrating to ${newDbPath}...`
  );

  const stagingDir = join(STATE_DIR, MIGRATION_STAGING_DIRNAME);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  copyFileSync(legacyDbPath, join(stagingDir, DB_FILENAME));
  for (const suffix of suffixesPresent) {
    copyFileSync(legacyDbPath + suffix, join(stagingDir, DB_FILENAME + suffix));
  }

  for (const suffix of suffixesPresent) {
    renameSync(join(stagingDir, DB_FILENAME + suffix), newDbPath + suffix);
  }
  renameSync(join(stagingDir, DB_FILENAME), newDbPath);

  rmSync(stagingDir, { recursive: true, force: true });

  rmSync(legacyDbPath, { force: true });
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    rmSync(legacyDbPath + suffix, { force: true });
  }

  console.log(`[db] Migration complete — database now lives at ${newDbPath}.`);
}

export function getDb(): Database.Database {
  if (db) return db;
  migrateLegacyDatabase();
  mkdirSync(STATE_DIR, { recursive: true });
  db = new Database(join(STATE_DIR, DB_FILENAME));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function getDataDir(): string {
  return DATA_DIR;
}

export function getStateDir(): string {
  return STATE_DIR;
}

/** Exported for tests: runs every schema migration against `db`. Idempotent. */
export function migrate(db: Database.Database): void {
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

    CREATE TABLE IF NOT EXISTS character_interviews (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      session_token TEXT NOT NULL,
      transcript TEXT NOT NULL DEFAULT '[]',
      definition TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_interview_session ON character_interviews(campaign_id, session_token);

    CREATE TABLE IF NOT EXISTS replay_log (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      seq INTEGER NOT NULL,
      entry TEXT NOT NULL,
      session_token TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (campaign_id, seq)
    );
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
  // Pause state lives on the campaign row, not just in the GameLoop, so it
  // survives the loop: a refreshed tab, a torn-down room and a server restart
  // all read it back from here. NULL paused_at means not paused.
  if (!colNames.has('paused_at')) {
    db.exec('ALTER TABLE campaigns ADD COLUMN paused_at TEXT');
  }
  if (!colNames.has('paused_reason')) {
    db.exec('ALTER TABLE campaigns ADD COLUMN paused_reason TEXT');
  }

  const cpCols = db.pragma('table_info(checkpoints)') as Array<{ name: string }>;
  if (!cpCols.some(c => c.name === 'transcript')) {
    db.exec('ALTER TABLE checkpoints ADD COLUMN transcript TEXT');
  }

  const charCols = db.pragma('table_info(characters)') as Array<{ name: string }>;
  if (!charCols.some(c => c.name === 'revoked_at')) {
    db.exec('ALTER TABLE characters ADD COLUMN revoked_at TEXT');
  }

  migratePartyKnowledge(db);
}

/**
 * Party knowledge: which NPCs, places and items the story has revealed to the
 * characters (see WorldBible.getPlayerKnowledge). Two one-time steps, each
 * keyed on its column not existing yet, so a later boot never re-runs them:
 *
 *  - entities.motivation: seeding used to append "[Motivation: …]" to the
 *    description, which leaked into character prompts. Existing rows have it
 *    parsed back out into its own column.
 *
 *  - known_to_party on entities/locations/items: new games start at 0 and
 *    the story marks rows as it reveals them. A game already mid-play would
 *    lose all its world knowledge at once if every row just defaulted to 0,
 *    so for campaigns in 'playing' this backfills from what the table has
 *    actually seen: visited locations, plus anything named in the saved
 *    story text — the latest checkpoint's transcript and every stored scene's
 *    transcript and summary — with whisper lines removed, since a whisper is
 *    private to one character. It deliberately does not try to reconstruct
 *    more than that (e.g. compacted-away turns that survive only in a recap);
 *    a thing the table saw but nobody has named since can be re-revealed by
 *    the DM naming it again. Campaigns not yet playing start from nothing,
 *    exactly like a fresh seed.
 */
function migratePartyKnowledge(db: Database.Database): void {
  const cols = (table: string) => new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name));

  if (!cols('entities').has('motivation')) {
    db.exec('ALTER TABLE entities ADD COLUMN motivation TEXT');
    const rows = db.prepare("SELECT id, description FROM entities WHERE description LIKE '%[Motivation:%'").all() as Array<{ id: string; description: string }>;
    const update = db.prepare('UPDATE entities SET description = ?, motivation = ? WHERE id = ?');
    for (const row of rows) {
      const m = row.description.match(/^([\s\S]*?)\s*\[Motivation:\s*([\s\S]*?)\]\s*$/);
      if (m) update.run(m[1]!.trim() || null, m[2]!.trim() || null, row.id);
    }
  }

  let added = false;
  for (const table of ['entities', 'locations', 'items']) {
    if (!cols(table).has('known_to_party')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN known_to_party INTEGER NOT NULL DEFAULT 0`);
      added = true;
    }
  }
  if (!added) return;

  const playing = db.prepare("SELECT id FROM campaigns WHERE phase = 'playing'").all() as Array<{ id: string }>;
  if (playing.length === 0) return;
  const worldBible = new WorldBible(db);
  const storyText = (json: string | null): string => {
    if (!json) return '';
    try {
      const messages = JSON.parse(json) as TranscriptMessage[];
      return Array.isArray(messages) ? messages.filter(m => m && m.role !== 'whisper').map(m => m.content).join('\n') : '';
    } catch { return ''; }
  };
  for (const { id } of playing) {
    db.prepare('UPDATE locations SET known_to_party = 1 WHERE campaign_id = ? AND visited = 1').run(id);
    const checkpoint = db.prepare('SELECT transcript FROM checkpoints WHERE campaign_id = ? ORDER BY scene_number DESC, turn_number DESC, created_at DESC LIMIT 1').get(id) as { transcript: string | null } | undefined;
    const scenes = db.prepare('SELECT transcript, summary FROM scenes WHERE campaign_id = ?').all(id) as Array<{ transcript: string; summary: string | null }>;
    const text = [
      storyText(checkpoint?.transcript ?? null),
      ...scenes.map(sc => `${storyText(sc.transcript)}\n${sc.summary ?? ''}`),
    ].join('\n');
    worldBible.revealMentioned(id, text);
  }
  console.log(`[db] Party knowledge backfilled for ${playing.length} campaign(s) in play.`);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
