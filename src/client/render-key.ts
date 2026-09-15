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
