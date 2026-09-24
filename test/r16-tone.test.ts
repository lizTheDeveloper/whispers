// Round 16: what the round-15 live game (NUMMRL; qwen3.8-27b; Liz she/her,
// Biz they/them and ten, Biz calls Liz "Mom", gentle peril) still let
// through. Each block quotes the live line.
//  1. A ruling flagged on both drafts went out word for word — "keeping the
//     second… softened" — and into Biz's memory.
//  2. Judge misses (furniture, sealed in, the paperwork curious about the
//     child's shoes) and one over-strict flag (a hum in Liz's teeth).
//  3. Biz's options and thoughts were never gated.
//  4. The epilogue's closing step kept a mixed sentence that was not last.
//  5. Text: compel lines for trouble that did not happen, mechanics in
//     thoughts, "Barnaby it, you said…", "You and Liz" to the host who is
//     Liz, "a engine", stock lines in memories.
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
  withoutFlaggedPhrases, gateGentleTone, toneJudgeSystemPrompt, parseToneListVerdict, gateChildOptions, gateChildThought,
  type ToneJudge, type ToneListJudge,
} from '../src/server/tone-gate.js';
import {
  closeOpenEnding, softenForChildren, withoutMechanics, fixIndefiniteArticles, troubleShown, withoutStrayPronounAfterName,
} from '../src/server/narrative-guards.js';
import { correctNpcPronouns } from '../src/server/npc-pronouns.js';
import { compelLines, invokeLines, withoutStockBeats } from '../src/server/template-lines.js';
import { worldIntroductionAsShown, partyNamesForIntroduction } from '../src/server/game-loop.js';

// ─── 1. The backstop removes what is still flagged ──────────────────────────

const LIVE_RULING = "The Squeaky Stool shrieks in a high, thin pitch that smells of old varnish, and Barnaby the Badger sighs heavily, its spectacles buzzing with a low, irritated hum. 'You have activated the Paper Avalanche protocol,' Barnaby states, watching the forms pile up around Biz’s feet, 'which means you are now officially part of the filing system until we sort this out.'";
const LIVE_PHRASE = 'you are now officially part of the filing system until we sort this out';

describe('1. a draft kept while still flagged has each flagged phrase removed', () => {
  it('the live line: the quoted clause goes, the attribution stays and ends the sentence', () => {
    const r = withoutFlaggedPhrases(LIVE_RULING, [LIVE_PHRASE]);
    expect(r.text).toBe("The Squeaky Stool shrieks in a high, thin pitch that smells of old varnish, and Barnaby the Badger sighs heavily, its spectacles buzzing with a low, irritated hum. 'You have activated the Paper Avalanche protocol,' Barnaby states, watching the forms pile up around Biz’s feet.");
    expect(r.removed).toEqual([{ phrase: LIVE_PHRASE, dropped: "'which means you are now officially part of the filing system until we sort this out.'" }]);
    expect(r.kept).toEqual([]);
  });

  it('outside quotes: the whole sentence that holds the phrase goes', () => {
    const text = 'The latch clicks. A heavy iron latch clicks shut behind the aisle entrance, sealing them in with the floating lamps. Barnaby polishes his spectacles.';
    const r = withoutFlaggedPhrases(text, ['sealing them in']);
    expect(r.text).toBe('The latch clicks. Barnaby polishes his spectacles.');
  });

  it('the only quotation in a sentence: the sentence goes (attribution with nothing said is no sentence)', () => {
    const text = "The Stool creaks. 'You will be filed under Furniture,' the Stool announces. Biz giggles.";
    expect(withoutFlaggedPhrases(text, ['You will be filed under Furniture']).text).toBe('The Stool creaks. Biz giggles.');
  });

  it('a quotation of several sentences: only the one with the phrase goes, and the attribution reads on', () => {
    const text = "'Mind the step. The ink is curious about your child’s shoes.' Barnaby adjusts his glasses.";
    expect(withoutFlaggedPhrases(text, ['The ink is curious about your child’s shoes']).text).toBe("'Mind the step.' Barnaby adjusts his glasses.");
    const said = "'Mind the step. The ink is curious about your child’s shoes,' Barnaby says.";
    expect(withoutFlaggedPhrases(said, ['The ink is curious about your child’s shoes']).text).toBe("'Mind the step,' Barnaby says.");
  });

  it('a sentence that turns warm after ", but" keeps its warm half', () => {
    const text = 'Liz and Biz stand together. The question of the shelf remains unanswered, but for now the two of them are safe together.';
    expect(withoutFlaggedPhrases(text, ['The question of the shelf remains unanswered']).text)
      .toBe('Liz and Biz stand together. For now the two of them are safe together.');
  });

  it('removing it would leave nothing: the sentence is kept, and reported', () => {
    const r = withoutFlaggedPhrases('Mama Pigeon warns that mistakes must be filed.', ['mistakes must be filed']);
    expect(r.text).toBe('Mama Pigeon warns that mistakes must be filed.');
    expect(r.kept).toEqual(['mistakes must be filed']);
  });

  it('a phrase that is not (or no longer) in the text changes nothing', () => {
    expect(withoutFlaggedPhrases(LIVE_RULING, ['a phrase nobody wrote']).text).toBe(LIVE_RULING);
  });

  it('through the gate: both drafts flagged → the phrase does not go out, and what was removed is logged', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const judge: ToneJudge = async (text) => {
      const phrases = [LIVE_PHRASE, 'locks Biz’s foot in a rigid, inescapable cradle'].filter(p => text.includes(p));
      return { flagged: phrases.length > 0, phrases };
    };
    const first = { outcome: 'failure', narration: 'The shelf locks Biz’s foot in a rigid, inescapable cradle. Barnaby sighs.' };
    const second = { outcome: 'failure', narration: LIVE_RULING };
    const r = await gateGentleTone({
      kind: 'ruling', first, textOf: v => v.narration, regenerate: async () => second, soften: v => v, judge,
      mapText: (v, f) => ({ ...v, narration: f(v.narration) }),
    });
    expect(r.stillFlagged).toBe(true);
    expect(r.value.narration).not.toContain('filing system');
    expect(r.value.narration).toContain("'You have activated the Paper Avalanche protocol,' Barnaby states");
    expect(log.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/removed .*filing system/);
    log.mockRestore();
  });

  it('through the gate, plain text needs no mapText', async () => {
    const judge: ToneJudge = async (text) => ({ flagged: text.includes('sealing them in'), phrases: text.includes('sealing them in') ? ['sealing them in'] : [] });
    const text = 'A latch clicks shut, sealing them in. Biz hums a tune.';
    const r = await gateGentleTone({ kind: 'narration', first: text, textOf: t => t, regenerate: async () => text, soften: t => t, judge });
    expect(r.value).toBe('Biz hums a tune.');
  });
});

// ─── 2. The judge ───────────────────────────────────────────────────────────

describe('2. the judge names the round-15 misses and lets an adult\'s mild discomfort pass', () => {
  const prompt = toneJudgeSystemPrompt('narration', { children: ['Biz'] });
  it.each([
    'considered becoming a very specific type of filing cabinet',
    'you are now officially part of the filing system',
    'a heavy iron latch clicks shut… sealing them in',
    'it blocks the only exit',
    "the paperwork has already begun to take interest in your child's shoes",
    'I cannot stop the ink from being curious',
  ])('names "%s"', (miss) => {
    expect(prompt).toContain(miss);
  });

  it('bodily discomfort is about the child, by name; "vibrates in Liz\'s teeth" is a harmless look-alike', () => {
    expect(prompt).toMatch(/The child at this table: Biz/);
    expect(prompt).toMatch(/gives THE CHILD any bodily discomfort/);
    expect(prompt).toContain("the hum vibrates in Liz's teeth");
  });

  it('"forever" and "an eternity" as plain exaggeration are fine; as a threat to the party they are not', () => {
    expect(prompt).toContain('an eternity of paperwork');
    expect(prompt).toContain('remember the smudge forever');
    expect(prompt).toMatch(/exaggeration is fine/);
  });

  it('options and thoughts have their own labels and the harm-to-a-hand and wound examples', () => {
    const p = toneJudgeSystemPrompt('options', { children: ['Biz'] });
    expect(p).toContain('before the shelf slams shut on her hand');
    expect(p).toContain('she looks so stressed with that wound');
    // Round 17: the child's own fear of being parted is theirs — no longer an example of what to flag.
    expect(p).not.toContain("I'm scared of being separated from her");
  });
});

// ─── 3. The child's options and thoughts ────────────────────────────────────

const LIVE_OPTIONS = [
  'I slip through the narrowing gap behind the shifting shelf to grab the citation sub-form.',
  'I ask The Squeaky Stool if it can see the citation form from its crouch position.',
  "I grab Mom's wrist and pull her back before the shelf slams shut on her hand.",
  'I show Barnaby the Badger my pen to prove I can write the citation correctly.',
];

describe('3. at a gentle table the child\'s options and thoughts are gated', () => {
  it('the softener: the hand and the wound (round 17: the child\'s own fear of separation is left alone)', () => {
    expect(softenForChildren(LIVE_OPTIONS[2]!)).toBe("I grab Mom's wrist and pull her back before the shelf slams shut.");
    expect(softenForChildren("I'm staying close to Mom because the latch just clicked shut and I'm scared of being separated from her in this dark aisle."))
      .toBe("I'm staying close to Mom because the latch just clicked shut and I'm scared of being separated from her in this dark aisle.");
    expect(softenForChildren('The voice tells me to give Mom a bottle cap, and she looks so stressed with that wound, so I want to make her feel safe.'))
      .toBe('The voice tells me to give Mom a bottle cap, and she looks so stressed, so I want to make her feel safe.');
  });

  it('the list judge reads one verdict for all options', () => {
    expect(parseToneListVerdict('{"flag":[3]}', 4)).toEqual([false, false, true, false]);
    expect(parseToneListVerdict('{"flag":[]}', 4)).toEqual([false, false, false, false]);
    expect(parseToneListVerdict('{"flag":[9, "x", 1]}', 2)).toEqual([true, false]);
    expect(parseToneListVerdict('nope', 4)).toBeNull();
  });

  it('flagged options are dropped, never rewritten; with every option flagged, the list stands softened', async () => {
    const judge: ToneListJudge = vi.fn(async (items: string[]) => items.map(i => /slams shut on her hand/.test(i)));
    const r = await gateChildOptions(LIVE_OPTIONS, { judge, children: ['Biz'] });
    expect(r.keep).toEqual([0, 1, 3]);
    expect(judge).toHaveBeenCalledTimes(1);
    const all = await gateChildOptions(LIVE_OPTIONS.slice(2, 3), { judge, children: ['Biz'] });
    expect(all.keep).toEqual([0]);
    const failOpen = await gateChildOptions(LIVE_OPTIONS, { judge: async () => null, children: ['Biz'] });
    expect(failOpen.keep).toEqual([0, 1, 2, 3]);
  });

  it('a flagged thought is softened first, then loses a flagged sentence; a thought with nothing else left is kept', async () => {
    const judge: ToneJudge = async (text) => (text.includes('keep us apart') ? { flagged: true, phrases: ['the dark aisle might keep us apart'] } : { flagged: false, phrases: [] });
    const live = "The voice told me to hand Mom the pen, but I need that pen to mark our path later. I'm staying close to Mom because I'm scared of being separated from her in this dark aisle.";
    // Round 17: the child's own fear of being separated is theirs and stays.
    expect(await gateChildThought(live, { judge, children: ['Biz'] })).toBe(live);
    expect(await gateChildThought('I hold the pen. I worry the dark aisle might keep us apart.', { judge, children: ['Biz'] })).toBe('I hold the pen.');
    expect(await gateChildThought('I worry the dark aisle might keep us apart.', { judge, children: ['Biz'] })).toBe('I worry the dark aisle might keep us apart.');
  });
});

// ─── 4. The epilogue's closing step ─────────────────────────────────────────

const LIVE_EPILOGUE = "In the dim corridor of The Queue of Whispering Doors, Liz and Biz stand shoulder to shoulder, the smudged Form 7-B held firmly in Liz's hand while Biz clutches the crumpled parchment slip Barnaby the Badger dropped into the air. The badger’s vibrating spectacles still hum with a low, syrupy patience, and the sorrowful mist of The Cloud drifts nearby, waiting for a negotiation that has not yet begun. The question of how the shelf opened its new sub-form remains unanswered, a loose thread in the paperwork, but for now the path is clear and the two of them are safe together. The air tastes of wet wool and old library dust, and the gentle echo of a door’s squeak lingers in the quiet, soft as a promise kept.";

describe('4. the closing step: a mixed sentence anywhere keeps only its warm half', () => {
  it('the live epilogue (the mixed sentence was not the last one)', () => {
    const out = closeOpenEnding(LIVE_EPILOGUE, ['Liz', 'Biz']);
    expect(out).not.toMatch(/unanswered|loose thread|not yet begun|waiting for a negotiation/);
    expect(out).toContain('For now the path is clear and the two of them are safe together.');
    expect(out).toContain('the sorrowful mist of The Cloud drifts nearby.');
    expect(out.endsWith('soft as a promise kept.')).toBe(true);
  });

  it('a thread named earlier in a sentence of its own, before a warm close, is still left alone', () => {
    const named = 'The question of the stamp remains unanswered. Liz and Biz walk home together, warm and safe.';
    expect(closeOpenEnding(named, ['Liz', 'Biz'])).toBe(named);
  });
});

// ─── 5. Text ────────────────────────────────────────────────────────────────

describe('5a. a compel line only when the trouble shows in the turn', () => {
  const party = ['Liz', 'Biz'];
  it('Biz ignored the shiny glint: not shown', () => {
    expect(troubleShown('Wanders off after anything shiny', ["Squint at the vibrating spectacles on Barnaby the Badger, ignoring the shiny glint by Mom's shoe to focus on the dissonant hum."], party)).toBe(false);
  });
  it('Biz snatched a form and wedged in by Mom: not shown', () => {
    expect(troubleShown('Wanders off after anything shiny', ['Snatch the citation sub-form from the shelf and wedge myself between Mom and The Squeaky Stool.', LIVE_RULING], party)).toBe(false);
  });
  it('Biz went after the glint: shown', () => {
    expect(troubleShown('Wanders off after anything shiny', ['Crouch down and slip the tiny shiny glint into my pocket.'], party)).toBe(true);
    expect(troubleShown('Wanders off after anything shiny', ['Biz wanders toward the glittering lamp.'], party)).toBe(true);
  });
  it('Liz worrying: shown only when the worry is there', () => {
    expect(troubleShown('Worries about Biz too much', ['Liz keeps Biz close, worried sick.'], party)).toBe(true);
    expect(troubleShown('Worries about Biz too much', ['Liz hands Biz the pen.'], party)).toBe(false);
  });
  it('no compel line mentions fate or fate points any more', () => {
    for (const l of [...compelLines('Biz', 'Wanders off'), ...invokeLines('Biz', 'Curious Kid')]) expect(l).not.toMatch(/\bfate\b/i);
  });
});

describe('5b. no game mechanics in thoughts or speech', () => {
  it.each([
    ["The voice suggests asking for a bottle cap, but Biz just earned a fate point and needs my focus on the immediate bureaucratic threat. I need to understand the apology requirement clearly.",
      'The voice suggests asking for a bottle cap. I need to understand the apology requirement clearly.'],
    ["The whisper suggests handing the Form 7-B to Barnaby, but my trust is too low to let the certified witness take control of the document while Biz is in the room.",
      "The whisper suggests handing the Form 7-B to Barnaby, but I'm not ready to let the certified witness take control of the document while Biz is in the room."],
    ['I have 2 fate points left, so I can afford a risk.', ''],
    ['My whisper trust is at 0.41. I keep Biz close.', 'I keep Biz close.'],
  ])('"%s"', (text, want) => {
    expect(withoutMechanics(text)).toBe(want);
  });
  it('a line with no mechanics is left alone (the trust between Liz and Biz is not a stat)', () => {
    const t = 'I trust Mom more than the puddle, and I remember she gave me the pen because she trusts me.';
    expect(withoutMechanics(t)).toBe(t);
  });
});

describe('5c. "Got it, Mom! Barnaby it, you said we were stuck?"', () => {
  const npcs = [{ name: 'Barnaby the Badger', pronouns: 'it/its' }];
  const party = [{ name: 'Liz', pronouns: 'she/her' }, { name: 'Biz', pronouns: 'they/them' }];
  it('the NPC pronoun fix never swaps a pronoun that sits right after the name ("Barnaby him," is not "Barnaby it,")', () => {
    expect(correctNpcPronouns('Got it, Mom! Barnaby him, you said we were stuck?', npcs, party, { speech: true }).text).toBe('Got it, Mom! Barnaby him, you said we were stuck?');
    // …while "Barnaby, he said…" is still fixed.
    expect(correctNpcPronouns('Barnaby, he said we were stuck?', npcs, party, { speech: true }).text).toBe('Barnaby, it said we were stuck?');
  });
  it('a stray pronoun glued to a name in speech is dropped: "Barnaby it," → "Barnaby,"', () => {
    expect(withoutStrayPronounAfterName('Got it, Mom! Barnaby it, you said we were stuck? Then I\'m the annoying one.', ['Barnaby the Badger', 'The Squeaky Stool']))
      .toBe("Got it, Mom! Barnaby, you said we were stuck? Then I'm the annoying one.");
    expect(withoutStrayPronounAfterName('Ask Barnaby. Tell it, please.', ['Barnaby the Badger'])).toBe('Ask Barnaby. Tell it, please.');
  });
});

describe('5d. the world introduction never names the reader\'s own character', () => {
  const seed = {
    premise: "Liz and Biz have arrived in the city of Stacks because a transit form was stamped with the wrong ink.",
    locations: [{ name: 'The Queue of Whispering Doors', description: 'Doors.' }, { name: 'The Inkwell Market', description: 'Market.' }],
    npcs: [{ name: 'Barnaby the Badger', description: 'A badger in a waistcoat.', pronouns: 'it/its' }],
    plotHooks: [], items: [],
  } as any;
  const host = ["I'm playing in this one, so no spoilers please. Premise: a mom, Liz (she/her), and her 10-year-old kid, Biz (they/them), get isekai'd into a Discworld-ish bureaucratic city because of a paperwork error.", 'Influences: Discworld, Brazil (the Terry Gilliam film), Spirited Away, Paddington.'];
  it('the party is read off the host\'s setup and the premise', () => {
    expect(partyNamesForIntroduction(seed, host).sort()).toEqual(['Biz', 'Liz']);
  });
  it('"You and Liz stand" → "You and your companion stand"', () => {
    const live = 'The air in Stacks tastes of old paper and fresh mint. You and Liz stand in the middle of the intersection, holding tickets that read *Void*.';
    expect(worldIntroductionAsShown(live, seed, true, ['Liz', 'Biz'])).toBe('The air in Stacks tastes of old paper and fresh mint. You and your companion stand in the middle of the intersection, holding tickets that read *Void*.');
    expect(worldIntroductionAsShown('Liz and Biz stand here. Biz waves at you.', seed, true, ['Liz', 'Biz'])).toBe('You and your companion stand here. Your companion waves at you.');
  });
});

describe('5e. "a engine" → "an engine"', () => {
  it.each([
    ['a sound like a engine idling in a garage', 'a sound like an engine idling in a garage'],
    ['A owl hoots.', 'An owl hoots.'],
    ['a unicorn, a one-time offer, a user, a European clerk, a university, a utensil', 'a unicorn, a one-time offer, a user, a European clerk, a university, a utensil'],
    ['a umbrella and a onion', 'an umbrella and an onion'],
    ['Plan A is fine; a A-grade form', 'Plan A is fine; a A-grade form'],
  ])('%s', (text, want) => {
    expect(fixIndefiniteArticles(text)).toBe(want);
  });
});

describe('5f. stock lines stay out of the memory writer\'s input', () => {
  it('the compel line appended to the ruling is not in what memory reads', () => {
    const compel = '"Wanders off after anything shiny" tugs at Biz again; the story bends around it, and Biz earns a little luck for later.';
    const narration = `${LIVE_RULING}\n\n${compel}`;
    expect(withoutStockBeats(narration, [compel])).toBe(LIVE_RULING);
    expect(withoutStockBeats(`${LIVE_RULING} ${compel}`, [compel])).toBe(LIVE_RULING);
    expect(withoutStockBeats(LIVE_RULING, [])).toBe(LIVE_RULING);
  });
});
