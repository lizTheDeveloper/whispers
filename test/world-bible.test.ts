import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE campaigns (id TEXT PRIMARY KEY, join_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, dm_preset TEXT NOT NULL, scenario_id TEXT, system_id TEXT NOT NULL DEFAULT 'fate-core', host_user_id TEXT, house_rules TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE entities (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), type TEXT NOT NULL, name TEXT NOT NULL, description TEXT, disposition TEXT, alive INTEGER NOT NULL DEFAULT 1, location_id TEXT, metadata TEXT);
    CREATE TABLE locations (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), name TEXT NOT NULL, description TEXT, terrain TEXT, connections TEXT, coords TEXT);
    CREATE TABLE items (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), name TEXT NOT NULL, description TEXT, properties TEXT, holder_id TEXT, location_id TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), scene_number INTEGER NOT NULL, description TEXT NOT NULL, participants TEXT, outcome TEXT);
    CREATE TABLE relationships (campaign_id TEXT NOT NULL REFERENCES campaigns(id), entity_a_id TEXT NOT NULL, entity_b_id TEXT NOT NULL, type TEXT NOT NULL, description TEXT, PRIMARY KEY (campaign_id, entity_a_id, entity_b_id));
    CREATE TABLE characters (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), player_user_id TEXT, definition TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  db.prepare('INSERT INTO campaigns (id, join_code, name, dm_preset) VALUES (?, ?, ?, ?)').run('c1', 'ABC123', 'Test', 'chronicler');
  return db;
}

describe('world bible', () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('adds and retrieves a location', async () => {
    const { WorldBible } = await import('../src/server/world-bible.js');
    const wb = new WorldBible(db);
    wb.addLocation({ id: 'loc1', campaignId: 'c1', name: 'The Rusty Anchor', description: 'A dockside tavern', terrain: 'urban', connections: [], coords: null });
    const loc = wb.getLocationByName('c1', 'The Rusty Anchor');
    expect(loc).not.toBeNull();
    expect(loc!.description).toBe('A dockside tavern');
  });

  it('adds entity at a location and retrieves by location', async () => {
    const { WorldBible } = await import('../src/server/world-bible.js');
    const wb = new WorldBible(db);
    wb.addLocation({ id: 'loc1', campaignId: 'c1', name: 'Tavern', description: null, terrain: null, connections: [], coords: null });
    wb.addEntity({ id: 'e1', campaignId: 'c1', type: 'npc', name: 'Marcus', description: 'A merchant', disposition: 'friendly', alive: true, locationId: 'loc1', metadata: {} });
    const entities = wb.getEntitiesForLocation('c1', 'loc1');
    expect(entities).toHaveLength(1);
    expect(entities[0]!.name).toBe('Marcus');
  });

  it('generates a summary for DM context', async () => {
    const { WorldBible } = await import('../src/server/world-bible.js');
    const wb = new WorldBible(db);
    wb.addLocation({ id: 'loc1', campaignId: 'c1', name: 'Tavern', description: 'A smoky tavern', terrain: 'urban', connections: [], coords: null });
    wb.addEntity({ id: 'e1', campaignId: 'c1', type: 'npc', name: 'Marcus', description: 'A merchant', disposition: 'friendly', alive: true, locationId: 'loc1', metadata: {} });
    const summary = wb.getSummary('c1', 'loc1');
    expect(summary).toContain('Tavern');
    expect(summary).toContain('Marcus');
  });

  it('applies a structured diff', async () => {
    const { WorldBible } = await import('../src/server/world-bible.js');
    const wb = new WorldBible(db);
    wb.applyDiff('c1', {
      newLocations: [{ name: 'River Styx', description: 'A dark river', terrain: 'water' }],
      newEntities: [{ name: 'Ferryman', type: 'npc', description: 'Rows the boat', disposition: 'neutral' }],
      newItems: [],
      newEvents: [{ sceneNumber: 1, description: 'Party reached the river', participants: [], outcome: null }],
      newRelationships: [],
    });
    const loc = wb.getLocationByName('c1', 'River Styx');
    expect(loc).not.toBeNull();
  });

  it('returns personalized character relationships', async () => {
    const { WorldBible } = await import('../src/server/world-bible.js');
    const wb = new WorldBible(db);
    db.prepare("INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)").run('ch1', 'c1', '{"name":"Elara Thorne"}', '{}');
    wb.addEntity({ id: 'npc1', campaignId: 'c1', type: 'npc', name: 'Cassius', description: 'A spy', disposition: 'suspicious', alive: true, locationId: null, metadata: {} });
    wb.addRelationship({ campaignId: 'c1', entityAId: 'ch1', entityBId: 'npc1', type: 'distrust', description: 'Elara suspects Cassius poisoned the wine' });
    wb.addRelationship({ campaignId: 'c1', entityAId: 'npc1', entityBId: 'ch1', type: 'manipulates', description: 'Cassius is playing Elara for information' });
    const rels = wb.getCharacterRelationships('c1', 'ch1', 'Elara Thorne');
    expect(rels).toContain('You distrust Cassius');
    expect(rels).toContain('You are manipulated by Cassius');
  });

  it('deduplicates entities by name on diff apply', async () => {
    const { WorldBible } = await import('../src/server/world-bible.js');
    const wb = new WorldBible(db);
    wb.addEntity({ id: 'e1', campaignId: 'c1', type: 'npc', name: 'Marcus', description: 'A merchant', disposition: 'friendly', alive: true, locationId: null, metadata: {} });
    wb.applyDiff('c1', {
      newLocations: [],
      newEntities: [{ name: 'Marcus', type: 'npc', description: 'A wealthy merchant', disposition: 'friendly' }],
      newItems: [],
      newEvents: [],
      newRelationships: [],
    });
    const all = db.prepare('SELECT * FROM entities WHERE campaign_id = ?').all('c1') as any[];
    expect(all).toHaveLength(1);
    expect(all[0].description).toBe('A wealthy merchant');
  });
});
