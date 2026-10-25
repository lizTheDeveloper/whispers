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
      created_at INTEGER NOT NULL,
      group_ref TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_child_safety_outbox_next ON child_safety_outbox(next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_child_safety_outbox_group ON child_safety_outbox(group_ref);
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

let kick: (() => void) | null = null;

/** Store a case for delivery. Synchronous; returns false only for a duplicate externalRef. */
export function enqueueEvidence(db: Database.Database, body: EvidenceBody, token: string | undefined = process.env.CHILD_SAFETY_INGEST_TOKEN || undefined, now = Date.now()): boolean {
  const { keyId, payload } = seal(body, token);
  const r = db.prepare(`INSERT OR IGNORE INTO child_safety_outbox (external_ref, key_id, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(body.externalRef, keyId, payload, now, now);
  if (r.changes > 0) kick?.();
  return r.changes > 0;
}

/** A flag held back by the rate limit: in full up to the cap, then its hash and time only. */
type HeldMember =
  | { kind: 'full'; content: string; incidentAt: number; ipAddress: string | null; userAgent: string | null; reason: string | null }
  | { kind: 'hash'; sha256: string; incidentAt: number };

/** Per summary case (one per seat or IP and window), this many suppressed flags are kept in full. */
export const HELD_FULL_CAP = 50;
/** Never "due" on its own: a member row goes out with its summary. */
const NEVER = Number.MAX_SAFE_INTEGER;
/** RI keeps at most 100k characters of content; parts stay well under. */
const PART_MAX = 90_000;

/**
 * Hold one suppressed flag. Nothing is overwritten: the summary row (created
 * once, due when the window closes) carries the first suppressed flag's
 * identifiers and context, and every suppressed flag is its own member row
 * linked to it — in full up to HELD_FULL_CAP, then as a SHA-256 and a time.
 * At delivery the summary and its members are sent together.
 */
export function holdSuppressed(db: Database.Database, opts: { summaryRef: string; flag: EvidenceBody; deliverAt: number; token?: string; now?: number }): { held: number; full: boolean } {
  const token = opts.token ?? (process.env.CHILD_SAFETY_INGEST_TOKEN || undefined);
  const now = opts.now ?? Date.now();
  return db.transaction(() => {
    const base = seal({ ...opts.flag, externalRef: opts.summaryRef }, token);
    db.prepare('INSERT OR IGNORE INTO child_safety_outbox (external_ref, key_id, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(opts.summaryRef, base.keyId, base.payload, opts.deliverAt, now);
    const n = (db.prepare('SELECT COUNT(*) AS c FROM child_safety_outbox WHERE group_ref = ?').get(opts.summaryRef) as { c: number }).c;
    const full = n < HELD_FULL_CAP;
    const member: HeldMember = full
      ? { kind: 'full', content: opts.flag.content, incidentAt: opts.flag.incidentAt, ipAddress: opts.flag.ipAddress, userAgent: opts.flag.userAgent, reason: opts.flag.reason ?? null }
      : { kind: 'hash', sha256: createHash('sha256').update(opts.flag.content, 'utf8').digest('hex'), incidentAt: opts.flag.incidentAt };
    const m = seal(member, token);
    db.prepare('INSERT OR IGNORE INTO child_safety_outbox (external_ref, key_id, payload, next_attempt_at, created_at, group_ref) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`${opts.summaryRef}:m:${opts.flag.externalRef}`, m.keyId, m.payload, NEVER, now, opts.summaryRef);
    return { held: n + 1, full };
  })();
}

/** The bodies one held summary goes out as: one case, split into parts only to fit RI's content limit. */
function summaryParts(base: EvidenceBody, members: HeldMember[]): EvidenceBody[] {
  const fullN = members.filter(m => m.kind === 'full').length;
  const hashN = members.length - fullN;
  const header = `[rate limit] ${members.length} safety-floor ${members.length === 1 ? 'flag' : 'flags'} from this sender ${members.length === 1 ? 'was' : 'were'} held back by the per-seat/IP rate limit and are filed together here: ${fullN} in full${hashN ? `, ${hashN} more (over the cap of ${HELD_FULL_CAP} per window) as SHA-256 and time only` : ''}.`;
  const entries = members.map((m, i) => m.kind === 'full'
    ? `### Held flag ${i + 1} — ${new Date(m.incidentAt).toISOString()}${m.ipAddress ? ` — IP ${m.ipAddress}` : ''}${m.userAgent ? ` — UA ${m.userAgent}` : ''}\n${m.content}`
    : `### Held flag ${i + 1} — ${new Date(m.incidentAt).toISOString()} — sha256 ${m.sha256} (content not kept: over the per-window cap)`);
  // A flag longer than a part is split across parts; nothing is cut.
  const step = PART_MAX - 1000;
  const chunks: string[] = [];
  for (const e of entries) for (let i = 0; i < e.length; i += step) chunks.push(i === 0 ? e.slice(0, step) : `(continued) ${e.slice(i, i + step)}`);
  const parts: string[] = [];
  let cur = header;
  for (const c of chunks) {
    if (cur.length + c.length + 2 > PART_MAX) { parts.push(cur); cur = header; }
    cur += `\n\n${c}`;
  }
  parts.push(cur);
  return parts.map((content, k) => ({
    ...base,
    content: parts.length > 1 ? `[part ${k + 1} of ${parts.length}] ${content}` : content,
    reason: `${members.length} held by the rate limit. ${base.reason ?? ''}`,
    externalRef: parts.length > 1 ? `${base.externalRef}:p${k + 1}of${parts.length}` : base.externalRef,
  }));
}

/** Backoff after `attempts` failures: 30s, 1m, 2m, … capped at 6h. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60 * 1000);
}

export interface DeliveryResult { delivered: number; failed: number; pending: number; caseIds: string[] }

/** One pass: post every due row. Never throws. */
export async function deliverDue(db: Database.Database, cfg: OutboxConfig, now = Date.now()): Promise<DeliveryResult> {
  const rows = db.prepare('SELECT id, external_ref, key_id, payload, attempts FROM child_safety_outbox WHERE next_attempt_at <= ? AND group_ref IS NULL ORDER BY id LIMIT 50').all(now) as Array<{ id: number; external_ref: string; key_id: string; payload: string; attempts: number }>;
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
    let bodies: EvidenceBody[];
    try {
      const body = open(row.key_id, row.payload, cfg.token);
      const members = db.prepare('SELECT key_id, payload FROM child_safety_outbox WHERE group_ref = ? ORDER BY id').all(row.external_ref) as Array<{ key_id: string; payload: string }>;
      bodies = members.length > 0 ? summaryParts(body, members.map(m => open<HeldMember>(m.key_id, m.payload, cfg.token))) : [body];
    } catch (e) { fail(row, e instanceof Error ? e.message : String(e)); continue; }
    try {
      const ids: string[] = [];
      let failed: string | null = null;
      for (const body of bodies) {
        const res = await cfg.fetchImpl(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        // A part already filed answers with its existing case (idempotent), so a retry re-sends safely.
        if (!res.ok) { failed = `HTTP ${res.status}`; break; }
        const json = await res.json().catch(() => ({})) as { caseId?: string };
        if (json.caseId) ids.push(json.caseId);
      }
      if (failed) { fail(row, failed); continue; }
      db.prepare('DELETE FROM child_safety_outbox WHERE id = ? OR group_ref = ?').run(row.id, row.external_ref);
      result.caseIds.push(...ids);
      console.log(`[child-safety] evidence ${row.external_ref.slice(0, 16)} filed in the vault as case ${ids.join(', ') || '(no id)'}`);
      result.delivered++;
    } catch (e) {
      fail(row, e instanceof Error ? e.message : String(e));
    }
  }
  result.pending = (db.prepare('SELECT COUNT(*) AS c FROM child_safety_outbox WHERE group_ref IS NULL').get() as { c: number }).c;
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
