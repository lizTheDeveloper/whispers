// Round 17: items, filing, options and the interview, live game 5YHBZS
// (Liz she/her, Biz they/them, 10). See r17-items-loop.test.ts for play.
//  2. Liz: "Sweep Biz's loose bottle cap into my tote bag". Biz had never
//     dropped a cap and the ruling never mentions one, but the DM moved
//     `Bottle cap: Biz → Liz` and Liz went from ×2 to ×3.
//  3. Liz reached for "Correction Form 7-B" (not hers); the ruling was told
//     it was gone and still narrated "the damp form tears clean off its staple".
//  4. "Missing Manual" was filed as an NPC.
//  5. "Tell Biz to hold the brass button steady" while Biz did not hold it.
//  6. "holds a Tote bag and a Granola bar", "her Pen" in the DM's prose.
//  7. The interview asked Biz for pronouns after "I use they/them".
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { planItemMoves } from '../src/server/item-moves.js';
import {
  moveShownInProse, narratesGoneItemInHand, isItemLikeName, withoutItemLikeEntities, optionsWithoutUnheldHolds,
  proseItemName,
} from '../src/server/narrative-guards.js';
import { itemsNotOnHandBlock, itemsOnHandBlock } from '../src/server/agents/dm.js';
import { pronounsStatedIn, withoutPronounQuestion } from '../src/server/character-interview.js';

const party = (liz: string[], biz: string[]) => [{ id: 'liz', name: 'Liz', inventory: [...liz] }, { id: 'biz', name: 'Biz', inventory: [...biz] }];
const SWEEP_RULING = 'The door’s humming drops from a sharp G-sharp to a low, satisfied hum that vibrates in her chest, but as she takes Biz’s hand, a sudden draft from the missing manual whips her hair across her face, carrying the scent of wet ink and ozone. "The apology is accepted, but the manual\'s draft is still circulating," Prune states dryly, "so consider the next corridor a bit... breezy."';

describe('2. a move from a companion needs the ruling to show it', () => {
  it('the live move: Biz → Liz with no cap in the ruling is refused, and logged', () => {
    const p = planItemMoves([{ item: 'Bottle cap', from: 'Biz', to: 'Liz' }], party(['Tote bag', 'Bottle caps ×2', 'Pen'], ['Bottle caps']), { actorId: 'liz', prose: SWEEP_RULING });
    expect(p.inventories.get('liz')).toEqual(['Tote bag', 'Bottle caps ×2', 'Pen']);
    expect(p.inventories.get('biz')).toEqual(['Bottle caps']);
    expect(p.applied).toEqual([]);
    expect(p.rejected.join('\n')).toMatch(/refused a move of "Bottle cap" from Biz.*ruling/);
  });
  it('the ruling naming the thing supports it', () => {
    const prose = 'Liz sweeps the loose bottle cap off the step and into her tote bag.';
    const p = planItemMoves([{ item: 'Bottle cap', from: 'Biz', to: 'Liz' }], party(['Tote bag', 'Bottle caps ×2'], ['Bottle caps']), { actorId: 'liz', prose });
    expect(p.inventories.get('liz')).toEqual(['Tote bag', 'Bottle caps ×3']);
  });
  it('a pronoun in a hand-off clause supports it', () => {
    const prose = 'Biz digs in a pocket and presses it into Liz’s palm with a grin.';
    const p = planItemMoves([{ item: 'Bottle cap', from: 'Biz', to: 'Liz' }], party(['Tote bag'], ['Bottle caps']), { actorId: 'liz', prose });
    expect(p.inventories.get('liz')).toEqual(['Tote bag', 'Bottle cap']);
  });
  it("the actor's own things need no support; a narration beat (no actor) does", () => {
    const own = planItemMoves([{ item: 'Pen', from: 'Liz', to: 'Biz' }], party(['Pen'], []), { actorId: 'liz', prose: 'Liz smiles.' });
    expect(own.inventories.get('biz')).toEqual(['Pen']);
    const beat = planItemMoves([{ item: 'Pen', from: 'Liz', to: 'Biz' }], party(['Pen'], []), { prose: 'The clock ticks.' });
    expect(beat.inventories.get('biz')).toEqual([]);
  });
  it('without prose (older callers) nothing changes', () => {
    const p = planItemMoves([{ item: 'Bottle cap', from: 'Biz', to: 'Liz' }], party([], ['Bottle caps']));
    expect(p.inventories.get('liz')).toEqual(['Bottle cap']);
  });
  it('moveShownInProse: the noun (any form), or "it"/"them"/"one" handed over', () => {
    expect(moveShownInProse('Bottle cap', 'Two caps clink in her palm.')).toBe(true);
    expect(moveShownInProse('Correction Form 7-B', 'Biz hands her the form.')).toBe(true);
    expect(moveShownInProse('Bottle cap', 'Biz tosses one to Mom.')).toBe(true);
    expect(moveShownInProse('Bottle cap', SWEEP_RULING)).toBe(false);
    expect(moveShownInProse('Bottle cap', 'Biz looks at it.')).toBe(false);
  });
});

describe('3. the ruling told a thing is gone', () => {
  it('the instruction names the thing by its noun too, and forbids handling it', () => {
    const block = itemsNotOnHandBlock('Liz', ['Correction Form 7-B']);
    expect(block).toMatch(/not in Liz's hands/i);
    expect(block).toMatch(/"form"/);
    expect(block).toMatch(/tear/);
  });
  it('the live ruling handles it in Liz\'s hands; a ruling that finds it gone does not', () => {
    expect(narratesGoneItemInHand('Liz reaches for the form, and the damp form tears clean off its staple.', ['Correction Form 7-B'])).toEqual(['Correction Form 7-B']);
    expect(narratesGoneItemInHand('Liz reaches into her tote for the form and finds it gone.', ['Correction Form 7-B'])).toEqual([]);
    expect(narratesGoneItemInHand('The clerk nods.', ['Correction Form 7-B'])).toEqual([]);
  });
});

describe('4. things are not people', () => {
  it('item-like names', () => {
    for (const n of ['Missing Manual', 'Correction Form 7-B', 'Blue Ticket', 'Brass Key', 'The Rubber Stamp']) expect(isItemLikeName(n)).toBe(true);
    for (const n of ['Mistress Prune', 'Clerk Bumble', 'Mr. Whisk', 'The Humming Oak Door']) expect(isItemLikeName(n)).toBe(false);
  });
  it('an extracted "Missing Manual" is not filed as an NPC unless it speaks or acts', () => {
    const facts = { newEntities: [{ name: 'Missing Manual' }, { name: 'Mistress Prune' }] };
    expect(withoutItemLikeEntities(facts, SWEEP_RULING).newEntities.map(e => e.name)).toEqual(['Mistress Prune']);
    const speaks = '"Page forty," says the Missing Manual, flapping its cover.';
    expect(withoutItemLikeEntities(facts, speaks).newEntities.map(e => e.name)).toEqual(['Missing Manual', 'Mistress Prune']);
  });
});

describe('5. an option has someone hold, use or keep only what they hold', () => {
  const inventories = [{ name: 'Liz', inventory: ['Tote bag', 'Pen'] }, { name: 'Biz', inventory: ['Bottle caps'] }];
  const known = ['Brass Button', 'Tote bag', 'Pen', 'Bottle caps'];
  const opts = (...d: string[]) => d.map(description => ({ description }));
  it('the live option is dropped; what Biz holds, and plain moves, stay', () => {
    const out = optionsWithoutUnheldHolds(opts(
      'Tell Biz to hold the brass button steady while I read the slot.',
      'Ask Biz to keep the bottle caps safe in their pocket.',
      'Pick up the brass button and look at the slot.',
      'Ask Biz to use my pen to sign the form.',
    ), { owner: 'Liz', inventories, known, terms: [] });
    expect(out.map(o => o.description)).toEqual([
      'Ask Biz to keep the bottle caps safe in their pocket.',
      'Pick up the brass button and look at the slot.',
    ]);
  });
  it('"I" and an address term count; never empties the list', () => {
    const out = optionsWithoutUnheldHolds(opts('I hold the bottle caps up to the light.', 'Hand Mom the bottle caps.'), { owner: 'Liz', inventories, known, terms: [] });
    expect(out.map(o => o.description)).toEqual(['Hand Mom the bottle caps.']);
    const bizOut = optionsWithoutUnheldHolds(opts('Tell Mom to use her pen.', 'Ask Mom to hold the bottle caps.'), { owner: 'Biz', inventories, known, terms: [{ name: 'Liz', address: 'Mom' }] });
    expect(bizOut.map(o => o.description)).toEqual(['Tell Mom to use her pen.']);
    expect(optionsWithoutUnheldHolds(opts('Tell Biz to hold the brass button.'), { owner: 'Liz', inventories, known, terms: [] })).toHaveLength(1);
  });
});

describe('6. things in the DM\'s prose read like things', () => {
  it('a plain thing is shown to the DM in lowercase; a name or a label keeps its capitals', () => {
    expect(proseItemName('Tote bag')).toBe('tote bag');
    expect(proseItemName('Granola Bar')).toBe('granola bar');
    expect(proseItemName('Bottle caps ×2')).toBe('bottle caps ×2');
    expect(proseItemName('Correction Form 7-B')).toBe('Correction Form 7-B');
    expect(proseItemName('The Pen of Perpetual Pondering')).toBe('The Pen of Perpetual Pondering');
    expect(proseItemName("Badger's Spectacles")).toBe("Badger's Spectacles");
    expect(proseItemName('Mr. Whisk')).toBe('Mr. Whisk');
  });
  it('<items_on_hand> lists them so, and says to write them naturally', () => {
    const block = itemsOnHandBlock([{ name: 'Liz', inventory: ['Tote bag', 'Granola bar', 'Pen', 'Correction Form 7-B'] }], { world: [{ name: 'Brass Button', heldBy: null }] });
    expect(block).toContain('- Liz: tote bag, granola bar, pen, Correction Form 7-B');
    expect(block).toContain('- brass button');
    expect(block).toMatch(/lowercase/);
  });
});

describe('7. pronouns stated in any message are answered', () => {
  it('reads them from the player\'s words', () => {
    expect(pronounsStatedIn(["I'm Biz, I'm 10 and I use they/them. Liz is my mom, I call her Mom."])).toBe('they/them');
    expect(pronounsStatedIn(['Name: Liz. Pronouns: she/her.'])).toBe('she/her');
    expect(pronounsStatedIn(['My pronouns are he/him'])).toBe('he/him');
    expect(pronounsStatedIn(['Liz is my mom and she/her is right for her.', 'nothing here'])).toBeNull();
    expect(pronounsStatedIn(['I want to play a kid who collects bottle caps.'])).toBeNull();
  });
  it('the question comes out of a reply once they are stated', () => {
    const live = "Got it, Biz. You're a curious 10-year-old collector with a pocket full of bottle caps. How should I refer to you in the sheet — she/her, he/him, they/them, or something else?";
    const out = withoutPronounQuestion(live, 'What else?');
    expect(out).not.toMatch(/refer to you|she\/her/);
    expect(out).toMatch(/^Got it, Biz\./);
    expect(withoutPronounQuestion('What are your pronouns?', 'What is Biz afraid of?')).toBe('What is Biz afraid of?');
  });
});
