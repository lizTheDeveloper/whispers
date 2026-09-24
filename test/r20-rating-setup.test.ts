// Round 20: the setup chat asks how intense the game should get, sets the
// rating from the host's answer, and never claims a rating it did not set.
// (The default rating, read off the database, is r20-rating-default.test.ts.)
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { withoutUnsetRatingClaims, ratingStatedIn } from '../src/server/content-rating.js';
import { setupRatingBlock, setupToneRule } from '../src/server/agents/dm.js';
import { DmSetupReplySchema } from '../src/server/agents/schemas.js';

describe('the setup chat and the rating', () => {
  it('asks once, naturally, while the host has not chosen; lists the levels; sets it only through contentRating', () => {
    const open = setupRatingBlock({ rating: 'storybook', explicit: false });
    expect(open).toContain('rated Storybook (a default');
    expect(open).toContain('ask how intense this should get');
    expect(open).toContain('"contentRating"');
    for (const l of ['"gentle"', '"storybook"', '"adventure"', '"mature"']) expect(open).toContain(l);
    expect(open).toContain('Never say in "reply" that the rating is or will be a level unless you set "contentRating"');
    const chosen = setupRatingBlock({ rating: 'mature', explicit: true });
    expect(chosen).toContain('rated Mature (the host chose it)');
    expect(chosen).not.toContain('ask how intense');
  });

  it('reads contentRating from the reply, and anything that is not a level as not set', () => {
    expect(DmSetupReplySchema.parse({ reply: 'ok', contentRating: 'Adventure' }).contentRating).toBe('adventure');
    expect(DmSetupReplySchema.parse({ reply: 'ok', contentRating: 'PG-13' }).contentRating).toBeNull();
    expect(DmSetupReplySchema.parse({ reply: 'ok' }).contentRating).toBeNull();
  });

  it('never claims a rating it did not set', () => {
    const fallback = 'What kind of danger do you enjoy?';
    expect(withoutUnsetRatingClaims('Lovely. I have set the rating to Mature. Who are the heroes?', 'storybook', fallback)).toBe('Lovely. Who are the heroes?');
    expect(withoutUnsetRatingClaims('We are rated Adventure now.', 'storybook', fallback)).toBe(fallback);
    // The rating it did set (or already has) may be said.
    expect(withoutUnsetRatingClaims('Great — we are rated Adventure now.', 'adventure', fallback)).toBe('Great — we are rated Adventure now.');
    // A question offering the levels is not a claim; nor is "gentle" as a plain word.
    const ask = 'How intense should this get — Gentle, Storybook, Adventure or Mature?';
    expect(withoutUnsetRatingClaims(ask, 'storybook', fallback)).toBe(ask);
    expect(withoutUnsetRatingClaims('A gentle mist rolls over a mature forest.', 'storybook', fallback)).toBe('A gentle mist rolls over a mature forest.');
  });

  it('reads the host\'s answer when they name a level outright', () => {
    expect(ratingStatedIn("Let's rate it Mature, it's just us adults.")).toBe('mature');
    expect(ratingStatedIn('Adventure rating please.')).toBe('adventure');
    expect(ratingStatedIn('Make it storybook.')).toBe('storybook');
    expect(ratingStatedIn('Go with Mature')).toBe('mature');
    expect(ratingStatedIn('I want a big space adventure with pirates.')).toBeNull();
    expect(ratingStatedIn('Is Mature too much?')).toBeNull();
    expect(ratingStatedIn('Somewhere between Storybook and Adventure rating.')).toBeNull();
    expect(ratingStatedIn('make it gentle and silly')).toBeNull();
  });

  it('the gentle setup register follows the rating: gone once the host chose higher', () => {
    const asked = [{ role: 'user', content: 'gentle peril please' }];
    expect(setupToneRule(asked)).toContain('GENTLE PERIL');
    expect(setupToneRule(asked, 'gentle')).toContain('GENTLE PERIL');
    expect(setupToneRule(asked, 'adventure')).toBe('');
    expect(setupToneRule([{ role: 'user', content: 'a heist' }], 'gentle')).toContain('rated Gentle');
  });
});
