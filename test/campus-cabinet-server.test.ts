// Web cabinets over the real server: framing headers, the campus pass
// exchange, and a campus identity riding along on create/join/rejoin.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { startHarness, type Harness } from './lib/server-harness.js';
import { sendMsg } from './lib/ws-helpers.js';
import { seatOn, waitUntil, sleep } from './lib/playing-game.js';
import { newCampusKeyPair, claimsFor, signPass } from './lib/campus-pass-fixture.js';
import type { ServerMessage } from '../src/shared/protocol.js';

const keys = newCampusKeyPair();
let harness: Harness;
let getDb: typeof import('../src/server/db.js').getDb;
let ipSeq = 10;
// Each test gets its own client IP (loopback is a trusted proxy), so the
// exchange's per-IP limit only bites in the test about it.
const freshIp = () => `198.51.100.${ipSeq++}`;

beforeAll(async () => {
  process.env.CAMPUS_PASS_PUBLIC_KEY = keys.publicKeyB64;
  harness = await startHarness();
  ({ getDb } = await import('../src/server/db.js'));
}, 30_000);
afterAll(async () => {
  await harness.stop();
  delete process.env.CAMPUS_PASS_PUBLIC_KEY;
}, 30_000);

const base = () => `http://127.0.0.1:${harness.port}`;

async function exchange(pass: unknown, ip = freshIp()): Promise<Response> {
  return fetch(`${base()}/api/campus-pass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ pass }),
  });
}

async function identityFor(name = 'Test Student', sub = '@test-student:themultiverse.school'): Promise<string> {
  const res = await exchange(signPass(claimsFor({ name, sub }), keys.privateKeyB64));
  expect(res.status).toBe(200);
  return (await res.json()).identity;
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

const campusSubOf = (token: string) =>
  (getDb().prepare('SELECT campus_sub FROM campaign_sessions WHERE token = ?').get(token) as { campus_sub: string | null }).campus_sub;

describe('framing', () => {
  it('every response may be framed by campus, and carries no X-Frame-Options', async () => {
    for (const path of ['/healthz', '/api/nope']) {
      const res = await fetch(base() + path);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp.endsWith("frame-ancestors 'self' https://campus.themultiverse.school")).toBe(true);
      expect(csp.match(/frame-ancestors/g)).toHaveLength(1);
      expect(res.headers.get('x-frame-options')).toBeNull();
    }
  });
});

describe('POST /api/campus-pass', () => {
  it('exchanges a valid pass for an opaque identity token', async () => {
    const c = claimsFor({ name: 'Test Student' });
    const res = await exchange(signPass(c, keys.privateKeyB64));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ identity: expect.stringMatching(/^[0-9a-f]{64}$/), name: 'Test Student', sub: c.sub });
    const row = getDb().prepare('SELECT sub, name, expires_at, created_at FROM campus_identities WHERE token = ?').get(body.identity) as { sub: string; name: string; expires_at: number; created_at: number };
    expect(row.sub).toBe(c.sub);
    expect(row.expires_at - row.created_at).toBe(12 * 60 * 60 * 1000);
  });

  it('refuses a replayed pass, a bad pass and a missing pass with no detail', async () => {
    const pass = signPass(claimsFor(), keys.privateKeyB64);
    expect((await exchange(pass)).status).toBe(200);
    for (const p of [pass, 'cps.garbage.sig', undefined, 42, signPass(claimsFor({ aud: 'agentic-dnd' }), keys.privateKeyB64)]) {
      const res = await exchange(p);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'pass_refused' });
    }
  });

  it('never logs the pass itself', async () => {
    const lines: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of ['log', 'warn', 'error', 'info'] as const) console[k] = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    try {
      const c = claimsFor();
      const pass = signPass(c, keys.privateKeyB64);
      await exchange(pass);
      await exchange(pass);
      expect(lines.join('\n')).not.toContain(pass.split('.')[2]!);
      expect(lines.join('\n')).not.toContain(pass.split('.')[1]!);
    } finally { Object.assign(console, orig); }
  });

  it('a malformed JSON body is refused like any bad pass, and never logged', async () => {
    const lines: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of ['log', 'warn', 'error', 'info'] as const) console[k] = (...a: unknown[]) => { lines.push(a.map(a => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' ')); };
    const stderr: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { stderr.push(String(chunk)); return origWrite(chunk as string, ...(rest as [])); }) as typeof process.stderr.write;
    try {
      const pass = signPass(claimsFor(), keys.privateKeyB64);
      const res = await fetch(`${base()}/api/campus-pass`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': freshIp() },
        body: `{"pass": "${pass}"`,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'pass_refused' });
      const all = lines.join('\n') + stderr.join('');
      expect(all).not.toContain('cps.');
    } finally { Object.assign(console, orig); process.stderr.write = origWrite; }
  });

  it('a malformed JSON body elsewhere still gets a plain 400', async () => {
    const res = await fetch(`${base()}/api/campaigns/x/materials-not-a-route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('{bad');
  });

  it('rate-limits one IP to 30 exchanges a minute', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await exchange('cps.x.y', ip)).status);
    expect(statuses.slice(0, 30).every(s => s === 400)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    // another IP is unaffected
    expect((await exchange('cps.x.y')).status).toBe(400);
  });
});

describe('a campus identity on the seat', () => {
  it('create records campus_sub on the host seat', async () => {
    const identity = await identityFor('Test Host', '@test-host:themultiverse.school');
    const host = seatOn(await connect());
    sendMsg(host.ws, { type: 'create', name: 'Cabinet game', dmPreset: 'chronicler', systemId: 'fate-core', scenarioId: null, houseRules: null, campusIdentity: identity });
    const joined = await host.q.waitFor('room-joined', 10_000) as Extract<ServerMessage, { type: 'room-joined' }>;
    expect(campusSubOf(joined.sessionToken)).toBe('@test-host:themultiverse.school');
    host.ws.close();
  });

  it('join records campus_sub; an unknown identity is ignored and play goes on', async () => {
    const host = seatOn(await connect());
    sendMsg(host.ws, { type: 'create', name: 'Cabinet game 2', dmPreset: 'chronicler', systemId: 'fate-core', scenarioId: null, houseRules: null });
    const hj = await host.q.waitFor('room-joined', 10_000) as Extract<ServerMessage, { type: 'room-joined' }>;
    expect(campusSubOf(hj.sessionToken)).toBeNull();

    const identity = await identityFor('Test Player', '@test-player:themultiverse.school');
    const p1 = seatOn(await connect());
    sendMsg(p1.ws, { type: 'join', joinCode: hj.joinCode, playerName: 'Test Player', campusIdentity: identity });
    const j1 = await p1.q.waitFor('room-joined', 10_000) as Extract<ServerMessage, { type: 'room-joined' }>;
    expect(j1.playerName).toBe('Test Player');
    expect(campusSubOf(j1.sessionToken)).toBe('@test-player:themultiverse.school');

    const p2 = seatOn(await connect());
    sendMsg(p2.ws, { type: 'join', joinCode: hj.joinCode, playerName: 'Someone', campusIdentity: 'f'.repeat(64) });
    const j2 = await p2.q.waitFor('room-joined', 10_000) as Extract<ServerMessage, { type: 'room-joined' }>;
    expect(campusSubOf(j2.sessionToken)).toBeNull();
    await waitUntil(() => p2.log.some(m => m.type === 'campus-identity'), 5000, 'campus-identity unknown');
    expect(p2.log.find(m => m.type === 'campus-identity')).toEqual({ type: 'campus-identity', status: 'unknown' });
    expect(p2.log.some(m => m.type === 'error')).toBe(false);
    // a non-string identity is ignored the same way
    const p3 = seatOn(await connect());
    sendMsg(p3.ws, { type: 'join', joinCode: hj.joinCode, playerName: 'Third', campusIdentity: { evil: true } } as any);
    await p3.q.waitFor('room-joined', 10_000);

    for (const s of [host, p1, p2, p3]) s.ws.close();
  });

  it('rejoin with a fresh identity records campus_sub on an anonymous seat', async () => {
    const host = seatOn(await connect());
    sendMsg(host.ws, { type: 'create', name: 'Cabinet game 3', dmPreset: 'chronicler', systemId: 'fate-core', scenarioId: null, houseRules: null });
    const hj = await host.q.waitFor('room-joined', 10_000) as Extract<ServerMessage, { type: 'room-joined' }>;
    host.ws.close();
    await sleep(50);
    const identity = await identityFor('Test Host', '@test-rejoin:themultiverse.school');
    const again = seatOn(await connect());
    sendMsg(again.ws, { type: 'rejoin', joinCode: hj.joinCode, sessionToken: hj.sessionToken, campusIdentity: identity });
    await again.q.waitFor('room-joined', 10_000);
    expect(campusSubOf(hj.sessionToken)).toBe('@test-rejoin:themultiverse.school');
    again.ws.close();
  });

  it('an expired identity is unknown', async () => {
    const identity = await identityFor();
    getDb().prepare('UPDATE campus_identities SET expires_at = ? WHERE token = ?').run(Date.now() - 1, identity);
    const host = seatOn(await connect());
    sendMsg(host.ws, { type: 'create', name: 'Cabinet game 4', dmPreset: 'chronicler', systemId: 'fate-core', scenarioId: null, houseRules: null, campusIdentity: identity });
    const hj = await host.q.waitFor('room-joined', 10_000) as Extract<ServerMessage, { type: 'room-joined' }>;
    expect(campusSubOf(hj.sessionToken)).toBeNull();
    await waitUntil(() => host.log.some(m => m.type === 'campus-identity'), 5000, 'campus-identity unknown');
    host.ws.close();
  });
});
