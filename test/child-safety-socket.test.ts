// Child safety over the real server: a seat's own words that cross the
// floor's sexual criterion are filed with that seat as sender and the IP
// derived from trusted proxies only; the synthetic test hook files a test
// case end to end. Fixtures are clinical, never abusive content.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { startHarness, type Harness } from './lib/server-harness.js';
import { sendMsg } from './lib/ws-helpers.js';
import { seatOn, waitUntil } from './lib/playing-game.js';
import { deliverDue } from '../src/server/child-safety/outbox.js';
import { seatId } from '../src/server/child-safety/reporter.js';
import type { ServerMessage } from '../src/shared/protocol.js';

const FIXTURE = 'TEST FIXTURE: the word sexual near the word child.';
let harness: Harness;
let ri: Server;
let riPort: number;
const received: any[] = [];
let getDb: typeof import('../src/server/db.js').getDb;

beforeAll(async () => {
  process.env.CHILD_SAFETY_INGEST_TOKEN = 'test-ingest-token';
  ri = createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer test-ingest-token') { res.writeHead(401).end(); return; }
      received.push(JSON.parse(data));
      res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ caseId: `case-${received.length}`, created: true }));
    });
  });
  await new Promise<void>(r => ri.listen(0, r));
  riPort = (ri.address() as { port: number }).port;
  process.env.CHILD_SAFETY_INGEST_URL = `http://127.0.0.1:${riPort}/api/internal/child-safety/evidence`;
  harness = await startHarness();
  // Imported only now: db.ts reads DATA_DIR at import time, and the harness
  // has just pointed it at a temp dir (never the repo's data/).
  ({ getDb } = await import('../src/server/db.js'));
}, 30_000);
afterAll(async () => {
  await harness.stop();
  await new Promise<void>(r => ri.close(() => r()));
  delete process.env.TRUSTED_PROXIES;
}, 30_000);

function connect(headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`, { headers });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function hostSays(headers: Record<string, string>, text: string): Promise<{ sessionToken: string; campaignId: string }> {
  const host = seatOn(await connect(headers));
  sendMsg(host.ws, { type: 'create', name: 'CS test', dmPreset: 'chronicler', systemId: 'fate-core', scenarioId: null, houseRules: null } as any);
  const joined = await host.q.waitFor('room-joined', 10_000) as Extract<ServerMessage, { type: 'room-joined' }>;
  sendMsg(host.ws, { type: 'dm-chat', text } as any);
  // The create itself may send a "no rulebook" notice; wait for the reply to this message.
  await waitUntil(() => host.log.some(m => m.type === 'dm-chat-reply' && !String((m as any).text).startsWith('Heads up')), 20_000, 'the DM\'s reply');
  host.ws.close();
  return { sessionToken: joined.sessionToken, campaignId: (joined as any).campaignId };
}

const cfg = () => ({ url: process.env.CHILD_SAFETY_INGEST_URL!, token: 'test-ingest-token', fetchImpl: fetch, timeoutMs: 5000 });

describe('child safety over the socket', () => {
  it('files the seat\'s own words with its trusted IP (behind a trusted proxy)', async () => {
    received.length = 0;
    const { sessionToken, campaignId } = await hostSays({ 'x-forwarded-for': '198.51.100.1, 203.0.113.9', 'user-agent': 'CS-Test-UA' }, FIXTURE);
    await deliverDue(getDb(), cfg(), Date.now() + 1);
    const c = received.find(b => b.gameRef === `whispers:${campaignId}`);
    expect(c).toBeTruthy();
    expect(c.source).toBe('whispers');
    expect(c.content).toBe(FIXTURE);
    expect(c.categories).toEqual(['sexual/minors']);
    expect(c.ipAddress).toBe('203.0.113.9');
    expect(c.userAgent).toBe('CS-Test-UA');
    expect(c.identifiers).toContainEqual({ kind: 'whispers_seat', value: seatId(sessionToken), verified: true });
    expect(c.identifiers).toContainEqual({ kind: 'whispers_player_name', value: 'Host', verified: false });
    expect(c.reason).toContain("player's own words");
  }, 60_000);

  it('ignores a forwarded-for header from a peer that is not a trusted proxy', async () => {
    received.length = 0;
    process.env.TRUSTED_PROXIES = '10.99.99.99/32';
    try {
      const { campaignId } = await hostSays({ 'x-forwarded-for': '203.0.113.66' }, `${FIXTURE} (spoof)`);
      await deliverDue(getDb(), cfg(), Date.now() + 1);
      const c = received.find(b => b.gameRef === `whispers:${campaignId}`);
      expect(c.ipAddress).toBe('127.0.0.1');
    } finally {
      delete process.env.TRUSTED_PROXIES;
    }
  }, 60_000);

  it('the synthetic hook files an isTest case end to end, and needs the token', async () => {
    received.length = 0;
    const url = `http://127.0.0.1:${harness.port}/api/internal/child-safety/synthetic`;
    expect((await fetch(url, { method: 'POST' })).status).toBe(401);
    const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer test-ingest-token', 'X-Forwarded-For': '203.0.113.200' } });
    expect(res.status).toBe(200);
    const out = await res.json() as any;
    expect(out.delivery.caseIds).toHaveLength(1);
    const c = received[0];
    expect(c.isTest).toBe(true);
    expect(c.content).toContain('SYNTHETIC TEST FIXTURE');
    expect(c.ipAddress).toBe('203.0.113.200');
    expect(c.identifiers).toContainEqual({ kind: 'ip', value: '192.0.2.77', verified: true, role: 'participant' });
    expect(c.identifiers).toContainEqual({ kind: 'whispers_player_name', value: 'Synthetic Tester', verified: false });
    // The throwaway game is gone.
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM campaigns WHERE id = ?').get(c.gameRef.replace('whispers:', ''))).toEqual({ c: 0 });
  }, 30_000);
});

describe('child safety: bounded input', () => {
  it('player text for the floor is capped in count and size, and one message files one case', async () => {
    const { playerTextForFloor, WS_MAX_PAYLOAD } = await import('../src/server/index.js');
    expect(WS_MAX_PAYLOAD).toBe(256 * 1024);
    const big = { type: 'submit-character', definition: { aspects: Array.from({ length: 500 }, () => 'y'.repeat(10_000)) } };
    const t = playerTextForFloor(big);
    expect(t.length).toBeLessThanOrEqual(16_000);
    expect(playerTextForFloor({ type: 'whisper', text: 'hello', joinCode: 'ABCDEF', sessionToken: 'secret' })).toBe('hello');

    received.length = 0;
    const many = Array.from({ length: 25 }, (_, i) => `TEST FIXTURE ${i}: the word sexual near the word child.`).join(' ');
    const { campaignId } = await hostSays({}, many);
    await deliverDue(getDb(), cfg(), Date.now() + 1);
    const cases = received.filter(b => b.gameRef === `whispers:${campaignId}`);
    expect(cases).toHaveLength(1);
    expect(cases[0].reason).toContain('25 flagged sentences');
  }, 60_000);

  it('a message over maxPayload is refused by the socket', async () => {
    const ws = await connect({});
    const closed = new Promise<number>(r => ws.on('close', code => r(code)));
    ws.send(JSON.stringify({ type: 'whisper', text: 'z'.repeat(300 * 1024) }));
    expect(await closed).toBe(1009);
  }, 30_000);
});
