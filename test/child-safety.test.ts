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
import { setSexualFloorHandler, resetSexualFloorSink, noteSexualFloor, redactLine, redactLog, type SexualFloorFlag } from '../src/server/child-safety/sink.js';
import { enqueueEvidence, deliverDue, backoffMs, type EvidenceBody } from '../src/server/child-safety/outbox.js';
import { ensureChildSafetyTables, buildEvidence, recordSeatIp, runInSafetyScope, withSafetyScope, fileFlag, seatId, purgeIpLog } from '../src/server/child-safety/reporter.js';
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
    expect(flags[0]).toMatchObject({ content: FIXTURE, detector: 'backstop', label: 'narration', origin: 'ai' });
    expect(flags[0]!.passage).toContain(VIOLENCE);
  });
  it('withoutFloorBreaches reports under its label, and its log line withholds the text', () => {
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try { withoutFloorBreaches(FIXTURE, {}, 'thought (Pip)'); } finally { console.warn = orig; }
    expect(flags[0]!.label).toBe('thought (Pip)');
    expect(lines.join('\n')).not.toContain('the word sexual');
    expect(lines.join('\n')).toContain('[withheld: child-safety evidence');
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
    expect(flags.some(f => f.detector === 'judge' && f.content === 'near the word' && f.label.includes('scene 1'))).toBe(true);
  });
  it('a throwing handler never breaks the game', () => {
    setSexualFloorHandler(() => { throw new Error('boom'); });
    expect(() => floorBackstop(FIXTURE)).not.toThrow();
  });
});

describe('log redaction', () => {
  beforeEach(() => resetSexualFloorSink());
  it('withholds reported content wherever a log line carries it, quoted or truncated', () => {
    noteSexualFloor({ content: FIXTURE, detector: 'backstop', label: 'x', origin: 'ai' });
    expect(redactLine(`[floor] x: caught "${FIXTURE}"`)).not.toContain('sexual');
    expect(redactLine(`[floor] x: caught "${FIXTURE.slice(0, 30)}"`)).not.toContain('the word sexual');
    expect(redactLine(`plain ${FIXTURE} trailing`)).not.toContain('sexual');
    expect(redactLine('[tone-gate] narration: ok (12ms)')).toBe('[tone-gate] narration: ok (12ms)');
    expect(redactLog('child')).toBe('child'); // short words are not withheld
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

  it('backoff is capped at six hours', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(40)).toBe(6 * 60 * 60 * 1000);
  });
});

describe('who the case names', () => {
  let db: Database.Database;
  const seat = (token: string, name: string, isHost: boolean, characterId: string | null = null) =>
    db.prepare('INSERT INTO campaign_sessions (token, campaign_id, join_code, player_name, is_host, character_id) VALUES (?, ?, ?, ?, ?, ?)').run(token, 'g1', 'JC', name, isHost ? 1 : 0, characterId);
  const flag: SexualFloorFlag = { content: FIXTURE, detector: 'backstop', label: 'test', origin: 'ai' };
  beforeEach(() => {
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
    expect(b.reason).toContain('player "Bo"');
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
      seen.push(fileFlag(db, { ...flag, content: `${FIXTURE} 2` })?.ipAddress ?? null);
    });
    expect(seen).toEqual(['203.0.113.2', null]);
    expect((db.prepare('SELECT COUNT(*) AS c FROM child_safety_outbox').get() as { c: number }).c).toBe(2);
  });

  it('the IP log keeps one row per seat, IP and user agent, and purges after 90 days', () => {
    recordSeatIp(db, { campaignId: 'g1', sessionToken: 'host-tok', ip: '203.0.113.1', userAgent: 'UA-host', event: 'whisper' }, 5000);
    expect((db.prepare("SELECT COUNT(*) AS c FROM child_safety_ip_log WHERE session_token = 'host-tok'").get() as { c: number }).c).toBe(1);
    expect(purgeIpLog(db, 5000 + 91 * 86_400_000)).toBe(2);
  });
});
