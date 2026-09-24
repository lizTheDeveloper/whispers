// Round 17: what the round-16 live game (5YHBZS; qwen3.8-27b; Liz she/her,
// Biz they/them and ten, Biz calls Liz "Mom", gentle peril; Biz's aspect
// "Afraid of losing Mom") got wrong. Each block quotes the live line.
//  1. The thought gate cut Biz's OWN fear of losing Mom (four times), and
//     two cuts broke what was left ("I need to keep her grounded…" with no
//     "her"; the survivor was the outside menace).
//  2. World menace the judge let through (a twisting shadow, a hawk and a
//     mouse, a shrinking pocket, "into their bones", "trapped here").
//  3. Options that sneak the child away from Mom toward danger.
//  4. An unsettled epilogue and an odd last reflection (judge criteria).
//  5. Mechanics: "I will use my Rapport…", "I use my Notice skill to recall…".
//  6. Text: "Dad a bottle cap to Mom", the stock compel closer, memories
//     that swap who did what and end on "which revealed…".
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  toneJudgeSystemPrompt, gateChildThought, withoutFlaggedPhrases, isOwnFear, softenOwnFear, toneFeedback, toneListJudgeSystemPrompt,
  type ToneJudge,
} from '../src/server/tone-gate.js';
import { softenForChildren, withoutMechanics, repairKinWordAsVerb, withoutCharacterReading, mechanicTerms } from '../src/server/narrative-guards.js';
import { compelLines, LineRotation } from '../src/server/template-lines.js';

const BIZ = { children: ['Biz'], ownFeelings: ['Afraid of losing Mom', 'Mom is my home base', 'Wanders off after anything shiny'], people: [{ word: 'Mom', pronoun: 'she' as const }, { word: 'Liz', pronoun: 'she' as const }] };

// ─── 1. The child's own feelings are theirs ─────────────────────────────────

const OWN_FEARS = [
  "I'm not scared of the bird, but I'm terrified of losing track of Mom in this lavender fog.",
  'I am scared of losing Mom if I wander off after the button while the door is sealed, so I keep my eyes on the exit and my hand on hers.',
  'The voice wants me to pocket the Brass Button, but that shiny thing just pulled my focus from the fern last time and I’m too scared to lose Mom again.',
  'The voice tells me to hum for the Door, but I’m too scared of losing Mom to stand there making noise while the humidity turns everything to soup.',
];

describe('1. the thought gate keeps the child\'s own fears', () => {
  it('the judge is told the child\'s own feelings are fine in a thought, with the live lines as examples, and the sheet\'s feelings', () => {
    const p = toneJudgeSystemPrompt('thought', BIZ);
    expect(p).toMatch(/CHILD.S OWN THOUGHT/);
    expect(p).toContain("I'm too scared to lose Mom again");
    expect(p).toContain('terrified of losing track of Mom');
    expect(p).toContain('"Afraid of losing Mom"');
    // Criterion 2 is the WORLD parting them; the child's worry is no longer an example of it.
    expect(p).not.toContain("I'm scared of being separated from her");
    expect(toneJudgeSystemPrompt('ruling', BIZ)).toMatch(/2\. has the WORLD separate the child from their grown-up/);
  });

  it('isOwnFear: a first-person fear about the grown-up, getting lost or the sheet\'s own feeling; not a fear of a menace', () => {
    for (const t of OWN_FEARS) expect(isOwnFear(t, BIZ)).toBe(true);
    expect(isOwnFear('I notice the shadow beneath the banister is twisting right toward us.', BIZ)).toBe(false);
    expect(isOwnFear("I'm scared the shadow will grab me.", BIZ)).toBe(false);
    expect(isOwnFear('Mom is scared of the shelf.', BIZ)).toBe(false);
  });

  it('softenOwnFear lowers the pitch and keeps the feeling', () => {
    expect(softenOwnFear(OWN_FEARS[0]!)).toBe("I'm not scared of the bird, but I'm worried about losing track of Mom in this lavender fog.");
    expect(softenOwnFear(OWN_FEARS[2]!)).toBe(OWN_FEARS[2]);
    expect(softenOwnFear("I'm petrified Mom will get lost.")).toBe("I'm worried Mom will get lost.");
  });

  it('a flagged own fear is softened, never removed (the four live thoughts)', async () => {
    // The live judge flagged each of these; the gate must not cut them.
    const judge: ToneJudge = async (text) => {
      const m = text.match(/(?:terrified of losing track of Mom|I am scared of losing Mom if I wander off after the button while the door is sealed|I’m too scared to lose Mom again|I’m too scared of losing Mom)/);
      return m ? { flagged: true, phrases: [m[0]] } : { flagged: false, phrases: [] };
    };
    expect(await gateChildThought(OWN_FEARS[0]!, { judge, ...BIZ })).toBe("I'm not scared of the bird, but I'm worried about losing track of Mom in this lavender fog.");
    for (const t of OWN_FEARS.slice(1)) expect(await gateChildThought(t, { judge, ...BIZ })).toBe(t);
  });

  it('the judge is given the child\'s own feelings (ctx.ownFeelings)', async () => {
    const seen: any[] = [];
    const judge: ToneJudge = async (_t, _k, ctx) => { seen.push(ctx); return { flagged: false, phrases: [] }; };
    await gateChildThought('I hold Mom\'s hand.', { judge, ...BIZ });
    expect(seen[0].ownFeelings).toEqual(BIZ.ownFeelings);
  });

  it('world menace in the thought still goes: the twisting shadow is cut, the child\'s fear stays', async () => {
    const live = "The voice tells me to hum for the Door, but I’m too scared of losing Mom to stand there making noise. I notice the shadow beneath the banister is twisting right toward us, and I need to keep my eyes on that danger.";
    const judge: ToneJudge = async () => ({ flagged: true, phrases: ['I’m too scared of losing Mom', 'the shadow beneath the banister is twisting right toward us'] });
    expect(await gateChildThought(live, { judge, ...BIZ })).toBe('The voice tells me to hum for the Door, but I’m too scared of losing Mom to stand there making noise.');
  });

  it('a removal that leaves a dangling pronoun at the start: repaired with the name', () => {
    const t = 'Mom keeps staring at the shadow twisting toward us. I need to keep her grounded because the ribbon is tugging.';
    const r = withoutFlaggedPhrases(t, ['the shadow twisting toward us'], { people: BIZ.people });
    expect(r.text).toBe('I need to keep Mom grounded because the ribbon is tugging.');
    const poss = withoutFlaggedPhrases('Mom stares at the twisting shadow. I hold her hand tight.', ['the twisting shadow'], { people: BIZ.people });
    expect(poss.text).toBe("I hold Mom's hand tight.");
    const she = withoutFlaggedPhrases('Mom stares at the twisting shadow. She looks tired.', ['the twisting shadow'], { people: BIZ.people });
    expect(she.text).toBe('Mom looks tired.');
  });

  it('…or, with no name to repair it with, the removal is dropped', () => {
    const t = 'The shadow creeps toward the clerk. I need to keep him calm.';
    const r = withoutFlaggedPhrases(t, ['The shadow creeps toward the clerk'], { people: BIZ.people });
    expect(r.text).toBe(t);
    expect(r.kept).toEqual(['The shadow creeps toward the clerk']);
  });

  it('a pronoun with its referent still in the text is left alone', () => {
    const t = 'I hold Mom\'s hand. The shadow twists toward us. I need to keep her grounded.';
    expect(withoutFlaggedPhrases(t, ['The shadow twists toward us'], { people: BIZ.people }).text).toBe("I hold Mom's hand. I need to keep her grounded.");
  });

  it('the round-16 separation softener now only softens the WORLD parting them, never the child\'s own worry', () => {
    const own = "I'm staying close to Mom because the latch just clicked shut and I'm scared of being separated from her in this dark aisle.";
    expect(softenForChildren(own)).toBe(own);
    expect(softenForChildren('"Step lively, or the queue will separate you from your mother," the clerk warns.'))
      .toBe('"Step lively, or the queue will keep you waiting a moment," the clerk warns.');
  });
});

// ─── 2. World menace ────────────────────────────────────────────────────────

describe('2. world menace: judge criteria and the softener floor', () => {
  const p = toneJudgeSystemPrompt('narration', BIZ);
  it.each([
    'The shadow beneath the ribbon stretches unnaturally long, twisting toward the center of the room',
    'with the intensity of a hawk spotting a mouse',
    'trapping the pair in a shrinking pocket of dry air',
    'keep them both perfectly safe from whatever grows in the shadows',
    'vibrates through the floorboards and into their bones',
    'We are trapped here with the paperwork',
  ])('the judge has the live line "%s"', (line) => {
    expect(p).toContain(line);
  });

  it.each([
    ["The kid points a shaking finger at the Red Ribbon Banister, where the fabric pulls taut with a low, creaking hum that vibrates through the floorboards and into their bones.",
      'The kid points a shaking finger at the Red Ribbon Banister, where the fabric pulls taut with a low, creaking hum that vibrates through the floorboards.'],
    ['Mistress Prune lowers her teacup with a slow, deliberate clink, her gaze snapping to the ribbon with the intensity of a hawk spotting a mouse.',
      'Mistress Prune lowers her teacup with a slow, deliberate clink, her gaze snapping to the ribbon with sharp interest.'],
    ['The Opaline Desk slides another six inches to the left, trapping the pair in a shrinking pocket of dry air.',
      'The Opaline Desk slides another six inches to the left, leaving the pair in a small pocket of dry air.'],
    ['She tightens her grip, with the fierce need to keep them both perfectly safe from whatever grows in the shadows.',
      'She tightens her grip, with the fierce need to keep them both perfectly safe from the muddle.'],
    ['Mom, the door is stuck. We are trapped here with the paperwork.', 'Mom, the door is stuck. We are stuck here for a moment with the paperwork.'],
    ['The shadow beneath the ribbon stretches unnaturally long, twisting toward the center of the room.', 'The shadow beneath the ribbon stretches long across the room.'],
  ])('softened: %s', (text, want) => {
    expect(softenForChildren(text)).toBe(want);
  });

  it('left alone: an ordinary shadow, a cozy small room, a hawk that is just a hawk', () => {
    for (const t of ['The lamp throws a long shadow of the fern across the desk.', 'The cupboard is small and cozy, just big enough for two.', 'A brass hawk sits on the shelf, polishing its beak.', 'The trap door in the hall creaks open.', 'The realization settles into her bones.']) {
      expect(softenForChildren(t)).toBe(t);
    }
  });

  it('the second draft is told about shadows, predators and shrinking spaces', () => {
    expect(toneFeedback(['x'], 'narration')).toMatch(/creeping shadows/);
    expect(toneFeedback(['x'], 'narration')).toMatch(/predator/);
    expect(toneFeedback(['x'], 'narration')).toMatch(/shrinking/);
  });
});

// ─── 3. Options that sneak the child away from their grown-up ───────────────

describe('3. the options judge: sneaking away toward danger is flagged, wandering after shiny things is not', () => {
  it('the list judge\'s prompt has both, with the live lines, and the child\'s own trouble', () => {
    const system = toneListJudgeSystemPrompt('options', BIZ);
    expect(system).toContain('Slip through the humming oak door before Mom can stop me');
    expect(system).toContain('to check the twisting shadow');
    expect(system).toContain('wander after the shiny button');
    expect(system).toMatch(/Wanders off after anything shiny/);
    expect(system).toMatch(/\{"flag":\[2,4\]\}/);
    expect(system).not.toMatch(/"verdict"/);
  });
});

// ─── 4. Endings ─────────────────────────────────────────────────────────────

describe('4. endings: the last paragraph calm and settled; no odd last jab', () => {
  it('the epilogue criteria name the live unsettled images', () => {
    const p = toneJudgeSystemPrompt('epilogue', BIZ);
    expect(p).toContain('shrinking pocket of dry air');
    expect(p).toContain('Clerk Bumble trembles');
    expect(p).toContain('mood swinging wildly');
    expect(p).toMatch(/LAST PARAGRAPH/);
  });
  it('the reflection criteria name the live odd reflection', () => {
    expect(toneJudgeSystemPrompt('reflection', BIZ)).toContain('because I certainly did not');
  });
});

// ─── 5. Mechanics ───────────────────────────────────────────────────────────

describe('5. no skill, aspect, stunt or roll as a mechanic in a character\'s words', () => {
  const LIZ = { skills: ['Investigate', 'Rapport', 'Will', 'Notice', 'Finance'], aspects: ['Tote bag contains a pen', 'Tired but Resourceful', 'Resourceful Accountant'], stunts: ['Fine Print - once per scene I can find a loophole in any form'] };
  const BIZ_SHEET = { skills: ['Notice', 'Stealth', 'Athletics', 'Rapport'], aspects: ['A pocket full of bottle caps', 'Mom is my home base', 'Afraid of losing Mom'], stunts: ['Tiny and Quick — slips through gaps grown-ups can\'t'] };

  it('the sheet\'s terms: skills, aspects and stunt names', () => {
    expect(mechanicTerms(LIZ).stunts).toEqual(['Fine Print']);
    expect(mechanicTerms(BIZ_SHEET).stunts).toEqual(['Tiny and Quick']);
  });

  it.each([
    ['Mistress Prune just appeared and seems to be the authority here, so I will use my Rapport to establish a line of communication while keeping Biz close.', LIZ,
      'Mistress Prune just appeared and seems to be the authority here, so I will establish a line of communication while keeping Biz close.'],
    ['I noticed Bumble is too scared to check his clipboard, so I use my Notice skill to recall the date I saw written on the fern waiver earlier.', BIZ_SHEET,
      'I noticed Bumble is too scared to check his clipboard, so I recall the date I saw written on the fern waiver earlier.'],
    ['I use my Fine Print to find the clause allowing oral date corrections.', LIZ, 'I find the clause allowing oral date corrections.'],
    ['I read the form with my Investigate skill.', LIZ, 'I read the form.'],
    ["I lean on my 'Mom is my home base' aspect and stay put.", BIZ_SHEET, ''],
    ['I stay close to Mom. I hope I get a good roll on this one.', BIZ_SHEET, 'I stay close to Mom.'],
    ['I keep calm, but I need to roll the dice well.', LIZ, 'I keep calm.'],
  ])('"%s"', (text, sheet, want) => {
    expect(withoutMechanics(text, sheet)).toBe(want);
  });

  it('left alone: the plain words that share a skill\'s name, a bottle cap that rolls, every aspect of the form', () => {
    for (const t of [
      'I notice the ink is still wet.', 'The bottle cap rolls under the desk.', 'I roll my eyes at the fern.', 'Against my will, I giggle.',
      'I check every aspect of the form.', 'I will use my pen to sign it.', 'I call on all my patience.',
    ]) expect(withoutMechanics(t, LIZ)).toBe(t);
  });
});

// ─── 6. Text ────────────────────────────────────────────────────────────────

describe('6a. "Dad a bottle cap to Mom": a kin word in the verb slot of an action', () => {
  it.each([
    ['Dad a bottle cap to Mom and watch the fern grow while holding the form.', 'Hand a bottle cap to Mom and watch the fern grow while holding the form.'],
    ['I Mom the pen to Clerk Bumble.', 'I hand the pen to Clerk Bumble.'],
  ])('%s', (text, want) => {
    expect(repairKinWordAsVerb(text)).toBe(want);
  });
  it.each([
    'Hand a bottle cap to Mom and watch the fern grow.',
    'Mom, the pen goes to Clerk Bumble.',
    'Dad and I hand the pen to Clerk Bumble.',
    'Squeeze Mom\'s hand and hand the pen to Clerk Bumble.',
  ])('left alone: %s', (text) => {
    expect(repairKinWordAsVerb(text)).toBe(text);
  });
});

describe('6b. compel closers: the stock "small mercy" line is retired and the first compel varies', () => {
  it('no compel line says the universe grants a small mercy', () => {
    for (const l of compelLines('Biz', 'Wanders off after anything shiny')) expect(l).not.toMatch(/small mercy|universe grants/);
  });
  it('still twenty-four variants, no two sharing a four-word phrase', () => {
    const lines = compelLines('Biz', 'Wanders off');
    expect(lines).toHaveLength(24);
    const grams = new Map<string, number>();
    lines.forEach((l, i) => {
      const w = l.replace(/"[^"]*"/g, 'T').replace(/\bBiz\b/g, 'N').toLowerCase().split(/\s+/);
      for (let k = 0; k + 4 <= w.length; k++) {
        const g = w.slice(k, k + 4).join(' ');
        if (grams.has(g) && grams.get(g) !== i) throw new Error(`"${g}" in lines ${grams.get(g)} and ${i}`);
        grams.set(g, i);
      }
    });
  });
  it('a seeded rotation starts somewhere else in the list, and the same seed starts in the same place', () => {
    const variants = compelLines('Biz', 'Wanders off');
    const firsts = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(seed => new LineRotation(seed).pick('compel', variants)));
    expect(firsts.size).toBeGreaterThan(1);
    expect(new LineRotation('5YHBZS').pick('compel', variants)).toBe(new LineRotation('5YHBZS').pick('compel', variants));
    // Unseeded: as before, the first variant first.
    expect(new LineRotation().pick('compel', variants)).toBe(variants[0]);
  });
  it('a seeded rotation still says every variant once before it is spent', () => {
    const variants = compelLines('Biz', 'Wanders off');
    const r = new LineRotation('5YHBZS');
    const said = variants.map(() => r.pick('compel', variants, '', { whenSpent: 'skip' }));
    expect(new Set(said).size).toBe(24);
    expect(r.pick('compel', variants, '', { whenSpent: 'skip' })).toBe('');
  });
});

describe('6c. memories: no character reading tacked on', () => {
  it.each([
    ["I saw Biz press the slick brass button on the Opaline Desk, which caused the mechanism to wobble erratically before settling, revealing their impatience and lack of fine motor control.",
      'I saw Biz press the slick brass button on the Opaline Desk, which caused the mechanism to wobble erratically before settling.'],
    ["I watched Biz lean in and whisper the specific date of the Tuesday Incident directly into Clerk Bumble's twitching nose, revealing their complete disregard for social boundaries and protocol in favor of getting the information accepted.",
      "I watched Biz lean in and whisper the specific date of the Tuesday Incident directly into Clerk Bumble's twitching nose."],
    ['I saw Biz hand me a bottle cap and hold a form steady while watching a fern grow, which revealed their gentle attentiveness and care for the small living things around them.',
      'I saw Biz hand me a bottle cap and hold a form steady while watching a fern grow.'],
    ['I watched Liz pull her pen from her tote bag and address the Opaline Desk directly, which showed me she is the one handling the formalities while I held her hand tight to stay grounded.',
      'I watched Liz pull her pen from her tote bag and address the Opaline Desk directly.'],
  ])('%s', (text, want) => {
    expect(withoutCharacterReading(text)).toBe(want);
  });
  it('left alone: a memory with no reading, and "revealing" as a plain verb', () => {
    for (const t of ['I held Mom\'s hand while the fern grew.', 'The drawer slid open, revealing a tiny brass key.']) expect(withoutCharacterReading(t)).toBe(t);
  });
});
