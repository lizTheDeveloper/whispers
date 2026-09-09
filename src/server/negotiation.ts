import { WebSocket } from 'ws';
import { callLlm } from './agents/llm-client.js';
import type { CharacterDefinition } from '../shared/types.js';
import type { ServerMessage } from '../shared/protocol.js';

interface NegotiationEntry {
  sender: 'dm-agent' | 'host' | 'player' | 'char-agent';
  senderName: string;
  text: string;
}

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

  close(): void { this.closed = true; }

  private async runAgentTurns(): Promise<void> {
    if (this.closed) return;

    const transcript = this.history.map(e => `[${e.senderName}] ${e.text}`).join('\n');

    const dmReply = await this.callDmAgent(
      `The negotiation continues for character "${this.definition.name}".

Conversation so far:
${transcript}

Respond to the latest messages. If there are disagreements, propose a compromise. If everyone seems aligned, suggest finalizing. Be brief and conversational.`
    );
    this.addAndBroadcast('dm-agent', 'DM', dmReply);

    if (this.closed) return;

    const charReply = await this.callCharAgent(transcript);
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
