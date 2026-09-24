// Round 12: items. Live game 7MJXE5 (qwen/qwen3.8-27b; Liz she/her, Biz
// they/them). Each block quotes the live line.
//  1. Liz's kit was three aspects: "Always carries a canvas tote bag", "Tote
//     bag contains a granola bar", "Tote bag contains a pen". Only the tote
//     was seeded.
//  2. Biz pressed the Pen into Liz's palm (moved correctly); then "the Shiny
//     Pen in Liz’s hand" gave her a second pen: ["Canvas tote bag","Pen","Shiny Pen"].
//  3. "Barnaby’s beak snaps shut on it with a satisfying *crunch*" never took
//     the granola bar away, and a later "I jam the granola bar from my tote
//     into…" was ruled as if she still had it.
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { startingKit } from '../src/server/starting-kit.js';
import { sameItem, narratedItemEvents, usesMissingItems } from '../src/server/narrative-guards.js';

const LIZ = {
  highConcept: 'Unflappable Accountant Mom',
  aspects: ['Always carries a canvas tote bag', 'Tote bag contains a granola bar', 'Tote bag contains a pen', 'Resourceful and calm under pressure', 'Tired but dedicated'],
};
const BIZ = { highConcept: 'Curious Kid Collector', aspects: ['Pocket full of bottle caps', 'Mom is my home base'] };

// World items at the end of 7MJXE5 (the extractor's names).
const WORLD_ITEMS = ['The Stapler of Intent', 'A Ticket to Nowhere (But Everywhere)', 'Shiny Pen', 'Vanilla Receipts', 'Bottle Caps', 'Damp Blank Form', 'Form 7-B', 'Shiny Bottle Cap', 'Granola Bar', 'Vanilla Receipt', 'Damp Sticky Note', 'Pen', 'Golden Stamp', 'Damp Sticker', 'Loose Sheet of Paper', 'Bottle Cap'];

const PEN_PRESSED = "Biz presses the cool metal of the Pen firmly into Liz's palm, the small click of the cap releasing audible in the sudden silence of the atrium. Liz’s fingers close around it instinctively, her expression softening from worry to focused determination as she feels the weight of it settle.";
const GOOSE_EYES_PEN = "A wet, rubbery *thwack* echoes from the corner as Barnaby the Bureaucratic Goose slides into the frame, its tiny briefcase banging against the floor with a hollow clatter that smells faintly of old library dust. The goose waddles directly between Officer Tick-Tock and the party, its large eyes fixed on the Shiny Pen in Liz’s hand, blocking the automaton’s line of sight with a stubborn, white-feathered wall.";
const GRANOLA_CRUNCH = 'Liz snatches the granola bar from her tote and hurls it with the precision of a woman who has balanced more ledgers than she cares to admit, the sticky, oat-heavy scent cutting through the vanilla air just before Barnaby’s beak snaps shut on it with a satisfying *crunch*. She yanks Biz down into the low hum of the static field, where the air tastes like licking a battery and their hair lifts in a wild, crackling halo. The goose chews absently, its eyes glazed and happy, while Officer Tick-Tock’s brass claw hovers uselessly an inch above the empty space where the child used to be, its clock-face head spinning in a confused, high-pitched whir of bureaucratic frustration.';
const JAM_GRANOLA = "I jam the granola bar from my tote into the Shiny Pen's glint to block Pudding's view, then hiss at Biz to stay still.";

describe('1. the starting kit reads what a container holds', () => {
  it('Liz 7MJXE5: "Tote bag contains a granola bar", "Tote bag contains a pen"', () => {
    expect(startingKit(LIZ)).toEqual(['Canvas tote bag', 'Granola bar', 'Pen']);
  });

  it('Biz 7MJXE5: "Pocket full of bottle caps" still works', () => {
    expect(startingKit(BIZ)).toEqual(['Bottle caps']);
  });

  it('other containment phrasings', () => {
    const kit = (...aspects: string[]) => startingKit({ highConcept: 'Mom', aspects });
    expect(kit('A tote bag with a pen and a granola bar inside')).toEqual(['Tote bag', 'Pen', 'Granola bar']);
    expect(kit('Tote bag full of snacks')).toEqual(['Tote bag', 'Snacks']);
    expect(kit('Always has a tote bag holding a pen, a granola bar')).toEqual(['Tote bag', 'Pen', 'Granola bar']);
    expect(kit('My backpack holds a flashlight and a map')).toEqual(['Backpack', 'Flashlight', 'Map']);
    expect(kit('Her satchel contains a pen, a notebook, and a compass')).toEqual(['Satchel', 'Pen', 'Notebook', 'Compass']);
  });

  it('a container named twice is one container', () => {
    expect(startingKit({ highConcept: 'Mom', aspects: ['Tote bag contains a pen', 'Always carries a canvas tote bag'] })).toEqual(['Canvas tote bag', 'Pen']);
  });

  it('never an abstraction or a condition', () => {
    const kit = (...aspects: string[]) => startingKit({ highConcept: 'Mom', aspects });
    expect(kit('Backpack holds the weight of the world')).toEqual(['Backpack']);
  });
});

describe('2. an adjective variant is the item already held', () => {
  it('"Shiny Pen" is the Pen; "Shiny Bottle Cap" the bottle cap', () => {
    expect(sameItem('Shiny Pen', 'Pen')).toBe(true);
    expect(sameItem('Pen', 'the shiny pen')).toBe(true);
    expect(sameItem('Cool Metal Pen', 'Pen')).toBe(true);
  });

  it('distinct named things stay distinct', () => {
    expect(sameItem('The Fading Form', 'Recall Form')).toBe(false);
    expect(sameItem('The Fading Form', 'Form')).toBe(false);
    expect(sameItem('Orange Key', 'Blue Key')).toBe(false);
    expect(sameItem('Orange Key', 'Key')).toBe(false);
    expect(sameItem('Golden Stamp', 'Damp Sticker')).toBe(false);
  });

  it('7MJXE5: the pen pressed into Liz\'s palm, then "the Shiny Pen in Liz’s hand": no second pen', () => {
    const party = [{ name: 'Liz', inventory: ['Canvas tote bag', 'Pen'] }, { name: 'Biz', inventory: ['Bottle caps'] }];
    expect(narratedItemEvents(PEN_PRESSED, party, WORLD_ITEMS)).toEqual([]);
    expect(narratedItemEvents(GOOSE_EYES_PEN, party, WORLD_ITEMS)).toEqual([]);
  });

  it('"the Shiny Pen in Liz’s hand" while Biz holds the Pen moves that pen, not a new one', () => {
    const party = [{ name: 'Liz', inventory: ['Canvas tote bag'] }, { name: 'Biz', inventory: ['Bottle caps', 'Pen'] }];
    expect(narratedItemEvents(GOOSE_EYES_PEN, party, WORLD_ITEMS)).toEqual([{ kind: 'gain', to: 'Liz', item: 'Pen', from: 'Biz' }]);
  });
});

describe('3. an item eaten is gone, and the DM is told when a player reaches for it', () => {
  it('7MJXE5: "Barnaby’s beak snaps shut on it with a satisfying *crunch*": Liz no longer has the granola bar', () => {
    const party = [{ name: 'Liz', inventory: ['Canvas tote bag', 'Granola bar', 'Pen'] }, { name: 'Biz', inventory: ['Bottle caps'] }];
    expect(narratedItemEvents(GRANOLA_CRUNCH, party, WORLD_ITEMS)).toEqual([{ kind: 'loss', from: 'Liz', item: 'Granola bar' }]);
  });

  it('other ways an NPC eats it', () => {
    const party = [{ name: 'Liz', inventory: ['Granola bar'] }];
    expect(narratedItemEvents('Liz tosses the granola bar and the goose gobbles it down.', party)).toEqual([{ kind: 'loss', from: 'Liz', item: 'Granola bar' }]);
    expect(narratedItemEvents("Barnaby's beak snaps shut on the granola bar.", party)).toEqual([{ kind: 'loss', from: 'Liz', item: 'Granola bar' }]);
    expect(narratedItemEvents('Barnaby chomps the granola bar in two bites.', party)).toEqual([{ kind: 'loss', from: 'Liz', item: 'Granola bar' }]);
  });

  it('not a threat, and not an "it" that is something else', () => {
    const party = [{ name: 'Liz', inventory: ['Granola bar'] }];
    expect(narratedItemEvents('Liz waves the granola bar, and the goose looks ready to gobble it up.', party)).toEqual([]);
    expect(narratedItemEvents('Liz clutches the granola bar while Barnaby spots a receipt and his beak snaps shut on it.', party, ['Vanilla Receipt'])).toEqual([]);
  });

  it('7MJXE5: "I jam the granola bar from my tote into…" with no granola bar on hand names it as missing', () => {
    const known = [...startingKit(LIZ), ...WORLD_ITEMS];
    expect(usesMissingItems(JAM_GRANOLA, ['Canvas tote bag', 'Pen'], known)).toEqual(['Granola bar']);
  });

  it('not when it is on hand, not someone else\'s thing, not a pick-up', () => {
    const known = [...startingKit(LIZ), ...WORLD_ITEMS];
    expect(usesMissingItems(JAM_GRANOLA, ['Canvas tote bag', 'Granola bar', 'Pen'], known)).toEqual([]);
    expect(usesMissingItems('I tell Biz to hold the Shiny Pen away from Barnaby.', ['Canvas tote bag'], known)).toEqual([]);
    expect(usesMissingItems('I pick up the Golden Stamp.', ['Canvas tote bag'], known)).toEqual([]);
    expect(usesMissingItems('I block Barnaby with my hip.', ['Canvas tote bag'], known)).toEqual([]);
  });

  it('"my pen" when only the Shiny Pen is on hand is not missing', () => {
    expect(usesMissingItems('I write my name with my pen.', ['Shiny Pen'], ['Pen', 'Shiny Pen'])).toEqual([]);
  });
});
