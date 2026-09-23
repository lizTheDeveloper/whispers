import type { GamePhase, TableRole } from '../shared/types.js';

/**
 * The cache key `renderFor` uses to decide whether the screen needs to
 * change at all. Pulled out as a pure function (no DOM, no WsClient) so it
 * can be unit-tested directly — this project has no jsdom configured, and
 * everything else in this file touches the DOM.
 *
 * Must encode every field that changes which view is shown. It used to omit
 * table role: a host who switched from 'dm' to 'player' (or back) while the
 * join code and phase stayed the same produced the same key, so `renderFor`
 * silently kept whatever was already on screen instead of re-routing them.
 */
export function renderKey(owner: boolean, tableRole: TableRole | null, joinCode: string, phase: GamePhase): string {
  return `${owner ? 'dm' : 'play'}:${tableRole ?? 'none'}:${joinCode}:${phase}`;
}

export type ClientScreen = 'game-view' | 'dm-lobby' | 'waiting-room' | 'character-creator';

/**
 * Which screen `renderFor` mounts for a given seat state. renderKey above
 * decides *whether* anything changed; this decides *what* to show, and lets
 * renderFor notice when a key change still lands on the screen already up.
 *
 * That matters for the DM lobby: a host choosing a table role during the
 * lobby phase gets a fresh room-joined (new tableRole → new renderKey) but
 * stays on the DM lobby either way. Remounting it there wiped #dm-chat-log
 * — the host's whole setup conversation — with nothing sent to refill it.
 */
export function screenFor(owner: boolean, tableRole: TableRole | null, phase: GamePhase): ClientScreen {
  if (phase === 'playing' || phase === 'ended') return 'game-view';
  // The owner runs world setup from the DM lobby regardless of which table
  // role they've chosen — table role only matters for where they land once
  // the table actually opens. A host who chose to play routes like any
  // other player from here on.
  if (owner && (phase === 'lobby' || tableRole !== 'player')) return 'dm-lobby';
  if (!owner && phase === 'lobby') return 'waiting-room';
  return 'character-creator';
}
