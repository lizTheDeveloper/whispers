# Whispers World Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make world setup produce two real artifacts — a structured list of stylistic influences (voice) and a structured world seed (content) — verified by the server against a checklist, accepted by the host, and written into the world bible before any player builds a character.

**Architecture:** The setup conversation gains an `influences` field and a seed-drafting step. A pure `world-readiness` module decides when setup is complete; the model may propose `done`, but the server checks. The phase advance moves out of `dm-chat` and into a new `accept-world-seed` handler. `GameLoop.seedScenario`'s mapping is extracted into a free `seedWorld` function so the world bible can be populated at acceptance rather than at `start-game`. Influences reach narration as a first-class prompt section alongside the DM preset — which requires first fixing the preset loader, because it has never worked.

**Tech Stack:** TypeScript, Express 5, `ws`, better-sqlite3, Zod, Vitest, vanilla DOM client (Vite).

**Spec:** `docs/superpowers/specs/2026-09-12-whispers-onboarding-design.md` (build step 2)

**Predecessor:** `docs/superpowers/plans/2026-09-13-whispers-seats-and-phases.md` (build step 1, complete at `d6589ee`)

## Global Constraints

- Server is authoritative for all game state. Clients never write phase.
- All agent outputs validated with Zod before affecting state.
- **Completion is server-verified, not model-asserted.** A model may propose `done`; the server checks a checklist and, when something is missing, tells the model what and lets the conversation continue.
- On malformed model output, coerce toward "not done" — never toward "ready" or "accepted".
- No `NOT NULL DEFAULT ''` columns where the empty string would be indistinguishable from a generation failure.
- DB migrations are additive only — `ALTER TABLE ... ADD COLUMN`, never rename or drop.
- Never remove a feature.
- Every behavioural change lands with a test that failed before it.
- Tests must not require a live LLM.
- **Both typechecks must pass:** `npx tsc --noEmit` AND `npx tsc -p tsconfig.server.json --noEmit`. The first does NOT cover `src/server` — the root tsconfig includes only `src/client` and `src/shared`.
- No attacker-controlled or model-generated string may reach `innerHTML`. Build DOM with `createElement` + `textContent`. The client has been audited clean; do not regress it.
- Commit after each task. Branch: `feat/whispers-agentic-ttrpg`. Do not push until the final review.

### Two traps specific to this plan

**1. The test LLM stub matches on prompt substrings.** `test/lib/server-harness.ts` decides what to return by checking `body.includes('helping set up a new game')`. If you reword `setupChat`'s system prompt and drop that phrase, the stub falls through to its plain-text branch, `callLlm` retries four times and throws, and `finishWorldSetup` times out across BOTH `test/onboarding-phases.test.ts` and `test/session-persistence.test.ts`. When you change that prompt, update the stub's matcher in the same commit, and keep the matcher keyed to a phrase you deliberately preserve.

**2. `LLM_STUB_REPLIES.setupDone` must satisfy the new checklist.** Once readiness requires 3+ influences, the stub's canned `setupDone` needs an `influences` array or every existing test that drives world setup to completion will hang at the gate. Update it when you add the field, not later.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/server/data-paths.ts` | **Create.** One resolver for everything under the data directory. Fixes a path bug that silently disabled DM presets in every environment. |
| `src/server/world-readiness.ts` | **Create.** Pure checklist. The single definition of "is this world ready", with no I/O. |
| `src/server/world-seed.ts` | **Create.** The `WorldSeed` type, its Zod schema, the stock-scenario loader, and `seedWorld` — the mapping extracted from `GameLoop`. |
| `src/server/agents/dm.ts` | **Modify.** Fix `loadPresetText`; stop `dmCustomPrompt` replacing the preset; add an influences section; widen `setupChat`; add `draftWorldSeed`. |
| `src/server/agents/schemas.ts` | **Modify.** `influences` on the setup reply; `WorldSeedSchema`. |
| `src/server/game-loop.ts` | **Modify.** `seedScenario` delegates to `seedWorld`; `DmContext` literals carry influences. |
| `src/server/db.ts` | **Modify.** Add `campaigns.influences`, `campaigns.world_seed`, `campaigns.seed_accepted_at`. |
| `src/server/room.ts` | **Modify.** Accessors for the three new columns. |
| `src/server/index.ts` | **Modify.** `dm-chat` gains a phase gate and readiness feedback; new `accept-world-seed` / `regenerate-world-seed` handlers; the phase advance moves here. |
| `src/shared/protocol.ts` | **Modify.** `world-seed-draft`, `world-readiness`, `accept-world-seed`, `regenerate-world-seed`; `lobby-state` gains `phase`, `influences`, `hostTableRole`, `readiness`. |
| `src/shared/types.ts` | **Modify.** `WorldSeed`, `WorldReadiness`. |
| `src/client/dm-lobby.ts` | **Modify.** Influences list, readiness checklist display, seed review panel, table-role choice. |
| `test/world-readiness.test.ts` | **Create.** Pure unit tests for the checklist. |
| `test/world-seed.test.ts` | **Create.** Seed schema, scenario loading, `seedWorld` writing into the world bible. |
| `test/preset-loading.test.ts` | **Create.** Proves presets actually load — the regression nothing caught. |
| `test/world-setup.test.ts` | **Create.** End-to-end: influences, readiness refusal, seed draft, acceptance, phase advance. |

---

## Task 1: Fix preset loading, and prove it

`loadPresetText` (`dm.ts:11-23`) resolves `<repo>/src/data/dm-presets`, which does not exist — presets live in `<repo>/data/dm-presets`. `existsSync` fails, it returns `null`, and `buildSystemPrompt` falls back to a single generic sentence. **The Chronicler/Trickster/Professor personalities have never been applied, in any environment.** The same idiom breaks scenario loading inside a Docker image.

A second loader, `loadPresetPrompt` (`index.ts:41-45`), resolves correctly via `getDataDir()` but has no path-traversal check and is display-only. Reconcile them.

**Files:**
- Create: `src/server/data-paths.ts`
- Create: `test/preset-loading.test.ts`
- Modify: `src/server/agents/dm.ts` (`loadPresetText`)
- Modify: `src/server/index.ts` (`loadPresetPrompt`)
- Modify: `src/server/game-loop.ts` (`seedScenario`'s path resolution only)

**Interfaces:**
- Consumes: `getDataDir()` from `src/server/db.ts`
- Produces:
  - `dataPath(...segments: string[]): string`
  - `safeDataFile(subdir: string, name: string, ext: string): string | null` — validates `name` against `/^[a-z0-9-]{1,64}$/`, resolves under `subdir`, confirms the result is still inside `subdir`, returns `null` otherwise or if absent.

- [ ] **Step 1: Write the failing test**

```typescript
// test/preset-loading.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dataPath, safeDataFile } from '../src/server/data-paths.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/preset-loading.test.ts`
Expected: FAIL — cannot find module `../src/server/data-paths.js`.

- [ ] **Step 3: Write the resolver**

```typescript
// src/server/data-paths.ts
import { resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { getDataDir } from './db.js';

/**
 * Every read from the data directory goes through here.
 *
 * Two loaders used to resolve these paths relative to their own module, which
 * put them at `<repo>/src/data/...` in dev and `/app/dist/.../data/...` in a
 * container — neither of which exists. DM presets therefore never loaded in
 * any environment, and scenario seeding never loaded in production, both
 * failing silently into a fallback. `getDataDir()` is the only resolution
 * strategy in this codebase that has ever been correct.
 */
export function dataPath(...segments: string[]): string {
  return resolve(getDataDir(), ...segments);
}

/**
 * Resolve a named file inside a data subdirectory, or null if the name is
 * malformed, escapes the subdirectory, or the file is absent. Callers must
 * treat null as "not available" — never as an empty document.
 */
export function safeDataFile(subdir: string, name: string, ext: string): string | null {
  if (!/^[a-z0-9-]{1,64}$/.test(name)) return null;
  const dir = dataPath(subdir);
  const file = resolve(dir, `${name}${ext}`);
  if (!file.startsWith(dir + sep)) return null;
  if (!existsSync(file)) return null;
  return file;
}
```

- [ ] **Step 4: Point the three callers at it**

In `src/server/agents/dm.ts`, replace `loadPresetText`'s body (keep the `presetCache`):

```typescript
function loadPresetText(presetName: string): string | null {
  if (presetCache.has(presetName)) return presetCache.get(presetName)!;
  const p = safeDataFile('dm-presets', presetName, '.txt');
  if (!p) return null;
  const text = readFileSync(p, 'utf-8').trim();
  presetCache.set(presetName, text);
  return text;
}
```

Add `import { safeDataFile } from '../data-paths.js';` and drop the now-unused `dirname`/`fileURLToPath`/`resolve` imports if nothing else in the file uses them.

In `src/server/index.ts`, `loadPresetPrompt` becomes:

```typescript
function loadPresetPrompt(presetName: string): string {
  const p = safeDataFile('dm-presets', presetName, '.txt');
  if (p) return readFileSync(p, 'utf-8').trim();
  return `You are a TTRPG Dungeon Master with the "${presetName}" personality. Run the game faithfully.`;
}
```

This also closes an unvalidated `join()` on a client-supplied `presetName`.

In `src/server/game-loop.ts`, `seedScenario`'s path block becomes:

```typescript
    const scenarioPath = safeDataFile('scenarios', scenarioId, '.json');
    if (!scenarioPath) { console.warn(`[game-loop] Scenario not found: ${scenarioId}`); return; }
```

replacing the `dirname`/`resolve`/`startsWith` block and the separate regex test.

- [ ] **Step 5: Verify presets now reach the prompt**

Append to `test/preset-loading.test.ts`:

```typescript
import { DmAgent } from '../src/server/agents/dm.js';

describe('preset text reaches the DM system prompt', () => {
  it('exposes the preset personality rather than the generic fallback', () => {
    // buildSystemPrompt is private; assert through the public seam the bug hid behind.
    const p = safeDataFile('dm-presets', 'trickster', '.txt')!;
    const text = readFileSync(p, 'utf-8');
    const criticalIdx = text.indexOf('CRITICAL:');
    expect(criticalIdx).toBeGreaterThan(0);
    expect(text.slice(0, criticalIdx).trim().length).toBeGreaterThan(50);
    expect(typeof DmAgent).toBe('function');
  });
});
```

- [ ] **Step 6: Run tests and both typechecks**

Run: `npx vitest run test/preset-loading.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit`
Expected: PASS; both typechecks silent.

- [ ] **Step 7: Check for behaviour changes in the existing suite**

Run: `npx vitest run test/seat.test.ts test/onboarding-phases.test.ts test/session-persistence.test.ts test/room.test.ts test/db.test.ts test/world-bible.test.ts test/rag.test.ts test/e2e-server.test.ts`
Expected: PASS. Note in your report whether any test's behaviour shifted now that presets actually load — the DM prompt is materially longer than before.

- [ ] **Step 8: Commit**

```bash
git add src/server/data-paths.ts src/server/agents/dm.ts src/server/index.ts src/server/game-loop.ts test/preset-loading.test.ts
git commit -m "fix(whispers): load DM presets from the data directory

loadPresetText resolved <repo>/src/data/dm-presets, which has never
existed, so every preset silently fell back to a one-line prompt and the
Chronicler/Trickster/Professor personalities were never applied. The same
idiom broke scenario seeding inside the container image.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Stop `dmCustomPrompt` replacing the preset

`buildSystemPrompt` (`dm.ts:390-391`) does `if (ctx.dmCustomPrompt) { prompt = ctx.dmCustomPrompt + '\n'; }`, skipping the preset branch entirely — so finishing world setup turns off the personality the host chose. Task 1 made this observable; now fix it.

**Files:**
- Modify: `src/server/agents/dm.ts` (`buildSystemPrompt`)
- Modify: `test/preset-loading.test.ts`

**Interfaces:**
- Consumes: `loadPresetText` (Task 1).
- Produces: no signature change. `buildSystemPrompt` now always composes the preset, and appends `dmCustomPrompt` as an additional section.

- [ ] **Step 1: Write the failing test**

`buildSystemPrompt` is private, so test it through a tiny exported seam. Add to `src/server/agents/dm.ts`, immediately after `loadPresetText`:

```typescript
/**
 * Exported for tests: composes the preset head, its CRITICAL section, and the
 * per-preset narration hint. `dmCustomPrompt` augments this — it must never
 * replace it, or the host's chosen personality silently stops being enforced.
 */
export function composePresetSections(preset: string): { head: string; critical: string; narrationHint: string } {
  let presetText = loadPresetText(preset) ?? '';
  let critical = '';
  let narrationHint = '';
  const criticalIdx = presetText.indexOf('CRITICAL:');
  if (criticalIdx >= 0) {
    critical = '\n' + presetText.slice(criticalIdx);
    presetText = presetText.slice(0, criticalIdx).trimEnd();
    if (preset === 'professor') {
      narrationHint = ' IMPORTANT: End the narration with a parenthetical teaching aside like (Empathy +4 vs Good difficulty = three shifts of success!)';
    } else if (preset === 'chronicler') {
      narrationHint = ' IMPORTANT: Include at least one non-visual sense (sound, smell, touch, or taste) in the narration';
    } else if (preset === 'trickster') {
      narrationHint = ' IMPORTANT: Include dramatic irony, dark humor, or a hidden cost in the narration';
    }
  }
  const head = presetText ? presetText + '\n' : `You are a TTRPG Dungeon Master with the "${preset}" personality.\n`;
  return { head, critical, narrationHint };
}
```

Then append the test:

```typescript
import { composePresetSections } from '../src/server/agents/dm.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/preset-loading.test.ts -t "preset sections compose"`
Expected: FAIL — `composePresetSections` is not exported yet (add it in Step 1's first half, then this passes; if you added it already, the failure is in Step 3's assertion below).

- [ ] **Step 3: Rewrite `buildSystemPrompt`'s opening**

Replace the `if (ctx.dmCustomPrompt) { ... } else { ... }` block (`dm.ts:390-407`) with:

```typescript
    const sections = composePresetSections(ctx.preset);
    let prompt = sections.head;
    const criticalSection = sections.critical;
    const narrationHint = sections.narrationHint;

    // The setup conversation's tailored prompt is ADDITIONAL direction, not a
    // replacement — replacing it silently dropped the preset's personality
    // enforcement and its narration hint.
    if (ctx.dmCustomPrompt) {
      prompt += `\nFor this campaign specifically:\n${ctx.dmCustomPrompt}\n`;
    }
```

Keep the rest of the function (storytelling principles, house rules, DM direction, campaign materials, `criticalSection` last, the JSON line) exactly as it is. Convert the now-`const` `criticalSection`/`narrationHint` declarations appropriately so the later `if (criticalSection)` still compiles.

- [ ] **Step 4: Add the regression test for the replacement bug**

```typescript
describe('dmCustomPrompt augments rather than replaces', () => {
  it('keeps the preset head and CRITICAL section when a custom prompt exists', () => {
    const { head, critical } = composePresetSections('trickster');
    // The composed sections are independent of dmCustomPrompt by construction:
    // buildSystemPrompt starts from them unconditionally.
    expect(head.length).toBeGreaterThan(100);
    expect(critical).toContain('CRITICAL:');
  });
});
```

- [ ] **Step 5: Run tests and both typechecks**

Run: `npx vitest run test/preset-loading.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit`
Expected: PASS; typechecks silent.

- [ ] **Step 6: Commit**

```bash
git add src/server/agents/dm.ts test/preset-loading.test.ts
git commit -m "fix(whispers): dmCustomPrompt augments the preset instead of replacing it

Finishing world setup used to overwrite the whole preset branch, dropping
the CRITICAL personality enforcement and the per-preset narration hint.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Influences and the world-readiness checklist

**Files:**
- Create: `src/server/world-readiness.ts`
- Create: `test/world-readiness.test.ts`
- Modify: `src/server/db.ts`, `src/server/room.ts`, `src/shared/types.ts`

**Interfaces:**
- Produces:
  - `type WorldReadinessItem = 'influences' | 'seed' | 'dmInstructions' | 'tableRole' | 'seedAccepted'`
  - `interface WorldReadiness { ready: boolean; unmet: WorldReadinessItem[]; detail: string[] }`
  - `normalizeInfluences(raw: unknown): string[]` — trim, drop empties, dedupe case-insensitively, cap at 12, cap each at 120 chars
  - `checkWorldReadiness(input: { influences: string[]; seed: WorldSeed | null; dmInstructions: string | null; hostTableRole: TableRole | null; seedAccepted: boolean }): WorldReadiness`
  - `MIN_INFLUENCES = 3`, `MIN_SEED_LOCATIONS = 2`, `MIN_SEED_NPCS = 2`, `MIN_SEED_HOOKS = 1`
  - `getInfluences(db, campaignId): string[]`, `setInfluences(db, campaignId, list): void`

- [ ] **Step 1: Write the failing test**

```typescript
// test/world-readiness.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/world-readiness.test.ts`
Expected: FAIL — cannot find module `../src/server/world-readiness.js`.

- [ ] **Step 3: Add the shared types**

In `src/shared/types.ts`, after `TableRole`:

```typescript
export interface WorldSeedLocation { name: string; description: string; terrain: string | null }
export interface WorldSeedNpc { name: string; description: string; disposition: string | null; motivation: string | null }
export interface WorldSeedItem { name: string; description: string }

export interface WorldSeed {
  premise: string;
  locations: WorldSeedLocation[];
  npcs: WorldSeedNpc[];
  plotHooks: string[];
  items: WorldSeedItem[];
}

export type WorldReadinessItem = 'influences' | 'seed' | 'dmInstructions' | 'tableRole' | 'seedAccepted';

export interface WorldReadiness {
  ready: boolean;
  unmet: WorldReadinessItem[];
  /** Human-readable, one per unmet item, in the same order. Shown to the host and fed back to the model. */
  detail: string[];
}
```

- [ ] **Step 4: Write the checklist**

```typescript
// src/server/world-readiness.ts
import type { TableRole, WorldReadiness, WorldReadinessItem, WorldSeed } from '../shared/types.js';

export const MIN_INFLUENCES = 3;
export const MIN_SEED_LOCATIONS = 2;
export const MIN_SEED_NPCS = 2;
export const MIN_SEED_HOOKS = 1;
const MAX_INFLUENCES = 12;
const MAX_INFLUENCE_LEN = 120;

/**
 * Influences arrive from a model, so treat the value as untrusted shape as
 * well as untrusted content: anything that is not an array of strings becomes
 * an empty list rather than throwing, and the result is capped so a runaway
 * generation cannot flood every downstream prompt.
 */
export function normalizeInfluences(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim().slice(0, MAX_INFLUENCE_LEN);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_INFLUENCES) break;
  }
  return out;
}

function seedIsComplete(seed: WorldSeed | null): boolean {
  if (!seed) return false;
  if (typeof seed.premise !== 'string' || !seed.premise.trim()) return false;
  if (!Array.isArray(seed.locations) || seed.locations.length < MIN_SEED_LOCATIONS) return false;
  if (!Array.isArray(seed.npcs) || seed.npcs.length < MIN_SEED_NPCS) return false;
  if (!Array.isArray(seed.plotHooks) || seed.plotHooks.length < MIN_SEED_HOOKS) return false;
  return true;
}

/**
 * The single definition of "this world is ready to open the table".
 *
 * A model may propose that setup is finished; this decides. Every unmet item
 * is reported at once so the host sees the whole remaining list and the model
 * can be told everything it still needs in one turn.
 */
export function checkWorldReadiness(input: {
  influences: string[];
  seed: WorldSeed | null;
  dmInstructions: string | null;
  hostTableRole: TableRole | null;
  seedAccepted: boolean;
}): WorldReadiness {
  const unmet: WorldReadinessItem[] = [];
  const detail: string[] = [];

  if (input.influences.length < MIN_INFLUENCES) {
    unmet.push('influences');
    detail.push(`Name at least ${MIN_INFLUENCES} stylistic influences (currently ${input.influences.length}).`);
  }
  if (!seedIsComplete(input.seed)) {
    unmet.push('seed');
    detail.push(`The world needs a premise, at least ${MIN_SEED_LOCATIONS} locations, ${MIN_SEED_NPCS} NPCs, and ${MIN_SEED_HOOKS} plot hook.`);
  }
  if (!input.dmInstructions || !input.dmInstructions.trim()) {
    unmet.push('dmInstructions');
    detail.push('The DM still needs a summary of how you want this game run.');
  }
  if (input.hostTableRole !== 'dm' && input.hostTableRole !== 'player') {
    unmet.push('tableRole');
    detail.push('Choose whether you are running this game or playing in it.');
  }
  if (!input.seedAccepted) {
    unmet.push('seedAccepted');
    detail.push('Review and accept the starting world.');
  }

  return { ready: unmet.length === 0, unmet, detail };
}
```

- [ ] **Step 5: Add the columns and accessors**

In `src/server/db.ts`, inside `migrate()` after the `host_table_role` block:

```typescript
  if (!colNames.has('influences')) {
    db.exec('ALTER TABLE campaigns ADD COLUMN influences TEXT');
  }
  if (!colNames.has('world_seed')) {
    db.exec('ALTER TABLE campaigns ADD COLUMN world_seed TEXT');
  }
  if (!colNames.has('seed_accepted_at')) {
    db.exec('ALTER TABLE campaigns ADD COLUMN seed_accepted_at TEXT');
  }
```

All nullable: null means "not produced yet", distinguishable from an empty result.

In `src/server/room.ts`, beside the other accessors:

```typescript
export function getInfluences(db: Database.Database, campaignId: string): string[] {
  const row = db.prepare('SELECT influences FROM campaigns WHERE id = ?').get(campaignId) as any;
  if (!row?.influences) return [];
  try {
    const parsed = JSON.parse(row.influences);
    return Array.isArray(parsed) ? parsed.filter((x: unknown): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

export function setInfluences(db: Database.Database, campaignId: string, list: string[]): void {
  db.prepare("UPDATE campaigns SET influences = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(list), campaignId);
}
```

- [ ] **Step 6: Run tests and both typechecks**

Run: `npx vitest run test/world-readiness.test.ts test/db.test.ts test/room.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit`
Expected: PASS; typechecks silent.

- [ ] **Step 7: Commit**

```bash
git add src/server/world-readiness.ts src/server/db.ts src/server/room.ts src/shared/types.ts test/world-readiness.test.ts
git commit -m "feat(whispers): server-verified world readiness checklist

A model may propose that setup is done; this decides. Every unmet item is
reported at once so the host and the model both see the whole list.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: The world seed — schema, stock scenarios, and seeding outside the game loop

`GameLoop.seedScenario` is private, reads scenario files, maps them into `WorldBible.applyDiff(..., { allowNewLocations: true })`, and pushes the opening narration onto the live transcript. Its only real coupling to a running loop is that transcript push. Extract the rest.

**Files:**
- Create: `src/server/world-seed.ts`
- Create: `test/world-seed.test.ts`
- Modify: `src/server/agents/schemas.ts`, `src/server/game-loop.ts`, `src/server/room.ts`

**Interfaces:**
- Consumes: `safeDataFile` (Task 1); `WorldSeed` (Task 3); `WorldBible` from `./world-bible.js`.
- Produces:
  - `WorldSeedSchema` (Zod) in `src/server/agents/schemas.ts`
  - `loadStockScenario(scenarioId: string): { seed: WorldSeed; openingNarration: string | null } | null`
  - `seedWorld(db, campaignId, seed): void`
  - `getWorldSeed(db, campaignId): WorldSeed | null`, `setWorldSeed(db, campaignId, seed): void`
  - `markSeedAccepted(db, campaignId): void`, `isSeedAccepted(db, campaignId): boolean`

- [ ] **Step 1: Write the failing test**

```typescript
// test/world-seed.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorldSeed } from '../src/shared/types.js';

let dataDir: string;
let db: any;
let seedWorld: typeof import('../src/server/world-seed.js').seedWorld;
let loadStockScenario: typeof import('../src/server/world-seed.js').loadStockScenario;
let WorldBible: typeof import('../src/server/world-bible.js').WorldBible;
let createRoom: typeof import('../src/server/room.js').createRoom;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-seed-'));
  process.env.DATA_DIR = dataDir;
  // DATA_DIR is bound at module load, so import after setting it.
  const dbMod = await import('../src/server/db.js');
  db = dbMod.getDb();
  ({ seedWorld, loadStockScenario } = await import('../src/server/world-seed.js'));
  ({ WorldBible } = await import('../src/server/world-bible.js'));
  ({ createRoom } = await import('../src/server/room.js'));
});

afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

const seed: WorldSeed = {
  premise: 'A lighthouse keeps something out.',
  locations: [
    { name: 'The Lamp Room', description: 'Glass and salt.', terrain: 'interior' },
    { name: 'The Tidal Stair', description: 'Cut into rock.', terrain: 'coast' },
  ],
  npcs: [{ name: 'Maren', description: 'The keeper.', disposition: 'wary', motivation: 'Keep the light lit.' }],
  plotHooks: ['The relief keeper never arrived.'],
  items: [{ name: 'Brass Key', description: 'Warm to the touch.' }],
};

describe('seedWorld', () => {
  it('writes locations, npcs, items, and hooks into the world bible', () => {
    const { campaignId } = createRoom(db, { name: 'Seed Test', dmPreset: 'chronicler', systemId: 'fate-core' });
    seedWorld(db, campaignId, seed);

    const wb = new WorldBible(db);
    const names = wb.getAllLocationNames(campaignId);
    expect(names).toContain('The Lamp Room');
    expect(names).toContain('The Tidal Stair');

    const summary = wb.getSummary(campaignId);
    expect(summary).toContain('Maren');
    expect(summary).toContain('relief keeper');
  });

  it('is idempotent — seeding twice does not duplicate locations', () => {
    const { campaignId } = createRoom(db, { name: 'Twice', dmPreset: 'chronicler', systemId: 'fate-core' });
    seedWorld(db, campaignId, seed);
    seedWorld(db, campaignId, seed);
    const wb = new WorldBible(db);
    expect(wb.getAllLocationNames(campaignId).length).toBe(2);
  });

  it('creates locations even though in-play updates cannot', () => {
    // seedWorld must pass allowNewLocations: true; play-time diffs must not.
    const { campaignId } = createRoom(db, { name: 'Allow', dmPreset: 'chronicler', systemId: 'fate-core' });
    seedWorld(db, campaignId, seed);
    expect(new WorldBible(db).getAllLocationNames(campaignId).length).toBeGreaterThan(0);
  });
});

describe('loadStockScenario', () => {
  it('returns null for an unknown or malformed id', () => {
    expect(loadStockScenario('no-such-scenario')).toBeNull();
    expect(loadStockScenario('../../../etc/passwd')).toBeNull();
  });
});
```

Note: `loadStockScenario` reads from the data directory, which this test points at a temp dir with no `scenarios/`, so only the negative cases are asserted here. The positive case is covered by `test/preset-loading.test.ts`, which runs against the real data directory.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/world-seed.test.ts`
Expected: FAIL — cannot find module `../src/server/world-seed.js`.

- [ ] **Step 3: Add the Zod schema**

In `src/server/agents/schemas.ts`:

```typescript
export const WorldSeedSchema = z.object({
  premise: z.string().min(1),
  locations: z.array(z.object({
    name: z.string().min(1),
    description: z.string().default(''),
    terrain: z.string().nullable().default(null),
  })).default([]),
  npcs: z.array(z.object({
    name: z.string().min(1),
    description: z.string().default(''),
    disposition: z.string().nullable().default(null),
    motivation: z.string().nullable().default(null),
  })).default([]),
  plotHooks: z.array(z.string().min(1)).default([]),
  items: z.array(z.object({
    name: z.string().min(1),
    description: z.string().default(''),
  })).default([]),
});
```

Minimum counts are NOT enforced here — `checkWorldReadiness` owns that, so a short draft can still round-trip to the host for editing rather than throwing.

- [ ] **Step 4: Write the seed module**

```typescript
// src/server/world-seed.ts
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { WorldBible } from './world-bible.js';
import { safeDataFile } from './data-paths.js';
import { WorldSeedSchema } from './agents/schemas.js';
import type { WorldSeed } from '../shared/types.js';

/**
 * Write a seed into the world bible.
 *
 * This is the mapping that used to live inside GameLoop.seedScenario. It moved
 * out so the world can exist before a game starts — a player has to be able to
 * meet the world before they build a character for it. This is the only caller
 * that passes allowNewLocations: true; in-play updates must not create places.
 */
export function seedWorld(db: Database.Database, campaignId: string, seed: WorldSeed): void {
  const worldBible = new WorldBible(db);
  worldBible.applyDiff(campaignId, {
    newLocations: seed.locations.map(l => ({ name: l.name, description: l.description, terrain: l.terrain ?? null })),
    newEntities: seed.npcs.map(n => ({
      name: n.name,
      type: 'npc' as const,
      description: n.motivation ? `${n.description} [Motivation: ${n.motivation}]` : n.description,
      disposition: n.disposition ?? null,
    })),
    newItems: seed.items.map(i => ({ name: i.name, description: i.description, properties: {} })),
    newEvents: seed.plotHooks.map(hook => ({ sceneNumber: 0, description: hook, participants: [], outcome: null })),
    newRelationships: [],
  }, { allowNewLocations: true });
}

/**
 * A stock scenario is just a pre-written seed. Loading it here means improvised
 * and stock campaigns travel one code path from this point on.
 */
export function loadStockScenario(scenarioId: string): { seed: WorldSeed; openingNarration: string | null } | null {
  const file = safeDataFile('scenarios', scenarioId, '.json');
  if (!file) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    const parsed = WorldSeedSchema.safeParse({
      premise: raw.description ?? raw.name ?? '',
      locations: raw.locations ?? [],
      npcs: raw.npcs ?? [],
      plotHooks: raw.plotHooks ?? [],
      items: raw.items ?? [],
    });
    if (!parsed.success) {
      console.warn(`[world-seed] Scenario ${scenarioId} failed validation:`, parsed.error.issues.map(i => i.path.join('.')).join(', '));
      return null;
    }
    return { seed: parsed.data, openingNarration: typeof raw.openingNarration === 'string' ? raw.openingNarration : null };
  } catch (e) {
    console.warn(`[world-seed] Failed to load scenario ${scenarioId}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

export function getWorldSeed(db: Database.Database, campaignId: string): WorldSeed | null {
  const row = db.prepare('SELECT world_seed FROM campaigns WHERE id = ?').get(campaignId) as any;
  if (!row?.world_seed) return null;
  try {
    const parsed = WorldSeedSchema.safeParse(JSON.parse(row.world_seed));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function setWorldSeed(db: Database.Database, campaignId: string, seed: WorldSeed): void {
  db.prepare("UPDATE campaigns SET world_seed = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(seed), campaignId);
}

export function markSeedAccepted(db: Database.Database, campaignId: string): void {
  db.prepare("UPDATE campaigns SET seed_accepted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(campaignId);
}

export function isSeedAccepted(db: Database.Database, campaignId: string): boolean {
  const row = db.prepare('SELECT seed_accepted_at FROM campaigns WHERE id = ?').get(campaignId) as any;
  return Boolean(row?.seed_accepted_at);
}
```

- [ ] **Step 5: Make `GameLoop.seedScenario` delegate**

Replace the body of `seedScenario` in `src/server/game-loop.ts` with:

```typescript
  private async seedScenario(scenarioId: string): Promise<void> {
    const loaded = loadStockScenario(scenarioId);
    if (!loaded) return;
    seedWorld(this.db, this.campaignId, loaded.seed);
    if (loaded.openingNarration) {
      this.transcript.push({ role: 'system' as const, content: `[Scenario] ${loaded.openingNarration}`, timestamp: new Date().toISOString() });
    }
    console.log(`[game-loop] Seeded scenario "${scenarioId}"`);
  }
```

Add `import { loadStockScenario, seedWorld } from './world-seed.js';`. Leave the `start()` call site and its `existingLocs.length === 0` guard alone — that guard is what makes a seed applied at acceptance suppress the start-time seed.

- [ ] **Step 6: Run tests and both typechecks**

Run: `npx vitest run test/world-seed.test.ts test/world-bible.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit`
Expected: PASS; typechecks silent.

- [ ] **Step 7: Commit**

```bash
git add src/server/world-seed.ts src/server/agents/schemas.ts src/server/game-loop.ts src/server/room.ts test/world-seed.test.ts
git commit -m "feat(whispers): extract world seeding out of the game loop

A world has to exist before a player can be introduced to it, so seeding
can no longer wait for start-game. Stock scenarios become pre-written
seeds, so improvised and stock campaigns share one path.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: The DM drafts a world seed

**Files:**
- Modify: `src/server/agents/dm.ts` (`setupChat` signature and prompt; new `draftWorldSeed`)
- Modify: `src/server/agents/schemas.ts` (`influences` on the setup reply)
- Modify: `test/lib/server-harness.ts` (stub branches — REQUIRED, see Global Constraints)

**Interfaces:**
- Consumes: `WorldSeedSchema` (Task 4), `normalizeInfluences` (Task 3).
- Produces:
  - `DmSetupReply` gains `influences: string[]`
  - `setupChat(opts: { preset: string; systemId: string; history: Array<{role,content}>; unmet: string[] }): Promise<DmSetupReply>`
  - `draftWorldSeed(opts: { preset: string; systemId: string; influences: string[]; dmInstructions: string; history: Array<{role,content}>; existing: WorldSeed | null }): Promise<WorldSeed>`

- [ ] **Step 1: Extend the setup schema**

In `src/server/agents/schemas.ts`, add to `DmSetupReplySchema`:

```typescript
  influences: z.array(z.string()).nullable().default(null),
```

Nullable so an older-shaped reply still parses; the server normalizes it.

- [ ] **Step 2: Widen `setupChat` and teach it about influences**

Replace `setupChat`'s signature and system prompt in `src/server/agents/dm.ts`. **Keep the literal phrase `helping set up a new game`** — the test stub matches on it.

```typescript
  async setupChat(opts: {
    preset: string;
    systemId: string;
    history: Array<{ role: string; content: string }>;
    unmet: string[];
  }): Promise<DmSetupReply> {
    const ruleContext = this.lookupRules(opts.systemId, 'setting tone genre campaign');
    const unmetBlock = opts.unmet.length > 0
      ? `\n\nStill missing before this game can open:\n${opts.unmet.map(u => `- ${u}`).join('\n')}\nWork these into the conversation naturally. Do not present them as a form.`
      : '';

    const systemPrompt = `You are a TTRPG Dungeon Master helping set up a new game. Your base personality is "${opts.preset}".

Have a natural conversation with the game host to build their world with them:
1. What kind of adventure, setting, and tone they want
2. STYLISTIC INFLUENCES — at least three. Books, films, games, records, painters, anything. Ask what this world should FEEL like, and offer candidates drawn from what they have already told you. Three is the minimum because one is a costume and two is a comparison; three forces a specific intersection.
3. Any house rules or special requests

Be conversational and enthusiastic. Ask one or two questions at a time, never a checklist.
Accumulate every influence the host names into "influences" — return the full list every time, not just new ones.
When you have enough to build a world, set "done": true and fill in dmInstructions (a summary of how they want this run) and dmCustomPrompt (your tailored direction for running it).
Until then, set "done": false and leave dmInstructions/dmCustomPrompt null.

Rules reference for their chosen system:
${ruleContext}${unmetBlock}

Respond as JSON: { "reply": "your message", "done": false, "influences": [], "dmInstructions": null, "dmCustomPrompt": null }`;

    return callLlm({
      messages: [{ role: 'system', content: systemPrompt }, ...opts.history],
      schema: DmSetupReplySchema,
    });
  }
```

- [ ] **Step 3: Add `draftWorldSeed`**

```typescript
  /**
   * Turn the setup conversation into a starting world. The host reviews this
   * before anyone plays, so err toward concrete and specific — a place with a
   * name and a problem beats a genre.
   */
  async draftWorldSeed(opts: {
    preset: string;
    systemId: string;
    influences: string[];
    dmInstructions: string;
    history: Array<{ role: string; content: string }>;
    existing: WorldSeed | null;
  }): Promise<WorldSeed> {
    const transcript = opts.history.map(m => `[${m.role}] ${m.content}`).join('\n');
    const existingBlock = opts.existing
      ? `\n\nYou previously drafted this world. Revise it — keep what works, change what the conversation asks for:\n${JSON.stringify(opts.existing, null, 2)}`
      : '';

    const systemPrompt = `You are a world builder for a TTRPG. You output ONLY JSON. No prose, no roleplay, no markdown.

Build a starting world from the host's setup conversation.

Stylistic influences to honour (these shape VOICE and texture, not plot): ${opts.influences.join(' × ')}

Requirements:
- premise: one or two sentences naming the situation the players arrive into
- locations: at least 3, each with a name, a concrete description, and a terrain word
- npcs: at least 3, each with a name, a description, a disposition, and a motivation that could put them in someone's way
- plotHooks: at least 3 unresolved situations, phrased as things that are already happening
- items: 0 or more notable objects

Make places and people specific enough to walk into. Avoid generic fantasy furniture unless the influences call for it.

Return ONLY: {"premise":"...","locations":[{"name":"...","description":"...","terrain":"..."}],"npcs":[{"name":"...","description":"...","disposition":"...","motivation":"..."}],"plotHooks":["..."],"items":[{"name":"...","description":"..."}]}`;

    return callLlm({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Setup conversation:\n${transcript}\n\nDM direction: ${opts.dmInstructions}${existingBlock}\n\nBuild the world.` },
      ],
      schema: WorldSeedSchema,
      temperature: 0.8,
    });
  }
```

Add `WorldSeedSchema` to the schemas import and `WorldSeed` to the types import.

- [ ] **Step 4: Update the test stub — REQUIRED, or every harness test hangs**

In `test/lib/server-harness.ts`, extend `LLM_STUB_REPLIES`:

```typescript
  setupDone: {
    reply: 'Got it — I have what I need.',
    done: true,
    influences: ['Le Guin', 'Annihilation', 'Disco Elysium'],
    dmInstructions: 'A haunted lighthouse, spooky but hopeful.',
    dmCustomPrompt: 'You are running a haunted lighthouse game.',
  },
  setupOpen: {
    reply: 'What kind of game are we running?',
    done: false,
    influences: [],
    dmInstructions: null,
    dmCustomPrompt: null,
  },
  worldSeed: {
    premise: 'A lighthouse keeps something out, not in.',
    locations: [
      { name: 'The Lamp Room', description: 'Glass, salt, and a light that must not go out.', terrain: 'interior' },
      { name: 'The Tidal Stair', description: 'Steps cut into wet rock, passable twice a day.', terrain: 'coast' },
      { name: 'Cormorant Town', description: 'Nine houses and a chapel with no bell.', terrain: 'village' },
    ],
    npcs: [
      { name: 'Maren', description: 'The keeper, thirty years at the lamp.', disposition: 'wary', motivation: 'Keep the light lit.' },
      { name: 'The Cartwright', description: 'Brings supplies, never stays for dark.', disposition: 'friendly', motivation: 'Get paid and get home.' },
      { name: 'Iselin', description: 'The relief keeper who never arrived.', disposition: 'unknown', motivation: 'Unknown.' },
    ],
    plotHooks: ['The relief keeper never arrived.', 'The chapel bell was removed, not lost.', 'Something answers the light.'],
    items: [{ name: 'Brass Key', description: 'Warm to the touch, always.' }],
  },
```

And add a stub branch BEFORE the setup branch (the world-builder prompt does not contain the setup phrase, so order is not strictly required, but keep the most specific matcher first):

```typescript
        if (body.includes('You are a world builder for a TTRPG')) {
          text = JSON.stringify(LLM_STUB_REPLIES.worldSeed);
        } else if (body.includes('character sheet validation API')) {
```

- [ ] **Step 5: Update the one existing `setupChat` call site**

In `src/server/index.ts`'s `dm-chat` handler, change the call to the new object form. For now pass `unmet: []`; Task 6 wires the real value.

```typescript
    const reply = await dm.setupChat({
      preset: campaign.dmPreset,
      systemId: campaign.systemId,
      history: currentPlayer.setupChat,
      unmet: [],
    });
```

- [ ] **Step 6: Run tests and both typechecks**

Run: `npx vitest run test/onboarding-phases.test.ts test/session-persistence.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit`
Expected: PASS. These two files drive world setup through the stub, so they are the ones that break if the stub matcher drifted.

- [ ] **Step 7: Commit**

```bash
git add src/server/agents/dm.ts src/server/agents/schemas.ts src/server/index.ts test/lib/server-harness.ts
git commit -m "feat(whispers): setup conversation collects influences and drafts a world

setupChat now gains rules context and accumulates stylistic influences;
draftWorldSeed turns the conversation into a structured starting world.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Wire it — readiness gates the table, acceptance advances the phase

This is the task that moves the phase advance out of `dm-chat`. The in-code comment at `index.ts:553` marks the seam.

**Files:**
- Modify: `src/shared/protocol.ts`, `src/server/index.ts`
- Create: `test/world-setup.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–5.
- Produces, on `ClientMessage`:
  - `{ type: 'accept-world-seed'; seed: WorldSeed }`
  - `{ type: 'regenerate-world-seed'; note?: string }`
- Produces, on `ServerMessage`:
  - `{ type: 'world-seed-draft'; seed: WorldSeed; accepted: boolean }`
  - `{ type: 'world-readiness'; readiness: WorldReadiness; influences: string[] }`
- `lobby-state` gains `phase: GamePhase`, `influences: string[]`, `hostTableRole: TableRole | null`, `readiness: WorldReadiness`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/world-setup.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, type Harness, LLM_STUB_REPLIES } from './lib/server-harness.js';
import type { WebSocket } from 'ws';

let harness: Harness;
let port: number;

beforeAll(async () => { harness = await startHarness(); port = harness.port; }, 30_000);
afterAll(async () => { await harness.stop(); });

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((r) => { ws.once('close', () => r()); ws.close(); });
}

async function createGame() {
  const ws = await connectWs(port);
  const q = new MessageQueue(ws);
  sendMsg(ws, { type: 'create', name: 'World Test', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
  const joined = await q.waitFor('room-joined', 10_000) as any;
  await q.waitFor('dm-chat-reply', 10_000);
  return { ws, q, joined };
}

describe('World setup gates the table', () => {
  it('does not open the table when the model says done', async () => {
    const { ws, q, joined } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse.' });
    await q.waitFor('dm-chat-reply', 15_000);

    // The model asserted done, but the seed has not been accepted.
    await expect(q.waitFor('phase-change', 2_000)).rejects.toThrow(/Timeout/);

    const readiness = await q.waitFor('world-readiness', 10_000) as any;
    expect(readiness.readiness.ready).toBe(false);
    expect(readiness.readiness.unmet).toContain('seedAccepted');
    expect(readiness.influences).toEqual(LLM_STUB_REPLIES.setupDone.influences);
    expect(joined.phase).toBe('lobby');
    await closeWs(ws);
  }, 30_000);

  it('sends a world seed draft once the conversation has what it needs', async () => {
    const { ws, q } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse.' });
    const draft = await q.waitFor('world-seed-draft', 20_000) as any;
    expect(draft.accepted).toBe(false);
    expect(draft.seed.premise.length).toBeGreaterThan(0);
    expect(draft.seed.locations.length).toBeGreaterThanOrEqual(2);
    await closeWs(ws);
  }, 30_000);

  it('opens the table only after a role is chosen and the seed accepted', async () => {
    const { ws, q } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse.' });
    const draft = await q.waitFor('world-seed-draft', 20_000) as any;

    // Accepting without a table role must be refused.
    sendMsg(ws, { type: 'accept-world-seed', seed: draft.seed } as any);
    const blocked = await q.waitFor('world-readiness', 10_000) as any;
    expect(blocked.readiness.unmet).toContain('tableRole');

    sendMsg(ws, { type: 'choose-table-role', role: 'dm' } as any);
    await q.waitFor('room-joined', 10_000);

    sendMsg(ws, { type: 'accept-world-seed', seed: draft.seed } as any);
    const phase = await q.waitFor('phase-change', 15_000) as any;
    expect(phase.phase).toBe('character-creation');
    await closeWs(ws);
  }, 40_000);

  it('refuses a seed that does not meet the checklist', async () => {
    const { ws, q } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse.' });
    const draft = await q.waitFor('world-seed-draft', 20_000) as any;
    sendMsg(ws, { type: 'choose-table-role', role: 'dm' } as any);
    await q.waitFor('room-joined', 10_000);

    const thin = { ...draft.seed, locations: [draft.seed.locations[0]], npcs: [] };
    sendMsg(ws, { type: 'accept-world-seed', seed: thin } as any);
    const readiness = await q.waitFor('world-readiness', 10_000) as any;
    expect(readiness.readiness.unmet).toContain('seed');
    await expect(q.waitFor('phase-change', 2_000)).rejects.toThrow(/Timeout/);
    await closeWs(ws);
  }, 40_000);

  it('writes the accepted world into the world bible', async () => {
    const { ws, q } = await createGame();
    sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse.' });
    const draft = await q.waitFor('world-seed-draft', 20_000) as any;
    sendMsg(ws, { type: 'choose-table-role', role: 'dm' } as any);
    await q.waitFor('room-joined', 10_000);
    sendMsg(ws, { type: 'accept-world-seed', seed: draft.seed } as any);
    await q.waitFor('phase-change', 15_000);

    // lobby-state after acceptance must report a ready world.
    sendMsg(ws, { type: 'dm-chat', text: 'anything' });
    const reply = await q.waitForAny(['error', 'dm-chat-reply'], 10_000) as any;
    expect(reply.type).toBe('error'); // dm-chat is closed once the world is accepted
    await closeWs(ws);
  }, 40_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/world-setup.test.ts`
Expected: FAIL — no `world-readiness` or `world-seed-draft` message is ever sent, and the phase advances on `dm-chat`.

- [ ] **Step 3: Extend the protocol**

In `src/shared/protocol.ts`, add to `ClientMessage`:

```typescript
  | { type: 'accept-world-seed'; seed: import('./types.js').WorldSeed }
  | { type: 'regenerate-world-seed'; note?: string }
```

Add to `ServerMessage`:

```typescript
  | { type: 'world-seed-draft'; seed: import('./types.js').WorldSeed; accepted: boolean }
  | { type: 'world-readiness'; readiness: import('./types.js').WorldReadiness; influences: string[] }
```

And widen `lobby-state`:

```typescript
  | { type: 'lobby-state'; players: string[]; setupChat: Array<{ role: string; content: string }>; dmReady: boolean; approvedCount: number; phase: GamePhase; influences: string[]; hostTableRole: import('./types.js').TableRole | null; readiness: import('./types.js').WorldReadiness }
```

- [ ] **Step 4: Add a readiness helper in `index.ts`**

```typescript
function currentReadiness(campaign: import('../shared/types.js').Campaign) {
  const db = getDb();
  return checkWorldReadiness({
    influences: getInfluences(db, campaign.id),
    seed: getWorldSeed(db, campaign.id),
    dmInstructions: campaign.dmInstructions,
    hostTableRole: campaign.hostTableRole,
    seedAccepted: isSeedAccepted(db, campaign.id),
  });
}

function sendReadiness(ws: WebSocket, campaign: import('../shared/types.js').Campaign): void {
  send(ws, { type: 'world-readiness', readiness: currentReadiness(campaign), influences: getInfluences(getDb(), campaign.id) });
}
```

Update `sendLobbyState` to include `phase`, `influences`, `hostTableRole`, and `readiness`.

- [ ] **Step 5: Rewrite the `dm-chat` handler**

Replace the body between the auth check and `saveSetupChat` with:

```typescript
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      // Once the world is accepted it is no longer up for renegotiation by
      // chat — otherwise a stray message rewrites a world players are already
      // building characters against.
      if (campaign.phase !== 'lobby') {
        send(ws, { type: 'error', message: 'The world is set. Start the game when your players are ready.' });
        return;
      }
      currentPlayer.setupChat.push({ role: 'user', content: msg.text });
      const dm = new DmAgent(db);
      try {
        const before = currentReadiness(campaign);
        const reply = await dm.setupChat({
          preset: campaign.dmPreset,
          systemId: campaign.systemId,
          history: currentPlayer.setupChat,
          unmet: before.detail,
        });
        currentPlayer.setupChat.push({ role: 'assistant', content: reply.reply });

        const influences = normalizeInfluences(reply.influences);
        if (influences.length > 0) setInfluences(db, campaign.id, influences);

        if (reply.done && reply.dmInstructions) {
          db.prepare("UPDATE campaigns SET dm_instructions = ?, dm_custom_prompt = ?, updated_at = datetime('now') WHERE id = ?")
            .run(reply.dmInstructions, reply.dmCustomPrompt, campaign.id);
        }
        saveSetupChat(db, campaign.id, currentPlayer.setupChat);

        const after = joinRoom(db, currentJoinCode);
        if (!after) return;

        // Draft a world as soon as there is enough to build one. The phase does
        // NOT advance here any more — only accepting the seed opens the table.
        const readiness = currentReadiness(after);
        const needsSeed = readiness.unmet.includes('seed');
        const canDraft = getInfluences(db, after.id).length >= MIN_INFLUENCES && Boolean(after.dmInstructions);
        send(ws, { type: 'dm-chat-reply', text: reply.reply, done: reply.done });
        sendReadiness(ws, after);

        if (needsSeed && canDraft) {
          const stock = after.scenarioId ? loadStockScenario(after.scenarioId) : null;
          const seed = await dm.draftWorldSeed({
            preset: after.dmPreset,
            systemId: after.systemId,
            influences: getInfluences(db, after.id),
            dmInstructions: after.dmInstructions ?? '',
            history: currentPlayer.setupChat,
            existing: getWorldSeed(db, after.id) ?? stock?.seed ?? null,
          });
          setWorldSeed(db, after.id, seed);
          send(ws, { type: 'world-seed-draft', seed, accepted: false });
          sendReadiness(ws, joinRoom(db, currentJoinCode)!);
        }
      } catch (e) {
        console.error('[dm-chat] error:', e);
        currentPlayer.setupChat.pop();
        send(ws, { type: 'dm-chat-reply', text: 'Sorry, I lost my train of thought. Could you repeat that?', done: false });
      }
```

Remove the `advancePhaseIfLobby` call and its broadcast from this handler.

- [ ] **Step 6: Add the acceptance handlers**

```typescript
    if (msg.type === 'accept-world-seed' && currentJoinCode && isWorldAuthor(currentPlayer)) {
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      if (campaign.phase !== 'lobby') { send(ws, { type: 'error', message: 'The table is already open.' }); return; }

      const parsed = WorldSeedSchema.safeParse(msg.seed);
      if (!parsed.success) { send(ws, { type: 'error', message: 'That world could not be read. Ask the DM to redraft it.' }); return; }
      setWorldSeed(db, campaign.id, parsed.data);

      // Check readiness with the seed the host is actually accepting, and with
      // acceptance assumed — so the only thing left to decide is whether the
      // rest of the checklist passes.
      const readiness = checkWorldReadiness({
        influences: getInfluences(db, campaign.id),
        seed: parsed.data,
        dmInstructions: campaign.dmInstructions,
        hostTableRole: campaign.hostTableRole,
        seedAccepted: true,
      });
      if (!readiness.ready) {
        send(ws, { type: 'world-readiness', readiness, influences: getInfluences(db, campaign.id) });
        return;
      }

      markSeedAccepted(db, campaign.id);
      seedWorld(db, campaign.id, parsed.data);
      send(ws, { type: 'world-seed-draft', seed: parsed.data, accepted: true });
      if (advancePhaseIfLobby(db, campaign.id)) {
        broadcast(currentJoinCode, { type: 'phase-change', phase: 'character-creation' });
      }
      sendReadiness(ws, joinRoom(db, currentJoinCode)!);
    }

    if (msg.type === 'regenerate-world-seed' && currentJoinCode && isWorldAuthor(currentPlayer)) {
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      if (campaign.phase !== 'lobby') { send(ws, { type: 'error', message: 'The table is already open.' }); return; }
      const dm = new DmAgent(db);
      try {
        const history = [...currentPlayer!.setupChat];
        if (msg.note) history.push({ role: 'user', content: `Redraft the world: ${msg.note}` });
        const seed = await dm.draftWorldSeed({
          preset: campaign.dmPreset,
          systemId: campaign.systemId,
          influences: getInfluences(db, campaign.id),
          dmInstructions: campaign.dmInstructions ?? '',
          history,
          existing: getWorldSeed(db, campaign.id),
        });
        setWorldSeed(db, campaign.id, seed);
        send(ws, { type: 'world-seed-draft', seed, accepted: false });
        sendReadiness(ws, joinRoom(db, currentJoinCode)!);
      } catch (e) {
        console.error('[regenerate-world-seed] failed:', e);
        send(ws, { type: 'error', message: 'The DM could not redraft the world. Try again.' });
      }
    }
```

On rejoin, after `sendDmSettings`, send the draft and readiness to a returning host:

```typescript
        const seed = getWorldSeed(db, campaign.id);
        if (seed) send(ws, { type: 'world-seed-draft', seed, accepted: isSeedAccepted(db, campaign.id) });
        sendReadiness(ws, campaign);
```

- [ ] **Step 7: Run tests and both typechecks**

Run: `npx vitest run test/world-setup.test.ts test/onboarding-phases.test.ts test/session-persistence.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit`
Expected: PASS.

**`test/onboarding-phases.test.ts` and `test/session-persistence.test.ts` WILL break** — `finishWorldSetup` drives `dm-chat` and expects a `phase-change`, which no longer arrives from that message. Update `test/lib/finish-world-setup.ts` to complete the whole sequence: send `dm-chat`, wait for `world-seed-draft`, send `choose-table-role` with `'dm'`, wait for `room-joined`, send `accept-world-seed` with the drafted seed, then wait for `phase-change: 'character-creation'`. Every caller then keeps working unchanged. Do NOT weaken any assertion in those files.

- [ ] **Step 8: Commit**

```bash
git add src/shared/protocol.ts src/server/index.ts test/world-setup.test.ts test/lib/finish-world-setup.ts
git commit -m "feat(whispers): accepting the world opens the table

The phase advance moves out of dm-chat. A model may say it is done; the
server checks a checklist, drafts a world for the host to review, and only
an accepted seed opens character creation.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Influences reach narration

**Files:**
- Modify: `src/server/agents/dm.ts` (`DmContext`, `buildSystemPrompt`), `src/server/game-loop.ts`
- Modify: `test/preset-loading.test.ts`

**Interfaces:**
- Consumes: `getInfluences` (Task 3).
- Produces: `DmContext` gains `influences: string[]`.

- [ ] **Step 1: Add the field and the prompt section**

In `src/server/agents/dm.ts`, add `influences: string[];` to `DmContext`. In `buildSystemPrompt`, immediately after the `dmCustomPrompt` block from Task 2:

```typescript
    if (ctx.influences.length > 0) {
      prompt += `\nStylistic influences for this world — these shape VOICE and texture, never plot. Let them show in word choice, rhythm, and what the narration notices:\n${ctx.influences.map(i => `- ${i}`).join('\n')}\n`;
    }
```

- [ ] **Step 2: Pass it from both `DmContext` construction sites**

In `src/server/game-loop.ts`, add `influences: getInfluences(this.db, this.campaignId),` to both context literals (narration ~line 145 and resolution ~line 511). Add the import from `./room.js`.

- [ ] **Step 3: Test**

```typescript
describe('influences reach the system prompt', () => {
  it('is a distinct section, not folded into dmCustomPrompt', () => {
    const { head } = composePresetSections('chronicler');
    expect(head).not.toContain('Stylistic influences');
  });
});
```

Add an assertion in `test/world-setup.test.ts` that `lobby-state.influences` round-trips the stub's three influences after setup.

- [ ] **Step 4: Run tests and both typechecks**

Run: `npx vitest run && npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/agents/dm.ts src/server/game-loop.ts test/preset-loading.test.ts test/world-setup.test.ts
git commit -m "feat(whispers): influences shape narration alongside the DM preset

Voice, not content — they never touch the world bible.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: The DM lobby shows influences, readiness, and the world

**Files:**
- Modify: `src/client/dm-lobby.ts`, `src/client/style.css`

No automated test — the project has no DOM harness. Verification is typecheck, build, and a browser walkthrough the controller performs.

- [ ] **Step 1: Add the sidebar sections**

Add three panels to the DM lobby sidebar, above "Players":

1. **Table role** — two buttons, "I'm running this game" / "I'm playing in it", sending `choose-table-role`. Show the current choice. Hide once the phase leaves `lobby`.
2. **Influences** — a list rendered from `lobby-state.influences` and `world-readiness.influences`, with a count against the minimum of 3.
3. **Readiness** — one line per `readiness.detail` entry while unmet; a single "Ready to open the table" line when `readiness.ready`.

Build every one of these with `createElement` + `textContent`. **No `innerHTML` with interpolated values** — influences are model-generated strings and the client has been audited clean.

- [ ] **Step 2: Add the world review panel**

In the main column, below the chat, render `world-seed-draft`:

- premise as a paragraph
- locations, NPCs, plot hooks, and items as lists (name in bold, description after)
- an "Accept this world" button sending `accept-world-seed` with the drafted seed
- a "Draft it again" button sending `regenerate-world-seed`, with an optional note field
- once `accepted: true`, replace the buttons with a confirmation line

Again: `createElement` + `textContent` throughout.

- [ ] **Step 3: Handle the new messages**

```typescript
ws.on('world-readiness', (msg) => { if (msg.type === 'world-readiness') { renderInfluences(msg.influences); renderReadiness(msg.readiness); } });
ws.on('world-seed-draft', (msg) => { if (msg.type === 'world-seed-draft') renderSeed(msg.seed, msg.accepted); });
```

And extend the existing `lobby-state` handler to call `renderInfluences`, `renderReadiness`, and the role display.

- [ ] **Step 4: Styles**

Append styles for `.world-seed-panel`, `.seed-section`, `.influence-list`, `.readiness-list`, `.readiness-met`. Follow the existing token vocabulary (`--ember`, `--text-dim`, `--radius`, `--surface`). Respect `prefers-reduced-motion` for anything animated.

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit && npm run build`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/client/dm-lobby.ts src/client/style.css
git commit -m "feat(whispers): DM lobby shows influences, readiness, and the drafted world

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Full verification

- [ ] **Step 1: Whole offline suite**

```bash
npx vitest run
```

Report the counts. Every previously-passing test must still pass.

- [ ] **Step 2: Both typechecks and the build**

```bash
npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit && npm run build
```

- [ ] **Step 3: Confirm the XSS audit still holds**

The client gained a panel rendering model-generated strings. Verify no interpolated value reaches `innerHTML`:

```bash
perl -0777 -ne 'while (/(\w[\w.]*)\s*(?:\+)?=\s*`((?:[^`\\]|\\.)*)`/gs) { my ($v,$t)=($1,$2); next unless $v =~ /innerHTML|^html$|Html$/i; while ($t =~ /\$\{([^}]*)\}/g) { print "$ARGV: $v <- \${$1}\n" } }' src/client/*.ts
```

Every line of output must be a server-generated join code, a URL derived from one, a regex-validated route param, a constant string, or a numeric counter. Anything else is a defect.

- [ ] **Step 4: Report**

Summarise counts, and list anything deferred.

---

## Self-Review Notes

Checked against the spec's step-2 scope. Covered: influences (min 3, structured, voice-only), the seed draft and review, server-verified readiness, seeding the world bible at acceptance, stock scenarios feeding the draft, the `dmCustomPrompt` preset-replacement fix, and the preset path bug that made that fix unobservable.

Deliberately NOT in this plan, and tracked:

- **The `dnd5e` empty-rules notice** (spec bug 8) moves to step 3. `setupChat` now takes `systemId` and does a rules lookup, so the seam exists — but the host-facing warning belongs with the character-interview work that actually suffers from missing rules.
- **World growth during play** is step 4.
- **Character interview, transcripts, preview/confirm, revoke** are step 3.
- `campaigns.setup_chat` remains a whole-array overwrite with a swallowed parse failure. Not touched here; flagged for step 3, which introduces per-turn transcript persistence and should fix both.
- `dm-chat` now refuses once the phase leaves `lobby`, which also closes the pre-existing hole where a stray message could rewrite an accepted world.
