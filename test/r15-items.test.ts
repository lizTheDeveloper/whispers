// Round 15: items, live game RZBU7G (Liz she/her, Biz they/them, 10). Round
// 14's itemMoves held up — zero cross-check disagreements, ~20 applied moves
// — and left four defects:
//  1. "Granola bar": Liz → Clerk 4-B, then "takes a bite": recorded as a
//     hand-over, so later he was "chewing on the granola bar he has been
//     hoarding" and the DB had the clerk holding "Granola Bar".
//  2. Liz handed over "Stamp of Clarity" (accepted in-story) while her line
//     said "The Stamp": refused. The DM kept coining names for that one stamp
//     (The Stamp, Stamp of Clarity, Square Stamp, Ink-Stained Stamp), and the
//     world table had "Pen" and "The Pen" side by side.
//  3. "Bottle caps": the world → the world (meant: Biz drops one), then a
//     "Green Bottle Cap" minted in the vent instead of the dropped cap.
//  4. "Ask Clerk 4-B if the Filing Chair can sign the witness form." dropped
//     as reaching for a gone thing (Form 12-B, given to Mildred).
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { planItemMoves } from '../src/server/item-moves.js';
import { eatenByReceiver, optionsWithoutGoneItems, namesOneThing, itemKey } from '../src/server/narrative-guards.js';
import { itemsOnHandBlock, ITEM_MOVES_RULE } from '../src/server/agents/dm.js';
import { WorldBible } from '../src/server/world-bible.js';

const LIZ_R14 = ['Tote bag', 'The Unfinished Biscuit', 'Pen', 'The Stamp', 'Brass button'];
const party = (liz: string[], biz: string[]) => [{ id: 'liz', name: 'Liz', inventory: [...liz] }, { id: 'biz', name: 'Biz', inventory: [...biz] }];

// The live ruling (RZBU7G), word for word.
const BITE = 'Liz extends the granola bar, and Clerk 4-B’s projector-lens eyes widen as a tiny, chattering squeak escapes his throat. He grabs the bar with trembling fingers, takes a bite that tastes like static and oatmeal, and the room’s ambient hum shifts into a low, satisfied hum as the system registers the valid crumb.';

describe('1. eaten is consumed, not a hand-over', () => {
  it('the moves rule: eaten food goes to null; give-then-eat is two moves or one straight to null', () => {
    expect(ITEM_MOVES_RULE).toMatch(/eat/i);
    expect(ITEM_MOVES_RULE).toMatch(/"to": null/);
    expect(ITEM_MOVES_RULE).toMatch(/two (?:moves|entries)/i);
  });

  it('the live ruling: the clerk bites the bar just handed to him', () => {
    expect(eatenByReceiver(BITE, 'Clerk 4-B', 'Granola bar', ['Liz', 'Biz'])).toBe(true);
    expect(eatenByReceiver('Clerk 4-B takes the granola bar and chews it slowly.', 'Clerk 4-B', 'Granola bar', ['Liz'])).toBe(true);
    expect(eatenByReceiver('Mama Pigeon swallows the biscuit whole.', 'Mama Pigeon', 'The Unfinished Biscuit', ['Liz'])).toBe(true);
  });

  it('not eaten: pocketed, only looked at, a threat, someone else eating, a thing that is not food', () => {
    expect(eatenByReceiver('Clerk 4-B tucks the granola bar into his waistcoat pocket.', 'Clerk 4-B', 'Granola bar', ['Liz'])).toBe(false);
    expect(eatenByReceiver('Clerk 4-B stares at the granola bar, as if he might eat it later.', 'Clerk 4-B', 'Granola bar', ['Liz'])).toBe(false);
    expect(eatenByReceiver('Clerk 4-B takes the granola bar. Liz takes a bite of her biscuit.', 'Clerk 4-B', 'Granola bar', ['Liz'])).toBe(false);
    expect(eatenByReceiver('Clerk 4-B takes the brass button and bites it to test the metal.', 'Clerk 4-B', 'Brass button', ['Liz'])).toBe(false);
    expect(eatenByReceiver('Clerk 4-B takes the granola bar and bites his lip.', 'Clerk 4-B', 'Granola bar', ['Liz'])).toBe(false);
  });

  it('consumed things are listed as eaten in the DM\'s items block', () => {
    const block = itemsOnHandBlock([{ name: 'Liz', inventory: ['Pen'] }], { gone: ['Granola bar'], eaten: ['Granola bar'] });
    expect(block).toMatch(/Eaten or used up[^\n]*granola bar/);
    expect(block).toMatch(/not even (?:with )?an NPC/i);
  });
});

describe('2. one stamp, one name', () => {
  it('"Stamp of Clarity" from Liz, who holds exactly one stamp ("The Stamp"): resolved to it and logged', () => {
    const p = planItemMoves([{ item: 'Stamp of Clarity', from: 'Liz', to: 'Clerk 4-B' }], party(LIZ_R14, ['Bottle caps']));
    expect(p.rejected).toEqual([]);
    expect(p.applied).toHaveLength(1);
    expect(p.applied[0]!.item).toBe('The Stamp');
    expect(p.inventories.get('liz')).toEqual(['Tote bag', 'The Unfinished Biscuit', 'Pen', 'Brass button']);
    expect(p.notes.join('\n')).toMatch(/"Stamp of Clarity".*"The Stamp"/);
  });

  it('two things with the same head noun: still refused', () => {
    const p = planItemMoves([{ item: 'Silver Key', from: 'Liz', to: 'Clerk 4-B' }], party(['Red Key', 'Blue Key'], []));
    expect(p.applied).toEqual([]);
    expect(p.rejected[0]).toMatch(/Silver Key/);
    expect(p.inventories.get('liz')).toEqual(['Red Key', 'Blue Key']);
  });

  it('a known alias resolves to the item it names', () => {
    const p = planItemMoves([{ item: 'Square Stamp', from: 'world', to: 'Biz' }], party([], []), { worldItems: ['The Stamp'], aliases: [{ alias: 'Square Stamp', name: 'The Stamp' }] });
    expect(p.applied[0]!.item).toBe('The Stamp');
    expect(p.inventories.get('biz')).toEqual(['The Stamp']);
  });

  it('the moves rule and the items block: call things by the exact names listed', () => {
    expect(ITEM_MOVES_RULE).toMatch(/exact name/i);
    expect(itemsOnHandBlock([{ name: 'Liz', inventory: ['The Stamp'] }])).toMatch(/exact name[^\n]*never a new name/i);
  });

  it('names for one thing, and names for two', () => {
    expect(itemKey('The Pen')).toBe(itemKey('pen'));
    expect(itemKey('Bottle caps')).toBe(itemKey('bottle cap'));
    expect(namesOneThing('The Stamp', 'Stamp of Clarity')).toBe(true);
    expect(namesOneThing('The Stamp', 'Square Stamp')).toBe(true);
    expect(namesOneThing('Bottle cap', 'Green Bottle Cap')).toBe(true);
    expect(namesOneThing('Orange Key', 'Brass Key')).toBe(false);
    expect(namesOneThing('Form 12-B', 'Form 88-B')).toBe(false);
    expect(namesOneThing('Pen', 'Waiver')).toBe(false);
  });
});

describe('2b. the world items table: "Pen" and "The Pen" are one row; a new name for a thing in this scene is an alias', () => {
  const bible = () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE campaigns (id TEXT PRIMARY KEY, join_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, dm_preset TEXT NOT NULL, scenario_id TEXT, system_id TEXT NOT NULL DEFAULT 'fate-core', host_user_id TEXT, house_rules TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE entities (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), type TEXT NOT NULL, name TEXT NOT NULL, description TEXT, disposition TEXT, alive INTEGER NOT NULL DEFAULT 1, location_id TEXT, metadata TEXT);
      CREATE TABLE locations (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), name TEXT NOT NULL, description TEXT, terrain TEXT, connections TEXT, coords TEXT);
      CREATE TABLE items (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), name TEXT NOT NULL, description TEXT, properties TEXT, holder_id TEXT, location_id TEXT);
      CREATE TABLE events (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), scene_number INTEGER NOT NULL, description TEXT NOT NULL, participants TEXT, outcome TEXT);
      CREATE TABLE relationships (campaign_id TEXT NOT NULL REFERENCES campaigns(id), entity_a_id TEXT NOT NULL, entity_b_id TEXT NOT NULL, type TEXT NOT NULL, description TEXT, PRIMARY KEY (campaign_id, entity_a_id, entity_b_id));
      CREATE TABLE characters (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), player_user_id TEXT, definition TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    `);
    db.prepare('INSERT INTO campaigns (id, join_code, name, dm_preset) VALUES (?, ?, ?, ?)').run('c1', 'RZBU7G', 'Test', 'chronicler');
    return { db, wb: new WorldBible(db) };
  };
  const rows = (db: Database.Database) => (db.prepare('SELECT name, properties FROM items WHERE campaign_id = ? ORDER BY rowid').all('c1') as Array<{ name: string; properties: string }>);

  it('dedupes by normalized name (article, case, plural)', () => {
    const { db, wb } = bible();
    wb.applyDiff('c1', { newLocations: [], newEntities: [], newEvents: [], newRelationships: [], newItems: [{ name: 'The Pen', description: 'Static pen' }] }, { markKnown: true, sceneNumber: 1 });
    wb.applyDiff('c1', { newLocations: [], newEntities: [], newEvents: [], newRelationships: [], newItems: [{ name: 'Pen', description: 'Object on desk' }, { name: 'Bottle caps', description: null }] }, { markKnown: true, sceneNumber: 1 });
    wb.applyDiff('c1', { newLocations: [], newEntities: [], newEvents: [], newRelationships: [], newItems: [{ name: 'bottle cap', description: null }] }, { markKnown: true, sceneNumber: 3 });
    expect(rows(db).map(r => r.name)).toEqual(['The Pen', 'Bottle caps']);
    wb.placeItem('c1', 'pen', { npcName: null });
    expect(wb.getItemNames('c1')).toEqual(['The Pen', 'Bottle caps']);
  });

  it('a new stamp in the same scene as "The Stamp" is an alias of it; a different form or key is its own item', () => {
    const { db, wb } = bible();
    const diff = (names: string[], scene: number) => wb.applyDiff('c1', { newLocations: [], newEntities: [], newEvents: [], newRelationships: [], newItems: names.map(name => ({ name, description: null })) }, { markKnown: true, sceneNumber: scene });
    diff(['The Stamp', 'Form 12-B', 'Orange Key'], 1);
    diff(['Stamp of Clarity', 'Square Stamp', 'Form 88-B', 'Brass Key'], 1);
    expect(rows(db).map(r => r.name)).toEqual(['The Stamp', 'Form 12-B', 'Orange Key', 'Form 88-B', 'Brass Key']);
    expect(wb.getItemAliases('c1')).toEqual(expect.arrayContaining([{ alias: 'Stamp of Clarity', name: 'The Stamp' }, { alias: 'Square Stamp', name: 'The Stamp' }]));
    // Moves under an alias find the row.
    wb.placeItem('c1', 'Square Stamp', { gone: true });
    expect(JSON.parse(rows(db)[0]!.properties).gone).toBe(1);
  });

  it('not in this scene: a new item, not an alias', () => {
    const { db, wb } = bible();
    const diff = (names: string[], scene: number) => wb.applyDiff('c1', { newLocations: [], newEntities: [], newEvents: [], newRelationships: [], newItems: names.map(name => ({ name, description: null })) }, { markKnown: true, sceneNumber: scene });
    diff(['The Stamp'], 1);
    diff(['Ink-Stained Stamp'], 3);
    expect(rows(db).map(r => r.name)).toEqual(['The Stamp', 'Ink-Stained Stamp']);
  });

  it('two stamps already here: ambiguous, a new item', () => {
    const { db, wb } = bible();
    const diff = (names: string[]) => wb.applyDiff('c1', { newLocations: [], newEntities: [], newEvents: [], newRelationships: [], newItems: names.map(name => ({ name, description: null })) }, { markKnown: true, sceneNumber: 1 });
    diff(['Red Stamp', 'Blue Stamp']);
    diff(['Stamp']);
    expect(rows(db)).toHaveLength(3);
  });
});

describe('3. no-op moves and the dropped cap', () => {
  it('"Bottle caps": the world → the world while Biz holds the stack: Biz drops one, and it is a world "Bottle cap"', () => {
    const p = planItemMoves([{ item: 'Bottle caps', from: 'world', to: 'world' }], party(['Pen'], ['Bottle caps', 'Brass button']));
    expect(p.inventories.get('biz')).toEqual(['Bottle caps', 'Brass button']);
    expect(p.applied).toHaveLength(1);
    expect(p.applied[0]).toEqual({ item: 'Bottle cap', from: { kind: 'pc', id: 'biz', name: 'Biz' }, to: { kind: 'world' } });
    expect(p.notes.join('\n')).toMatch(/same place/);
  });

  it('a single thing moved from the world to the world while one member holds it: that member dropped it', () => {
    const p = planItemMoves([{ item: 'Brass button', from: 'the floor', to: 'world' }], party(['Pen'], ['Bottle caps', 'Brass button']));
    expect(p.inventories.get('biz')).toEqual(['Bottle caps']);
    expect(p.applied[0]!.from).toEqual({ kind: 'pc', id: 'biz', name: 'Biz' });
  });

  it('nobody holds it: it stays in the world, logged, not silently dropped', () => {
    const p = planItemMoves([{ item: 'Green Bottle Cap', from: 'world', to: 'world' }], party(['Pen'], ['Brass button']));
    expect(p.rejected).toEqual([]);
    expect(p.notes.join('\n')).toMatch(/Green Bottle Cap[^\n]*same place/);
    expect(p.applied).toEqual([{ item: 'Green Bottle Cap', from: { kind: 'world' }, to: { kind: 'world' } }]);
  });

  it('Liz → Liz: logged, nothing moves', () => {
    const p = planItemMoves([{ item: 'Pen', from: 'Liz', to: 'Liz' }], party(['Pen'], []));
    expect(p.inventories.get('liz')).toEqual(['Pen']);
    expect(p.applied).toEqual([]);
    expect(p.rejected).toEqual([]);
    expect(p.notes.join('\n')).toMatch(/Pen[^\n]*same place/);
  });

  it('picking up "Green Bottle Cap" when the one loose cap in the world is the dropped "Bottle cap": it is that cap', () => {
    const p = planItemMoves([{ item: 'Green Bottle Cap', from: 'world', to: 'Liz' }], party(['Pen'], ['Bottle caps']), { worldItems: ['Bottle cap', 'The Stamp'], looseItems: ['Bottle cap', 'The Stamp'] });
    expect(p.applied[0]!.item).toBe('Bottle cap');
    expect(p.inventories.get('liz')).toEqual(['Pen', 'Bottle cap']);
  });

  it('two loose caps, or a differently named one: no guess', () => {
    const two = planItemMoves([{ item: 'Green Bottle Cap', from: 'world', to: 'Liz' }], party(['Pen'], []), { worldItems: ['Bottle cap', 'Red Bottle Cap'], looseItems: ['Bottle cap', 'Red Bottle Cap'] });
    expect(two.applied[0]!.item).toBe('Green Bottle Cap');
    const key = planItemMoves([{ item: 'Red Key', from: 'world', to: 'Liz' }], party(['Pen'], []), { worldItems: ['Silver Key'], looseItems: ['Silver Key'] });
    expect(key.applied[0]!.item).toBe('Red Key');
  });
});

describe('4. options: a different form is not the gone form', () => {
  const gone = ['Granola bar', 'Bottle cap', 'Form 12-B'];
  const held = ['Bottle caps', 'Brass button'];
  it('the live options survive', () => {
    const options = [
      { description: 'Ask Clerk 4-B if the Filing Chair can sign the witness form.' },
      { description: 'Slip under the desk to inspect the crumpled Form 88-B for hidden ink.' },
      { description: 'I tell Biz to hold my tote while I ask Clerk 4-B to show me the fine print on Form 88-B.' },
    ];
    expect(optionsWithoutGoneItems(options, gone, held)).toEqual(options);
  });
  it('the gone form itself, by name or plainly, still goes', () => {
    const options = [
      { description: 'I hand Form 12-B to the clerk again.' },
      { description: 'I sign the form and give it to Mildred.' },
      { description: 'I use my granola bar to bribe Clerk 4-B.' },
      { description: 'I ask Mildred where the Stamp went.' },
    ];
    expect(optionsWithoutGoneItems(options, gone, held).map(o => o.description)).toEqual(['I ask Mildred where the Stamp went.']);
  });
});
