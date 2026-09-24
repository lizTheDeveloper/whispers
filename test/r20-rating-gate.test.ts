// Round 20: the tone gate's criteria are tagged by rating tier — the gentle
// judge is exactly as before; storybook reads the reduced set; adventure
// reads only gore and sexual content.
import { describe, it, expect } from 'vitest';
import { toneJudgeSystemPrompt, toneListJudgeSystemPrompt, toneFeedback, gateGentleTone, gateChildOptions, gateChildThought, type ToneJudge, type ToneContext } from '../src/server/tone-gate.js';
import { ratingToneRule, childToneRule, SAFETY_FLOOR, assembleSystemPrompt } from '../src/server/agents/dm.js';

const SHADOWS = 'has creepy or unexplained shadows';
const CHASED = 'has the party chased, hunted, pursued';
const SEPARATE = 'has the WORLD separate the child from their grown-up';
const BODY_HORROR = 'is body-horror about ANYONE';
const SHAME = 'has anyone judge, suspect, scold or shame THE CHILD';
const GORE = 'is graphic gore';
const SEXUAL = 'is sexual:';

describe('the judge by tier', () => {
  it('gentle (the default) holds every gentle criterion, 1–17, the two safety-floor criteria, and the ending as 20', () => {
    const p = toneJudgeSystemPrompt('epilogue', { children: ['Biz'] });
    expect(p).toContain('TONE JUDGE for a family tabletop game');
    for (const c of [SHADOWS, CHASED, SEPARATE, BODY_HORROR, SHAME]) expect(p).toContain(c);
    expect(p).toContain('17. has anyone judge');
    expect(p).toContain('18. SAFETY FLOOR — is sexual content involving a minor');
    expect(p).toContain('19. SAFETY FLOOR — is violence, injury or a threat of harm aimed at a minor');
    expect(p).toContain('20. THIS IS AN ENDING. It must close warm and resolved enough');
    expect(p).not.toContain(GORE);
    expect(toneJudgeSystemPrompt('narration', { tier: 'gentle' })).toBe(toneJudgeSystemPrompt('narration', {}));
  });

  it('storybook: only threats, harm or erasure aimed at a child, separation, body horror, gore, shaming the child — suspense is fine', () => {
    const p = toneJudgeSystemPrompt('narration', { children: ['Biz'], tier: 'storybook' });
    expect(p).toContain('storybook table, like Paddington or a Studio Ghibli film');
    for (const c of [SEPARATE, BODY_HORROR, SHAME, SEXUAL, 'threatens THE CHILD with harm', 'threatens to file, erase, delete, recycle or process THE CHILD']) expect(p).toContain(c);
    for (const c of [SHADOWS, CHASED, 'locks or seals the party in', 'shows panic, terror or fright', 'predator-and-prey', 'makes anything permanent or "forever"']) expect(p).not.toContain(c);
    expect(p).toMatch(/^1\. /m);
    expect(p).not.toContain('THIS IS AN ENDING');
  });

  it('storybook endings land hopeful, with an open thread allowed — not the gentle settled close', () => {
    const p = toneJudgeSystemPrompt('epilogue', { tier: 'storybook' });
    expect(p).toContain('may leave a thread open');
    expect(p).not.toContain('It must close warm and resolved enough');
  });

  it('adventure: gore and sexual content only', () => {
    const p = toneJudgeSystemPrompt('ruling', { children: ['Biz'], tier: 'adventure' });
    expect(p).toContain('TONE JUDGE for a teen tabletop game');
    expect(p).toContain(GORE);
    expect(p).toContain(SEXUAL);
    for (const c of [SEPARATE, BODY_HORROR, SHAME, SHADOWS, CHASED]) expect(p).not.toContain(c);
    expect(toneJudgeSystemPrompt('epilogue', { tier: 'adventure' })).not.toContain('THIS IS AN ENDING');
  });

  it('the options list at storybook keeps the child\'s adventurous play — no rule against sneaking off', () => {
    const gentle = toneListJudgeSystemPrompt('options', { children: ['Biz'] });
    const story = toneListJudgeSystemPrompt('options', { children: ['Biz'], tier: 'storybook' });
    expect(gentle).toContain('sneak, slip, creep, crawl, dart');
    expect(story).not.toContain('sneak, slip, creep, crawl, dart');
    expect(story).toContain('Brave, sneaky, curious and adventurous choices');
  });

  it('the second draft\'s feedback speaks for the tier', () => {
    expect(toneFeedback(['x'], 'narration')).toContain('A reader for this gentle table');
    expect(toneFeedback(['x'], 'narration', 'storybook')).toContain('A reader for this all-ages table');
    expect(toneFeedback(['x'], 'narration', 'storybook')).not.toContain('no creeping shadows');
    expect(toneFeedback(['x'], 'narration', 'adventure')).toContain('no graphic gore');
  });
});

describe('the gate passes the tier to its judge', () => {
  it('gateGentleTone: the judge gets the tier, and a flag regenerates with the tier\'s feedback', async () => {
    const seen: Array<ToneContext | undefined> = [];
    const judge: ToneJudge = async (text, _kind, ctx) => { seen.push(ctx); return text.includes('blood') ? { flagged: true, phrases: ['blood pools'] } : { flagged: false, phrases: [] }; };
    let feedback = '';
    const r = await gateGentleTone({
      kind: 'narration', first: 'The clerk falls; blood pools under the desk.', textOf: t => t,
      regenerate: async f => { feedback = f; return 'The clerk falls behind the desk.'; },
      soften: t => t, judge, ctx: { tier: 'storybook' },
    });
    expect(seen.every(c => c?.tier === 'storybook')).toBe(true);
    expect(feedback).toContain('all-ages table');
    expect(r.value).toBe('The clerk falls behind the desk.');
  });

  it('gateChildOptions and gateChildThought carry the tier; the thought is not softened below gentle', async () => {
    const ctxs: Array<ToneContext | undefined> = [];
    const listJudge = async (items: string[], _k: any, ctx?: ToneContext) => { ctxs.push(ctx); return items.map(() => false); };
    await gateChildOptions(['Sneak under the desk'], { judge: listJudge, children: ['Biz'], tier: 'storybook' });
    expect(ctxs[0]?.tier).toBe('storybook');
    const judge: ToneJudge = async (_t, _k, ctx) => { ctxs.push(ctx); return { flagged: false, phrases: [] }; };
    const kept = await gateChildThought('It is terrifying, and I love it.', { judge, children: ['Biz'], tier: 'storybook', soften: false });
    expect(kept).toBe('It is terrifying, and I love it.');
    expect(ctxs[1]?.tier).toBe('storybook');
    // At gentle the softener still runs first, as before.
    expect(await gateChildThought('It is terrifying, and I love it.', { judge, children: ['Biz'] })).toBe('It is unnerving, and I love it.');
  });
});

describe('the register per rating', () => {
  const party = [{ name: 'Biz', highConcept: 'Curious kid', age: 10 }, { name: 'Liz', highConcept: 'Mom' }];
  const adults = [{ name: 'Ada', highConcept: 'Smuggler' }, { name: 'Rook', highConcept: 'Knight' }];

  it('gentle is the family-table rule as before, with the safety floor', () => {
    expect(ratingToneRule('gentle', party)).toBe(`${childToneRule(party)} ${SAFETY_FLOOR}`);
    // A gentle rating with no child: the gentle-peril register.
    expect(ratingToneRule('gentle', adults)).toContain('GENTLE PERIL register');
  });

  it('storybook, adventure and mature name their register, and every one keeps the safety floor', () => {
    expect(ratingToneRule('storybook', adults)).toContain('STORYBOOK register');
    expect(ratingToneRule('adventure', adults)).toContain('ADVENTURE register');
    expect(ratingToneRule('mature', adults)).toContain('MATURE register');
    for (const r of ['storybook', 'adventure', 'mature'] as const) {
      expect(ratingToneRule(r, adults)).toContain(SAFETY_FLOOR);
      expect(ratingToneRule(r, adults)).not.toContain('GENTLE PERIL register');
    }
    expect(SAFETY_FLOOR).toMatch(/never any sexual content involving a child, a minor/);
  });

  it('a child character at a higher rating is named — the host chose it, and the floor holds', () => {
    const rule = ratingToneRule('mature', party);
    expect(rule).toContain('Biz is a child character.');
    expect(rule).toContain(SAFETY_FLOOR);
  });

  it('the system prompt carries the rating\'s register', () => {
    const base = { preset: 'chronicler', dmCustomPrompt: null, houseRules: null, dmInstructions: null, campaignMaterials: null, influences: [], party: adults };
    expect(assembleSystemPrompt({ ...base, rating: 'mature' }).systemPrompt).toContain('MATURE register');
    expect(assembleSystemPrompt({ ...base, rating: 'gentle' }).systemPrompt).toContain('GENTLE PERIL register');
    // No rating given: the pre-rating rule (nothing, for adults who did not ask).
    expect(assembleSystemPrompt(base).systemPrompt).not.toContain('CONTENT RATING');
  });
});
