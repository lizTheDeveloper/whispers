// Round 11: item tracking recorded nothing. Live game Z9JKG2 (qwen/qwen3.8-27b;
// Liz she/her, Biz they/them): both inventories stayed [] all game. The kit
// from character creation only ever became aspects; the pen Liz threw to Biz,
// the Fading Form Liz scooped up, and the form Clerk Marni slid across the
// counter were never recorded; and with nothing on record the DM's prose
// contradicted itself. Each block quotes the live line.
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { CharacterDefinition } from '../src/shared/types.js';
import { narratesItemTransfer, narratesItemTransferRecently, narratedItemEvents, declaredTakes, confirmsClaim } from '../src/server/narrative-guards.js';
import { startingKit } from '../src/server/starting-kit.js';

const LIZ_SHEET: CharacterDefinition = {
  name: 'Liz', highConcept: 'Tired but resourceful mom navigating bureaucratic reality with a pen and a granola bar', trouble: 'She worries too much about Biz',
  aspects: ['Great at paperwork', 'Very good at finding lost things', 'Carrying a tote bag with a granola bar and a pen'],
  personality: 'Tired, resourceful, protective, and practical', backstory: 'Liz is a mom who is used to managing chaos and finding what is missing, whether it\'s a lost kid or a lost form.',
  skills: { Notice: 3, Will: 3 }, stunts: ['Found It!'], pronouns: 'she/her', relationships: [{ to: 'Biz', relation: 'child', address: 'Biz' }],
};
const BIZ_SHEET: CharacterDefinition = {
  name: 'Biz', highConcept: 'Shiny-Obsessed 10-Year-Old Explorer', trouble: 'Wanders off after anything shiny',
  aspects: ['Pocket full of bottle caps', 'Eager to show finds to Mom', 'Curious about the Department\'s secrets'],
  personality: 'Super curious', backstory: 'Stamped into the Department of Misfiled Reality due to a clerical error alongside their mother, Liz.',
  skills: { Notice: 3, Athletics: 3 }, stunts: ['Tiny and Quick'], age: 10, pronouns: 'they/them', relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }],
};

// Live, Z9JKG2.
const MARNI_SLIDES_FORM = "Clerk Marni adjusts their saucer-sized spectacles, the lenses catching the amber light, and taps a rubber stamp the size of a dinner plate against the counter with a rhythmic, hollow thud. \"A 'Recall' is a very specific category, Liz, and quite frankly, a bit messy for a Tuesday,\" Marni chirps, sliding a blank form across the polished wood while the air around them smells faintly of ozone and old ink. \"However, since you are holding a child who is currently trying to lick the counter, I will grant you a 'Provisional Exit'—provided you can find the correct filing cabinet before the next chime.\"";
const GRANOLA_THROWN = 'Liz hurls the granola bar across the gap, the wrapper flapping like a tired flag, but her shout scatters the loose envelopes into a swirling, rustling tornado that buries Biz deeper. Marni catches the snack with a cheerful *crunch*, their magnified eyes widening with genuine delight as they take a bite, but the gesture accidentally nudges the dial another notch, sending the floor spinning faster and the air thickening with the sharp, metallic scent of ozone.';
const PEN_THROWN = 'Liz hurls the pen with the precise, desperate arc of a mother who has been up since five a.m., and Biz snatches it out of the air with a sharp *fwip* that cuts through the lemon-scented fog. But the order is already losing the war; Biz’s eyes are locked on the distant glint of The Shiny Object, and as they bring the pen to the fading form, their hand trembles, scratching out a signature that looks less like a name and more like a small, jagged hiccup.';
const KEY_OFFERED = "Biz’s eyes dart between the glinting key in Marni’s hand and Liz’s firm, protective stance, the air around the counter humming with the static charge of a dozen unclosed envelopes. Marni’s saucer spectacles fog up with sudden humidity, and she offers a wobbly smile that doesn't quite reach her eyes, the rubber stamp in her other hand tapping a nervous, irregular beat against the wood. \"The key is yours to hold, dear, but the Intake Hall has a... strong opinion about shiny things being kept; you'll find it's heavier than it looks, and the next chime is already in the air, smelling faintly of burnt toast and urgency.\"";
const FORM_IN_LIZ_HAND = "The chime does not ring so much as it rips through the air, a high, sweet note that tastes like mint and urgency, causing the Fading Form in Liz’s hand to crinkle violently as the ink bleeds into a soft, violet haze. The Postman’s Shadow slides forward, its tiny hat tilting with a precise, bureaucratic nod, and extends a gloved hand toward the empty space where the key has vanished.";
const FORM_IN_LIZ_GRIP = "The Postman’s Shadow tilts its tiny hat, its static voice crackling like a radio losing signal: 'The file for the Unsent is open, but the key is sticky with yesterday’s mail.' Biz’s hand jerks toward the Shiny Object, the tag humming with a scent that is exactly the back of the library, while the Fading Form in Liz’s grip dissolves into a violet haze, its ink thinning with every second they hesitate.";
const PEN_EATEN = "Marni scrambles behind her desk, clutching the brass-bound ledger to her chest, and squeaks, 'You cannot process an exit without a signature, and the storm has eaten the pen!' A gust of cold air, smelling faintly of wet wool and old ink, rushes under the desk, pushing the Blue Whale Cap closer to Biz’s sneakers while the shelves groan in protest.";

const LIZ_SCOOPS = 'Scoop up the Fading Form and tuck it into my tote bag, then look to the Postman’s Shadow for direction.';
const LIZ_STEPS_IN = 'Liz steps across the threshold, her foot sinking into the mist which tastes of wet ink and old glue, curling around her ankles like cold water. The Fading Form in her grip shudders, its ink thinning to a faint violet haze that smells distinctly of lavender and regret.';
const ODO_LANDS = 'A heavy, papery rustle cuts through the silence as Odo the Owl descends from the high ledgers, their parchment-colored feathers ruffling like the pages of an ancient book, and lands with a soft *thump* on the counter beside the Fading Form.';

// The world's items at that point (the extractor had added several forms).
const WORLD_ITEMS = ['The Fading Form', 'The Shiny Object', 'Recall Form', 'Loose Envelopes', 'Emergency Re-File Form', 'Dinner Plate Stamp'];

describe('1. the starting kit from character creation is the starting inventory', () => {
  it('Liz: "Carrying a tote bag with a granola bar and a pen"', () => {
    expect(startingKit(LIZ_SHEET)).toEqual(['Tote bag', 'Granola bar', 'Pen']);
  });

  it('Biz: "Pocket full of bottle caps"', () => {
    expect(startingKit(BIZ_SHEET)).toEqual(['Bottle caps']);
  });

  it('the aspects stay as they are', () => {
    const before = JSON.stringify(LIZ_SHEET);
    startingKit(LIZ_SHEET);
    expect(JSON.stringify(LIZ_SHEET)).toBe(before);
  });

  it('never an abstraction: grudges, burdens, the weight of the world, a heavy heart', () => {
    const sheet = (aspects: string[], highConcept = 'Wizard with a Grudge'): CharacterDefinition => ({ ...LIZ_SHEET, highConcept, aspects });
    expect(startingKit(sheet(['Carrying the weight of the world', 'Carries a heavy heart', 'Holding a grudge against the Guild']))).toEqual([]);
    expect(startingKit(sheet(['Great at paperwork', 'Very good at finding lost things']))).toEqual([]);
  });

  it('other concrete kit phrasings', () => {
    const sheet = (aspects: string[]): CharacterDefinition => ({ ...LIZ_SHEET, highConcept: 'Detective', aspects });
    expect(startingKit(sheet(['Never without my trusty lantern', 'Armed with a rusty sword and a wooden shield']))).toEqual(['Trusty lantern', 'Rusty sword', 'Wooden shield']);
    expect(startingKit(sheet(['Satchel full of maps']))).toEqual(['Satchel', 'Maps']);
  });
});

describe('2. hand-offs the prose narrates are recorded', () => {
  const seeded = () => [{ name: 'Liz', inventory: ['Tote bag', 'Granola bar', 'Pen'] }, { name: 'Biz', inventory: ['Bottle caps'] }];

  it('"Liz hurls the pen …, and Biz snatches it out of the air": Biz holds the pen, Liz no longer does', () => {
    expect(narratedItemEvents(PEN_THROWN, seeded(), WORLD_ITEMS)).toEqual([{ kind: 'gain', to: 'Biz', item: 'Pen', from: 'Liz' }]);
  });

  it('"the Fading Form in Liz’s hand": Liz holds the Fading Form, though three world items are forms', () => {
    expect(narratedItemEvents(FORM_IN_LIZ_HAND, seeded(), WORLD_ITEMS)).toEqual([{ kind: 'gain', to: 'Liz', item: 'The Fading Form', from: null }]);
    expect(narratedItemEvents(FORM_IN_LIZ_GRIP, seeded(), WORLD_ITEMS)).toEqual([{ kind: 'gain', to: 'Liz', item: 'The Fading Form', from: null }]);
  });

  it('holding and clutching: "Biz clutches the pen"', () => {
    expect(narratedItemEvents('Liz is crouched under the counter with Biz, while Biz clutches the pen with a trembling hand.', seeded(), WORLD_ITEMS))
      .toEqual([{ kind: 'gain', to: 'Biz', item: 'Pen', from: 'Liz' }]);
  });

  it('Marni sliding a blank form across the polished wood to Liz, whose ruling it is, lets the ruling\'s add stand', () => {
    expect(narratesItemTransfer(MARNI_SLIDES_FORM, 'The Provisional Exit Form', 'Liz', { acting: true })).toBe(true);
    expect(narratesItemTransferRecently(MARNI_SLIDES_FORM, [], 'The Provisional Exit Form', 'Liz', { acting: true })).toBe(true);
  });

  it('…but not for a companion the slide was never aimed at, and not toward someone else', () => {
    expect(narratesItemTransfer(MARNI_SLIDES_FORM, 'The Provisional Exit Form', 'Biz')).toBe(false);
    expect(narratesItemTransfer('Marni slides a blank form across the counter to the Postman.', 'The Provisional Exit Form', 'Liz', { acting: true })).toBe(false);
    expect(narratesItemTransfer('Liz slides a blank form across the counter.', 'The Provisional Exit Form', 'Liz', { acting: true })).toBe(false);
  });

  it('never a pronoun with nothing named, nor a catch of a thing two items could be', () => {
    expect(narratedItemEvents('Biz snatches it out of the air.', seeded(), WORLD_ITEMS)).toEqual([]);
    expect(narratedItemEvents('The Recall Form and the Fading Form flutter down, and Biz snatches it out of the air.', seeded(), WORLD_ITEMS)).toEqual([]);
  });
});

describe('2b. the player\'s own declared pick-up, once the prose confirms it', () => {
  it('"Scoop up the Fading Form and tuck it into my tote bag" claims the Fading Form', () => {
    expect(declaredTakes(LIZ_SCOOPS, WORLD_ITEMS)).toEqual(['The Fading Form']);
    expect(declaredTakes('I look at the Fading Form and ask Marni what it is.', WORLD_ITEMS)).toEqual([]);
    expect(declaredTakes('Grab a granola bar from my tote and offer it to Marni.', WORLD_ITEMS)).toEqual([]);
  });

  it('"The Fading Form in her grip shudders", in Liz\'s own ruling, confirms her claim', () => {
    const opts = { ownRuling: true, party: ['Liz', 'Biz'], pronouns: 'she/her' };
    expect(confirmsClaim(LIZ_STEPS_IN, 'Liz', 'The Fading Form', opts)).toBe(true);
    expect(confirmsClaim(LIZ_STEPS_IN, 'Liz', 'The Fading Form', { ...opts, ownRuling: false })).toBe(false);
    expect(confirmsClaim(LIZ_STEPS_IN, 'Liz', 'The Fading Form', { ...opts, pronouns: 'he/him' })).toBe(false);
  });

  it('a mention that is not possession does not', () => {
    expect(confirmsClaim(ODO_LANDS, 'Liz', 'The Fading Form', { ownRuling: true, party: ['Liz', 'Biz'], pronouns: 'she/her' })).toBe(false);
  });
});

describe('3. items given away, destroyed or lost leave the inventory', () => {
  const seeded = () => [{ name: 'Liz', inventory: ['Tote bag', 'Granola bar', 'Pen'] }, { name: 'Biz', inventory: ['Bottle caps'] }];

  it('"Liz hurls the granola bar … Marni catches the snack": the granola bar is gone', () => {
    // Two sentences: the throw names Liz, the catch names Marni.
    expect(narratedItemEvents(GRANOLA_THROWN, seeded(), WORLD_ITEMS)).toEqual([{ kind: 'loss', from: 'Liz', item: 'Granola bar' }]);
  });

  it('handed to an NPC by name', () => {
    expect(narratedItemEvents('Biz hands the silver bottle cap to Odo, who tucks it under a wing.', [{ name: 'Liz', inventory: [] }, { name: 'Biz', inventory: ['Silver bottle cap'] }]))
      .toEqual([{ kind: 'loss', from: 'Biz', item: 'Silver bottle cap' }]);
    expect(narratedItemEvents('Odo takes the bottle cap from Biz and tucks it into a hidden pocket on their wing.', [{ name: 'Liz', inventory: [] }, { name: 'Biz', inventory: ['Silver bottle cap'] }]))
      .toEqual([{ kind: 'loss', from: 'Biz', item: 'Silver bottle cap' }]);
  });

  it('one cap from a pocketful leaves the rest', () => {
    expect(narratedItemEvents('Biz hands a bottle cap to Odo.', seeded(), WORLD_ITEMS)).toEqual([]);
  });

  it('"the storm has eaten the pen!" — after Biz caught it, Biz no longer has it', () => {
    const party = [{ name: 'Liz', inventory: ['Tote bag', 'Granola bar'] }, { name: 'Biz', inventory: ['Bottle caps', 'Pen'] }];
    expect(narratedItemEvents(PEN_EATEN, party, WORLD_ITEMS)).toEqual([{ kind: 'loss', from: 'Biz', item: 'Pen' }]);
  });
});

describe('4. a spoken-only offer is still not a transfer', () => {
  it('"The key is yours to hold, dear" — the key stays in Marni\'s hand', () => {
    for (const item of ['The Shiny Object', 'Misfiled Key']) {
      expect(narratesItemTransfer(KEY_OFFERED, item, 'Biz', { acting: true })).toBe(false);
      expect(narratesItemTransferRecently(KEY_OFFERED, [], item, 'Biz', { acting: true })).toBe(false);
    }
    expect(narratedItemEvents(KEY_OFFERED, [{ name: 'Liz', inventory: [] }, { name: 'Biz', inventory: [] }], ['Misfiled Key', ...WORLD_ITEMS])).toEqual([]);
  });

  it('holding out is an offer, not a hand-off', () => {
    expect(narratesItemTransfer('Clerk Marni holds out a fresh, blank form with a smile that is almost too wide.', 'Recall Form', 'Liz', { acting: true })).toBe(false);
  });
});
