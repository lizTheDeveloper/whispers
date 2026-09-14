# Whispers Table Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the host's choice between running the table and playing at it actually mean something — the AI DM approves characters when the host is playing, the host keeps a non-blocking veto, and a negotiation can end.

**Architecture:** The single `INSERT INTO characters` is extracted into one transactional `makeCharacterLive`, which both the host-approval path and a new AI-approval path call. Revocation becomes a soft delete (`characters.revoked_at`) because a live foreign key from `character_memories` makes hard deletion throw. Every silent refusal becomes a message, and the client stops painting "Approved" before the server has agreed. Negotiations gain a turn cap and are cleaned up on teardown.

**Tech Stack:** TypeScript, Express 5, `ws`, better-sqlite3, Zod, Vitest, vanilla DOM client (Vite).

**Spec:** `docs/superpowers/specs/2026-09-12-whispers-onboarding-design.md` (build step 3, second half)

**Predecessors:** step 1 `d6589ee`, step 2 `7d9590c`, step 3a `0bfabb6`

## Global Constraints

- Server is authoritative for all game state. Clients never write phase.
- All agent outputs validated with Zod before affecting state.
- On malformed model output, coerce toward "not ready" — never toward "ready" or "approved".
- **No silent refusals.** Every rejected client action sends something back. A bare `return` on a guard failure is a defect in this plan's scope.
- No `NOT NULL DEFAULT ''` columns where the empty string would be indistinguishable from a failure.
- DB migrations are additive only.
- Never remove a feature.
- No model-generated or player-typed string may reach `innerHTML`.
- Every behavioural change lands with a test that failed before it.
- Tests must not require a live LLM.
- BOTH `npx tsc --noEmit` AND `npx tsc -p tsconfig.server.json --noEmit` must pass.
- Commit after each task. Branch: `feat/whispers-agentic-ttrpg`. Do not push until the final review.

### Four traps specific to this plan

**1. `characters` has a live foreign key.** `character_memories.character_id` references it and `PRAGMA foreign_keys = ON`. Deleting a character row throws as soon as any memory exists. Revocation must be a soft delete.

**2. `countLiveCharacters` counts rows, not liveness.** It is `SELECT COUNT(*)`, and it gates `start-game` *and* feeds `lobby-state.approvedCount`. Add a soft-delete column without updating it and a revoked character still counts as a party member.

**3. ~20 live-LLM playtest files hardcode the approval sequence** `negotiation-opened` → `negotiation-message` → `host-approve-character`. They are skipped without `LLM_PROXY_URL`, so they fail late and in bulk. Do not change *when* a negotiation opens for a host-as-DM table — only for host-as-player, which none of them exercise.

**4. `test/lib/finish-world-setup.ts` hardcodes `role: 'dm'`.** Every stub-harness test is therefore a host-as-DM test. It needs an optional role parameter, and `test/session-persistence.test.ts`'s "refuses character approval from an owner who chose to play" currently asserts the *bug* — it waits for a `character-submitted` timeout. Making host-as-player work will fail that test. That is correct; rewrite it to assert the new behaviour rather than deleting it.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/server/db.ts` | **Modify.** `characters.revoked_at`. |
| `src/server/room.ts` | **Modify.** `countLiveCharacters` respects revocation; `clearSessionCharacter`; `reviveOrRevokeCharacter`. |
| `src/server/character-live.ts` | **Create.** `makeCharacterLive` — the one transactional path into `characters`. |
| `src/server/index.ts` | **Modify.** AI approval, revoke handler, refusal messages, approver-aware `hostSocket`, negotiation lifecycle. |
| `src/server/negotiation.ts` | **Modify.** Turn cap and a reason for ending. |
| `src/shared/protocol.ts` | **Modify.** `revoke-character`, `character-revoked`, `approval-refused`. |
| `src/client/dm-lobby.ts` | **Modify.** Stop optimistic approval; render revoke; handle refusal. |
| `src/client/negotiation-chat.ts` | **Modify.** Stop optimistic approval. |
| `src/client/main.ts` | **Modify.** Route a host-as-player to character creation. |
| `test/lib/finish-world-setup.ts` | **Modify.** Optional table role. |
| `test/table-authority.test.ts` | **Create.** The whole authority surface. |

---

## Task 1: One transactional path into `characters`

Today the only `INSERT INTO characters` sits inline in `host-approve-character`, interleaved with two socket sends, a map mutation and a delete, with no transaction. A second approval path is about to need all of it.

**Files:**
- Create: `src/server/character-live.ts`
- Modify: `src/server/db.ts`, `src/server/room.ts`, `src/server/index.ts`
- Create: `test/table-authority.test.ts` (the persistence half)

**Interfaces:**
- Produces:
  - `makeCharacterLive(db, pending: PendingCharacterRow): void` — inserts the character, sets the session's character id, marks the interview `'live'`, and deletes the pending row, **in one transaction**. Socket sends stay with the caller.
  - `countLiveCharacters` excludes revoked rows.
  - `revokeCharacter(db, characterId): boolean`, `clearSessionCharacter(db, sessionToken): void`

- [ ] **Step 1: Write the failing test**

```typescript
// test/table-authority.test.ts — persistence half
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string; let db: any;
let mod: typeof import('../src/server/character-live.js');
let room: typeof import('../src/server/room.js');
let interviews: typeof import('../src/server/character-interview.js');

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-authority-'));
  process.env.DATA_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
  mod = await import('../src/server/character-live.js');
  room = await import('../src/server/room.js');
  interviews = await import('../src/server/character-interview.js');
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

const DEF = {
  name: 'Vesper Ash', highConcept: 'Keeper Who Stopped Believing',
  trouble: 'Owes a debt she cannot name', aspects: ['Maps are promises', 'Never looks back'],
  personality: 'Quiet.', backstory: 'Thirty years at the lamp.',
  skills: { Will: 3 }, stunts: ['Steady Hand: +2 to Will against fear.'],
} as any;

function seedPending(token = 'tok') {
  const { campaignId, joinCode } = room.createRoom(db, { name: 'Auth', dmPreset: 'chronicler', systemId: 'fate-core' });
  const session = room.createSession(db, { campaignId, joinCode, playerName: 'Wendy', isHost: false });
  const interview = interviews.getOrCreateInterview(db, campaignId, session.token);
  const pending = { id: 'char-' + token, campaignId, joinCode, sessionToken: session.token, playerName: 'Wendy', definition: DEF, aiFeedback: 'ok' };
  room.savePendingCharacter(db, pending);
  return { campaignId, session, interview, pending };
}

describe('makeCharacterLive', () => {
  it('inserts the character, claims the session, marks the interview live, and clears the pending row', () => {
    const { campaignId, session, pending } = seedPending('a');
    mod.makeCharacterLive(db, pending);

    expect(room.countLiveCharacters(db, campaignId)).toBe(1);
    expect(db.prepare('SELECT character_id FROM campaign_sessions WHERE token = ?').get(session.token).character_id).toBe(pending.id);
    expect(interviews.getInterviewBySession(db, campaignId, session.token)!.status).toBe('live');
    expect(room.listPendingCharacters(db, campaignId)).toHaveLength(0);
  });

  it('is all-or-nothing — a failure leaves no partial state', () => {
    const { campaignId, pending } = seedPending('b');
    // A pending row referencing a campaign that does not exist must not half-apply.
    const bad = { ...pending, id: 'char-b2', campaignId: 'no-such-campaign' };
    expect(() => mod.makeCharacterLive(db, bad)).toThrow();
    expect(room.countLiveCharacters(db, campaignId)).toBe(0);
    expect(room.listPendingCharacters(db, campaignId)).toHaveLength(1);
  });
});

describe('revocation', () => {
  it('stops counting toward the party without deleting the row', () => {
    const { campaignId, pending } = seedPending('c');
    mod.makeCharacterLive(db, pending);
    expect(room.countLiveCharacters(db, campaignId)).toBe(1);

    expect(room.revokeCharacter(db, pending.id)).toBe(true);
    expect(room.countLiveCharacters(db, campaignId)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM characters WHERE id = ?').get(pending.id).c).toBe(1);
  });

  it('survives a character that has memories — a hard delete would throw', () => {
    const { campaignId, pending } = seedPending('d');
    mod.makeCharacterLive(db, pending);
    db.prepare("INSERT INTO character_memories (id, character_id, campaign_id, scene_number, turn_number, type, content) VALUES (?,?,?,0,0,'fact','remembered')")
      .run('mem-1', pending.id, campaignId);
    expect(() => room.revokeCharacter(db, pending.id)).not.toThrow();
    expect(room.countLiveCharacters(db, campaignId)).toBe(0);
  });

  it('returns false for a character that does not exist', () => {
    expect(room.revokeCharacter(db, 'no-such-character')).toBe(false);
  });

  it('clears the session claim so the player can build another', () => {
    const { campaignId, session, pending } = seedPending('e');
    mod.makeCharacterLive(db, pending);
    room.clearSessionCharacter(db, session.token);
    expect(db.prepare('SELECT character_id FROM campaign_sessions WHERE token = ?').get(session.token).character_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/table-authority.test.ts`
Expected: FAIL — cannot find module `../src/server/character-live.js`.

- [ ] **Step 3: Add the column**

In `src/server/db.ts`'s `migrate()`, with the other additive column guards — note `colNames` there is built from `campaigns`, so read `characters`' columns separately:

```typescript
  const charCols = db.pragma('table_info(characters)') as Array<{ name: string }>;
  if (!charCols.some(c => c.name === 'revoked_at')) {
    db.exec('ALTER TABLE characters ADD COLUMN revoked_at TEXT');
  }
```

Nullable: null means "live". A revoked character keeps its row because `character_memories` holds a foreign key to it.

- [ ] **Step 4: Teach `room.ts` about revocation**

```typescript
/**
 * Counts characters that are actually at the table. Revoked characters keep
 * their row — `character_memories` has a foreign key to it — so liveness has
 * to be a predicate, not a row count. This gates `start-game` and feeds
 * `lobby-state.approvedCount`; both would be wrong without the NULL check.
 */
export function countLiveCharacters(db: Database.Database, campaignId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM characters WHERE campaign_id = ? AND revoked_at IS NULL').get(campaignId) as { c: number };
  return row.c;
}

export function revokeCharacter(db: Database.Database, characterId: string): boolean {
  const res = db.prepare("UPDATE characters SET revoked_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").run(characterId);
  return res.changes === 1;
}

export function clearSessionCharacter(db: Database.Database, sessionToken: string): void {
  db.prepare('UPDATE campaign_sessions SET character_id = NULL WHERE token = ?').run(sessionToken);
}
```

- [ ] **Step 5: Extract `makeCharacterLive`**

```typescript
// src/server/character-live.ts
import type Database from 'better-sqlite3';
import type { PendingCharacterRow } from './room.js';
import { deletePendingCharacter, setSessionCharacter } from './room.js';
import { getInterviewBySession, setInterviewStatus } from './character-interview.js';

const INITIAL_STATE = JSON.stringify({
  stress: 0, consequences: [], fatePoints: 3,
  inventory: [], xpMilestones: [], whisperTrust: 0.65,
});

/**
 * The ONE path into the `characters` table.
 *
 * Both approval routes call this — the human host's, and the AI DM's when the
 * host is playing rather than running the table. It is a transaction because
 * the insert, the session claim, the interview status and the pending-row
 * delete have to move together: a half-applied approval leaves a character
 * that exists but nobody owns, or a pending row for a character already live.
 *
 * Socket sends stay with the caller — they are not transactional and must not
 * fire before a commit.
 */
export function makeCharacterLive(db: Database.Database, pending: PendingCharacterRow): void {
  db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO characters (id, campaign_id, player_user_id, definition, state) VALUES (?, ?, ?, ?, ?)')
      .run(pending.id, pending.campaignId, null, JSON.stringify(pending.definition), INITIAL_STATE);

    if (pending.sessionToken) {
      setSessionCharacter(db, pending.sessionToken, pending.id);
      const interview = getInterviewBySession(db, pending.campaignId, pending.sessionToken);
      if (interview) setInterviewStatus(db, interview.id, 'live');
    }

    deletePendingCharacter(db, pending.id);
  })();
}
```

- [ ] **Step 6: Call it from `host-approve-character`**

Replace the inline insert / session write / delete in `src/server/index.ts` with a single `makeCharacterLive(db, pending)` call, keeping the socket sends, the in-memory `playerInRoom.characterId` assignment and the negotiation teardown where they are — but move all of them AFTER the call so nothing is announced before it commits.

- [ ] **Step 7: Run tests and both typechecks**

Run: `npx vitest run && npx tsc --noEmit && npx tsc -p tsconfig.server.json --noEmit`

- [ ] **Step 8: Commit**

---

## Task 2: The AI DM approves when the host is playing

**Files:**
- Modify: `src/server/index.ts`
- Modify: `test/table-authority.test.ts`, `test/lib/finish-world-setup.ts`, `test/session-persistence.test.ts`

**Interfaces:**
- Consumes: `makeCharacterLive` (Task 1), `effectiveTableRole` (`src/server/seat.ts`).
- Produces: `finishWorldSetup(ws, q, role?: TableRole)` — defaults to `'dm'` so every existing caller is unchanged.

- [ ] **Step 1: Give the test helper a role**

Add an optional third parameter to `finishWorldSetup`, defaulting to `'dm'`, and pass it to `choose-table-role`. Every existing call site keeps working untouched.

- [ ] **Step 2: Write the failing test**

Add to `test/table-authority.test.ts` a harness-based describe proving:
1. With the host as `'player'`, a submitted character goes live **without any host action** — the player receives `character-validated {approved:true}` and the room receives `character-submitted`.
2. `start-game` then succeeds, where today it is refused forever.
3. No `character-pending-review` is sent and no negotiation is opened, because there is no human approver to negotiate with.
4. With the host as `'dm'` (the default), behaviour is exactly as before — a pending review arrives and nothing goes live until the host approves.

- [ ] **Step 3: Rewrite the test that asserts the bug**

`test/session-persistence.test.ts`'s "refuses character approval from an owner who chose to play" waits for a `character-submitted` timeout — it asserts the dead end. Rewrite it to assert the new truth: an owner who chose to play does not *approve* (their `host-approve-character` is refused with a message), but the character goes live anyway via the AI DM. Do not delete the test; its subject is still real.

- [ ] **Step 4: Branch `submit-character` on table role**

After validation and the readiness check, where the pending row is currently always saved:

```typescript
      const approver = effectiveTableRole(submitCampaign.hostTableRole);
      savePendingCharacter(db, pending);

      if (approver === 'player') {
        // The host is at the table as a player, so there is no human to
        // approve. The AI DM's validation is the decision — the character goes
        // live immediately and the host keeps a veto they can use later.
        makeCharacterLive(db, pending);
        send(ws, { type: 'character-validated', characterId: pending.id, approved: true, feedback: `${feedbackText} Your character is in the game.` });
        broadcast(currentJoinCode, { type: 'character-submitted', characterId: pending.id, definition: pending.definition });
        return;
      }

      // ...existing host-review path unchanged...
```

The pending row is still written first so the AI path and the host path share one shape, and so a crash between the two leaves a reviewable row rather than nothing.

- [ ] **Step 5: Run everything and both typechecks**

- [ ] **Step 6: Commit**

---

## Task 3: The host's veto

**Files:**
- Modify: `src/shared/protocol.ts`, `src/server/index.ts`, `src/client/dm-lobby.ts`
- Modify: `test/table-authority.test.ts`

**Interfaces:**
- Produces: client `{ type: 'revoke-character'; characterId: string; reason?: string }`; server `{ type: 'character-revoked'; characterId: string; reason: string }`.

- [ ] **Step 1: Write the failing test**

Prove: the owner can revoke a live character; it stops counting toward the party; the room is told; the player's interview returns to `'open'` so they can build another; a non-owner's revoke is refused with a message; revoking an unknown or already-revoked character is refused rather than silently succeeding.

- [ ] **Step 2: Add the handler**

Owner-only (`isWorldAuthor`), because a host who is playing must still be able to veto. On success: `revokeCharacter`, `clearSessionCharacter`, reset the interview to `'open'`, clear the in-memory `characterId`, and broadcast `character-revoked`. Bound `reason` with `isValidLongField`. Refuse with an error when the id is unknown or already revoked.

- [ ] **Step 3: Client**

Render a revoke affordance on approved characters in the DM lobby, and handle `character-revoked` by decrementing the approved count and marking the card. Build with `createElement`/`textContent`.

- [ ] **Step 4: Run, typecheck, commit**

---

## Task 4: Stop lying about approval

Today `host-approve-character` and `host-reject-character` return silently on every guard failure, while the client has already painted "Approved" and disabled both buttons. The card says one thing and the database says another, permanently.

**Files:**
- Modify: `src/server/index.ts`, `src/client/dm-lobby.ts`, `src/client/negotiation-chat.ts`
- Modify: `test/table-authority.test.ts`

- [ ] **Step 1: Write the failing test** — a host without DM authority who sends `host-approve-character` receives an explicit refusal, not silence.

- [ ] **Step 2: Replace every bare `return`** in `host-approve-character`, `host-reject-character` and `choose-table-role` with a `send(ws, { type: 'error', message: ... })` naming the reason. Each message must say what is true: no authority, no such pending character, wrong phase.

- [ ] **Step 3: Make the client stop pre-empting the server.** In both `dm-lobby.ts` and `negotiation-chat.ts`, the Approve click should disable the buttons and show a pending state — not "Approved". Move the "Approved" label to the `character-submitted` handler, which only fires when the server actually did it. On `error`, restore the buttons.

- [ ] **Step 4: Run, typecheck, commit**

---

## Task 5: A negotiation that can end

**Files:**
- Modify: `src/server/negotiation.ts`, `src/server/index.ts`
- Modify: `test/lib/server-harness.ts` (a stub branch for the negotiation prompts)
- Modify: `test/table-authority.test.ts`

- [ ] **Step 1: Add a stub branch** for the two negotiation prompts (`facilitating character creation negotiation` and `You ARE `), returning short prose. Without it every negotiation turn in a stub test returns the fallback string and costs four retries on nothing.

- [ ] **Step 2: Write the failing test** — a negotiation stops running agent turns after the cap, and a room teardown removes it from the `negotiations` map.

- [ ] **Step 3: Cap the turns.** Add a `MAX_NEGOTIATION_ROUNDS` (choose a number and justify it in a comment — the project's precedent is the 3-turn therapy cap in a sibling game and the 35-message scene compaction here). When the cap is reached, broadcast a final message saying the discussion is closed and stop running agent turns. Do NOT auto-approve — the decision stays with whoever has authority.

- [ ] **Step 4: Stop leaking.** `negotiations` is a module-level `Map` that the socket-close handler never touches, and `openNegotiation`'s `has()` guard means a stale entry permanently blocks a replacement. Clear a campaign's negotiations in the same 30-second room-teardown path that clears `rooms` and `gameLoops`.

- [ ] **Step 5: Do not open a negotiation with no approver.** `openNegotiation` fires whenever a host socket exists, but `hostSocket` keys on ownership, not authority. A host-as-player gets a negotiation panel with dead Approve/Reject buttons and no way to end it. Gate opening on `hasDmAuthority`, not on the owner being connected.

- [ ] **Step 6: Run, typecheck, commit**

---

## Task 6: A host who plays can reach a character

**Files:**
- Modify: `src/client/main.ts`, `src/client/dm-lobby.ts`, `src/server/index.ts`

- [ ] **Step 1: Route them.** `renderFor` short-circuits on `owner` before phase, so `renderCharacterCreator` is unreachable for the host. A host whose table role is `'player'` and whose phase is `character-creation` must reach it. Note `renderFor`'s cache key does not encode table role — add it, or a host who switches role renders the same key and nothing changes.

- [ ] **Step 2: Give them the world.** `accept-world-seed` sends the world introduction to every non-owner, explicitly excluding the host. A host who is playing must meet their own world like anyone else.

- [ ] **Step 3: Keep the role visible.** `dm-lobby.ts` hides the table-role section entirely once phase leaves `lobby`, so after the table opens the host cannot see which role they chose. Show it as a read-only status instead of hiding it.

- [ ] **Step 4: Typecheck, build, commit.** No automated test — this is routing; the controller verifies in a browser.

---

## Task 7: Carry-forwards and the silent-degradation notice

**Files:**
- Modify: `src/server/index.ts`, `src/server/agents/dm.ts`, `src/client/character-creator.ts`
- Modify: `test/table-authority.test.ts`, `test/lib/server-harness.ts`

- [ ] **Step 1: Give the server the role guard the client already has.** `windowInterviewHistory` and `sendWorldIntroduction` both treat `transcript[0]` as the world introduction with no role check, while `character-creator.ts` explicitly guards against exactly that. Add the same `role === 'assistant'` check in both server places. Pin nothing and show nothing if turn 0 is a user turn.

- [ ] **Step 2: Fix the thin-proposal dead end.** In `char-chat`, a thin-but-non-null proposal arriving while a ready sheet is stored currently tells the player their finished character needs everything, and hides both affordances. Compute readiness for the *display* from the stored definition when one exists and is ready, so the screen never contradicts what the server holds.

- [ ] **Step 3: Test the three uncovered fixes from the previous plan.** `windowInterviewHistory` (export it for test, or test through a long interview), the empty-introduction guard (add a stub fixture returning whitespace and assert nothing is stored or sent), and the readiness fallback branch (the harness's stub currently returns a definition on every turn after the first, so add a trigger that forces `definition: null` on a later turn).

- [ ] **Step 4: Tell the host when their system has no rulebook.** `dnd5e` is selectable and `data/systems/dnd5e` does not exist, so every rules lookup returns `(No rules found for this query)` and that sentinel is interpolated into prompts as if it were the rulebook. At campaign creation, check `SELECT COUNT(*) FROM rule_chunks WHERE system_id = ?` and, when it is zero, have the DM's opening message say plainly that it has no rulebook for that system and offer the upload that already exists in the sidebar. Do not remove the option.

- [ ] **Step 5: Stop handing the validator its own answer.** `validateCharacter`'s user message ends `Return ONLY: {"approved": true, ...}`. Its six criteria are now a strict subset of the server's readiness check, which runs first — so its only real jobs are the feedback sentence and `modifications`. Reword the prompt to ask for a judgement about fit with the world rather than a field-presence check it cannot fail, and stop pre-filling the answer.

- [ ] **Step 6: Run, typecheck, commit**

---

## Task 8: Full verification

- [ ] **Step 1:** `npx vitest run` — report counts.
- [ ] **Step 2:** both typechecks and `npm run build`.
- [ ] **Step 3:** the XSS sweep, confirming no new interpolation reaches `innerHTML`.
- [ ] **Step 4:** report anything deferred.

---

## Self-Review Notes

Covered: the approve/revoke split by table role, closing the host-as-player dead end, negotiation termination, and the carry-forwards from step 3a.

Deliberately NOT here:

- **The multi-character paste batch is neither atomic nor idempotent** — resubmitting after one refusal duplicates the characters that already succeeded, under fresh ids, as separate pending cards. That is a real defect but it belongs with a redesign of batch submission, not with authority. Tracked for a follow-up.
- **`modifications` may carry keys outside `CharacterDefinition`** and the merge is shallow, so unknown keys survive into the stored definition. Narrow, and the re-validation added in step 3a bounds the known fields.
- World growth during play is build step 4.
