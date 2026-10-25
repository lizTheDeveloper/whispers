// Campus launch passes (web cabinets): every check the cabinet contract
// requires of a game server, each refusing on its own.
import { describe, it, expect, beforeEach } from 'vitest';
import { verifyCampusPass, resetSeenJtis, CAMPUS_PASS_PUBLIC_KEY } from '../src/server/campus-pass.js';
import { newCampusKeyPair, claimsFor, signPass } from './lib/campus-pass-fixture.js';

const keys = newCampusKeyPair();
const other = newCampusKeyPair();
const NOW = 1_800_000_000_000;
const opts = (o: Partial<{ nowMs: number; audience: string }> = {}) => ({ publicKeyB64: keys.publicKeyB64, audience: 'whispers', nowMs: NOW, ...o });

beforeEach(() => resetSeenJtis());

describe('verifyCampusPass', () => {
  it('accepts a valid pass and returns sub, name and jti only', () => {
    const c = claimsFor({}, NOW);
    expect(verifyCampusPass(signPass(c, keys.privateKeyB64), opts())).toEqual({ sub: c.sub, name: c.name, jti: c.jti });
  });

  it('pins the contract public key', () => {
    expect(CAMPUS_PASS_PUBLIC_KEY).toBe('MCowBQYDK2VwAyEAdlhCkIVpnYHxsbzstbzg2DLS7x9Br8dhqCIFtoZuBXU=');
  });

  it('refuses a pass signed by another key', () => {
    expect(verifyCampusPass(signPass(claimsFor({}, NOW), other.privateKeyB64), opts())).toBeNull();
  });

  it('refuses a tampered claims segment', () => {
    const t = signPass(claimsFor({}, NOW), keys.privateKeyB64);
    const [, payload, sig] = t.split('.');
    const c = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    c.sub = '@someone-else:themultiverse.school';
    expect(verifyCampusPass(`cps.${Buffer.from(JSON.stringify(c)).toString('base64url')}.${sig}`, opts())).toBeNull();
  });

  it('refuses the wrong audience', () => {
    expect(verifyCampusPass(signPass(claimsFor({ aud: 'raising-intelligences' }, NOW), keys.privateKeyB64), opts())).toBeNull();
  });

  it('refuses the wrong issuer', () => {
    expect(verifyCampusPass(signPass(claimsFor({ iss: 'evil.example' }, NOW), keys.privateKeyB64), opts())).toBeNull();
  });

  it('refuses an expired pass', () => {
    const c = claimsFor({}, NOW - 301_000);
    expect(verifyCampusPass(signPass(c, keys.privateKeyB64), opts())).toBeNull();
    // exactly at exp is expired too (now < exp is required)
    const d = claimsFor({}, NOW - 300_000);
    expect(verifyCampusPass(signPass(d, keys.privateKeyB64), opts())).toBeNull();
  });

  it('refuses exp − iat over 300 s', () => {
    const iat = Math.floor(NOW / 1000);
    expect(verifyCampusPass(signPass(claimsFor({ iat, exp: iat + 301 }, NOW), keys.privateKeyB64), opts())).toBeNull();
  });

  it('allows ≤30 s clock skew on iat only', () => {
    const iat = Math.floor(NOW / 1000) + 30;
    expect(verifyCampusPass(signPass(claimsFor({ iat, exp: iat + 300 }, NOW), keys.privateKeyB64), opts())).not.toBeNull();
    const late = Math.floor(NOW / 1000) + 31;
    expect(verifyCampusPass(signPass(claimsFor({ iat: late, exp: late + 300 }, NOW), keys.privateKeyB64), opts())).toBeNull();
  });

  it('refuses non-integer iat/exp', () => {
    const iat = Math.floor(NOW / 1000);
    expect(verifyCampusPass(signPass(claimsFor({ iat: iat + 0.5, exp: iat + 100 }, NOW), keys.privateKeyB64), opts())).toBeNull();
    expect(verifyCampusPass(signPass({ ...claimsFor({}, NOW), exp: String(iat + 100) }, keys.privateKeyB64), opts())).toBeNull();
  });

  it('refuses a bad sub', () => {
    for (const sub of ['@Mixed:themultiverse.school', '@x:matrix.org', 'x:themultiverse.school', '@:themultiverse.school', '@a b:themultiverse.school']) {
      expect(verifyCampusPass(signPass(claimsFor({ sub }, NOW), keys.privateKeyB64), opts()), sub).toBeNull();
    }
  });

  it('refuses a bad jti', () => {
    expect(verifyCampusPass(signPass(claimsFor({ jti: 'ABCDEF0123456789abcdef0123456789' }, NOW), keys.privateKeyB64), opts())).toBeNull();
    expect(verifyCampusPass(signPass(claimsFor({ jti: 'abc' }, NOW), keys.privateKeyB64), opts())).toBeNull();
  });

  it('refuses a name that is not a string ≤ 100', () => {
    expect(verifyCampusPass(signPass(claimsFor({ name: 'x'.repeat(101) }, NOW), keys.privateKeyB64), opts())).toBeNull();
    expect(verifyCampusPass(signPass({ ...claimsFor({}, NOW), name: 5 }, keys.privateKeyB64), opts())).toBeNull();
  });

  it('refuses a replayed jti, and forgets it after exp', () => {
    const c = claimsFor({}, NOW);
    const t = signPass(c, keys.privateKeyB64);
    expect(verifyCampusPass(t, opts())).not.toBeNull();
    expect(verifyCampusPass(t, opts())).toBeNull();
    expect(verifyCampusPass(t, opts({ nowMs: NOW + 1000 }))).toBeNull();
  });

  it('a refused pass does not burn its jti', () => {
    const c = claimsFor({}, NOW);
    expect(verifyCampusPass(signPass(c, keys.privateKeyB64), opts({ audience: 'other' }))).toBeNull();
    expect(verifyCampusPass(signPass(c, keys.privateKeyB64), opts())).not.toBeNull();
  });

  it('refuses malformed tokens', () => {
    const good = signPass(claimsFor({}, NOW), keys.privateKeyB64);
    const [, payload, sig] = good.split('.');
    for (const t of ['', 'cps.', 'cps.a', `xps.${payload}.${sig}`, `cps.${payload}.${sig}.extra`, `cps.${payload}`, `cps..${sig}`, `cps.${payload}.`, `cps.${payload}!.${sig}`, `cps.${Buffer.from('not json').toString('base64url')}.${sig}`, `cps.${Buffer.from('[1]').toString('base64url')}.${sig}`]) {
      expect(verifyCampusPass(t, opts()), t).toBeNull();
    }
    expect(verifyCampusPass(undefined as unknown as string, opts())).toBeNull();
    expect(verifyCampusPass(good, opts({ }))).not.toBeNull();
  });

  it('reads CAMPUS_PASS_PUBLIC_KEY from the env when no key is passed', () => {
    const prev = process.env.CAMPUS_PASS_PUBLIC_KEY;
    process.env.CAMPUS_PASS_PUBLIC_KEY = keys.publicKeyB64;
    try {
      expect(verifyCampusPass(signPass(claimsFor({}, NOW), keys.privateKeyB64), { audience: 'whispers', nowMs: NOW })).not.toBeNull();
      delete process.env.CAMPUS_PASS_PUBLIC_KEY;
      // the pinned production key did not sign it
      expect(verifyCampusPass(signPass(claimsFor({}, NOW), keys.privateKeyB64), { audience: 'whispers', nowMs: NOW })).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.CAMPUS_PASS_PUBLIC_KEY; else process.env.CAMPUS_PASS_PUBLIC_KEY = prev;
    }
  });
});
