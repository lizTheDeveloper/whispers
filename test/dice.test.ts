import { describe, it, expect } from 'vitest';
import { rollDice } from '../src/server/dice.js';

describe('dice roller', () => {
  it('rolls standard FATE dice (4dF)', () => {
    const result = rollDice('4dF');
    expect(result.expression).toBe('4dF');
    expect(result.total).toBeGreaterThanOrEqual(-4);
    expect(result.total).toBeLessThanOrEqual(4);
    expect(result.rolls).toHaveLength(4);
    result.rolls.forEach(r => expect([-1, 0, 1]).toContain(r));
  });

  it('rolls d20 + modifier', () => {
    const result = rollDice('1d20+5');
    expect(result.total).toBeGreaterThanOrEqual(6);
    expect(result.total).toBeLessThanOrEqual(25);
  });

  it('rolls 2d6', () => {
    const result = rollDice('2d6');
    expect(result.total).toBeGreaterThanOrEqual(2);
    expect(result.total).toBeLessThanOrEqual(12);
    expect(result.rolls).toHaveLength(2);
  });

  it('includes a human-readable description', () => {
    const result = rollDice('4dF');
    expect(typeof result.description).toBe('string');
    expect(result.description.length).toBeGreaterThan(0);
  });

  it('throws on invalid expression', () => {
    expect(() => rollDice('not-a-dice-expression')).toThrow();
  });
});
