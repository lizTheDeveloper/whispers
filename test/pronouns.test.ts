// Live: the whisper panel read "Liz is focused and alert. They listen, but
// weigh your words against their own judgment." for Liz, whose sheet says
// she/her. The trust hint was a fixed "They" sentence. It now speaks of the
// character in the pronouns the sheet states — or by name when it states
// none, or states pronouns whose forms we cannot derive.
import { describe, it, expect } from 'vitest';
import { pronounSet, referTo } from '../src/shared/pronouns.js';
import { trustHint } from '../src/server/trust-hint.js';

describe('pronounSet', () => {
  it('reads the common sets', () => {
    expect(pronounSet('she/her')).toEqual({ subject: 'she', object: 'her', possessive: 'her', plural: false });
    expect(pronounSet('he/him')).toEqual({ subject: 'he', object: 'him', possessive: 'his', plural: false });
    expect(pronounSet('they/them')).toEqual({ subject: 'they', object: 'them', possessive: 'their', plural: true });
  });

  it('tolerates case, spacing, separators and a lone subject', () => {
    expect(pronounSet(' She / Her ')?.subject).toBe('she');
    expect(pronounSet('he, him, his')?.possessive).toBe('his');
    expect(pronounSet('they')?.object).toBe('them');
    expect(pronounSet('she/they')?.subject).toBe('she');
  });

  it('is null when nothing usable is stated — neopronouns, "any", empty', () => {
    expect(pronounSet('xe/xem')).toBeNull();
    expect(pronounSet('ze/zir')).toBeNull();
    expect(pronounSet('any pronouns')).toBeNull();
    expect(pronounSet('')).toBeNull();
    expect(pronounSet(null)).toBeNull();
    expect(pronounSet(undefined)).toBeNull();
  });
});

describe('referTo', () => {
  it('uses the pronouns when known, the name otherwise', () => {
    expect(referTo('Liz', 'she/her')).toEqual({ subject: 'she', object: 'her', possessive: 'her', plural: false });
    expect(referTo('Ash', 'xe/xem')).toEqual({ subject: 'Ash', object: 'Ash', possessive: "Ash's", plural: false });
    expect(referTo('Biz', null)).toEqual({ subject: 'Biz', object: 'Biz', possessive: "Biz's", plural: false });
  });
});

describe('the whisper panel\'s trust line', () => {
  it('she/her', () => {
    expect(trustHint(0.6, 'Liz', 'she/her')).toBe('She listens, but weighs your words against her own judgment.');
    expect(trustHint(0.9, 'Liz', 'she/her')).toBe('She trusts your voice deeply — your words carry weight.');
    expect(trustHint(0.4, 'Liz', 'she/her')).toBe('She\'s uncertain about you — choose your words carefully.');
    expect(trustHint(0.2, 'Liz', 'she/her')).toBe('She barely hears you. Only the most compelling whisper might reach her.');
  });

  it('they/them keeps plural agreement', () => {
    expect(trustHint(0.6, 'Sam', 'they/them')).toBe('They listen, but weigh your words against their own judgment.');
    expect(trustHint(0.9, 'Sam', 'they/them')).toBe('They trust your voice deeply — your words carry weight.');
    expect(trustHint(0.4, 'Sam', 'they/them')).toBe('They\'re uncertain about you — choose your words carefully.');
    expect(trustHint(0.2, 'Sam', 'they/them')).toBe('They barely hear you. Only the most compelling whisper might reach them.');
  });

  it('he/him', () => {
    expect(trustHint(0.6, 'Biz', 'he/him')).toBe('He listens, but weighs your words against his own judgment.');
    expect(trustHint(0.2, 'Biz', 'he/him')).toBe('He barely hears you. Only the most compelling whisper might reach him.');
  });

  it('unknown (or neopronouns): the name, never a guessed "They"', () => {
    expect(trustHint(0.6, 'Biz', undefined)).toBe('Biz listens, but weighs your words against Biz\'s own judgment.');
    expect(trustHint(0.4, 'Biz', null)).toBe('Biz is uncertain about you — choose your words carefully.');
    expect(trustHint(0.2, 'Ash', 'xe/xem')).toBe('Ash barely hears you. Only the most compelling whisper might reach Ash.');
  });
});
