import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { enqueueEvidence, upsertHeldEvidence, ensureOutboxTables, type EvidenceBody, type EvidenceIdentifier } from './outbox.js';
import { contentSha256, setSexualFloorHandler, type SexualFloorFlag } from './sink.js';

/**
 * Files every safety-floor flag for sexual content involving a minor in the
 * child-safety evidence vault (via the outbox), with the flagged sender's
 * trusted IP, user agent, seat, game id and identifiers.
 *
 * Who the sender is comes from the async scope the flag was raised in:
 *  - a socket message (dm-chat, char-chat, a whisper…): the seat that sent
 *    it, and that request's IP and user agent;
 *  - a character's turn in the game loop: the seat that plays that
 *    character (its whispers steer it);
 *  - anything else in the game loop (the DM's narration, the epilogue):
 *    the only human seat if there is exactly one, else nobody — every seat
 *    goes in as a participant and the reviewer decides.
 *
 * Verified: only what this server authenticated — the IPs it observed
 * (through trusted proxies only, trusted-ip.ts) and the seat, whose session
 * token it issued (sent as a hash, never the token). Player names are typed
 * by the player: "claimed, unverified". Co-players are participants, never
 * the flagged sender, so a confirm in the vault never bans them.
 */

export interface ContextTurn { speaker: string; content: string; at?: number | string | null }

export interface SafetyScope {
  campaignId: () => string | null;
  /** The seat that sent the request being handled (socket scope). */
  seatToken?: () => string | null;
  requestIp?: string | null;
  userAgent?: string | null;
  /** The character whose turn this is (game-loop scope). */
  characterId?: string | null;
  context?: () => ContextTurn[];
  /** For the reviewer: where this flag was raised. */
  where?: string;
}

const scope = new AsyncLocalStorage<SafetyScope>();

export function runInSafetyScope<T>(s: SafetyScope, fn: () => T): T {
  return scope.run(s, fn);
}

/** The current scope with `extra` on top (a character's turn inside the loop). */
export function withSafetyScope<T>(extra: Partial<SafetyScope>, fn: () => T): T {
  const base = scope.getStore();
  return scope.run({ campaignId: () => null, ...base, ...extra } as SafetyScope, fn);
}

export function currentSafetyScope(): SafetyScope | undefined {
  return scope.getStore();
}

// ─── IP log ─────────────────────────────────────────────────────────────────

export const IP_LOG_RETENTION_DAYS = Number(process.env.CHILD_SAFETY_IP_LOG_RETENTION_DAYS) || 90;

export function ensureChildSafetyTables(db: Database.Database): void {
  ensureOutboxTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS child_safety_ip_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id TEXT NOT NULL,
      session_token TEXT NOT NULL,
      ip TEXT NOT NULL,
      user_agent TEXT,
      event TEXT NOT NULL,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      UNIQUE (campaign_id, session_token, ip, user_agent)
    );
    CREATE INDEX IF NOT EXISTS idx_child_safety_ip_log_campaign ON child_safety_ip_log(campaign_id);
  `);
}

/** One row per seat × IP × user agent, with when it was first and last seen. */
export function recordSeatIp(db: Database.Database, e: { campaignId: string; sessionToken: string; ip: string | null; userAgent: string | null; event: string }, now = Date.now()): void {
  if (!e.ip) return;
  try {
    db.prepare(`INSERT INTO child_safety_ip_log (campaign_id, session_token, ip, user_agent, event, first_at, last_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (campaign_id, session_token, ip, user_agent) DO UPDATE SET last_at = excluded.last_at`)
      .run(e.campaignId, e.sessionToken, e.ip, e.userAgent ?? '', e.event, now, now);
  } catch (err) {
    console.error('[child-safety] ip log write failed:', err instanceof Error ? err.message : err);
  }
}

export function purgeIpLog(db: Database.Database, now = Date.now()): number {
  return db.prepare('DELETE FROM child_safety_ip_log WHERE last_at < ?').run(now - IP_LOG_RETENTION_DAYS * 86_400_000).changes;
}

// ─── Building a case ────────────────────────────────────────────────────────

/** A seat's identifier for the vault: a hash of its session token, never the token. */
export function seatId(token: string): string {
  return createHash('sha256').update(`whispers-seat:${token}`).digest('hex').slice(0, 24);
}

interface SeatRow { token: string; player_name: string; is_host: number; character_id: string | null }
interface IpRow { session_token: string; ip: string; user_agent: string; event: string; first_at: number; last_at: number }

export interface BuildInput {
  flag: SexualFloorFlag;
  scope: SafetyScope | undefined;
  now?: number;
  isTest?: boolean;
  model?: string;
}

export function buildEvidence(db: Database.Database, input: BuildInput): EvidenceBody {
  const now = input.now ?? Date.now();
  const s = input.scope;
  const campaignId = s?.campaignId() ?? null;
  const seats: SeatRow[] = campaignId
    ? db.prepare('SELECT token, player_name, is_host, character_id FROM campaign_sessions WHERE campaign_id = ?').all(campaignId) as SeatRow[]
    : [];
  const ips: IpRow[] = campaignId
    ? db.prepare('SELECT session_token, ip, user_agent, event, first_at, last_at FROM child_safety_ip_log WHERE campaign_id = ? ORDER BY last_at').all(campaignId) as IpRow[]
    : [];

  // Who sent it.
  let sender: string | null = null;
  let attribution: string;
  const requestSeat = s?.seatToken?.() ?? null;
  if (requestSeat) {
    sender = requestSeat;
    attribution = 'the seat whose own request carried or prompted the flagged text';
  } else if (s?.characterId) {
    sender = seats.find(r => r.character_id === s.characterId)?.token ?? null;
    attribution = sender
      ? "the seat that plays the character whose turn produced it (that seat's whispers steer the character)"
      : 'unknown: the character whose turn produced it has no human seat';
  } else if (seats.length === 1) {
    sender = seats[0]!.token;
    attribution = 'the only human seat at the table';
  } else {
    attribution = seats.length === 0 ? 'unknown: no seats on record' : `unknown: ${seats.length} human seats, AI-written text not tied to one of them — every seat is listed as a participant`;
  }

  const seatName = (token: string) => {
    const row = seats.find(r => r.token === token);
    return row ? `${row.is_host ? 'host' : 'player'} "${row.player_name}"` : 'a seat no longer on record';
  };
  const identifiers: EvidenceIdentifier[] = [];
  const role = (token: string): { role?: 'participant' } => (sender !== null && token === sender ? {} : { role: 'participant' });
  const tokens = new Set<string>([...seats.map(r => r.token), ...ips.map(r => r.session_token), ...(sender ? [sender] : [])]);
  for (const token of tokens) {
    identifiers.push({ kind: 'whispers_seat', value: seatId(token), verified: true, ...role(token) });
    const row = seats.find(r => r.token === token);
    if (row?.player_name) identifiers.push({ kind: 'whispers_player_name', value: row.player_name, verified: false, ...role(token) });
  }
  for (const r of ips) identifiers.push({ kind: 'ip', value: r.ip, verified: true, ...role(r.session_token) });

  // The sender's IP and user agent: this request's when it is theirs, else their latest on record.
  let ipAddress: string | null = null;
  let userAgent: string | null = null;
  if (sender && requestSeat === sender && s?.requestIp) {
    ipAddress = s.requestIp;
    userAgent = s.userAgent ?? null;
  } else if (sender) {
    const latest = [...ips].reverse().find(r => r.session_token === sender);
    ipAddress = latest?.ip ?? null;
    userAgent = latest?.user_agent || null;
  }

  const context: ContextTurn[] = (() => {
    try { return (s?.context?.() ?? []).slice(-20); } catch { return []; }
  })();
  const ipHistory = ips.map(r => `${r.ip} (${seatName(r.session_token)}${sender && r.session_token === sender ? ', FLAGGED SENDER' : ''}; ${r.event}; first ${new Date(r.first_at).toISOString()}, last ${new Date(r.last_at).toISOString()}; UA ${r.user_agent || 'none'})`);

  const reason = [
    `Whispers safety floor: sexual content involving a minor or child character (${input.flag.items.length} flagged ${input.flag.items.length === 1 ? 'sentence or phrase' : 'sentences or phrases'}), detected by the ${input.flag.detector === 'judge' ? 'LLM floor judge' : 'deterministic floor backstop'} in ${input.flag.label}${s?.where ? ` (${s.where})` : ''}.`,
    `Written by ${input.flag.origin === 'human' ? 'a human player (their own words)' : 'an AI agent (the game\'s LLM), steered by the players'}; the game removed it before anyone saw it${input.flag.origin === 'human' ? ' as story text' : ''}.`,
    `Flagged sender: ${sender ? seatName(sender) : 'none'} — ${attribution}.`,
    ipHistory.length ? `IP log for this game: ${ipHistory.join('; ')}.` : 'No IPs on record for this game.',
  ].join(' ');

  const flagged = input.flag.items.join('\n');
  const content = input.flag.passage
    ? `${flagged}\n\n--- the passage around it ---\n${input.flag.passage}`
    : flagged;

  return {
    source: 'whispers',
    content,
    context,
    categories: ['sexual/minors'],
    model: input.model ?? (input.flag.detector === 'judge' ? 'whispers-floor-judge' : 'whispers-floor-backstop'),
    reason,
    gameRef: campaignId ? `whispers:${campaignId}` : null,
    ipAddress,
    userAgent,
    identifiers,
    incidentAt: now,
    externalRef: contentSha256(`${campaignId ?? 'none'}\n${flagged}`).slice(0, 40),
    ...(input.isTest ? { isTest: true } : {}),
  };
}

// ─── Rate limit ─────────────────────────────────────────────────────────────
//
// At most RATE_MAX cases per seat and per IP in each RATE_WINDOW_MS window.
// Past that nothing is dropped silently: one held "N more suppressed" case
// per seat (or IP) and window carries the count and the latest flagged text,
// and is delivered when the window closes.

export const RATE_WINDOW_MS = 10 * 60 * 1000;
export const RATE_MAX = 5;
const windows = new Map<string, { start: number; count: number; suppressed: number }>();

function windowFor(key: string, now: number) {
  const start = now - (now % RATE_WINDOW_MS);
  let w = windows.get(key);
  if (!w || w.start !== start) { w = { start, count: 0, suppressed: 0 }; windows.set(key, w); }
  if (windows.size > 10_000) for (const [k, v] of windows) if (v.start < start) windows.delete(k);
  return w;
}

const filedRefs = new Set<string>();
function rememberRef(ref: string): void {
  filedRefs.add(ref);
  if (filedRefs.size > 5000) filedRefs.delete(filedRefs.values().next().value as string);
}

/** For tests. */
export function resetRateLimit(): void { windows.clear(); filedRefs.clear(); }

function rateKeys(body: EvidenceBody, s: SafetyScope | undefined): string[] {
  const keys: string[] = [];
  const seat = body.identifiers.find(i => i.kind === 'whispers_seat' && !i.role);
  if (seat) keys.push(`seat:${seat.value}`);
  const ip = body.ipAddress ?? s?.requestIp ?? null;
  if (ip) keys.push(`ip:${ip}`);
  if (keys.length === 0) keys.push(`game:${body.gameRef ?? 'none'}`);
  return keys;
}

/** File a flag raised in the current scope. Never throws. */
export function fileFlag(db: Database.Database, flag: SexualFloorFlag, opts: { isTest?: boolean; scope?: SafetyScope; now?: number } = {}): EvidenceBody | null {
  try {
    const s = opts.scope ?? scope.getStore();
    const now = opts.now ?? Date.now();
    const body = buildEvidence(db, { flag, scope: s, isTest: opts.isTest, now });
    // The same text checked again (a re-check, a second draft) is the same
    // case: it neither files twice nor counts against the rate limit.
    if (filedRefs.has(body.externalRef)) return body;
    rememberRef(body.externalRef);
    const keys = rateKeys(body, s);
    const ws = keys.map(k => windowFor(k, now));
    const over = ws.findIndex(w => w.count >= RATE_MAX);
    if (over >= 0 && !opts.isTest) {
      const w = ws[over]!;
      w.suppressed++;
      const ref = contentSha256(`suppressed\n${keys[over]}\n${w.start}`).slice(0, 40);
      const summary: EvidenceBody = {
        ...body,
        content: `[rate limit] ${w.suppressed} more safety-floor ${w.suppressed === 1 ? 'flag' : 'flags'} from this ${keys[over]!.split(':')[0]} were suppressed in the ${RATE_WINDOW_MS / 60000}-minute window from ${new Date(w.start).toISOString()} (after ${RATE_MAX} cases were filed). The latest suppressed flag:\n\n${body.content}`,
        reason: `${w.suppressed} more suppressed by the per-seat/IP rate limit. ${body.reason ?? ''}`,
        externalRef: ref,
      };
      upsertHeldEvidence(db, summary, w.start + RATE_WINDOW_MS, undefined, now);
      console.warn(`[child-safety] safety-floor flag (${flag.detector}, ${flag.label}) over the rate limit for ${keys[over]!.split(':')[0]}: ${w.suppressed} suppressed this window, summary ${ref.slice(0, 16)} held until the window closes`);
      return summary;
    }
    for (const w of ws) w.count++;
    const queued = enqueueEvidence(db, body, undefined, now);
    console.warn(`[child-safety] safety-floor flag (${flag.detector}, ${flag.label}) ${queued ? 'queued for the evidence vault' : 'already queued'}: evidence ${body.externalRef.slice(0, 16)}`);
    return body;
  } catch (e) {
    console.error('[child-safety] could not queue a safety-floor flag:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** Install the sink handler: every floor flag goes to the vault. */
export function installChildSafetyReporter(getDb: () => Database.Database): void {
  setSexualFloorHandler(flag => { fileFlag(getDb(), flag); });
}
