import { describe, it, expect } from 'vitest';
import { checkCharacterReadiness, MIN_ASPECTS } from '../src/server/character-readiness.js';

const good = {
  name: 'Vesper Ash',
  highConcept: 'Lighthouse Keeper Who Stopped Believing',
  trouble: 'Owes the Ledger Cult a debt she cannot name',
  aspects: ['Maps are promises', 'Never looks back'],
  personality: 'Quiet.',
  backstory: 'Thirty years at the lamp.',
  skills: { Will: 3 },
  stunts: ['Steady Hand: +2 to Will against fear.'],
};

describe('checkCharacterReadiness', () => {
  it('passes a complete sheet', () => {
    const r = checkCharacterReadiness(good);
    expect(r.ready).toBe(true);
    expect(r.unmet).toEqual([]);
    expect(r.detail).toEqual([]);
  });

  it('rejects anything that is not an object', () => {
    for (const junk of [null, undefined, 'a sheet', 42, []]) {
      const r = checkCharacterReadiness(junk);
      expect(r.ready).toBe(false);
      expect(r.unmet.length).toBeGreaterThan(0);
    }
  });

  it('requires name, highConcept and trouble to be non-empty after trimming', () => {
    expect(checkCharacterReadiness({ ...good, name: '   ' }).unmet).toContain('name');
    expect(checkCharacterReadiness({ ...good, highConcept: '' }).unmet).toContain('highConcept');
    expect(checkCharacterReadiness({ ...good, trouble: undefined }).unmet).toContain('trouble');
  });

  it(`requires at least ${MIN_ASPECTS} non-empty aspects`, () => {
    expect(checkCharacterReadiness({ ...good, aspects: ['only one'] }).unmet).toContain('aspects');
    expect(checkCharacterReadiness({ ...good, aspects: ['a', '   '] }).unmet).toContain('aspects');
    expect(checkCharacterReadiness({ ...good, aspects: [null, {}] }).unmet).toContain('aspects');
    expect(checkCharacterReadiness({ ...good, aspects: 'two of them' }).unmet).toContain('aspects');
  });

  it('requires at least one skill with a numeric rating', () => {
    expect(checkCharacterReadiness({ ...good, skills: {} }).unmet).toContain('skills');
    expect(checkCharacterReadiness({ ...good, skills: { Will: 'high' } }).unmet).toContain('skills');
    expect(checkCharacterReadiness({ ...good, skills: null }).unmet).toContain('skills');
  });

  it('requires at least one non-empty stunt', () => {
    expect(checkCharacterReadiness({ ...good, stunts: [] }).unmet).toContain('stunts');
    expect(checkCharacterReadiness({ ...good, stunts: ['  '] }).unmet).toContain('stunts');
  });

  it('reports every unmet item at once, with one detail per item in the same order', () => {
    const r = checkCharacterReadiness({});
    expect(r.unmet).toEqual(expect.arrayContaining(['name', 'highConcept', 'trouble', 'aspects', 'skills', 'stunts']));
    expect(r.detail.length).toBe(r.unmet.length);
  });

  it('never throws on a hostile shape', () => {
    expect(() => checkCharacterReadiness({ aspects: { length: 99 }, skills: [], stunts: 'x' })).not.toThrow();
  });
});
