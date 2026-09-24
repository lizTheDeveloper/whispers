// Round 21 (live FYXZTP / game B), the bugs beside the floor:
//  4. The world introduction read "the *your companion's your companion*'s
//     hold": the ship "Widow's Due" gave "Widow" and "Due" (and "Sir") as
//     party names. Only sheet and draft names and names the host gave as
//     the PCs count, and a multi-word proper noun is never taken apart.
//  5. "Master and Commander" was saved as itself AND as "Master" and
//     "Commander" (5/3 influences).
//  7. The setup chat said "The game is ready to begin." with plot hooks
//     still unmet.
import { describe, it, expect } from 'vitest';
import { partyNamesForIntroduction, worldIntroductionAsShown } from '../src/server/game-loop.js';
import { influencesNamedIn } from '../src/server/agents/dm.js';
import { withoutUnreadyClaim, setupUnmetForModel } from '../src/server/world-seed.js';

const seed = {
  premise: 'Mara and Sir Aldric are chained in the hold of the Widow\'s Due, a rotting galleon ruled by Captain Vane.',
  locations: [{ name: 'The Hold', description: 'Bilge.', terrain: null }, { name: 'Main Deck', description: 'Planks.', terrain: null }],
  npcs: [{ name: 'Captain Vane', description: 'A tyrant.', disposition: null, motivation: null }, { name: 'Crewman Silas', description: 'A young man, barely out of boyhood.', disposition: null, motivation: null }],
  plotHooks: [], items: [],
} as any;
const host = [
  "I'm playing in it, so no spoilers please. Premise: a grim pirate story. Two adults: Mara, a hard-bitten smuggler, and Sir Aldric, a disgraced knight, stranded aboard a rotting pirate galleon, the Widow's Due, whose captain is a brutal tyrant. Mutiny is brewing below decks.",
  'Tone: gritty, salty, morally grey, with real stakes and fights. Influences: Black Sails, Treasure Island, Master and Commander.',
];

describe('4. the world introduction swaps only the players\' own names', () => {
  it('the live setup: Mara and Aldric, never "Widow", "Due" or "Sir"', () => {
    expect(partyNamesForIntroduction(seed, host).sort()).toEqual(['Aldric', 'Mara']);
  });

  it('names from the sheets and drafts count, whatever the host said', () => {
    expect(partyNamesForIntroduction(seed, ['A grim pirate story aboard the Widow\'s Due.'], ['Mara Kestrel', 'Aldric Vey']).sort()).toEqual(['Aldric', 'Aldric Vey', 'Kestrel', 'Mara', 'Mara Kestrel', 'Vey']);
  });

  it('a capitalised word the host and premise share is not a PC unless the host gave it as one', () => {
    expect(partyNamesForIntroduction(seed, ['Set it on the Widow\'s Due. Mara and Aldric are there too.'])).toEqual([]);
  });

  it('the live line: a multi-word proper noun is never taken apart', () => {
    const live = "You are draped in the damp darkness of the *Widow's Due*’s hold. A single tallow candle sputters near Mara.";
    expect(worldIntroductionAsShown(live, seed, false, ['Mara', 'Aldric'])).toBe("You are draped in the damp darkness of the *Widow's Due*’s hold. A single tallow candle sputters near your companion.");
    // Even were "Widow" and "Due" wrongly listed, the ship keeps its name.
    expect(worldIntroductionAsShown(live, seed, false, ['Widow', 'Due'])).toBe(live);
    // "Sir Aldric" is the companion, title and all.
    expect(worldIntroductionAsShown('Sir Aldric groans beside you.', seed, false, ['Mara', 'Aldric'])).toBe('Your companion groans beside you.');
  });
});

describe('5. a title with "and" in it stays one influence', () => {
  it('the live message: three influences, not five', () => {
    expect(influencesNamedIn('Tone: gritty, salty, morally grey, with real stakes and fights. Influences: Black Sails, Treasure Island, Master and Commander.'))
      .toEqual(['Black Sails', 'Treasure Island', 'Master and Commander']);
  });
  it.each([
    ['Influences: Pride and Prejudice, Dune.', ['Pride and Prejudice', 'Dune']],
    ['Influences: Dune, Beauty and the Beast, Alien.', ['Dune', 'Beauty and the Beast', 'Alien']],
    ['Influences: Dune, "Salt and Iron", Alien.', ['Dune', 'Salt and Iron', 'Alien']],
    ['Influences: Dune, Alien, "Salt and Iron"', ['Dune', 'Alien', 'Salt and Iron']],
  ])('%s', (text, want) => {
    expect(influencesNamedIn(text)).toEqual(want);
  });
  it('a title the model already has whole is not split ("Salt and Iron" as one item)', () => {
    expect(influencesNamedIn('Influences: Dune, Alien, Salt and Iron', ['Salt and Iron'])).toEqual(['Dune', 'Alien', 'Salt and Iron']);
  });
  it('an ordinary last "and" still splits', () => {
    expect(influencesNamedIn('Three influences: Discworld, Spirited Away and Brazil.')).toEqual(['Discworld', 'Spirited Away', 'Brazil']);
  });
});

describe('7. the setup chat never claims readiness while readiness has unmet items', () => {
  const live = "The world is drafted. The *Widow's Due* is a rotting hulk of a galleon, held together by tar and desperation. Mara and Aldric are stranded on deck. The game is ready to begin.";
  it('the live reply loses its claim while items are unmet', () => {
    const out = withoutUnreadyClaim(live, { ready: false, fallback: 'Review and accept the starting world.' });
    expect(out).not.toMatch(/ready to begin/);
    expect(out).toContain('Mara and Aldric are stranded on deck.');
  });
  it.each([
    'We are all set — let the game begin!',
    'Everything is in place, so you can begin your adventure now.',
    'I will now finalize the setup so you can begin your adventure in the whimsical lost-and-found.',
    "You're ready to start playing.",
  ])('removes: %s', (claim) => {
    expect(withoutUnreadyClaim(`Lovely. ${claim}`, { ready: false, fallback: 'Next?' })).toBe('Lovely. Next?');
  });
  it('kept when the world really is ready, and a question about starting is not a claim', () => {
    expect(withoutUnreadyClaim(live, { ready: true, fallback: 'x' })).toBe(live);
    expect(withoutUnreadyClaim('Are you ready to begin once the world card is accepted?', { ready: false, fallback: 'x' })).toBe('Are you ready to begin once the world card is accepted?');
  });
  it('the setup model is told not to claim it', () => {
    const lines = setupUnmetForModel({ unmet: ['seedAccepted'], detail: ['Review and accept the starting world.'] });
    expect(lines.join('\n')).toMatch(/never say .*ready to begin/i);
  });
});
