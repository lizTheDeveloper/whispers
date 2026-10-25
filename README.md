# Whispers

A multiplayer agentic TTRPG. AI agents play the characters. An AI DM runs the table. You don't control your character — you *whisper* to them, and they decide whether to listen.

**Play:** https://play.multiversestudios.xyz/whispers/

## The idea

In most RPGs you are your character. In Whispers you're the voice in their head.

Each character is an LLM agent with its own memories, relationships, and state. When you whisper a suggestion, the agent weighs it against what it wants, what it remembers, and how much it has come to trust you — then follows it, partly follows it, or refuses, and tells you why. Trust drifts over the session based on how your advice actually turns out.

The DM is also an agent: it narrates scenes, resolves actions against dice the server rolls, paces a three-act structure, and builds a world bible from what actually happens at the table.

## How a game runs

1. **The host builds a world with the AI DM** — a conversation, not a form. The DM asks about tone, setting, and stylistic influences, then drafts a structured world seed: premise, locations, NPCs, plot hooks, items. The host reviews and accepts it.
2. **The host picks a lane.** Run the table alongside the AI DM, or play a character in it. Not both — world setup is always the host's, but the seat at the head of the table is a choice.
3. **Players join and build characters in conversation.** The AI DM introduces them to the world and interviews them into a character sheet with a mix of direct and indirect questions.
4. **Characters are approved.** If the host is running the table, they review. If the host is playing, the AI DM approves — and the host keeps a silent veto they can use later.
5. **Play.** Scenes run in initiative order. Humans whisper. Agents act. The server is authoritative for everything that matters.

### Whispers: who may speak, and when

A whisper is your own character's inner voice, so the server routes it by
*your seat*, not by whose input box happens to be on screen:

- You whisper to the character you built. Another player's character is not
  yours to steer, and a whisper aimed there is refused, out loud.
- **In the moment** — your character's decision window is open (30s) — the
  whisper lands immediately and that turn's verdict tells you whether it was
  heeded, partially heeded, or resisted.
- **Between moments** — no window open for your character — the whisper is
  *saved* and carried into their next decision, up to three at a time. You
  see a "carried your whisper into this choice" line and a verdict either
  way. Nothing you type is ever dropped without a reason shown back to you.
- The host seat, if it has no character of its own, is a table driver rather
  than a voice: it may whisper into whoever is deciding right now, and gets a
  refusal when nobody is. Playtest harnesses and solo-driver tables rely on
  this path.

Saved whispers live in the running game only — a server restart or an ended
table drops them, and the log says so.

## Architecture

- **The server is authoritative for all game state.** Agents propose; the server validates and applies.
- **Every agent output is validated with Zod** before it can affect anything.
- **Dice are rolled server-side only**, via `@dice-roller/rpg-dice-roller`.
- **Game state is checkpointed after every turn** for crash recovery.
- **Transcripts compact automatically** — old messages are summarised and facts extracted, so a session has no token ceiling.

```
src/client/   Vite frontend (vanilla DOM, no framework)
src/server/   Express + ws WebSocket backend
  agents/     DM, character, and extractor agents + Zod schemas
  rag/        Rulebook ingestion + SQLite FTS5 search
src/shared/   Types and the client/server protocol
data/         Bundled system chunks (FATE Core) and stock scenarios
```

## Campus cabinet

Students on [campus.themultiverse.school](https://campus.themultiverse.school) can play
Whispers inside a "web cabinet": campus loads `/whispers/?cabinet=campus` in an iframe.

- **Framing.** Every response carries
  `Content-Security-Policy: frame-ancestors 'self' https://campus.themultiverse.school`
  (merged into any CSP a handler sets) and never `X-Frame-Options`.
- **Cabinet mode** is on only when the page is framed *and* the URL has `?cabinet=campus`;
  otherwise nothing changes. In cabinet mode the page posts `mg:ready` to the campus
  origin, takes campus's `mg:pass` (a 5-minute Ed25519-signed launch pass), trades it at
  `POST /whispers/api/campus-pass` for an opaque identity token (12 h, kept server-side in
  `campus_identities`), pre-fills the join name with the campus screen name and posts
  `mg:signed-in`. The support / Stripe links are hidden in cabinet mode.
- **Seats.** `create` / `join` / `rejoin` carry the identity token; a valid one records the
  campus Matrix ID on the seat (`campaign_sessions.campus_sub`), and child-safety evidence
  then names it as a verified `matrix` identifier. An unknown or expired token is ignored —
  play goes on anonymously — and the page asks campus for a fresh pass (at most once a minute).
- **Key.** Passes are verified against campus's public key, pinned in
  `src/server/campus-pass.ts`; set `CAMPUS_PASS_PUBLIC_KEY` (base64 SPKI DER) to override it.
  The pass is never logged or stored — only its `jti` is logged.

## Running locally

```bash
npm install
cp .env.example .env    # then fill in LLM_PROXY_URL
npm run dev             # client + server
```

`LLM_PROXY_URL` should point at an OpenAI-compatible chat completions endpoint. Without it the server has no model to talk to and every agent call fails.

```bash
npm test          # vitest
npm run build     # typecheck + build client + compile server
```

Some tests are gated on a live `LLM_PROXY_URL` and skip without one. The rest run offline against a stubbed model.

## Stack

TypeScript, Vite, Express, `ws`, SQLite (better-sqlite3), Zod, Vitest.
