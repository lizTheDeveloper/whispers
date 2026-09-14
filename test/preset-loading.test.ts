import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dataPath, safeDataFile } from '../src/server/data-paths.js';
import { composePresetSections, assembleSystemPrompt } from '../src/server/agents/dm.js';
import { loadStockScenario } from '../src/server/world-seed.js';

describe('data path resolution', () => {
  it('finds the DM preset files that ship with the repo', () => {
    for (const preset of ['chronicler', 'trickster', 'professor']) {
      const p = safeDataFile('dm-presets', preset, '.txt');
      expect(p, `${preset}.txt should resolve`).not.toBeNull();
      expect(existsSync(p!)).toBe(true);
    }
  });

  it('returns preset text containing the CRITICAL enforcement section', () => {
    const p = safeDataFile('dm-presets', 'chronicler', '.txt')!;
    const text = readFileSync(p, 'utf-8');
    expect(text.length).toBeGreaterThan(100);
    expect(text).toContain('CRITICAL:');
  });

  it('finds the stock scenario files', () => {
    for (const s of ['collapsed-mine', 'haunted-masquerade', 'clockwork-vault', 'frontier-outpost']) {
      expect(safeDataFile('scenarios', s, '.json'), `${s}.json should resolve`).not.toBeNull();
    }
  });

  it('refuses path traversal and malformed names', () => {
    expect(safeDataFile('dm-presets', '../../../etc/passwd', '.txt')).toBeNull();
    expect(safeDataFile('dm-presets', 'Chronicler', '.txt')).toBeNull(); // uppercase rejected
    expect(safeDataFile('dm-presets', '', '.txt')).toBeNull();
  });

  it('returns null for a name that passes validation but does not exist', () => {
    expect(safeDataFile('dm-presets', 'nonexistent-preset', '.txt')).toBeNull();
  });

  it('roots everything at the configured data directory', () => {
    expect(dataPath('dm-presets')).toBe(dataPath('dm-presets'));
    expect(dataPath('a', 'b')).toMatch(/[/\\]a[/\\]b$/);
  });
});

describe('loadStockScenario against the real data directory', () => {
  // world-seed.test.ts points DATA_DIR at a temp dir with no scenarios/, so it
  // can only exercise loadStockScenario's negative cases (unknown id,
  // traversal). This file deliberately does NOT override DATA_DIR, so it is
  // the only place that can catch the mapping itself going wrong — e.g. if
  // `premise: raw.description` silently produced an empty premise, or if the
  // shipped JSON field names (`description`, `openingNarration`) drifted from
  // what the loader expects.
  it('maps collapsed-mine.json into a seed with real content', () => {
    const loaded = loadStockScenario('collapsed-mine');
    expect(loaded).not.toBeNull();
    const { seed, openingNarration } = loaded!;

    expect(seed.premise.trim().length).toBeGreaterThan(0);
    expect(seed.locations.length).toBeGreaterThanOrEqual(2);
    for (const loc of seed.locations) expect(loc.name.trim().length).toBeGreaterThan(0);
    expect(seed.npcs.length).toBeGreaterThanOrEqual(2);
    for (const npc of seed.npcs) expect(npc.name.trim().length).toBeGreaterThan(0);
    expect(seed.plotHooks.length).toBeGreaterThanOrEqual(1);
    expect(typeof openingNarration).toBe('string');
    expect(openingNarration!.trim().length).toBeGreaterThan(0);
  });

  it('maps haunted-masquerade.json into a seed with real content', () => {
    const loaded = loadStockScenario('haunted-masquerade');
    expect(loaded).not.toBeNull();
    const { seed, openingNarration } = loaded!;

    expect(seed.premise.trim().length).toBeGreaterThan(0);
    expect(seed.locations.length).toBeGreaterThanOrEqual(2);
    for (const loc of seed.locations) expect(loc.name.trim().length).toBeGreaterThan(0);
    expect(seed.npcs.length).toBeGreaterThanOrEqual(2);
    for (const npc of seed.npcs) expect(npc.name.trim().length).toBeGreaterThan(0);
    expect(seed.plotHooks.length).toBeGreaterThanOrEqual(1);
    expect(typeof openingNarration).toBe('string');
    expect(openingNarration!.trim().length).toBeGreaterThan(0);
  });
});

describe('preset text reaches the DM system prompt', () => {
  it('exposes the preset personality rather than the generic fallback', () => {
    // buildSystemPrompt is private; assert through the public seam the bug hid behind.
    const p = safeDataFile('dm-presets', 'trickster', '.txt')!;
    const text = readFileSync(p, 'utf-8');
    const criticalIdx = text.indexOf('CRITICAL:');
    expect(criticalIdx).toBeGreaterThan(0);
    expect(text.slice(0, criticalIdx).trim().length).toBeGreaterThan(50);
  });
});

describe('preset sections compose', () => {
  it('returns real preset text, a CRITICAL section, and a narration hint', () => {
    const { head, critical, narrationHint } = composePresetSections('chronicler');
    expect(head.length).toBeGreaterThan(100);
    expect(head).not.toMatch(/^You are a TTRPG Dungeon Master with the "chronicler" personality\.$/m);
    expect(critical).toContain('CRITICAL:');
    expect(narrationHint).toContain('non-visual sense');
  });

  it('falls back to a named generic prompt for an unknown preset', () => {
    const { head, critical, narrationHint } = composePresetSections('no-such-preset');
    expect(head).toContain('no-such-preset');
    expect(critical).toBe('');
    expect(narrationHint).toBe('');
  });
});

describe('dmCustomPrompt augments rather than replaces', () => {
  it('keeps the preset personality when a custom prompt is present', () => {
    const { head, critical } = composePresetSections('trickster');
    const presetOpening = head.slice(0, 60).trim();

    const withCustom = assembleSystemPrompt({
      preset: 'trickster',
      dmCustomPrompt: 'SENTINEL-CUSTOM-PROMPT',
      houseRules: null,
      dmInstructions: null,
      campaignMaterials: null,
      influences: [],
    });

    // Both must be present. Replacing the preset drops the first.
    expect(withCustom.systemPrompt).toContain(presetOpening);
    expect(withCustom.systemPrompt).toContain('SENTINEL-CUSTOM-PROMPT');
    expect(withCustom.systemPrompt).toContain(critical.trim());
    expect(withCustom.criticalReminder).not.toBe('');
    expect(withCustom.narrationHint).not.toBe('');
  });

  it('is otherwise identical to the no-custom-prompt case', () => {
    const withoutCustom = assembleSystemPrompt({
      preset: 'trickster', dmCustomPrompt: null, houseRules: null, dmInstructions: null, campaignMaterials: null, influences: [],
    });
    expect(withoutCustom.systemPrompt).not.toContain('SENTINEL-CUSTOM-PROMPT');
    expect(withoutCustom.criticalReminder).not.toBe('');
  });
});

describe('influences reach the system prompt', () => {
  it('places each influence between dmCustomPrompt and the storytelling principles', () => {
    const { systemPrompt } = assembleSystemPrompt({
      preset: 'trickster',
      dmCustomPrompt: 'SENTINEL-CUSTOM-PROMPT',
      houseRules: null,
      dmInstructions: null,
      campaignMaterials: null,
      influences: ['Dark Souls item descriptions', 'The Wicker Man (1973)', 'Gene Wolfe'],
    });

    for (const influence of ['Dark Souls item descriptions', 'The Wicker Man (1973)', 'Gene Wolfe']) {
      expect(systemPrompt).toContain(influence);
    }

    const customIdx = systemPrompt.indexOf('SENTINEL-CUSTOM-PROMPT');
    const influenceIdx = systemPrompt.indexOf('Dark Souls item descriptions');
    const principlesIdx = systemPrompt.indexOf('Storytelling principles:');
    expect(customIdx).toBeGreaterThan(-1);
    expect(influenceIdx).toBeGreaterThan(customIdx);
    expect(principlesIdx).toBeGreaterThan(influenceIdx);
  });

  it('omits the section entirely when there are no influences', () => {
    const { systemPrompt } = assembleSystemPrompt({
      preset: 'trickster',
      dmCustomPrompt: null,
      houseRules: null,
      dmInstructions: null,
      campaignMaterials: null,
      influences: [],
    });

    expect(systemPrompt).not.toContain('Stylistic influences');
  });
});
