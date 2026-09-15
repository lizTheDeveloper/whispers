import { WebSocket } from 'ws';
import { callLlm } from './agents/llm-client.js';
import type { CharacterDefinition } from '../shared/types.js';
import type { ServerMessage } from '../shared/protocol.js';

interface NegotiationEntry {
  sender: 'dm-agent' | 'host' | 'player' | 'char-agent';
  senderName: string;
  text: string;
}

/**
 * Hard cap on back-and-forth rounds (one DM turn + one character turn, run
 * together once both the host and the player have spoken) before the AI
 * agents step back from the negotiation. Each round costs exactly two LLM
 * calls — one DM-agent turn, one character-agent turn — so this cap bounds
 * AI spend, not the conversation itself: once it's hit, runAgentTurns()
 * never runs again for this negotiation, but the host and player keep
 * talking to each other for free (see stepBackAtCap()). That decoupling is
 * what makes it safe to set this generously.
 *
 * This project's existing precedent for "how long is too long for an
 * unbounded LLM back-and-forth" is the 35-message scene-transcript
 * compaction threshold (see CLAUDE.md). 15 rounds is 30 agent messages
 * (DM + character, twice per round) — just under that threshold, so a
 * negotiation that runs its full course still fits in one uncompacted
 * transcript, while giving a real disagreement about a character three
 * times the room the old 5-round/10-message cap did before human
 * conversation could no longer be blocked by it anyway.
 */
export const MAX_NEGOTIATION_ROUNDS = 15;

export class NegotiationRoom {
  private history: NegotiationEntry[] = [];
  private hostSpoke = false;
  private playerSpoke = false;
  private closed = false;
  /**
   * Set once the round cap is hit. This is NOT closed — the host and player
   * keep talking, and handleMessage keeps appending/broadcasting their
   * messages exactly as before. It only turns off runAgentTurns(): no more
   * DM-agent or character-agent LLM calls happen for this negotiation, ever.
   */
  private steppedBack = false;
  private round = 0;

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

    if (sender === 'host') this.hostSpoke = true;
    if (sender === 'player') this.playerSpoke = true;

    if (this.hostSpoke && this.playerSpoke) {
      this.hostSpoke = false;
      this.playerSpoke = false;
      // Once stepped back, the AI never speaks again for this negotiation —
      // the round counter and runAgentTurns() are both permanently retired,
      // but the host/player exchange above already happened and keeps
      // happening on every future call.
      if (this.steppedBack) return;
      this.round++;
      if (this.round > MAX_NEGOTIATION_ROUNDS) {
        this.stepBackAtCap();
        return;
      }
      await this.runAgentTurns();
    }
  }

  isClosed(): boolean { return this.closed; }
  isSteppedBack(): boolean { return this.steppedBack; }

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

  close(): void { this.closed = true; }

  /**
   * Reaching the round cap retires the AI, not the DISCUSSION and not the
   * DECISION. It never calls makeCharacterLive or anything like it, and it
   * never calls close() — the negotiation is NOT closed, `isClosed()` still
   * reads false, and negotiation-message keeps flowing between the host and
   * player exactly as before. Auto-approving or auto-closing here would mean
   * a timeout — not the host — decides the outcome of a stuck negotiation,
   * which is exactly the authority this feature exists to keep with the
   * host. The Approve/Reject buttons on the host's panel remain live after
   * this, same as always: only the AI stepped back.
   */
  private stepBackAtCap(): void {
    if (this.steppedBack) return;
    this.steppedBack = true;
    this.addAndBroadcast(
      'dm-agent',
      'DM',
      `We've reached the ${MAX_NEGOTIATION_ROUNDS}-round limit for AI participation in this discussion. The AI DM and ${this.definition.name} are stepping back now, but the two of you can keep talking — the host approves or rejects the character whenever ready.`,
    );
    // Structured, alongside the prose line above: negotiation-message is free
    // text a client can only ever log, not act on. A client needs something
    // it can switch on to tell "AI stepped back" apart from "negotiation
    // closed" — those are different UI states (input stays live vs. input
    // disables) and must not share one signal.
    this.sendToBoth({ type: 'negotiation-ai-stepped-back', characterId: this.characterId });
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
  }

  private async callDmAgent(userPrompt: string): Promise<string> {
    return callLlm({
      messages: [
        { role: 'system', content: `You are a TTRPG Dungeon Master ("${this.dmPreset}" style) facilitating character creation negotiation. Be fair, fun, and keep things moving. Respond in 2-4 sentences. No JSON — just speak naturally.` },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.8,
    });
  }

  private async callCharAgent(transcript: string): Promise<string> {
    const d = this.definition;
    return callLlm({
      messages: [
        { role: 'system', content: `You ARE ${d.name}. You are in a character creation discussion where the DM and other players are reviewing your character sheet. Advocate for yourself — explain why your abilities matter to your concept, but be willing to compromise on things that aren't core to who you are. Stay in character. Respond in 2-3 sentences. No JSON.

Your concept: ${d.highConcept}
Your trouble: ${d.trouble}
Your personality: ${d.personality}
Your backstory: ${d.backstory}` },
        { role: 'user', content: `Discussion so far:\n${transcript}\n\nRespond to the latest points. Defend what matters to your character, concede what doesn't.` },
      ],
      temperature: 0.9,
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
