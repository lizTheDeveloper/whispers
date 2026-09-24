import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Entity, Location, Item, GameEvent, Relationship } from '../shared/types.js';

export interface WorldBibleDiff {
  newLocations: Array<{ name: string; description: string | null; terrain: string | null }>;
  newEntities: Array<{ name: string; type: string; description: string | null; disposition: string | null; motivation?: string | null }>;
  newItems: Array<{ name: string; description: string | null; properties?: Record<string, unknown>; holderId?: string; locationId?: string }>;
  newEvents: Array<{ sceneNumber: number; description: string; participants: string[]; outcome: string | null }>;
  newRelationships: Array<{ entityAName: string; entityBName: string; type: string; description: string | null }>;
}

function genId(): string { return randomBytes(16).toString('hex'); }

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Whole-word (letter/digit-bounded) occurrence of `needle` in `text`. */
function mentionsPhrase(text: string, needle: string, caseSensitive = false): boolean {
  if (!needle.trim()) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle.trim())}(?![\\p{L}\\p{N}])`, caseSensitive ? 'u' : 'iu');
  return re.test(text);
}

const NAME_TITLES = new Set(['dame', 'sir', 'lord', 'lady', 'prince', 'princess', 'king', 'queen', 'duke', 'duchess', 'count', 'countess', 'baron', 'baroness', 'master', 'captain', 'elder', 'chief', 'sister', 'brother', 'father', 'mother', 'doctor', 'professor', 'the', 'a', 'an', 'of']);

/**
 * Whether narration names this thing. Full name, or the name without a
 * leading article ("the Wine Cellar" for "The Wine Cellar"), both
 * case-insensitive. People are also recognised by their given name —
 * "Vaelora" for "Duchess Vaelora", "Mira" for "Mira the Servant" — matched
 * case-sensitively so a common word is not mistaken for a name.
 */
function isMentioned(text: string, name: string, isPerson: boolean): boolean {
  if (mentionsPhrase(text, name)) return true;
  const stripped = name.replace(/^(the|a|an)\s+/i, '');
  if (stripped !== name && stripped.length >= 4 && mentionsPhrase(text, stripped)) return true;
  if (isPerson) {
    const given = name.split(/\s+/)
      .map(w => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
      .find(w => w.length > 0 && !NAME_TITLES.has(w.toLowerCase()));
    if (given && given.length >= 4 && given !== name && mentionsPhrase(text, given, true)) return true;
  }
  return false;
}

/**
 * Columns a bare test database (one that never went through db.ts migrate)
 * may be missing. Real databases get these from migrate(), which also does
 * the one-time backfill for games already in play — this only makes sure the
 * columns exist.
 */
function ensureColumns(db: Database.Database): void {
  const add = (table: string, column: string, ddl: string) => {
    const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  add('locations', 'visited', 'visited INTEGER NOT NULL DEFAULT 0');
  add('locations', 'known_to_party', 'known_to_party INTEGER NOT NULL DEFAULT 0');
  add('entities', 'known_to_party', 'known_to_party INTEGER NOT NULL DEFAULT 0');
  add('entities', 'motivation', 'motivation TEXT');
  add('items', 'known_to_party', 'known_to_party INTEGER NOT NULL DEFAULT 0');
}

/**
 * The world bible holds two audiences' worth of truth. The DM sees all of it
 * (getSummary): seeded plot hooks, every NPC and their motivation, every
 * place and item. Characters are LLM agents playing people in the story, and
 * a person knows only what has happened to them — so their view
 * (getPlayerKnowledge) is limited to rows marked known_to_party, which only
 * the story itself sets: the DM naming something in narration or resolution,
 * the DM putting an NPC on stage, a location being visited, or the fact
 * extractor pulling it out of the (whisper-free) transcript. Seeding writes
 * everything as unknown.
 */
export class WorldBible {
  constructor(private db: Database.Database) {
    ensureColumns(db);
  }

  addLocation(loc: Location, knownToParty = false): void {
    this.db.prepare(`INSERT INTO locations (id, campaign_id, name, description, terrain, connections, coords, known_to_party) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(loc.id, loc.campaignId, loc.name, loc.description, loc.terrain, JSON.stringify(loc.connections), loc.coords ? JSON.stringify(loc.coords) : null, knownToParty ? 1 : 0);
  }

  markLocationVisited(campaignId: string, locationId: string): void {
    this.db.prepare('UPDATE locations SET visited = 1, known_to_party = 1 WHERE id = ? AND campaign_id = ?').run(locationId, campaignId);
  }

  /** The DM put this NPC in the scene — the party can see them now. */
  markEntityKnown(campaignId: string, name: string): void {
    this.db.prepare('UPDATE entities SET known_to_party = 1 WHERE campaign_id = ? AND name = ? COLLATE NOCASE').run(campaignId, name);
  }

  /**
   * Mark every not-yet-known NPC, location and item that `text` names as
   * known to the party. Callers pass story text only — narration,
   * resolutions, character actions, recaps — never whispers, which are
   * private to one character and are not the story.
   */
  revealMentioned(campaignId: string, text: string): void {
    if (!text.trim()) return;
    const tables: Array<{ table: 'entities' | 'locations' | 'items'; isPerson: boolean }> = [
      { table: 'entities', isPerson: true },
      { table: 'locations', isPerson: false },
      { table: 'items', isPerson: false },
    ];
    for (const { table, isPerson } of tables) {
      const rows = this.db.prepare(`SELECT id, name FROM ${table} WHERE campaign_id = ? AND known_to_party = 0`).all(campaignId) as Array<{ id: string; name: string }>;
      for (const row of rows) {
        if (isMentioned(text, row.name, isPerson)) {
          this.db.prepare(`UPDATE ${table} SET known_to_party = 1 WHERE id = ?`).run(row.id);
        }
      }
    }
  }

  addEntity(ent: Entity): void {
    this.db.prepare(`INSERT INTO entities (id, campaign_id, type, name, description, disposition, alive, location_id, metadata, motivation, known_to_party) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ent.id, ent.campaignId, ent.type, ent.name, ent.description, ent.disposition, ent.alive ? 1 : 0, ent.locationId, JSON.stringify(ent.metadata), ent.motivation ?? null, ent.knownToParty ? 1 : 0);
  }

  addItem(item: Item, knownToParty = false): void {
    this.db.prepare(`INSERT INTO items (id, campaign_id, name, description, properties, holder_id, location_id, known_to_party) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(item.id, item.campaignId, item.name, item.description, JSON.stringify(item.properties), item.holderId, item.locationId, knownToParty ? 1 : 0);
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
    if (!row) {
      const stripped = name.replace(/^(the|a|an)\s+/i, '');
      if (stripped !== name) {
        return this.getLocationByName(campaignId, stripped);
      }
      const withArticle = this.db.prepare(
        "SELECT * FROM locations WHERE campaign_id = ? AND (name = ? COLLATE NOCASE OR REPLACE(LOWER(name), 'the ', '') = LOWER(?))"
      ).get(campaignId, name, stripped) as any;
      if (withArticle) {
        return this.rowToLocation(withArticle);
      }
      return this.fuzzyMatchLocation(campaignId, name);
    }
    return this.rowToLocation(row);
  }

  private rowToLocation(row: any): Location {
    return { id: row.id, campaignId: row.campaign_id, name: row.name, description: row.description, terrain: row.terrain, connections: JSON.parse(row.connections ?? '[]'), coords: row.coords ? JSON.parse(row.coords) : null };
  }

  private fuzzyMatchLocation(campaignId: string, name: string): Location | null {
    const allLocs = this.db.prepare('SELECT * FROM locations WHERE campaign_id = ?').all(campaignId) as any[];
    if (allLocs.length === 0) return null;
    const stopWords = new Set(['the', 'a', 'an', 'of', 'in', 'at', 'to', 'and', 'or']);
    const queryWords = name.toLowerCase().split(/[\s'-]+/).filter(w => w.length > 2 && !stopWords.has(w));
    if (queryWords.length === 0) return null;
    let bestMatch: any = null;
    let bestScore = 0;
    for (const loc of allLocs) {
      const locWords = (loc.name as string).toLowerCase().split(/[\s'-]+/).filter(w => w.length > 2 && !stopWords.has(w));
      const shared = queryWords.filter(w => locWords.some(lw => lw.includes(w) || w.includes(lw))).length;
      if (shared > bestScore) { bestScore = shared; bestMatch = loc; }
    }
    if (bestScore >= 1 && bestMatch) {
      console.log(`[world-bible] Fuzzy-matched "${name}" → "${bestMatch.name}" (${bestScore} shared words)`);
      return this.rowToLocation(bestMatch);
    }
    return null;
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
    const locs = this.db.prepare('SELECT name, description, visited FROM locations WHERE campaign_id = ? ORDER BY visited ASC, rowid DESC LIMIT 12').all(campaignId) as any[];
    if (locs.length > 0) {
      const unvisited = locs.filter((l: any) => !l.visited);
      const visited = locs.filter((l: any) => l.visited);
      let locText = '';
      if (unvisited.length > 0) {
        locText += 'UNVISITED locations (advance the story toward these!): ' + unvisited.map((l: any) => `${l.name}${l.description ? ' — ' + l.description : ''}`).join('; ');
      }
      if (visited.length > 0) {
        locText += (locText ? '\n' : '') + 'Visited locations: ' + visited.map((l: any) => l.name).join(', ');
      }
      parts.push(locText);
    }

    const npcs = this.db.prepare('SELECT name, type, disposition, description, motivation FROM entities WHERE campaign_id = ? AND alive = 1 ORDER BY rowid DESC LIMIT 15').all(campaignId) as any[];
    if (npcs.length > 0) {
      parts.push('Known NPCs/creatures: ' + npcs.map((n: any) => {
        let label = `${n.name} (${n.type}${n.disposition ? ', ' + n.disposition : ''})`;
        if (n.description) label += ` — ${n.description}`;
        if (n.motivation) label += ` [Motivation: ${n.motivation}]`;
        return label;
      }).join('; '));
    }

    const rels = this.db.prepare(`SELECT r.type, r.description,
        COALESCE(e1.name, json_extract(c1.definition, '$.name')) as a_name,
        COALESCE(e2.name, json_extract(c2.definition, '$.name')) as b_name
      FROM relationships r
      LEFT JOIN entities e1 ON r.entity_a_id = e1.id
      LEFT JOIN entities e2 ON r.entity_b_id = e2.id
      LEFT JOIN characters c1 ON r.entity_a_id = c1.id
      LEFT JOIN characters c2 ON r.entity_b_id = c2.id
      WHERE r.campaign_id = ? AND (a_name IS NOT NULL AND b_name IS NOT NULL)
      ORDER BY r.rowid DESC LIMIT 10`).all(campaignId) as any[];
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

    const heldItems = this.db.prepare(
      `SELECT i.name,
              COALESCE(e.name, json_extract(c.definition, '$.name')) as holder_name
       FROM items i
       LEFT JOIN entities e ON i.holder_id = e.id
       LEFT JOIN characters c ON i.holder_id = c.id
       WHERE i.campaign_id = ? AND i.holder_id IS NOT NULL`
    ).all(campaignId) as any[];
    if (heldItems.length > 0) {
      parts.push('Carried items: ' + heldItems.map((i: any) =>
        i.holder_name ? `${i.name} (held by ${i.holder_name})` : `${i.name} (held by a party member)`
      ).join(', '));
    }

    const unusedItems = this.db.prepare('SELECT name, description FROM items WHERE campaign_id = ? AND holder_id IS NULL AND location_id IS NULL').all(campaignId) as any[];
    if (unusedItems.length > 0) {
      parts.push('Unclaimed items: ' + unusedItems.map((i: any) => i.name).join(', '));
    }

    return parts.join('\n') || 'No world knowledge yet.';
  }

  getCompactSummary(campaignId: string, locationId?: string): string {
    const parts: string[] = [];
    if (locationId) {
      const loc = this.db.prepare('SELECT name FROM locations WHERE id = ?').get(locationId) as any;
      if (loc) parts.push(`You are at: ${loc.name}`);
    }
    const npcs = locationId
      ? this.db.prepare('SELECT name, type, disposition, description FROM entities WHERE campaign_id = ? AND alive = 1 AND location_id = ? LIMIT 8').all(campaignId, locationId) as any[]
      : this.db.prepare('SELECT name, type, disposition, description FROM entities WHERE campaign_id = ? AND alive = 1 LIMIT 8').all(campaignId) as any[];
    if (npcs.length > 0) {
      parts.push('People nearby: ' + npcs.map((n: any) => {
        let label = `${n.name} (${n.disposition ?? n.type})`;
        if (n.description) label += ` — ${n.description.slice(0, 60)}`;
        return label;
      }).join('; '));
    }
    if (locationId) {
      const otherNpcs = this.db.prepare('SELECT name, disposition FROM entities WHERE campaign_id = ? AND alive = 1 AND (location_id IS NULL OR location_id != ?) LIMIT 5').all(campaignId, locationId) as any[];
      if (otherNpcs.length > 0) {
        parts.push('People you\'ve met elsewhere: ' + otherNpcs.map((n: any) => n.name).join(', '));
      }
    }
    const allLocs = this.db.prepare('SELECT name, visited FROM locations WHERE campaign_id = ? ORDER BY visited ASC LIMIT 8').all(campaignId) as any[];
    if (allLocs.length > 1) {
      const otherLocs = allLocs.filter((l: any) => {
        if (!locationId) return true;
        const currentLoc = this.db.prepare('SELECT name FROM locations WHERE id = ?').get(locationId) as any;
        return !currentLoc || l.name !== currentLoc.name;
      });
      if (otherLocs.length > 0) {
        const unvisited = otherLocs.filter((l: any) => !l.visited);
        const visited = otherLocs.filter((l: any) => l.visited);
        const locParts: string[] = [];
        if (unvisited.length > 0) locParts.push(`unexplored: ${unvisited.map((l: any) => l.name).join(', ')}`);
        if (visited.length > 0) locParts.push(`visited: ${visited.map((l: any) => l.name).join(', ')}`);
        parts.push('Known locations: ' + locParts.join(' | '));
      }
    }
    const unclaimedItems = locationId
      ? this.db.prepare('SELECT name FROM items WHERE campaign_id = ? AND holder_id IS NULL AND (location_id = ? OR location_id IS NULL) LIMIT 5').all(campaignId, locationId) as any[]
      : this.db.prepare('SELECT name FROM items WHERE campaign_id = ? AND holder_id IS NULL LIMIT 5').all(campaignId) as any[];
    if (unclaimedItems.length > 0) {
      parts.push('Items you could pick up: ' + unclaimedItems.map((i: any) => i.name).join(', '));
    }
    const rels = this.db.prepare(`SELECT r.type, r.description,
        COALESCE(e1.name, json_extract(c1.definition, '$.name')) as a_name,
        COALESCE(e2.name, json_extract(c2.definition, '$.name')) as b_name
      FROM relationships r
      LEFT JOIN entities e1 ON r.entity_a_id = e1.id
      LEFT JOIN entities e2 ON r.entity_b_id = e2.id
      LEFT JOIN characters c1 ON r.entity_a_id = c1.id
      LEFT JOIN characters c2 ON r.entity_b_id = c2.id
      WHERE r.campaign_id = ? AND (a_name IS NOT NULL AND b_name IS NOT NULL)
      ORDER BY r.rowid DESC LIMIT 5`).all(campaignId) as any[];
    if (rels.length > 0) {
      parts.push('Relationships: ' + rels.map((r: any) => `${r.a_name} ${r.type} ${r.b_name}`).join(', '));
    }
    const currentScene = this.db.prepare('SELECT MAX(scene_number) as s FROM events WHERE campaign_id = ?').get(campaignId) as any;
    const maxScene = currentScene?.s ?? 0;
    const unresolved = this.db.prepare('SELECT description FROM events WHERE campaign_id = ? AND outcome IS NULL AND scene_number > ? LIMIT 3').all(campaignId, maxScene - 5) as any[];
    if (unresolved.length > 0) {
      parts.push('Open threads: ' + unresolved.map((e: any) => e.description).join('; '));
    }
    return parts.join('\n') || '';
  }

  /**
   * What a character in the story actually knows about the world: only NPCs,
   * places and items the story has revealed (known_to_party), never seeded
   * plot hooks, never motivations. Threads listed here are ones the fact
   * extractor pulled out of play (scene 1+), not the DM's scene-0 hooks.
   * The "People nearby:" label is parsed by CharacterAgent.extractNearbyNpcs.
   */
  getPlayerKnowledge(campaignId: string, locationId?: string): string {
    const parts: string[] = [];
    let currentName: string | null = null;
    if (locationId) {
      const loc = this.db.prepare('SELECT name FROM locations WHERE id = ? AND campaign_id = ?').get(locationId, campaignId) as any;
      if (loc) {
        currentName = loc.name;
        parts.push(`You are at: ${loc.name}`);
      }
    }

    if (locationId) {
      const here = this.db.prepare('SELECT name, type, disposition, description FROM entities WHERE campaign_id = ? AND alive = 1 AND known_to_party = 1 AND location_id = ? LIMIT 8').all(campaignId, locationId) as any[];
      if (here.length > 0) {
        parts.push('People nearby: ' + here.map((n: any) => {
          let label = `${n.name} (${n.disposition ?? n.type})`;
          if (n.description) label += ` — ${n.description.slice(0, 60)}`;
          return label;
        }).join('; '));
      }
    }
    const elsewhere = locationId
      ? this.db.prepare('SELECT name, disposition FROM entities WHERE campaign_id = ? AND alive = 1 AND known_to_party = 1 AND (location_id IS NULL OR location_id != ?) LIMIT 8').all(campaignId, locationId) as any[]
      : this.db.prepare('SELECT name, disposition FROM entities WHERE campaign_id = ? AND alive = 1 AND known_to_party = 1 LIMIT 8').all(campaignId) as any[];
    if (elsewhere.length > 0) {
      parts.push(`People you know of${locationId ? ' (not here)' : ''}: ` + elsewhere.map((n: any) => n.disposition ? `${n.name} (${n.disposition})` : n.name).join(', '));
    }

    const locs = (this.db.prepare('SELECT name, visited FROM locations WHERE campaign_id = ? AND known_to_party = 1 ORDER BY visited ASC LIMIT 8').all(campaignId) as any[])
      .filter((l: any) => l.name !== currentName);
    if (locs.length > 0) {
      const heardOf = locs.filter((l: any) => !l.visited).map((l: any) => l.name);
      const visited = locs.filter((l: any) => l.visited).map((l: any) => l.name);
      const locParts: string[] = [];
      if (heardOf.length > 0) locParts.push(`heard of, not yet visited: ${heardOf.join(', ')}`);
      if (visited.length > 0) locParts.push(`visited: ${visited.join(', ')}`);
      parts.push('Places you know: ' + locParts.join(' | '));
    }

    const items = locationId
      ? this.db.prepare('SELECT name FROM items WHERE campaign_id = ? AND known_to_party = 1 AND holder_id IS NULL AND (location_id = ? OR location_id IS NULL) LIMIT 5').all(campaignId, locationId) as any[]
      : this.db.prepare('SELECT name FROM items WHERE campaign_id = ? AND known_to_party = 1 AND holder_id IS NULL LIMIT 5').all(campaignId) as any[];
    if (items.length > 0) {
      parts.push('Items you have seen: ' + items.map((i: any) => i.name).join(', '));
    }

    const rels = this.db.prepare(`SELECT r.type,
        COALESCE(e1.name, json_extract(c1.definition, '$.name')) as a_name,
        COALESCE(e2.name, json_extract(c2.definition, '$.name')) as b_name
      FROM relationships r
      LEFT JOIN entities e1 ON r.entity_a_id = e1.id
      LEFT JOIN entities e2 ON r.entity_b_id = e2.id
      LEFT JOIN characters c1 ON r.entity_a_id = c1.id
      LEFT JOIN characters c2 ON r.entity_b_id = c2.id
      WHERE r.campaign_id = ? AND (a_name IS NOT NULL AND b_name IS NOT NULL)
        AND (e1.id IS NULL OR e1.known_to_party = 1) AND (e2.id IS NULL OR e2.known_to_party = 1)
      ORDER BY r.rowid DESC LIMIT 5`).all(campaignId) as any[];
    if (rels.length > 0) {
      parts.push('Relationships: ' + rels.map((r: any) => `${r.a_name} ${r.type} ${r.b_name}`).join(', '));
    }

    const currentScene = this.db.prepare('SELECT MAX(scene_number) as s FROM events WHERE campaign_id = ?').get(campaignId) as any;
    const maxScene = currentScene?.s ?? 0;
    const threads = this.db.prepare('SELECT description FROM events WHERE campaign_id = ? AND outcome IS NULL AND scene_number > 0 AND scene_number > ? ORDER BY scene_number DESC LIMIT 3').all(campaignId, maxScene - 5) as any[];
    if (threads.length > 0) {
      parts.push('Unanswered questions from the story so far: ' + threads.map((e: any) => e.description).join('; '));
    }
    return parts.join('\n');
  }

  /**
   * Where things stand at the end, for the epilogue and closing reflections:
   * each item the party has seen with its latest known holder or place, and
   * each place the party actually went. Events carry no location, so "what
   * happened where" is not recorded here — only where the party has been.
   */
  getEndingFacts(campaignId: string): { items: string[]; places: string[] } {
    const items = (this.db.prepare(
      `SELECT i.name,
              COALESCE(e.name, json_extract(c.definition, '$.name')) AS holder_name,
              i.holder_id AS holder_id,
              l.name AS location_name
       FROM items i
       LEFT JOIN entities e ON i.holder_id = e.id
       LEFT JOIN characters c ON i.holder_id = c.id
       LEFT JOIN locations l ON i.location_id = l.id
       WHERE i.campaign_id = ? AND i.known_to_party = 1
       ORDER BY i.name`
    ).all(campaignId) as Array<{ name: string; holder_name: string | null; holder_id: string | null; location_name: string | null }>).map(i =>
      i.holder_name ? `${i.name} — last held by ${i.holder_name}`
        : i.holder_id ? `${i.name} — held by someone the record does not name`
        : i.location_name ? `${i.name} — last seen at ${i.location_name}, not carried by the party`
        : `${i.name} — not carried by anyone in the party`);
    const places = (this.db.prepare('SELECT name, description FROM locations WHERE campaign_id = ? AND visited = 1 ORDER BY name').all(campaignId) as Array<{ name: string; description: string | null }>)
      .map(l => l.description ? `${l.name}: ${l.description.slice(0, 140)}` : l.name);
    return { items, places };
  }

  updateItemHolder(campaignId: string, itemName: string, holderId: string | null): void {
    // Changing hands happens in a narrated resolution — the party has seen it.
    this.db.prepare('UPDATE items SET holder_id = ?, known_to_party = 1 WHERE campaign_id = ? AND name = ? COLLATE NOCASE')
      .run(holderId, campaignId, itemName);
  }

  updateEntityLocation(campaignId: string, entityName: string, locationId: string): void {
    this.db.prepare('UPDATE entities SET location_id = ? WHERE campaign_id = ? AND name = ? COLLATE NOCASE')
      .run(locationId, campaignId, entityName);
  }

  ensureEntity(campaignId: string, name: string, locationId: string): void {
    const existing = this.db.prepare('SELECT id FROM entities WHERE campaign_id = ? AND name = ? COLLATE NOCASE').get(campaignId, name);
    if (!existing) {
      this.addEntity({ id: genId(), campaignId, type: 'npc', name, description: null, disposition: null, alive: true, locationId, metadata: {} });
      console.log(`[world-bible] Auto-created NPC "${name}" from DM narration`);
    }
  }

  getRelationships(campaignId: string): Array<{ entityAName: string; entityBName: string; type: string; description: string | null }> {
    return this.db.prepare(`SELECT r.type, r.description,
        COALESCE(e1.name, json_extract(c1.definition, '$.name')) as entityAName,
        COALESCE(e2.name, json_extract(c2.definition, '$.name')) as entityBName
      FROM relationships r
      LEFT JOIN entities e1 ON r.entity_a_id = e1.id
      LEFT JOIN entities e2 ON r.entity_b_id = e2.id
      LEFT JOIN characters c1 ON r.entity_a_id = c1.id
      LEFT JOIN characters c2 ON r.entity_b_id = c2.id
      WHERE r.campaign_id = ? AND entityAName IS NOT NULL AND entityBName IS NOT NULL
      ORDER BY r.rowid DESC LIMIT 10`).all(campaignId) as any[];
  }

  isLocationVisited(campaignId: string, locationId: string): boolean {
    const row = this.db.prepare('SELECT visited FROM locations WHERE id = ? AND campaign_id = ?').get(locationId, campaignId) as any;
    return row?.visited === 1;
  }

  getAllLocationNames(campaignId: string): string[] {
    const rows = this.db.prepare('SELECT name FROM locations WHERE campaign_id = ? ORDER BY visited ASC').all(campaignId) as any[];
    return rows.map(r => r.name as string);
  }

  getUnvisitedLocationNames(campaignId: string): string[] {
    const rows = this.db.prepare('SELECT name FROM locations WHERE campaign_id = ? AND visited = 0').all(campaignId) as any[];
    return rows.map(r => r.name as string);
  }

  /**
   * Descriptions of every event ever recorded for this campaign, resolved or
   * not. Events have no name-based identity the way locations/entities/items
   * do, so callers that need to dedupe an incoming event against what already
   * exists (e.g. re-applying a world seed) compare against this list on
   * trimmed, case-insensitive description — consistent with the
   * `COLLATE NOCASE` name dedup used elsewhere in this class.
   *
   * Deliberately includes resolved events, not just unresolved ones: this is
   * used by re-seed paths (accept-world-seed, regenerate-world-seed), and a
   * plot hook the table already resolved and closed must not come back as a
   * "fresh" unresolved event just because a later draft repeats its wording.
   * Locations, entities, and items dedupe by identity regardless of state
   * for the same reason — only events had a state-scoped filter here, and
   * that was fine until re-seeding existed at all.
   */
  getEventDescriptions(campaignId: string): string[] {
    const rows = this.db.prepare('SELECT description FROM events WHERE campaign_id = ?').all(campaignId) as any[];
    return rows.map(r => r.description as string);
  }

  snapToKnownLocation(campaignId: string, name: string): string | null {
    const exact = this.getLocationByName(campaignId, name);
    if (exact) return exact.name;

    const all = this.getAllLocationNames(campaignId);
    if (all.length === 0) return null;

    const stopWords = new Set(['the', 'a', 'an', 'of', 'in', 'at', 'to', 'and', 'or', 'its', 'with']);
    const queryWords = name.toLowerCase().split(/[\s'-]+/).filter(w => w.length > 2 && !stopWords.has(w));
    if (queryWords.length === 0) return null;

    let bestName: string | null = null;
    let bestScore = 0;
    for (const locName of all) {
      const locWords = locName.toLowerCase().split(/[\s'-]+/).filter(w => w.length > 2 && !stopWords.has(w));
      const shared = queryWords.filter(w => locWords.some(lw => lw.includes(w) || w.includes(lw))).length;
      if (shared > bestScore) { bestScore = shared; bestName = locName; }
    }
    return bestScore >= 1 ? bestName : null;
  }

  getCharacterRelationships(campaignId: string, characterId: string, characterName: string): string {
    const rels = this.db.prepare(`SELECT r.type, r.description,
        COALESCE(e1.name, json_extract(c1.definition, '$.name')) as a_name,
        COALESCE(e2.name, json_extract(c2.definition, '$.name')) as b_name
      FROM relationships r
      LEFT JOIN entities e1 ON r.entity_a_id = e1.id
      LEFT JOIN entities e2 ON r.entity_b_id = e2.id
      LEFT JOIN characters c1 ON r.entity_a_id = c1.id
      LEFT JOIN characters c2 ON r.entity_b_id = c2.id
      WHERE r.campaign_id = ? AND (r.entity_a_id = ? OR r.entity_b_id = ?)
      ORDER BY r.rowid DESC LIMIT 8`).all(campaignId, characterId, characterId) as any[];

    if (rels.length === 0) return '';

    const lines = rels.map((r: any) => {
      const isSubject = r.a_name?.toLowerCase() === characterName.toLowerCase();
      const other = isSubject ? r.b_name : r.a_name;
      const verb = isSubject ? r.type : this.reverseRelationType(r.type);
      const desc = r.description ? ` — ${r.description}` : '';
      return `- You ${verb} ${other}${desc}`;
    });

    return `Your relationships:\n${lines.join('\n')}`;
  }

  private reverseRelationType(type: string): string {
    const reverses: Record<string, string> = {
      'protects': 'are protected by',
      'suspects': 'are suspected by',
      'distrust': 'are distrusted by',
      'admires': 'are admired by',
      'fears': 'are feared by',
      'manipulates': 'are manipulated by',
      'betrayed-by': 'betrayed',
      'alliance': 'are allied with',
      'rivalry': 'have a rivalry with',
      'debt': 'are owed by',
      'cooperates-with': 'cooperate with',
    };
    return reverses[type] ?? `have a ${type} relationship with`;
  }

  /**
   * `markKnown` is for diffs drawn from the story itself (the fact extractor
   * reading the whisper-free transcript): everything they name, new or
   * existing, becomes known to the party. Seeding leaves it off — a seed is
   * the DM's private notes.
   */
  applyDiff(campaignId: string, diff: WorldBibleDiff, opts?: { allowNewLocations?: boolean; markKnown?: boolean }): void {
    const allowNewLocations = opts?.allowNewLocations ?? false;
    const markKnown = opts?.markKnown ?? false;
    const tx = this.db.transaction(() => {
      for (const loc of diff.newLocations) {
        const existing = this.getLocationByName(campaignId, loc.name);
        if (existing) {
          if (loc.description) this.db.prepare('UPDATE locations SET description = ? WHERE id = ?').run(loc.description, existing.id);
          if (markKnown) this.db.prepare('UPDATE locations SET known_to_party = 1 WHERE id = ?').run(existing.id);
        } else if (allowNewLocations) {
          this.addLocation({ id: genId(), campaignId, name: loc.name, description: loc.description, terrain: loc.terrain, connections: [], coords: null }, markKnown);
        } else {
          console.log(`[world-bible] Dropped extracted location "${loc.name}" — not in scenario`);
        }
      }
      for (const ent of diff.newEntities) {
        const existing = this.db.prepare('SELECT id FROM entities WHERE campaign_id = ? AND name = ? COLLATE NOCASE').get(campaignId, ent.name) as any;
        if (existing) {
          if (ent.description) this.db.prepare('UPDATE entities SET description = ? WHERE id = ?').run(ent.description, existing.id);
          if (ent.disposition) this.db.prepare('UPDATE entities SET disposition = ? WHERE id = ?').run(ent.disposition, existing.id);
          if (ent.motivation) this.db.prepare('UPDATE entities SET motivation = ? WHERE id = ?').run(ent.motivation, existing.id);
          if (markKnown) this.db.prepare('UPDATE entities SET known_to_party = 1 WHERE id = ?').run(existing.id);
        } else {
          this.addEntity({ id: genId(), campaignId, type: ent.type as Entity['type'], name: ent.name, description: ent.description, disposition: ent.disposition, alive: true, locationId: null, metadata: {}, motivation: ent.motivation ?? null, knownToParty: markKnown });
        }
      }
      for (const item of diff.newItems) {
        const existingItem = this.db.prepare('SELECT id FROM items WHERE campaign_id = ? AND name = ? COLLATE NOCASE').get(campaignId, item.name) as any;
        if (existingItem) {
          if (item.description) this.db.prepare('UPDATE items SET description = ? WHERE id = ?').run(item.description, existingItem.id);
          if (markKnown) this.db.prepare('UPDATE items SET known_to_party = 1 WHERE id = ?').run(existingItem.id);
        } else {
          this.addItem({ id: genId(), campaignId, name: item.name, description: item.description, properties: item.properties ?? {}, holderId: item.holderId ?? null, locationId: item.locationId ?? null }, markKnown);
        }
      }
      for (const evt of diff.newEvents) {
        if (evt.outcome) {
          const stopWords = new Set(['that', 'this', 'with', 'from', 'have', 'been', 'will', 'they', 'them', 'their', 'were', 'what', 'when', 'into', 'also', 'more', 'some']);
          const keywords = evt.description.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stopWords.has(w));
          const participants = evt.participants.map(p => p.toLowerCase());
          if (keywords.length > 0 || participants.length > 0) {
            const unresolved = this.db.prepare(
              'SELECT id, description, participants FROM events WHERE campaign_id = ? AND outcome IS NULL'
            ).all(campaignId) as Array<{ id: string; description: string; participants: string }>;
            const best = unresolved.reduce<{ id: string; score: number } | null>((top, row) => {
              const desc = row.description.toLowerCase();
              const wordScore = keywords.length > 0 ? keywords.filter(k => desc.includes(k)).length / keywords.length : 0;
              const rowParticipants = JSON.parse(row.participants || '[]').map((p: string) => p.toLowerCase());
              const nameScore = participants.length > 0 ? participants.filter(p => rowParticipants.includes(p) || desc.includes(p)).length * 0.3 : 0;
              const score = wordScore + nameScore;
              return score >= 0.3 && (!top || score > top.score) ? { id: row.id, score } : top;
            }, null);
            if (best) {
              this.db.prepare('UPDATE events SET outcome = ? WHERE id = ?').run(evt.outcome, best.id);
              continue;
            }
          }
        }
        this.addEvent({ id: genId(), campaignId, sceneNumber: evt.sceneNumber, description: evt.description, participants: evt.participants, outcome: evt.outcome });
      }
      for (const rel of (diff.newRelationships ?? [])) {
        const findId = (name: string) => {
          const entity = this.db.prepare('SELECT id FROM entities WHERE campaign_id = ? AND name = ? COLLATE NOCASE').get(campaignId, name) as any;
          if (entity) return entity.id;
          // Deliberately not filtering revoked_at here: this resolves a
          // participant in a relationship extracted from play, and a
          // relationship involving a since-revoked character is still true
          // history. Filtering would risk creating a duplicate entity for
          // the same name instead of pointing back at the character that
          // actually lived it.
          const char = this.db.prepare("SELECT id FROM characters WHERE campaign_id = ? AND json_extract(definition, '$.name') = ? COLLATE NOCASE").get(campaignId, name) as any;
          return char?.id ?? null;
        };
        const idA = findId(rel.entityAName);
        const idB = findId(rel.entityBName);
        if (idA && idB) {
          this.addRelationship({ campaignId, entityAId: idA, entityBId: idB, type: rel.type, description: rel.description });
        }
      }
    });
    tx();
  }
}
