# Whispers Onboarding: World First, Then Characters

**Status:** design, approved in conversation 2026-09-12
**Supersedes:** the current parallel lobby flow (host setup chat and player character creation running independently)

## The problem

Today the host's setup chat and the players' character creation run in parallel and never meet. Three consequences, all observed in the code:

1. **A player can build and submit a character before any world exists.** `renderCharacterCreator` is rendered for any non-host whose phase isn't `playing`/`ended` — which is true the instant they join. Neither `char-chat` nor `submit-character` checks a phase or whether setup has happened.
2. **The character interview cannot mention the world even if one existed.** `DmAgent.interviewForCharacter` (`src/server/agents/dm.ts:279`) receives only `systemId` and chat history — no `dmInstructions`, no `dmCustomPrompt`, no world bible, no uploaded materials, no scenario. The same is true of `validateCharacter` and both `NegotiationRoom` agents; `NegotiationRoom` even holds `campaignId` and never reads it.
3. **"The world" is not data.** Setup produces two free-text blobs. The world bible — which *is* structured — is only populated after `start-game`, and only from a stock scenario file.

The fix is a sequence: build the world, then open the table, then interview players into that world.

## Principles

- **Completion is server-verified, not model-asserted.** A model may propose that a conversation is finished; the server checks a checklist and, when something is missing, tells the model what and lets the conversation continue. This is the mechanism that makes "minimum 3 influences" a rule rather than a hope.
- **Store the raw conversation, not just what we derived from it.** Raising Intelligences' strongest result came from re-reading raw player confessions hours later. The derived record was worth less than the input.
- **Never ask for the thing you are collecting** — where a story question will do. Mix in direct questions only to close gaps the checklist has identified.
- **Nothing blocks on a human who is busy playing.**

## Roles

`isHost` currently conflates three things. Split them:

| Concept | Set when | Changes? |
|---|---|---|
| **Owner** | game creation | never |
| **World author** | game creation | never — always the host |
| **Table role** | end of world setup | chosen once, then fixed |

Table role is `dm` or `player`. The host picks one and commits; they do not do both, because divided attention at the table produces neither job well. World setup belongs to the host either way.

World-building is host + AI DM alone. Letting players contribute suggestions is a deliberate future option, not in this design.

### What table role changes

| | Host as `dm` | Host as `player` |
|---|---|---|
| Runs scenes | co-DM with AI DM | AI DM alone |
| Has a character | no | yes, built through the same interview |
| Character approval | **blocking** — nothing goes live without them | **non-blocking** — AI DM approves, character goes live, host can revoke |

The non-blocking veto is the point: the host keeps a hand on the tiller without anyone waiting on them. Revocation sends the character back to its interview with the host's reason attached.

## Phases

No new phase value is needed. `GamePhase` already declares `'character-creation'` and nothing has ever set it.

```
lobby  →  character-creation  →  playing  →  ended
```

- **`lobby`** — world setup in progress. Host is in the world interview. Players who arrive see a waiting room (game name, "the DM is building the world", who else is here). They **cannot** open a character creator.
- **`character-creation`** — the host accepted the world seed and chose a table role. The table is open. Each arriving player gets the world introduction, then their interview.
- **`playing`**, **`ended`** — unchanged.

Client routing (`src/client/main.ts:20-33`) currently collapses `lobby` and `character-creation` into the same branch and its `phase-change` handler early-returns unless the phase is `playing`. Both need to handle the full set.

## World setup produces two different things

### Voice

Stylistic influences: **minimum 3**, free text named by the host, and the AI DM may propose candidates drawn from the conversation. Stored as a structured list — *not* melted into prose.

They are **voice, not content**: they shape narration, never the world bible.

This matters because of an existing bug. `DmAgent.buildSystemPrompt` (`dm.ts:390`) does:

```ts
if (ctx.dmCustomPrompt) { prompt = ctx.dmCustomPrompt + '\n'; }
```

— which *replaces* the preset file entirely, silently dropping the preset's `CRITICAL:` personality enforcement and its per-preset narration hints. Finishing world setup currently turns off the Chronicler/Trickster/Professor voice the host chose. Influences must be injected **alongside** the preset, and `dmCustomPrompt` must stop replacing it.

### Content

A structured world seed in the same shape as the stock scenario JSONs, so improvised and stock campaigns run through one path:

```
premise:      string
locations:    [{ name, description, terrain }]
npcs:         [{ name, description, disposition, motivation }]
plotHooks:    string[]
items:        [{ name, description }]
```

The AI DM drafts it at the end of the interview. The host reviews, edits, or regenerates, then accepts. Acceptance is the gate that opens the table.

**Stock scenarios feed the same path.** If the host picked a scenario at creation, its JSON pre-populates the seed draft and the world interview adapts and extends it rather than starting blank — the host is editing a world that already has a shape. There is one seed-acceptance gate regardless of where the seed came from, which is what lets improvised and stock campaigns share a code path.

Seeding reuses `GameLoop.seedScenario`'s existing mapping into `WorldBible.applyDiff(..., { allowNewLocations: true })`, moved so it runs at seed acceptance rather than at `start-game`.

## The world grows during play

`allowNewLocations: false` on every in-play `applyDiff` means unknown locations are dropped, so a campaign without a stock scenario gets **one location forever** while the DM prompt keeps instructing it to advance through locations.

That guard exists for a reason — without it, every stray noun in a narration becomes a room and the world fragments. So growth must be deliberate, not a flag flip:

- A new location is created when the DM **moves the party** to somewhere not already known — not when a place is merely mentioned.
- The new location is **connected** to the one the party came from.
- Locations invented in passing are still snapped to known locations, as now.

## Character creation

### Gated

`char-chat` and `submit-character` reject anything sent while phase is `lobby`. The client shows the waiting room, so this is a backstop against a stale tab rather than a normal path.

### The interview

It opens with the AI DM **introducing the world** — a short in-fiction passage built from the accepted seed, naming real places and people from it. Then it alternates:

- **Indirect questions** put the character in a seeded location and ask what they notice, do, or want. *"The colony's on its third failed harvest. You're at the edge of the tailing field watching the dust come in. What are you thinking about?"* Answers are mined for aspects, skills, and a trouble.
- **Direct questions** close gaps: *"What do we call them?"*

Indirect first; direct to finish. The server checklist is what makes the direct questions targeted — the model is told which fields remain unfilled, so it asks for those rather than reading a form aloud.

Indirect questions are only possible because the seed exists: the scene you drop a player into has to be a real place in the world they're about to play in.

The existing "Build here" form and "Paste markdown" tabs are **kept** as escape hatches for players who know FATE and want to type a sheet. But conversation becomes the **default tab** — currently `form` is default, which is backwards. Sheets arriving through those paths still pass the same checklist and still get the world introduction.

### Storage

The interview transcript is persisted **per turn**, alongside the derived definition. Today `charChat` lives on the in-memory `ConnectedPlayer` and is reset to `[]` on rejoin (`src/server/index.ts:293`) — a refresh mid-interview loses the entire conversation.

```sql
CREATE TABLE character_interviews (
  id            TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES campaigns(id),
  session_token TEXT NOT NULL,
  transcript    TEXT NOT NULL DEFAULT '[]',   -- JSON, appended per turn
  definition    TEXT,                          -- JSON, null until derived
  status        TEXT NOT NULL DEFAULT 'open',  -- open | confirmed | live | revoked
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

A table rather than columns on `characters`, for two reasons: the interview exists before a character does, and RI's "every new thing is a column on the games row" leaves no history and turns later analysis into a JSONB dig.

The transcript is kept after the character goes live. It is the raw material for later use — letting the character agent play someone who "never looks back", and letting the DM build scenes that press on what a player revealed sideways. Consuming it that way is **out of scope here**; this design only guarantees it is captured and durable.

### Campaign columns

```sql
ALTER TABLE campaigns ADD COLUMN influences      TEXT;  -- JSON string[]
ALTER TABLE campaigns ADD COLUMN world_seed      TEXT;  -- JSON, the accepted seed
ALTER TABLE campaigns ADD COLUMN host_table_role TEXT;  -- 'dm' | 'player'
```

## Server-verified completion

A model proposes `done`. The server checks the checklist and either advances or returns the unmet items to the model, which continues the conversation.

**World readiness** — gates `lobby → character-creation`:

- `influences.length >= 3`, each non-empty after trimming, deduplicated case-insensitively
- seed has `premise` non-empty, `locations.length >= 2`, `npcs.length >= 2`, `plotHooks.length >= 1`
- `dmInstructions` non-empty
- `hostTableRole` is `dm` or `player`
- the host has explicitly **accepted** the seed

**Character readiness** — gates a character reaching the confirm step:

- `name`, `highConcept`, `trouble` all non-empty after trimming
- `aspects.length >= 2`, all non-empty
- at least one skill, at least one stunt

A character then moves through three states, and the table role decides only the last one:

```
interview  →  checklist passes  →  player confirms preview  →  ┬─ host as dm:     awaits host approval, then live
                                                               └─ host as player: live immediately, host may revoke
```

The player's confirmation is always required. It is what makes the interview a conversation the player agreed to the outcome of, rather than one a model concluded on their behalf.

This replaces `dmReady = Boolean(campaign.dmInstructions)` (`src/server/index.ts:191`), which measures "the LLM said done once" rather than "a world exists". It also closes the disagreement where `done: true` with a null `dmInstructions` unlocks the client's Start button (`dm-lobby.ts:168`) but writes nothing to the database (`index.ts:464`), so a refresh reports `dmReady: false`.

Two validation rules taken from RI's mistakes:

- **Never let a parse failure fall through to the irreversible branch.** On malformed model output, coerce toward "not done" and keep talking — never toward "approved".
- **A failed derivation must be distinguishable from an empty one.** No `NOT NULL DEFAULT ''` columns where the empty string would be indistinguishable from a generation failure. RI ships games whose child has no temperament because of exactly this.

`CharInterviewReplySchema` (`src/server/agents/schemas.ts:103`) currently permits `""` and `[]` for every field — the checklist supersedes it, but tighten the schema too.

`validateCharacter`'s prompt (`dm.ts:316`) literally hands the model the answer: `Return ONLY: {"approved": true, ...}`. The mechanical criteria move into the server checklist; the LLM's remaining job is judgment about fit with the world, not field presence.

## Prompt changes

| Prompt | Change |
|---|---|
| `setupChat` | Becomes the world interview: premise, tone, influences (min 3), house rules. Gains campaign-materials RAG (`campaign:<id>`), which it currently has none of — uploaded rulebooks are invisible to setup today. |
| new: `draftWorldSeed` | Conversation + influences → the structured seed. Zod-validated. |
| `interviewForCharacter` | Gains world context: premise, influences, seeded locations/NPCs/hooks. Direct + indirect questions. Told which checklist fields remain unfilled. |
| `validateCharacter` | Stops checking field presence; judges fit with the world. |
| `buildSystemPrompt` | Influences injected as a first-class section; `dmCustomPrompt` augments the preset instead of replacing it. |
| `NegotiationRoom` agents | Gain world context — they currently hold `campaignId` and never use it. |

## Protocol

New client → server:
- `accept-world-seed` (host) — with any host edits
- `regenerate-world-seed` (host)
- `choose-table-role` (host) — `dm` | `player`
- `confirm-character` (player) — confirms the previewed sheet
- `revoke-character` (host, non-blocking veto) — with a reason

New server → client:
- `world-seed-draft` — the proposed seed, for host review
- `world-readiness` — checklist state, so the UI can show what's missing
- `world-introduction` — the in-fiction opening sent to a player entering character creation
- `character-preview` — derived sheet awaiting player confirmation

`lobby-state` gains `phase`, `influences`, `hostTableRole`, and the readiness checklist.

## Bugs fixed as part of this work

These are all in the paths being changed, and leaving them would undermine the design:

1. `dmCustomPrompt` replacing the DM preset, dropping personality enforcement and narration hints (`dm.ts:390`).
2. `allowNewLocations: false` producing one-location worlds (`game-loop.ts:835,858,912`).
3. **Starting with zero characters is an unbounded narration loop.** Nothing guards it client-side (`dm-lobby.ts:175` — `approvedCount` affects only hint text) or server-side (`index.ts:484`). `runScene`'s safety valves all key off counters that only advance inside the per-character turn loop, so with an empty party it recurses forever. Gate `start-game` on at least one live character.
4. `charChat` reset on rejoin, losing an in-progress interview (`index.ts:293`).
5. The `dmReady` disagreement between client and database, above.
6. `CharInterviewReplySchema` accepting empty strings and arrays.
7. "Build here" as the default character tab (`character-creator.ts:65`).
8. `dnd5e` is offered in the lobby dropdown but `data/systems/dnd5e` does not exist, so every rules lookup silently returns "(No rules found)" — including the ones behind character creation. The option stays (we do not remove features); instead the server checks at campaign creation whether the chosen system has ingested rule chunks, and if it does not, tells the host plainly in the world interview that it is running without a rulebook and offers the upload. A known-empty system becomes a visible condition rather than a silent degradation.

## Testing

Server-side, against the real server with a stubbed LLM proxy, following the pattern in `test/session-persistence.test.ts`:

- A player cannot `char-chat` or `submit-character` while phase is `lobby`.
- World readiness fails with 2 influences, passes with 3; fails with an empty premise; fails until the host accepts.
- A model claiming `done` with an incomplete payload does **not** advance the phase, and the unmet items come back.
- Malformed model output coerces to "not done", never to "approved".
- Host as `dm`: a submitted character does not go live until the host approves.
- Host as `player`: a submitted character goes live without the host, and `revoke-character` pulls it back.
- The interview transcript survives a disconnect and rejoin mid-interview.
- `start-game` is refused with zero live characters.
- A location the DM moves the party to is created and connected; a location merely mentioned is not.

Browser verification of the whole sequence — create, world interview, seed review, role choice, player joins, introduction, interview, confirm, start — before this is called done.

## Suggested build order

This is larger than one implementation plan. It decomposes into four, each shippable and verifiable on its own:

1. **Seats and phases.** Split `isHost` into owner / world author / table role. Wire the `lobby → character-creation` transition and the player waiting room. Gate `char-chat` and `submit-character` on phase. Gate `start-game` on at least one live character. No LLM changes.
2. **World setup.** Influences, the seed draft and review, server-verified world readiness, seeding the world bible at acceptance, stock scenarios feeding the draft. Fixes the `dmCustomPrompt` preset-replacement bug.
3. **Character interview.** World context into the interview, direct + indirect questions, persisted transcripts, the preview/confirm step, character readiness, the approve/revoke split by table role.
4. **World growth.** Deliberate location creation during play.

1 is a prerequisite for 2 and 3. 4 is independent and can land any time after 2.

## Out of scope

- Players contributing to world-building (the "option C" door, deliberately left open).
- Consuming stored interview transcripts for scene pressure or character-agent voice — captured now, used later.
- Accounts. "Games you're in" remains per-browser localStorage.
