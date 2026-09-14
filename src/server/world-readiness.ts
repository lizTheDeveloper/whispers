import type { TableRole, WorldReadiness, WorldReadinessItem, WorldSeed } from '../shared/types.js';

export const MIN_INFLUENCES = 3;
export const MIN_SEED_LOCATIONS = 2;
export const MIN_SEED_NPCS = 2;
export const MIN_SEED_HOOKS = 1;
const MAX_INFLUENCES = 12;
const MAX_INFLUENCE_LEN = 120;

/**
 * Influences arrive from a model, so treat the value as untrusted shape as
 * well as untrusted content: anything that is not an array of strings becomes
 * an empty list rather than throwing, and the result is capped so a runaway
 * generation cannot flood every downstream prompt.
 */
export function normalizeInfluences(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim().slice(0, MAX_INFLUENCE_LEN);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_INFLUENCES) break;
  }
  return out;
}

/** A named-entity slot (location/NPC) is only real once it has a non-empty name, not merely a slot in the array. */
function hasNonEmptyName(entry: unknown): boolean {
  return typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string'
    && (entry as { name: string }).name.trim().length > 0;
}

function isNonEmptyString(entry: unknown): boolean {
  return typeof entry === 'string' && entry.trim().length > 0;
}

function countValid(arr: unknown, isValid: (entry: unknown) => boolean): number {
  return Array.isArray(arr) ? arr.filter(isValid).length : 0;
}

/**
 * Counts VALID entries, not array length: a model can produce an array of
 * the right length full of nulls or empty objects, and that must not read
 * as a finished world. A false "not ready" is an annoyance; a false "ready"
 * opens the table onto a world that does not exist.
 */
function seedIsComplete(seed: WorldSeed | null): boolean {
  if (!seed) return false;
  if (typeof seed.premise !== 'string' || !seed.premise.trim()) return false;
  if (countValid(seed.locations, hasNonEmptyName) < MIN_SEED_LOCATIONS) return false;
  if (countValid(seed.npcs, hasNonEmptyName) < MIN_SEED_NPCS) return false;
  if (countValid(seed.plotHooks, isNonEmptyString) < MIN_SEED_HOOKS) return false;
  return true;
}

/**
 * The single definition of "this world is ready to open the table".
 *
 * A model may propose that setup is finished; this decides. Every unmet item
 * is reported at once so the host sees the whole remaining list and the model
 * can be told everything it still needs in one turn.
 */
export function checkWorldReadiness(input: {
  influences: string[];
  seed: WorldSeed | null;
  dmInstructions: string | null;
  hostTableRole: TableRole | null;
  seedAccepted: boolean;
}): WorldReadiness {
  const unmet: WorldReadinessItem[] = [];
  const detail: string[] = [];

  // Count only entries that are actually non-empty after trimming: this must
  // stay safe even when called with input that never passed through
  // normalizeInfluences (a later call site could feed it directly).
  const influenceCount = input.influences.filter(isNonEmptyString).length;
  if (influenceCount < MIN_INFLUENCES) {
    unmet.push('influences');
    detail.push(`Name at least ${MIN_INFLUENCES} stylistic influences (currently ${influenceCount}).`);
  }
  if (!seedIsComplete(input.seed)) {
    unmet.push('seed');
    detail.push(`The world needs a premise, at least ${MIN_SEED_LOCATIONS} locations, ${MIN_SEED_NPCS} NPCs, and ${MIN_SEED_HOOKS} plot hook.`);
  }
  if (typeof input.dmInstructions !== 'string' || !input.dmInstructions.trim()) {
    unmet.push('dmInstructions');
    detail.push('The DM still needs a summary of how you want this game run.');
  }
  if (input.hostTableRole !== 'dm' && input.hostTableRole !== 'player') {
    unmet.push('tableRole');
    detail.push('Choose whether you are running this game or playing in it.');
  }
  if (!input.seedAccepted) {
    unmet.push('seedAccepted');
    detail.push('Review and accept the starting world.');
  }

  return { ready: unmet.length === 0, unmet, detail };
}
