import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * A durable outbox for the child-safety evidence vault (Raising
 * Intelligences' ingest endpoint, docs/child-safety.md "Other games").
 *
 * One flag is one structured RI case; one row here is one record. Its
 * identifiers, IP, user agent, seat, game, time and content are separate
 * fields — nothing is ever concatenated into free text, so nothing a player
 * writes can forge attribution. Related records share a groupRef.
 *
 * enqueueEvidence() is a synchronous SQLite insert, so the game never waits
 * on the network; the worker posts due rows a page at a time and deletes a
 * row only on a 2xx (its per-record progress). A row is never dropped: RI
 * down, a 5xx, a 4xx, a missing token — it stays and is retried with backoff
 * (capped at six hours). RI is idempotent on externalRef.
 *
 * Over the per-key rate limit (reporter.ts) no case is created. Instead a
 * structured counter row for that exact key (one seat, or one IP) and window
 * counts the flags, keeps the first and last times and up to 200 SHA-256
 * hashes of the content; when the window closes it becomes one RI
 * "suppressed_burst" record under that key's own identity.
 *
 * Rows are AES-256-GCM encrypted with a key derived from the ingest token.
 * With no token configured a row is stored with key id "none" — keeping the
 * evidence beats losing it — and the worker logs an error every pass.
 */

export interface EvidenceIdentifier {
  kind: string;
  value: string;
  /** True only when Whispers' own server authenticated it. */
  verified?: boolean;
  /** "participant": anyone other than the flagged sender. */
  role?: 'participant';
}

export interface SuppressedBurst {
  /** The exact key that went over its cap, e.g. {kind: 'whispers_seat', value} or {kind: 'ip', value}. */
  key: { kind: string; value: string };
  count: number;
  firstAt: number;
  lastAt: number;
  /** SHA-256 of each suppressed flag's content, the first SUPPRESSED_HASH_CAP of them. */
  sha256: string[];
}

export interface EvidenceBody {
  source: string;
  content?: string;
  context: Array<{ speaker: string; content: string; at?: number | string | null }>;
  categories: string[];
  scores?: Record<string, number>;
  model?: string | null;
  reason?: string | null;
  gameRef: string | null;
  /** The flagged sender's request IP; null when the sender is not known. */
  ipAddress: string | null;
  userAgent: string | null;
  identifiers: EvidenceIdentifier[];
  incidentAt: number;
  externalRef: string;
  groupRef?: string | null;
  recordKind?: 'flag' | 'suppressed_burst';
  suppressedBurst?: SuppressedBurst;
  isTest?: boolean;
}

export const DEFAULT_INGEST_URL = 'http://raising-intelligences:3000/api/internal/child-safety/evidence';

/** Hashes kept per suppressed-burst counter. */
export const SUPPRESSED_HASH_CAP = 200;
/** Rows posted per worker pass. */
export const PAGE = 50;

export function ensureOutboxTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS child_safety_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_ref TEXT NOT NULL UNIQUE,
      key_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_child_safety_outbox_next ON child_safety_outbox(next_attempt_at);
    CREATE TABLE IF NOT EXISTS child_safety_suppressed (
      rate_key TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL,
      key_id TEXT NOT NULL,
      identity TEXT NOT NULL,
      count INTEGER NOT NULL,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      hashes TEXT NOT NULL,
      PRIMARY KEY (rate_key, window_start)
    );
  `);
}

function keyFor(token: string): { id: string; key: Buffer } {
  const key = createHash('sha256').update(`whispers-child-safety-outbox:${token}`).digest();
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 12), key };
}

function seal(body: unknown, token: string | undefined): { keyId: string; payload: string } {
  const json = JSON.stringify(body);
  if (!token) return { keyId: 'none', payload: json };
  const { id, key } = keyFor(token);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  return { keyId: id, payload: [iv, cipher.getAuthTag(), ct].map(b => b.toString('base64')).join('.') };
}

function open<T = EvidenceBody>(keyId: string, payload: string, token: string | undefined): T {
  if (keyId === 'none') return JSON.parse(payload);
  if (!token) throw new Error('no ingest token to decrypt the pending case');
  const { id, key } = keyFor(token);
  if (id !== keyId) throw new Error(`pending case was sealed with key ${keyId}, the current token's key is ${id}`);
  const [iv, tag, ct] = payload.split('.').map(p => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv!);
  decipher.setAuthTag(tag!);
  return JSON.parse(Buffer.concat([decipher.update(ct!), decipher.final()]).toString('utf8'));
}

export interface OutboxConfig {
  url: string;
  token: string | undefined;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

export function outboxConfigFromEnv(): OutboxConfig {
  return {
    url: process.env.CHILD_SAFETY_INGEST_URL || DEFAULT_INGEST_URL,
    token: process.env.CHILD_SAFETY_INGEST_TOKEN || undefined,
    fetchImpl: fetch,
    timeoutMs: 10_000,
  };
}

const envToken = () => process.env.CHILD_SAFETY_INGEST_TOKEN || undefined;
let kick: (() => void) | null = null;

/** Store a case for delivery. Synchronous; returns false only for a duplicate externalRef. */
export function enqueueEvidence(db: Database.Database, body: EvidenceBody, token: string | undefined = envToken(), now = Date.now()): boolean {
  const { keyId, payload } = seal(body, token);
  const r = db.prepare(`INSERT OR IGNORE INTO child_safety_outbox (external_ref, key_id, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(body.externalRef, keyId, payload, now, now);
  if (r.changes > 0) kick?.();
  return r.changes > 0;
}

// ─── Suppressed-burst counters ──────────────────────────────────────────────

/** The over-the-cap key's own identity: what its burst record is filed under. */
export interface KeyIdentity {
  key: { kind: string; value: string };
  gameRef: string | null;
  groupRef: string | null;
  ipAddress: string | null;
  identifiers: EvidenceIdentifier[];
}

/**
 * Count one flag that a key's cap kept from becoming a case: a structured
 * counter per key and window (count, first/last time, up to
 * SUPPRESSED_HASH_CAP hashes). The identity is the key's own, set when the
 * counter is created and never taken from another flag.
 */
export function countSuppressed(db: Database.Database, opts: { rateKey: string; windowStart: number; windowEnd: number; identity: KeyIdentity; contentSha256: string; at: number; token?: string }): void {
  const token = opts.token ?? envToken();
  db.transaction(() => {
    const row = db.prepare('SELECT count, hashes FROM child_safety_suppressed WHERE rate_key = ? AND window_start = ?').get(opts.rateKey, opts.windowStart) as { count: number; hashes: string } | undefined;
    if (!row) {
      const id = seal(opts.identity, token);
      db.prepare('INSERT INTO child_safety_suppressed (rate_key, window_start, window_end, key_id, identity, count, first_at, last_at, hashes) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)')
        .run(opts.rateKey, opts.windowStart, opts.windowEnd, id.keyId, id.payload, opts.at, opts.at, JSON.stringify([opts.contentSha256]));
      return;
    }
    const hashes = JSON.parse(row.hashes) as string[];
    if (hashes.length < SUPPRESSED_HASH_CAP) hashes.push(opts.contentSha256);
    db.prepare('UPDATE child_safety_suppressed SET count = count + 1, last_at = MAX(last_at, ?), first_at = MIN(first_at, ?), hashes = ? WHERE rate_key = ? AND window_start = ?')
      .run(opts.at, opts.at, JSON.stringify(hashes), opts.rateKey, opts.windowStart);
  })();
}

/** Turn every closed window's counter into one suppressed_burst record in the outbox. */
export function flushSuppressed(db: Database.Database, now: number, token: string | undefined): number {
  const rows = db.prepare('SELECT rate_key, window_start, key_id, identity, count, first_at, last_at, hashes FROM child_safety_suppressed WHERE window_end <= ?').all(now) as Array<{ rate_key: string; window_start: number; key_id: string; identity: string; count: number; first_at: number; last_at: number; hashes: string }>;
  for (const r of rows) {
    db.transaction(() => {
      const id = open<KeyIdentity>(r.key_id, r.identity, token);
      const body: EvidenceBody = {
        source: 'whispers',
        recordKind: 'suppressed_burst',
        suppressedBurst: { key: id.key, count: r.count, firstAt: r.first_at, lastAt: r.last_at, sha256: JSON.parse(r.hashes) },
        context: [],
        categories: ['sexual/minors'],
        model: null,
        reason: 'Over the per-key case cap: these flags were counted, not filed as separate cases.',
        gameRef: id.gameRef,
        groupRef: id.groupRef,
        ipAddress: id.ipAddress,
        userAgent: null,
        identifiers: id.identifiers,
        incidentAt: r.first_at,
        externalRef: createHash('sha256').update(`burst\n${r.rate_key}\n${r.window_start}`).digest('hex').slice(0, 40),
      };
      const sealed = seal(body, token);
      db.prepare('INSERT OR IGNORE INTO child_safety_outbox (external_ref, key_id, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)').run(body.externalRef, sealed.keyId, sealed.payload, now, now);
      db.prepare('DELETE FROM child_safety_suppressed WHERE rate_key = ? AND window_start = ?').run(r.rate_key, r.window_start);
    })();
  }
  return rows.length;
}

/** Backoff after `attempts` failures: 30s, 1m, 2m, … capped at 6h. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60 * 1000);
}

export interface DeliveryResult { delivered: number; failed: number; pending: number; caseIds: string[] }

/** One pass: closed burst counters into the outbox, then a page of due records posted. Never throws. */
export async function deliverDue(db: Database.Database, cfg: OutboxConfig, now = Date.now()): Promise<DeliveryResult> {
  const result: DeliveryResult = { delivered: 0, failed: 0, pending: 0, caseIds: [] };
  try { flushSuppressed(db, now, cfg.token ?? envToken()); } catch (e) { console.error('[child-safety] could not flush suppressed-burst counters:', e instanceof Error ? e.message : e); }
  const rows = db.prepare('SELECT id, external_ref, key_id, payload, attempts FROM child_safety_outbox WHERE next_attempt_at <= ? ORDER BY id LIMIT ?').all(now, PAGE) as Array<{ id: number; external_ref: string; key_id: string; payload: string; attempts: number }>;
  const fail = (row: { id: number; attempts: number; external_ref: string }, why: string) => {
    const attempts = row.attempts + 1;
    db.prepare('UPDATE child_safety_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?').run(attempts, now + backoffMs(attempts), why.slice(0, 300), row.id);
    // The external ref is a hash; never the content.
    console.error(`[child-safety] evidence ${row.external_ref.slice(0, 16)} not delivered (attempt ${attempts}): ${why} — kept in the outbox, retrying`);
    result.failed++;
  };
  for (const row of rows) {
    if (!cfg.token) { fail(row, 'CHILD_SAFETY_INGEST_TOKEN is not set'); continue; }
    let body: EvidenceBody;
    try { body = open(row.key_id, row.payload, cfg.token); } catch (e) { fail(row, e instanceof Error ? e.message : String(e)); continue; }
    try {
      const res = await cfg.fetchImpl(cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (!res.ok) { fail(row, `HTTP ${res.status}`); continue; }
      const json = await res.json().catch(() => ({})) as { caseId?: string };
      db.prepare('DELETE FROM child_safety_outbox WHERE id = ?').run(row.id);
      if (json.caseId) result.caseIds.push(json.caseId);
      console.log(`[child-safety] evidence ${row.external_ref.slice(0, 16)} filed in the vault as case ${json.caseId ?? '(no id)'}`);
      result.delivered++;
    } catch (e) {
      fail(row, e instanceof Error ? e.message : String(e));
    }
  }
  result.pending = (db.prepare('SELECT COUNT(*) AS c FROM child_safety_outbox').get() as { c: number }).c;
  return result;
}

/**
 * Run the worker: a pass every `intervalMs`, and one straight away after
 * each enqueue. Returns a stop function.
 */
export function startOutbox(db: Database.Database, cfg: OutboxConfig = outboxConfigFromEnv(), intervalMs = 30_000): () => void {
  let running = false;
  let again = false;
  const pass = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      do { again = false; await deliverDue(db, cfg); } while (again);
    } catch (e) {
      console.error('[child-safety] outbox pass failed:', e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  };
  if (!cfg.token) console.error('[child-safety] CHILD_SAFETY_INGEST_TOKEN is not set — flags are kept in the outbox but cannot be delivered');
  kick = () => { void pass(); };
  const timer = setInterval(() => { void pass(); }, intervalMs);
  timer.unref?.();
  void pass();
  return () => { clearInterval(timer); kick = null; };
}
