# Whispers — Agentic TTRPG

## What This Is
Multiplayer agentic TTRPG. AI agents play characters, humans whisper to influence them, AI DM runs the game.

## Tech Stack
- Frontend: TypeScript + Vite (vanilla DOM)
- Backend: Express + ws (WebSocket)
- Database: SQLite (better-sqlite3). File lives at `STATE_DIR/whispers.db` (defaults to
  `DATA_DIR` for local dev/tests). In production `STATE_DIR` is a mounted volume, kept
  separate from `DATA_DIR`'s static content — see "Production" below.
- LLM: Shared proxy at LLM_PROXY_URL

## Key Patterns
- Server is authoritative for ALL game state. Agents propose, server validates and applies.
- All agent outputs validated with Zod before affecting state.
- Dice rolled server-side only via @dice-roller/rpg-dice-roller.
- Game state checkpointed after every turn for crash recovery.
- Transcript compacts automatically at 35 messages — triggers fact extraction mid-scene, replaces old messages with a summary. No session token limit.
- Scene pacing: 3-act structure (I=setup, II=confrontation, III=resolution at scene 4+, finale at scene 5+). Server hard-caps scenes at 10 rounds. Minimum 2 rounds per scene (3 for finale).
- LLM calls: POST to LLM_PROXY_URL/api/llm/think with X-Game: whispers header.

## Commands
- `npm run dev` — run client + server in dev mode
- `npm run build` — typecheck + build client + compile server
- `npm test` — run vitest
- `npm start` — run production server

## File Layout
- src/client/ — Vite frontend
- src/server/ — Express + WebSocket backend
- src/server/agents/ — DM, Character, Extractor agents + Zod schemas
- src/server/rag/ — Rulebook ingestion + FTS5 search
- src/shared/ — Types + protocol shared between client and server
- data/systems/ — Bundled TTRPG system chunks (FATE Core) — static, baked into the image
- data/scenarios/ — Stock scenario JSON files — static, baked into the image
- data/dm-presets/ — DM personality system prompts — static, baked into the image
- (production only) the live `whispers.db` — NOT under `data/`, lives on `STATE_DIR`
  (a separate mounted volume in prod) precisely so it doesn't collide with the static
  content above. See `src/server/db.ts` and "Production" below.

## Production
- This repo (not `games/whispers` inside the `multiverse_games` monorepo — that's now a
  submodule/gitlink pointing here) deploys itself. Run `./deploy.sh` on the server; see
  `DEPLOY.md` for the full process (git-based deploy, DB backup before every deploy,
  build-before-stop, `/healthz` health check, auto-rollback on failure).
- Live at `play.multiversestudios.xyz/whispers/`, container `whispers-server`, on
  `multiverse-games-hel1` (ssh alias `games`), `/opt/whispers`.
- Do not rely on the `multiverse_games` monorepo's deploy tooling (`publish.sh` etc.) for
  this game — it has its own.
