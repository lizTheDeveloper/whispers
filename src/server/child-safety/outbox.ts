import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * A durable outbox for the child-safety evidence vault (Raising
 * Intelligences' ingest endpoint, docs/child-safety.md "Other games").
 *
 * enqueueEvidence() is a synchronous SQLite insert, so the game never
 * waits on the network; a worker posts each row and deletes it only on a
 * 2xx. A row is never dropped: RI down, a 5xx, a 4xx, a missing token — the
 * row stays and is retried with backoff (capped at six hours) until it
 * lands. RI is idempotent on externalRef, so a retry after a lost response
 * files nothing twice.
 *
 * Rows are AES-256-GCM encrypted with a key derived from the ingest token,
 * so a pending case is not readable in a database backup without it. With
 * no token configured the row is stored with key id "none" — keeping the
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

export interface EvidenceBody {
  source: string;
  content: string;
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
  isTest?: boolean;
}

export const DEFAULT_INGEST_URL = 'http://raising-intelligences:3000/api/internal/child-safety/evidence';

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
  `);
}

function keyFor(token: string): { id: string; key: Buffer } {
  const key = createHash('sha256').update(`whispers-child-safety-outbox:${token}`).digest();
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 12), key };
}

function seal(body: EvidenceBody, token: string | undefined): { keyId: string; payload: string } {
  const json = JSON.stringify(body);
  if (!token) return { keyId: 'none', payload: json };
  const { id, key } = keyFor(token);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  return { keyId: id, payload: [iv, cipher.getAuthTag(), ct].map(b => b.toString('base64')).join('.') };
}

function open(keyId: string, payload: string, token: string | undefined): EvidenceBody {
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

let kick: (() => void) | null = null;

/** Store a case for delivery. Synchronous; returns false only for a duplicate externalRef. */
export function enqueueEvidence(db: Database.Database, body: EvidenceBody, token: string | undefined = process.env.CHILD_SAFETY_INGEST_TOKEN || undefined, now = Date.now()): boolean {
  const { keyId, payload } = seal(body, token);
  const r = db.prepare(`INSERT OR IGNORE INTO child_safety_outbox (external_ref, key_id, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(body.externalRef, keyId, payload, now, now);
  if (r.changes > 0) kick?.();
  return r.changes > 0;
}

/**
 * Insert or replace a case that is held until `deliverAt` (the rate limit's
 * "N more suppressed" summary, updated as the count grows). Once it has been
 * tried it is left alone.
 */
export function upsertHeldEvidence(db: Database.Database, body: EvidenceBody, deliverAt: number, token: string | undefined = process.env.CHILD_SAFETY_INGEST_TOKEN || undefined, now = Date.now()): void {
  const { keyId, payload } = seal(body, token);
  db.prepare(`INSERT INTO child_safety_outbox (external_ref, key_id, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(external_ref) DO UPDATE SET key_id = excluded.key_id, payload = excluded.payload WHERE child_safety_outbox.attempts = 0`)
    .run(body.externalRef, keyId, payload, deliverAt, now);
}

/** Backoff after `attempts` failures: 30s, 1m, 2m, … capped at 6h. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60 * 1000);
}

export interface DeliveryResult { delivered: number; failed: number; pending: number; caseIds: string[] }

/** One pass: post every due row. Never throws. */
export async function deliverDue(db: Database.Database, cfg: OutboxConfig, now = Date.now()): Promise<DeliveryResult> {
  const rows = db.prepare('SELECT id, external_ref, key_id, payload, attempts FROM child_safety_outbox WHERE next_attempt_at <= ? ORDER BY id LIMIT 50').all(now) as Array<{ id: number; external_ref: string; key_id: string; payload: string; attempts: number }>;
  const result: DeliveryResult = { delivered: 0, failed: 0, pending: 0, caseIds: [] };
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
      if (res.ok) {
        const json = await res.json().catch(() => ({})) as { caseId?: string };
        db.prepare('DELETE FROM child_safety_outbox WHERE id = ?').run(row.id);
        if (json.caseId) result.caseIds.push(json.caseId);
        console.log(`[child-safety] evidence ${row.external_ref.slice(0, 16)} filed in the vault as case ${json.caseId ?? '(no id)'}`);
        result.delivered++;
      } else {
        fail(row, `HTTP ${res.status}`);
      }
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
