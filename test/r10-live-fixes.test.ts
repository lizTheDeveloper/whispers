// Round 10: what the round-9 live verification (game N7RQZ7; qwen/qwen3.8-27b;
// Liz she/her, Biz they/them, Liz's sheet calls Biz her "kid") still got
// wrong. Each block quotes the live line.
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { WorldSeed } from '../src/shared/types.js';
import { ownKinNouns } from '../src/server/pronoun-consistency.js';
import { kinWordDirective, type PartyMemberView } from '../src/server/agents/character.js';
import {
  narratesItemTransfer, narratesItemTransferRecently, narratedItemEvents, itemHead, sameItem, softenForChildren, changedSpan,
} from '../src/server/narrative-guards.js';
import { seedForHost, withHiddenSeedFields } from '../src/server/world-seed.js';
import { assembleSystemPrompt, childToneRule, wantsGentlePeril } from '../src/server/agents/dm.js';

const LIZ = { name: 'Liz', pronouns: 'she/her', relationships: [{ to: 'Biz', relation: 'kid' }] };
const BIZ = { name: 'Biz', pronouns: 'they/them', relationships: [{ to: 'Liz', relation: 'mother' }] };
const PARTY = [LIZ, BIZ];

// ─── 1. "My son" in a character's own words ─────────────────────────────────

describe('1. a character calls their kid what their sheet calls them', () => {
  const LIVE = 'Excuse me. My son is a minor, but if you’re looking for a signature on a misfiled arrival, I’m the one who needs to know who signs off on the correction.';

  it('the live line: Liz\'s "My son" is "My kid"', () => {
    expect(ownKinNouns(LIVE, LIZ, PARTY)).toBe('Excuse me. My kid is a minor, but if you’re looking for a signature on a misfiled arrival, I’m the one who needs to know who signs off on the correction.');
  });

  it('daughter, boy, girl, and "my little boy" too; "child" when that is the recorded word', () => {
    expect(ownKinNouns('Keep your hands off my daughter.', LIZ, PARTY)).toBe('Keep your hands off my kid.');
    expect(ownKinNouns('That is my little boy you are shouting at.', LIZ, PARTY)).toBe('That is my little kid you are shouting at.');
    expect(ownKinNouns('I tell the clerk our girl needs a form too.', LIZ, PARTY)).toBe('I tell the clerk our kid needs a form too.');
    const lizChild = { ...LIZ, relationships: [{ to: 'Biz', relation: 'child' }] };
    expect(ownKinNouns('My son is a minor.', lizChild, [lizChild, BIZ])).toBe('My child is a minor.');
  });

  it('left alone: a noun that fits, a sheet that says "son", another speaker, a kid outside the party', () => {
    const tom = { name: 'Tom', pronouns: 'he/him', relationships: [{ to: 'Liz', relation: 'mother' }] };
    expect(ownKinNouns('My son is a minor.', LIZ, [LIZ, tom])).toBe('My son is a minor.');
    // Pronouns unstated and the speaker's own sheet says "son": their word.
    const lizSon = { ...LIZ, relationships: [{ to: 'Biz', relation: 'son' }] };
    expect(ownKinNouns('My son is a minor.', lizSon, [lizSon, { name: 'Biz', pronouns: null }])).toBe('My son is a minor.');
    // Biz has no child at the table.
    expect(ownKinNouns('My son is a minor.', BIZ, PARTY)).toBe('My son is a minor.');
    // A son who is not at the table may be the one meant.
    const lizTwo = { ...LIZ, relationships: [{ to: 'Biz', relation: 'kid' }, { to: 'Tomas', relation: 'son' }] };
    expect(ownKinNouns('My son is at home.', lizTwo, [lizTwo, BIZ])).toBe('My son is at home.');
    // Someone else's son.
    expect(ownKinNouns("The clerk's son waves.", LIZ, PARTY)).toBe("The clerk's son waves.");
  });

  it('the character agent is told the word for each companion', () => {
    const biz: PartyMemberView = { name: 'Biz', highConcept: 'Curious Kid', trouble: 'Wanders off', relation: 'kid', pronouns: 'they/them' };
    const d = kinWordDirective([biz]);
    expect(d).toContain('Biz is your kid — say "my kid", never "my son", "my daughter", "my boy" or "my girl"');
    // A mother is a mother.
    expect(kinWordDirective([{ name: 'Liz', highConcept: 'x', trouble: 'y', relation: 'mother', pronouns: 'she/her' }])).toContain('Liz is your mother ("my mother")');
    expect(kinWordDirective([{ name: 'Liz', highConcept: 'x', trouble: 'y' }])).toBe('');
  });
});

// ─── 2. The seed a spoiler-free host is sent ─────────────────────────────────

describe('2. a spoiler-free host is never sent plot hooks or NPC motives', () => {
  // Live (R6KXDU, the DM host who asked for no spoilers): the frame carried these.
  const SEED: WorldSeed = {
    premise: 'You arrive in Sumperton, a perpetually wet canal city.',
    locations: [{ name: 'The Lamp Hall', description: 'Bulbs on every beam.', terrain: 'interior' }],
    npcs: [
      { name: 'Luma', description: 'Head of the Guild of Lamplighters, kind but overwhelmed.', disposition: 'harried', motivation: "Burying the truth about the recent 'incidents' under a mountain of paperwork." },
      { name: 'The Dark', description: 'Files complaints with a clipboard.', disposition: 'aggrieved', motivation: 'To be let in for tea.' },
    ],
    plotHooks: ['A lamplighter vanished mid-shift last Tuesday.'],
    items: [{ name: 'Brass Snuffer', description: 'Warm, always.' }],
  };

  it('stripped for them; the card\'s fields kept', () => {
    const sent = seedForHost(SEED, true);
    const json = JSON.stringify(sent);
    expect(json).not.toContain('Burying the truth');
    expect(json).not.toContain('incidents');
    expect(json).not.toContain('To be let in for tea');
    expect(json).not.toContain('vanished mid-shift');
    expect(sent.plotHooks).toEqual([]);
    expect(sent.npcs.map(n => n.motivation)).toEqual([null, null]);
    expect(sent.npcs[0]!.description).toBe(SEED.npcs[0]!.description);
    expect(sent.npcs[0]!.disposition).toBe('harried');
    expect(sent.premise).toBe(SEED.premise);
    expect(sent.items).toEqual(SEED.items);
    // A DM host who did not ask gets the whole seed.
    expect(seedForHost(SEED, false)).toBe(SEED);
  });

  it('what they accept comes back whole', () => {
    const back = withHiddenSeedFields(seedForHost(SEED, true), SEED);
    expect(back).toEqual(SEED);
  });
});

// ─── 3. Hand-offs across rulings, and self-pickups ──────────────────────────

// Live, in order (N7RQZ7).
const LIZ_RULING_TUCK = 'As Biz tucks the key into their treasure pocket, they glance up with a grin that is half-mischief and half-promise, the crust of the warm bread already softening in their other hand. The act of sharing the food and the secret seems to settle the air around them; the vanilla-scented hum of the form grows quieter, and Clerk Bixby, sensing the sudden drop in chaos, adjusts his crooked spectacles and mutters, "A moment of order... how refreshing, though I shall still need to file the bread crumbs under \'Edible Debris.\'"';
const BIZ_PRESSES_KEY = "Biz presses the warm Orange Key into Liz's trembling palm, the metal radiating a heat that feels like a held breath, and squeezes until the accountant's knuckles whiten. Liz’s fingers lock around the key instinctively, the scent of burnt sugar rising from the nearby forms to mix with the vanilla hum of the Hall, grounding them both in the strange, sticky air. Mama Figo watches from the corner, her wooden spoon hovering mid-air, and mutters, \"Good, good, keep the shiny thing in the grown-up hands, little one; the dark door bites back when it sees a child grinning.\"";
const POSTMAN_SLIPS = "The Postman’s rasping breath catches, a sound like paper tearing, as he studies the damp smear on Biz’s palm and the crumpled Form 9-B clinging to Liz’s hand like a shed skin. He does not answer her question directly; instead, he tilts his head, his blue coat rippling in the sudden chill of the market, and slips the glowing envelope into Biz’s sticky, ink-stained hand. 'The signature is already written in the ink of your arrival,' he whispers, his voice losing its urgency, 'but the proof must be balanced by the one who refuses to let the ledger close,' his fingertips brushing past Liz’s outstretched hand, leaving a trail of cold ozone that makes her teeth ache.";
const BIZ_OPENS = 'Biz’s fingers fumble with the wax seal, the hot wax cracking under the pressure of their small, impatient nails, while the envelope hums against their chest like a trapped bee. The paper inside is warm and smells of cinnamon and old libraries, and as Biz pulls it free, the glowing script begins to fade into plain ink before their eyes. Behind them, Liz’s hand shoots out, catching the back of Biz’s shirt with a grip that smells of anxiety and stale coffee, her eyes wide and fixed on the vanishing magic.';
const LIZ_TAKES_ENVELOPE = 'Biz’s voice cuts through the humid air, sharp as a snapped twig, and the crowd’s shuffling feet hesitate, the smell of wet ink and burnt sugar thickening around them. Clerk Bixby’s quill stops trembling, his spectacles sliding down his nose as he squints, and he hisses, "The queue shifts because the paperwork is breathing, child, and the stamp is currently being digested by the alphabet." Liz’s hand closes around the crumpled envelope, her knuckles whitening, but the crowd surges forward again, the metallic tang of ozone filling Biz’s nose as the moment slips away.';
const FORM_TORN = 'The paper sticks to Biz’s outstretched fingers, tearing completely as they yank it free, leaving only a damp, useless smear of blue ink on their palm and the ground. Above, the stall’s canvas flap whips down, blocking the light, and Biz can hear the muffled, frantic stamping of dozens of boots closing in from all sides. "Wanders off after anything shiny" — the words could be Biz\'s motto. But fate is generous to those it tests.';
const KEY_SWALLOWED = "A sharp, wet click echoes from the lock, followed by the sudden, unnerving silence of the chewing stopping. The Lost Postman lunges forward, his blue coat snapping like a sail in a gale, and slams his long, ink-stained palm over Biz’s small one on the brass. 'The Alphabet has swallowed the key,' he hisses, his voice trembling with a fear that tastes of ozone and old paper, 'and now it is waiting for you to be hungry.' The air grows heavy and still, the cinnamon scent curdling into the sharp, metallic tang of fear as the door begins to swell outward, inch by agonizing inch.";

const FORM = 'Form 9-B: Return to Source (Crumpled)';
const WORLD_ITEMS = ['The Smudged Stamp', 'The Orange Key'];

describe('3. an item add stands when a recent beat shows the hand-off', () => {
  it('the live Letter of Truth: handed over in Liz\'s ruling, added in Biz\'s', () => {
    // The ruling that added it shows no transfer on its own…
    expect(narratesItemTransfer(BIZ_OPENS, 'The Letter of Truth', 'Biz')).toBe(false);
    // …the one before it did.
    expect(narratesItemTransfer(POSTMAN_SLIPS, 'The Letter of Truth', 'Biz')).toBe(true);
    expect(narratesItemTransferRecently(BIZ_OPENS, [POSTMAN_SLIPS], 'The Letter of Truth', 'Biz')).toBe(true);
    // Not Liz's: the envelope went into Biz's hand.
    expect(narratesItemTransferRecently(BIZ_OPENS, [POSTMAN_SLIPS], 'The Letter of Truth', 'Liz')).toBe(false);
  });

  it('spoken claims are still not transfers, now or a beat ago', () => {
    expect(narratesItemTransferRecently('Liz nods.', ["'This brass key is mine now,' Liz declares, hand on her heart."], 'Brass Key', 'Liz')).toBe(false);
  });

  it('item nouns: the head of the name', () => {
    expect(itemHead('The Letter of Truth')).toBe('letter');
    expect(itemHead(FORM)).toBe('form');
    expect(itemHead('Orange Key')).toBe('key');
    expect(sameItem('The Orange Key', 'orange key')).toBe(true);
  });
});

describe('3b. DM prose moves items: pickups and hand-offs', () => {
  it('"Biz tucks the key into their treasure pocket" gives Biz the Orange Key', () => {
    const events = narratedItemEvents(LIZ_RULING_TUCK, [{ name: 'Liz', inventory: [FORM] }, { name: 'Biz', inventory: [] }], WORLD_ITEMS);
    expect(events).toEqual([{ kind: 'gain', to: 'Biz', item: 'The Orange Key', from: null }]);
  });

  it('Biz presses the key into Liz\'s palm: Liz holds it, Biz no longer does', () => {
    const events = narratedItemEvents(BIZ_PRESSES_KEY, [{ name: 'Liz', inventory: [FORM] }, { name: 'Biz', inventory: ['The Orange Key'] }], WORLD_ITEMS);
    expect(events).toEqual([{ kind: 'gain', to: 'Liz', item: 'The Orange Key', from: 'Biz' }]);
  });

  it('the envelope in Biz\'s hand, then Liz\'s hand closing around it', () => {
    expect(narratedItemEvents(LIZ_TAKES_ENVELOPE, [{ name: 'Liz', inventory: [FORM] }, { name: 'Biz', inventory: ['The Letter of Truth'] }]))
      .toEqual([{ kind: 'gain', to: 'Liz', item: 'The Letter of Truth', from: 'Biz' }]);
  });

  it('never from a claim, a refusal, a pronoun, or an item two things could be', () => {
    const party = [{ name: 'Liz', inventory: [] as string[] }, { name: 'Biz', inventory: [] as string[] }];
    expect(narratedItemEvents("'This orange key is mine now,' Liz declares.", party, WORLD_ITEMS)).toEqual([]);
    expect(narratedItemEvents('Liz reaches for the Orange Key, but Mama Figo refuses to give it up.', party, WORLD_ITEMS)).toEqual([]);
    expect(narratedItemEvents('She tucks the key into her pocket.', party, WORLD_ITEMS)).toEqual([]);
    expect(narratedItemEvents('Biz pockets the key.', party, ['The Orange Key', 'The Iron Key'])).toEqual([]);
    expect(narratedItemEvents('Biz stares at the Orange Key on the counter.', party, WORLD_ITEMS)).toEqual([]);
    expect(narratedItemEvents('Biz catches sight of the key on the counter.', party, WORLD_ITEMS)).toEqual([]);
    expect(narratedItemEvents('Liz takes a step toward the Orange Key.', party, WORLD_ITEMS)).toEqual([]);
  });
});

// ─── 4. Destroyed, eaten, lost, given away ──────────────────────────────────

describe('4. items the DM destroys leave the inventory', () => {
  it('Form 9-B torn to a useless smear', () => {
    expect(narratedItemEvents(FORM_TORN, [{ name: 'Liz', inventory: [FORM, 'Orange Key'] }, { name: 'Biz', inventory: [] }]))
      .toEqual([{ kind: 'loss', from: 'Liz', item: FORM }]);
  });

  it('"The Alphabet has swallowed the key" — the key, not the "old paper" form', () => {
    expect(narratedItemEvents(KEY_SWALLOWED, [{ name: 'Liz', inventory: [FORM, 'Orange Key'] }, { name: 'Biz', inventory: ['Golden Fruit'] }]))
      .toEqual([{ kind: 'loss', from: 'Liz', item: 'Orange Key' }]);
  });

  it('given away to someone outside the party', () => {
    expect(narratedItemEvents("Biz slips the key into the Postman's coat pocket.", [{ name: 'Liz', inventory: [] }, { name: 'Biz', inventory: ['The Orange Key'] }]))
      .toEqual([{ kind: 'loss', from: 'Biz', item: 'The Orange Key' }]);
  });

  it('never a threat, a near-miss, or something in progress', () => {
    const party = [{ name: 'Liz', inventory: [FORM, 'Orange Key'] }, { name: 'Biz', inventory: [] as string[] }];
    for (const t of [
      "'Hand it over, or the Alphabet will swallow the key,' Bixby warns.",
      'The Alphabet nearly swallows the key before Liz snatches it back.',
      'The stamp is currently being digested by the alphabet.',
      'The Golden Fruit sticks to the pocket, the paper tearing audibly against the fabric.',
      'Liz is about to tear the form in half.',
    ]) expect(narratedItemEvents(t, party)).toEqual([]);
  });
});

// ─── 5. Gentle peril ─────────────────────────────────────────────────────────

describe('5. gentle peril', () => {
  const HOST_TONE = 'Tone: warm, funny, kid-friendly — gentle peril only, nothing scary or gory, the kid is present at the table. You decide the rest. Please draft the world.';

  it('the host\'s ask is recognised', () => {
    expect(wantsGentlePeril([HOST_TONE])).toBe(true);
    expect(wantsGentlePeril(['Keep it cozy.'])).toBe(true);
    expect(wantsGentlePeril(['Satirical and absurd, with a little Brazil dread.', null])).toBe(false);
  });

  it('the family-table rule names the gentle-peril register', () => {
    const party = [{ name: 'Liz', highConcept: 'x', relationships: [{ to: 'Biz', relation: 'kid' }] }, { name: 'Biz', highConcept: 'y', age: 10 }];
    const rule = childToneRule(party);
    expect(rule).toMatch(/GENTLE PERIL register/);
    expect(rule).toMatch(/mishaps, silliness/);
    expect(rule).toMatch(/bureaucratic obstacles/);
    expect(rule).toMatch(/Never describe bodily harm or pain/);
    expect(rule).toMatch(/no weapons or weapon sounds/);
    expect(rule).toMatch(/hunted, stalked, preyed on or eaten/);
    expect(childToneRule(party, { gentlePeril: true })).toMatch(/The host asked for gentle peril too/);
    // No child, but the host asked: the register still applies.
    const adults = [{ name: 'Liz', highConcept: 'x' }];
    expect(childToneRule(adults)).toBe('');
    expect(childToneRule(adults, { gentlePeril: true })).toMatch(/^GENTLE PERIL: the host asked for gentle peril/);
    const { systemPrompt } = assembleSystemPrompt({ preset: 'chronicler', dmCustomPrompt: null, houseRules: null, dmInstructions: null, influences: [], party: adults, gentlePeril: true });
    expect(systemPrompt).toMatch(/GENTLE PERIL register/);
  });

  it('the live phrases are softened', () => {
    expect(softenForChildren('The Alphabet’s teeth grind audibly beneath her fingers, a sound like a jaw cracking open, and the vibration rattles her teeth in her skull.'))
      .toBe('The Alphabet’s teeth grind audibly beneath her fingers, a sound like a drawer creaking open, and the vibration rattles her teeth.');
    expect(softenForChildren('the cold seeping through their clothes until their bones feel like frozen sticks. The door holds, but the effort tears a sharp pain through their shoulder'))
      .toBe('the cold seeping through their clothes until their toes feel like ice cubes. The door holds, but the effort sends a sudden jolt through their shoulder');
    expect(softenForChildren('leaving the door unsealed and the crowd turning with hunting intent.')).toBe('leaving the door unsealed and the crowd turning with nosy curiosity.');
    expect(softenForChildren('A heavy, brass-plated door slams shut at the far end of the aisle, the sound echoing like a gunshot that silences the shuffling crowd'))
      .toBe('A heavy, brass-plated door slams shut at the far end of the aisle, the sound echoing like a slammed book that silences the shuffling crowd');
    expect(softenForChildren('Bixby, you made this mess, so you explain why the queue is shifting and where the stamp is before the crowd eats us.'))
      .toBe('Bixby, you made this mess, so you explain why the queue is shifting and where the stamp is before the crowd sweeps us away.');
    expect(softenForChildren('a deadline that feels less like a date and more like a tangle of rope tightening around their ankles.'))
      .toBe('a deadline that feels less like a date and more like a tangle of rope tugging at their shoelaces.');
    // Everyday words stay.
    expect(softenForChildren('Biz eats the warm bread, and the realization settles into her bones.')).toBe('Biz eats the warm bread, and the realization settles into her bones.');
    expect(softenForChildren('You can eat them, Bixby! Let her eat her sandwich.')).toBe('You can eat them, Bixby! Let her eat her sandwich.');
  });
});

// ─── 6. Logs show the change ──────────────────────────────────────────────────

describe('6. guard logs show what changed', () => {
  it('the changed span, not the unchanged first 80 characters', () => {
    const before = 'A hidden clause glares up at her in ink that smells faintly of burnt sugar: the deadline feels like a noose.';
    const after = softenForChildren(before);
    const span = changedSpan(before, after);
    expect(span).toContain('noose');
    expect(span).toContain('tangle of rope');
    expect(span).not.toContain('A hidden clause');
  });
});
