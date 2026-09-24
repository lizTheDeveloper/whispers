// Round 16: items, live game NUMMRL (Liz she/her, Biz they/them, 10).
//  1. Liz held "Bottle cap" (one, from Biz). Biz dropped another; "Liz scoops
//     the ink-stained Bottle cap from the floor" logged `Liz already holds
//     "Bottle cap"; not added twice` — she should have held two.
//  2. At another place, Biz pocketed "the tiny shiny glint"; the server took
//     it as the Bottle cap that sank in an ink puddle at the Inkwell Market
//     (`the world → Biz`) and refused it as a duplicate.
//  3. World near-duplicates: "Voided Ticket" / "Void Ticket", "Badger's
//     Spectacles" / "Vibrating Spectacles".
//  4. "Squeaky Stool" (a talking NPC) filed as an item; "The Smudged Compass"
//     with no holder though Madame Quill held it up.
//  5. Liz offered "ask Barnaby the Badger if the ink can be calmed by a
//     granola bar" after the bar was eaten.
//  6. Liz said "I have a pen" while Biz held it.
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { planItemMoves } from '../src/server/item-moves.js';
import { sameItem, itemHead, isStack, singleOf, itemCount, namesOneThing, optionsWithoutGoneItems } from '../src/server/narrative-guards.js';
import { characterItemsBlock } from '../src/server/agents/character.js';
import { EXTRACTOR_ITEM_RULE } from '../src/server/agents/extractor.js';
import { WorldBible } from '../src/server/world-bible.js';

const party = (liz: string[], biz: string[]) => [{ id: 'liz', name: 'Liz', inventory: [...liz] }, { id: 'biz', name: 'Biz', inventory: [...biz] }];

describe('1. a second single is a count, not a duplicate', () => {
  it('names with a count are the same thing, stack and head as before', () => {
    expect(sameItem('Bottle caps ×2', 'Bottle cap')).toBe(true);
    expect(sameItem('Bottle caps ×2', 'bottle caps')).toBe(true);
    expect(itemHead('Bottle caps ×2')).toBe('cap');
    expect(isStack('Bottle caps ×2')).toBe(true);
    expect(singleOf('Bottle caps ×3')).toBe('Bottle cap');
    expect(itemCount('Bottle caps ×3')).toBe(3);
    expect(itemCount('Bottle cap')).toBe(1);
    expect(itemCount('Bottle caps')).toBeNull();
  });

  it('the live beat: Liz holds one cap, and picks up the one Biz dropped here — she holds two', () => {
    const p = planItemMoves([{ item: 'Bottle cap', from: 'world', to: 'Liz' }], party(['Tote bag', 'Form 7-B', 'Bottle cap'], ['Bottle caps', 'Pen']), { worldItems: ['Bottle cap'], looseItems: ['Bottle cap'] });
    expect(p.inventories.get('liz')).toEqual(['Tote bag', 'Form 7-B', 'Bottle caps ×2']);
    expect(p.inventories.get('biz')).toEqual(['Bottle caps', 'Pen']);
    expect(p.notes.join('\n')).not.toMatch(/not added twice/);
  });

  it('the same pick-up restated (the record already has it in Liz\'s hand, none lying loose): not added twice', () => {
    const p = planItemMoves([{ item: 'Bottle cap', from: 'world', to: 'Liz' }], party(['Tote bag', 'Bottle cap'], ['Bottle caps']), { worldItems: ['Bottle cap'], looseItems: [] });
    expect(p.inventories.get('liz')).toEqual(['Tote bag', 'Bottle cap']);
    expect(p.notes.join('\n')).toMatch(/not added twice/);
  });

  it('handed one by a companion who held it: a new one', () => {
    const p = planItemMoves([{ item: 'Bottle cap', from: 'Biz', to: 'Liz' }], party(['Bottle cap'], ['Bottle caps']));
    expect(p.inventories.get('liz')).toEqual(['Bottle caps ×2']);
    expect(p.inventories.get('biz')).toEqual(['Bottle caps']);
    const q = planItemMoves([{ item: 'Coin', from: 'Biz', to: 'Liz' }], party(['Coin'], ['Coin', 'Pen']));
    expect(q.inventories.get('liz')).toEqual(['Coins ×2']);
    expect(q.inventories.get('biz')).toEqual(['Pen']);
  });

  it('a counted stack counts down one at a time', () => {
    const p = planItemMoves([{ item: 'Bottle cap', from: 'Liz', to: 'Barnaby the Badger' }], party(['Bottle caps ×2'], []));
    expect(p.inventories.get('liz')).toEqual(['Bottle cap']);
    expect(p.applied[0]!.item).toBe('Bottle cap');
    const q = planItemMoves([{ item: 'Bottle cap', from: 'Liz', to: 'world' }], party(['Bottle caps ×3'], []));
    expect(q.inventories.get('liz')).toEqual(['Bottle caps ×2']);
    const r = planItemMoves([{ item: 'Bottle caps', from: 'Liz', to: 'Biz' }], party(['Bottle caps ×2'], ['Bottle cap']));
    expect(r.inventories.get('liz')).toEqual([]);
    expect(r.inventories.get('biz')).toEqual(['Bottle caps ×3']);
  });

  it('one more on an uncounted stack is still the stack', () => {
    const p = planItemMoves([{ item: 'Bottle cap', from: 'world', to: 'Biz' }], party([], ['Bottle caps']), { worldItems: ['Bottle cap'], looseItems: ['Bottle cap'] });
    expect(p.inventories.get('biz')).toEqual(['Bottle caps']);
  });

  it('from an NPC the record has holding one: a new one; from an NPC the record does not: a restatement', () => {
    const given = planItemMoves([{ item: 'Bottle cap', from: 'Barnaby the Badger', to: 'Liz' }], party(['Bottle cap'], []), { npcItems: [{ name: 'Bottle cap', heldBy: 'Barnaby the Badger' }] });
    expect(given.inventories.get('liz')).toEqual(['Bottle caps ×2']);
    const restated = planItemMoves([{ item: 'Bottle cap', from: 'Barnaby the Badger', to: 'Liz' }], party(['Bottle cap'], []), { npcItems: [] });
    expect(restated.inventories.get('liz')).toEqual(['Bottle cap']);
  });
});

describe('2. a pick-up from the world is a thing lying here', () => {
  it('the live beat: "Bottle cap" picked up where none lies — the sunk one is at the Inkwell Market — is another one, not that record', () => {
    const p = planItemMoves([{ item: 'Bottle cap', from: 'world', to: 'Biz' }], party(['Tote bag'], ['Bottle caps', 'Pen']), { worldItems: ['Bottle cap'], looseItems: [], elsewhere: ['Bottle cap'] });
    expect(p.inventories.get('biz')).toEqual(['Bottle caps', 'Pen']);
    expect(p.applied).toHaveLength(1);
    expect(p.applied[0]!.fresh).toBe(true);
    expect(p.notes.join('\n')).toMatch(/another place/);
    expect(p.notes.join('\n')).not.toMatch(/not added twice/);
  });

  it('a new name is only resolved to a loose thing lying here', () => {
    const far = planItemMoves([{ item: 'Green Bottle Cap', from: 'world', to: 'Liz' }], party([], []), { worldItems: ['Bottle cap'], looseItems: [], elsewhere: ['Bottle cap'] });
    expect(far.inventories.get('liz')).toEqual(['Green Bottle Cap']);
    const here = planItemMoves([{ item: 'Green Bottle Cap', from: 'world', to: 'Liz' }], party([], []), { worldItems: ['Bottle cap'], looseItems: ['Bottle cap'] });
    expect(here.inventories.get('liz')).toEqual(['Bottle cap']);
  });

  it('an unnamed "shiny glint" is not the bottle cap lying here', () => {
    const p = planItemMoves([{ item: 'Tiny shiny glint', from: 'world', to: 'Biz' }], party([], ['Bottle caps']), { worldItems: ['Bottle cap'], looseItems: ['Bottle cap'] });
    expect(p.inventories.get('biz')).toEqual(['Bottle caps', 'Tiny shiny glint']);
  });
});

const bible = () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE campaigns (id TEXT PRIMARY KEY, join_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, dm_preset TEXT NOT NULL, scenario_id TEXT, system_id TEXT NOT NULL DEFAULT 'fate-core', host_user_id TEXT, house_rules TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE entities (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), type TEXT NOT NULL, name TEXT NOT NULL, description TEXT, disposition TEXT, alive INTEGER NOT NULL DEFAULT 1, location_id TEXT, metadata TEXT, motivation TEXT, known_to_party INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE locations (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), name TEXT NOT NULL, description TEXT, terrain TEXT, connections TEXT, coords TEXT, known_to_party INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE items (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), name TEXT NOT NULL, description TEXT, properties TEXT, holder_id TEXT, location_id TEXT, known_to_party INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE events (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), scene_number INTEGER NOT NULL, description TEXT NOT NULL, participants TEXT, outcome TEXT);
    CREATE TABLE relationships (campaign_id TEXT NOT NULL REFERENCES campaigns(id), entity_a_id TEXT NOT NULL, entity_b_id TEXT NOT NULL, type TEXT NOT NULL, description TEXT, PRIMARY KEY (campaign_id, entity_a_id, entity_b_id));
    CREATE TABLE characters (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), player_user_id TEXT, definition TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  db.prepare('INSERT INTO campaigns (id, join_code, name, dm_preset) VALUES (?, ?, ?, ?)').run('c1', 'NUMMRL', 'Test', 'chronicler');
  db.prepare("INSERT INTO characters (id, campaign_id, definition) VALUES ('liz', 'c1', ?)").run(JSON.stringify({ name: 'Liz' }));
  for (const [id, name, description] of [['barnaby', 'Barnaby the Badger', 'Badger with vibrating spectacles'], ['quill', 'Madame Quill', 'Stern bureaucrat with ink fingers'], ['stool', 'The Squeaky Stool', 'Entity filing counter-complaints']]) {
    db.prepare("INSERT INTO entities (id, campaign_id, type, name, description, metadata) VALUES (?, 'c1', 'npc', ?, ?, '{}')").run(id, name, description);
  }
  return { db, wb: new WorldBible(db) };
};
const rows = (db: Database.Database) => (db.prepare('SELECT name, holder_id, properties FROM items WHERE campaign_id = ? ORDER BY rowid').all('c1') as Array<{ name: string; holder_id: string | null; properties: string }>);
const diff = (wb: WorldBible, items: Array<{ name: string; heldBy?: string }>, scene: number, locationId?: string) =>
  wb.applyDiff('c1', { newLocations: [], newEntities: [], newEvents: [], newRelationships: [], newItems: items.map(i => ({ description: null, ...i })) }, { markKnown: true, sceneNumber: scene, ...(locationId ? { locationId } : {}) });

describe('2b. the record keeps where a thing was set down', () => {
  it('placed in the world at a location: the place is kept; picked up: it is cleared', () => {
    const { wb } = bible();
    wb.placeItem('c1', 'Bottle cap', { scene: 1, locationId: 'market' });
    expect(wb.getItemPlaces('c1')).toEqual([expect.objectContaining({ name: 'Bottle cap', heldBy: null, heldByPc: false, gone: false, scene: 1, locationId: 'market' })]);
    wb.placeItem('c1', 'Bottle cap', { holderId: 'liz', scene: 2 });
    expect(wb.getItemPlaces('c1')[0]).toEqual(expect.objectContaining({ heldByPc: true, scene: 2, locationId: null }));
  });
});

describe('3. near-duplicate world items are one thing; distinct ones stay distinct', () => {
  it('stems: void and voided', () => {
    expect(namesOneThing('Voided Ticket', 'Void Ticket')).toBe(true);
    expect(namesOneThing('Form 7-B', 'Form 12-B')).toBe(false);
    expect(namesOneThing('Orange Key', 'Brass Key')).toBe(false);
  });

  it('"Void Ticket" after "Voided Ticket" in the same scene: an alias', () => {
    const { db, wb } = bible();
    diff(wb, [{ name: 'Voided Ticket' }], 1, 'market');
    diff(wb, [{ name: 'Void Ticket' }], 1, 'market');
    expect(rows(db).map(r => r.name)).toEqual(['Voided Ticket']);
    expect(wb.getItemAliases('c1')).toEqual([{ alias: 'Void Ticket', name: 'Voided Ticket' }]);
  });

  it('"Vibrating Spectacles" a scene after "Badger\'s Spectacles", both Barnaby\'s: an alias', () => {
    const { db, wb } = bible();
    diff(wb, [{ name: 'Badger’s Spectacles' }], 1, 'market');
    diff(wb, [{ name: 'Vibrating Spectacles' }], 2, 'aisle');
    expect(rows(db).map(r => r.name)).toEqual(['Badger’s Spectacles']);
  });

  it('an adjective variant at the same place is an alias; at another place with no owner, its own thing', () => {
    const { db, wb } = bible();
    diff(wb, [{ name: 'Humming Lantern' }], 1, 'market');
    diff(wb, [{ name: 'Glowing Lantern' }], 2, 'market');
    diff(wb, [{ name: 'Flickering Lantern' }], 3, 'aisle');
    expect(rows(db).map(r => r.name)).toEqual(['Humming Lantern', 'Flickering Lantern']);
  });

  it('labels, colours and different owners stay distinct', () => {
    const { db, wb } = bible();
    diff(wb, [{ name: 'Form 7-B' }, { name: 'Orange Key' }, { name: 'Madame Quill’s Ledger' }], 1, 'market');
    diff(wb, [{ name: 'Form 12-B' }, { name: 'Brass Key' }, { name: 'Barnaby’s Ledger' }], 1, 'market');
    expect(rows(db).map(r => r.name)).toEqual(['Form 7-B', 'Orange Key', 'Madame Quill’s Ledger', 'Form 12-B', 'Brass Key', 'Barnaby’s Ledger']);
  });
});

describe('4. the extractor\'s filings', () => {
  it('a known NPC is never filed as an item ("Squeaky Stool" is The Squeaky Stool)', () => {
    const { db, wb } = bible();
    diff(wb, [{ name: 'Squeaky Stool' }, { name: 'The Smudged Compass' }], 2, 'aisle');
    expect(rows(db).map(r => r.name)).toEqual(['The Smudged Compass']);
  });

  it('an NPC shown holding a thing is its holder; never over a party member, never an unknown name', () => {
    const { db, wb } = bible();
    diff(wb, [{ name: 'The Smudged Compass', heldBy: 'Madame Quill' }, { name: 'Brass Whistle', heldBy: 'Nobody Known' }], 1, 'market');
    expect(rows(db).find(r => r.name === 'The Smudged Compass')!.holder_id).toBe('quill');
    expect(rows(db).find(r => r.name === 'Brass Whistle')!.holder_id).toBeNull();
    wb.placeItem('c1', 'Pen', { scene: 1, locationId: 'market' });
    wb.placeItem('c1', 'Pen', { holderId: 'liz', scene: 1 });
    diff(wb, [{ name: 'Pen', heldBy: 'Barnaby the Badger' }], 1, 'market');
    expect(rows(db).find(r => r.name === 'Pen')!.holder_id).toBe('liz');
    // An existing thing no one holds: the NPC shown holding it now holds it.
    diff(wb, [{ name: 'Brass Whistle', heldBy: 'Barnaby' }], 1, 'market');
    expect(rows(db).find(r => r.name === 'Brass Whistle')!.holder_id).toBe('barnaby');
  });

  it('the extractor is asked for heldBy and told NPCs are never items', () => {
    expect(EXTRACTOR_ITEM_RULE).toMatch(/heldBy/);
    expect(EXTRACTOR_ITEM_RULE).toMatch(/never .*item/i);
  });
});

describe('5. a gone thing as the means is using it; asking about it is not', () => {
  const opts = (ds: string[]) => ds.map(description => ({ description }));
  it('the live option: calmed by the eaten granola bar — dropped', () => {
    const out = optionsWithoutGoneItems(opts([
      'I demand Madame Quill explain why Biz\'s bottle cap is blocking the exit.',
      'I ask Barnaby the Badger if the ink can be calmed by a granola bar.',
    ]), ['Granola bar'], ['Tote bag', 'Form 7-B', 'Bottle cap']);
    expect(out.map(o => o.description)).toEqual(['I demand Madame Quill explain why Biz\'s bottle cap is blocking the exit.']);
  });

  it('fixed with / using the gone thing — dropped; asking whether it counts or where it went — kept', () => {
    const out = optionsWithoutGoneItems(opts([
      'I fix the jammed latch with the granola bar.',
      'I ask Barnaby for help, using the granola bar as a bribe.',
      'I ask Barnaby if the granola bar counts as a proper offering.',
      'I ask Barnaby where the granola bar went.',
      'I hold Biz\'s hand.',
    ]), ['Granola bar'], ['Tote bag']);
    expect(out.map(o => o.description)).toEqual([
      'I ask Barnaby if the granola bar counts as a proper offering.',
      'I ask Barnaby where the granola bar went.',
      'I hold Biz\'s hand.',
    ]);
  });
});

describe('6. what a character says they have is on their own line', () => {
  it('the items block tells the speaker, words included', () => {
    const block = characterItemsBlock('Liz', [{ name: 'Liz', inventory: ['Tote bag', 'Form 7-B'] }, { name: 'Biz', inventory: ['Bottle caps', 'Pen'] }], []);
    expect(block).toMatch(/- Biz: Bottle caps, Pen/);
    expect(block).toMatch(/spokenWords|what you say/i);
    expect(block).toMatch(/never say you have/i);
  });
});
