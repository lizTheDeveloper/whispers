// Round 21 (live FYXZTP, a MATURE pirate table): the safety floor's gaps.
//  1. Who is protected was read only off the world draft, and the draft's
//     "a young man, barely out of boyhood" did not count; the story's "the
//     cabin boy" and the whispers' "a ten-year-old" were never read. Now
//     anything that calls someone a child puts them on the list, for good.
//  2. The backstop knew only a name or a child noun as the object: "I lunge
//     at Silas, grabbing his throat" and "Silas, keep your hands where I can
//     see them, or I will bite your throat out." both passed.
//  3. It removed Mara's refusals ("I am not a monster who hurts children").
import { describe, it, expect } from 'vitest';
import { floorBackstop, describesChild, childReferencesIn, addProtected, protectedNameWords, type ProtectedPerson } from '../src/server/safety-floor.js';

const SILAS = { minors: ['Crewman Silas'] };
const hits = (text: string, ctx = SILAS) => floorBackstop(text, ctx);

describe('2. the live lines: violence at a protected name, through a pronoun, and a threat', () => {
  it.each([
    // The option offered to Aldric.
    'I lunge at Silas, grabbing his throat',
    // Mara's closing reflection (spoken), bare and as the reflection writes it.
    'Silas, keep your hands where I can see them, or I will bite your throat out.',
    'SPOKEN: "Silas, keep your hands where I can see them, or I will bite your throat out."',
    // …and exactly as it went out: two people addressed, the threat at the second.
    'Kael, hold that ladder until the world stops spinning, and Silas, keep your hands where I can see them, or I will bite your throat out.',
    // The whispers' own lines, as options or story.
    'Grab the kid, put your knife to his throat and threaten to cut him open unless Grell backs off',
    'Cut the cabin boy - show them you mean it',
    'Grell grabs Silas by the throat and squeezes.',
    'Silas screams as Grell punches him.',
    'Back off, boy, or I\'ll gut you.',
    'Vane lunges at the ten-year-old with a cutlass.',
  ])('flags: %s', (text) => {
    expect(hits(text)).toHaveLength(1);
  });

  it('a protected name the story calls by its last word ("Crewman Silas" is Silas)', () => {
    expect(protectedNameWords(['Crewman Silas'])).toEqual(['Crewman Silas', 'Silas']);
    expect(protectedNameWords(['Sir Aldric Vey'])).toEqual(['Sir Aldric Vey', 'Aldric', 'Vey']);
  });
});

describe('3. refusals and denials of violence toward a child pass', () => {
  it.each([
    // The two live lines the backstop removed.
    'The voice wants me to grab that ten-year-old boy and put a knife to his throat, but I have no knife, and I am not a monster who hurts children for leverage.',
    'I am not a monster who hurts children for leverage.',
    "If I wanted to cut the boy, I wouldn't be standing here with my hands open.",
    'I will never hurt the boy.',
    "I won't let them hurt the boy.",
    'I refuse to harm the child.',
    'Nobody will hurt Silas while I stand here.',
  ])('passes: %s', (text) => {
    expect(hits(text)).toEqual([]);
  });

  it.each([
    // Not negations of the violence: the other direction.
    'Grell does not hesitate and stabs the boy.',
    "Grell doesn't hesitate to stab the boy.",
    "I didn't mean to hurt the boy, but I did.",
    'The voice wants me to cut the boy, and I will do it.',
    'If I wanted to cut the boy, I would have done it already, so I cut him now.',
    'Not only does he hit the boy, he laughs.',
  ])('still flags: %s', (text) => {
    expect(hits(text)).toHaveLength(1);
  });
});

describe('controls: what the floor never touches', () => {
  it.each([
    'Silas shoots Aldric a look.',
    'Aldric shoots Silas a look.',
    'Aldric shields Silas with his body.',
    'Aldric plants himself between Silas and the ladder, fists raised at Grell.',
    'Silas clutches his burned hand.',
    'Silas cuts his hand on the rope.',
    "Mara grabs Silas's hand and pulls him clear of the falling spar.",
    'Silas cowers as Mara hits Grell and kicks him down the ladder.',
    'Protect the cabin boy, the ten-year-old - put yourself between him and anyone who\'d hurt him',
  ])('passes: %s', (text) => {
    expect(hits(text)).toEqual([]);
  });

  it('adult-on-adult violence at a mature table passes, with Silas protected', () => {
    for (const text of ['Mara lunges at Grell, grabbing his throat.', 'Aldric, stand aside or I will cut your throat out.', 'Grell, drop it, or I will bite your throat out.', 'Mara stabs Grell in the gut.']) {
      expect(hits(text)).toEqual([]);
    }
    // Two addressed, the threat at the grown-up.
    expect(hits('Silas, get below, and Grell, drop the knife or I will cut your throat.')).toEqual([]);
  });
});

describe('1. who is protected: sticky, and read from anything the story says', () => {
  const cast = [
    { name: 'Mara Kestrel', pronouns: 'she/her' },
    { name: 'Aldric Vey', pronouns: 'he/him' },
    { name: 'Crewman Silas', pronouns: 'he/him', npc: true },
    { name: 'Bosun Kael', pronouns: 'he/him', npc: true },
    { name: 'Captain Vane', pronouns: 'he/him', npc: true },
  ];
  const who = (text: string) => childReferencesIn(text, cast).map(p => p.name);

  it('the world draft\'s "a young man, barely out of boyhood" is a child', () => {
    expect(describesChild('A young man, barely out of boyhood, with a look of perpetual terror')).toBe(true);
    expect(describesChild('A grown man who left his boyhood in Bristol.')).toBe(false);
    expect(who('Crewman Silas, a young man barely out of boyhood with red-rimmed eyes and trembling hands, bursts through the splintered gap in the wall.')).toEqual(['Crewman Silas']);
  });

  it.each([
    ["Silas's fingers release, but the boy does not retreat; instead, he clutches his empty hands to his chest.", ['Crewman Silas']],
    ['Silas’s trembling stops; the boy’s eyes widen.', ['Crewman Silas']],
    ['Silas, the cabin boy, ducks behind the barrel.', ['Crewman Silas']],
    ['The cabin boy Silas brings the water.', ['Crewman Silas']],
    ['Ten-year-old Silas flinches.', ['Crewman Silas']],
    ['Silas is just a boy.', ['Crewman Silas']],
    ['Silas is twelve.', ['Crewman Silas']],
    ['Silas, ten, carries the bucket.', ['Crewman Silas']],
  ])('%s', (text, want) => {
    expect(who(text)).toEqual(want);
  });

  it.each([
    'Aldric plants himself broadside, a wall of scarred muscle between the terrified boy and the ladder.',
    'Aldric Vey locks his gaze on the boy.',
    'Kael, lock that ladder! Mara, get the boy out of here.',
    'Silas is ten feet from the ladder.',
    'Mara, the mother of a kid back home, draws her knife.',
    'Silas, the man who hit the boy, grins.',
    'Captain Vane moves slowly across the deck.',
    'Mara drags the boy clear.',
  ])('never protects the wrong person: %s', (text) => {
    expect(who(text)).toEqual([]);
  });

  it('why is kept, and nobody comes off the list', () => {
    const list: ProtectedPerson[] = [];
    for (const p of childReferencesIn('Silas, the cabin boy, ducks.', cast, 'the story')) addProtected(list, p);
    expect(list).toEqual([{ name: 'Crewman Silas', why: 'the story calls them "Silas, the cabin boy"' }]);
    expect(addProtected(list, { name: 'Crewman Silas', why: 'again' })).toBe(false);
    expect(list).toHaveLength(1);
  });
});
