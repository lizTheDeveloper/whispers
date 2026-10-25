import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * A campus identity: what a verified campus pass is exchanged for. The token
 * is opaque (32 random bytes, hex) and maps server-side to the campus Matrix
 * ID and screen name, for 12 hours. It is never the pass and never a Matrix
 * access token.
 */
export const CAMPUS_IDENTITY_TTL_MS = 12 * 60 * 60 * 1000;
const TOKEN_RE = /^[0-9a-f]{64}$/;

export interface CampusIdentity { sub: string; name: string }

export function createCampusIdentity(db: Database.Database, who: CampusIdentity, nowMs = Date.now()): string {
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM campus_identities WHERE expires_at <= ?').run(nowMs);
  db.prepare('INSERT INTO campus_identities (token, sub, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(token, who.sub, who.name, nowMs, nowMs + CAMPUS_IDENTITY_TTL_MS);
  return token;
}

/** The identity behind a token, or null when it is unknown, expired or not a token at all. */
export function lookupCampusIdentity(db: Database.Database, token: unknown, nowMs = Date.now()): CampusIdentity | null {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const row = db.prepare('SELECT sub, name, expires_at FROM campus_identities WHERE token = ?').get(token) as { sub: string; name: string; expires_at: number } | undefined;
  if (!row || row.expires_at <= nowMs) return null;
  return { sub: row.sub, name: row.name };
}

/** Binds a campus Matrix ID to a seat. The first one wins: a seat's campus identity never changes. */
export function setSessionCampusSub(db: Database.Database, sessionToken: string, sub: string): void {
  db.prepare('UPDATE campaign_sessions SET campus_sub = ? WHERE token = ? AND campus_sub IS NULL').run(sub, sessionToken);
}

/**
 * A tiny fixed-window limiter (no limiter in this repo): `max` hits per key
 * per `windowMs`. True when the hit is allowed.
 */
export function makeRateLimiter(max: number, windowMs: number): (key: string, nowMs?: number) => boolean {
  const hits = new Map<string, { start: number; count: number }>();
  return (key, nowMs = Date.now()) => {
    let w = hits.get(key);
    if (!w || nowMs - w.start >= windowMs) {
      if (hits.size > 10_000) for (const [k, v] of hits) if (nowMs - v.start >= windowMs) hits.delete(k);
      w = { start: nowMs, count: 0 };
      hits.set(key, w);
    }
    w.count++;
    return w.count <= max;
  };
}
