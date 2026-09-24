// Round 19: items, live game KAZQX3 (Liz she/her, Biz they/them, 10, gentle
// peril). See r19-items-loop.test.ts for play.
//  a. Biz set a bottle cap by Mom's feet in the lobby; the scene moved to the
//     Umbrella Aisle and Liz pocketed it: "the record's 'Bottle cap' lies at
//     another place — this is another one" — a cap minted from nothing.
//  b. One cap rolled out of Liz's tote; `Bottle cap: Liz → the world` came in
//     two rulings running (×3 → ×2 → 1). And "Bottle cap: Biz → the world"
//     twice too.
//  c. "the brass key in Biz's pocket" gave Biz a "Brass Key" beside the
//     "The Golden Key" they held.
//  d. "The bird's beak clicks shut around it" (the granola bar) was logged as
//     held; the record then had a loose "Granola Bar".
//  e. "Liz holds the stale sheet up like a shield" gave Liz "Fresh Sheet".
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { planItemMoves, type AppliedMove } from '../src/server/item-moves.js';
import { narratedItemEvents, eatenByReceiver, withoutGoneThings } from '../src/server/narrative-guards.js';
import { WorldBible } from '../src/server/world-bible.js';
import { migrate } from '../src/server/db.js';

const party = (liz: string[], biz: string[]) => [{ id: 'liz', name: 'Liz', inventory: [...liz] }, { id: 'biz', name: 'Biz', inventory: [...biz] }];
const LIZ_SIDE = { kind: 'pc' as const, id: 'liz', name: 'Liz' };
const BIZ_SIDE = { kind: 'pc' as const, id: 'biz', name: 'Biz' };
const WORLD = { kind: 'world' as const };

// ─── a. A cap a party member just set down travels with the party ──────────

const PICKUP = 'Liz pockets the bottle cap with a soft, satisfying clink and turns to the bird, her voice steady as a metronome.';

describe('a. a pick-up of a thing a party member set down a beat or two ago is that thing, wherever its record says it lies', () => {
  it('the live beat: the cap Biz set down in the lobby, picked up in the Umbrella Aisle, is the record\'s cap — one more on Liz\'s stack', () => {
    const p = planItemMoves([{ item: 'bottle cap', from: 'world', to: 'Liz' }], party(['Tote bag', 'Bottle caps ×2'], ['Bottle caps']), {
      worldItems: ['Bottle cap'], looseItems: [], elsewhere: ['Bottle cap'], recentDrops: ['Bottle cap'], actorId: 'liz', prose: PICKUP,
    });
    expect(p.inventories.get('liz')).toEqual(['Tote bag', 'Bottle caps ×3']);
    expect(p.applied).toHaveLength(1);
    expect(p.applied[0]!.fresh).toBeUndefined();
    expect(p.applied[0]!.item).toBe('Bottle cap');
    expect(p.notes.join('\n')).not.toMatch(/another place/);
    expect(p.notes.join('\n')).toMatch(/set down .* a moment ago/);
  });

  it('round 16 stands: a thing lying elsewhere that no one set down lately is another one', () => {
    const p = planItemMoves([{ item: 'Bottle cap', from: 'world', to: 'Biz' }], party(['Tote bag'], ['Bottle caps', 'Pen']), { worldItems: ['Bottle cap'], looseItems: [], elsewhere: ['Bottle cap'], recentDrops: [] });
    expect(p.applied[0]!.fresh).toBe(true);
    expect(p.notes.join('\n')).toMatch(/another place/);
  });
});

// ─── b. A move already made is not made twice ──────────────────────────────

const ROLL_OUT = 'She spots a critical clause about \'pending disputes\' that matches the smudged log, but just as she reaches to point it out, the sheet slips slightly, and a single, small bottle cap rolls out of her tote bag, clattering loudly against the wooden counter.';
const LUNGE = 'Biz lunges for the rolling bottle cap, their small fingers brushing the smooth, cold metal just as it tumbles off the counter\'s edge with a sharp, metallic clatter, landing squarely in the spreading ink puddle.';
const lastBeat: AppliedMove[] = [{ item: 'Bottle cap', from: LIZ_SIDE, to: WORLD }];

describe('b. the same move as the last beat\'s, with nothing new in the prose, is the same event told again', () => {
  it('the live pair: the cap rolled out on Liz\'s turn; Biz\'s ruling re-sent `Liz → the world` — Liz keeps two', () => {
    const p = planItemMoves([{ item: 'Bottle cap', from: 'Liz', to: 'world' }], party(['Tote bag', 'Bottle caps ×2', 'Fresh Sheet'], ['Bottle caps', 'The Golden Key']), {
      recentMoves: lastBeat, actorId: 'biz', prose: LUNGE,
    });
    expect(p.inventories.get('liz')).toEqual(['Tote bag', 'Bottle caps ×2', 'Fresh Sheet']);
    expect(p.applied).toEqual([]);
    expect([...p.notes, ...p.rejected].join('\n')).toMatch(/same move .* last beat/);
  });

  it('the first telling still applies', () => {
    const p = planItemMoves([{ item: 'Bottle cap', from: 'Liz', to: 'world' }], party(['Bottle caps ×3'], []), { recentMoves: [], actorId: 'liz', prose: ROLL_OUT });
    expect(p.inventories.get('liz')).toEqual(['Bottle caps ×2']);
  });

  it('a fresh instance in the prose is a second move: "another", "a second", "one more"', () => {
    for (const prose of ['Another bottle cap slips out of Liz\'s tote and rolls away.', 'A second bottle cap tumbles out of Liz\'s tote bag.', 'One more cap rolls out of Liz\'s tote.']) {
      const p = planItemMoves([{ item: 'Bottle cap', from: 'Liz', to: 'world' }], party(['Bottle caps ×2'], []), { recentMoves: lastBeat, actorId: 'biz', prose });
      expect(p.inventories.get('liz'), prose).toEqual(['Bottle cap']);
    }
  });

  it('the giver acting again is a new action: Liz drops another on her own turn', () => {
    const p = planItemMoves([{ item: 'Bottle cap', from: 'Liz', to: 'world' }], party(['Bottle caps ×2'], []), { recentMoves: lastBeat, actorId: 'liz', prose: 'Liz sets a bottle cap on the counter.' });
    expect(p.inventories.get('liz')).toEqual(['Bottle cap']);
  });

  it('the live lobby pair: "Bottle cap: Biz → the world" re-sent with Liz\'s pick-up is dropped, the pick-up stands', () => {
    const p = planItemMoves([{ item: 'bottle cap', from: 'world', to: 'Liz' }, { item: 'Bottle cap', from: 'Biz', to: 'world' }], party(['Tote bag', 'Bottle caps ×2'], ['Bottle caps ×3']), {
      worldItems: ['Bottle cap'], looseItems: [], elsewhere: ['Bottle cap'], recentDrops: ['Bottle cap'], recentMoves: [{ item: 'Bottle cap', from: BIZ_SIDE, to: WORLD }], actorId: 'liz',
      prose: 'Liz pockets the bottle cap Biz had set by her feet with a soft, satisfying clink.',
    });
    expect(p.inventories.get('liz')).toEqual(['Tote bag', 'Bottle caps ×3']);
    expect(p.inventories.get('biz')).toEqual(['Bottle caps ×3']);
    expect(p.applied).toHaveLength(1);
  });
});

// ─── c. A paraphrase of what the same member holds is that thing ────────────

const LIZ_ITEMS = ['Tote bag', 'Bottle caps ×2', 'Fresh Sheet'];
const BIZ_ITEMS = ['Bottle caps', 'The Golden Key'];

describe('c. "the brass key in Biz\'s pocket" is the Golden Key Biz holds', () => {
  const people = [{ name: 'Liz', inventory: LIZ_ITEMS }, { name: 'Biz', inventory: BIZ_ITEMS }];
  it('the live narration beat', () => {
    const text = "Marmot Mailman hovers nearby, his satchel swinging nervously, and mutters, 'If that cap clogs the mechanism, the whole intake log will jam for hours.' He glances at the brass key in Biz's pocket, his whiskers twitching with a sudden, desperate hope.";
    expect(narratedItemEvents(text, people, ['The Golden Key', 'Brass Key', 'Fresh Sheet', 'Envelope'])).toEqual([]);
  });

  it('the live epilogue line', () => {
    const text = 'Liz smoothed the Fresh Sheet against the counter while Biz held the brass key tight in their pocket, the two of them standing shoulder to shoulder in the Umbrella Aisle.';
    expect(narratedItemEvents(text, people, ['The Golden Key', 'Brass Key'])).toEqual([]);
  });

  it('a new key picked up is still a gain', () => {
    const text = 'Biz snatches the brass key from the counter.';
    expect(narratedItemEvents(text, people, ['The Golden Key', 'Brass Key'])).toEqual([{ kind: 'gain', to: 'Biz', item: 'Brass Key', from: null }]);
  });
});

// ─── d. Eaten is gone ───────────────────────────────────────────────────────

const EATEN = 'The bird’s beak clicks shut around it, and her shoulders drop two inches, the frantic drumming in her chest slowing to a steady, grateful thump. Marmot Mailman scurries forward, his paws slippery with sweat as he grabs the pen from Liz’s outstretched hand.';
const OTHERS = ['Liz', 'Biz', 'Marmot Mailman', 'The Typewriter'];

describe('d. a beak, jaws or mouth closing around the food just handed over is eating it', () => {
  it('the live ruling: "The bird\'s beak clicks shut around it"', () => {
    expect(eatenByReceiver(EATEN, 'Hazel', 'Granola bar', OTHERS)).toBe(true);
  });

  it.each([
    "Hazel's jaws snap shut around the granola bar.",
    'Her mouth closes over the granola bar with a happy crunch.',
    "Hazel's beak snaps shut on it.",
  ])('eaten: %s', (prose) => {
    expect(eatenByReceiver(prose, 'Hazel', 'Granola bar', OTHERS)).toBe(true);
  });

  it.each([
    'Hazel’s beak clicks shut on the edge of the paper, and she squeaks.',
    "The Marmot Mailman's mouth snaps shut around it.",
    'Hazel’s beak snaps shut in alarm.',
    "Hazel's beak clicks shut around the pen.",
  ])('not eaten: %s', (prose) => {
    expect(eatenByReceiver(prose, 'Hazel', 'Granola bar', OTHERS)).toBe(false);
  });

  it('a food eaten with no world record becomes a gone record, never a loose one', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare('INSERT INTO campaigns (id, join_code, name, dm_preset) VALUES (?, ?, ?, ?)').run('c1', 'KAZQX3', 'Test', 'chronicler');
    const wb = new WorldBible(db);
    wb.placeItem('c1', 'Granola bar', { gone: true, scene: 2 });
    const row = db.prepare('SELECT holder_id, properties FROM items WHERE campaign_id = ? AND name = ?').get('c1', 'Granola bar') as { holder_id: string | null; properties: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.holder_id).toBeNull();
    expect(JSON.parse(row!.properties).gone).toBe(1);
    expect(JSON.parse(row!.properties).locationId).toBeUndefined();
  });

  it('the extractor\'s "Granola Bar" after it went is not filed as a loose thing', () => {
    const items = [{ name: 'Granola Bar', description: 'Food item for calming' }, { name: 'Lavender Stamp', description: 'Stamp' }];
    expect(withoutGoneThings(items, ['Granola bar']).map(i => i.name)).toEqual(['Lavender Stamp']);
    expect(withoutGoneThings(items, [])).toEqual(items);
  });
});

// ─── e. "the stale sheet" is not the Fresh Sheet ────────────────────────────

describe('e. a word that contradicts the item\'s name is another thing', () => {
  const people = [{ name: 'Liz', inventory: ['Tote bag', 'Granola bar', 'Pen', 'Bottle cap'] }, { name: 'Biz', inventory: ['Bottle caps'] }];
  it('the live ruling: "Liz holds the stale sheet up like a shield" is not Liz gaining "Fresh Sheet"', () => {
    const text = "Liz holds the stale sheet up like a shield, the paper trembling slightly in her grip as the Typewriter's carriage jerks forward with a frustrated clatter.";
    expect(narratedItemEvents(text, people, ['Fresh Sheet'])).toEqual([]);
    expect(narratedItemEvents(text.replace('stale', 'outdated'), people, ['Fresh Sheet'])).toEqual([]);
  });

  it('"the sheet" or "the fresh sheet" still is', () => {
    const text = 'Liz picks up the fresh sheet from the counter.';
    expect(narratedItemEvents(text, people, ['Fresh Sheet'])).toEqual([{ kind: 'gain', to: 'Liz', item: 'Fresh Sheet', from: null }]);
    expect(narratedItemEvents('Liz picks up the sheet from the counter.', people, ['Fresh Sheet'])).toEqual([{ kind: 'gain', to: 'Liz', item: 'Fresh Sheet', from: null }]);
  });
});

describe('c. (cont.) a companion\'s thing handed over is still a hand-over', () => {
  it('Liz holds a pen; Biz presses the Red Pen into Liz\'s palm — Liz gains it', () => {
    const people = [{ name: 'Liz', inventory: ['Pen'] }, { name: 'Biz', inventory: ['Red Pen'] }];
    expect(narratedItemEvents('Biz presses the Red Pen into Liz\'s palm.', people, [])).toEqual([{ kind: 'gain', to: 'Liz', item: 'Red Pen', from: 'Biz' }]);
  });
});
