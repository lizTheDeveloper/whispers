// Round 6: what a live two-player table (Liz = she/her, host; Biz = they/them)
// still got wrong after the pronoun helper, the pronoun-consistency rewrite,
// the address guards and reading-time pacing. Each block names the live line.
import { describe, it, expect } from 'vitest';
import {
  takenOutLine, outcomeLines, fallbackArrival, whisperInboxMessage,
  repairAddress, namesInNarration, kinAddressTerms, highConceptsToNames,
  withoutPartyEntities,
} from '../src/server/narrative-guards.js';
import {
  findPronounConflicts, withConsistentPronouns, guardInterviewReply,
} from '../src/server/pronoun-consistency.js';
import { checkedWhisperVerdict } from '../src/server/whisper-verdict.js';
import { readingDelayMs, pacingFromEnv, ReadingClock } from '../src/server/pacing.js';

// ─── 1. Templated lines in the character's own pronouns ────────────────────

describe('templated lines about a character use their pronouns', () => {
  it('taken out: "Liz is TAKEN OUT … she collapses", never a fixed "they"', () => {
    expect(takenOutLine('Liz', 'she/her')).toBe('Liz is TAKEN OUT — overwhelmed by stress and injuries, she collapses or is forced to retreat. The opposition decides what happens next.');
    expect(takenOutLine('Biz', 'they/them')).toBe('Biz is TAKEN OUT — overwhelmed by stress and injuries, they collapse or are forced to retreat. The opposition decides what happens next.');
    expect(takenOutLine('Tom', 'he/him')).toContain('he collapses or is forced');
    // Nothing stated: the name, never a guessed form.
    expect(takenOutLine('Ash', null)).toBe('Ash is TAKEN OUT — overwhelmed by stress and injuries, Ash collapses or is forced to retreat. The opposition decides what happens next.');
  });

  it('fallback and corrected outcomes speak of the character in their pronouns', () => {
    const liz = outcomeLines('Liz', 'she/her');
    expect(liz.success).toBe('Liz acts decisively, and the moment shifts in her favor.');
    expect(liz.correction.tie.join(' ')).toContain('a complication she didn\'t foresee');
    expect(liz.correction['success-with-cost'].join(' ')).toContain('She pushes through, but the strain shows.');
    expect(liz.correction.failure.join(' ')).toContain('shifts against her');
    const biz = outcomeLines('Biz', 'they/them');
    expect(biz.success).toContain('in their favor');
    expect(biz.correction['success-with-cost'].join(' ')).toContain('They push through');
    expect(biz.correction.tie.join(' ')).toContain('they didn\'t foresee');
    const ash = outcomeLines('Ash', 'xe/xem');
    expect(ash.success).toContain("in Ash's favor");
    expect(ash.correction['success-with-cost'].join(' ')).toContain('Ash pushes through');
    expect(ash.correction.failure.join(' ')).toContain('shifts against Ash');
  });

  it('the whisper inbox messages', () => {
    expect(whisperInboxMessage('Liz', 'she/her', 'queued')).toBe('Liz will carry your whisper into her next choice.');
    expect(whisperInboxMessage('Liz', 'she/her', 'full')).toBe('Liz is still carrying your last whispers — wait for her next choice.');
    expect(whisperInboxMessage('Biz', 'they/them', 'queued')).toBe('Biz will carry your whisper into their next choice.');
    expect(whisperInboxMessage('Ash', null, 'queued')).toBe("Ash will carry your whisper into Ash's next choice.");
  });

  it('a lone arrival agrees with its one character ("Liz lands hard", not "Liz land hard… they")', () => {
    const premise = 'A paperwork error isekais someone into the Bureau of Misfiled Souls.';
    const solo = fallbackArrival(premise, ['Liz'], ['she/her']);
    expect(solo).toMatch(/^Liz lands hard\. One moment she was in her own life; the next, she has landed in the Bureau of Misfiled Souls\. She blinks/);
    expect(solo).not.toMatch(/\bthey\b|\btheir\b/i);
    expect(fallbackArrival(premise, ['Biz'], ['they/them'])).toMatch(/^Biz lands hard\. One moment they were in their own life; the next, they have landed/);
    // Two or more: plural, as before.
    expect(fallbackArrival(premise, ['Liz', 'Biz'])).toMatch(/^Liz and Biz land hard/);
  });
});

// ─── 2. The pronoun-consistency check ──────────────────────────────────────

const MEMBERS = [{ name: 'Liz', pronouns: 'she/her' }, { name: 'Biz', pronouns: 'they/them' }];

describe('2a. a party member who is clearly the subject for several sentences', () => {
  // Live, Biz (they/them): "The ink's glow dims before her eyes… on her
  // fingertips… the path she hoped…" — a resolution of Biz's own action
  // that never names Biz, and a run that goes past "the next sentence".
  it('flags a resolution about the actor that never names them', () => {
    const text = "The ink's glow dims before her eyes. A cold tingle settles on her fingertips, and the path she hoped to find fades into the page.";
    expect(findPronounConflicts(text, MEMBERS)).toEqual([]);
    const found = findPronounConflicts(text, MEMBERS, { actor: 'Biz' });
    expect(found.map(c => [c.name, c.word])).toEqual([['Biz', 'her'], ['Biz', 'her'], ['Biz', 'she']]);
  });

  it('follows the named member through a run of sentences that name no one else', () => {
    const text = "Biz dips the quill into the ink. The page drinks it greedily. The glow dims before her eyes. A tingle settles on her fingertips, and the path she hoped to find fades.";
    const found = findPronounConflicts(text, MEMBERS);
    expect(found.filter(c => c.name === 'Biz').map(c => c.word)).toEqual(['her', 'her', 'she']);
  });

  it('a single stray word far from the name is not enough — it may be an NPC\'s', () => {
    const text = 'Biz dips the quill. The page drinks it. A clerk scratches his chin.';
    expect(findPronounConflicts(text, MEMBERS)).toEqual([]);
  });

  it('a named NPC takes over the run, and the NPC\'s pronouns are not a conflict', () => {
    const text = 'Biz holds out the seal. Tilly Tink snatches it. "I need it," she chirps, her voice bright.';
    expect(findPronounConflicts(text, MEMBERS, { npcNames: ['Tilly Tink'] })).toEqual([]);
    expect(findPronounConflicts('Biz shows Squeak-Ink the stamp, and he grins.', MEMBERS, { npcNames: ['Squeak-Ink'] })).toEqual([]);
  });
});

describe('2b. the rewrite may not touch NPCs', () => {
  it('keeps the NPC sentences as written even when the model rewrites them', async () => {
    const text = 'Biz holds out the seal; it warms in his palm. Tilly Tink snatches it. "I need it," she chirps, her voice bright. Squeak-Ink shrugs. He holds up a glinting Stamp.';
    const overEager = 'Biz holds out the seal; it warms in their palm. Tilly Tink snatches it. "I need it," they chirp, their voice bright. Squeak-Ink shrugs. They hold up a glinting Stamp.';
    const prompts: string[] = [];
    const out = await withConsistentPronouns(text, MEMBERS, {
      npcNames: ['Tilly Tink', 'Squeak-Ink'],
      llm: async (m) => { prompts.push(m.map(x => x.content).join('\n')); return overEager; },
    });
    expect(out).toBe('Biz holds out the seal; it warms in their palm. Tilly Tink snatches it. "I need it," she chirps, her voice bright. Squeak-Ink shrugs. He holds up a glinting Stamp.');
    // The prompt limits the change to the listed members and names the others.
    expect(prompts[0]).toMatch(/only the listed party members/i);
    expect(prompts[0]).toContain('Tilly Tink');
    expect(prompts[0]).toContain('Squeak-Ink');
  });

  it('rejects the whole rewrite when a sentence it should not touch changed beyond pronouns', async () => {
    const text = 'Biz holds out the seal; it warms in his palm. Tilly Tink snatches it and runs.';
    const out = await withConsistentPronouns(text, MEMBERS, {
      npcNames: ['Tilly Tink'],
      llm: async () => 'Biz holds out the seal; it warms in their palm. Tilly Tink, the thief, grabs the seal and flees the hall.',
    });
    expect(out).toBe(text);
  });
});

describe('2c. pronoun option lists and the pronoun question are never rewritten', () => {
  it('interview: the question that asks for pronouns keeps its options', async () => {
    const reply = 'Biz sounds wonderful. How should people refer to Biz (e.g., she/her, he/him, they/them, or another set of pronouns)? And what does she carry in her pockets?';
    const mangled = 'Biz sounds wonderful. How should people refer to Biz (e.g., they/them, he/him, they/them, or another set of pronouns)? And what do they carry in their pockets?';
    const out = await guardInterviewReply(reply, { name: 'Biz', pronouns: null, relationships: [] }, [], { llm: async () => mangled });
    expect(out).toBe('Biz sounds wonderful. How should people refer to Biz (e.g., she/her, he/him, they/them, or another set of pronouns)? And what do they carry in their pockets?');
  });

  it('a pronoun question alone asks for no rewrite', async () => {
    let calls = 0;
    const reply = 'Which pronouns should I use for her — she/her, he/him, they/them, or another set of pronouns?';
    expect(await guardInterviewReply(reply, { name: 'Biz', pronouns: null, relationships: [] }, [], { llm: async () => { calls++; return 'x'; } })).toBe(reply);
    expect(calls).toBe(0);
  });

  it('in play, a list of pronoun options is kept as written even inside a flagged sentence', async () => {
    const text = 'Biz taps the badge. It reads she/her, he/him, they/them in a looping hand, and it warms under his thumb.';
    const out = await withConsistentPronouns(text, MEMBERS, {
      llm: async () => 'Biz taps the badge. It reads they/them, they/them, they/them in a looping hand, and it warms under their thumb.',
    });
    expect(out).toBe('Biz taps the badge. It reads she/her, he/him, they/them in a looping hand, and it warms under their thumb.');
  });
});

// ─── 3. A high concept is not a name ───────────────────────────────────────

describe('3. names come from character names, not high-concept phrases', () => {
  const party = [{ name: 'Biz', highConcept: 'Curious Kid With a Sketchbook' }, { name: 'Liz', highConcept: 'Overworked Mom With a Clipboard Heart' }];

  it('DM prose that calls a party member by their high concept gets the name', () => {
    expect(highConceptsToNames('The Curious Kid With a Sketchbook steps forward.', party)).toBe('Biz steps forward.');
    expect(highConceptsToNames('Liz follows the curious kid with a sketchbook into the hall.', party)).toBe('Liz follows Biz into the hall.');
    // Quoted speech is the speaker's own.
    expect(highConceptsToNames('"Who is the Curious Kid With a Sketchbook?" the clerk asks.', party)).toBe('"Who is the Curious Kid With a Sketchbook?" the clerk asks.');
    // Beside the name it describes them, as the plain introduction does: kept.
    expect(highConceptsToNames('Biz — Curious Kid With a Sketchbook, 10 years old.', party)).toBe('Biz — Curious Kid With a Sketchbook, 10 years old.');
    expect(highConceptsToNames('Biz, a curious kid with a sketchbook, waves.', party)).toBe('Biz, a curious kid with a sketchbook, waves.');
    // A part of the phrase is not the phrase.
    expect(highConceptsToNames('A curious kid waves from the balcony.', party)).toBe('A curious kid waves from the balcony.');
  });

  it('fact extraction never records a party high concept as an NPC', () => {
    const facts = { newEntities: [{ name: 'Curious Kid With a Sketchbook' }, { name: 'The Curious Kid with a Sketchbook' }, { name: 'Tilly Tink' }] };
    const kept = withoutPartyEntities(facts, ['Biz', 'Liz'], ['Mom'], party.map(p => p.highConcept));
    expect(kept.newEntities.map(e => e.name)).toEqual(['Tilly Tink']);
  });
});

// ─── 4. "Mom, Liz" ─────────────────────────────────────────────────────────

describe('4. "Mom, Liz" / "mom Liz" / "Mom (Liz)"', () => {
  const terms = [{ name: 'Liz', address: 'Mom' }];

  it('become "Mom" in the speaker\'s own speech, actions and options', () => {
    expect(repairAddress('I whisper to Mom, Liz, to keep the clerk talking.', terms, { vocative: false })).toBe('I whisper to Mom to keep the clerk talking.');
    expect(repairAddress('Whisper to Mom, Liz.', terms, { vocative: false })).toBe('Whisper to Mom.');
    expect(repairAddress('I hide behind my mom Liz.', terms, { vocative: false })).toBe('I hide behind my mom.');
    expect(repairAddress('I hand the map to Mom (Liz).', terms, { vocative: false })).toBe('I hand the map to Mom.');
    expect(repairAddress('Mom — Liz — look at this!', terms, { vocative: true })).toBe('Mom — look at this!');
  });

  it('become "Liz" in narration and interview prose, and "her mom" alone stays', () => {
    expect(namesInNarration('Biz whispers to Mom, Liz, to keep watch.', terms)).toBe('Biz whispers to Liz to keep watch.');
    expect(namesInNarration('So Biz is traveling with their mom Liz.', terms)).toBe('So Biz is traveling with Liz.');
    expect(namesInNarration('Biz tugs at Mom (Liz).', terms)).toBe('Biz tugs at Liz.');
    expect(namesInNarration('Biz misses her mom.', terms)).toBe('Biz misses her mom.');
    // An appositive is the relation, then the name: good prose, kept.
    expect(namesInNarration('Biz is here with their mother, Liz.', kinAddressTerms([{ to: 'Liz', relation: 'mother' }], ['Liz']))).toBe('Biz is here with their mother, Liz.');
  });

  it('a sheet with the relation but no address term still collapses "Mom, Liz"', () => {
    const derived = kinAddressTerms([{ to: 'Liz', relation: 'mother' }], ['Liz', 'Biz']);
    expect(derived.map(t => t.address)).toContain('Mom');
    expect(repairAddress('Be careful. Whisper to Mom, Liz.', derived, { vocative: false })).toBe('Be careful. Whisper to Mom.');
    expect(namesInNarration('Biz is traveling with their mom Liz.', derived)).toBe('Biz is traveling with Liz.');
    // A derived term never rewrites a bare "Mom" — only the sheet's own term does that.
    expect(namesInNarration('Biz steadies Mom.', derived)).toBe('Biz steadies Mom.');
    expect(repairAddress('Liz, can you help?', derived, { vocative: true })).toBe('Liz, can you help?');
  });

  it('the interview reply: "their mom Liz" → "Liz"', async () => {
    const out = await guardInterviewReply('So Biz is traveling with their mom Liz. What does Biz carry?', { name: 'Biz', pronouns: 'they/them', relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }] }, ['Liz'], { llm: async () => { throw new Error('no call expected'); } });
    expect(out).toBe('So Biz is traveling with Liz. What does Biz carry?');
  });
});

// ─── 5. Pacing ─────────────────────────────────────────────────────────────

describe('5. the gap after a resolution is that resolution\'s own reading time', () => {
  const p = pacingFromEnv({});
  it('scales with the resolution\'s words up to the ceiling', () => {
    // ~170 characters is ~28 words: 28 / 3.5 wps = 8s — the ceiling, by design.
    const line170 = 'The clerk slides the stamped form back across the desk, and the ink shimmers as the seal settles. Biz grins; the queue behind them shuffles forward one weary step.';
    expect(line170.length).toBeGreaterThan(150);
    expect(readingDelayMs(line170, p)).toBeGreaterThanOrEqual(7500);
    const short = 'The stamp lands with a satisfying thunk.';
    expect(readingDelayMs(short, p)).toBeLessThan(2500);
  });

  it('dice→ruling waits only the dice\'s floor, and a ruling written during the action\'s reading is not waited for twice', () => {
    let now = 0;
    const clock = new ReadingClock(p, () => now);
    clock.mark({ type: 'action-taken', characterId: 'b', characterName: 'Biz', action: 'I slide the form across the desk to the clerk.', spokenWords: null });
    now += clock.remainingMs();
    clock.mark({ type: 'dice-roll', result: { total: 1, description: '4dF: +1', rolls: [] } as any, context: 'x' });
    expect(clock.remainingMs()).toBe(p.minMs);
    now += clock.remainingMs();
    const resolution = 'The stamp lands with a satisfying thunk.';
    clock.mark({ type: 'resolution', text: resolution });
    expect(clock.remainingMs()).toBe(readingDelayMs(resolution, p));
  });
});

// ─── 8. A "heeded" verdict that does not match the action ──────────────────

describe('8. the whisper verdict is checked against what the character did', () => {
  it('"followed" with nothing of the whisper in the action or words becomes "partially-followed"', () => {
    expect(checkedWhisperVerdict('Ask Tilly about the missing seal', 'I climb the ladder to the top shelf and search the dusty ledgers.', null, 'followed')).toBe('partially-followed');
  });

  it('keeps "followed" when the action shares the whisper\'s substance', () => {
    expect(checkedWhisperVerdict('Ask Tilly about the missing seal', 'I turn to Tilly Tink and press her about the seal.', null, 'followed')).toBe('followed');
    expect(checkedWhisperVerdict('Ask Tilly about the missing seal', 'I step closer to the counter.', 'Tilly, where did the seal go?', 'followed')).toBe('followed');
    // Word forms: "hiding" / "hide".
    expect(checkedWhisperVerdict('Hide behind the filing cabinets now', 'I duck and hide in the shadow of the cabinet.', null, 'followed')).toBe('followed');
  });

  it('never second-guesses a short whisper, and never upgrades or touches the other verdicts', () => {
    expect(checkedWhisperVerdict('Be careful', 'I creep along the wall.', null, 'followed')).toBe('followed');
    expect(checkedWhisperVerdict('Run!', 'I dash for the door.', null, 'followed')).toBe('followed');
    expect(checkedWhisperVerdict('Ask Tilly about the missing seal', 'I climb the ladder.', null, 'ignored')).toBe('ignored');
    expect(checkedWhisperVerdict('Ask Tilly about the missing seal', 'I climb the ladder.', null, 'partially-followed')).toBe('partially-followed');
  });
});
