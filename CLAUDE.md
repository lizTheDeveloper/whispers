# Whispers — Agentic TTRPG

## What This Is
Multiplayer agentic TTRPG. AI agents play characters, humans whisper to influence them, AI DM runs the game.

## Tech Stack
- Frontend: TypeScript + Vite (vanilla DOM)
- Backend: Express + ws (WebSocket)
- Database: SQLite (better-sqlite3)
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
- data/systems/ — Bundled TTRPG system chunks (FATE Core)
- data/scenarios/ — Stock scenario JSON files
- data/dm-presets/ — DM personality system prompts
