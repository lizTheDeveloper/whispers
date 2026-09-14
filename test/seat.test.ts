import { describe, it, expect } from 'vitest';
import { effectiveTableRole, isWorldAuthor, hasDmAuthority } from '../src/server/seat.js';

const owner = { isOwner: true };
const player = { isOwner: false };

describe('effectiveTableRole', () => {
  it('defaults an unset role to dm, preserving how games behaved before roles existed', () => {
    expect(effectiveTableRole(null)).toBe('dm');
    expect(effectiveTableRole(undefined)).toBe('dm');
  });

  it('returns the chosen role', () => {
    expect(effectiveTableRole('player')).toBe('player');
    expect(effectiveTableRole('dm')).toBe('dm');
  });
});

describe('isWorldAuthor', () => {
  it('is the owner regardless of table role', () => {
    expect(isWorldAuthor(owner)).toBe(true);
    expect(isWorldAuthor(player)).toBe(false);
  });

  it('is false for a missing seat', () => {
    expect(isWorldAuthor(null)).toBe(false);
    expect(isWorldAuthor(undefined)).toBe(false);
  });
});

describe('hasDmAuthority', () => {
  it('belongs to the owner when they chose to run the table', () => {
    expect(hasDmAuthority(owner, 'dm')).toBe(true);
  });

  it('is withheld from the owner when they chose to play', () => {
    expect(hasDmAuthority(owner, 'player')).toBe(false);
  });

  it('defaults to the owner when no role was chosen', () => {
    expect(hasDmAuthority(owner, null)).toBe(true);
  });

  it('never belongs to a non-owner', () => {
    expect(hasDmAuthority(player, 'dm')).toBe(false);
    expect(hasDmAuthority(player, 'player')).toBe(false);
    expect(hasDmAuthority(null, 'dm')).toBe(false);
  });
});
