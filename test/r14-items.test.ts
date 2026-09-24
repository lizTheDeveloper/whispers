// Round 14: items become structural. Live game 7RAAQ7 (Liz she/her, Biz
// they/them, 10). Four rounds of prose patterns kept losing to new wordings,
// so the DM now states every move of a thing as data — itemMoves, {item,
// from, to, qty?} — the server checks each against the real inventories and
// applies it, and prose parsing is only a cross-check.
//  1. "Mama Pigeon … offers a granola bar to Biz" moved LIZ's bar to Biz.
//  2. "The clerk takes the snack … takes a bite", then "Biz now holds
//     'Granola Bar'" — eaten, then back under another case.
//  3. "her tote bag snagged …, tearing a long strip of canvas and scattering
//     her pen": the tote vanished, the pen stayed.
//  4. "the Silver Key slips from Biz's fingers", then "I scoop up the Silver
//     Key … tuck it into my pocket": neither registered.
//  5. The world's "The Pen of Perpetual Pondering" next to the party's "Pen".
//  6. Gone things in the ending and in options ("… if the granola bar wrapper
//     is safe to eat").
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseItemMoves, planItemMoves, endingItemsBlock } from '../src/server/item-moves.js';
import { DmResolutionSchema, DmNarrationSchema } from '../src/server/agents/schemas.js';
import { narratedItemEvents, optionsWithoutMouthedThings, optionsWithoutGoneItems } from '../src/server/narrative-guards.js';
import { itemsOnHandBlock, ITEM_MOVES_RULE } from '../src/server/agents/dm.js';

const LIZ = { id: 'liz', name: 'Liz', inventory: ['Tote bag', 'Granola bar', 'Pen'] };
const BIZ = { id: 'biz', name: 'Biz', inventory: ['Bottle caps'] };
const party = (liz = LIZ.inventory, biz = BIZ.inventory) => [{ ...LIZ, inventory: [...liz] }, { ...BIZ, inventory: [...biz] }];

describe('itemMoves in the DM\'s JSON', () => {
  it('a ruling and a narration beat carry them; absent stays absent', () => {
    const base = { narration: 'x', outcome: 'success' };
    expect(DmResolutionSchema.parse(base).itemMoves).toBeUndefined();
    const r = DmResolutionSchema.parse({ ...base, itemMoves: [{ item: 'Pen', from: 'Liz', to: 'world' }, { item: 'Granola bar', from: 'Biz', to: null }, { item: 'Bottle caps', from: 'Biz', to: 'Liz', qty: 1 }] });
    expect(r.itemMoves).toEqual([{ item: 'Pen', from: 'Liz', to: 'world' }, { item: 'Granola bar', from: 'Biz', to: null }, { item: 'Bottle caps', from: 'Biz', to: 'Liz', qty: 1 }]);
    const n = DmNarrationSchema.parse({ narration: 'x', currentLocationName: '', activeNpcs: [], itemMoves: [] });
    expect(n.itemMoves).toEqual([]);
  });

  it('odd shapes degrade, never sink the reply', () => {
    expect(parseItemMoves([{ item: '' }, 'Pen to Biz', { item: 'Pen', from: 'nobody', to: 'Biz' }, { name: 'Silver Key', from: 'Biz', to: 'the floor', qty: '1' }]))
      .toEqual([{ item: 'Pen', from: null, to: 'Biz' }, { item: 'Silver Key', from: 'Biz', to: 'the floor', qty: 1 }]);
    expect(parseItemMoves('junk')).toEqual([]);
    expect(parseItemMoves(undefined)).toBeUndefined();
  });
});

describe('planItemMoves: the server checks each move against the real inventories', () => {
  it('1. an NPC\'s granola bar comes from the NPC — Liz keeps hers', () => {
    const p = planItemMoves([{ item: 'Granola bar', from: 'Mama Pigeon', to: 'Biz' }], party());
    expect(p.inventories.get('liz')).toEqual(['Tote bag', 'Granola bar', 'Pen']);
    expect(p.inventories.get('biz')).toEqual(['Bottle caps', 'Granola bar']);
    expect(p.applied[0]!.from).toEqual({ kind: 'npc', name: 'Mama Pigeon' });
  });

  it('2. eaten is gone; the same thing under another case never doubles up', () => {
    const eaten = planItemMoves([{ item: 'Granola Bar', from: 'Biz', to: 'Clerk Ozymandias' }], party(LIZ.inventory, ['Bottle caps', 'Granola bar']));
    expect(eaten.inventories.get('biz')).toEqual(['Bottle caps']);
    expect(eaten.applied[0]!.item).toBe('Granola bar');
    const twice = planItemMoves([{ item: 'granola BAR', from: 'world', to: 'Liz' }], party());
    expect(twice.inventories.get('liz')).toEqual(['Tote bag', 'Granola bar', 'Pen']);
  });

  it('3. a torn tote stays; the scattered pen goes to the world', () => {
    const p = planItemMoves([{ item: 'Pen', from: 'Liz', to: 'world' }], party());
    expect(p.inventories.get('liz')).toEqual(['Tote bag', 'Granola bar']);
    expect(p.applied[0]!.to).toEqual({ kind: 'world' });
  });

  it('4. dropped, then picked up by someone else', () => {
    const drop = planItemMoves([{ item: 'Silver Key', from: 'Biz', to: 'the floor' }], party(['Pen'], ['Bottle caps', 'Silver Key']));
    expect(drop.inventories.get('biz')).toEqual(['Bottle caps']);
    const pick = planItemMoves([{ item: 'silver key', from: 'world', to: 'Liz' }], party(['Pen'], ['Bottle caps']), { worldItems: ['Silver Key'] });
    expect(pick.inventories.get('liz')).toEqual(['Pen', 'Silver Key']);
  });

  it('4b. a pick-up from the world of a unique world item the record still has in a companion\'s hand: it leaves that hand (the drop went unrecorded)', () => {
    const p = planItemMoves([{ item: 'Silver Key', from: 'world', to: 'Liz' }], party(['Pen'], ['Bottle caps', 'Silver Key']), { worldItems: ['Silver Key'] });
    expect(p.inventories.get('liz')).toEqual(['Pen', 'Silver Key']);
    expect(p.inventories.get('biz')).toEqual(['Bottle caps']);
  });

  it('a move from someone who does not hold it is refused and changes nothing', () => {
    // Round 15 (RZBU7G): a name sharing the head noun of exactly one thing
    // the giver holds is that thing ("Stamp of Clarity" for "The Stamp"), so
    // the refusal is for a thing with no such match.
    const p = planItemMoves([{ item: 'Silver Key', from: 'Liz', to: 'Biz' }], party());
    expect(p.inventories.get('liz')).toEqual(LIZ.inventory);
    expect(p.inventories.get('biz')).toEqual(BIZ.inventory);
    expect(p.applied).toEqual([]);
    expect(p.rejected[0]).toMatch(/Liz does not hold "Silver Key"/);
  });

  it('one from a stack: the receiver gets one, the giver keeps the stack', () => {
    const p = planItemMoves([{ item: 'Bottle caps', from: 'Biz', to: 'Liz', qty: 1 }], party(['Tote bag']));
    expect(p.inventories.get('biz')).toEqual(['Bottle caps']);
    expect(p.inventories.get('liz')).toEqual(['Tote bag', 'Bottle cap']);
    const single = planItemMoves([{ item: 'Bottle cap', from: 'Biz', to: 'Liz' }], party(['Tote bag']));
    expect(single.inventories.get('biz')).toEqual(['Bottle caps']);
    expect(single.inventories.get('liz')).toEqual(['Tote bag', 'Bottle cap']);
  });

  it('a PC is found by first name, any case; a hand-over between PCs moves the thing', () => {
    const p = planItemMoves([{ item: 'pen', from: 'liz', to: 'BIZ' }], [{ id: 'liz', name: 'Liz Howard', inventory: ['Pen'] }, { id: 'biz', name: 'Biz', inventory: [] }]);
    expect(p.inventories.get('liz')).toEqual([]);
    expect(p.inventories.get('biz')).toEqual(['Pen']);
  });

  it('moves apply in order: handed over, then eaten', () => {
    const p = planItemMoves([{ item: 'Granola bar', from: 'Liz', to: 'Biz' }, { item: 'Granola bar', from: 'Biz', to: null }], party());
    expect(p.inventories.get('liz')).toEqual(['Tote bag', 'Pen']);
    expect(p.inventories.get('biz')).toEqual(['Bottle caps']);
  });
});

describe('1. prose cross-check: an NPC\'s offer never takes a PC\'s thing', () => {
  it('"Mama Pigeon … offers a granola bar to Biz" gives Biz nothing of Liz\'s', () => {
    const text = 'Mama Pigeon hops forward, her tiny talons clicking a rapid staccato against the linoleum as she offers a granola bar to Biz, her eyes wide with anxious anticipation.';
    const events = narratedItemEvents(text, party().map(p => ({ name: p.name, inventory: p.inventory })));
    expect(events.filter(e => e.kind === 'gain' && e.from === 'Liz')).toEqual([]);
  });

  it('still: "Liz hands the granola bar to Biz" moves it', () => {
    const events = narratedItemEvents('Liz hands the granola bar to Biz.', party().map(p => ({ name: p.name, inventory: p.inventory })));
    expect(events).toContainEqual({ kind: 'gain', to: 'Biz', item: 'Granola bar', from: 'Liz' });
  });
});

describe('5. the items block names who holds what, world items as held by nobody', () => {
  const block = itemsOnHandBlock([{ name: 'Liz', inventory: ['Tote bag', 'Pen'] }, { name: 'Biz', inventory: ['Bottle caps', 'Pen'] }], {
    world: [{ name: 'The Pen of Perpetual Pondering' }, { name: 'Silver Key', heldBy: 'Clerk Ozymandias' }],
    gone: ['Granola bar'],
  });
  it('lists the party, the world and what is gone', () => {
    expect(block).toMatch(/^- Liz: Tote bag, Pen$/m);
    expect(block).toMatch(/^- The Pen of Perpetual Pondering — not held by anyone in the party$/m);
    expect(block).toMatch(/^- Silver Key — held by Clerk Ozymandias$/m);
    expect(block).toMatch(/Gone for good[^\n]*: Granola bar/);
  });
  it('spells out a name clash', () => {
    expect(block).toMatch(/"Pen" \(Liz, Biz\) and "The Pen of Perpetual Pondering" are different things/);
  });
  it('the moves rule says damaged is not gone, and an NPC\'s thing comes from the NPC', () => {
    expect(ITEM_MOVES_RULE).toMatch(/itemMoves/);
    expect(ITEM_MOVES_RULE).toMatch(/Damaged is not gone/);
    expect(ITEM_MOVES_RULE).toMatch(/never from a player character/);
  });
});

describe('6. gone things in the ending and in options', () => {
  it('the ending block lists what each holds and what is gone', () => {
    const b = endingItemsBlock([{ name: 'Liz', inventory: ['Pen'] }, { name: 'Biz', inventory: ['Bottle caps', 'Silver Key'] }], ['Granola bar', 'Tote bag']);
    expect(b).toMatch(/^- Liz: Pen$/m);
    expect(b).toMatch(/^- Biz: Bottle caps, Silver Key$/m);
    expect(b).toMatch(/Granola bar, Tote bag/);
    expect(b).toMatch(/never say anyone still has/i);
  });

  it('"… if the granola bar wrapper is safe to eat" goes; "… if the granola bar counts" stays', () => {
    const wrapper = { description: 'I ask Mama Pigeon if the granola bar wrapper is safe to eat.' };
    const counts = { description: 'I ask Clerk Ozymandias if the granola bar counts as the sentimental substitute for the Lanyard.' };
    const cookie = { description: 'I ask Mama Pigeon if the cookie is safe to eat.' };
    const cap = { description: 'I ask Button whether a bottle cap is edible.' };
    const eatWrapper = { description: 'I eat the granola bar wrapper to prove a point.' };
    const muffin = { description: 'I bite into the muffin.' };
    const kept = optionsWithoutMouthedThings([wrapper, counts, cookie, cap, eatWrapper, muffin], ['Bottle caps', 'Pen']);
    expect(kept).toEqual([counts, cookie, muffin]);
    expect(optionsWithoutGoneItems([counts], ['Granola bar'], ['Pen'])).toEqual([counts]);
  });
});
