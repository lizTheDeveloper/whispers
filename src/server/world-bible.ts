import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Entity, Location, Item, GameEvent, Relationship } from '../shared/types.js';

export interface WorldBibleDiff {
  newLocations: Array<{ name: string; description: string | null; terrain: string | null }>;
  newEntities: Array<{ name: string; type: string; description: string | null; disposition: string | null }>;
  newItems: Array<{ name: string; description: string | null; properties?: Record<string, unknown>; holderId?: string; locationId?: string }>;
  newEvents: Array<{ sceneNumber: number; description: string; participants: string[]; outcome: string | null }>;
  newRelationships: Array<{ entityAName: string; entityBName: string; type: string; description: string | null }>;
}

function genId(): string { return randomBytes(16).toString('hex'); }

export class WorldBible {
  constructor(private db: Database.Database) {}

  addLocation(loc: Location): void {
    this.db.prepare(`INSERT INTO locations (id, campaign_id, name, description, terrain, connections, coords) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(loc.id, loc.campaignId, loc.name, loc.description, loc.terrain, JSON.stringify(loc.connections), loc.coords ? JSON.stringify(loc.coords) : null);
  }

  addEntity(ent: Entity): void {
    this.db.prepare(`INSERT INTO entities (id, campaign_id, type, name, description, disposition, alive, location_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ent.id, ent.campaignId, ent.type, ent.name, ent.description, ent.disposition, ent.alive ? 1 : 0, ent.locationId, JSON.stringify(ent.metadata));
  }

  addItem(item: Item): void {
    this.db.prepare(`INSERT INTO items (id, campaign_id, name, description, properties, holder_id, location_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(item.id, item.campaignId, item.name, item.description, JSON.stringify(item.properties), item.holderId, item.locationId);
  }

  addEvent(evt: GameEvent): void {
    this.db.prepare(`INSERT INTO events (id, campaign_id, scene_number, description, participants, outcome) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(evt.id, evt.campaignId, evt.sceneNumber, evt.description, JSON.stringify(evt.participants), evt.outcome);
  }

  addRelationship(rel: Relationship): void {
    this.db.prepare(`INSERT OR REPLACE INTO relationships (campaign_id, entity_a_id, entity_b_id, type, description) VALUES (?, ?, ?, ?, ?)`)
      .run(rel.campaignId, rel.entityAId, rel.entityBId, rel.type, rel.description);
  }

  getLocationByName(campaignId: string, name: string): Location | null {
    const row = this.db.prepare('SELECT * FROM locations WHERE campaign_id = ? AND name = ? COLLATE NOCASE').get(campaignId, name) as any;
    if (!row) return null;
    return { id: row.id, campaignId: row.campaign_id, name: row.name, description: row.description, terrain: row.terrain, connections: JSON.parse(row.connections ?? '[]'), coords: row.coords ? JSON.parse(row.coords) : null };
  }

  getEntitiesForLocation(campaignId: string, locationId: string): Entity[] {
    const rows = this.db.prepare('SELECT * FROM entities WHERE campaign_id = ? AND location_id = ? AND alive = 1').all(campaignId, locationId) as any[];
    return rows.map(r => ({ id: r.id, campaignId: r.campaign_id, type: r.type, name: r.name, description: r.description, disposition: r.disposition, alive: !!r.alive, locationId: r.location_id, metadata: JSON.parse(r.metadata ?? '{}') }));
  }

  getSummary(campaignId: string, locationId?: string): string {
    const parts: string[] = [];
    if (locationId) {
      const loc = this.db.prepare('SELECT * FROM locations WHERE id = ?').get(locationId) as any;
      if (loc) parts.push(`Current location: ${loc.name}${loc.description ? ' — ' + loc.description : ''}`);
      const entities = this.getEntitiesForLocation(campaignId, locationId);
      if (entities.length > 0) parts.push('Present: ' + entities.map(e => `${e.name} (${e.type}, ${e.disposition ?? 'unknown disposition'})`).join(', '));
    }
    const locs = this.db.prepare('SELECT name, description FROM locations WHERE campaign_id = ? ORDER BY rowid DESC LIMIT 12').all(campaignId) as any[];
    if (locs.length > 0) parts.push('Known locations: ' + locs.map((l: any) => `${l.name}${l.description ? ' — ' + l.description : ''}`).join('; '));

    const npcs = this.db.prepare('SELECT name, type, disposition, description FROM entities WHERE campaign_id = ? AND alive = 1 ORDER BY rowid DESC LIMIT 15').all(campaignId) as any[];
    if (npcs.length > 0) {
      parts.push('Known NPCs/creatures: ' + npcs.map((n: any) => `${n.name} (${n.type}${n.disposition ? ', ' + n.disposition : ''})`).join('; '));
    }

    const rels = this.db.prepare(`SELECT r.type, r.description, e1.name as a_name, e2.name as b_name
      FROM relationships r
      JOIN entities e1 ON r.entity_a_id = e1.id
      JOIN entities e2 ON r.entity_b_id = e2.id
      WHERE r.campaign_id = ? ORDER BY r.rowid DESC LIMIT 10`).all(campaignId) as any[];
    if (rels.length > 0) {
      parts.push('Relationships: ' + rels.map((r: any) => `${r.a_name} ${r.type} ${r.b_name}${r.description ? ' — ' + r.description : ''}`).join('; '));
    }

    const currentScene = this.db.prepare('SELECT MAX(scene_number) as s FROM events WHERE campaign_id = ?').get(campaignId) as any;
    const maxScene = currentScene?.s ?? 0;

    const events = this.db.prepare('SELECT description, outcome, scene_number FROM events WHERE campaign_id = ? ORDER BY scene_number DESC LIMIT 12').all(campaignId) as any[];
    const resolved = events.filter((e: any) => e.outcome);
    const unresolved = events.filter((e: any) => !e.outcome && maxScene - e.scene_number < 5);
    const stale = events.filter((e: any) => !e.outcome && maxScene - e.scene_number >= 5);

    if (stale.length > 0) {
      this.db.prepare('UPDATE events SET outcome = ? WHERE campaign_id = ? AND outcome IS NULL AND scene_number <= ?')
        .run('(faded from narrative focus)', campaignId, maxScene - 5);
    }

    if (unresolved.length > 0) {
      parts.push('UNRESOLVED THREADS (advance these): ' + unresolved.map((e: any) => e.description).join('; '));
    }
    if (resolved.length > 0) {
      parts.push('Story so far: ' + resolved.slice(0, 8).map((e: any) => `${e.description} → ${e.outcome}`).join('. '));
    }

    const unusedItems = this.db.prepare('SELECT name, description FROM items WHERE campaign_id = ? AND holder_id IS NULL AND location_id IS NULL').all(campaignId) as any[];
    if (unusedItems.length > 0) {
      parts.push('Unclaimed items: ' + unusedItems.map((i: any) => i.name).join(', '));
    }

    return parts.join('\n\n') || 'No world knowledge yet.';
  }

  getCompactSummary(campaignId: string): string {
    const parts: string[] = [];
    const npcs = this.db.prepare('SELECT name, type, disposition FROM entities WHERE campaign_id = ? AND alive = 1 LIMIT 8').all(campaignId) as any[];
    if (npcs.length > 0) {
      parts.push('People nearby: ' + npcs.map((n: any) => `${n.name} (${n.disposition ?? n.type})`).join(', '));
    }
    const items = this.db.prepare('SELECT name FROM items WHERE campaign_id = ? AND holder_id IS NULL AND location_id IS NULL LIMIT 5').all(campaignId) as any[];
    if (items.length > 0) {
      parts.push('Available items: ' + items.map((i: any) => i.name).join(', '));
    }
    const currentScene = this.db.prepare('SELECT MAX(scene_number) as s FROM events WHERE campaign_id = ?').get(campaignId) as any;
    const maxScene = currentScene?.s ?? 0;
    const unresolved = this.db.prepare('SELECT description FROM events WHERE campaign_id = ? AND outcome IS NULL AND scene_number > ? LIMIT 3').all(campaignId, maxScene - 5) as any[];
    if (unresolved.length > 0) {
      parts.push('Open threads: ' + unresolved.map((e: any) => e.description).join('; '));
    }
    return parts.join('\n') || '';
  }

  applyDiff(campaignId: string, diff: WorldBibleDiff): void {
    const tx = this.db.transaction(() => {
      for (const loc of diff.newLocations) {
        const existing = this.getLocationByName(campaignId, loc.name);
        if (existing) {
          if (loc.description) this.db.prepare('UPDATE locations SET description = ? WHERE id = ?').run(loc.description, existing.id);
        } else {
          this.addLocation({ id: genId(), campaignId, name: loc.name, description: loc.description, terrain: loc.terrain, connections: [], coords: null });
        }
      }
      for (const ent of diff.newEntities) {
        const existing = this.db.prepare('SELECT id FROM entities WHERE campaign_id = ? AND name = ? COLLATE NOCASE').get(campaignId, ent.name) as any;
        if (existing) {
          if (ent.description) this.db.prepare('UPDATE entities SET description = ? WHERE id = ?').run(ent.description, existing.id);
        } else {
          this.addEntity({ id: genId(), campaignId, type: ent.type as Entity['type'], name: ent.name, description: ent.description, disposition: ent.disposition, alive: true, locationId: null, metadata: {} });
        }
      }
      for (const item of diff.newItems) {
        this.addItem({ id: genId(), campaignId, name: item.name, description: item.description, properties: item.properties ?? {}, holderId: item.holderId ?? null, locationId: item.locationId ?? null });
      }
      for (const evt of diff.newEvents) {
        this.addEvent({ id: genId(), campaignId, sceneNumber: evt.sceneNumber, description: evt.description, participants: evt.participants, outcome: evt.outcome });
      }
      for (const rel of (diff.newRelationships ?? [])) {
        const entityA = this.db.prepare('SELECT id FROM entities WHERE campaign_id = ? AND name = ? COLLATE NOCASE').get(campaignId, rel.entityAName) as any;
        const entityB = this.db.prepare('SELECT id FROM entities WHERE campaign_id = ? AND name = ? COLLATE NOCASE').get(campaignId, rel.entityBName) as any;
        if (entityA && entityB) {
          this.addRelationship({ campaignId, entityAId: entityA.id, entityBId: entityB.id, type: rel.type, description: rel.description });
        }
      }
    });
    tx();
  }
}
