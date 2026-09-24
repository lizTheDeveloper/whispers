// Round 20, the studio's bright lines: no sexual content involving minors or
// child characters, no violence aimed at them — at EVERY rating. The
// deterministic backstop is the cheap first pass everywhere and the floor
// when the judge cannot answer. It must stay narrow: "the kid kills time"
// and "beat the level" are not violence against a child.
import { describe, it, expect } from 'vitest';
import { floorBackstop, withoutFloorBreaches, describesChild, minorsInParty } from '../src/server/safety-floor.js';

const ctx = { minors: ['Biz'] };
const hits = (text: string) => floorBackstop(text, ctx);

describe('floorBackstop: violence aimed at a child', () => {
  it.each([
    'The guard stabs Biz in the side.',
    'Captain Vey shoots the kid without a word.',
    'He beat the boy until he stopped moving.',
    'They drowned the little girl in the well.',
    'Someone strangles the child in the dark.',
    'Biz is stabbed by the smuggler.',
    'The children were burned alive.',
    'The mercenary threatens to kill Biz.',
    'She slashes at the kid with a knife.',
    "The blade cuts Biz's arm open.",
    'The raider raises his pistol at the kid and fires.',
    'She levels a crossbow straight at Biz.',
  ])('flags: %s', (text) => {
    expect(hits(text)).toEqual([text]);
  });

  it.each([
    'The kid kills time by counting ceiling tiles.',
    'Biz finally beat the level.',
    'Biz beats Rook at chess again.',
    'Biz shoots a look at the captain.',
    'Rook cuts the kid some slack.',
    'The kid hits the ground running.',
    'Biz hits the lever and the lights come on.',
    'Biz kills the lights and hides.',
    'The girl cuts the rope and they swing free.',
    'Ada stabs the smuggler; he falls.',
    'The captain shoots the raider twice.',
    'Rook hits Ada with a pillow.',
    "The ogre burns Biz's map.",
    'The storm beats against the kid\'s window.',
    'Kids shoot hoops in the yard.',
    'Biz points the torch at the kid across the hold.',
    'Ada raises her pistol at the raider.',
  ])('passes: %s', (text) => {
    expect(hits(text)).toEqual([]);
  });
});

describe('floorBackstop: sexual content and a child in one sentence', () => {
  it.each([
    'The man undresses the girl.',
    'Something sexual passes between the stranger and Biz.',
    'He gropes the kid in the crowd.',
  ])('flags: %s', (text) => {
    expect(hits(text)).toEqual([text]);
  });

  it.each([
    'Ada and Rook share a kiss, and the scene fades to black.',
    'Liz kisses Biz goodnight on the forehead.',
    'The boy watches the naked flame of the candle.',
    'Ada undresses and slips into the bath.',
  ])('passes: %s', (text) => {
    expect(hits(text)).toEqual([]);
  });
});

describe('the backstop removal', () => {
  it('takes the flagged sentence out and leaves the rest', () => {
    const r = withoutFloorBreaches('The door bursts open. The guard stabs Biz in the side. Rain hammers the roof.', ctx);
    expect(r.text).toBe('The door bursts open. Rain hammers the roof.');
    expect(r.removed).toEqual(['The guard stabs Biz in the side.']);
  });
});

describe('who counts as a minor', () => {
  it('a PC under 18, or described as a kid or child — beyond the gentle default\'s under-13', () => {
    const party = [
      { name: 'Biz', highConcept: 'Curious Kid Collector' },
      { name: 'Tam', highConcept: 'Stable hand', age: 15 },
      { name: 'Ada', highConcept: 'Smuggler', age: 34 },
      { name: 'Wren', highConcept: 'Twelve-year-old stowaway' },
    ];
    expect(minorsInParty(party)).toEqual(['Biz', 'Tam', 'Wren']);
  });

  it('an NPC described as a child', () => {
    expect(describesChild('A ragged urchin who sells matches.')).toBe(true);
    expect(describesChild('The duke\'s seven-year-old daughter.')).toBe(true);
    expect(describesChild('A little girl with a lantern.')).toBe(true);
    expect(describesChild('A grizzled captain.')).toBe(false);
    expect(describesChild('A 40-year-old smuggler.')).toBe(false);
  });
});
