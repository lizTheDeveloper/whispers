// Child safety: every safety-floor flag for sexual content involving a minor
// is filed in the studio's evidence vault (Raising Intelligences' ingest
// endpoint) through a durable outbox, with the sender's trusted IP, user
// agent, seat and identifiers; the flagged text stays out of the logs.
//
// The fixtures are deliberately clinical ("the word sexual near the word
// child") — they trip the deterministic floor without being abusive content.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { clientIp, buildTrustedList, normalizeIp } from '../src/server/child-safety/trusted-ip.js';
import { setSexualFloorHandler, resetSexualFloorSink, noteSexualFloor, redactLog, redactLine, installLogRedaction, isWithheld, passageWindow, type SexualFloorFlag } from '../src/server/child-safety/sink.js';
import { enqueueEvidence, deliverDue, backoffMs, setDeadLetterAlert, startOutbox, EvidenceKeyMissingError, INGEST_CONTENT_CAP, type EvidenceBody } from '../src/server/child-safety/outbox.js';
import { createHash } from 'node:crypto';
import { ensureChildSafetyTables, buildEvidence, recordSeatIp, runInSafetyScope, withSafetyScope, fileFlag, seatId, purgeIpLog, resetRateLimit, RATE_MAX, RATE_WINDOW_MS } from '../src/server/child-safety/reporter.js';
import { floorBackstop, withoutFloorBreaches, sexualFloorSentences } from '../src/server/safety-floor.js';
import { parseToneVerdict, gateGentleTone } from '../src/server/tone-gate.js';
import { migrate } from '../src/server/db.js';

const FIXTURE = 'TEST FIXTURE: the word sexual near the word child.';
const VIOLENCE = 'The guard hits the child.';

function memDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  ensureChildSafetyTables(db);
  return db;
}

describe('trusted client IP', () => {
  it('by default trusts loopback only — never a shared Docker bridge', () => {
    const def = buildTrustedList('');
    expect(clientIp('172.19.0.4', '203.0.113.5', def)).toBe('172.19.0.4');
    expect(clientIp('127.0.0.1', '203.0.113.5', def)).toBe('203.0.113.5');
    const prod = buildTrustedList('172.30.42.3/32');
    expect(clientIp('172.30.42.3', '203.0.113.5', prod)).toBe('203.0.113.5');
    expect(clientIp('172.30.42.4', '203.0.113.5', prod)).toBe('172.30.42.4');
  });
  const list = buildTrustedList('127.0.0.0/8,10.0.0.0/8');
  it('ignores X-Forwarded-For from a peer that is not a trusted proxy', () => {
    expect(clientIp('203.0.113.5', '198.51.100.1', list)).toBe('203.0.113.5');
  });
  it('reads the rightmost untrusted hop when the peer is a trusted proxy', () => {
    // The client wrote "1.1.1.1"; Traefik appended the real address.
    expect(clientIp('10.0.0.4', '1.1.1.1, 203.0.113.9', list)).toBe('203.0.113.9');
    expect(clientIp('::ffff:127.0.0.1', '203.0.113.9, 10.0.0.7', list)).toBe('203.0.113.9');
  });
  it('falls back to the peer when there is no header, and stops at garbage', () => {
    expect(clientIp('10.0.0.4', undefined, list)).toBe('10.0.0.4');
    expect(clientIp('10.0.0.4', 'not-an-ip, 203.0.113.9', list)).toBe('203.0.113.9');
    expect(clientIp('10.0.0.4', '203.0.113.9, garbage', list)).toBe('10.0.0.4');
  });
  it('normalizes mapped and ported addresses', () => {
    expect(normalizeIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeIp('192.0.2.1:5555')).toBe('192.0.2.1');
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(normalizeIp('nope')).toBeNull();
  });
});

describe('the floor reports its sexual criterion, and only that', () => {
  let flags: SexualFloorFlag[];
  beforeEach(() => { resetSexualFloorSink(); flags = []; setSexualFloorHandler(f => flags.push(f)); });
  afterEach(() => resetSexualFloorSink());

  it('a sexual breach is reported with its label and origin; violence is not', () => {
    expect(floorBackstop(`${FIXTURE} ${VIOLENCE}`, { label: 'narration', origin: 'ai' })).toHaveLength(2);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ items: [FIXTURE], detector: 'backstop', label: 'narration', origin: 'ai' });
    expect(flags[0]!.passage).toContain(VIOLENCE);
  });
  it('one text with many flagged sentences files ONE flag listing them all, with a bounded passage', () => {
    const filler = 'The lantern flickers over the long quiet road. '.repeat(400);
    const many = Array.from({ length: 30 }, (_, i) => `TEST FIXTURE ${i}: the word sexual near the word child.`);
    floorBackstop(`${filler}${many.join(' ')}${filler}`, { label: 'a dm-chat message', origin: 'human' });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.items).toHaveLength(30);
    expect(flags[0]!.passage!.length).toBeLessThanOrEqual(4100);
  });
  it('withoutFloorBreaches reports under its label, and its log line withholds the text', () => {
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try { withoutFloorBreaches(`${FIXTURE} ${VIOLENCE}`, {}, 'thought (Pip)'); } finally { console.warn = orig; }
    expect(flags[0]!.label).toBe('thought (Pip)');
    expect(lines.join('\n')).not.toContain('the word sexual');
    expect(lines.join('\n')).toContain('[withheld: child-safety evidence');
    // The violence line (not a sexual flag) is still logged as it was.
    expect(lines.join('\n')).toContain(VIOLENCE);
  });
  it('sexualFloorSentences is pure', () => {
    expect(sexualFloorSentences(FIXTURE)).toEqual([FIXTURE]);
    expect(flags).toHaveLength(0);
  });
  it('the judge\'s floor_sexual phrases are read, and must be in the text', () => {
    const v = parseToneVerdict('{"verdict":"flag","phrases":[],"floor":[],"floor_sexual":["the word sexual", "not there"]}', FIXTURE);
    expect(v?.floorSexual).toEqual(['the word sexual']);
    expect(v?.floor).toEqual(['the word sexual']);
  });
  it('gateGentleTone files the judge\'s sexual-floor phrases', async () => {
    const judge = async () => ({ flagged: true, phrases: ['near the word'], floor: ['near the word'], floorSexual: ['near the word'] });
    await gateGentleTone({ kind: 'narration', first: 'A quiet scene, near the word.', textOf: v => v, regenerate: async () => 'A quiet scene.', soften: v => v, judge, label: 'scene 1' });
    expect(flags.some(f => f.detector === 'judge' && f.items[0] === 'near the word' && f.label.includes('scene 1'))).toBe(true);
  });
  it('a throwing handler never breaks the game', () => {
    setSexualFloorHandler(() => { throw new Error('boom'); });
    expect(() => floorBackstop(FIXTURE)).not.toThrow();
  });
});

describe('log redaction', () => {
  beforeEach(() => resetSexualFloorSink());
  it('withholds exactly what was reported, and nothing else', () => {
    noteSexualFloor({ items: [FIXTURE], detector: 'backstop', label: 'x', origin: 'ai' });
    expect(redactLog(FIXTURE)).toMatch(/^\[withheld: child-safety evidence [0-9a-f]{12}\]$/);
    expect(redactLog(`  ${FIXTURE.toUpperCase()} `)).toContain('[withheld'); // normalised exact match
    // Unrelated lines, and lines that merely contain or are contained in it, are untouched.
    expect(redactLog('[tone-gate] narration: ok (12ms)')).toBe('[tone-gate] narration: ok (12ms)');
    expect(redactLog(`prefix ${FIXTURE}`)).toBe(`prefix ${FIXTURE}`);
    expect(redactLog('the word sexual')).toBe('the word sexual');
  });
  it('short strings are never stored or withheld, so a player cannot hide common words', () => {
    noteSexualFloor({ items: ['the child', 'and'], detector: 'backstop', label: 'x', origin: 'human' });
    expect(isWithheld('the child')).toBe(false);
    expect(redactLog('and')).toBe('and');
  });
  it('call sites withhold the truncated forms logs print', () => {
    const long = 'TEST FIXTURE: a long flagged sentence, the word sexual near the word child, that runs on well past one hundred and sixty characters so that a log line would only ever print a prefix of it.';
    noteSexualFloor({ items: [long], detector: 'backstop', label: 'x', origin: 'ai' });
    expect(isWithheld(long.slice(0, 160))).toBe(true);
    expect(isWithheld(long.slice(0, 80))).toBe(true);
  });
  it('the global console filter withholds an exact flagged sentence, and leaves unrelated lines with common words alone', () => {
    noteSexualFloor({ items: [FIXTURE], detector: 'backstop', label: 'x', origin: 'ai' });
    const seen: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { seen.push(a.join(' ')); };
    try {
      installLogRedaction();
      console.log(`[llm-client] reply: The room is quiet. ${FIXTURE} The lamp burns.`);
      console.log(`[dm] "${FIXTURE}"`);
      console.log('[game-loop] the child near the word sexual education poster is fine: the word child appears.');
      console.log('[tone-gate] narration: ok (12ms)');
    } finally { console.log = orig; }
    expect(seen[0]).not.toContain('the word sexual near');
    expect(seen[0]).toContain('The room is quiet.');
    expect(seen[1]).not.toContain('the word sexual near');
    expect(seen[2]).toBe('[game-loop] the child near the word sexual education poster is fine: the word child appears.');
    expect(seen[3]).toBe('[tone-gate] narration: ok (12ms)');
    expect(redactLine('and the child')).toBe('and the child');
  });
  it('long content is matched by its capped normal form', () => {
    const long = `TEST FIXTURE ${'x'.repeat(5000)}`;
    noteSexualFloor({ items: [long], detector: 'backstop', label: 'x', origin: 'ai' });
    expect(isWithheld(long)).toBe(true);
  });
  it('passageWindow keeps only the text around the flagged items', () => {
    const p = `${'a'.repeat(3000)} FLAGGED ITEM ${'b'.repeat(3000)}`;
    const w = passageWindow(p, ['FLAGGED ITEM']);
    expect(w).toContain('FLAGGED ITEM');
    expect(w.length).toBeLessThan(900);
  });
});

function body(over: Partial<EvidenceBody> = {}): EvidenceBody {
  return { source: 'whispers', content: FIXTURE, context: [], categories: ['sexual/minors'], gameRef: 'whispers:g', ipAddress: '203.0.113.9', userAgent: 'UA', identifiers: [], incidentAt: 1, externalRef: 'ref1', ...over };
}

describe('the outbox', () => {
  let db: Database.Database;
  beforeEach(() => { db = memDb(); });

  it('stores the case encrypted, delivers it, and deletes it only on a 2xx', async () => {
    expect(enqueueEvidence(db, body(), 'tok', 0)).toBe(true);
    expect(enqueueEvidence(db, body(), 'tok', 0)).toBe(false); // idempotent
    const row = db.prepare('SELECT payload, key_id FROM child_safety_outbox').get() as { payload: string; key_id: string };
    expect(row.payload).not.toContain('sexual');
    expect(row.key_id).not.toBe('none');

    const sent: Array<{ url: string; init: RequestInit }> = [];
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    let r = await deliverDue(db, { url: 'http://ri/ingest', token: 'tok', fetchImpl: down, timeoutMs: 1000 }, 0);
    expect(r).toMatchObject({ delivered: 0, failed: 1, pending: 1 });
    const next = (db.prepare('SELECT next_attempt_at, attempts FROM child_safety_outbox').get() as { next_attempt_at: number; attempts: number });
    expect(next.attempts).toBe(1);
    expect(next.next_attempt_at).toBe(backoffMs(1));

    const err500 = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    r = await deliverDue(db, { url: 'http://ri/ingest', token: 'tok', fetchImpl: err500, timeoutMs: 1000 }, backoffMs(1));
    expect(r.pending).toBe(1);

    const ok = (async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response(JSON.stringify({ caseId: 'case-1', created: true }), { status: 201 }); }) as unknown as typeof fetch;
    r = await deliverDue(db, { url: 'http://ri/ingest', token: 'tok', fetchImpl: ok, timeoutMs: 1000 }, 10 * 60 * 60 * 1000);
    expect(r).toMatchObject({ delivered: 1, pending: 0, caseIds: ['case-1'] });
    expect((sent[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(sent[0]!.init.body as string)).toMatchObject({ source: 'whispers', content: FIXTURE, externalRef: 'ref1', categories: ['sexual/minors'] });
  });

  it('keeps a case queued while no token is configured, and delivers it once there is one', async () => {
    enqueueEvidence(db, body(), undefined, 0);
    const ok = (async () => new Response('{}', { status: 201 })) as unknown as typeof fetch;
    let r = await deliverDue(db, { url: 'u', token: undefined, fetchImpl: ok, timeoutMs: 1000 }, 0);
    expect(r.pending).toBe(1);
    r = await deliverDue(db, { url: 'u', token: 'tok', fetchImpl: ok, timeoutMs: 1000 }, 10 * 60 * 60 * 1000);
    expect(r.pending).toBe(0);
  });

  it('a flag over RI\'s limit is capped, its original\'s hash recorded, and the original kept in the row', async () => {
    const big = 'F'.repeat(INGEST_CONTENT_CAP + 1000);
    enqueueEvidence(db, body({ content: big, externalRef: 'big' }), 'tok', 0);
    const row = db.prepare("SELECT full_content FROM child_safety_outbox WHERE external_ref = 'big'").get() as { full_content: string };
    expect(row.full_content).toBeTruthy();
    expect(row.full_content).not.toContain('FFFF'); // sealed
    const sent: any[] = [];
    const ok = (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(init.body as string)); return new Response('{}', { status: 201 }); }) as unknown as typeof fetch;
    await deliverDue(db, { url: 'u', token: 'tok', fetchImpl: ok, timeoutMs: 1000 }, 1);
    expect(sent[0].content.length).toBe(INGEST_CONTENT_CAP);
    expect(sent[0].contentTruncated).toEqual({ originalSha256: createHash('sha256').update(big).digest('hex'), originalLength: big.length });
  });

  it('a permanent 4xx dead-letters the record and alerts; 429 and 5xx keep retrying', async () => {
    const alerts: string[] = [];
    setDeadLetterAlert(async t => { alerts.push(t); });
    enqueueEvidence(db, body({ externalRef: 'bad' }), 'tok', 0);
    enqueueEvidence(db, body({ externalRef: 'busy' }), 'tok', 0);
    const f = (async (_u: string, init: RequestInit) => new Response('{}', { status: JSON.parse(init.body as string).externalRef === 'bad' ? 422 : 429 })) as unknown as typeof fetch;
    const r = await deliverDue(db, { url: 'u', token: 'tok', fetchImpl: f, timeoutMs: 1000 }, 1);
    expect(r).toMatchObject({ deadLettered: 1, failed: 1, pending: 1 });
    const dead = db.prepare("SELECT dead_at, last_error FROM child_safety_outbox WHERE external_ref = 'bad'").get() as { dead_at: number; last_error: string };
    expect(dead.dead_at).toBe(1);
    expect(dead.last_error).toBe('HTTP 422');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('dead-lettered');
    expect(alerts[0]).not.toContain('sexual'); // no content in alerts
    // The dead record is never retried.
    const r2 = await deliverDue(db, { url: 'u', token: 'tok', fetchImpl: f, timeoutMs: 1000 }, 1e15);
    expect(r2.deadLettered).toBe(0);
  });

  it('production with no key: nothing is persisted unencrypted, the worker does not start, and an alert goes out', () => {
    const saved = { VITEST: process.env.VITEST, NODE_ENV: process.env.NODE_ENV };
    delete process.env.VITEST;
    process.env.NODE_ENV = 'production';
    const alerts: string[] = [];
    setDeadLetterAlert(async t => { alerts.push(t); });
    try {
      expect(() => enqueueEvidence(db, body({ externalRef: 'nokey' }), undefined, 0)).toThrow(EvidenceKeyMissingError);
      expect((db.prepare('SELECT COUNT(*) AS c FROM child_safety_outbox').get() as { c: number }).c).toBe(0);
      const stop = startOutbox(db, { url: 'u', token: undefined, fetchImpl: fetch, timeoutMs: 1000 }, 60_000);
      stop();
      expect(alerts.some(a => a.includes('evidence path is OFF'))).toBe(true);
    } finally {
      process.env.VITEST = saved.VITEST;
      process.env.NODE_ENV = saved.NODE_ENV;
    }
  });

  it('backoff is capped at six hours', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(40)).toBe(6 * 60 * 60 * 1000);
  });
});

describe('who the case names', () => {
  let db: Database.Database;
  const seat = (token: string, name: string, isHost: boolean, characterId: string | null = null) =>
    db.prepare('INSERT INTO campaign_sessions (token, campaign_id, join_code, player_name, is_host, character_id) VALUES (?, ?, ?, ?, ?, ?)').run(token, 'g1', 'JC', name, isHost ? 1 : 0, characterId);
  const flag: SexualFloorFlag = { items: [FIXTURE], detector: 'backstop', label: 'test', origin: 'ai' };
  beforeEach(() => {
    resetRateLimit();
    db = memDb();
    db.prepare("INSERT INTO campaigns (id, join_code, name, dm_preset, system_id) VALUES ('g1', 'JC', 'G', 'chronicler', 'fate-core')").run();
    seat('host-tok', 'Ann', true);
    seat('p2-tok', 'Bo', false, 'char-bo');
    recordSeatIp(db, { campaignId: 'g1', sessionToken: 'host-tok', ip: '203.0.113.1', userAgent: 'UA-host', event: 'create' }, 1000);
    recordSeatIp(db, { campaignId: 'g1', sessionToken: 'p2-tok', ip: '203.0.113.2', userAgent: 'UA-bo', event: 'join' }, 2000);
  });

  it('a socket message: the sending seat, with that request\'s IP; the co-player is a participant', () => {
    const b = buildEvidence(db, { flag, scope: { campaignId: () => 'g1', seatToken: () => 'p2-tok', requestIp: '198.51.100.7', userAgent: 'UA-now' } });
    expect(b.ipAddress).toBe('198.51.100.7');
    expect(b.userAgent).toBe('UA-now');
    expect(b.gameRef).toBe('whispers:g1');
    expect(b.identifiers).toContainEqual({ kind: 'whispers_seat', value: seatId('p2-tok'), verified: true });
    expect(b.identifiers).toContainEqual({ kind: 'whispers_player_name', value: 'Bo', verified: false });
    expect(b.identifiers).toContainEqual({ kind: 'ip', value: '203.0.113.2', verified: true });
    expect(b.identifiers).toContainEqual({ kind: 'whispers_seat', value: seatId('host-tok'), verified: true, role: 'participant' });
    expect(b.identifiers).toContainEqual({ kind: 'ip', value: '203.0.113.1', verified: true, role: 'participant' });
    expect(b.identifiers).toContainEqual({ kind: 'whispers_player_name', value: 'Ann', verified: false, role: 'participant' });
    // The raw session token never leaves the server.
    expect(JSON.stringify(b)).not.toContain('p2-tok');
    expect(b.reason).toContain('Flagged sender: a player seat');
  });

  it('a character\'s turn: the seat that plays the character, at its latest IP', () => {
    const b = buildEvidence(db, { flag, scope: { campaignId: () => 'g1', characterId: 'char-bo' } });
    expect(b.ipAddress).toBe('203.0.113.2');
    expect(b.userAgent).toBe('UA-bo');
    expect(b.identifiers.find(i => i.kind === 'ip' && i.value === '203.0.113.1')?.role).toBe('participant');
  });

  it('the DM\'s narration at a table of two: no sender — no headline IP, everyone a participant', () => {
    const b = buildEvidence(db, { flag, scope: { campaignId: () => 'g1' } });
    expect(b.ipAddress).toBeNull();
    expect(b.identifiers.every(i => i.role === 'participant')).toBe(true);
    expect(b.reason).toContain('unknown');
  });

  it('the DM\'s narration with one human seat: that seat', () => {
    db.prepare("DELETE FROM campaign_sessions WHERE token = 'p2-tok'").run();
    db.prepare("DELETE FROM child_safety_ip_log WHERE session_token = 'p2-tok'").run();
    const b = buildEvidence(db, { flag, scope: { campaignId: () => 'g1' } });
    expect(b.ipAddress).toBe('203.0.113.1');
  });

  it('the scope flows through async work, and a character scope overrides the loop scope', async () => {
    const seen: Array<string | null> = [];
    await runInSafetyScope({ campaignId: () => 'g1' }, async () => {
      await new Promise(r => setTimeout(r, 1));
      await withSafetyScope({ characterId: 'char-bo' }, async () => {
        const b = fileFlag(db, flag);
        seen.push(b?.ipAddress ?? null);
      });
      seen.push(fileFlag(db, { ...flag, items: [`${FIXTURE} 2`] })?.ipAddress ?? null);
    });
    expect(seen).toEqual(['203.0.113.2', null]);
    expect((db.prepare('SELECT COUNT(*) AS c FROM child_safety_outbox').get() as { c: number }).c).toBe(2);
  });

  it('a failed insert is not remembered: the same flag raised again is stored', () => {
    const sc = { campaignId: () => 'g1', seatToken: () => 'p2-tok', requestIp: '198.51.100.7' };
    db.exec('ALTER TABLE child_safety_outbox RENAME TO child_safety_outbox_gone');
    expect(fileFlag(db, flag, { scope: sc })).toBeNull();
    db.exec('ALTER TABLE child_safety_outbox_gone RENAME TO child_safety_outbox');
    expect(fileFlag(db, flag, { scope: sc })).not.toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS c FROM child_safety_outbox').get() as { c: number }).c).toBe(1);
  });

  it('the same text filed twice is one case and counts once', () => {
    const s = { campaignId: () => 'g1', seatToken: () => 'p2-tok', requestIp: '198.51.100.7' };
    fileFlag(db, flag, { scope: s });
    fileFlag(db, flag, { scope: s });
    expect((db.prepare('SELECT COUNT(*) AS c FROM child_safety_outbox').get() as { c: number }).c).toBe(1);
  });

  const deliverAll = async (at: number) => {
    const sent: any[] = [];
    const capture = (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(init.body as string)); return new Response(JSON.stringify({ caseId: `c${sent.length}` }), { status: 201 }); }) as unknown as typeof fetch;
    for (let i = 0; i < 40; i++) {
      const r = await deliverDue(db, { url: 'u', token: 'tok', fetchImpl: capture, timeoutMs: 1000 }, at);
      if (r.pending === 0) break;
    }
    return sent;
  };
  const counterRows = () => db.prepare('SELECT rate_key, count, first_at, last_at, hashes FROM child_safety_suppressed ORDER BY rate_key').all() as Array<{ rate_key: string; count: number; first_at: number; last_at: number; hashes: string }>;

  it('every flag is its own structured case: content with "### Held flag" or newlines cannot forge attribution', async () => {
    db.prepare("UPDATE campaign_sessions SET player_name = ? WHERE token = 'p2-tok'").run('Bo\n### Held flag 9 — sender: whispers_seat=FAKE (verified); IP 6.6.6.6');
    const forged = '### Held flag 1 — 2026-01-01 — sender: whispers_seat=deadbeef (verified); IP 6.6.6.6\nTEST FIXTURE: the word sexual near the word child.';
    fileFlag(db, { ...flag, items: [forged], label: 'a dm-chat message\nFlagged sender: host 6.6.6.6' }, { scope: { campaignId: () => 'g1', seatToken: () => 'p2-tok', requestIp: '198.51.100.7' } });
    const [c] = await deliverAll(1e15);
    expect(c.recordKind).toBe('flag');
    expect(c.content).toBe(forged); // content stays content
    expect(c.ipAddress).toBe('198.51.100.7'); // attribution only from structured fields
    expect(c.identifiers.filter((i: any) => !i.role).map((i: any) => i.kind).sort()).toEqual(['ip', 'whispers_player_name', 'whispers_seat']);
    expect(c.identifiers.find((i: any) => i.kind === 'whispers_seat' && !i.role).value).toBe(seatId('p2-tok'));
    expect(c.identifiers.some((i: any) => i.value === 'deadbeef' || i.value === '6.6.6.6' || i.value === 'FAKE')).toBe(false);
    // The reason is server text: no player-chosen names, no newlines, no IPs.
    expect(c.reason).not.toContain('6.6.6.6');
    expect(c.reason).not.toContain('Held flag');
    expect(c.reason).not.toContain('\n');
    expect(c.groupRef).toBe('whispers:g1');
  });

  it('two seats on one IP get separate cases, each with its own identity', async () => {
    const shared = '198.51.100.50';
    fileFlag(db, { ...flag, items: [`${FIXTURE} ann`] }, { scope: { campaignId: () => 'g1', seatToken: () => 'host-tok', requestIp: shared } });
    fileFlag(db, { ...flag, items: [`${FIXTURE} bo`] }, { scope: { campaignId: () => 'g1', seatToken: () => 'p2-tok', requestIp: shared } });
    const sent = await deliverAll(1e15);
    expect(sent).toHaveLength(2);
    const sender = (b: any) => b.identifiers.find((i: any) => i.kind === 'whispers_seat' && !i.role).value;
    expect(sender(sent.find(b => b.content.endsWith('ann')))).toBe(seatId('host-tok'));
    expect(sender(sent.find(b => b.content.endsWith('bo')))).toBe(seatId('p2-tok'));
  });

  it('a burst over the cap creates no extra cases: a counter per key, with hashes, filed under that key\'s own identity', async () => {
    const sc = { campaignId: () => 'g1', seatToken: () => 'p2-tok', requestIp: '198.51.100.7' };
    const t0 = 5 * RATE_WINDOW_MS + 1000;
    for (let i = 0; i < RATE_MAX + 30; i++) fileFlag(db, { ...flag, items: [`${FIXTURE} #${i}`] }, { scope: sc, now: t0 + i });
    expect((db.prepare('SELECT COUNT(*) AS c FROM child_safety_outbox').get() as { c: number }).c).toBe(RATE_MAX);
    const counters = counterRows();
    expect(counters.map(r => [r.rate_key.split(':')[0], r.count])).toEqual([['ip', 30], ['seat', 30]]);
    expect(JSON.parse(counters[0]!.hashes)).toHaveLength(30 - 10); // the first 10 are kept in full
    expect(JSON.parse(counters[0]!.hashes)[0]).toMatch(/^[0-9a-f]{64}$/);
    // Before the window closes only the cases go out; after, one burst record per key.
    expect(await deliverAll(t0 + 100)).toHaveLength(RATE_MAX);
    const bursts = await deliverAll(6 * RATE_WINDOW_MS);
    expect(bursts).toHaveLength(2);
    expect(bursts.every(b => b.recordKind === 'suppressed_burst' && b.content === undefined && b.suppressedBurst.count === 30)).toBe(true);
    for (const b of bursts) {
      expect(b.suppressedBurst.samples).toHaveLength(10);
      expect(b.suppressedBurst.sha256).toHaveLength(20);
      expect(b.suppressedBurst.samples[0].content).toBe(`${FIXTURE} #${RATE_MAX}`);
      expect(b.suppressedBurst.samples[0].identifiers.find((i: any) => i.kind === 'whispers_seat' && !i.role).value).toBe(seatId('p2-tok'));
      expect(b.suppressedBurst.samples[0].ipAddress).toBe('198.51.100.7');
    }
    const seatBurst = bursts.find(b => b.suppressedBurst.key.kind === 'whispers_seat');
    const ipBurst = bursts.find(b => b.suppressedBurst.key.kind === 'ip');
    expect(seatBurst.suppressedBurst.key.value).toBe(seatId('p2-tok'));
    expect(seatBurst.identifiers).toEqual([{ kind: 'whispers_seat', value: seatId('p2-tok'), verified: true }, { kind: 'whispers_player_name', value: 'Bo', verified: false }]);
    expect(seatBurst.ipAddress).toBeNull();
    expect(ipBurst.ipAddress).toBe('198.51.100.7');
    expect(ipBurst.identifiers).toEqual([{ kind: 'ip', value: '198.51.100.7', verified: true }]);
    expect(counterRows()).toHaveLength(0);
  });

  it('a seat under its cap behind an IP that is over keeps its seat: counted on both keys, each sample with its own sender', async () => {
    const shared = '198.51.100.51';
    const t0 = 5 * RATE_WINDOW_MS + 1000;
    for (let i = 0; i < RATE_MAX; i++) fileFlag(db, { ...flag, items: [`${FIXTURE} ann #${i}`] }, { scope: { campaignId: () => 'g1', seatToken: () => 'host-tok', requestIp: shared }, now: t0 + i });
    fileFlag(db, { ...flag, items: [`${FIXTURE} bo`] }, { scope: { campaignId: () => 'g1', seatToken: () => 'p2-tok', requestIp: shared }, now: t0 + 500 });
    expect(counterRows().map(r => [r.rate_key.split(':')[0], r.count])).toEqual([['ip', 1], ['seat', 1]]);
    const bursts = (await deliverAll(6 * RATE_WINDOW_MS)).filter(b => b.recordKind === 'suppressed_burst');
    expect(bursts).toHaveLength(2);
    const ipBurst = bursts.find(b => b.suppressedBurst.key.kind === 'ip');
    const seatBurst = bursts.find(b => b.suppressedBurst.key.kind === 'whispers_seat');
    expect(ipBurst.identifiers).toEqual([{ kind: 'ip', value: shared, verified: true }]);
    expect(seatBurst.suppressedBurst.key.value).toBe(seatId('p2-tok')); // Bo's own seat, never Ann's
    for (const b of [ipBurst, seatBurst]) {
      const sender = b.suppressedBurst.samples[0].identifiers.find((i: any) => i.kind === 'whispers_seat' && !i.role);
      expect(sender.value).toBe(seatId('p2-tok'));
      expect(b.suppressedBurst.samples[0].content).toBe(`${FIXTURE} bo`);
    }
  });

  it('a 1,000-flag burst: the counter is right and keeps at most 200 hashes', () => {
    const sc = { campaignId: () => 'g1', seatToken: () => 'p2-tok', requestIp: '198.51.100.7' };
    const t0 = 5 * RATE_WINDOW_MS + 1000;
    for (let i = 0; i < 1000; i++) fileFlag(db, { ...flag, items: [`${FIXTURE} burst #${i}`] }, { scope: sc, now: t0 + i });
    expect((db.prepare('SELECT COUNT(*) AS c FROM child_safety_outbox').get() as { c: number }).c).toBe(RATE_MAX);
    for (const r of counterRows()) {
      expect(r.count).toBe(1000 - RATE_MAX);
      expect(JSON.parse(r.hashes)).toHaveLength(200); // after the 10 kept in full
      expect(r.first_at).toBe(t0 + RATE_MAX);
      expect(r.last_at).toBe(t0 + 999);
    }
  });

  it('the IP log keeps one row per seat, IP and user agent, and purges after 90 days', () => {
    recordSeatIp(db, { campaignId: 'g1', sessionToken: 'host-tok', ip: '203.0.113.1', userAgent: 'UA-host', event: 'whisper' }, 5000);
    expect((db.prepare("SELECT COUNT(*) AS c FROM child_safety_ip_log WHERE session_token = 'host-tok'").get() as { c: number }).c).toBe(1);
    expect(purgeIpLog(db, 5000 + 91 * 86_400_000)).toBe(2);
  });
});
