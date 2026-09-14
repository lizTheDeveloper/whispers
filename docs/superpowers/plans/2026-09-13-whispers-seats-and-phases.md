# Whispers Seats and Phases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate room ownership from DM authority, and gate character creation behind the world being set up, so a player can no longer build a character before a world exists.

**Architecture:** `ConnectedPlayer.isHost` currently means three things at once (room owner, world author, DM authority). This plan renames it to `isOwner` for the first two and derives DM authority from a new `campaigns.host_table_role` column. The dead `'character-creation'` phase value becomes live: the server advances `lobby → character-creation` when world setup completes, and rejects `char-chat` / `submit-character` while still in `lobby`. Players who arrive during `lobby` get a waiting room instead of a character creator.

**Tech Stack:** TypeScript, Express 5, `ws`, better-sqlite3, Vitest, vanilla DOM client (Vite).

**Spec:** `docs/superpowers/specs/2026-09-12-whispers-onboarding-design.md`

## Global Constraints

- Server is authoritative for all game state. Clients never write phase.
- All agent outputs validated with Zod before affecting state.
- Never remove a feature. The "Build here" and "Paste markdown" character tabs stay.
- No `NOT NULL DEFAULT ''` columns where the empty string would be indistinguishable from a failure.
- DB migrations are additive only — `ALTER TABLE ... ADD COLUMN`, never rename or drop.
- Every behavioural change lands with a test that failed before it.
- Tests must not require a live LLM. Use the stubbed proxy harness.
- Commit after each task. Branch: `feat/whispers-agentic-ttrpg`.

### Scope boundary for this plan

This plan makes the **mechanism**. It does not make world setup smarter — that is build step 2.

- The `lobby → character-creation` transition is triggered here by the **existing** completion signal (`dmInstructions` persisted, i.e. today's `dmReady`). Step 2 replaces that trigger with server-verified world readiness and seed acceptance.
- `host_table_role` is persisted and settable here, and defaults to `'dm'` when unset, so behaviour after this plan matches today for anyone who never chooses. Step 2 adds the UI that asks.
- Client routing still derives `#/dm/` vs `#/play/` from ownership, not table role. Table role does not change which screen the owner gets until build step 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `test/lib/server-harness.ts` | **Create.** Boot the real server against a temp DB and a stubbed LLM proxy. Shared by all server e2e tests. |
| `src/server/seat.ts` | **Create.** Seat authority predicates. Pure functions, no I/O — the one place that answers "may this connection do DM things?" |
| `src/server/db.ts` | **Modify.** Add `campaigns.host_table_role`. |
| `src/server/room.ts` | **Modify.** `Campaign.hostTableRole`; `setHostTableRole`; `countLiveCharacters`. |
| `src/shared/types.ts` | **Modify.** `TableRole`; `Campaign.hostTableRole`. |
| `src/shared/protocol.ts` | **Modify.** `choose-table-role`; `room-joined.isOwner` + `.tableRole`; `waiting-room` state on `lobby-state`. |
| `src/server/index.ts` | **Modify.** Rename `isHost` → `isOwner`; route authority through `seat.ts`; phase gates; `start-game` character gate. |
| `src/client/main.ts` | **Modify.** Route `character-creation` and `lobby` to different views. |
| `src/client/waiting-room.ts` | **Create.** The screen a player sees while the world is being built. |
| `src/client/dm-lobby.ts` | **Modify.** Consume `isOwner`. |
| `src/client/session-store.ts` | **Modify.** Consume `isOwner`. |
| `test/onboarding-phases.test.ts` | **Create.** Phase gating and start-game gating tests. |
| `test/seat.test.ts` | **Create.** Unit tests for the authority predicates. |

---

## Task 1: Extract the server test harness

Two test files will need to boot the real server against a stub LLM. Extract the existing setup from `test/session-persistence.test.ts` before duplicating it.

**This task is a pure refactor. All 11 existing tests must still pass, unchanged in behaviour.**

**Files:**
- Create: `test/lib/server-harness.ts`
- Modify: `test/session-persistence.test.ts` (replace inline setup with the harness)

**Interfaces:**
- Consumes: `test/lib/ws-helpers.ts` — `getFreePort()`, `connectWs(port)`, `sendMsg(ws, msg)`, `MessageQueue`
- Produces:
  - `startHarness(): Promise<Harness>`
  - `interface Harness { port: number; stop(): Promise<void> }`
  - `LLM_STUB_REPLIES` — the canned responses, exported so tests can assert against them

- [ ] **Step 1: Create the harness**

```typescript
// test/lib/server-harness.ts
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFreePort } from './ws-helpers.js';

export const LLM_STUB_REPLIES = {
  validation: { approved: true, feedback: 'Solid sheet.', modifications: null },
  setupOpen: { reply: 'What kind of game are we running?', done: false, dmInstructions: null, dmCustomPrompt: null },
  setupDone: { reply: 'Got it — I have what I need.', done: true, dmInstructions: 'A haunted lighthouse, spooky but hopeful.', dmCustomPrompt: 'You are running a haunted lighthouse game.' },
};

export interface Harness {
  port: number;
  stop(): Promise<void>;
}

/**
 * Boots the real server (src/server/index.ts) against a throwaway data dir and
 * a canned LLM proxy. The server reads PORT/DATA_DIR/LLM_PROXY_URL at import
 * time, so they must be set before the dynamic import below.
 */
export async function startHarness(): Promise<Harness> {
  const llm = await startLlmStub();
  process.env.LLM_PROXY_URL = llm.url;

  const dataDir = mkdtempSync(join(tmpdir(), 'whispers-test-'));
  process.env.DATA_DIR = dataDir;

  const port = await getFreePort();
  process.env.PORT = String(port);

  const mod = await import('../../src/server/index.js');
  if (!mod.server.listening) {
    await new Promise<void>((r) => mod.server.once('listening', () => r()));
  }

  return {
    port,
    async stop() {
      await new Promise<void>((r) => mod.server.close(() => r()));
      await new Promise<void>((r) => llm.server.close(() => r()));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * The host says "done" only after at least one message, so a test can drive a
 * campaign to "world set up" deterministically by sending exactly one dm-chat.
 */
function startLlmStub(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let text: string;
        if (body.includes('character sheet validation API')) {
          text = JSON.stringify(LLM_STUB_REPLIES.validation);
        } else if (body.includes('helping set up a new game')) {
          const hostSpoke = body.includes('"role":"user"');
          text = JSON.stringify(hostSpoke ? LLM_STUB_REPLIES.setupDone : LLM_STUB_REPLIES.setupOpen);
        } else {
          text = 'Understood. Lets keep moving.';
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));
      });
    });
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}
```

- [ ] **Step 2: Rewrite session-persistence.test.ts to use it**

Replace the `beforeAll`/`afterAll` blocks and the local `startLlmStub`/`dataDir`/`gameServer` declarations with:

```typescript
import { startHarness, type Harness } from './lib/server-harness.js';

let harness: Harness;
let port: number;

beforeAll(async () => {
  harness = await startHarness();
  port = harness.port;
}, 30_000);

afterAll(async () => {
  await harness.stop();
});
```

Delete the now-unused imports (`createHttpServer`, `mkdtempSync`, `rmSync`, `tmpdir`, `join`, `Server`). Leave every `describe`/`it` body untouched.

- [ ] **Step 3: Run the existing suite to prove the refactor is behaviour-neutral**

Run: `npx vitest run test/session-persistence.test.ts`
Expected: PASS, 11 tests. Any failure means the harness differs from the inline setup — fix the harness, not the tests.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add test/lib/server-harness.ts test/session-persistence.test.ts
git commit -m "test(whispers): extract shared server harness

Two more test files need to boot the real server against a stubbed LLM
proxy. Pure refactor — the 11 session tests pass unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Seat authority predicates

`isHost` answers three different questions today. Give each its own name, in one pure module that is trivial to test.

**Files:**
- Create: `src/server/seat.ts`
- Create: `test/seat.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TableRole = 'dm' | 'player'` (re-exported from `src/shared/types.ts`)
  - `interface Seat { isOwner: boolean }`
  - `effectiveTableRole(hostTableRole: TableRole | null | undefined): TableRole`
  - `isWorldAuthor(seat: Seat | null | undefined): boolean`
  - `hasDmAuthority(seat: Seat | null | undefined, hostTableRole: TableRole | null | undefined): boolean`

- [ ] **Step 1: Write the failing test**

```typescript
// test/seat.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/seat.test.ts`
Expected: FAIL — cannot find module `../src/server/seat.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/server/seat.ts
import type { TableRole } from '../shared/types.js';

export type { TableRole };

/** The subset of a connection this module needs. */
export interface Seat {
  isOwner: boolean;
}

/**
 * `isHost` used to mean three things at once: who owns the room, who authors
 * the world, and who has DM authority at the table. The first two always
 * belong to the person who created the game. The third is a choice they make
 * once, and it is the only one that can move.
 */

/** Campaigns created before roles existed have none; they behaved as host-DM. */
export function effectiveTableRole(hostTableRole: TableRole | null | undefined): TableRole {
  return hostTableRole === 'player' ? 'player' : 'dm';
}

/** World setup belongs to the owner whatever they do at the table. */
export function isWorldAuthor(seat: Seat | null | undefined): boolean {
  return seat?.isOwner === true;
}

/** Approving characters, injecting, overriding — only when they are running it. */
export function hasDmAuthority(
  seat: Seat | null | undefined,
  hostTableRole: TableRole | null | undefined,
): boolean {
  if (seat?.isOwner !== true) return false;
  return effectiveTableRole(hostTableRole) === 'dm';
}
```

- [ ] **Step 4: Add the TableRole type**

In `src/shared/types.ts`, immediately after the `GamePhase` declaration:

```typescript
export type TableRole = 'dm' | 'player';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/seat.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/seat.ts src/shared/types.ts test/seat.test.ts
git commit -m "feat(whispers): separate room ownership from DM authority

isHost meant owner, world author, and DM authority at once. Only the
last one can move, and only by the owner's choice.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Persist the host's table role

**Files:**
- Modify: `src/server/db.ts` (migration block, alongside the existing `setup_chat` / `phase` ALTERs)
- Modify: `src/server/room.ts` (`Campaign` mapping in `joinRoom`; new `setHostTableRole`)
- Modify: `src/shared/types.ts` (`Campaign.hostTableRole`)
- Modify: `test/room.test.ts`

**Interfaces:**
- Consumes: `TableRole` from Task 2.
- Produces:
  - `Campaign.hostTableRole: TableRole | null`
  - `setHostTableRole(db: Database.Database, campaignId: string, role: TableRole): void`

- [ ] **Step 1: Write the failing test**

Append to `test/room.test.ts`:

```typescript
describe('host table role', () => {
  it('is null on a fresh campaign and survives a round trip once set', () => {
    const db = getDb();
    const { campaignId, joinCode } = createRoom(db, {
      name: 'Role Test', dmPreset: 'chronicler', systemId: 'fate-core',
    });

    expect(joinRoom(db, joinCode)?.hostTableRole).toBeNull();

    setHostTableRole(db, campaignId, 'player');
    expect(joinRoom(db, joinCode)?.hostTableRole).toBe('player');

    setHostTableRole(db, campaignId, 'dm');
    expect(joinRoom(db, joinCode)?.hostTableRole).toBe('dm');
  });
});
```

Add `setHostTableRole` to the existing import from `../src/server/room.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/room.test.ts`
Expected: FAIL — `setHostTableRole` is not exported.

- [ ] **Step 3: Add the column**

In `src/server/db.ts`, inside `migrate()`, directly after the existing `phase` column block:

```typescript
  if (!colNames.has('host_table_role')) {
    db.exec('ALTER TABLE campaigns ADD COLUMN host_table_role TEXT');
  }
```

Nullable on purpose: null means "not chosen yet", which is distinguishable from both valid values.

- [ ] **Step 4: Map and write it**

In `src/server/room.ts`, add to the object literal returned by `joinRoom`, next to `phase`:

```typescript
    hostTableRole: row.host_table_role ?? null,
```

And add the setter beside `setCampaignPhase`:

```typescript
export function setHostTableRole(db: Database.Database, campaignId: string, role: TableRole): void {
  db.prepare("UPDATE campaigns SET host_table_role = ?, updated_at = datetime('now') WHERE id = ?")
    .run(role, campaignId);
}
```

Add `TableRole` to the existing type import from `../shared/types.js`.

In `src/shared/types.ts`, add to the `Campaign` interface next to `phase`:

```typescript
  hostTableRole: TableRole | null;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/room.test.ts && npx tsc --noEmit`
Expected: PASS; no typecheck output.

- [ ] **Step 6: Commit**

```bash
git add src/server/db.ts src/server/room.ts src/shared/types.ts test/room.test.ts
git commit -m "feat(whispers): persist the host's table role

Nullable, so 'not chosen yet' stays distinguishable from both choices.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Rename isHost to isOwner and route authority through seat.ts

Mechanical rename plus one behavioural change: character approval now requires DM authority rather than mere ownership.

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `src/client/main.ts`, `src/client/dm-lobby.ts`, `src/client/session-store.ts`
- Modify: `test/session-persistence.test.ts` (assertions reading `isHost` from `room-joined`)

**Interfaces:**
- Consumes: `hasDmAuthority`, `isWorldAuthor` from Task 2; `Campaign.hostTableRole` from Task 3.
- Produces: `room-joined` carries `isOwner: boolean` and `tableRole: TableRole | null`. `ConnectedPlayer.isOwner` replaces `.isHost`.

- [ ] **Step 1: Write the failing test**

Append to `test/session-persistence.test.ts`:

```typescript
describe('Table role governs DM authority', () => {
  it('reports ownership and an unset table role to the creator', async () => {
    const { ws, joined } = await createGame();
    expect(joined.isOwner).toBe(true);
    expect(joined.tableRole).toBeNull();
    await closeWs(ws);
  }, 20_000);

  it('refuses character approval from an owner who chose to play', async () => {
    const { ws: hostWs, q: hostQ, joined } = await createGame();
    const { joinCode } = joined;

    sendMsg(hostWs, { type: 'choose-table-role', role: 'player' } as any);
    await hostQ.waitFor('room-joined', 10_000); // re-sent with the new role

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);
    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const review = await hostQ.waitFor('character-pending-review', 20_000) as any;

    // The owner is playing, so this approval must not take effect.
    sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });

    await expect(pq.waitFor('character-submitted', 3_000)).rejects.toThrow(/Timeout/);

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 40_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/session-persistence.test.ts -t "Table role governs"`
Expected: FAIL — `joined.isOwner` is `undefined`; `choose-table-role` is unhandled.

- [ ] **Step 3: Update the protocol**

In `src/shared/protocol.ts`:

```typescript
  | { type: 'choose-table-role'; role: import('./types.js').TableRole }
```

added to `ClientMessage`, and `room-joined` becomes:

```typescript
  | { type: 'room-joined'; campaignId: string; joinCode: string; isOwner: boolean; tableRole: import('./types.js').TableRole | null; sessionToken: string; gameName: string; playerName: string; phase: GamePhase }
```

- [ ] **Step 4: Update the server**

In `src/server/index.ts`:

1. Import the predicates:
```typescript
import { hasDmAuthority, isWorldAuthor } from './seat.js';
```
2. Rename the `ConnectedPlayer` field `isHost` → `isOwner`, and every construction site (`create`, `join`, `rejoin`) plus `hostSocket()`'s `p.isHost` and `sendLobbyState()`'s `filter(p => !p.isHost)`.
3. Every `room-joined` send gains `isOwner` (was `isHost`) and `tableRole: campaign.hostTableRole`. On `create` the campaign row is read back already — reuse it.
4. Change the guards:

| Handler | Old guard | New guard |
|---|---|---|
| `dm-chat` | `currentPlayer?.isHost` | `isWorldAuthor(currentPlayer)` |
| `update-dm-settings` | `currentPlayer?.isHost` | `isWorldAuthor(currentPlayer)` |
| `start-game` | `currentPlayer?.isHost` | `isWorldAuthor(currentPlayer)` |
| `end-game` | `currentPlayer?.isHost` | `isWorldAuthor(currentPlayer)` |
| `host-approve-character` | `currentPlayer?.isHost` | `hasDmAuthority(currentPlayer, campaign.hostTableRole)` |
| `host-reject-character` | `currentPlayer?.isHost` | `hasDmAuthority(currentPlayer, campaign.hostTableRole)` |

Both approval handlers already load `hostCampaign` via `joinRoom`; move that load above the guard so `hostTableRole` is available to it.

5. Add the handler, beside the other owner-only handlers:

```typescript
    if (msg.type === 'choose-table-role' && currentJoinCode && isWorldAuthor(currentPlayer)) {
      if (msg.role !== 'dm' && msg.role !== 'player') return;
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      if (campaign.phase !== 'lobby') {
        send(ws, { type: 'error', message: 'The table role is fixed once the game opens.' });
        return;
      }
      setHostTableRole(db, campaign.id, msg.role);
      send(ws, {
        type: 'room-joined',
        campaignId: campaign.id, joinCode: currentJoinCode,
        isOwner: true, tableRole: msg.role,
        sessionToken: currentPlayer!.sessionToken,
        gameName: campaign.name, playerName: currentPlayer!.playerName,
        phase: campaign.phase,
      });
    }
```

Add `setHostTableRole` to the existing import from `./room.js`.

- [ ] **Step 5: Update the client**

- `src/client/main.ts`: `msg.isHost` → `msg.isOwner` at all three sites (the `role:` derivation, `setRoute`, `renderFor`). Keep deriving the route from ownership — table role does not change the owner's screen until build step 3.
- `src/client/dm-lobby.ts`, `src/client/session-store.ts`: no functional change; fix any type errors the rename surfaces.
- `test/session-persistence.test.ts`: existing assertions reading `reply.isHost` / `rejoined.isHost` / `joined.isHost` become `isOwner`.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run test/seat.test.ts test/session-persistence.test.ts test/room.test.ts && npx tsc --noEmit`
Expected: PASS. The new "refuses character approval" test now passes because `hasDmAuthority` returns false.

- [ ] **Step 7: Commit**

```bash
git add -A src/ test/
git commit -m "feat(whispers): gate DM authority on the host's table role

A host who chose to play no longer approves characters — that authority
moves to the AI DM. Ownership (world setup, start/end game) is unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Gate character creation behind the world

**Files:**
- Create: `test/onboarding-phases.test.ts`
- Modify: `src/server/index.ts`

**Interfaces:**
- Consumes: `startHarness` (Task 1); `setCampaignPhase` (existing, `src/server/room.ts`).
- Produces: phase advances `lobby → character-creation` when `dmInstructions` is first persisted; `char-chat` and `submit-character` are rejected during `lobby`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/onboarding-phases.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';
import type { CharacterDefinition } from '../src/shared/types.js';
import type { WebSocket } from 'ws';

let harness: Harness;
let port: number;

const CHAR: CharacterDefinition = {
  name: 'Vex Ashgrove', backstory: 'Raised by cartographers.',
  personality: 'Curious, stubborn.', highConcept: 'Runaway Star-Cartographer',
  trouble: 'Owes a debt to the Ledger Cult',
  aspects: ['Maps are promises', 'Never look back'],
  skills: { Notice: 3, Lore: 2 }, stunts: ['Dead Reckoning: +2 to Notice.'],
};

beforeAll(async () => { harness = await startHarness(); port = harness.port; }, 30_000);
afterAll(async () => { await harness.stop(); });

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((r) => { ws.once('close', () => r()); ws.close(); });
}

async function createGame() {
  const ws = await connectWs(port);
  const q = new MessageQueue(ws);
  sendMsg(ws, { type: 'create', name: 'Gate Test', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
  const joined = await q.waitFor('room-joined', 10_000) as any;
  await q.waitFor('dm-chat-reply', 10_000); // the DM's opening greeting
  return { ws, q, joined };
}

/** Drives world setup to completion — the stub returns done:true once the host speaks. */
async function finishWorldSetup(ws: WebSocket, q: MessageQueue) {
  sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse, spooky but hopeful.' });
  const reply = await q.waitFor('dm-chat-reply', 15_000) as any;
  expect(reply.done).toBe(true);
}

describe('Character creation is gated behind the world', () => {
  it('starts a new game in the lobby phase', async () => {
    const { ws, joined } = await createGame();
    expect(joined.phase).toBe('lobby');
    await closeWs(ws);
  }, 20_000);

  it('tells a player joining during world setup that they are waiting', async () => {
    const { ws: hostWs, joined } = await createGame();
    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    const pJoined = await pq.waitFor('room-joined', 10_000) as any;

    expect(pJoined.phase).toBe('lobby');

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 20_000);

  it('refuses a character submitted before the world exists', async () => {
    const { ws: hostWs, joined } = await createGame();
    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);

    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const reply = await pq.waitForAny(['error', 'character-validated'], 10_000) as any;
    expect(reply.type).toBe('error');
    expect(reply.message).toMatch(/world/i);

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 20_000);

  it('refuses a character interview before the world exists', async () => {
    const { ws: hostWs, joined } = await createGame();
    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);

    sendMsg(playerWs, { type: 'char-chat', text: 'I want to play a thief' });
    const reply = await pq.waitForAny(['error', 'char-chat-reply'], 10_000) as any;
    expect(reply.type).toBe('error');

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 20_000);

  it('opens the table when world setup completes, and tells everyone', async () => {
    const { ws: hostWs, q: hostQ, joined } = await createGame();
    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);

    await finishWorldSetup(hostWs, hostQ);

    const phase = await pq.waitFor('phase-change', 10_000) as any;
    expect(phase.phase).toBe('character-creation');

    // And now a submission is accepted.
    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const validated = await pq.waitFor('character-validated', 20_000) as any;
    expect(validated.approved).toBe(true);

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 40_000);

  it('reports character-creation phase to someone who rejoins after the table opens', async () => {
    const { ws: hostWs, q: hostQ, joined } = await createGame();
    await finishWorldSetup(hostWs, hostQ);

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Late' });
    const pJoined = await pq.waitFor('room-joined', 10_000) as any;
    expect(pJoined.phase).toBe('character-creation');

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 40_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onboarding-phases.test.ts`
Expected: FAIL — submissions are accepted during `lobby`, and no `phase-change` to `character-creation` ever arrives.

- [ ] **Step 3: Advance the phase when setup completes**

In `src/server/index.ts`, in the `dm-chat` handler, inside the existing `if (reply.done && reply.dmInstructions)` block, after the `UPDATE campaigns` statement:

```typescript
          // World setup is what opens the table. Build step 2 replaces this
          // trigger with server-verified readiness plus seed acceptance.
          if (campaign.phase === 'lobby') {
            setCampaignPhase(db, campaign.id, 'character-creation');
            broadcast(currentJoinCode, { type: 'phase-change', phase: 'character-creation' });
          }
```

- [ ] **Step 4: Reject character work during lobby**

In `src/server/index.ts`, as the first statement inside the `submit-character` handler (before the `joinRoom` call):

```typescript
      const submitCampaign = joinRoom(db, currentJoinCode);
      if (!submitCampaign) return;
      if (submitCampaign.phase === 'lobby') {
        send(ws, { type: 'error', message: 'The DM is still building the world — character creation opens when it is ready.' });
        return;
      }
```

Reuse `submitCampaign` in place of the handler's existing `campaign` lookup rather than querying twice.

And as the first statement inside the `char-chat` handler, after its existing `joinRoom`:

```typescript
      if (campaign.phase === 'lobby') {
        send(ws, { type: 'error', message: 'The DM is still building the world — character creation opens when it is ready.' });
        return;
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/onboarding-phases.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Check for regressions**

Run: `npx vitest run test/session-persistence.test.ts test/seat.test.ts test/room.test.ts`
Expected: PASS. Note: the session tests submit characters without finishing world setup, so any that now fail must be updated to drive setup first via the same `finishWorldSetup` helper — copy it rather than importing across test files.

- [ ] **Step 7: Commit**

```bash
git add src/server/index.ts test/onboarding-phases.test.ts test/session-persistence.test.ts
git commit -m "feat(whispers): gate character creation behind world setup

Players can no longer build a character into a void. The dead
'character-creation' phase value finally does its job.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Refuse to start a game with no characters

With an empty party, `runScene` recurses forever: `initiativeOrder` is `[]`, so the per-character turn loop never runs, so `currentTurn` and `sceneTurnCount` never advance, so every safety valve keyed off them (`roundCount`, `forceSceneEnd`, `allowSceneEnd`, the session hard limit) is unreachable, and line 277 re-enters `runScene` unconditionally.

**Files:**
- Modify: `src/server/room.ts` (`countLiveCharacters`)
- Modify: `src/server/index.ts` (`start-game` guard)
- Modify: `test/onboarding-phases.test.ts`

**Interfaces:**
- Consumes: `isWorldAuthor` (Task 2).
- Produces: `countLiveCharacters(db: Database.Database, campaignId: string): number`

- [ ] **Step 1: Write the failing test**

Append to `test/onboarding-phases.test.ts`:

```typescript
describe('Starting a game requires a party', () => {
  it('refuses to start with no approved characters', async () => {
    const { ws: hostWs, q: hostQ } = await createGame();
    await finishWorldSetup(hostWs, hostQ);

    sendMsg(hostWs, { type: 'start-game' });
    const reply = await hostQ.waitForAny(['error', 'phase-change'], 10_000) as any;

    expect(reply.type).toBe('error');
    expect(reply.message).toMatch(/character/i);

    await closeWs(hostWs);
  }, 40_000);

  it('starts once a character is live', async () => {
    const { ws: hostWs, q: hostQ, joined } = await createGame();
    await finishWorldSetup(hostWs, hostQ);

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);
    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const review = await hostQ.waitFor('character-pending-review', 20_000) as any;
    sendMsg(hostWs, { type: 'host-approve-character', characterId: review.characterId });
    await pq.waitFor('character-submitted', 10_000);

    sendMsg(hostWs, { type: 'start-game' });
    const phase = await hostQ.waitFor('phase-change', 15_000) as any;
    expect(phase.phase).toBe('playing');

    await closeWs(playerWs);
    await closeWs(hostWs);
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onboarding-phases.test.ts -t "Starting a game"`
Expected: the first test FAILS — the server starts the loop and emits `phase-change: playing` with an empty party.

- [ ] **Step 3: Add the count helper**

In `src/server/room.ts`, beside `setCampaignPhase`:

```typescript
export function countLiveCharacters(db: Database.Database, campaignId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM characters WHERE campaign_id = ?').get(campaignId) as { c: number };
  return row.c;
}
```

- [ ] **Step 4: Guard start-game**

In `src/server/index.ts`, in the `start-game` handler, immediately after the `if (!campaign) return;` line:

```typescript
      // An empty party makes runScene recurse forever: every safety valve is
      // keyed off counters that only advance inside the per-character loop.
      if (countLiveCharacters(db, campaign.id) === 0) {
        send(ws, { type: 'error', message: 'You need at least one approved character before the game can start.' });
        return;
      }
```

Add `countLiveCharacters` to the existing import from `./room.js`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/onboarding-phases.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/room.ts src/server/index.ts test/onboarding-phases.test.ts
git commit -m "fix(whispers): refuse to start a game with an empty party

runScene recursed forever with no characters — initiativeOrder is empty,
so the counters every safety valve reads never advance.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: The waiting room

A player who joins during `lobby` currently gets a character creator. Give them a screen that says what is happening.

**Files:**
- Create: `src/client/waiting-room.ts`
- Modify: `src/client/main.ts`
- Modify: `src/client/style.css`

**Interfaces:**
- Consumes: `WsClient`; `lobby-state` (existing server message).
- Produces: `renderWaitingRoom(root: HTMLElement, ws: WsClient, gameName: string, joinCode: string): void`

- [ ] **Step 1: Write the view**

```typescript
// src/client/waiting-room.ts
import type { WsClient } from './ws-client.js';

/**
 * Shown to a player who arrives while the host is still building the world.
 * main.ts swaps this for the character creator on phase-change.
 */
export function renderWaitingRoom(root: HTMLElement, ws: WsClient, gameName: string, joinCode: string): void {
  root.innerHTML = `
    <div class="waiting-room">
      <h1>${gameName || 'Whispers'}</h1>
      <p class="subtitle">You're in. The DM is building the world.</p>
      <div id="ws-status" class="ws-status ws-connected">Connected</div>

      <div class="panel waiting-panel">
        <div class="waiting-pulse" aria-hidden="true"></div>
        <p class="waiting-note">
          Character creation opens once the world is ready — then the DM will
          introduce you to it before you decide who you are in it.
        </p>
        <h3>At the table</h3>
        <ul id="waiting-player-list"><li class="waiting">Just you so far...</li></ul>
        <p class="paste-hint">Join code: <code>${joinCode}</code></p>
      </div>
    </div>
  `;

  const list = root.querySelector('#waiting-player-list') as HTMLUListElement;

  function setPlayers(names: string[]) {
    list.innerHTML = '';
    if (names.length === 0) {
      list.innerHTML = '<li class="waiting">Just you so far...</li>';
      return;
    }
    for (const name of names) {
      const li = document.createElement('li');
      li.textContent = name;
      list.appendChild(li);
    }
  }

  ws.on('lobby-state', (msg) => {
    if (msg.type !== 'lobby-state') return;
    setPlayers(msg.players);
  });

  ws.on('player-joined', (msg) => {
    if (msg.type !== 'player-joined') return;
    if (list.querySelector(`li[data-name="${CSS.escape(msg.playerName)}"]`)) return;
    const waiting = list.querySelector('.waiting');
    if (waiting) waiting.remove();
    const li = document.createElement('li');
    li.textContent = msg.playerName;
    li.dataset.name = msg.playerName;
    list.appendChild(li);
  });

  const statusEl = root.querySelector('#ws-status') as HTMLElement;
  ws.onStatus((connected) => {
    statusEl.textContent = connected ? 'Connected' : 'Reconnecting…';
    statusEl.className = `ws-status ${connected ? 'ws-connected' : 'ws-disconnected'}`;
  });
}
```

- [ ] **Step 2: Route to it**

In `src/client/main.ts`, replace the body of `renderFor` with:

```typescript
function renderFor(joinCode: string, campaignId: string, owner: boolean, phase: GamePhase, gameName: string): void {
  const key = `${owner ? 'dm' : 'play'}:${joinCode}:${phase}`;
  if (currentView === key) return; // silent reconnect — leave the screen alone
  currentView = key;
  isOwner = owner;

  if (phase === 'playing' || phase === 'ended') {
    renderGameView(root, ws, owner);
  } else if (owner) {
    renderDmLobby(root, ws, joinCode, campaignId);
  } else if (phase === 'lobby') {
    renderWaitingRoom(root, ws, gameName, joinCode);
  } else {
    renderCharacterCreator(root, ws, joinCode);
  }
}
```

Update the `room-joined` handler's call to pass `msg.gameName`, and add the import.

The existing `phase-change` handler only reacts to `'playing'`. Extend it so the waiting room advances:

```typescript
ws.on('phase-change', (msg) => {
  if (msg.type !== 'phase-change') return;
  const parts = currentView?.split(':') ?? [];
  const joinCode = parts[1];
  if (!joinCode) return;
  if (msg.phase === 'playing') {
    if (currentView?.endsWith(':playing')) return;
    currentView = `${isOwner ? 'dm' : 'play'}:${joinCode}:playing`;
    renderGameView(root, ws, isOwner);
  } else if (msg.phase === 'character-creation' && !isOwner) {
    if (currentView?.endsWith(':character-creation')) return;
    currentView = `play:${joinCode}:character-creation`;
    renderCharacterCreator(root, ws, joinCode);
  }
});
```

Rename the module-level `isHost` to `isOwner` to match.

- [ ] **Step 3: Add the styles**

Append to `src/client/style.css`:

```css
/* ---- Waiting room: shown while the host builds the world ---- */
.waiting-room {
  max-width: 34rem;
  margin: 0 auto;
  padding: 3rem 1.5rem;
  text-align: center;
}
.waiting-panel {
  align-items: center;
  gap: 1.1rem;
}
.waiting-pulse {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  background: var(--ember-glow);
  border: 1px solid rgba(255, 107, 53, 0.3);
  animation: waiting-breathe 2.8s ease-in-out infinite;
}
@keyframes waiting-breathe {
  0%, 100% { transform: scale(0.85); opacity: 0.5; }
  50%      { transform: scale(1.05); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .waiting-pulse { animation: none; }
}
.waiting-note {
  color: var(--text-dim);
  line-height: 1.6;
  max-width: 28rem;
}
#waiting-player-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  width: 100%;
}
```

- [ ] **Step 4: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; build succeeds.

- [ ] **Step 5: Verify in a browser**

Boot the app against the stub LLM (see `test/lib/server-harness.ts` for the canned replies) and walk it:

1. Create a game → DM lobby, URL `#/dm/<CODE>`.
2. In a second tab open `#/play/<CODE>` and join → **waiting room**, not a character creator.
3. In the DM tab, send one setup message → the stub returns `done: true`.
4. The player tab flips to the character creator **without a reload**.
5. Refresh the player tab → still the character creator.
6. Try Start Game before any character is approved → the error from Task 6.

Capture a screenshot of the waiting room.

- [ ] **Step 6: Commit**

```bash
git add src/client/waiting-room.ts src/client/main.ts src/client/style.css
git commit -m "feat(whispers): waiting room while the world is built

Players who arrive during setup get told what is happening instead of a
character form they are not allowed to submit yet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Full verification

**Files:** none — verification only.

- [ ] **Step 1: Run the whole offline suite**

```bash
npx vitest run \
  test/seat.test.ts test/onboarding-phases.test.ts test/session-persistence.test.ts \
  test/room.test.ts test/db.test.ts test/e2e-server.test.ts test/dice.test.ts \
  test/markdown-parser.test.ts test/checkpoint.test.ts test/rag.test.ts \
  test/world-bible.test.ts test/character-memory.test.ts test/risk-trust.test.ts \
  test/scenario-seed.test.ts
```

Expected: all pass. Report the counts.

- [ ] **Step 2: Typecheck and build**

```bash
npx tsc --noEmit && npm run build
```

- [ ] **Step 3: Confirm the migration is safe on an existing database**

The migration must run against a DB created before `host_table_role` existed:

```bash
git stash && npx vitest run test/db.test.ts && git stash pop
```

Then, with the changes restored, run `test/db.test.ts` again against the same data directory and confirm `ALTER TABLE` is skipped on the second pass (the `colNames.has` guard) rather than throwing a duplicate-column error.

- [ ] **Step 4: Push**

```bash
git push
```

---

## Self-Review Notes

Checked against the spec. Covered by this plan: role split, table role persistence and choice, DM authority gating, phase gate (`lobby` → `character-creation`), waiting room, `char-chat`/`submit-character` phase rejection, zero-character start guard.

Deferred to later plans, by design, and tracked in the spec's build order:

- Influences, world seed, seed review, server-verified readiness → **step 2**
- World introduction, direct/indirect interview, persisted transcripts, preview/confirm, revoke → **step 3**
- Deliberate location growth → **step 4**
- `dmCustomPrompt` replacing the preset → **step 2** (it is a prompt-assembly change and belongs with the influences work)
- The `dnd5e` empty-rules warning → **step 2** (surfaced during the world interview)

One spec item has no task in any step and is called out here so it is not lost: `CharInterviewReplySchema` accepting `""` and `[]` is tightened in **step 3**, alongside the character readiness checklist that supersedes it.
