# Whispers Character Interview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the conversation itself build the character. The AI DM introduces a player to the world that now exists, interviews them with a mix of direct and indirect questions, and the player confirms a sheet they watched being written — with the raw transcript kept, not just the result.

**Architecture:** `interviewForCharacter` gains the world (premise, influences, seeded locations and NPCs) and a server-computed list of what the sheet still needs. A new `character-readiness` module mirrors `world-readiness`: the model may propose a definition, the server decides whether it is complete. Interview transcripts move out of process memory into a `character_interviews` table, persisted per turn, and are replayed on rejoin. A preview/confirm step lands between "the model wrote a sheet" and "the sheet is submitted".

**Tech Stack:** TypeScript, Express 5, `ws`, better-sqlite3, Zod, Vitest, vanilla DOM client (Vite).

**Spec:** `docs/superpowers/specs/2026-09-12-whispers-onboarding-design.md` (build step 3, first half)

**Predecessors:** build step 1 (`d6589ee`), build step 2 (`7d9590c`)

**Sibling plan, NOT this one:** the approve/revoke split by table role, closing the host-as-player dead end, and terminating negotiations are build step 3b. This plan must not change `host-approve-character`, `host-reject-character`, `hasDmAuthority`, or `NegotiationRoom`.

## Global Constraints

- Server is authoritative for all game state. Clients never write phase.
- All agent outputs validated with Zod before affecting state.
- **Completion is server-verified, not model-asserted.** The model may propose a definition; the server decides whether it is complete, and tells the model what is missing.
- On malformed model output, coerce toward "not ready" — never toward "ready" or "approved".
- Store the raw conversation, not only what was derived from it.
- No `NOT NULL DEFAULT ''` columns where the empty string would be indistinguishable from a generation failure.
- DB migrations are additive only.
- Never remove a feature. The "Build here" and "Paste markdown" tabs stay.
- No model-generated or player-typed string may reach `innerHTML`. Build DOM with `createElement` + `textContent`.
- Every behavioural change lands with a test that failed before it.
- Tests must not require a live LLM.
- BOTH `npx tsc --noEmit` AND `npx tsc -p tsconfig.server.json --noEmit` must pass. The first does NOT cover `src/server`.
- Commit after each task. Branch: `feat/whispers-agentic-ttrpg`. Do not push until the final review.

### Three traps specific to this plan

**1. The test stub has no branch for the interview prompt.** `test/lib/server-harness.ts` matches on substrings and `interviewForCharacter`'s prompt matches none of them, so every harness `char-chat` today falls through to a plain string, fails JSON repair, burns four `callLlm` retries and returns the handler's error fallback. Nothing about interviews is testable until Task 1 fixes this. Note the existing `setupChat` branch keys on `'"role":"user"'` appearing anywhere in the body — keep the interview branch's matcher distinct from the other three so they cannot collide.

**2. The harness `DATA_DIR` is an empty temp directory.** No presets, no scenarios, no rule chunks. `lookupRules` always returns `'(No rules found for this query)'` inside harness tests. Do not write an assertion that depends on real rules or preset content loading.

**3. The form tab ships pre-filled with a complete, valid character.** "Sigmund the Bold" with a full default skill pyramid. Any readiness checklist you write passes it without the player typing anything, and both the form and paste paths silently inject `{Notice:2, Fight:1, Stealth:1}` when skills are empty — so a "needs at least one skill" rule can never fail from the client. Task 7 addresses the defaults; until then, do not mistake a passing form submission for a working checklist.

---

## File Structure

| File | Responsibility |
|---|---|
| `test/lib/server-harness.ts` | **Modify.** A stub branch and fixture for the interview, and for the world introduction. |
| `src/server/character-readiness.ts` | **Create.** Pure checklist for a character definition. The single definition of "is this sheet finished". |
| `src/server/character-interview.ts` | **Create.** Transcript persistence and the interview record's lifecycle. |
| `src/server/db.ts` | **Modify.** The `character_interviews` table. |
| `src/server/agents/dm.ts` | **Modify.** Widen `interviewForCharacter`; add `introduceWorld`. |
| `src/server/agents/schemas.ts` | **Modify.** Tighten `CharInterviewReplySchema`. |
| `src/server/index.ts` | **Modify.** Rewrite `char-chat`; add `confirm-character`; send the introduction; gate on phase properly. |
| `src/shared/protocol.ts` | **Modify.** `world-introduction`, `character-preview`, `character-readiness`, `confirm-character`, `interview-replay`. |
| `src/shared/types.ts` | **Modify.** `CharacterReadiness`. |
| `src/client/character-creator.ts` | **Modify.** Introduction, preview/confirm, conversation as the default tab, transcript replay. |
| `test/character-readiness.test.ts` | **Create.** Pure unit tests. |
| `test/character-interview.test.ts` | **Create.** End-to-end: introduction, interview, readiness refusal, preview, confirm, transcript survival. |

---

## Task 1: Teach the test stub about interviews

Nothing in this plan is testable until the harness can answer an interview prompt. Do this first and alone.

**Files:**
- Modify: `test/lib/server-harness.ts`

**Interfaces:**
- Produces: `LLM_STUB_REPLIES.charInterviewOpen`, `LLM_STUB_REPLIES.charInterviewDone`, `LLM_STUB_REPLIES.worldIntroduction`

- [ ] **Step 1: Add the fixtures**

```typescript
  charInterviewOpen: {
    reply: 'You are standing at the edge of the tailing field watching the dust come in. What are you thinking about?',
    definition: null,
  },
  charInterviewDone: {
    reply: 'Here is who I think you are.',
    definition: {
      name: 'Vesper Ash',
      highConcept: 'Lighthouse Keeper Who Stopped Believing',
      trouble: 'Owes the Ledger Cult a debt she cannot name',
      aspects: ['Maps are promises', 'Never looks back'],
      personality: 'Quiet, stubborn, allergic to comfort.',
      backstory: 'Thirty years at the lamp and one night she did not climb the stair.',
      skills: { Will: 3, Notice: 2, Lore: 1 },
      stunts: ['Steady Hand: +2 to Will against fear.'],
    },
  },
  worldIntroduction: {
    text: 'The lamp has been lit every night for thirty years. Tonight the relief keeper did not arrive, and the chapel below has no bell to ring.',
  },
```

- [ ] **Step 2: Add the branches**

Insert BEFORE the existing `character sheet validation API` branch, so the most specific matchers come first:

```typescript
        if (body.includes('You are a world builder for a TTRPG')) {
          text = JSON.stringify(LLM_STUB_REPLIES.worldSeed);
        } else if (body.includes('introducing a player to a world')) {
          text = JSON.stringify(LLM_STUB_REPLIES.worldIntroduction);
        } else if (body.includes('character creation API')) {
          // The interview turns "done" once the player has answered twice, so a
          // test can drive it deterministically instead of guessing turn counts.
          const playerTurns = (body.match(/"role":"user"/g) ?? []).length;
          text = JSON.stringify(playerTurns >= 2 ? LLM_STUB_REPLIES.charInterviewDone : LLM_STUB_REPLIES.charInterviewOpen);
        } else if (body.includes('character sheet validation API')) {
```

Note the `setupChat` branch also counts on `'"role":"user"'`; keeping `character creation API` ahead of it is what prevents a collision, since the interview prompt does not contain `helping set up a new game`.

- [ ] **Step 3: Prove the branch is reachable**

Run: `npx vitest run test/onboarding-phases.test.ts test/world-setup.test.ts`
Expected: PASS, unchanged. These do not send `char-chat`, so this step only proves you did not break the existing matchers.

- [ ] **Step 4: Both typechecks**

Run: `npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit`

- [ ] **Step 5: Commit**

```bash
git add test/lib/server-harness.ts
git commit -m "test(whispers): teach the LLM stub to answer interview prompts

Every harness char-chat previously fell through to a plain string, burned
four retries and returned the error fallback, so nothing about character
interviews could be tested at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: The character readiness checklist

Mirror `world-readiness.ts`. The model proposes a definition; this decides whether it is finished.

**Files:**
- Create: `src/server/character-readiness.ts`
- Create: `test/character-readiness.test.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- Produces:
  - `type CharacterReadinessItem = 'name' | 'highConcept' | 'trouble' | 'aspects' | 'skills' | 'stunts'`
  - `interface CharacterReadiness { ready: boolean; unmet: CharacterReadinessItem[]; detail: string[] }`
  - `checkCharacterReadiness(def: unknown): CharacterReadiness`
  - `MIN_ASPECTS = 2`, `MIN_SKILLS = 1`, `MIN_STUNTS = 1`

- [ ] **Step 1: Write the failing test**

```typescript
// test/character-readiness.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/character-readiness.test.ts`
Expected: FAIL — cannot find module `../src/server/character-readiness.js`.

- [ ] **Step 3: Add the shared types**

In `src/shared/types.ts`, after `WorldReadiness`:

```typescript
export type CharacterReadinessItem = 'name' | 'highConcept' | 'trouble' | 'aspects' | 'skills' | 'stunts';

export interface CharacterReadiness {
  ready: boolean;
  unmet: CharacterReadinessItem[];
  /** Human-readable, one per unmet item, in the same order. Shown to the player and fed back to the model. */
  detail: string[];
}
```

- [ ] **Step 4: Write the checklist**

```typescript
// src/server/character-readiness.ts
import type { CharacterReadiness, CharacterReadinessItem } from '../shared/types.js';

export const MIN_ASPECTS = 2;
export const MIN_SKILLS = 1;
export const MIN_STUNTS = 1;

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function countNonEmptyStrings(v: unknown): number {
  if (!Array.isArray(v)) return 0;
  return v.filter(isNonEmptyString).length;
}

function countNumericSkills(v: unknown): number {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 0;
  return Object.entries(v as Record<string, unknown>)
    .filter(([name, rating]) => isNonEmptyString(name) && typeof rating === 'number' && Number.isFinite(rating))
    .length;
}

/**
 * The single definition of "this character sheet is finished".
 *
 * Takes `unknown` on purpose: the definition arrives from a model, so its
 * shape is as untrusted as its content. Nothing here may throw, and every
 * failure direction resolves to "not ready" — a sheet wrongly called finished
 * puts a hollow character at the table, which is the failure that matters.
 */
export function checkCharacterReadiness(def: unknown): CharacterReadiness {
  const unmet: CharacterReadinessItem[] = [];
  const detail: string[] = [];
  const d = (def && typeof def === 'object' && !Array.isArray(def)) ? def as Record<string, unknown> : {};

  if (!isNonEmptyString(d.name)) {
    unmet.push('name');
    detail.push('They still need a name.');
  }
  if (!isNonEmptyString(d.highConcept)) {
    unmet.push('highConcept');
    detail.push('What is this character, in a phrase? A high concept.');
  }
  if (!isNonEmptyString(d.trouble)) {
    unmet.push('trouble');
    detail.push('What complicates their life? A trouble that creates real dilemmas.');
  }
  if (countNonEmptyStrings(d.aspects) < MIN_ASPECTS) {
    unmet.push('aspects');
    detail.push(`They need at least ${MIN_ASPECTS} aspects — things that are true about them and can be leaned on.`);
  }
  if (countNumericSkills(d.skills) < MIN_SKILLS) {
    unmet.push('skills');
    detail.push(`They need at least ${MIN_SKILLS} skill with a rating.`);
  }
  if (countNonEmptyStrings(d.stunts) < MIN_STUNTS) {
    unmet.push('stunts');
    detail.push(`They need at least ${MIN_STUNTS} stunt — something they can do that others cannot.`);
  }

  return { ready: unmet.length === 0, unmet, detail };
}
```

- [ ] **Step 5: Run tests and both typechecks**

Run: `npx vitest run test/character-readiness.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/server/character-readiness.ts src/shared/types.ts test/character-readiness.test.ts
git commit -m "feat(whispers): server-verified character readiness checklist

The model may propose a sheet; this decides whether it is finished, and
reports every missing piece at once so the interview can ask for them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Interview transcripts that survive a refresh

Today a player's interview lives only in `ConnectedPlayer.charChat`, in process memory. The close handler splices the seat out immediately, so a browser refresh rebuilds it as `[]` — the conversation is gone, and there is no message that could replay it.

**Files:**
- Create: `src/server/character-interview.ts`
- Create: `test/character-interview.test.ts` (the persistence half; the end-to-end half arrives in Task 5)
- Modify: `src/server/db.ts`

**Interfaces:**
- Produces:
  - `interface InterviewRecord { id: string; campaignId: string; sessionToken: string; transcript: Array<{ role: string; content: string }>; definition: CharacterDefinition | null; status: 'open' | 'confirmed' | 'live' | 'revoked' }`
  - `getOrCreateInterview(db, campaignId, sessionToken): InterviewRecord`
  - `appendInterviewTurn(db, id, turn): void`
  - `setInterviewDefinition(db, id, def): void`
  - `setInterviewStatus(db, id, status): void`
  - `getInterviewBySession(db, campaignId, sessionToken): InterviewRecord | null`

- [ ] **Step 1: Write the failing test**

```typescript
// test/character-interview.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let db: any;
let mod: typeof import('../src/server/character-interview.js');
let createRoom: typeof import('../src/server/room.js').createRoom;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-interview-'));
  process.env.DATA_DIR = dataDir;
  // DATA_DIR is bound at module load, so import after setting it.
  db = (await import('../src/server/db.js')).getDb();
  mod = await import('../src/server/character-interview.js');
  ({ createRoom } = await import('../src/server/room.js'));
});

afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

function newCampaign() {
  return createRoom(db, { name: 'Interview Test', dmPreset: 'chronicler', systemId: 'fate-core' }).campaignId;
}

describe('interview persistence', () => {
  it('creates one record per session and returns the same one afterwards', () => {
    const c = newCampaign();
    const a = mod.getOrCreateInterview(db, c, 'token-a');
    const b = mod.getOrCreateInterview(db, c, 'token-a');
    expect(b.id).toBe(a.id);
    expect(mod.getOrCreateInterview(db, c, 'token-b').id).not.toBe(a.id);
  });

  it('appends turns in order and survives a fresh read', () => {
    const c = newCampaign();
    const rec = mod.getOrCreateInterview(db, c, 'tok');
    mod.appendInterviewTurn(db, rec.id, { role: 'assistant', content: 'What are you thinking about?' });
    mod.appendInterviewTurn(db, rec.id, { role: 'user', content: 'The dust.' });

    const read = mod.getInterviewBySession(db, c, 'tok')!;
    expect(read.transcript.map(t => t.content)).toEqual(['What are you thinking about?', 'The dust.']);
  });

  it('stores a derived definition and a status', () => {
    const c = newCampaign();
    const rec = mod.getOrCreateInterview(db, c, 'tok');
    expect(rec.definition).toBeNull();
    expect(rec.status).toBe('open');

    mod.setInterviewDefinition(db, rec.id, { name: 'Vesper Ash' } as any);
    mod.setInterviewStatus(db, rec.id, 'confirmed');

    const read = mod.getInterviewBySession(db, c, 'tok')!;
    expect(read.definition?.name).toBe('Vesper Ash');
    expect(read.status).toBe('confirmed');
  });

  it('keeps the transcript after the definition is derived — the raw conversation is the point', () => {
    const c = newCampaign();
    const rec = mod.getOrCreateInterview(db, c, 'tok');
    mod.appendInterviewTurn(db, rec.id, { role: 'user', content: 'I never look back.' });
    mod.setInterviewDefinition(db, rec.id, { name: 'Vesper Ash' } as any);
    mod.setInterviewStatus(db, rec.id, 'live');

    const read = mod.getInterviewBySession(db, c, 'tok')!;
    expect(read.transcript).toHaveLength(1);
    expect(read.transcript[0]!.content).toBe('I never look back.');
  });

  it('degrades to an empty transcript rather than throwing on corrupt JSON', () => {
    const c = newCampaign();
    const rec = mod.getOrCreateInterview(db, c, 'tok');
    db.prepare('UPDATE character_interviews SET transcript = ? WHERE id = ?').run('not json{', rec.id);
    const read = mod.getInterviewBySession(db, c, 'tok')!;
    expect(read.transcript).toEqual([]);
  });

  it('returns null for a session that has no interview', () => {
    expect(mod.getInterviewBySession(db, newCampaign(), 'nobody')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/character-interview.test.ts`
Expected: FAIL — cannot find module `../src/server/character-interview.js`.

- [ ] **Step 3: Add the table**

In `src/server/db.ts`, inside `migrate()`'s main `db.exec` block, after `pending_characters`:

```sql
    CREATE TABLE IF NOT EXISTS character_interviews (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      session_token TEXT NOT NULL,
      transcript TEXT NOT NULL DEFAULT '[]',
      definition TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_interview_session ON character_interviews(campaign_id, session_token);
```

`definition` is nullable — null means "not derived yet", which must stay distinguishable from a derivation that produced nothing. `transcript` defaults to `'[]'` rather than `''` so an empty conversation is a valid document rather than a parse failure.

- [ ] **Step 4: Write the module**

```typescript
// src/server/character-interview.ts
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../shared/types.js';

export type InterviewStatus = 'open' | 'confirmed' | 'live' | 'revoked';

export interface InterviewTurn { role: string; content: string }

export interface InterviewRecord {
  id: string;
  campaignId: string;
  sessionToken: string;
  transcript: InterviewTurn[];
  definition: CharacterDefinition | null;
  status: InterviewStatus;
}

function parseTranscript(raw: unknown, id: string): InterviewTurn[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is InterviewTurn =>
      Boolean(t) && typeof t === 'object' && typeof t.role === 'string' && typeof t.content === 'string');
  } catch {
    console.warn(`[interview] corrupt transcript JSON for interview ${id}`);
    return [];
  }
}

function rowToRecord(row: any): InterviewRecord {
  let definition: CharacterDefinition | null = null;
  if (row.definition) {
    try { definition = JSON.parse(row.definition); }
    catch { console.warn(`[interview] corrupt definition JSON for interview ${row.id}`); }
  }
  return {
    id: row.id,
    campaignId: row.campaign_id,
    sessionToken: row.session_token,
    transcript: parseTranscript(row.transcript, row.id),
    definition,
    status: row.status,
  };
}

/**
 * One interview per player per campaign, keyed on the durable session token.
 *
 * The transcript lived in process memory until now, so a browser refresh threw
 * away the whole conversation. It is also worth keeping for its own sake: the
 * raw answers say things about a character that the derived sheet does not.
 */
export function getOrCreateInterview(db: Database.Database, campaignId: string, sessionToken: string): InterviewRecord {
  const existing = getInterviewBySession(db, campaignId, sessionToken);
  if (existing) return existing;
  const id = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO character_interviews (id, campaign_id, session_token) VALUES (?, ?, ?)')
    .run(id, campaignId, sessionToken);
  return { id, campaignId, sessionToken, transcript: [], definition: null, status: 'open' };
}

export function getInterviewBySession(db: Database.Database, campaignId: string, sessionToken: string): InterviewRecord | null {
  const row = db.prepare('SELECT * FROM character_interviews WHERE campaign_id = ? AND session_token = ?')
    .get(campaignId, sessionToken) as any;
  return row ? rowToRecord(row) : null;
}

export function appendInterviewTurn(db: Database.Database, id: string, turn: InterviewTurn): void {
  const row = db.prepare('SELECT transcript FROM character_interviews WHERE id = ?').get(id) as any;
  if (!row) return;
  const transcript = parseTranscript(row.transcript, id);
  transcript.push(turn);
  db.prepare("UPDATE character_interviews SET transcript = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(transcript), id);
}

export function setInterviewDefinition(db: Database.Database, id: string, definition: CharacterDefinition): void {
  db.prepare("UPDATE character_interviews SET definition = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(definition), id);
}

export function setInterviewStatus(db: Database.Database, id: string, status: InterviewStatus): void {
  db.prepare("UPDATE character_interviews SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, id);
}
```

- [ ] **Step 5: Run tests and both typechecks**

Run: `npx vitest run test/character-interview.test.ts test/db.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/server/character-interview.ts src/server/db.ts test/character-interview.test.ts
git commit -m "feat(whispers): persist character interviews

The transcript lived in process memory, so a refresh mid-interview threw
the whole conversation away. It is kept after the sheet is derived too —
the raw answers carry things the sheet does not.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: The interview learns about the world

`interviewForCharacter(systemId, history)` receives nothing about the campaign — no premise, no influences, no locations, no NPCs. A player is walked through a full character build for a world the interview has never heard of. This connects them, and adds the world introduction.

**Files:**
- Modify: `src/server/agents/dm.ts`, `src/server/agents/schemas.ts`

**Interfaces:**
- Consumes: `getWorldSeed` (`src/server/world-seed.ts`), `getInfluences` (`src/server/room.ts`), `checkCharacterReadiness` (Task 2).
- Produces:
  - `introduceWorld(opts: { preset: string; influences: string[]; seed: WorldSeed }): Promise<string>`
  - `interviewForCharacter(opts: { systemId: string; preset: string; playerName: string; influences: string[]; seed: WorldSeed | null; history: Array<{role,content}>; unmet: string[] })`

- [ ] **Step 1: Tighten the reply schema**

In `src/server/agents/schemas.ts`, replace `CharInterviewReplySchema`'s definition object so a partial sheet reads as "not done" instead of failing the whole call:

```typescript
export const CharInterviewReplySchema = z.object({
  reply: z.string().min(1),
  definition: z.object({
    name: z.string().default(''),
    highConcept: z.string().default(''),
    trouble: z.string().default(''),
    aspects: z.array(z.string()).default([]),
    personality: z.string().default(''),
    backstory: z.string().default(''),
    skills: z.record(z.number()).default({}),
    stunts: z.array(z.string()).default([]),
  }).nullable().default(null),
});
```

Every field gains a default. Previously omitting `stunts` failed the parse and burned four retries, while returning `stunts: []` passed silently — omission was fatal and emptiness was invisible. Now both read as "not finished", which `checkCharacterReadiness` will catch.

- [ ] **Step 2: Add the world introduction**

```typescript
  /**
   * The player's first sight of the world. Written in the fiction, not as a
   * briefing — they should want to be somewhere in it before they are asked
   * who they are. Keep the influences in the prose and out of the content.
   */
  async introduceWorld(opts: { preset: string; influences: string[]; seed: WorldSeed }): Promise<string> {
    const places = opts.seed.locations.slice(0, 4).map(l => `${l.name}: ${l.description}`).join('\n');
    const people = opts.seed.npcs.slice(0, 4).map(n => `${n.name}: ${n.description}`).join('\n');
    const hooks = opts.seed.plotHooks.slice(0, 4).map(h => `- ${h}`).join('\n');

    const systemPrompt = `You are a TTRPG Dungeon Master ("${opts.preset}" style) introducing a player to a world they are about to make a character for.

Write 120-180 words of second-person present tense. Put them somewhere specific and let them look around. Name real places and real people from the world below. End on something unresolved — a question the world is already asking.

Do NOT explain the setting, list factions, or describe mechanics. Do not tell them who their character is; that is the next conversation. No headings, no bullet points, no preamble — just the prose.

${opts.influences.length > 0 ? `Stylistic influences to honour in voice and texture only: ${opts.influences.join(' × ')}\n\n` : ''}Premise: ${opts.seed.premise}

Places:
${places}

People:
${people}

Unresolved:
${hooks}`;

    return callLlm({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Introduce them to this world.' },
      ],
      temperature: 0.9,
    });
  }
```

- [ ] **Step 3: Widen the interview**

Replace `interviewForCharacter`. **Keep the literal phrase `character creation API`** — the test stub matches on it.

```typescript
  async interviewForCharacter(opts: {
    systemId: string;
    preset: string;
    playerName: string;
    influences: string[];
    seed: WorldSeed | null;
    history: Array<{ role: string; content: string }>;
    unmet: string[];
  }): Promise<CharInterviewReply> {
    const ruleContext = this.lookupRules(opts.systemId, 'character creation aspects skills stunts');
    const worldBlock = opts.seed
      ? `\nThe world they are joining:\nPremise: ${opts.seed.premise}\nPlaces: ${opts.seed.locations.slice(0, 5).map(l => l.name).join(', ')}\nPeople: ${opts.seed.npcs.slice(0, 5).map(n => `${n.name} (${n.disposition ?? 'unknown'})`).join(', ')}\nUnresolved: ${opts.seed.plotHooks.slice(0, 4).join(' / ')}\n`
      : '';
    const unmetBlock = opts.unmet.length > 0
      ? `\nStill needed for their sheet:\n${opts.unmet.map(u => `- ${u}`).join('\n')}\nAsk for these, but ask the way a person would.\n`
      : '';

    const systemPrompt = `You are a character creation API for a TTRPG. You help a player named ${opts.playerName} build a character through conversation, for a world that already exists.

Ask a MIX of two kinds of question, and lead with the second kind:

DIRECT — the plain thing, when you need a specific field. "What do we call them?"

INDIRECT — put the character in a real place from the world below and ask what they do, notice, or want. "You are on the tidal stair as the water comes up. What makes you stop?" Never ask for a game term this way. Infer aspects, skills and a trouble from how they answer, and reflect what you inferred back in plain language so they can correct you.

Open indirect. Use direct questions only to close the gaps listed below. Never present a checklist, never ask for more than two things at once, and never use the words "high concept", "aspect" or "stunt" in a question — describe what you mean instead.

Aim them at characters with INTERNAL TENSION: a clear strength and a clear vulnerability. The trouble should create genuine dilemmas, not minor inconveniences, and it should have somewhere to bite in THIS world.
${worldBlock}${unmetBlock}
Rules reference:
${ruleContext}

CRITICAL: respond with ONLY a JSON object. No asterisks, no roleplay actions, no narration outside the JSON.

While the sheet is unfinished: {"reply": "your question", "definition": null}
Once you believe it is finished: {"reply": "what you understand about them, in plain language", "definition": {"name":"...","highConcept":"...","trouble":"...","aspects":["..."],"personality":"...","backstory":"...","skills":{"Skill":3},"stunts":["..."]}}`;

    const messages = [{ role: 'system', content: systemPrompt }, ...opts.history];
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') {
      messages[messages.length - 1] = { ...last, content: `${last.content}\n\n(Remember: respond with ONLY a JSON object, no other text)` };
    }

    return callLlm({ messages, schema: CharInterviewReplySchema, temperature: 0.5 });
  }
```

Add `WorldSeed` to the type imports.

- [ ] **Step 4: Update the existing call site to compile**

`src/server/index.ts`'s `char-chat` handler calls the old signature. Change it to the object form, passing `preset: campaign.dmPreset`, `playerName: currentPlayer.playerName`, `influences: getInfluences(db, campaign.id)`, `seed: getWorldSeed(db, campaign.id)`, `history: currentPlayer.charChat`, `unmet: []`. Task 5 rewrites this handler properly; this step only keeps the build green.

- [ ] **Step 5: Run tests and both typechecks**

Run: `npx vitest run && npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/server/agents/dm.ts src/server/agents/schemas.ts src/server/index.ts
git commit -m "feat(whispers): the character interview knows what world it is for

interviewForCharacter received only a system id and a chat history, so a
player could be walked through a whole character build for a world the
interview had never heard of. It now carries the premise, the influences,
and real places and people, and asks indirect questions grounded in them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire the interview — introduction, persistence, readiness, preview

**Files:**
- Modify: `src/shared/protocol.ts`, `src/server/index.ts`
- Modify: `test/character-interview.test.ts` (add the end-to-end half)

**Interfaces:**
- Produces, on `ClientMessage`: `{ type: 'confirm-character' }`
- Produces, on `ServerMessage`:
  - `{ type: 'world-introduction'; text: string }`
  - `{ type: 'character-preview'; definition: CharacterDefinition; readiness: CharacterReadiness }`
  - `{ type: 'character-readiness'; readiness: CharacterReadiness }`
  - `{ type: 'interview-replay'; transcript: Array<{ role: string; content: string }>; definition: CharacterDefinition | null }`

- [ ] **Step 1: Write the failing end-to-end test**

Append to `test/character-interview.test.ts` a `describe` using the harness (`startHarness`, `connectWs`, `MessageQueue`, `finishWorldSetup`) that proves:

1. A player joining after the table opens receives a `world-introduction` whose text is non-empty.
2. A first `char-chat` yields a `char-chat-reply` with `definition: null` and a `character-readiness` listing every unmet item.
3. After enough turns the player receives a `character-preview` — and `submit-character` is refused until they confirm.
4. `confirm-character` then allows submission.
5. The transcript survives: disconnect mid-interview, rejoin, and an `interview-replay` arrives carrying the earlier turns.

Use the harness's deterministic stub (two player turns flips it to `charInterviewDone`).

- [ ] **Step 2: Run it and confirm it fails**

Expected: FAIL — none of those messages exist.

- [ ] **Step 3: Extend the protocol**

Add the four server messages and one client message listed under Interfaces.

- [ ] **Step 4: Send the introduction when the table opens**

In `src/server/index.ts`, add a helper that loads the seed and influences, calls `dm.introduceWorld`, and sends `{ type: 'world-introduction', text }` to a player socket. Call it:
- when a player `join`s a campaign already in `character-creation`,
- when a player `rejoin`s in `character-creation` and has no interview transcript yet,
- for every non-owner in the room at the moment `accept-world-seed` advances the phase.

Wrap each call in its own try/catch — a failed introduction must not block character creation. On failure send nothing and log.

- [ ] **Step 5: Rewrite `char-chat`**

```typescript
    if (msg.type === 'char-chat' && currentJoinCode && currentPlayer?.sessionToken) {
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      if (campaign.phase !== 'character-creation') {
        send(ws, { type: 'error', message: 'Character creation is not open right now.' });
        return;
      }
      if (!isValidLongField(msg.text) || !msg.text.trim()) {
        send(ws, { type: 'error', message: 'That message was too long to send.' });
        return;
      }

      const interview = getOrCreateInterview(db, campaign.id, currentPlayer.sessionToken);
      appendInterviewTurn(db, interview.id, { role: 'user', content: msg.text });

      const dm = new DmAgent(db);
      try {
        const before = checkCharacterReadiness(interview.definition);
        const history = getInterviewBySession(db, campaign.id, currentPlayer.sessionToken)?.transcript ?? [];
        const reply = await dm.interviewForCharacter({
          systemId: campaign.systemId,
          preset: campaign.dmPreset,
          playerName: currentPlayer.playerName,
          influences: getInfluences(db, campaign.id),
          seed: getWorldSeed(db, campaign.id),
          history,
          unmet: before.detail,
        });
        appendInterviewTurn(db, interview.id, { role: 'assistant', content: reply.reply });

        const readiness = checkCharacterReadiness(reply.definition);
        if (reply.definition && readiness.ready) {
          setInterviewDefinition(db, interview.id, reply.definition);
          send(ws, { type: 'char-chat-reply', text: reply.reply, definition: reply.definition });
          send(ws, { type: 'character-preview', definition: reply.definition, readiness });
        } else {
          // A proposed-but-incomplete sheet is NOT shown as a definition — the
          // model does not get to decide the interview is finished.
          send(ws, { type: 'char-chat-reply', text: reply.reply, definition: null });
          send(ws, { type: 'character-readiness', readiness });
        }
      } catch (e) {
        console.error('[char-chat] error:', e);
        send(ws, { type: 'char-chat-reply', text: 'I had trouble following that — could you say it another way?', definition: null });
      }
    }
```

Note the phase gate is now `!== 'character-creation'`, which also closes interviews during `playing` and `ended`. Note also the error path no longer leaves a dangling user turn in memory, because the turn is already durably recorded.

- [ ] **Step 6: Add `confirm-character` and gate `submit-character` on it**

`confirm-character` sets the interview's status to `'confirmed'`. In `submit-character`, when the definition came from an interview, require that interview's status to be `'confirmed'` and its stored definition to match; otherwise send an error telling the player to confirm first. Submissions from the form and paste tabs — which have no interview record — are unaffected.

- [ ] **Step 7: Replay the transcript on rejoin**

In the non-owner rejoin branch, if an interview exists send `{ type: 'interview-replay', transcript, definition }`.

- [ ] **Step 8: Run everything and both typechecks**

Run: `npx vitest run && npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit`

Existing tests that submit characters do so from the form path and must keep working untouched. If any break, fix the cause rather than the assertion.

- [ ] **Step 9: Commit**

---

## Task 6: The interview on screen

**Files:**
- Modify: `src/client/character-creator.ts`, `src/client/style.css`

No automated test — no DOM harness. Verification is typechecks, the build, and a browser walkthrough the controller runs.

- [ ] **Step 1: Make conversation the default tab**

Change the active tab and the only unhidden panel to `chat`, and `getActiveTab()`'s fallback to `'chat'`. The other two tabs stay exactly as they are.

- [ ] **Step 2: Render the world introduction**

Add a container above the tabs. On `world-introduction`, render the text as paragraphs with `textContent` — it is model-generated prose. Keep it visible for the whole interview.

- [ ] **Step 3: Render readiness and the preview**

- On `character-readiness`, show the remaining items as a short list (one line per `detail` entry), built with `createElement`/`textContent`.
- On `character-preview`, render the proposed sheet — name, high concept, trouble, aspects, skills, stunts — with a **Confirm** button sending `confirm-character` and a "keep talking" affordance that simply returns to the chat input. Only after confirmation does the submit button become available.

- [ ] **Step 4: Replay the transcript**

On `interview-replay`, rebuild the chat log from the transcript (`replaceChildren`, not append) and restore the preview if a definition came with it.

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit && npm run build`

- [ ] **Step 6: Commit**

---

## Task 7: Stop the form pre-filling a whole character

The form tab ships with "Sigmund the Bold" and a complete default skill pyramid, and both the form and paste paths silently inject `{Notice:2, Fight:1, Stealth:1}` when skills are empty. A player can submit a full valid sheet without typing anything, and a "needs at least one skill" rule can never fail from the client.

**Files:**
- Modify: `src/client/character-creator.ts`

- [ ] **Step 1: Empty the placeholders**

Move the sample values from `value="..."` into `placeholder="..."` so they still show the shape without being submitted. Clear the default skill pyramid selection.

- [ ] **Step 2: Remove the silent skill injection**

Delete both `{Notice:2, Fight:1, Stealth:1}` fallbacks. An empty pyramid now produces an empty `skills` object, which the server's readiness check will report honestly.

- [ ] **Step 3: Confirm the server explains the refusal**

Submitting an empty form must now produce a clear message naming what is missing, not a silent failure. Check the `character-validated` / `error` path renders it.

- [ ] **Step 4: Typecheck, build, commit**

---

## Task 8: Full verification

- [ ] **Step 1:** `npx vitest run` — report counts.
- [ ] **Step 2:** both typechecks and `npm run build`.
- [ ] **Step 3:** the XSS sweep from the step-2 plan, confirming no new interpolation reaches `innerHTML`.
- [ ] **Step 4:** report anything deferred.

---

## Self-Review Notes

Covered against the spec's step-3 scope: world context into the interview, direct + indirect questions, persisted transcripts, the preview/confirm step, and character readiness.

Deliberately NOT here, and tracked:

- **The approve/revoke split by table role, the host-as-player dead end, and negotiation termination are build step 3b.** They are a coherent unit about authority rather than conversation, and 3b depends on this plan's preview/confirm existing. Until 3b lands, a host who chooses `'player'` still cannot start their game — the gap flagged when step 1 shipped.
- `premise` finally gets a runtime reader here, via `introduceWorld` and the interview's world block. Before this plan it was write-only.
- The `dnd5e` empty-rules notice (spec bug 8) moves to 3b, alongside the other host-facing messaging work.
- `validateCharacter` still hands the model its own answer, and `validation.modifications` is still spread over a definition after the size caps run — an LLM can reintroduce out-of-bounds fields. That is submission-path work and belongs with 3b's approval changes.
