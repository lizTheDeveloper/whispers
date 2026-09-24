// Round 13: items. Live game WXKC2C (Liz she/her, Biz they/them, 10). Each
// block quotes the live line.
//  1. The pen toss: "a soft arc of black plastic … landing perfectly in Biz’s
//     waiting palm". The add of "Pen" for Biz was dropped (the ruling never
//     said "pen"), the remove from Liz was applied, and the pen vanished. The
//     extractor also made a world item "Black Plastic Object".
//  2. The hand-back: "Biz’s small hand closes around … the pen and guides it
//     firmly into Liz’s waiting palm" gave Liz nothing.
//  3. "the golden paperclip glinting in Biz’s pocket" never put the paperclip
//     in Biz's inventory.
//  4. "Slip a bottle cap into Mom's palm" moved Biz's whole "Bottle caps" and
//     added a second "Bottle Cap": Liz ["Tote bag","Bottle caps","Bottle Cap"], Biz [].
//  5. Options offered gone items ("I use the granola bar to bribe Unit 7-G…")
//     and a child swallowing a bottle cap ("I swallow the metal cap…").
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  sameItem, narratedItemEvents, narratesItemTransfer, reconcileItemChanges, releasedInAction,
  withoutHeldParaphrases, optionsWithoutGoneItems, optionsWithoutMouthedThings, singleOf,
} from '../src/server/narrative-guards.js';

// World items at the end of WXKC2C (the extractor's names; "Black Plastic Object" is the bug).
const WORLD_ITEMS = ['The Rubber Stamp of No-Opinion', 'A Muffin, Still Warm', 'Form 12-A', 'Golden Paperclip', 'Form 14-S', 'Clipboard', 'Lemon-scented Intake Slip', 'Bottle Caps', 'Business Card', 'Blank Clipboard', 'Form 7-C', 'Central Ledger', 'Granola Bar', 'Rubber Stamp of No-Opinion', 'Bottle Cap', 'Sticky Card', 'Red-ink Pen', 'Missing Form', 'Violet Ink Puddle'];

const TOSS_ACTION = 'Reach into my tote bag, pull out the pen, and toss it gently toward Biz through the narrowing gap.';
const TOSS = "Liz’s toss is gentle, a soft arc of black plastic that glides through the narrowing air with a faint, satisfying whoosh, landing perfectly in Biz’s waiting palm. From the other side, Biz’s voice comes back, slightly muffled but steady, “Got it, Mom. I’m right here.”";
const HANDBACK_ACTION = "Reach up and place the pen directly into Mom's hand so she can sign Form 7-C.";
const HANDBACK = "Biz’s small hand closes around the cool, smooth barrel of the pen and guides it firmly into Liz’s waiting palm, the metal clicking softly against her knuckles with a reassuring, metallic chime. Liz’s fingers close around the instrument with the practiced ease of a woman who has signed thousands of invoices, and she looks down at the pen, then at her son, a quiet, steady warmth settling in her chest. Barnaby Twist lets out a small, relieved squeak, his bow-tie slackening as he scrambles to uncork the inkwell, the sharp, chemical tang of fresh ink suddenly filling the air between them.";
const PAPERCLIP = "Liz's pen taps a sharp, rhythmic code against her palm, the click cutting through the dusty air like a metronome in a silent room. Ms. Hark’s pen stops mid-tap, her eyes flickering between Liz’s unflappable stance and the golden paperclip glinting in Biz’s pocket, before she sighs with the heavy resignation of a woman who has been interrupted by a tax audit. \"Form 7-C, 'Residency Verification: Non-Standard Household,'\" Hark says, her voice dropping to a dry, bureaucratic murmur. \"It is in the bottom drawer of the only cabinet in this room that is currently not trying to file your child away.\"";
const CAP_ACTION = "Slip a bottle cap into Mom's palm and squeeze her hand, smiling up at her to anchor her against the rain.";
// The ruling as it reached the table (a sentence was stripped as an echo);
// Liz's memory of the beat: "I felt Biz slip a bottle cap into my palm".
const CAP_RULING = "Biz slips a bottle cap into Liz's palm and squeezes her hand. Liz’s eyes widen, and for a heartbeat, the rain seems to pause, her expression softening into a fierce, protective smile as she feels the promise in that grip. But Unit 7-G lets out a high-pitched, metallic shriek of annoyance, its drawer-pull mouth twisting into a grimace, and the machine lurches forward with a grinding, rhythmic thud that vibrates through the wet pavement, blocking the path to the golden paperclip.";

const inv = (id: string, name: string, items: string[]) => ({ id, name, inventory: items });

describe('1. the pen toss: an item released and received moves, it never vanishes', () => {
  it('the tossed "it" is the pen the thrower just released', () => {
    expect(releasedInAction(TOSS_ACTION, ['Tote bag', 'Granola bar', 'Pen'])).toEqual(['Pen']);
    expect(releasedInAction(HANDBACK_ACTION, ['Bottle caps', 'Pen'])).toEqual(['Pen']);
    expect(releasedInAction('I pull the pen from my tote bag, grip it firmly, and turn to face Barnaby Twist.', ['Tote bag', 'Pen'])).toEqual([]);
  });

  it('"a soft arc of black plastic … landing perfectly in Biz’s waiting palm" shows Biz receiving the released pen', () => {
    expect(narratesItemTransfer(TOSS, 'Pen', 'Biz')).toBe(false);
    expect(narratesItemTransfer(TOSS, 'Pen', 'Biz', { released: ['Pen'] })).toBe(true);
    // Not the thrower, and not a pen nobody let go of.
    expect(narratesItemTransfer(TOSS, 'Pen', 'Liz', { released: ['Pen'] })).toBe(false);
  });

  it('prose tracking moves the released pen to Biz', () => {
    const party = [{ name: 'Liz', inventory: ['Tote bag', 'Granola bar', 'Pen'] }, { name: 'Biz', inventory: ['Bottle caps'] }];
    expect(narratedItemEvents(TOSS, party, WORLD_ITEMS, { released: [{ from: 'Liz', item: 'Pen' }] }))
      .toEqual([{ kind: 'gain', to: 'Biz', item: 'Pen', from: 'Liz' }]);
    // Already removed from Liz by the ruling: Biz still gets it.
    const after = [{ name: 'Liz', inventory: ['Tote bag', 'Granola bar'] }, { name: 'Biz', inventory: ['Bottle caps'] }];
    expect(narratedItemEvents(TOSS, after, WORLD_ITEMS, { released: [{ from: 'Liz', item: 'Pen' }] }))
      .toEqual([{ kind: 'gain', to: 'Biz', item: 'Pen', from: null }]);
    // Without a release, nothing is guessed.
    expect(narratedItemEvents(TOSS, party, WORLD_ITEMS)).toEqual([]);
  });

  it('WXKC2C: remove "Pen" from Liz paired with add "Pen" for Biz keeps both, even when the prose never names it', () => {
    const holders = [inv('liz', 'Liz', ['Tote bag', 'Granola bar', 'Pen']), inv('biz', 'Biz', ['Bottle caps'])];
    const changes = [
      { characterId: 'liz', field: 'inventory', action: 'remove', value: 'Pen' },
      { characterId: 'biz', field: 'inventory', action: 'add', value: 'Pen' },
      { characterId: 'liz', field: 'fatePoints', action: 'set', value: 0 },
    ];
    const out = reconcileItemChanges(changes, holders, { actorId: 'liz', action: 'I shout.', narration: 'Something happens.', shown: () => false });
    expect(out.changes).toEqual(changes);
  });

  it('an add with no pairing and no prose is still dropped', () => {
    const holders = [inv('liz', 'Liz', ['Tote bag']), inv('biz', 'Biz', ['Bottle caps'])];
    const changes = [{ characterId: 'liz', field: 'inventory', action: 'add', value: 'Form 14-S' }];
    const out = reconcileItemChanges(changes, holders, { actorId: 'liz', action: 'I read the form.', narration: 'Hark frowns.', shown: () => false });
    expect(out.changes).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/dropped an inventory add of "Form 14-S" for Liz/);
  });

  it('a lone remove of an item the prose shows another member receiving becomes a move', () => {
    const holders = [inv('liz', 'Liz', ['Tote bag', 'Pen']), inv('biz', 'Biz', ['Bottle caps'])];
    const changes = [{ characterId: 'liz', field: 'inventory', action: 'remove', value: 'Pen' }];
    const out = reconcileItemChanges(changes, holders, { actorId: 'liz', action: TOSS_ACTION, narration: TOSS, shown: () => false });
    expect(out.changes).toEqual([
      { characterId: 'liz', field: 'inventory', action: 'remove', value: 'Pen' },
      { characterId: 'biz', field: 'inventory', action: 'add', value: 'Pen' },
    ]);
  });

  it('"Black Plastic Object" (a description of the held pen) is not a new world item; real new things are', () => {
    const items = [{ name: 'Black Plastic Object', description: 'Tossed gently through air' }, { name: 'Form 7-C', description: 'Muddy starburst verification form' }, { name: 'Shiny Pen', description: 'x' }];
    expect(withoutHeldParaphrases(items, ['Tote bag', 'Pen', 'Bottle caps']).map(i => i.name)).toEqual(['Form 7-C']);
    // Nothing held: a generic name is left for the world to keep.
    expect(withoutHeldParaphrases(items, []).map(i => i.name)).toEqual(['Black Plastic Object', 'Form 7-C', 'Shiny Pen']);
  });
});

describe('2. the hand-back: "guides it firmly into Liz’s waiting palm"', () => {
  it('prose tracking moves the pen from Biz to Liz', () => {
    const party = [{ name: 'Liz', inventory: ['Tote bag', 'Form 7-C'] }, { name: 'Biz', inventory: ['Bottle caps', 'Pen'] }];
    expect(narratedItemEvents(HANDBACK, party, WORLD_ITEMS)).toEqual([{ kind: 'gain', to: 'Liz', item: 'Pen', from: 'Biz' }]);
  });

  it('a ruling that adds the pen for Liz is shown by it', () => {
    expect(narratesItemTransfer(HANDBACK, 'Pen', 'Liz')).toBe(true);
    expect(narratesItemTransfer(HANDBACK, 'Pen', 'Biz')).toBe(false);
  });

  it('other ways a thing is put in someone\'s hand', () => {
    const party = [{ name: 'Liz', inventory: [] }, { name: 'Biz', inventory: ['Pen'] }];
    for (const line of [
      "Biz picks up the pen and presses it into Liz's hand.",
      "Biz takes the pen and slips it into Liz’s open palm.",
      "Biz holds out the pen and guides it gently into Liz's hand.",
    ]) expect(narratedItemEvents(line, party)).toEqual([{ kind: 'gain', to: 'Liz', item: 'Pen', from: 'Biz' }]);
  });
});

describe('3. prose stating a thing is in a member\'s pocket, sleeve or hand', () => {
  it('WXKC2C: "the golden paperclip glinting in Biz’s pocket" puts the Golden Paperclip with Biz', () => {
    const party = [{ name: 'Liz', inventory: ['Tote bag', 'Granola bar', 'Pen'] }, { name: 'Biz', inventory: ['Bottle caps'] }];
    expect(narratedItemEvents(PAPERCLIP, party, WORLD_ITEMS)).toEqual([{ kind: 'gain', to: 'Biz', item: 'Golden Paperclip', from: null }]);
  });

  it('a portable thing that is not yet a world item', () => {
    const party = [{ name: 'Liz', inventory: ['Tote bag'] }, { name: 'Biz', inventory: ['Bottle caps'] }];
    expect(narratedItemEvents('Hark glares at the brass key hidden in Biz’s sleeve.', party)).toEqual([{ kind: 'gain', to: 'Biz', item: 'Brass key', from: null }]);
  });

  it('never a body part, a person, or something the member already has', () => {
    const party = [{ name: 'Liz', inventory: ['Tote bag'] }, { name: 'Biz', inventory: ['Bottle caps', 'Golden Paperclip'] }];
    expect(narratedItemEvents('Liz slides her hand in Biz’s hand.', party)).toEqual([]);
    expect(narratedItemEvents('The golden paperclip glinting in Biz’s pocket hums.', party, WORLD_ITEMS)).toEqual([]);
    expect(narratedItemEvents('Biz’s bottle caps jingle softly in their pocket.', party, WORLD_ITEMS)).toEqual([]);
  });
});

describe('4. one from a stack is a single, and the stack stays', () => {
  it('singular and plural are the same noun', () => {
    expect(sameItem('Bottle caps', 'Bottle Cap')).toBe(true);
    expect(sameItem('Bottle Caps', 'bottle cap')).toBe(true);
    expect(sameItem('Keys', 'Key')).toBe(true);
    expect(sameItem('Glass', 'Glas')).toBe(false);
    expect(sameItem('Orange Key', 'Blue Keys')).toBe(false);
    expect(singleOf('Bottle caps')).toBe('Bottle cap');
    expect(singleOf('Matches')).toBe('Match');
    expect(singleOf('Berries')).toBe('Berry');
  });

  it('WXKC2C: the ruling moved the stack; a bottle cap slipped into Mom\'s palm gives Liz one and leaves Biz the rest', () => {
    const holders = [inv('liz', 'Liz', ['Tote bag']), inv('biz', 'Biz', ['Bottle caps'])];
    const changes = [
      { characterId: 'biz', field: 'inventory', action: 'remove', value: 'Bottle caps' },
      { characterId: 'liz', field: 'inventory', action: 'add', value: 'Bottle caps' },
    ];
    const out = reconcileItemChanges(changes, holders, { actorId: 'biz', action: CAP_ACTION, narration: CAP_RULING, shown: () => true });
    expect(out.changes).toEqual([{ characterId: 'liz', field: 'inventory', action: 'add', value: 'Bottle cap' }]);
    expect(out.keep).toEqual([{ holderId: 'biz', item: 'Bottle caps' }]);
  });

  it('a singular add from the ruling never takes the stack either', () => {
    const holders = [inv('liz', 'Liz', ['Tote bag']), inv('biz', 'Biz', ['Bottle caps'])];
    const changes = [{ characterId: 'liz', field: 'inventory', action: 'add', value: 'Bottle Cap' }];
    const out = reconcileItemChanges(changes, holders, { actorId: 'biz', action: 'Hold out my hand to Mom.', narration: CAP_RULING, shown: () => true });
    expect(out.changes).toEqual([{ characterId: 'liz', field: 'inventory', action: 'add', value: 'Bottle Cap' }]);
    expect(out.keep).toEqual([{ holderId: 'biz', item: 'Bottle caps' }]);
  });

  it('handing over the whole stack still moves the stack', () => {
    const holders = [inv('liz', 'Liz', ['Tote bag']), inv('biz', 'Biz', ['Bottle caps'])];
    const changes = [
      { characterId: 'biz', field: 'inventory', action: 'remove', value: 'Bottle caps' },
      { characterId: 'liz', field: 'inventory', action: 'add', value: 'Bottle caps' },
    ];
    const out = reconcileItemChanges(changes, holders, { actorId: 'biz', action: 'Pour all my bottle caps into Mom\'s hands.', narration: "Biz pours the bottle caps into Liz's hands.", shown: () => true });
    expect(out.changes).toEqual(changes);
    expect(out.keep).toEqual([]);
  });

  it('prose tracking: "Biz slips a bottle cap into Liz\'s palm" is one cap for Liz, not the stack and not a duplicate', () => {
    const party = [{ name: 'Liz', inventory: ['Tote bag'] }, { name: 'Biz', inventory: ['Bottle caps'] }];
    expect(narratedItemEvents(CAP_RULING, party, WORLD_ITEMS)).toEqual([{ kind: 'gain', to: 'Liz', item: 'Bottle cap', from: null }]);
    // Liz already has one: nothing new.
    const again = [{ name: 'Liz', inventory: ['Tote bag', 'Bottle cap'] }, { name: 'Biz', inventory: ['Bottle caps'] }];
    expect(narratedItemEvents(CAP_RULING, again, WORLD_ITEMS)).toEqual([]);
  });
});

describe('5. options never reach for gone things, and never put a thing in a mouth', () => {
  const opts = (...ds: string[]) => ds.map(description => ({ description, reasoning: 'r' }));

  it('WXKC2C: "I use the granola bar to bribe Unit 7-G…" after the bar was given away is dropped', () => {
    const got = optionsWithoutGoneItems(opts(
      'I hand Biz the business card and ask Ms. Hark to witness our signature.',
      'I ask Clerk Barnaby Twist if the golden smear can be wiped clean.',
      'I use the granola bar to bribe Unit 7-G into sliding away from the door.',
    ), ['Granola bar', "Ms. Hark's Business Card"], ['Tote bag', 'Bottle caps']);
    expect(got.map(o => o.description)).toEqual(['I ask Clerk Barnaby Twist if the golden smear can be wiped clean.']);
  });

  it('"take Mom\'s granola bar" is dropped; looking for a lost thing is kept; a held namesake keeps it', () => {
    const got = optionsWithoutGoneItems(opts(
      "Take Mom's granola bar and step back beside her.",
      'I search under the desk for the lost pen.',
      'I ask Hark about the stamp.',
    ), ['Granola bar', 'Pen'], ['Tote bag']);
    expect(got.map(o => o.description)).toEqual(['I search under the desk for the lost pen.', 'I ask Hark about the stamp.']);
    expect(optionsWithoutGoneItems(opts('I tap my pen on the desk.'), ['Pen'], ['Red-ink Pen']).length).toBe(1);
  });

  it('WXKC2C: "I swallow the metal cap…" and "Swallow the metallic taste of the chewed bottle cap" are dropped; food is fine', () => {
    const got = optionsWithoutMouthedThings(opts(
      'I swallow the metal cap and ask Barnaby Twist where the Archive is calling us.',
      "Swallow the metallic taste of the chewed bottle cap, take Mom's granola bar, and step back to stand right beside her.",
      "I grab Mom's sleeve and pull her toward the glowing doorway before the ink dries.",
      'I bite into the muffin to satisfy the witness requirement.',
      'I swallow my fear and step forward.',
      'I chew on the pen while I think.',
    ), ['Bottle caps', 'Tote bag', 'A Muffin, Still Warm']);
    expect(got.map(o => o.description)).toEqual([
      "I grab Mom's sleeve and pull her toward the glowing doorway before the ink dries.",
      'I bite into the muffin to satisfy the witness requirement.',
      'I swallow my fear and step forward.',
    ]);
  });
});
