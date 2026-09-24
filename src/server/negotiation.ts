import { WebSocket } from 'ws';
import { callLlm } from './agents/llm-client.js';
import { PLAIN_PROSE_STYLE } from './agents/style.js';
import type { CharacterDefinition } from '../shared/types.js';
import type { ServerMessage } from '../shared/protocol.js';

interface NegotiationEntry {
  // 'summary' is a compaction artifact (see maybeCompactHistory below), not
  // a real speaker — it never comes from addAndBroadcast/sendToBoth, only
  // from history compaction replacing older entries in place.
  sender: 'dm-agent' | 'host' | 'player' | 'char-agent' | 'summary';
  senderName: string;
  text: string;
}

/**
 * There is no round cap: a negotiation runs as long as its participants want
 * it to. A human has to type to advance every round (see handleMessage's
 * hostSpoke/playerSpoke gate below), which already bounds AI spend the same
 * way the main game loop's turn-by-turn pacing does — nothing here needs a
 * second, cruder limiter on top of that.
 *
 * What DOES need bounding is the prompt: runAgentTurns rebuilds it from the
 * entire `history` array every round, so left alone that prompt would grow
 * without bound over a long negotiation. This project already solves exactly
 * that problem for the main game transcript (see game-loop.ts's
 * BASE_COMPACTION_THRESHOLD/BASE_COMPACTION_KEEP_RECENT and
 * maybeCompactTranscript) — maybeCompactHistory below is the same pattern
 * applied here.
 *
 * The numbers are scaled down from game-loop's 35/12, because a negotiation
 * is a tighter, two-party conversation, not a whole party's play session:
 * every negotiation round always produces exactly 4 entries (host, player,
 * dm-agent, char-agent — see handleMessage/runAgentTurns), where a game
 * turn's entry count varies with party size and scene pacing. Game-loop's
 * base case is effectively a party of one, i.e. every ~3 of its messages is
 * one actor's turn; a negotiation round is denser at 4 entries for a single
 * back-and-forth. Threshold and keep-recent are each held to that same
 * ~1:3 ratio as game-loop's 12/35, rounded to whole rounds (4 entries) for a
 * round number that is easy to reason about in terms of "how many rounds of
 * back-and-forth does this keep verbatim": 20 entries (5 rounds) before
 * compacting, keeping the most recent 8 (2 rounds). That is comfortably
 * inside the old 15-round/60-entry cap this replaces, so a negotiation that
 * used to run its full course would already have compacted twice over by
 * the time it hit the old limit — and now it just keeps going instead of
 * stopping. (Compaction is checked after every append to `history`, not
 * just at round boundaries — see maybeCompactHistory — so it can in
 * practice fire mid-round; the round-sized numbers are chosen for a clean
 * justification, not a guaranteed alignment.)
 */
const NEGOTIATION_COMPACTION_THRESHOLD = 20;
const NEGOTIATION_COMPACTION_KEEP_RECENT = 8;

export class NegotiationRoom {
  private history: NegotiationEntry[] = [];
  private hostSpoke = false;
  private playerSpoke = false;
  private closed = false;

  /**
   * Sockets are resolved on every send rather than captured up front: either
   * side may refresh mid-negotiation, which replaces their socket entirely.
   * A captured reference would keep writing into a dead socket forever.
   */
  constructor(
    readonly characterId: string,
    readonly definition: CharacterDefinition,
    readonly aiFeedback: string,
    readonly playerName: string,
    private resolvePlayerWs: () => WebSocket | null,
    private resolveHostWs: () => WebSocket | null,
    private campaignId: string,
    private dmPreset: string,
    /** Which room this negotiation belongs to, so room teardown can find it. */
    readonly joinCode: string,
  ) {}

  async open(): Promise<void> {
    this.sendToBoth({ type: 'negotiation-opened', characterId: this.characterId, characterName: this.definition.name, playerName: this.playerName });

    const dmOpening = await this.callDmAgent(
      `A player named "${this.playerName}" has submitted a character sheet for "${this.definition.name}".

Character sheet:
${JSON.stringify(this.definition, null, 2)}

Your earlier validation assessment: ${this.aiFeedback}

Introduce the character to the group. Summarize the sheet, note what you like, and raise any concerns about balance or rule compliance. Be conversational — this is a negotiation, not a ruling. Address both the host and the player.`
    );
    // Same race as runAgentTurns below: close() can land while this await is
    // outstanding (approve/reject/teardown all run independently of open()).
    if (this.closed) return;
    this.addAndBroadcast('dm-agent', 'DM', dmOpening);
  }

  async handleMessage(sender: 'host' | 'player', senderName: string, text: string): Promise<void> {
    if (this.closed) return;

    this.addAndBroadcast(sender, senderName, text);
    await this.maybeCompactHistory();
    if (this.closed) return;

    if (sender === 'host') this.hostSpoke = true;
    if (sender === 'player') this.playerSpoke = true;

    if (this.hostSpoke && this.playerSpoke) {
      this.hostSpoke = false;
      this.playerSpoke = false;
      await this.runAgentTurns();
    }
  }

  isClosed(): boolean { return this.closed; }

  isParticipant(ws: WebSocket): 'host' | 'player' | null {
    if (ws === this.resolveHostWs()) return 'host';
    if (ws === this.resolvePlayerWs()) return 'player';
    return null;
  }

  /** Replay the conversation so far into a reconnected participant's screen. */
  replayTo(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'negotiation-opened',
      characterId: this.characterId,
      characterName: this.definition.name,
      playerName: this.playerName,
    } satisfies ServerMessage));
    for (const e of this.history) {
      ws.send(JSON.stringify({
        type: 'negotiation-message',
        characterId: this.characterId,
        sender: e.sender,
        senderName: e.senderName,
        text: e.text,
      } satisfies ServerMessage));
    }
  }

  /**
   * The single place every genuine close goes through — host-approve-
   * character, host-reject-character, revoke-character, and room teardown
   * all call this (see src/server/index.ts) — so `negotiation-closed`
   * fires from here once, rather than being duplicated at each call site
   * and inevitably missed at a new one. Idempotent: a second close() call
   * on an already-closed instance (defensive — no current call site does
   * this, since every one also deletes its map entry right after calling
   * close()) is a no-op rather than a second broadcast.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sendToBoth({ type: 'negotiation-closed', characterId: this.characterId });
  }

  /**
   * `close()` can land mid-call from host-approve-character, host-reject-
   * character, or room teardown — all of which run independently of this
   * method's own control flow, while a `callDmAgent`/`callCharAgent` await is
   * outstanding. Checking `closed` only between the two calls left the
   * window right after each `await` resolves unguarded: a close landing
   * there still appended to `history` and broadcast. That is not just a
   * stray message — `resolvePlayerWs`/`resolveHostWs` are dynamic closures,
   * so if a fresh negotiation for the same character has since opened (the
   * leak fix in this same task makes that possible), a dead negotiation's
   * late reply broadcasts onto sockets now bound to the NEW negotiation's
   * panel, about a decision already made. So: re-check immediately after
   * EVERY await, before anything that mutates history or sends — not just
   * between the two calls.
   */
  private async runAgentTurns(): Promise<void> {
    if (this.closed) return;

    const transcript = this.history.map(e => `[${e.senderName}] ${e.text}`).join('\n');

    const dmReply = await this.callDmAgent(
      `The negotiation continues for character "${this.definition.name}".

Conversation so far:
${transcript}

Respond to the latest messages. If there are disagreements, propose a compromise. If everyone seems aligned, suggest finalizing. Be brief and conversational.`
    );
    if (this.closed) return;
    this.addAndBroadcast('dm-agent', 'DM', dmReply);

    const charReply = await this.callCharAgent(transcript);
    if (this.closed) return;
    this.addAndBroadcast('char-agent', this.definition.name, charReply);

    await this.maybeCompactHistory();
  }

  private async callDmAgent(userPrompt: string): Promise<string> {
    return callLlm({
      messages: [
        { role: 'system', content: `You are a TTRPG Dungeon Master ("${this.dmPreset}" style) facilitating character creation negotiation. Be fair, fun, and keep things moving. Respond in 2-4 sentences. No JSON — just speak naturally. ${PLAIN_PROSE_STYLE}` },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.8,
    });
  }

  private async callCharAgent(transcript: string): Promise<string> {
    const d = this.definition;
    return callLlm({
      messages: [
        { role: 'system', content: `You ARE ${d.name}. You are in a character creation discussion where the DM and other players are reviewing your character sheet. Advocate for yourself — explain why your abilities matter to your concept, but be willing to compromise on things that aren't core to who you are. Stay in character. Respond in 2-3 sentences. No JSON. ${PLAIN_PROSE_STYLE}

Your concept: ${d.highConcept}
Your trouble: ${d.trouble}
Your personality: ${d.personality}
Your backstory: ${d.backstory}` },
        { role: 'user', content: `Discussion so far:\n${transcript}\n\nRespond to the latest points. Defend what matters to your character, concede what doesn't.` },
      ],
      temperature: 0.9,
    });
  }

  /**
   * Mirrors game-loop.ts's maybeCompactTranscript: once `history` crosses
   * NEGOTIATION_COMPACTION_THRESHOLD entries, summarise everything except
   * the most recent NEGOTIATION_COMPACTION_KEEP_RECENT into one entry and
   * splice it in ahead of them. This keeps runAgentTurns' prompt bounded no
   * matter how long the negotiation runs, without ever needing to stop the
   * agents from participating.
   *
   * Called after every append to `history` — both from handleMessage's raw
   * host/player lines and from runAgentTurns' own agent replies — rather
   * than once per round like game-loop's per-turn check. Unlike a game turn,
   * which always produces a fixed few transcript entries before the next
   * compaction check, one side of a negotiation can push several host-only
   * or player-only messages before the other replies and advances the round
   * (see handleMessage's hostSpoke/playerSpoke gate). Checking after every
   * append is the only way to guarantee the bound regardless of that shape.
   */
  private async maybeCompactHistory(): Promise<void> {
    if (this.history.length < NEGOTIATION_COMPACTION_THRESHOLD) return;

    console.log(`[negotiation] History compaction triggered at ${this.history.length} entries (threshold: ${NEGOTIATION_COMPACTION_THRESHOLD})`);
    const extractCount = this.history.length - NEGOTIATION_COMPACTION_KEEP_RECENT;
    const toSummarize = this.history.slice(0, extractCount);
    const toKeep = this.history.slice(extractCount);

    let summary: string;
    try {
      summary = await this.summarizeHistory(toSummarize);
    } catch (e) {
      console.error('[negotiation] Compaction summary failed, falling back to the last pre-compaction line:', e);
      summary = toSummarize.at(-1)?.text ?? 'The discussion continues.';
    }
    // Same race as runAgentTurns/open(): close() (approve/reject/teardown)
    // runs independently of this await. A close landing here must not
    // resurrect `history` for a negotiation that's already been decided —
    // just drop the summary instead of mutating history post-close.
    if (this.closed) return;

    this.history = [
      { sender: 'summary', senderName: 'Recap', text: `[Negotiation recap] ${summary}` },
      ...toKeep,
    ];
    console.log(`[negotiation] Compaction complete: ${extractCount} entries → 1 summary + ${toKeep.length} kept = ${this.history.length} total`);
  }

  /**
   * Dispatch substring for this system prompt — "summarizing a
   * character-negotiation discussion" — is unique across every prompt this
   * server sends: checked against this file's own DM/character-agent
   * prompts ("facilitating character creation negotiation" / "character
   * creation discussion"), dm.ts's summarizeScene ("Summarize TTRPG
   * scenes"), and every other system prompt under src/server/agents/. See
   * test/lib/server-harness.ts for the dispatcher branch keyed on it.
   */
  private async summarizeHistory(entries: NegotiationEntry[]): Promise<string> {
    const transcript = entries.map(e => `[${e.senderName}] ${e.text}`).join('\n');
    return callLlm({
      messages: [
        { role: 'system', content: 'You are summarizing a character-negotiation discussion so older messages can be compacted out of the prompt. Preserve every substantive position taken by the host, the player, the DM, and the character — especially any agreements reached or disagreements still unresolved. Output ONLY the recap, 2-4 sentences, no roleplay, no JSON.' },
        { role: 'user', content: `Discussion so far:\n${transcript}\n\nSummarize it.` },
      ],
      maxTokens: 512,
    });
  }

  private addAndBroadcast(sender: NegotiationEntry['sender'], senderName: string, text: string): void {
    this.history.push({ sender, senderName, text });
    const msg: ServerMessage = { type: 'negotiation-message', characterId: this.characterId, sender, senderName, text };
    this.sendToBoth(msg);
  }

  private sendToBoth(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    const playerWs = this.resolvePlayerWs();
    const hostWs = this.resolveHostWs();
    if (playerWs && playerWs.readyState === WebSocket.OPEN) playerWs.send(data);
    if (hostWs && hostWs.readyState === WebSocket.OPEN) hostWs.send(data);
  }
}
