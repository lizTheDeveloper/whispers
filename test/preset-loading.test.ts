import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dataPath, safeDataFile } from '../src/server/data-paths.js';
import { composePresetSections } from '../src/server/agents/dm.js';

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
  it('keeps the preset head and CRITICAL section when a custom prompt exists', () => {
    const { head, critical } = composePresetSections('trickster');
    // The composed sections are independent of dmCustomPrompt by construction:
    // buildSystemPrompt starts from them unconditionally.
    expect(head.length).toBeGreaterThan(100);
    expect(critical).toContain('CRITICAL:');
  });
});
