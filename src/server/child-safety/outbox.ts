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
 * Content is never stored unencrypted: with no token the evidence path fails
 * closed (nothing is persisted, the worker does not start, and an alert goes
 * out). Only tests, or a dev box that sets CHILD_SAFETY_PLAINTEXT_DEV=1, get
 * a clearly marked plaintext mode (key id "plaintext-dev").
 */

export interface EvidenceIdentifier {
  kind: string;
  value: string;
  /** True only when Whispers' own server authenticated it. */
  verified?: boolean;
  /** "participant": anyone other than the flagged sender. */
  role?: 'participant';
}

/** One suppressed flag kept in full, with its own sender — structured, never folded into text. */
export interface SuppressedSample {
  incidentAt: number;
  /** Capped at SAMPLE_CONTENT_CAP; RI hashes what it receives itself. */
  content: string;
  /** Our hash of the full original (RI keeps it as the sender's claim). */
  claimedSha256: string;
  originalLength: number;
  ipAddress: string | null;
  userAgent: string | null;
  gameRef: string | null;
  identifiers: EvidenceIdentifier[];
}

export interface SuppressedBurst {
  /** The exact key that went over its cap, e.g. {kind: 'whispers_seat', value} or {kind: 'ip', value}. */
  key: { kind: string; value: string };
  count: number;
  firstAt: number;
  lastAt: number;
  /** SHA-256 of each suppressed flag after the samples, the first SUPPRESSED_HASH_CAP of them. */
  sha256: string[];
  /** The first SUPPRESSED_SAMPLE_CAP suppressed flags, in full, each with its own sender. */
  samples: SuppressedSample[];
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
  /** Set when the content was capped at INGEST_CONTENT_CAP: the original's hash and length (the original stays in the outbox row). */
  contentTruncated?: { originalSha256: string; originalLength: number };
  isTest?: boolean;
}

export const DEFAULT_INGEST_URL = 'http://raising-intelligences:3000/api/internal/child-safety/evidence';

/** Per suppressed-burst counter: this many flags in full, then this many hashes. */
export const SUPPRESSED_SAMPLE_CAP = 10;
export const SUPPRESSED_HASH_CAP = 200;
/** A sample's content is capped here (its SHA-256 is of the full text). */
export const SAMPLE_CONTENT_CAP = 60_000;
/** RI keeps up to 500,000 characters of content; a larger flag is capped a little under it. */
export const INGEST_CONTENT_CAP = 480_000;
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
      created_at INTEGER NOT NULL,
      -- The full original of a flag capped at INGEST_CONTENT_CAP, sealed, for manual retrieval.
      full_content TEXT,
      -- Set when RI refused the record permanently (a 4xx other than 408/429): no more retries.
      dead_at INTEGER
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
      samples TEXT NOT NULL DEFAULT '[]',
      samples_key_id TEXT NOT NULL DEFAULT 'none',
      PRIMARY KEY (rate_key, window_start)
    );
  `);
}

function keyFor(token: string): { id: string; key: Buffer } {
  const key = createHash('sha256').update(`whispers-child-safety-outbox:${token}`).digest();
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 12), key };
}

/** Plaintext storage only in tests or with an explicit dev opt-in — never by default. */
export function plaintextAllowed(): boolean {
  return !!process.env.VITEST || process.env.NODE_ENV === 'test' || process.env.CHILD_SAFETY_PLAINTEXT_DEV === '1';
}

export class EvidenceKeyMissingError extends Error {
  constructor() { super('CHILD_SAFETY_INGEST_TOKEN is not set: evidence is never stored unencrypted, so the evidence path is off'); this.name = 'EvidenceKeyMissingError'; }
}

function seal(body: unknown, token: string | undefined): { keyId: string; payload: string } {
  const json = JSON.stringify(body);
  if (!token) {
    if (!plaintextAllowed()) throw new EvidenceKeyMissingError();
    return { keyId: 'plaintext-dev', payload: json };
  }
  const { id, key } = keyFor(token);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  return { keyId: id, payload: [iv, cipher.getAuthTag(), ct].map(b => b.toString('base64')).join('.') };
}

function open<T = EvidenceBody>(keyId: string, payload: string, token: string | undefined): T {
  if (keyId === 'plaintext-dev' || keyId === 'none') return JSON.parse(payload);
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
  // A flag over RI's limit would be refused forever: cap it, record the
  // original's hash and length, and keep the original here for retrieval.
  let full: string | null = null;
  if (body.content && body.content.length > INGEST_CONTENT_CAP) {
    full = seal(body.content, token).payload;
    body = { ...body, content: body.content.slice(0, INGEST_CONTENT_CAP), contentTruncated: { originalSha256: createHash('sha256').update(body.content, 'utf8').digest('hex'), originalLength: body.content.length } };
  }
  const { keyId, payload } = seal(body, token);
  const r = db.prepare(`INSERT OR IGNORE INTO child_safety_outbox (external_ref, key_id, payload, next_attempt_at, created_at, full_content) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(body.externalRef, keyId, payload, now, now, full);
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
export function countSuppressed(db: Database.Database, opts: { rateKey: string; windowStart: number; windowEnd: number; identity: KeyIdentity; flag: EvidenceBody; at: number; token?: string }): void {
  const token = opts.token ?? envToken();
  const f = opts.flag;
  const content = f.content ?? '';
  const sha = createHash('sha256').update(content, 'utf8').digest('hex');
  const sample: SuppressedSample = { incidentAt: opts.at, content: content.slice(0, SAMPLE_CONTENT_CAP), claimedSha256: sha, originalLength: content.length, ipAddress: f.ipAddress, userAgent: f.userAgent, gameRef: f.gameRef, identifiers: f.identifiers };
  db.transaction(() => {
    const row = db.prepare('SELECT count, hashes, samples, samples_key_id FROM child_safety_suppressed WHERE rate_key = ? AND window_start = ?').get(opts.rateKey, opts.windowStart) as { count: number; hashes: string; samples: string; samples_key_id: string } | undefined;
    if (!row) {
      const id = seal(opts.identity, token);
      const sm = seal([sample], token);
      db.prepare('INSERT INTO child_safety_suppressed (rate_key, window_start, window_end, key_id, identity, count, first_at, last_at, hashes, samples, samples_key_id) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)')
        .run(opts.rateKey, opts.windowStart, opts.windowEnd, id.keyId, id.payload, opts.at, opts.at, '[]', sm.payload, sm.keyId);
      return;
    }
    const samples = open<SuppressedSample[]>(row.samples_key_id, row.samples, token);
    const hashes = JSON.parse(row.hashes) as string[];
    if (samples.length < SUPPRESSED_SAMPLE_CAP) samples.push(sample);
    else if (hashes.length < SUPPRESSED_HASH_CAP) hashes.push(sha);
    const sm = seal(samples, token);
    db.prepare('UPDATE child_safety_suppressed SET count = count + 1, last_at = MAX(last_at, ?), first_at = MIN(first_at, ?), hashes = ?, samples = ?, samples_key_id = ? WHERE rate_key = ? AND window_start = ?')
      .run(opts.at, opts.at, JSON.stringify(hashes), sm.payload, sm.keyId, opts.rateKey, opts.windowStart);
  })();
}

/** Turn every closed window's counter into one suppressed_burst record in the outbox. */
export function flushSuppressed(db: Database.Database, now: number, token: string | undefined): number {
  const rows = db.prepare('SELECT rate_key, window_start, key_id, identity, count, first_at, last_at, hashes, samples, samples_key_id FROM child_safety_suppressed WHERE window_end <= ?').all(now) as Array<{ rate_key: string; window_start: number; key_id: string; identity: string; count: number; first_at: number; last_at: number; hashes: string; samples: string; samples_key_id: string }>;
  for (const r of rows) {
    db.transaction(() => {
      const id = open<KeyIdentity>(r.key_id, r.identity, token);
      const body: EvidenceBody = {
        source: 'whispers',
        recordKind: 'suppressed_burst',
        suppressedBurst: { key: id.key, count: r.count, firstAt: r.first_at, lastAt: r.last_at, sha256: JSON.parse(r.hashes), samples: open<SuppressedSample[]>(r.samples_key_id, r.samples, token) },
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

export interface DeliveryResult { delivered: number; failed: number; deadLettered: number; pending: number; caseIds: string[] }

/** Where dead-letter alerts go (a Matrix room). Swappable in tests. */
export let deadLetterAlert: (text: string) => Promise<void> = matrixAlert;
export function setDeadLetterAlert(fn: (text: string) => Promise<void>): void { deadLetterAlert = fn; }

/**
 * A Matrix message to the ops room: MATRIX_ALERT_TOKEN (a bot's access
 * token) and MATRIX_ALERT_ROOM (room id), on MATRIX_ALERT_HOMESERVER. Never
 * carries content — only the record's hash ref and the refusal.
 */
async function matrixAlert(text: string): Promise<void> {
  const token = process.env.MATRIX_ALERT_TOKEN;
  const room = process.env.MATRIX_ALERT_ROOM;
  const hs = process.env.MATRIX_ALERT_HOMESERVER || 'https://matrix.multiversegames.ai';
  if (!token || !room) { console.error(`[child-safety] ALERT (no MATRIX_ALERT_TOKEN/ROOM set): ${text}`); return; }
  const txn = `cs-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const res = await fetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${txn}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'm.text', body: text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) console.error(`[child-safety] Matrix alert failed: HTTP ${res.status} — ${text}`);
}

function deadLetter(db: Database.Database, row: { id: number; external_ref: string; attempts: number }, why: string, now: number): void {
  db.prepare('UPDATE child_safety_outbox SET dead_at = ?, attempts = ?, last_error = ? WHERE id = ?').run(now, row.attempts + 1, why.slice(0, 300), row.id);
  const text = `[whispers] child-safety evidence ${row.external_ref.slice(0, 16)} was refused by the vault (${why}) and is dead-lettered — kept in child_safety_outbox (dead_at set), not retried. Fix the cause, then clear dead_at to requeue.`;
  console.error(`[child-safety] ${text}`);
  void deadLetterAlert(text).catch(e => console.error('[child-safety] dead-letter alert failed:', e instanceof Error ? e.message : e));
}

/** One pass: closed burst counters into the outbox, then a page of due records posted. Never throws. */
export async function deliverDue(db: Database.Database, cfg: OutboxConfig, now = Date.now()): Promise<DeliveryResult> {
  const result: DeliveryResult = { delivered: 0, failed: 0, deadLettered: 0, pending: 0, caseIds: [] };
  try { flushSuppressed(db, now, cfg.token ?? envToken()); } catch (e) { console.error('[child-safety] could not flush suppressed-burst counters:', e instanceof Error ? e.message : e); }
  const rows = db.prepare('SELECT id, external_ref, key_id, payload, attempts FROM child_safety_outbox WHERE next_attempt_at <= ? AND dead_at IS NULL ORDER BY id LIMIT ?').all(now, PAGE) as Array<{ id: number; external_ref: string; key_id: string; payload: string; attempts: number }>;
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
      if (!res.ok) {
        // A permanent refusal (4xx other than 408/429) will never succeed by
        // retrying: dead-letter it, keep it, and alert a human.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          deadLetter(db, row, `HTTP ${res.status}`, now);
          result.deadLettered++;
          continue;
        }
        fail(row, `HTTP ${res.status}`);
        continue;
      }
      const json = await res.json().catch(() => ({})) as { caseId?: string };
      db.prepare('DELETE FROM child_safety_outbox WHERE id = ?').run(row.id);
      if (json.caseId) result.caseIds.push(json.caseId);
      console.log(`[child-safety] evidence ${row.external_ref.slice(0, 16)} filed in the vault as case ${json.caseId ?? '(no id)'}`);
      result.delivered++;
    } catch (e) {
      fail(row, e instanceof Error ? e.message : String(e));
    }
  }
  result.pending = (db.prepare('SELECT COUNT(*) AS c FROM child_safety_outbox WHERE dead_at IS NULL').get() as { c: number }).c;
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
  if (!cfg.token && !plaintextAllowed()) {
    // Fail closed: no key, no evidence path (seal() refuses to persist too).
    const text = '[child-safety] CHILD_SAFETY_INGEST_TOKEN is not set — the child-safety evidence path is OFF (evidence is never stored unencrypted). Set the token and restart.';
    console.error(text);
    void deadLetterAlert(text).catch(() => {});
    return () => {};
  }
  if (!cfg.token) console.error('[child-safety] PLAINTEXT DEV MODE: no CHILD_SAFETY_INGEST_TOKEN — evidence is stored unencrypted and cannot be delivered');
  kick = () => { void pass(); };
  const timer = setInterval(() => { void pass(); }, intervalMs);
  timer.unref?.();
  void pass();
  return () => { clearInterval(timer); kick = null; };
}
