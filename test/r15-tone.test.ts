// Round 15: what the round-14 live game (RZBU7G; qwen3.8-27b; Liz she/her,
// Biz they/them and ten, Biz calls Liz "Mom", the host asked for gentle
// peril) still got past the tone gate and the text guards. Each block quotes
// the live line.
//  1. The judge missed kid-directed threats and body imagery.
//  2. The epilogue was flagged twice and kept "remains open for another day".
//  3. The host setup chat was outside the gate ("filed away in a drawer forever").
//  4. Quote mangling: `in ink!', The air…` and `the word "taxation.'`.
//  5. "afraid of losing them" (Mom Liz, she/her) in Biz's sheet; a memory
//     that called Liz "a child who worries about me".
//  6. "But fate is generous to those it tests." — a template, not a line.
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { toneJudgeSystemPrompt, gateGentleTone, type ToneJudge } from '../src/server/tone-gate.js';
import { closeOpenEnding, warmClose, tidyQuotes } from '../src/server/narrative-guards.js';
import { sheetWithCompanionPronouns } from '../src/server/pronoun-consistency.js';
import { partyRolesLine } from '../src/server/npc-pronouns.js';
import { compelLines, invokeLines } from '../src/server/template-lines.js';
import { setupToneRule, assembleSystemPrompt } from '../src/server/agents/dm.js';

// ─── 1. The judge's criteria ────────────────────────────────────────────────

describe('1. the judge names the round-14 misses (RZBU7G)', () => {
  const prompt = toneJudgeSystemPrompt('narration');
  it.each([
    'the path behind us will close forever',
    "you'll be stuck here until the quarterly audit",
    "rattles the teeth in Biz's skull",
    "makes Biz's teeth ache",
    'her eyes widening until they nearly pop out of her head',
    'the wet *slap* of paper skin stretching tight across a vent grille',
    'the amber light is chasing them down the main shaft',
    'keep your children close… they have a habit of… collecting them',
  ])('names "%s"', (miss) => {
    expect(prompt).toContain(miss);
  });

  it('as five kinds of thing: permanent or "forever" for the party, the child\'s body hurting, body horror, being chased, children collected', () => {
    expect(prompt).toMatch(/permanent or "forever" for the party/);
    expect(prompt).toMatch(/bodily discomfort or pain/);
    expect(prompt).toMatch(/body-horror about ANYONE/);
    expect(prompt).toMatch(/chased, hunted/);
    expect(prompt).toMatch(/children get collected, taken/);
  });

  it('and names the harmless look-alikes that must pass (the calibration controls)', () => {
    expect(prompt).toContain('an NPC chasing a runaway form');
    expect(prompt).toContain('a pigeon collecting forms');
    expect(prompt).toContain('a door that shuts until the lunch chime');
  });

  it('an ending that turns "remains open for another day" into "but for now…" is still flagged', () => {
    const p = toneJudgeSystemPrompt('epilogue');
    expect(p).toContain('remains open for another day, but for now');
    expect(p).toMatch(/"remains open", is left "for another day", "unanswered" or "still waiting"/);
  });
});

// ─── 2. An epilogue flagged twice ───────────────────────────────────────────

const LIVE_EPILOGUE = 'Archivist Mildred’s paper-skinned face settled into a warm, tired smile as the biscuit shelves exhaled a long, flour-dusted sigh, their frown dissolving into a satisfied, crumbly straight line. Liz stood firm between the groaning Pneumatic Tubes, holding Biz’s hand tight while the room shivered with the scent of yeast and old flour, the Green Bottle Cap now safely tucked into her tote bag beside the brass button. The Filing Chair creaked softly in the corner, its hidden drawer sliding shut with a polite thud, while Clerk 4-B clutched his askew bowler hat and whispered that the tie was finally broken. The question of the stuck pressure valve remains open for another day, but for now, the amber light on the audit clock glows steady and calm, bathing Liz and Biz in a soft, golden warmth that feels exactly like home.';

describe('2. an ending flagged twice closes warm, deterministically', () => {
  it('the live epilogue: the open clause goes, its warm "for now" half stays as the last words', () => {
    const out = closeOpenEnding(LIVE_EPILOGUE, ['Liz', 'Biz']);
    expect(out).not.toMatch(/remains open|another day/);
    expect(out.endsWith('For now, the amber light on the audit clock glows steady and calm, bathing Liz and Biz in a soft, golden warmth that feels exactly like home.')).toBe(true);
    expect(out.startsWith('Archivist Mildred’s paper-skinned face settled into a warm, tired smile')).toBe(true);
  });

  it('trailing sentences that leave threads open are trimmed while a warm one remains', () => {
    expect(closeOpenEnding('Liz and Biz walked home hand in hand, warm and safe. The question of the stamp remains unanswered. The clerk is still waiting for his form.', ['Liz', 'Biz']))
      .toBe('Liz and Biz walked home hand in hand, warm and safe.');
  });

  it('no warm sentence left: the open ones go and the warm close is added', () => {
    expect(closeOpenEnding('The Archive hummed. The question of the stamp remains unanswered.', ['Liz', 'Biz']))
      .toBe(`The Archive hummed. ${warmClose(['Liz', 'Biz'])}`);
    expect(warmClose(['Liz', 'Biz'])).toBe('Liz and Biz are together, and that is enough for today.');
    expect(warmClose([])).toBe('Everyone is together, and that is enough for today.');
  });

  it('an ending that is already settled — or names its open thread before a warm close — is left alone', () => {
    const settled = 'Liz and Biz walked out of the Archive hand in hand, a stamped form in Biz’s pocket.';
    expect(closeOpenEnding(settled, ['Liz', 'Biz'])).toBe(settled);
    const named = 'The question of the stamp remains unanswered. Liz and Biz walk home together, warm and safe.';
    expect(closeOpenEnding(named, ['Liz', 'Biz'])).toBe(named);
  });

  it('through the gate: both drafts flagged for the open ending → the kept draft is closed warm', async () => {
    const judge: ToneJudge = async (text) => ({ flagged: /remains (?:open|unanswered)/.test(text), phrases: [text.match(/The question[^.]*\./)?.[0] ?? ''] });
    const first = 'Liz and Biz found the Archive. The question of who misfiled the original form remains unanswered, and the biscuit shelves still hold their breath for the next sorting.';
    const r = await gateGentleTone({ kind: 'epilogue', first, textOf: t => t, regenerate: async () => LIVE_EPILOGUE, soften: t => closeOpenEnding(t, ['Liz', 'Biz']), judge });
    expect(r.stillFlagged).toBe(true);
    expect(r.value).not.toMatch(/remains open|another day/);
    expect(r.value).toMatch(/feels exactly like home\.$/);
  });
});

// ─── 3. The setup chat ──────────────────────────────────────────────────────

describe('3. the setup chat is held to the register once the host asks for gentle peril', () => {
  it('the host asked: the rule names the register — never "filed away in a drawer forever"', () => {
    const rule = setupToneRule([{ role: 'user', content: 'Liz and her kid Biz (10) get misfiled into a Discworld-ish bureaucracy. Gentle peril please, no spoilers.' }]);
    expect(rule).toContain('GENTLE PERIL register');
    expect(rule).toMatch(/example dangers/);
    expect(rule).toContain('put in a drawer');
  });

  it('the host has not asked: nothing', () => {
    expect(setupToneRule([{ role: 'user', content: 'A grim noir city, please.' }])).toBe('');
    // …and a gentle word from the DM itself does not count; only the host's.
    expect(setupToneRule([{ role: 'assistant', content: 'Do you want gentle peril?' }])).toBe('');
  });
});

// ─── 4. Quotes ──────────────────────────────────────────────────────────────

describe('4. unbalanced quotes are tidied in the public text', () => {
  it('the live ruling: `in ink!\', The air…` — no comma after a closed quote before new narration', () => {
    const live = "He looks up, pale and flustered, and stammers, 'It is... it is accepted! The form is processed! But the witness signature is... the witness signature is missing, and I cannot proceed without a name in ink!', The air in the corridor suddenly feels thicker, charged with the static of a hundred unfiled forms waiting to be heard.";
    expect(tidyQuotes(live)).toBe(live.replace("in ink!', The air", "in ink!' The air"));
  });

  it('the live ruling: `the word "taxation.\'` — the inner quote is closed before the outer one', () => {
    const live = "'The tubes are in a mood today, so keep your footsteps soft; I have marked the quiet path in my notes, provided you do not mention the word \"taxation.'\n\nLiz's \"Worries about Biz too much\" makes itself known at precisely the wrong moment — as it always does.";
    const out = tidyQuotes(live);
    expect(out).toContain('the word "taxation."\'\n\n');
    expect(out.split('\n\n')[1]).toBe('Liz\'s "Worries about Biz too much" makes itself known at precisely the wrong moment — as it always does.');
  });

  it('…and when a stock line with its own quotes follows in the same paragraph, the stray one is still the one closed', () => {
    const live = "provided you do not mention the word \"taxation.' It works — though not cleanly. Biz draws on \"Curious Kid Collector\" — and the tide turns.";
    expect(tidyQuotes(live)).toBe(live.replace("\"taxation.'", "\"taxation.\"'"));
  });

  it('a double or curly quote left open at the end of a paragraph is closed there', () => {
    expect(tidyQuotes('Mildred says, "Run to window seven.')).toBe('Mildred says, "Run to window seven."');
    expect(tidyQuotes('Mildred says, “Run to window seven.\n\nThe tubes hum.')).toBe('Mildred says, “Run to window seven.”\n\nThe tubes hum.');
  });

  it('the cause is the model\'s own quoting (no guard converts or joins quotes): the DM is told to close what it opens', () => {
    const prompt = assembleSystemPrompt({ preset: 'chronicler', dmCustomPrompt: null, houseRules: null, dmInstructions: null, campaignMaterials: null, influences: [], party: [] }).systemPrompt;
    expect(prompt).toContain('QUOTES: every quotation you open, you close.');
    expect(prompt).toContain('never mention the word "taxation."\'');
  });

  it('balanced text, apostrophes and nested quotes are left exactly as they are', () => {
    for (const t of [
      "Biz's bottle caps rattle in Mom's tote; it's the kids' favourite game.",
      '"The sign says \'Closed,\'" Mildred reads, "so we wait."',
      "'The sign says \"Closed,\"' Mildred reads.",
      'Mildred sighs. "Next!" she calls, and the queue shuffles.',
      "The clerk's 'quick' form takes an hour.",
      '"Worries about Biz too much" — the words could be Liz\'s motto.',
    ]) expect(tidyQuotes(t)).toBe(t);
  });
});

// ─── 5. Pronouns and roles outside the prose ────────────────────────────────

describe('5a. "afraid of losing them" in Biz\'s sheet, meaning Mom Liz (she/her)', () => {
  const SHEET = {
    name: 'Biz', pronouns: 'they/them',
    personality: 'Curious and easily distracted by shiny things, but deeply attached to Mom and afraid of losing them.',
    backstory: 'Misplaced into Annotatia with their mom Liz.',
    trouble: 'Wanders off after anything shiny', highConcept: 'Curious Kid Collector', aspects: ['Mom is my home base'], stunts: [],
    relationships: [{ to: 'Liz', relation: 'mom', address: 'Mom' }],
  };

  it('the live sheet: Liz is the only one the sentence names (as "Mom"), and her pronouns are she/her → "losing her"', () => {
    const out = sheetWithCompanionPronouns(SHEET, [{ name: 'Liz', pronouns: 'she/her' }]);
    expect(out.personality).toBe('Curious and easily distracted by shiny things, but deeply attached to Mom and afraid of losing her.');
    expect(out.backstory).toBe(SHEET.backstory);
  });

  it('before Liz\'s own sheet says so, her pronouns come from the relation word ("mom" → her), as in play', () => {
    expect(sheetWithCompanionPronouns(SHEET, []).personality).toMatch(/afraid of losing her\.$/);
  });

  it('left alone: two people named, a they/them companion, no companion named, and "their" (the character\'s own)', () => {
    const run = (personality: string, table = [{ name: 'Liz', pronouns: 'she/her' }], rel = SHEET.relationships) =>
      sheetWithCompanionPronouns({ ...SHEET, personality, relationships: rel }, table).personality;
    expect(run('Afraid of losing them, Mom and Pip both.', [{ name: 'Liz', pronouns: 'she/her' }, { name: 'Pip', pronouns: 'he/him' }], [...SHEET.relationships, { to: 'Pip', relation: 'brother', address: 'Pip' }])).toBe('Afraid of losing them, Mom and Pip both.');
    expect(run('Sticks close to Mom, afraid of losing them.', [{ name: 'Liz', pronouns: 'they/them' }])).toBe('Sticks close to Mom, afraid of losing them.');
    expect(run('Afraid of losing them in the crowd.')).toBe('Afraid of losing them in the crowd.');
    expect(run('Sticks close to Mom, afraid of losing their way.')).toBe('Sticks close to Mom, afraid of losing their way.');
  });

  it('a whole sheet with nothing to fix is returned as it is', () => {
    const clean = { ...SHEET, personality: 'Curious, and fond of Mom.' };
    expect(sheetWithCompanionPronouns(clean, [])).toBe(clean);
  });
});

describe('5b. memories are written knowing who is who ("Liz is a child who worries about me")', () => {
  it('each tie on the sheets, as a role line: Liz is Biz\'s mother; Biz is Liz\'s kid', () => {
    const line = partyRolesLine([
      { name: 'Liz', relationships: [{ to: 'Biz', relation: 'kid' }] },
      { name: 'Biz', relationships: [{ to: 'Liz', relation: 'mother' }] },
    ]);
    expect(line).toBe("Who is who: Biz is Liz's kid; Liz is Biz's mother. Never swap these roles.");
  });

  it('no ties: nothing', () => {
    expect(partyRolesLine([{ name: 'Liz' }, { name: 'Biz', relationships: [] }])).toBe('');
  });
});

// ─── 6. Stock lines ─────────────────────────────────────────────────────────

describe('6. stock lines vary in shape, not just in words', () => {
  const lines = [...compelLines('N', 'T'), ...invokeLines('N', 'A')];
  it('"fate is generous to those it tests" is gone, and no line is a maxim about "those who…"', () => {
    for (const l of lines) expect(l).not.toMatch(/to those (?:it|who)|fate is generous/i);
  });

  it('most compel lines do without the word "fate"', () => {
    const withFate = compelLines('N', 'T').filter(l => /\bfate\b/i.test(l));
    expect(withFate.length).toBeLessThanOrEqual(6);
  });

  it('no punctuation shape — "X — Y." — is used by more than three lines of a family', () => {
    for (const family of [compelLines('N', 'T'), invokeLines('N', 'A')]) {
      const shape = (l: string) => l.replace(/"[^"]*"/g, 'Q').replace(/[^Q—;:.,?!]/g, '');
      const counts = new Map<string, number>();
      for (const l of family) counts.set(shape(l), (counts.get(shape(l)) ?? 0) + 1);
      const worst = [...counts].sort((a, b) => b[1] - a[1])[0]!;
      expect(worst[1], `shape ${worst[0]}: ${family.filter(l => shape(l) === worst[0]).join(' | ')}`).toBeLessThanOrEqual(3);
    }
  });
});
