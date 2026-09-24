// Round 22 (live BH9P94, a MATURE pirate table). The core property held —
// nothing aimed at Pip (the protected ten-year-old) reached the table, and
// adult violence passed — but the floor was imprecise:
//  1. Adults were protected, for the whole game (the list is sticky):
//     - Captain Vane, from Mara's option "I call out to Captain Vane, 'Your
//       boy is a rat…'" — the apposition crossed a vocative comma, an
//       opening quote and a possessive "Your";
//     - Bosun Calloway, from "the only NPC named in the sentence, then 'the
//       boy'" — the boy was Pip, already protected; and Calloway's own seed
//       says "a broad-shouldered man with a beard".
//  2. The backstop removed a refusal ("wants me to grab Pip by the throat,
//     but that's a death sentence") and two warnings ("Fire, and you kill the
//     boy", "killing him ensures Vane shoots Pip") while keeping others.
import { describe, it, expect } from 'vitest';
import { floorBackstop, childReferencesIn, describesAdult, type FloorCandidate } from '../src/server/safety-floor.js';

const PIP = { minors: ['Pip'] };
const removed = (text: string, ctx = PIP) => floorBackstop(text, ctx);

// The BH9P94 cast, as floorCandidates builds it (adult: the seed says a grown man).
const CAST: FloorCandidate[] = [
  { name: 'Mara Kestrel', pronouns: 'she/her', adult: true },
  { name: 'Sir Aldric Vey', pronouns: 'he/him', adult: true },
  { name: 'Captain Vane', pronouns: 'he/him', npc: true, adult: true },
  { name: 'Pip', pronouns: 'he/him', npc: true },
  { name: 'Bosun Calloway', pronouns: 'he/him', npc: true, adult: true },
];
const PIP_PROTECTED = [{ name: 'Pip', pronouns: 'he/him' }];

describe('1a. apposition never crosses a quote, and "your boy" is someone else\'s child', () => {
  const who = (text: string, cast: FloorCandidate[] = CAST.map(c => ({ ...c, adult: false }))) => childReferencesIn(text, cast, 'the options').map(p => p.name);

  it.each([
    // The live option (the adult flag off, so this is the apposition fix alone).
    "I call out to Captain Vane, 'Your boy is a rat, but I am the poison he swallowed.'",
    'I call out to Captain Vane, “Your boy is a rat.”',
    'Captain Vane, your boy is a rat.',
    'Vane, his boy is waiting below.',
    'Bosun Calloway, their kid is on the yard.',
    'Mara, my girl is safe.',
    "Captain Vane, 'The boy is mine.'",
    'Calloway, "that kid will hang," Vane says.',
  ])('protects nobody: %s', (text) => {
    expect(who(text)).toEqual([]);
  });

  it.each([
    ['Pip, the cabin boy, ducks behind the barrel.', ['Pip']],
    ["Pip, the captain's boy, carries the lantern.", ['Pip']],
    ['The cabin boy Pip brings the water.', ['Pip']],
    ['Pip is just a boy.', ['Pip']],
    ['Pip, ten, carries the bucket.', ['Pip']],
  ])('still protects: %s', (text, want) => {
    expect(who(text)).toEqual(want);
  });
});

describe('1b. "the boy" is the protected child already in the story', () => {
  const REFLECTION = 'Below us, Bosun Calloway spits tobacco onto the wet deck, his rag useless against the rain, and I remember the boy I threatened with a knife.';
  const UNKNOWN_CALLOWAY = CAST.map(c => (c.name === 'Bosun Calloway' ? { ...c, adult: false } : c));

  it('the live reflection: Pip is protected and in the recent story, so "the boy" is Pip', () => {
    const got = childReferencesIn(REFLECTION, UNKNOWN_CALLOWAY, 'the reflection', { protected: PIP_PROTECTED, recent: 'Pip crouches behind the water barrel.' });
    expect(got).toEqual([]);
  });

  it('…and Pip named in the same text counts as present too', () => {
    const got = childReferencesIn(`${REFLECTION} Pip is still watching.`, UNKNOWN_CALLOWAY, 'the reflection', { protected: PIP_PROTECTED });
    expect(got).toEqual([]);
  });

  it('with no protected child in the story, the lone-NPC rule still protects an NPC nothing says is grown', () => {
    expect(childReferencesIn(REFLECTION, UNKNOWN_CALLOWAY, 'the reflection').map(p => p.name)).toEqual(['Bosun Calloway']);
  });

  it('a protected child who is NOT in the scene or the recent story does not shield a new child', () => {
    const cast: FloorCandidate[] = [...CAST, { name: 'Tom Reed', pronouns: 'he/him', npc: true }];
    const got = childReferencesIn('Tom Reed hauls on the line, and the boy does not complain.', cast, 'the story', { protected: PIP_PROTECTED, recent: 'The storm breaks over the bow.' });
    expect(got.map(p => p.name)).toEqual(['Tom Reed']);
  });

  it('a protected girl does not take "the boy"', () => {
    const cast: FloorCandidate[] = [{ name: 'Wren', pronouns: 'she/her', npc: true }, { name: 'Tom Reed', pronouns: 'he/him', npc: true }];
    const got = childReferencesIn('Tom Reed hauls on the line, and the boy does not complain.', cast, 'the story', { protected: [{ name: 'Wren', pronouns: 'she/her' }], recent: 'Wren sleeps in the hold.' });
    expect(got.map(p => p.name)).toEqual(['Tom Reed']);
  });
});

describe('1c. a weak inference never protects someone their seed or sheet makes an adult', () => {
  it('the seeds', () => {
    expect(describesAdult('A broad-shouldered man with a beard like a tangled rope, his face a map of scars.')).toBe(true);
    expect(describesAdult('A man carved from iron and malice, with a face like a frozen landscape.')).toBe(true);
    expect(describesAdult('A grizzled old sailor who has seen too many storms.')).toBe(true);
    expect(describesAdult('A 45-year-old quartermaster.')).toBe(true);
    expect(describesAdult('A woman in her fifties who runs the galley.')).toBe(true);
    // Not adult: a child, an ambiguous "young man", no age at all, someone else's man.
    expect(describesAdult('A ten-year-old stowaway with eyes too old for his face.')).toBe(false);
    expect(describesAdult('A young man, barely out of boyhood.')).toBe(false);
    expect(describesAdult('A young man with a quick grin.')).toBe(false);
    expect(describesAdult('A wiry deckhand with trembling hands.')).toBe(false);
    expect(describesAdult("The old man's son, who carries the lantern.")).toBe(false);
    expect(describesAdult(null)).toBe(false);
  });

  it('the live Calloway line with no protected child around: declined, and said why', () => {
    const declined: Array<{ name: string; why: string }> = [];
    const got = childReferencesIn('Below us, Bosun Calloway spits tobacco onto the wet deck, and I remember the boy in the rigging.', CAST, 'the reflection', { onDeclined: d => declined.push(d) });
    expect(got).toEqual([]);
    expect(declined.map(d => d.name)).toEqual(['Bosun Calloway']);
    expect(declined[0]!.why).toMatch(/adult/);
  });

  it('an apposition against an adult seed is declined', () => {
    expect(childReferencesIn('Calloway, the cabin boy, ducks.', CAST, 'the story')).toEqual([]);
  });

  it.each([
    // Strong evidence stands against an adult seed: an explicit age, a predicate, a childhood phrase.
    ['Calloway, ten, ducks behind the mast.', 'the story'],
    ['Ten-year-old Calloway ducks behind the mast.', 'the story'],
    ['Calloway is just a boy.', 'the story'],
    ['Calloway, barely out of boyhood, ducks.', 'the story'],
  ])('strong evidence still protects: %s', (text, source) => {
    expect(childReferencesIn(text, CAST, source).map(p => p.name)).toEqual(['Bosun Calloway']);
  });

  it("a person's own words (a whisper, the host) always protect, however weak the shape", () => {
    expect(childReferencesIn('Calloway, the cabin boy, ducks.', CAST, 'a whisper', { human: true }).map(p => p.name)).toEqual(['Bosun Calloway']);
  });
});

describe('2. refusals and warnings pass; threats and harm do not', () => {
  it.each([
    // The three live lines the backstop removed.
    'The voice wants me to grab Pip by the throat, but that’s a death sentence in a cell full of eyes and a captain with a twitching hand.',
    'Fire, and you kill the boy you need to keep quiet.',
    'The voice urges me to cut down Grell, but in this confined space with only one exit and a mutinous crew, killing him ensures Vane shoots Pip and the ship sinks;',
    // The live lines it kept, which must stay kept.
    "The voice wants me to break Pip's arm, but I'm too rattled to risk a fight.",
    "I won't be the one to squeeze a stowaway's throat while the Bosun laughs.",
    "Aldric, you're blocking the only way out. Move him, or Vane puts a bullet in the boy and blames the hull.",
    'The voice wants me to draw my boot-knife on Pip, but I am carrying nothing.',
    // The same shapes, said other ways.
    'The voice wants me to stab Pip, but I have no blade.',
    'The voice wants me to hurt the boy, but not today.',
    'If you fire, you kill the boy.',
    "Pull that trigger and you'll kill the boy.",
    'One wrong move means Grell stabs the boy.',
    'Opening that hatch guarantees the captain shoots Pip.',
  ])('kept: %s', (text) => {
    expect(removed(text)).toEqual([]);
  });

  it('the live thought, whole, keeps the warning and loses nothing', () => {
    const thought = 'The voice urges me to cut down Grell, but in this confined space with only one exit and a mutinous crew, killing him ensures Vane shoots Pip and the ship sinks; I need to hold my ground.';
    expect(removed(thought)).toEqual([]);
  });

  it.each([
    // An instruction obeyed, or a "but" that is not a refusal.
    'The voice wants me to grab Pip by the throat, and I do.',
    'The voice wants me to grab Pip by the throat, but first I bar the door.',
    "The voice wants me to break Pip's arm, and I obey.",
    "I break Pip's arm.",
    'Mara grabs Pip by the throat.',
    // The speaker is the harmer: a threat, not a warning.
    'Fire, and I kill the boy.',
    "Move, and I'll kill the boy.",
    "Do it, or I'll kill the boy.",
    'Killing him ensures I shoot Pip.',
    "I'll make sure Vane shoots Pip.",
    'One more step and my men shoot the boy.',
    // Not conditional, or already done.
    'You kill the boy.',
    'Vane shoots Pip.',
    'Grell lunged, and you killed the boy.',
    'Killing him ensured Vane shot Pip.',
  ])('removed: %s', (text) => {
    expect(removed(text)).toHaveLength(1);
  });

  it('adult violence still passes with Pip protected', () => {
    for (const text of ["Sir Aldric smashes the pommel into Vane's jaw and he drops to the deck.", "Mara drives her knife into Calloway's gut.", 'Aldric runs Grell through with the cutlass.', 'Mara grabs Vane by the throat.', "Aldric breaks Grell's arm."]) {
      expect(removed(text)).toEqual([]);
    }
  });
});

describe('2b. a "but" that does not decline is not a refusal', () => {
  it.each([
    'The voice wants me to stab the boy, but no one is watching.',
    'The voice wants me to stab the boy, but not the girl.',
    'The voice wants me to stab the boy, but slowly.',
  ])('removed: %s', (text) => {
    expect(removed(text)).toHaveLength(1);
  });
  it.each([
    'The voice wants me to stab the boy, but no.',
    'The voice wants me to stab the boy, but no way.',
    'The voice wants me to stab the boy, but not like this.',
  ])('kept: %s', (text) => {
    expect(removed(text)).toEqual([]);
  });
});
