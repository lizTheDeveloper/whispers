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

## Child safety
- Every safety-floor flag for sexual content involving a minor (the deterministic backstop in
  `safety-floor.ts`, the judge's `floor_sexual` list in `tone-gate.ts`, and a player's own words
  in any socket message) is filed in the studio's evidence vault — Raising Intelligences'
  `/api/internal/child-safety/evidence`, see RI's `docs/child-safety.md` — through a durable
  SQLite outbox (`src/server/child-safety/`). Never block gameplay on it, never drop a row.
- Attribution: the async scope says who sent it (socket message → that seat; a character's turn
  → the seat playing it; DM narration → the only human seat, else nobody). Verified = what this
  server authenticated (IPs via trusted proxies only, the seat's server-issued token, hashed).
  Player names are client-claimed → unverified. Co-players are always `role: participant`.
- One case per checked text (all its flagged sentences, a bounded passage window). Player text in
  a socket message is scanned in FULL; a message over the caps (`PLAYER_TEXT_MAX_*`, 512 KiB
  socket `maxPayload`) is refused unprocessed with "too long". Rate limit: 5 cases per seat and
  per IP per 10 minutes; past that every flag is still kept — as its own held row linked to one
  summary case, in full up to 50 per window then as SHA-256 + time — and sent together when the
  window closes (split into parts under RI's 100k content limit; nothing overwritten).
- Logs: call sites that print model or player text use `redactLog` (exact normalised hash match,
  ≥12 chars, incl. the 60/80/120/160-char prefixes logs print), and `installLogRedaction` filters
  every console line by the hashes of exact flagged sentences / quoted runs as a backstop.
- Client IPs come from `child-safety/trusted-ip.ts` (prod: only Traefik's 172.30.42.3 on
  llm-relay); never read `X-Forwarded-For` directly.
- Check prod with the synthetic hook: `POST /whispers/api/internal/child-safety/synthetic` with
  `Authorization: Bearer $CHILD_SAFETY_INGEST_TOKEN` — files an `isTest` case; delete it in RI.

## Production
- This repo (not `games/whispers` inside the `multiverse_games` monorepo — that's now a
  submodule/gitlink pointing here) deploys itself. Run `./deploy.sh` on the server; see
  `DEPLOY.md` for the full process (git-based deploy, DB backup before every deploy,
  build-before-stop, `/healthz` health check, auto-rollback on failure).
- Live at `play.multiversestudios.xyz/whispers/`, container `whispers-server`, on
  `multiverse-games-hel1` (ssh alias `games`), `/opt/whispers`.
- Do not rely on the `multiverse_games` monorepo's deploy tooling (`publish.sh` etc.) for
  this game — it has its own.
