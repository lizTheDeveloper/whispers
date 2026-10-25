// @vitest-environment jsdom
// Web cabinets, client side: the postMessage handshake with campus, the pass
// exchange, and what changes on screen in cabinet mode (and nothing outside it).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CampusCabinet, isCabinetMode, CAMPUS_ORIGIN, setActiveCabinet, campusPassUrl } from '../src/client/campus-cabinet.js';
import { renderLobby } from '../src/client/lobby.js';

type Listener = (e: { origin: string; source: unknown; data: unknown }) => void;

function fakeWin(opts: { framed?: boolean; search?: string; pathname?: string } = {}) {
  const parent = { postMessage: vi.fn() };
  const listeners: Listener[] = [];
  const store = new Map<string, string>();
  const self = {};
  const win = {
    self,
    top: opts.framed === false ? self : {},
    parent,
    location: { search: opts.search ?? '?cabinet=campus', pathname: opts.pathname ?? '/whispers/', origin: GAME_ORIGIN },
    addEventListener: (type: string, l: Listener) => { if (type === 'message') listeners.push(l); },
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
  };
  const deliver = (e: { origin: string; source: unknown; data: unknown }) => listeners.forEach(l => l(e));
  return { win: win as unknown as Window, parent, deliver, store };
}

const GAME_ORIGIN = 'https://play.multiversegames.ai';
const PASS_MSG = { type: 'mg:pass', v: 1, pass: 'cps.claims.sig' };
const okFetch = () => vi.fn(async () => new Response(JSON.stringify({ identity: 'a'.repeat(64), name: 'Test Student', sub: '@test-student:themultiverse.school' }), { status: 200 }));
const flush = () => new Promise(r => setTimeout(r, 0));

describe('isCabinetMode', () => {
  it('needs both a frame and ?cabinet=campus', () => {
    expect(isCabinetMode(fakeWin().win)).toBe(true);
    expect(isCabinetMode(fakeWin({ framed: false }).win)).toBe(false);
    expect(isCabinetMode(fakeWin({ search: '' }).win)).toBe(false);
    expect(isCabinetMode(fakeWin({ search: '?cabinet=other' }).win)).toBe(false);
    // jsdom's own window is not framed
    expect(isCabinetMode()).toBe(false);
  });
});

describe('CampusCabinet', () => {
  it('posts mg:ready to the campus origin only, on start', () => {
    const { win, parent } = fakeWin();
    new CampusCabinet({ win, fetchImpl: okFetch() }).start();
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'mg:ready', v: 1, game: 'whispers' }, CAMPUS_ORIGIN);
  });

  it('outside a frame posts nothing and listens to nothing', async () => {
    const { win, parent, deliver } = fakeWin({ framed: false });
    const fetchImpl = okFetch();
    const c = new CampusCabinet({ win, fetchImpl });
    c.start();
    deliver({ origin: CAMPUS_ORIGIN, source: parent, data: PASS_MSG });
    await flush();
    expect(c.active).toBe(false);
    expect(parent.postMessage).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores a pass from the wrong origin, the wrong window, or of the wrong shape', async () => {
    const { win, parent, deliver } = fakeWin();
    const fetchImpl = okFetch();
    new CampusCabinet({ win, fetchImpl }).start();
    deliver({ origin: 'https://evil.example', source: parent, data: PASS_MSG });
    deliver({ origin: CAMPUS_ORIGIN, source: {}, data: PASS_MSG });
    deliver({ origin: CAMPUS_ORIGIN, source: parent, data: { type: 'mg:pass', v: 2, pass: 'cps.x.y' } });
    deliver({ origin: CAMPUS_ORIGIN, source: parent, data: { type: 'mg:pass', v: 1, pass: 42 } });
    deliver({ origin: CAMPUS_ORIGIN, source: parent, data: 'mg:pass' });
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exchanges a pass, keeps the identity, and posts mg:signed-in', async () => {
    const { win, parent, deliver, store } = fakeWin();
    const fetchImpl = okFetch();
    const c = new CampusCabinet({ win, fetchImpl });
    const signedIn = vi.fn();
    c.onSignedIn(signedIn);
    c.start();
    deliver({ origin: CAMPUS_ORIGIN, source: parent, data: PASS_MSG });
    await flush(); await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GAME_ORIGIN}/whispers/api/campus-pass`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ pass: 'cps.claims.sig' });
    expect(c.identity).toBe('a'.repeat(64));
    expect(c.name).toBe('Test Student');
    expect(signedIn).toHaveBeenCalledWith({ identity: 'a'.repeat(64), name: 'Test Student' });
    expect(parent.postMessage).toHaveBeenLastCalledWith({ type: 'mg:signed-in', v: 1, game: 'whispers' }, CAMPUS_ORIGIN);
    expect(store.size).toBe(1);
    // a reload in the same tab keeps it
    const again = new CampusCabinet({ win, fetchImpl });
    again.start();
    expect(again.identity).toBe('a'.repeat(64));
  });

  it('never sends the pass off its own origin, whatever the page path', async () => {
    for (const pathname of ['//evil.example/x', '//evil.example', '/\\evil.example/x', '///evil.example/']) {
      const { win, parent, deliver } = fakeWin({ pathname });
      const fetchImpl = okFetch();
      new CampusCabinet({ win, fetchImpl }).start();
      deliver({ origin: CAMPUS_ORIGIN, source: parent, data: PASS_MSG });
      await flush(); await flush();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const url = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
      expect(url.origin, pathname).toBe(GAME_ORIGIN);
      expect(url.pathname).toBe('/whispers/api/campus-pass');
    }
  });

  it('campusPassUrl stays on the origin for any base, or refuses', () => {
    expect(campusPassUrl(GAME_ORIGIN)).toBe(`${GAME_ORIGIN}/whispers/api/campus-pass`);
    for (const base of ['//evil.example/', '/\\evil.example/', 'https://evil.example/', '///evil.example']) {
      const u = campusPassUrl(GAME_ORIGIN, base);
      expect(u === null || new URL(u).origin === GAME_ORIGIN, base).toBe(true);
    }
  });

  it('holds a rejoin until the pass exchange settles, or 3 s at most', async () => {
    vi.useFakeTimers();
    try {
      const { win, parent, deliver } = fakeWin();
      const c = new CampusCabinet({ win, fetchImpl: okFetch() });
      c.start();
      const gate = c.whenSettled()!;
      let released = false;
      void gate.then(() => { released = true; });
      await vi.advanceTimersByTimeAsync(100);
      expect(released).toBe(false);
      deliver({ origin: CAMPUS_ORIGIN, source: parent, data: PASS_MSG });
      await vi.advanceTimersByTimeAsync(10);
      expect(released).toBe(true);
      expect(c.identity).toBe('a'.repeat(64));
      expect(c.whenSettled()).toBeNull(); // signed in: nothing to wait for
      // no pass ever arrives: released after 3 s
      const other = new CampusCabinet({ win: fakeWin().win, fetchImpl: okFetch() });
      other.start();
      let late = false;
      void other.whenSettled()!.then(() => { late = true; });
      await vi.advanceTimersByTimeAsync(2900);
      expect(late).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(late).toBe(true);
      // outside a cabinet: never held
      expect(new CampusCabinet({ win: fakeWin({ framed: false }).win }).whenSettled()).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('a refused pass leaves play signed out', async () => {
    const { win, parent, deliver } = fakeWin();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'pass_refused' }), { status: 400 }));
    const c = new CampusCabinet({ win, fetchImpl });
    c.start();
    deliver({ origin: CAMPUS_ORIGIN, source: parent, data: PASS_MSG });
    await flush(); await flush();
    expect(c.identity).toBeNull();
    expect(parent.postMessage).toHaveBeenCalledTimes(1); // only the ready
  });

  it('survives storage that throws', async () => {
    const { win, parent, deliver } = fakeWin();
    (win as unknown as { sessionStorage: unknown }).sessionStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    const c = new CampusCabinet({ win, fetchImpl: okFetch() });
    c.start();
    deliver({ origin: CAMPUS_ORIGIN, source: parent, data: PASS_MSG });
    await flush(); await flush();
    expect(c.identity).toBe('a'.repeat(64));
  });

  it('an identity the server no longer knows: dropped, and mg:ready again at most once a minute', () => {
    const { win, parent, store } = fakeWin();
    store.set('whispers:campus-identity:v1', JSON.stringify({ identity: 'b'.repeat(64), name: 'Old' }));
    let now = 1_000_000;
    const c = new CampusCabinet({ win, fetchImpl: okFetch(), now: () => now });
    c.start();
    expect(c.identity).toBe('b'.repeat(64));
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    now += 1000;
    c.identityUnknown();
    expect(c.identity).toBeNull();
    expect(store.size).toBe(0);
    expect(parent.postMessage).toHaveBeenCalledTimes(1); // the boot ready was under a minute ago
    now += 60_000;
    c.identityUnknown();
    expect(parent.postMessage).toHaveBeenCalledTimes(2);
    expect(parent.postMessage).toHaveBeenLastCalledWith({ type: 'mg:ready', v: 1, game: 'whispers' }, CAMPUS_ORIGIN);
    now += 10_000;
    c.identityUnknown();
    expect(parent.postMessage).toHaveBeenCalledTimes(2);
  });
});

describe('the lobby in and out of cabinet mode', () => {
  const ws = { on: () => {}, onStatus: () => {}, send: vi.fn(), connected: true } as any;
  beforeEach(() => { setActiveCabinet(null); document.body.innerHTML = '<div id="app"></div>'; });

  it('outside cabinet mode: the support links are there and the name is empty', () => {
    const root = document.getElementById('app')!;
    renderLobby(root, ws);
    expect(root.querySelector('.support-links')).not.toBeNull();
    expect((root.querySelector('#player-name') as HTMLInputElement).value).toBe('');
  });

  it('in cabinet mode: no real-money ask, and the name is pre-filled from campus until the player edits it', async () => {
    const { win, parent, deliver } = fakeWin();
    const c = new CampusCabinet({ win, fetchImpl: okFetch() });
    setActiveCabinet(c);
    c.start();
    const root = document.getElementById('app')!;
    renderLobby(root, ws);
    expect(root.querySelector('.support-links')).toBeNull();
    expect(root.innerHTML).not.toContain('stripe');
    deliver({ origin: CAMPUS_ORIGIN, source: parent, data: PASS_MSG });
    await flush(); await flush();
    const input = root.querySelector('#player-name') as HTMLInputElement;
    expect(input.value).toBe('Test Student');
    // a later re-render keeps the campus name too
    renderLobby(root, ws);
    expect((root.querySelector('#player-name') as HTMLInputElement).value).toBe('Test Student');
  });
});

describe('the socket carries the campus identity', () => {
  it('on create, join and rejoin only, and only when there is one', async () => {
    const { withCampusIdentity } = await import('../src/client/ws-client.js');
    const create = { type: 'create', name: 'G', dmPreset: 'chronicler', systemId: 'fate-core', scenarioId: null, houseRules: null } as const;
    expect(withCampusIdentity(create, 'c'.repeat(64))).toEqual({ ...create, campusIdentity: 'c'.repeat(64) });
    expect(withCampusIdentity({ type: 'join', joinCode: 'ABCDEF', playerName: 'P' }, 'c'.repeat(64))).toMatchObject({ campusIdentity: 'c'.repeat(64) });
    expect(withCampusIdentity({ type: 'rejoin', joinCode: 'ABCDEF', sessionToken: 't' }, 'c'.repeat(64))).toMatchObject({ campusIdentity: 'c'.repeat(64) });
    expect(withCampusIdentity({ type: 'whisper', text: 'hi' }, 'c'.repeat(64))).toEqual({ type: 'whisper', text: 'hi' });
    expect(withCampusIdentity(create, null)).toEqual(create);
  });
});

describe('WsClient holds a rejoin behind the cabinet gate', () => {
  it('sends the rejoin, with the identity, only once the gate settles', async () => {
    const { WsClient } = await import('../src/client/ws-client.js');
    const sent: string[] = [];
    const client = new WsClient();
    (client as any).ws = { readyState: WebSocket.OPEN, send: (d: string) => sent.push(d) };
    let identity: string | null = null;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    client.setCampusIdentitySource(() => identity);
    client.setRejoinGate(() => (identity ? null : gate));
    client.send({ type: 'rejoin', joinCode: 'ABCDEF', sessionToken: 't' });
    client.send({ type: 'whisper', text: 'hi' });
    expect(sent.map(d => JSON.parse(d).type)).toEqual(['whisper']);
    identity = 'd'.repeat(64);
    release();
    await flush();
    expect(JSON.parse(sent[1]!)).toEqual({ type: 'rejoin', joinCode: 'ABCDEF', sessionToken: 't', campusIdentity: 'd'.repeat(64) });
  });
});
