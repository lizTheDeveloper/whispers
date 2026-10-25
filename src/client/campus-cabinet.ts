/**
 * Web cabinets: Whispers framed inside campus.themultiverse.school. Active
 * only when the page is in a frame AND its URL has `?cabinet=campus`;
 * otherwise this does nothing at all.
 *
 * Handshake (the cabinet contract): post `mg:ready` to the campus origin;
 * campus answers with `mg:pass` (a 5-minute signed launch pass); trade it at
 * POST <base>/api/campus-pass for an opaque identity token, keep that in
 * memory (+ sessionStorage for reloads), post `mg:signed-in`, and send the
 * identity with create/join/rejoin. The pass itself is never stored or logged.
 */
export const CAMPUS_ORIGIN = 'https://campus.themultiverse.school';
export const GAME_KEY = 'whispers';
const STORAGE_KEY = 'whispers:campus-identity:v1';
const REASK_MIN_MS = 60_000;

export function isCabinetMode(win: Window = window): boolean {
  let framed: boolean;
  try { framed = win.self !== win.top; } catch { framed = true; }
  if (!framed) return false;
  try { return new URLSearchParams(win.location.search).get('cabinet') === 'campus'; } catch { return false; }
}

export interface SignedIn { identity: string; name: string }

export interface CabinetDeps {
  win?: Window;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class CampusCabinet {
  readonly active: boolean;
  identity: string | null = null;
  name: string | null = null;
  private readonly win: Window;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly listeners = new Set<(s: SignedIn) => void>();
  private lastReadyAt = -Infinity;
  private started = false;

  constructor(deps: CabinetDeps = {}) {
    this.win = deps.win ?? window;
    this.fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.now = deps.now ?? (() => Date.now());
    this.active = isCabinetMode(this.win);
  }

  start(): void {
    if (!this.active || this.started) return;
    this.started = true;
    this.restore();
    this.win.addEventListener('message', (e: MessageEvent) => { this.onMessage(e); });
    this.postReady();
  }

  onSignedIn(cb: (s: SignedIn) => void): void { this.listeners.add(cb); }

  /** The server no longer knows our identity: drop it, and ask campus for a fresh pass (≤ once a minute). */
  identityUnknown(): void {
    if (!this.active) return;
    this.identity = null;
    try { this.win.sessionStorage.removeItem(STORAGE_KEY); } catch { /* storage blocked */ }
    if (this.now() - this.lastReadyAt >= REASK_MIN_MS) this.postReady();
  }

  private post(type: 'mg:ready' | 'mg:signed-in'): void {
    try { this.win.parent.postMessage({ type, v: 1, game: GAME_KEY }, CAMPUS_ORIGIN); } catch { /* parent gone */ }
  }

  private postReady(): void {
    this.lastReadyAt = this.now();
    this.post('mg:ready');
  }

  private onMessage(e: MessageEvent): void {
    if (e.origin !== CAMPUS_ORIGIN || e.source !== this.win.parent) return;
    const d = e.data as { type?: unknown; v?: unknown; pass?: unknown } | null;
    if (!d || typeof d !== 'object' || d.type !== 'mg:pass' || d.v !== 1 || typeof d.pass !== 'string') return;
    void this.exchange(d.pass);
  }

  private apiUrl(): string {
    const base = (this.win.location.pathname || '/').replace(/\/+$/, '');
    return `${base}/api/campus-pass`;
  }

  private async exchange(pass: string): Promise<void> {
    try {
      const res = await this.fetchImpl(this.apiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass }),
      });
      if (!res.ok) return; // refused: play goes on signed out
      const body = await res.json() as { identity?: unknown; name?: unknown };
      if (typeof body.identity !== 'string' || typeof body.name !== 'string') return;
      this.identity = body.identity;
      this.name = body.name;
      try { this.win.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ identity: body.identity, name: body.name })); } catch { /* storage blocked */ }
      this.post('mg:signed-in');
      const s = { identity: body.identity, name: body.name };
      this.listeners.forEach(l => { try { l(s); } catch (err) { console.error('[cabinet] sign-in listener failed', err); } });
    } catch {
      // network failure: play goes on signed out
    }
  }

  private restore(): void {
    try {
      const raw = this.win.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const v = JSON.parse(raw) as { identity?: unknown; name?: unknown };
      if (typeof v.identity === 'string' && typeof v.name === 'string') { this.identity = v.identity; this.name = v.name; }
    } catch { /* storage blocked or corrupt */ }
  }
}

let activeCabinet: CampusCabinet | null = null;
/** The page's cabinet (set once by main.ts). */
export function setActiveCabinet(c: CampusCabinet | null): void { activeCabinet = c; }
export function getActiveCabinet(): CampusCabinet | null { return activeCabinet; }
