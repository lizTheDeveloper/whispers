/**
 * Campus launch passes (web cabinets). When a student plays Whispers inside a
 * campus.themultiverse.school "web cabinet", campus hands the framed page a
 * short-lived Ed25519-signed pass; the server exchanges it for an identity
 * token (see campus-identity.ts). This module only verifies passes and holds
 * only campus's PUBLIC key.
 *
 * Wire format: `cps.<base64url(claims JSON)>.<base64url(signature)>`; the
 * signature covers the ASCII bytes of the claims segment (no `cps.` prefix).
 * A pass is a bearer credential for five minutes: never log it, never store
 * it — log its jti.
 */
import { createPublicKey, verify } from 'node:crypto';
import type Database from 'better-sqlite3';

/** Campus's pass-signing public key (base64 SPKI DER, Ed25519). Public, not a secret. */
export const CAMPUS_PASS_PUBLIC_KEY = 'MCowBQYDK2VwAyEAdlhCkIVpnYHxsbzstbzg2DLS7x9Br8dhqCIFtoZuBXU=';
export const CAMPUS_PASS_PREFIX = 'cps.';
export const CAMPUS_ISSUER = 'campus.themultiverse.school';
export const CAMPUS_PASS_MAX_TTL_S = 300;
const IAT_SKEW_S = 30;
const SUB_RE = /^@[a-z0-9._=\-/+]{1,255}:themultiverse\.school$/;
const JTI_RE = /^[0-9a-f]{32}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export interface CampusPassIdentity { sub: string; name: string; jti: string }

/**
 * Spend a jti: true the first time it is seen, false for a replay. Kept in
 * SQLite (`campus_pass_jti`, created in db.ts migrate) so a restart or a
 * second process still refuses a replay; a row lives until its pass expires.
 */
export function consumePassJti(db: Database.Database, jti: string, expMs: number, nowMs = Date.now()): boolean {
  db.prepare('DELETE FROM campus_pass_jti WHERE exp_ms <= ?').run(nowMs);
  return db.prepare('INSERT OR IGNORE INTO campus_pass_jti (jti, exp_ms) VALUES (?, ?)').run(jti, expMs).changes === 1;
}

export function campusPassPublicKey(): string {
  return process.env.CAMPUS_PASS_PUBLIC_KEY?.trim() || CAMPUS_PASS_PUBLIC_KEY;
}

/**
 * Every check of the cabinet contract; null on any failure. A pass that
 * passes is consumed in `db`: its jti is refused from then until it expires.
 */
export function verifyCampusPass(
  token: string,
  opts: { publicKeyB64?: string; audience: string; nowMs?: number; db: Database.Database },
): CampusPassIdentity | null {
  if (typeof token !== 'string' || !token.startsWith(CAMPUS_PASS_PREFIX)) return null;
  const parts = token.slice(CAMPUS_PASS_PREFIX.length).split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  if (!B64URL_RE.test(payload) || !B64URL_RE.test(sig)) return null;
  const nowMs = opts.nowMs ?? Date.now();
  const nowS = nowMs / 1000;
  try {
    const pub = createPublicKey({ key: Buffer.from(opts.publicKeyB64 ?? campusPassPublicKey(), 'base64'), format: 'der', type: 'spki' });
    if (!verify(null, Buffer.from(payload, 'ascii'), pub, Buffer.from(sig, 'base64url'))) return null;
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown> | null;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    if (c.iss !== CAMPUS_ISSUER || c.aud !== opts.audience) return null;
    if (typeof c.sub !== 'string' || !SUB_RE.test(c.sub)) return null;
    if (typeof c.name !== 'string' || c.name.length > 100) return null;
    if (typeof c.jti !== 'string' || !JTI_RE.test(c.jti)) return null;
    if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp)) return null;
    const iat = c.iat as number;
    const exp = c.exp as number;
    if (!(exp > iat) || exp - iat > CAMPUS_PASS_MAX_TTL_S || !(nowS < exp) || iat > nowS + IAT_SKEW_S) return null;
    // Last: only a pass that passed every other check uses up its jti.
    if (!consumePassJti(opts.db, c.jti, exp * 1000, nowMs)) return null;
    return { sub: c.sub, name: c.name, jti: c.jti };
  } catch {
    return null;
  }
}
