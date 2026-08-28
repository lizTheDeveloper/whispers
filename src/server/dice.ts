import { DiceRoll } from '@dice-roller/rpg-dice-roller';
import type { DiceResult } from '../shared/types.js';

export function rollDice(expression: string): DiceResult {
  const roll = new DiceRoll(expression);
  const rolls: number[] = [];
  for (const group of roll.rolls) {
    if (typeof group === 'object' && group !== null && 'rolls' in group) {
      for (const r of (group as { rolls: Array<{ value: number }> }).rolls) {
        if (typeof r === 'object' && r !== null && 'value' in r) rolls.push(r.value);
      }
    }
  }
  return {
    expression,
    total: roll.total,
    rolls,
    description: roll.output,
  };
}
