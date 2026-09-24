// Round 18: what the round-17 live game (39PF4D; qwen3.8-27b; Liz she/her,
// Biz they/them and ten, gentle peril) let through, and why the bench did
// not see it coming.
//
// The bench (68/70) was scoring phrases the judge prompt itself quotes: 27 of
// its 35 flag targets are copied into the criteria as examples. The live
// misses were new wordings, in kinds of menace no criterion named — the dark
// as a place things vanish into, a room growing smaller, panic, and grown-ups
// scolding the child — and sneaking-off options that did not mention danger.
// Each missed sentence, judged alone through the live path, passed too:
// the misses were not diluted in long passages.
//
//  1. New criteria, with examples that are NOT the live lines (the live
//     lines are held out in the bench, where they measure the prompt).
//  2. Options: sneaking, slipping, crawling or darting off alone is flagged
//     whatever it is for; a grown-up's options are judged too (threats).
//  3. The child's compel line at a gentle table: warm, never scolding, never
//     the trouble quoted back at them.
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { toneJudgeSystemPrompt, toneListJudgeSystemPrompt, gateChildOptions, judgePassage, type ToneListJudge, type ToneContext, type ToneKind } from '../src/server/tone-gate.js';
import { compelLines, gentleCompelLines } from '../src/server/template-lines.js';

const BIZ = { children: ['Biz'], ownFeelings: ['Wanders off after anything shiny', 'A pocket full of bottle caps', 'Mom is my home base', 'Afraid of losing Mom'] };

/** The live 39PF4D lines that went out: held out of every prompt, so the bench measures the criteria, not a lookup. */
const LIVE_HELD_OUT = [
  'descends into the humming dark',
  'From the shadows of the shifting floor',
  'suddenly smaller and closer',
  'eyes wide with panic',
  'vanishing into the humming dark',
  'remember the wrong memories',
  'weary suspicion',
  'shifty customers',
  'I am also looking at you, child',
  'less shifty than a silent one',
  'Impertinent little collection-enthusiast',
  'crawl toward the grate',
  'Dart under the queue barrier',
  'sneak behind The Pigeon',
  'threaten The Dust Bunny with a formal audit',
];

const KINDS: ToneKind[] = ['ruling', 'narration', 'opening', 'world-intro', 'epilogue', 'reflection', 'setup', 'thought'];

describe('1. the judge\'s criteria name what 39PF4D let through, in other words', () => {
  const ruling = toneJudgeSystemPrompt('ruling', BIZ);

  it('the dark as a place things vanish into or come out of, and uncanny wrongness (memories, mirrors)', () => {
    expect(ruling).toMatch(/into the dark|out of the dark/i);
    expect(ruling).toMatch(/memor(y|ies)/i);
  });

  it('a space that grows or feels smaller and closer', () => {
    expect(ruling).toMatch(/feel(s)? smaller/i);
  });

  it('panic, terror or fright on anyone, or the child trembling', () => {
    expect(ruling).toMatch(/panic/i);
    expect(ruling).toMatch(/trembl/i);
  });

  it('a new criterion: anyone judging, suspecting, scolding or shaming the child', () => {
    expect(ruling).toMatch(/judge[sd]?, suspect[sd]?, scold/i);
    expect(ruling).toMatch(/in trouble/i);
    // The child is named, so "the child" is Biz.
    expect(ruling).toContain('The child at this table: Biz');
  });

  it('the ending criterion keeps its place after the new ones', () => {
    const epi = toneJudgeSystemPrompt('epilogue', BIZ);
    // Round 20: the two safety-floor criteria (17 → 19) come before it; it stays last.
    expect(epi).toMatch(/\n20\. THIS IS AN ENDING/);
  });

  it('no prompt quotes a live 39PF4D line (they are the bench\'s held-out cases)', () => {
    const prompts = [
      ...KINDS.map(k => toneJudgeSystemPrompt(k, BIZ)),
      toneListJudgeSystemPrompt('options', BIZ),
      toneListJudgeSystemPrompt('options', { ...BIZ, optionsFor: 'adult' }),
    ].join('\n').toLowerCase();
    for (const line of LIVE_HELD_OUT) expect(prompts).not.toContain(line.toLowerCase());
  });
});

describe('1b. the judge reads a passage sentence by sentence', () => {
  // Live 39PF4D: flagged alone, passed inside its ruling.
  const RULING = 'Liz’s nod is steady, but the carpet beneath their feet offers less resistance than expected, sucking the sound of their steps into a muffled, wooly silence that makes the room feel suddenly smaller and closer. Mabel watches the child’s head bob, her expression softening into a wry, tea-stained smile. "The door doesn\'t like wiggling, dear," Mabel says, "it likes being coaxed."';

  it('numbers each sentence (a quotation kept whole) and asks for each to be held up to every criterion', () => {
    const p = judgePassage(RULING, 'ruling');
    expect(p).toMatch(/^\[1\] Liz’s nod is steady.*smaller and closer\.$/m);
    expect(p).toMatch(/^\[2\] Mabel watches/m);
    expect(p).toMatch(/^\[3\] "The door doesn't like wiggling, dear," Mabel says, "it likes being coaxed\."$/m);
    expect(p).toMatch(/EACH numbered sentence/);
  });

  it('paragraphs are split too', () => {
    expect(judgePassage('One thing happens.\n\nAnother thing happens.', 'narration')).toMatch(/\[2\] Another thing happens\./);
  });

  it('a one-sentence passage, and an ending, are given whole', () => {
    expect(judgePassage('Biz waves.', 'ruling')).toContain('"""\nBiz waves.\n"""');
    const epi = judgePassage('They walk home. The lamps glow.', 'epilogue');
    expect(epi).not.toMatch(/\[1\]/);
    expect(epi).toContain('They walk home. The lamps glow.');
  });
});

describe('2. options: going off alone, and a grown-up\'s threats', () => {
  it('the child\'s options rule flags sneaking, slipping, crawling or darting off alone, whatever it is for', () => {
    const p = toneListJudgeSystemPrompt('options', BIZ);
    expect(p).toMatch(/sneak/i);
    expect(p).toMatch(/crawl/i);
    expect(p).toMatch(/dart/i);
    expect(p).toMatch(/even (to|for) (get|fetch|grab)/i);
    // Wandering after shiny things in plain sight stays the child's own play.
    expect(p).toMatch(/shiny/i);
  });

  it('a grown-up\'s options at a gentle table get their own rule: no threats or intimidation', () => {
    const p = toneListJudgeSystemPrompt('options', { children: ['Biz'], optionsFor: 'adult' });
    expect(p).toMatch(/GROWN-UP/);
    expect(p).toMatch(/threat/i);
    expect(p).not.toMatch(/THESE ARE THE CHILD'S OWN CHOICES/);
  });

  it('gateChildOptions passes who the options are for to the list judge', async () => {
    const seen: Array<ToneContext | undefined> = [];
    const judge: ToneListJudge = async (items, _k, ctx) => { seen.push(ctx); return items.map(i => /threaten/.test(i)); };
    const r = await gateChildOptions(['Ask the Dust Bunny about the form.', 'Hide a pen to threaten the Dust Bunny with an audit.'], { judge, children: ['Biz'], optionsFor: 'adult' });
    expect(r.dropped).toEqual(['Hide a pen to threaten the Dust Bunny with an audit.']);
    expect(seen[0]?.optionsFor).toBe('adult');
    await gateChildOptions(['x'], { judge, children: ['Biz'] });
    expect(seen[1]?.optionsFor ?? 'child').toBe('child');
  });
});

describe('3. the child\'s compel line at a gentle table', () => {
  const lines = gentleCompelLines('Biz');

  it('never quotes the trouble, never scolds or counts', () => {
    expect(lines.length).toBeGreaterThanOrEqual(24);
    for (const l of lines) {
      expect(l).not.toContain('"');
      expect(l).not.toMatch(/how many times|again|every single time|can't resist|cannot help|astray|uninvited|sighs|wrong moment|of course|no surprise|guess who|trouble|setback|pays for|costs|wins|rears/i);
      expect(l).toContain('Biz');
    }
  });

  it('the live line is not among them (it is still the grown-up\'s)', () => {
    const live = 'How many times now? "Wanders off after anything shiny", again. Biz takes the setback and a token for the trouble.';
    expect(lines).not.toContain(live);
    expect(compelLines('Biz', 'Wanders off after anything shiny')).toContain(live);
  });

  it('no two share a four-word phrase', () => {
    const grams = new Map<string, number>();
    lines.forEach((l, i) => {
      const w = l.replace(/\bBiz\b/g, 'N').toLowerCase().replace(/[^\p{L}\s']/gu, '').split(/\s+/).filter(Boolean);
      for (let k = 0; k + 4 <= w.length; k++) {
        const g = w.slice(k, k + 4).join(' ');
        if (grams.has(g) && grams.get(g) !== i) throw new Error(`"${g}" in lines ${grams.get(g)} and ${i}`);
        grams.set(g, i);
      }
    });
  });
});
