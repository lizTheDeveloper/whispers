import { describe, it, expect } from 'vitest';
import { renderKey } from '../src/client/render-key.js';

describe('renderKey', () => {
  it('produces different keys for two states that differ only in table role', () => {
    // This is the named bug from task 6: a host who switches table role
    // while the join code and phase stay put used to compute the same
    // cache key, so renderFor no-op'd and nothing re-rendered.
    const dmKey = renderKey(true, 'dm', 'ABCD', 'character-creation');
    const playerKey = renderKey(true, 'player', 'ABCD', 'character-creation');
    expect(dmKey).not.toBe(playerKey);
  });

  it('also distinguishes a null table role (pre-choice / legacy campaigns) from an explicit one', () => {
    const nullKey = renderKey(true, null, 'ABCD', 'lobby');
    const dmKey = renderKey(true, 'dm', 'ABCD', 'lobby');
    expect(nullKey).not.toBe(dmKey);
  });

  it('still varies by owner, join code, and phase as before', () => {
    const a = renderKey(true, 'dm', 'ABCD', 'lobby');
    const b = renderKey(false, 'dm', 'ABCD', 'lobby');
    const c = renderKey(true, 'dm', 'WXYZ', 'lobby');
    const d = renderKey(true, 'dm', 'ABCD', 'character-creation');
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('is stable for identical inputs', () => {
    expect(renderKey(true, 'player', 'ABCD', 'character-creation'))
      .toBe(renderKey(true, 'player', 'ABCD', 'character-creation'));
  });
});
