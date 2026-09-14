import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorldSeed } from '../src/shared/types.js';

let dataDir: string;
let db: any;
let seedWorld: typeof import('../src/server/world-seed.js').seedWorld;
let loadStockScenario: typeof import('../src/server/world-seed.js').loadStockScenario;
let WorldBible: typeof import('../src/server/world-bible.js').WorldBible;
let createRoom: typeof import('../src/server/room.js').createRoom;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-seed-'));
  process.env.DATA_DIR = dataDir;
  // DATA_DIR is bound at module load, so import after setting it.
  const dbMod = await import('../src/server/db.js');
  db = dbMod.getDb();
  ({ seedWorld, loadStockScenario } = await import('../src/server/world-seed.js'));
  ({ WorldBible } = await import('../src/server/world-bible.js'));
  ({ createRoom } = await import('../src/server/room.js'));
});

afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

const seed: WorldSeed = {
  premise: 'A lighthouse keeps something out.',
  locations: [
    { name: 'The Lamp Room', description: 'Glass and salt.', terrain: 'interior' },
    { name: 'The Tidal Stair', description: 'Cut into rock.', terrain: 'coast' },
  ],
  npcs: [{ name: 'Maren', description: 'The keeper.', disposition: 'wary', motivation: 'Keep the light lit.' }],
  plotHooks: ['The relief keeper never arrived.'],
  items: [{ name: 'Brass Key', description: 'Warm to the touch.' }],
};

describe('seedWorld', () => {
  it('writes locations, npcs, items, and hooks into the world bible', () => {
    const { campaignId } = createRoom(db, { name: 'Seed Test', dmPreset: 'chronicler', systemId: 'fate-core' });
    seedWorld(db, campaignId, seed);

    const wb = new WorldBible(db);
    const names = wb.getAllLocationNames(campaignId);
    expect(names).toContain('The Lamp Room');
    expect(names).toContain('The Tidal Stair');

    const summary = wb.getSummary(campaignId);
    expect(summary).toContain('Maren');
    expect(summary).toContain('relief keeper');
  });

  it('is idempotent — seeding twice does not duplicate locations, entities, items, or events', () => {
    const once = createRoom(db, { name: 'Once', dmPreset: 'chronicler', systemId: 'fate-core' });
    seedWorld(db, once.campaignId, seed);
    const countRows = (table: string, campaignId: string): number =>
      (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE campaign_id = ?`).get(campaignId) as { c: number }).c;
    const baseline = {
      locations: countRows('locations', once.campaignId),
      entities: countRows('entities', once.campaignId),
      items: countRows('items', once.campaignId),
      events: countRows('events', once.campaignId),
    };

    const twice = createRoom(db, { name: 'Twice', dmPreset: 'chronicler', systemId: 'fate-core' });
    seedWorld(db, twice.campaignId, seed);
    seedWorld(db, twice.campaignId, seed);

    expect(countRows('locations', twice.campaignId)).toBe(baseline.locations);
    expect(countRows('entities', twice.campaignId)).toBe(baseline.entities);
    expect(countRows('items', twice.campaignId)).toBe(baseline.items);
    // Events have no name-based dedup in applyDiff (unlike locations/entities/
    // items) — a seeded plot hook always has outcome: null, so applyDiff's
    // reconciliation branch (guarded by `if (evt.outcome)`) never runs for it
    // and every re-seed would otherwise add a fresh duplicate row.
    expect(countRows('events', twice.campaignId)).toBe(baseline.events);

    const wb = new WorldBible(db);
    expect(wb.getAllLocationNames(twice.campaignId).length).toBe(2);
  });

  it('creates locations even though in-play updates cannot', () => {
    // seedWorld must pass allowNewLocations: true; play-time diffs must not.
    const { campaignId } = createRoom(db, { name: 'Allow', dmPreset: 'chronicler', systemId: 'fate-core' });
    seedWorld(db, campaignId, seed);
    expect(new WorldBible(db).getAllLocationNames(campaignId).length).toBeGreaterThan(0);
  });

  it('does not resurrect a plot hook that was already resolved', () => {
    // The idempotency test above only proves dedup while every event is
    // still unresolved. accept-world-seed and regenerate-world-seed both
    // create genuine re-seed paths now, and by the time a host re-seeds, a
    // plot hook from the first pass may already have been played out and
    // resolved. Deduping only against UNRESOLVED events (the old behaviour)
    // would let that same hook come back as a brand-new open thread on a
    // second seedWorld call — worse than the duplicate-row bug the original
    // dedup existed to prevent.
    const { campaignId } = createRoom(db, { name: 'Resolved Dedup', dmPreset: 'chronicler', systemId: 'fate-core' });
    seedWorld(db, campaignId, seed);

    const countEvents = (): number =>
      (db.prepare('SELECT COUNT(*) AS c FROM events WHERE campaign_id = ?').get(campaignId) as { c: number }).c;
    const before = countEvents();

    db.prepare("UPDATE events SET outcome = 'The keeper was found, safe.' WHERE campaign_id = ?").run(campaignId);

    seedWorld(db, campaignId, seed);

    expect(countEvents()).toBe(before);
  });
});

describe('loadStockScenario', () => {
  it('returns null for an unknown or malformed id', () => {
    expect(loadStockScenario('no-such-scenario')).toBeNull();
    expect(loadStockScenario('../../../etc/passwd')).toBeNull();
  });
});
