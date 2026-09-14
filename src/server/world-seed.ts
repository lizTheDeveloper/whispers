import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { WorldBible } from './world-bible.js';
import { safeDataFile } from './data-paths.js';
import { WorldSeedSchema } from './agents/schemas.js';
import type { WorldSeed } from '../shared/types.js';

/**
 * Write a seed into the world bible.
 *
 * This is the mapping that used to live inside GameLoop.seedScenario. It moved
 * out so the world can exist before a game starts — a player has to be able to
 * meet the world before they build a character for it. This is the only caller
 * that passes allowNewLocations: true; in-play updates must not create places.
 *
 * Locations, entities, and items are deduped by name inside applyDiff, so
 * re-seeding an identical seed is safe for those categories. Events are not:
 * applyDiff's event-reconciliation branch only runs for events that arrive
 * with an outcome, and a seeded plot hook always has outcome: null, so a
 * second seedWorld call would otherwise add a second, identical event every
 * time. That reconciliation logic is shared with the in-play fact extractor,
 * so rather than touch its semantics, seedWorld does its own dedup here: drop
 * any plot hook whose description already exists for this campaign as an
 * event — resolved or not.
 *
 * Deduping against resolved events too (not just unresolved ones) matters
 * now that accept-world-seed and regenerate-world-seed can call seedWorld
 * more than once for the same campaign: without it, re-seeding could
 * resurrect a plot hook the table already played out and resolved as a
 * brand-new open thread, which is worse than the duplicate-row bug this
 * dedup originally existed to prevent.
 */
export function seedWorld(db: Database.Database, campaignId: string, seed: WorldSeed): void {
  const worldBible = new WorldBible(db);
  const existingEvents = new Set(
    worldBible.getEventDescriptions(campaignId).map(d => d.trim().toLowerCase())
  );
  const newHooks = seed.plotHooks.filter(hook => !existingEvents.has(hook.trim().toLowerCase()));

  worldBible.applyDiff(campaignId, {
    newLocations: seed.locations.map(l => ({ name: l.name, description: l.description, terrain: l.terrain ?? null })),
    newEntities: seed.npcs.map(n => ({
      name: n.name,
      type: 'npc' as const,
      description: n.motivation ? `${n.description} [Motivation: ${n.motivation}]` : n.description,
      disposition: n.disposition ?? null,
    })),
    newItems: seed.items.map(i => ({ name: i.name, description: i.description, properties: {} })),
    newEvents: newHooks.map(hook => ({ sceneNumber: 0, description: hook, participants: [], outcome: null })),
    newRelationships: [],
  }, { allowNewLocations: true });
}

/**
 * A stock scenario is just a pre-written seed. Loading it here means improvised
 * and stock campaigns travel one code path from this point on.
 */
export function loadStockScenario(scenarioId: string): { seed: WorldSeed; openingNarration: string | null } | null {
  const file = safeDataFile('scenarios', scenarioId, '.json');
  if (!file) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    const parsed = WorldSeedSchema.safeParse({
      premise: raw.description ?? raw.name ?? '',
      locations: raw.locations ?? [],
      npcs: raw.npcs ?? [],
      plotHooks: raw.plotHooks ?? [],
      items: raw.items ?? [],
    });
    if (!parsed.success) {
      console.warn(`[world-seed] Scenario ${scenarioId} failed validation:`, parsed.error.issues.map(i => i.path.join('.')).join(', '));
      return null;
    }
    return { seed: parsed.data, openingNarration: typeof raw.openingNarration === 'string' ? raw.openingNarration : null };
  } catch (e) {
    console.warn(`[world-seed] Failed to load scenario ${scenarioId}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

export function getWorldSeed(db: Database.Database, campaignId: string): WorldSeed | null {
  const row = db.prepare('SELECT world_seed FROM campaigns WHERE id = ?').get(campaignId) as any;
  if (!row?.world_seed) return null;
  try {
    const parsed = WorldSeedSchema.safeParse(JSON.parse(row.world_seed));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function setWorldSeed(db: Database.Database, campaignId: string, seed: WorldSeed): void {
  db.prepare("UPDATE campaigns SET world_seed = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(seed), campaignId);
}

export function markSeedAccepted(db: Database.Database, campaignId: string): void {
  db.prepare("UPDATE campaigns SET seed_accepted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(campaignId);
}

export function isSeedAccepted(db: Database.Database, campaignId: string): boolean {
  const row = db.prepare('SELECT seed_accepted_at FROM campaigns WHERE id = ?').get(campaignId) as any;
  return Boolean(row?.seed_accepted_at);
}
