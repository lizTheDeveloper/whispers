import { describe, it, expect } from 'vitest';
import { renderKey, screenFor } from '../src/client/render-key.js';

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

describe('screenFor', () => {
  it('keeps the host on the DM lobby for every table role during the lobby phase', () => {
    // Different renderKeys, same screen — renderFor must not remount the
    // lobby (and wipe the setup chat) when only the role changed.
    expect(screenFor(true, null, 'lobby')).toBe('dm-lobby');
    expect(screenFor(true, 'dm', 'lobby')).toBe('dm-lobby');
    expect(screenFor(true, 'player', 'lobby')).toBe('dm-lobby');
  });

  it('routes a playing host to the character creator once the table opens', () => {
    expect(screenFor(true, 'player', 'character-creation')).toBe('character-creator');
    expect(screenFor(true, 'dm', 'character-creation')).toBe('dm-lobby');
    expect(screenFor(true, null, 'character-creation')).toBe('dm-lobby');
  });

  it('routes non-owners and the running game as before', () => {
    expect(screenFor(false, null, 'lobby')).toBe('waiting-room');
    expect(screenFor(false, 'dm', 'character-creation')).toBe('character-creator');
    expect(screenFor(true, 'dm', 'playing')).toBe('game-view');
    expect(screenFor(false, 'player', 'ended')).toBe('game-view');
  });
});
