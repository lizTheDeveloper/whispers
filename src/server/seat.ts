import type { TableRole } from '../shared/types.js';

export type { TableRole };

/** The subset of a connection this module needs. */
export interface Seat {
  isOwner: boolean;
}

/**
 * `isHost` used to mean three things at once: who owns the room, who authors
 * the world, and who has DM authority at the table. The first two always
 * belong to the person who created the game. The third is a choice they make
 * once, and it is the only one that can move.
 */

/** Campaigns created before roles existed have none; they behaved as host-DM. */
export function effectiveTableRole(hostTableRole: TableRole | null | undefined): TableRole {
  return hostTableRole === 'player' ? 'player' : 'dm';
}

/** World setup belongs to the owner whatever they do at the table. */
export function isWorldAuthor(seat: Seat | null | undefined): boolean {
  return seat?.isOwner === true;
}

/** Approving characters, injecting, overriding — only when they are running it. */
export function hasDmAuthority(
  seat: Seat | null | undefined,
  hostTableRole: TableRole | null | undefined,
): boolean {
  if (seat?.isOwner !== true) return false;
  return effectiveTableRole(hostTableRole) === 'dm';
}
