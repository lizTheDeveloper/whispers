import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * A durable outbox for the child-safety evidence vault (Raising
 * Intelligences' ingest endpoint, docs/child-safety.md "Other games").
 *
 * enqueueEvidence() is a synchronous SQLite insert, so the game never
 * waits on the network; a worker posts each row and deletes it only once
 * every part of it is filed. A row is never dropped: RI down, a 5xx, a 4xx,
 * a missing token — the row stays and is retried with backoff (capped at six
 * hours). RI is idempotent on externalRef, and each row records how many of
 * its parts are already filed, so a retry never resends a filed part.
 *
 * A case longer than RI keeps (100k characters of content) goes as several
 * linked parts; nothing is cut.
 *
 * Rate-limited flags (reporter.ts) are held, not dropped: one summary row per
 * sender (seat + IP) and window, due when the window closes, and one member
 * row per held flag carrying that flag's OWN identifiers, IP, user agent and
 * game — in full for the first HELD_FULL_CAP, then as a SHA-256 and time for
 * the next HELD_HASH_CAP, then only a count with first/last times on the
 * summary row. Members are read in pages at delivery and filed together as
 * the summary case's parts, each member's sender listed with it.
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

/** Per summary: this many held flags in full, then this many as hash + time, then a count. */
export const HELD_FULL_CAP = 50;
export const HELD_HASH_CAP = 200;
/** RI keeps at most 100k characters of content; parts stay well under. */
export const PART_MAX = 90_000;
/** Parts filed per row per worker pass; the rest wait for the next pass. */
export const PARTS_PER_PASS = 10;
/** Members read per page at delivery. */
const MEMBER_PAGE = 25;
/** Never "due" on its own: a member row goes out with its summary. */
const NEVER = Number.MAX_SAFE_INTEGER;

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
      group_ref TEXT,
      member_kind TEXT,
      parts_done INTEGER NOT NULL DEFAULT 0,
      suppressed_count INTEGER NOT NULL DEFAULT 0,
      first_suppressed_at INTEGER,
      last_suppressed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_child_safety_outbox_next ON child_safety_outbox(next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_child_safety_outbox_group ON child_safety_outbox(group_ref, id);
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

// ─── Held (rate-limited) flags ──────────────────────────────────────────────

interface SenderInfo { gameRef: string | null; ipAddress: string | null; userAgent: string | null; identifiers: EvidenceIdentifier[] }
/** A held flag: its own sender and game, in full or as hash + time. */
type HeldMember =
  | ({ kind: 'full'; content: string; incidentAt: number; reason: string | null } & SenderInfo)
  | ({ kind: 'hash'; sha256: string; incidentAt: number } & SenderInfo);

export type HoldResult = 'full' | 'hash' | 'counted';

/**
 * Hold one rate-limited flag under `summaryRef` (one per sender — seat + IP —
 * and window). Never overwrites: the summary row is created once; each flag
 * adds its own member row until the caps, then only bumps the summary's count.
 */
export function holdSuppressed(db: Database.Database, opts: { summaryRef: string; flag: EvidenceBody; deliverAt: number; token?: string; now?: number }): HoldResult {
  const token = opts.token ?? envToken();
  const now = opts.now ?? Date.now();
  const f = opts.flag;
  return db.transaction((): HoldResult => {
    const base = seal({ ...f, externalRef: opts.summaryRef }, token);
    db.prepare('INSERT OR IGNORE INTO child_safety_outbox (external_ref, key_id, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(opts.summaryRef, base.keyId, base.payload, opts.deliverAt, now);
    const counts = db.prepare("SELECT SUM(member_kind = 'full') AS full, SUM(member_kind = 'hash') AS hash FROM child_safety_outbox WHERE group_ref = ?").get(opts.summaryRef) as { full: number | null; hash: number | null };
    const sender: SenderInfo = { gameRef: f.gameRef, ipAddress: f.ipAddress, userAgent: f.userAgent, identifiers: f.identifiers };
    let member: HeldMember | null = null;
    if ((counts.full ?? 0) < HELD_FULL_CAP) member = { kind: 'full', content: f.content, incidentAt: f.incidentAt, reason: f.reason ?? null, ...sender };
    else if ((counts.hash ?? 0) < HELD_HASH_CAP) member = { kind: 'hash', sha256: createHash('sha256').update(f.content, 'utf8').digest('hex'), incidentAt: f.incidentAt, ...sender };
    if (!member) {
      db.prepare('UPDATE child_safety_outbox SET suppressed_count = suppressed_count + 1, first_suppressed_at = COALESCE(first_suppressed_at, ?), last_suppressed_at = ? WHERE external_ref = ?')
        .run(f.incidentAt, f.incidentAt, opts.summaryRef);
      return 'counted';
    }
    const m = seal(member, token);
    db.prepare('INSERT OR IGNORE INTO child_safety_outbox (external_ref, key_id, payload, next_attempt_at, created_at, group_ref, member_kind) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`${opts.summaryRef}:m:${f.externalRef}`, m.keyId, m.payload, NEVER, now, opts.summaryRef, member.kind);
    return member.kind;
  })();
}

function describeSender(m: SenderInfo): string {
  const ids = m.identifiers.filter(i => !i.role).map(i => `${i.kind}=${i.value}${i.verified ? ' (verified)' : ' (claimed, unverified)'}`);
  return `sender: ${ids.join(', ') || 'unknown'}; IP ${m.ipAddress ?? 'unknown'}; UA ${m.userAgent ?? 'unknown'}; game ${m.gameRef ?? 'unknown'}`;
}

/** A summary case's text, generated page by page from its members (never all in memory). */
function* summaryChunks(db: Database.Database, ref: string, token: string | undefined): Generator<string> {
  const step = PART_MAX - 2000;
  let lastId = 0;
  let n = 0;
  for (;;) {
    const page = db.prepare('SELECT id, key_id, payload FROM child_safety_outbox WHERE group_ref = ? AND id > ? ORDER BY id LIMIT ?').all(ref, lastId, MEMBER_PAGE) as Array<{ id: number; key_id: string; payload: string }>;
    if (page.length === 0) return;
    for (const row of page) {
      lastId = row.id;
      n++;
      const m = open<HeldMember>(row.key_id, row.payload, token);
      const head = `### Held flag ${n} — ${new Date(m.incidentAt).toISOString()} — ${describeSender(m)}`;
      const text = m.kind === 'full' ? `${head}\n${m.content}` : `${head}\nsha256 ${m.sha256} (content not kept: over the per-window cap of ${HELD_FULL_CAP} in full)`;
      for (let i = 0; i < text.length; i += step) yield i === 0 ? text.slice(0, step) : `(held flag ${n}, continued) ${text.slice(i, i + step)}`;
    }
  }
}

interface OutboxRow { id: number; external_ref: string; key_id: string; payload: string; attempts: number; parts_done: number; suppressed_count: number; first_suppressed_at: number | null; last_suppressed_at: number | null }

/** The parts of one outbox row, in order, lazily; `last` marks the final one. */
function* partsOf(db: Database.Database, row: OutboxRow, token: string | undefined): Generator<{ body: EvidenceBody; last: boolean }> {
  const base = open(row.key_id, row.payload, token);
  const c = db.prepare("SELECT SUM(member_kind = 'full') AS full, SUM(member_kind = 'hash') AS hash FROM child_safety_outbox WHERE group_ref = ?").get(row.external_ref) as { full: number | null; hash: number | null };
  const full = c.full ?? 0;
  const hash = c.hash ?? 0;
  const summary = full + hash + row.suppressed_count > 0;
  let header = '';
  let texts: Iterable<string>;
  if (summary) {
    const total = full + hash + row.suppressed_count;
    header = `[rate limit] ${total} safety-floor ${total === 1 ? 'flag' : 'flags'} from this sender (seat + IP) ${total === 1 ? 'was' : 'were'} held back by the rate limit and are filed together: ${full} in full, ${hash} as SHA-256 + time${row.suppressed_count ? `, and ${row.suppressed_count} more counted only (over the row caps), from ${new Date(row.first_suppressed_at ?? 0).toISOString()} to ${new Date(row.last_suppressed_at ?? 0).toISOString()}` : ''}. Each held flag lists its own sender.`;
    texts = summaryChunks(db, row.external_ref, token);
  } else {
    const step = PART_MAX - 1000;
    const chunks: string[] = [];
    for (let i = 0; i < base.content.length; i += step) chunks.push(base.content.slice(i, i + step));
    texts = chunks.length ? chunks : [''];
  }
  let k = 0;
  const emit = (content: string, last: boolean) => {
    k++;
    const single = last && k === 1;
    return {
      body: {
        ...base,
        content: single ? content : `[part ${k}${last ? ', the last' : ''}] ${content}`,
        ...(summary ? { reason: `Rate-limit summary: ${full + hash + row.suppressed_count} held flags. ${base.reason ?? ''}` } : {}),
        externalRef: single ? base.externalRef : `${base.externalRef}:p${k}`,
      },
      last,
    };
  };
  // Group chunks into parts, holding one back to know which is last.
  let pending: string | null = null;
  let cur: string | null = null;
  for (const t of texts) {
    const next: string = cur === null ? (header ? `${header}\n\n${t}` : t) : `${cur}\n\n${t}`;
    if (cur !== null && next.length > PART_MAX) {
      if (pending !== null) yield emit(pending, false);
      pending = cur;
      cur = header ? `${header}\n\n${t}` : t;
    } else {
      cur = next;
    }
  }
  if (pending !== null) yield emit(pending, false);
  yield emit(cur ?? header, true);
}

/** Backoff after `attempts` failures: 30s, 1m, 2m, … capped at 6h. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60 * 1000);
}

export interface DeliveryResult { delivered: number; failed: number; pending: number; caseIds: string[]; partsSent: number }

/** One pass: post every due row's unfiled parts (at most PARTS_PER_PASS each). Never throws. */
export async function deliverDue(db: Database.Database, cfg: OutboxConfig, now = Date.now()): Promise<DeliveryResult> {
  const rows = db.prepare('SELECT id, external_ref, key_id, payload, attempts, parts_done, suppressed_count, first_suppressed_at, last_suppressed_at FROM child_safety_outbox WHERE next_attempt_at <= ? AND group_ref IS NULL ORDER BY id LIMIT 50').all(now) as OutboxRow[];
  const result: DeliveryResult = { delivered: 0, failed: 0, pending: 0, caseIds: [], partsSent: 0 };
  const fail = (row: OutboxRow, why: string) => {
    const attempts = row.attempts + 1;
    db.prepare('UPDATE child_safety_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?').run(attempts, now + backoffMs(attempts), why.slice(0, 300), row.id);
    // The external ref is a hash; never the content.
    console.error(`[child-safety] evidence ${row.external_ref.slice(0, 16)} not delivered (attempt ${attempts}): ${why} — kept in the outbox, retrying`);
    result.failed++;
  };
  for (const row of rows) {
    if (!cfg.token) { fail(row, 'CHILD_SAFETY_INGEST_TOKEN is not set'); continue; }
    let index = 0;
    let sent = 0;
    let done = false;
    let failed: string | null = null;
    try {
      for (const part of partsOf(db, row, cfg.token)) {
        index++;
        if (index <= row.parts_done) { done = part.last; continue; } // filed on an earlier pass
        if (sent >= PARTS_PER_PASS) break;
        const res = await cfg.fetchImpl(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
          body: JSON.stringify(part.body),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (!res.ok) { failed = `HTTP ${res.status}`; break; }
        const json = await res.json().catch(() => ({})) as { caseId?: string };
        if (json.caseId) result.caseIds.push(json.caseId);
        db.prepare('UPDATE child_safety_outbox SET parts_done = ? WHERE id = ?').run(index, row.id);
        sent++;
        result.partsSent++;
        done = part.last;
      }
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
    if (failed) { fail(row, failed); continue; }
    if (done) {
      db.prepare('DELETE FROM child_safety_outbox WHERE id = ? OR group_ref = ?').run(row.id, row.external_ref);
      console.log(`[child-safety] evidence ${row.external_ref.slice(0, 16)} filed in the vault (${index} part${index === 1 ? '' : 's'})`);
      result.delivered++;
    }
    // Not done and not failed: more parts than one pass sends; the row stays due for the next pass.
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
