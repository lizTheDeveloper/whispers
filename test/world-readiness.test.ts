import { describe, it, expect } from 'vitest';
import {
  normalizeInfluences, checkWorldReadiness,
  MIN_INFLUENCES,
} from '../src/server/world-readiness.js';
import type { WorldSeed } from '../src/shared/types.js';

const goodSeed: WorldSeed = {
  premise: 'A lighthouse keeps something out, not in.',
  locations: [
    { name: 'The Lamp Room', description: 'Glass and salt.', terrain: 'interior' },
    { name: 'The Tidal Stair', description: 'Cut into rock.', terrain: 'coast' },
  ],
  npcs: [
    { name: 'Maren', description: 'The keeper.', disposition: 'wary', motivation: 'Keep the light lit.' },
    { name: 'The Cartwright', description: 'Brings supplies.', disposition: 'friendly', motivation: 'Get paid.' },
  ],
  plotHooks: ['The relief keeper never arrived.'],
  items: [],
};

const base = {
  influences: ['Le Guin', 'Annihilation', 'Disco Elysium'],
  seed: goodSeed,
  dmInstructions: 'Spooky but hopeful.',
  hostTableRole: 'dm' as const,
  seedAccepted: true,
};

describe('normalizeInfluences', () => {
  it('trims, drops empties, and dedupes case-insensitively', () => {
    expect(normalizeInfluences(['  Le Guin ', 'le guin', '', '   ', 'Annihilation']))
      .toEqual(['Le Guin', 'Annihilation']);
  });

  it('returns an empty list for anything that is not an array of strings', () => {
    expect(normalizeInfluences(null)).toEqual([]);
    expect(normalizeInfluences('Le Guin')).toEqual([]);
    expect(normalizeInfluences([1, 2, 3])).toEqual([]);
    expect(normalizeInfluences([{ name: 'Le Guin' }])).toEqual([]);
  });

  it('caps the list and each entry so a model cannot flood the prompt', () => {
    const many = Array.from({ length: 30 }, (_, i) => `influence-${i}`);
    expect(normalizeInfluences(many).length).toBeLessThanOrEqual(12);
    const long = normalizeInfluences(['x'.repeat(500)]);
    expect(long[0]!.length).toBeLessThanOrEqual(120);
  });
});

describe('checkWorldReadiness', () => {
  it('passes when everything is present', () => {
    const r = checkWorldReadiness(base);
    expect(r.ready).toBe(true);
    expect(r.unmet).toEqual([]);
  });

  it(`requires at least ${MIN_INFLUENCES} influences`, () => {
    const r = checkWorldReadiness({ ...base, influences: ['Le Guin', 'Annihilation'] });
    expect(r.ready).toBe(false);
    expect(r.unmet).toContain('influences');
    expect(r.detail.join(' ')).toMatch(/3/);
  });

  it('requires a seed with enough locations, npcs, and hooks', () => {
    expect(checkWorldReadiness({ ...base, seed: null }).unmet).toContain('seed');
    expect(checkWorldReadiness({ ...base, seed: { ...goodSeed, locations: [goodSeed.locations[0]!] } }).unmet).toContain('seed');
    expect(checkWorldReadiness({ ...base, seed: { ...goodSeed, npcs: [goodSeed.npcs[0]!] } }).unmet).toContain('seed');
    expect(checkWorldReadiness({ ...base, seed: { ...goodSeed, plotHooks: [] } }).unmet).toContain('seed');
    expect(checkWorldReadiness({ ...base, seed: { ...goodSeed, premise: '   ' } }).unmet).toContain('seed');
  });

  it('requires dm instructions, a table role, and an accepted seed', () => {
    expect(checkWorldReadiness({ ...base, dmInstructions: null }).unmet).toContain('dmInstructions');
    expect(checkWorldReadiness({ ...base, dmInstructions: '   ' }).unmet).toContain('dmInstructions');
    expect(checkWorldReadiness({ ...base, hostTableRole: null }).unmet).toContain('tableRole');
    expect(checkWorldReadiness({ ...base, seedAccepted: false }).unmet).toContain('seedAccepted');
  });

  it('reports every unmet item at once, not just the first', () => {
    const r = checkWorldReadiness({ influences: [], seed: null, dmInstructions: null, hostTableRole: null, seedAccepted: false });
    expect(r.ready).toBe(false);
    expect(r.unmet).toEqual(
      expect.arrayContaining(['influences', 'seed', 'dmInstructions', 'tableRole', 'seedAccepted']),
    );
    expect(r.detail.length).toBe(r.unmet.length);
  });
});
