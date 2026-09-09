import type { GamePhase } from '../shared/types.js';

/**
 * Whispers has no accounts, so "the games you're in" lives in localStorage.
 * The sessionToken is what lets the server hand you back your DM chair after a
 * refresh — without it the room has no way to tell you apart from a new player.
 */
export interface StoredSession {
  campaignId: string;
  joinCode: string;
  gameName: string;
  role: 'dm' | 'player';
  playerName: string;
  sessionToken: string;
  phase: GamePhase;
  lastSeen: number;
}

const KEY = 'whispers:sessions:v1';
const MAX_SESSIONS = 20;

export function loadSessions(): StoredSession[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as StoredSession[])
      .filter(s => s && typeof s.joinCode === 'string' && typeof s.sessionToken === 'string')
      .sort((a, b) => b.lastSeen - a.lastSeen);
  } catch {
    return [];
  }
}

/**
 * Keyed by role as well as code: one browser can legitimately hold both a DM
 * seat and a player seat in the same game (that is how you test your own game),
 * and the #/dm/ vs #/play/ route says which one you are asking for.
 */
const sameSeat = (a: StoredSession, joinCode: string, role: StoredSession['role']) =>
  a.joinCode === joinCode.toUpperCase() && a.role === role;

export function getStoredSession(joinCode: string, role: StoredSession['role']): StoredSession | null {
  return loadSessions().find(s => sameSeat(s, joinCode, role)) ?? null;
}

export function saveSession(session: StoredSession): void {
  try {
    const others = loadSessions().filter(s => !sameSeat(s, session.joinCode, session.role));
    const next = [session, ...others].slice(0, MAX_SESSIONS);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private browsing / storage full — the in-page session still works, you
    // just won't be offered the game again next visit.
  }
}

export function removeSession(joinCode: string, role: StoredSession['role']): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadSessions().filter(s => !sameSeat(s, joinCode, role))));
  } catch { /* see saveSession */ }
}

/* ---------------------------------------------------------------- routing --
 * Hash routes, not path routes: the WebSocket URL and the material-upload URL
 * are both derived from location.pathname, so a path like /whispers/dm/ABC123
 * would send the socket to /whispers/dm/ABC123/ws and break the connection.
 */

export type Route =
  | { view: 'lobby' }
  | { view: 'dm'; joinCode: string }
  | { view: 'play'; joinCode: string };

export function parseRoute(hash: string = location.hash): Route {
  const m = /^#\/(dm|play)\/([A-Za-z0-9]{4,12})$/.exec(hash);
  if (!m) return { view: 'lobby' };
  return { view: m[1] as 'dm' | 'play', joinCode: m[2]!.toUpperCase() };
}

export function setRoute(route: Route): void {
  const hash = route.view === 'lobby' ? '' : `#/${route.view}/${route.joinCode}`;
  if (location.hash === hash) return;
  history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
}

function urlFor(view: 'dm' | 'play', joinCode: string): string {
  return `${location.origin}${location.pathname}${location.search}#/${view}/${joinCode}`;
}

/** Bookmark this and you get your DM chair back. */
export const dmUrl = (joinCode: string): string => urlFor('dm', joinCode);
/** Share this with players — it prefills the join code. */
export const playUrl = (joinCode: string): string => urlFor('play', joinCode);
