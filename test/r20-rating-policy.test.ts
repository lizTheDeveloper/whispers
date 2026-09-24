// Round 20: the content rating — one setting, one policy, every path.
// "Sometimes only adults will play this — add a rating setting so people
// can control this dynamically."
import { describe, it, expect } from 'vitest';
import { CONTENT_RATINGS, ratingPolicy, defaultContentRating, isContentRating, ratingLabel, ratingChangeLine, parseContentRating } from '../src/shared/rating.js';

describe('the content rating levels', () => {
  it('are ordered gentle < storybook < adventure < mature', () => {
    expect(CONTENT_RATINGS).toEqual(['gentle', 'storybook', 'adventure', 'mature']);
    expect(CONTENT_RATINGS.map(ratingLabel)).toEqual(['Gentle', 'Storybook', 'Adventure', 'Mature']);
  });

  it('reads a rating from loose input and nothing else', () => {
    expect(isContentRating('adventure')).toBe(true);
    expect(isContentRating('PG-13')).toBe(false);
    expect(parseContentRating(' Mature ')).toBe('mature');
    expect(parseContentRating('storybook')).toBe('storybook');
    expect(parseContentRating('R')).toBeNull();
    expect(parseContentRating(null)).toBeNull();
  });

  it('says a change in one plain line', () => {
    expect(ratingChangeLine('adventure')).toBe('The host set the rating to Adventure.');
  });
});

describe('ratingPolicy', () => {
  it('gentle: the whole gentle-table path — full gate on every kind, softeners, warm closed endings, gentle compels, options and thoughts judged', () => {
    const p = ratingPolicy('gentle');
    expect(p.gate).toBe('gentle');
    for (const k of ['ruling', 'narration', 'opening', 'world-intro', 'epilogue', 'reflection', 'setup'] as const) expect(p.gates(k)).toBe(true);
    expect(p.soften).toBe(true);
    expect(p.endings).toBe('warm-closed');
    expect(p.compels).toBe('gentle');
    expect(p.childOptions).toBe(true);
    expect(p.adultOptions).toBe(true);
    expect(p.childThought).toBe(true);
    expect(p.gentleRegister).toBe(true);
  });

  it('storybook: the reduced gate on the prose, no softener, warm (not closed) endings, warm lines for the child only', () => {
    const p = ratingPolicy('storybook');
    expect(p.gate).toBe('storybook');
    for (const k of ['ruling', 'narration', 'opening', 'world-intro', 'epilogue', 'reflection'] as const) expect(p.gates(k)).toBe(true);
    expect(p.gates('setup')).toBe(false);
    expect(p.soften).toBe(false);
    expect(p.endings).toBe('warm');
    expect(p.compels).toBe('child-gentle');
    expect(p.childOptions).toBe(true);
    expect(p.adultOptions).toBe(false);
    expect(p.childThought).toBe(true);
    expect(p.gentleRegister).toBe(false);
  });

  it('adventure: a light gore gate on the prose only; endings may be open or bleak', () => {
    const p = ratingPolicy('adventure');
    expect(p.gate).toBe('adventure');
    expect(p.gates('narration')).toBe(true);
    expect(p.gates('ruling')).toBe(true);
    expect(p.gates('setup')).toBe(false);
    expect(p.soften).toBe(false);
    expect(p.endings).toBe('open');
    expect(p.compels).toBe('standard');
    expect(p.childOptions).toBe(false);
    expect(p.adultOptions).toBe(false);
    expect(p.childThought).toBe(false);
  });

  it('mature: the safety floor alone on the prose (never off), no softener, open endings, stock lines', () => {
    const p = ratingPolicy('mature');
    expect(p.gate).toBe('floor');
    for (const k of ['ruling', 'narration', 'opening', 'world-intro', 'epilogue', 'reflection'] as const) expect(p.gates(k)).toBe(true);
    for (const k of ['setup', 'options', 'thought'] as const) expect(p.gates(k)).toBe(false);
    expect(p.soften).toBe(false);
    expect(p.endings).toBe('open');
    expect(p.compels).toBe('standard');
    expect(p.childOptions || p.adultOptions || p.childThought).toBe(false);
  });
});

describe('defaultContentRating', () => {
  it('gentle when the host asked for gentle peril', () => {
    expect(defaultContentRating({ gentleAsked: true, childPresent: false })).toBe('gentle');
  });
  it('gentle when a player character is a child', () => {
    expect(defaultContentRating({ gentleAsked: false, childPresent: true })).toBe('gentle');
  });
  it('storybook otherwise', () => {
    expect(defaultContentRating({ gentleAsked: false, childPresent: false })).toBe('storybook');
  });
});
