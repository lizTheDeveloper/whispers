// Round 18: setup, items and text, live game 39PF4D (Liz she/her, Biz
// they/them, 10, gentle peril). See r18-misc-loop.test.ts for play and the
// prompts.
//  1. Liz's sheet: "balancing books and her son's needs" — Biz is they/them.
//  2. "Liz sweeps… catching the scattered bottle caps": Biz's cap lay in the
//     world, the DM sent no move, and nothing changed hands. "Card Door" and
//     "Filing Cabinets" were filed as NPCs.
//  3. "Sharply瞪 The Pigeon"; a ruling that opened mid-quote
//     (`Liz, hold the form flat so it doesn't turn into a bird again."`);
//     "A small, velvety The Dust Bunny"; the option "Circled the exit code…";
//     the scene summary's "earning a fate point".
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { sheetWithNeutralNouns, repairChildNouns, type PronounMember } from '../src/server/pronoun-consistency.js';
import {
  actorPicksUp, isItemLikeName, isSilentThing, withoutEchoedAction, tidyQuotes, withoutTheAfterArticle,
  optionsInPresent, withoutMechanics,
} from '../src/server/narrative-guards.js';
import { withoutStrayScript } from '../src/server/stray-script.js';
import { validationFeedbackAsShown } from '../src/server/agents/dm.js';

const LIZ: PronounMember = { name: 'Liz', pronouns: 'she/her', relationships: [{ to: 'Biz', relation: 'kid', address: 'Biz' }] };
const BIZ: PronounMember = { name: 'Biz', pronouns: 'they/them', relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }] };

const LIZ_BACKSTORY = "A tired but dedicated mother from Ohio who has spent her career balancing books and her son's needs. She arrived in the Municipal District of Unfinished Business with her 10-year-old, Biz, holding a form that marks them both as 'Pending' and 'Lost'.";

describe('1. the generated sheet: a they/them kid is never "her son"', () => {
  it('Liz\'s live backstory: "her son\'s needs" → "her kid\'s needs"', () => {
    const sheet = { name: 'Liz', backstory: LIZ_BACKSTORY, personality: 'Calm and protective of her son.', aspects: ['Her son is her compass'] };
    const out = sheetWithNeutralNouns(sheet, [LIZ, BIZ]);
    expect(out.backstory).toContain("balancing books and her kid's needs");
    expect(out.backstory).not.toMatch(/\bson\b/);
    expect(out.personality).toBe('Calm and protective of her kid.');
    expect(out.aspects).toEqual(['Her kid is her compass']);
  });

  it('the owner\'s own "my son" in first person too', () => {
    const out = sheetWithNeutralNouns({ name: 'Liz', aspects: ['My son comes first'] }, [LIZ, BIZ]);
    expect(out.aspects).toEqual(['My kid comes first']);
  });

  it('left as written: a son the sheet owner has elsewhere, a he/him child, or someone else\'s son', () => {
    const lizTwo: PronounMember = { ...LIZ, relationships: [...LIZ.relationships!, { to: 'Tom', relation: 'son' }] };
    expect(sheetWithNeutralNouns({ name: 'Liz', backstory: 'She misses her son.' }, [lizTwo, BIZ]).backstory).toBe('She misses her son.');
    const bizHe: PronounMember = { ...BIZ, pronouns: 'he/him' };
    expect(sheetWithNeutralNouns({ name: 'Liz', backstory: 'She raises her son.' }, [LIZ, bizHe]).backstory).toBe('She raises her son.');
    // "his son" is not Liz's (she/her).
    expect(sheetWithNeutralNouns({ name: 'Liz', backstory: 'Her boss praised his son.' }, [LIZ, BIZ]).backstory).toBe('Her boss praised his son.');
  });

  it('DM prose without an owner keeps the old rule: "her son" alone, with nobody named, is left', () => {
    expect(repairChildNouns('She looks at her son.', [LIZ, BIZ])).toBe('She looks at her son.');
  });
});

describe('2. items: the actor picks up a thing lying here', () => {
  const SWEEP = 'Liz lunges, her body a blur of efficient motion as she snags the tote bag’s strap with one hand while the other sweeps a frantic arc across the tilting glass, catching the scattered bottle caps with a satisfying, metallic clatter. The bag is secured against her hip, but in her rush, the brass clip slips from her grasp and tumbles into the dark grate, vanishing into the humming dark with a faint, resonant ping.';

  it('the live sweep: "catching the scattered bottle caps" picks up the world\'s "Bottle cap"', () => {
    expect(actorPicksUp(SWEEP, 'Liz', ['Bottle cap'])).toEqual(['Bottle cap']);
  });

  it('plain pick-ups, singular or plural, by name or by pronoun after the name', () => {
    expect(actorPicksUp('Liz scoops up the bottle cap.', 'Liz', ['Bottle caps'])).toEqual(['Bottle caps']);
    expect(actorPicksUp('Biz kneels and picks up the brass button, grinning.', 'Biz', ['Brass Button'])).toEqual(['Brass Button']);
    expect(actorPicksUp('Liz bends down, and she gathers the scattered caps into her palm.', 'Liz', ['Bottle cap'])).toEqual(['Bottle cap']);
  });

  it('not a pick-up: a miss, a try, someone else, or a thing never named', () => {
    expect(actorPicksUp('Liz tries to catch the bottle cap, but it rolls into the grate.', 'Liz', ['Bottle cap'])).toEqual([]);
    expect(actorPicksUp('Liz lunges but misses the bottle cap.', 'Liz', ['Bottle cap'])).toEqual([]);
    expect(actorPicksUp('Liz watches as Mabel scoops up the bottle cap.', 'Liz', ['Bottle cap'])).toEqual([]);
    expect(actorPicksUp('Mabel scoops up the bottle cap while Liz waits.', 'Liz', ['Bottle cap'])).toEqual([]);
    expect(actorPicksUp('Liz scoops up the tote bag.', 'Liz', ['Bottle cap'])).toEqual([]);
    expect(actorPicksUp('"I will catch the bottle cap," Liz says.', 'Liz', ['Bottle cap'])).toEqual([]);
  });

  it('furniture and fixtures are things, not NPCs, unless they speak or act', () => {
    for (const n of ['Card Door', 'Filing Cabinets', 'The Brass Drawer', 'Oak Desk', 'The Wobbly Chair', 'Window Four', 'The Mirror', 'Supply Cupboard']) {
      expect([n, isItemLikeName(n)]).toEqual([n, true]);
    }
    expect(isSilentThing('Card Door', 'The Card Door stands closed at the end of the hall.')).toBe(true);
    expect(isSilentThing('Card Door', 'The Card Door sighs and says, "Knock first."')).toBe(false);
    expect(isItemLikeName('Mabel')).toBe(false);
    expect(isItemLikeName('The Dust Bunny')).toBe(false);
  });
});

describe('3. text', () => {
  it('stray CJK and other non-Latin script comes out of English, spacing tidied', () => {
    expect(withoutStrayScript('Sharply瞪 The Pigeon, demanding it explain why the code is failing.')).toBe('Sharply The Pigeon, demanding it explain why the code is failing.');
    expect(withoutStrayScript('Liz 看着 the clerk.')).toBe('Liz the clerk.');
    expect(withoutStrayScript('The clerk sighs — привет — and stamps it。')).toBe('The clerk sighs — and stamps it.');
    expect(withoutStrayScript('{"a":"Hold 住 the form"}')).toBe('{"a":"Hold the form"}');
  });
  it('Latin letters with accents, dashes, ×, curly quotes and emoji stay', () => {
    const s = 'José’s café — Bottle caps ×2 “ok” ✨';
    expect(withoutStrayScript(s)).toBe(s);
  });

  const ACTION = 'Slip a second bottle cap into Mom\'s tote bag pocket while asking Mabel about the bow tie knot.';
  const RULING = 'Biz slips a second bottle cap into the tote bag pocket and asks, "Mabel, if the knot is wrong, how do we know the right one? Mom, hold the form flat so it doesn\'t turn into a bird again." Liz’s hand tightens on the Mismatched Form, flattening the paper with a protective grip.';
  it('the echo stripper never leaves half a quote: the whole echoed quote goes', () => {
    const out = withoutEchoedAction(RULING, ACTION);
    expect(out).toBe('Liz’s hand tightens on the Mismatched Form, flattening the paper with a protective grip.');
  });
  it('the echo stripper leaves a ruling that does not echo the action', () => {
    const r = 'The drawer groans. Mabel laughs.';
    expect(withoutEchoedAction(r, ACTION)).toBe(r);
  });
  it('a ruling that opens mid-quote loses the fragment', () => {
    expect(tidyQuotes('Liz, hold the form flat so it doesn\'t turn into a bird again." Liz’s hand tightens on the form.'))
      .toBe('Liz’s hand tightens on the form.');
    expect(tidyQuotes('hold it flat.” Liz nods.')).toBe('Liz nods.');
    // A whole quote is left alone.
    expect(tidyQuotes('"Hold it flat," Mabel says.')).toBe('"Hold it flat," Mabel says.');
  });

  it('"The" in an NPC\'s name after an article or adjective goes', () => {
    expect(withoutTheAfterArticle('A small, velvety The Dust Bunny trotted out.')).toBe('A small, velvety Dust Bunny trotted out.');
    expect(withoutTheAfterArticle('She pats the The Pigeon.')).toBe('She pats the Pigeon.');
    expect(withoutTheAfterArticle('a grumpy The Pigeon')).toBe('a grumpy Pigeon');
    // A verb between is not an adjective; the name keeps its "The".
    expect(withoutTheAfterArticle('The clerk watches The Pigeon.')).toBe('The clerk watches The Pigeon.');
    expect(withoutTheAfterArticle('The Dust Bunny sneezes.')).toBe('The Dust Bunny sneezes.');
  });

  it('options are in the present: a past-tense option is put in the present, or dropped', () => {
    const out = optionsInPresent([
      { description: 'Circled the exit code in blue ink while asking Mabel for the pen cap.' },
      { description: 'I grabbed the brass clip.' },
      { description: 'Tried the door again.' },
      { description: 'Ask The Pigeon to clarify the queue shift.' },
    ]);
    expect(out.map(o => o.description)).toEqual([
      'Circle the exit code in blue ink while asking Mabel for the pen cap.',
      'I grab the brass clip.',
      'Try the door again.',
      'Ask The Pigeon to clarify the queue shift.',
    ]);
  });
  it('an unsure past tense is dropped while others remain, and never empties the list', () => {
    expect(optionsInPresent([{ description: 'Hoped the clerk would listen.' }, { description: 'Ask Mabel.' }]).map(o => o.description)).toEqual(['Ask Mabel.']);
    expect(optionsInPresent([{ description: 'Hoped the clerk would listen.' }]).map(o => o.description)).toEqual(['Hoped the clerk would listen.']);
    // Not a verb: a name, an adjective start, "Need".
    expect(optionsInPresent([{ description: 'Red ink on the form — point it out.' }, { description: 'Need a minute.' }]).map(o => o.description))
      .toEqual(['Red ink on the form — point it out.', 'Need a minute.']);
  });

  it('the live scene summary loses "earning a fate point"', () => {
    const s = 'As the Mismatched Form began to warp, Liz firmly held Biz back from chasing the shiny object, earning a fate point and Mabel\'s approval for their steady hands. The Card Door finally groaned open.';
    const out = withoutMechanics(s);
    expect(out).not.toMatch(/fate point/i);
    expect(out).toContain('Liz firmly held Biz back from chasing the shiny object.');
    expect(out).toContain('The Card Door finally groaned open.');
  });
});

describe('1. the approval message', () => {
  it('a gentle table never hears "horror"; a player character is never an NPC', () => {
    const horror = validationFeedbackAsShown('The character fits the tone of a grounded, bureaucratic horror campaign where an ordinary person is thrust into an uncanny administrative nightmare.', { gentlePeril: true });
    expect(horror).not.toMatch(/horror|nightmare|uncanny/i);
    expect(horror.trim()).not.toBe('');
    const npc = validationFeedbackAsShown('The character fits the world perfectly as a child companion or NPC, with a clear emotional anchor and appropriate skill set for their age and concept.', { gentlePeril: true });
    expect(npc).not.toMatch(/\bNPC\b|companion/i);
    expect(npc.trim()).not.toBe('');
  });
  it('fine feedback is left as written; "horror" at a table that asked for it stays', () => {
    const ok = 'A warm, resourceful mom who fits the gentle bureaucracy well.';
    expect(validationFeedbackAsShown(ok, { gentlePeril: true })).toBe(ok);
    const h = 'Fits this grim horror campaign.';
    expect(validationFeedbackAsShown(h, { gentlePeril: false })).toBe(h);
  });
});
