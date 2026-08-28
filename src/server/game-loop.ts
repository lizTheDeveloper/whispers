import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { DmAgent } from './agents/dm.js';
import { CharacterAgent } from './agents/character.js';
import { ExtractorAgent } from './agents/extractor.js';
import { WorldBible } from './world-bible.js';
import { rollDice } from './dice.js';
import { saveCheckpoint } from './checkpoint.js';
import type { Character, TranscriptMessage, RoomState } from '../shared/types.js';
import type { ServerMessage } from '../shared/protocol.js';

const COMPACTION_THRESHOLD = 50;
const COMPACTION_KEEP_RECENT = 15;

export class GameLoop {
  private dm: DmAgent;
  private characterAgent = new CharacterAgent();
  private extractor = new ExtractorAgent();
  private worldBible: WorldBible;
  private transcript: TranscriptMessage[] = [];
  private state: RoomState;
  private characters = new Map<string, Character>();
  private pendingWhisperResolve: ((text: string | null) => void) | null = null;
  private stopped = false;

  constructor(
    private db: Database.Database,
    private campaignId: string,
    private broadcastFn: (msg: ServerMessage) => void,
    private sendToHostFn: (msg: ServerMessage) => void,
    initialState: RoomState,
  ) {
    this.dm = new DmAgent(db);
    this.worldBible = new WorldBible(db);
    this.state = initialState;
  }

  loadCharacters(): void {
    const rows = this.db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(this.campaignId) as any[];
    for (const row of rows) {
      this.characters.set(row.id, {
        id: row.id,
        campaignId: row.campaign_id,
        playerUserId: row.player_user_id,
        definition: JSON.parse(row.definition),
        state: JSON.parse(row.state),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
  }

  async start(): Promise<void> {
    this.loadCharacters();
    this.state.phase = 'playing';
    this.state.currentScene = 1;
    this.state.currentTurn = 0;
    this.state.initiativeOrder = Array.from(this.characters.keys());
    this.broadcastFn({ type: 'phase-change', phase: 'playing' });

    const campaign = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(this.campaignId) as any;
    await this.runScene(campaign);
  }

  stop(): void {
    this.stopped = true;
    if (this.pendingWhisperResolve) {
      this.pendingWhisperResolve(null);
      this.pendingWhisperResolve = null;
    }
  }

  private async runScene(campaign: any): Promise<void> {
    if (this.stopped) return;

    const worldSummary = this.worldBible.getSummary(this.campaignId);
    const narration = await this.dm.narrate({
      preset: campaign.dm_preset,
      houseRules: campaign.house_rules,
      worldSummary,
      transcript: this.transcript,
      systemId: campaign.system_id,
    });

    this.addTranscript('dm', narration.narration);
    this.broadcastFn({ type: 'narration', text: narration.narration, sceneNumber: this.state.currentScene });

    if (narration.isSceneEnd) {
      await this.endScene();
      if (!this.stopped) await this.runScene(campaign);
      return;
    }

    for (const charId of this.state.initiativeOrder) {
      if (this.stopped) return;
      await this.processTurn(charId, campaign);
    }

    if (!this.stopped) await this.runScene(campaign);
  }

  private async processTurn(characterId: string, campaign: any): Promise<void> {
    const character = this.characters.get(characterId);
    if (!character) return;

    this.state.currentTurn++;
    this.state.activeCharacterId = characterId;

    const worldSummary = this.worldBible.getSummary(this.campaignId);
    const sceneNarration = this.transcript.filter(m => m.role === 'dm').slice(-3).map(m => m.content).join('\n');

    const proposals = await this.characterAgent.proposeActions({
      definition: character.definition,
      state: character.state,
      sceneNarration,
      transcript: this.transcript,
    });

    this.broadcastFn({
      type: 'action-proposals',
      characterId,
      characterName: character.definition.name,
      actions: proposals.actions.map(a => a.description),
      whisperTrust: character.state.whisperTrust,
    });

    this.state.awaitingWhisper = true;
    this.broadcastFn({ type: 'whisper-prompt', characterId, characterName: character.definition.name });

    const whisper = await this.waitForWhisper(15_000);
    this.state.awaitingWhisper = false;

    if (whisper) {
      this.addTranscript('whisper', whisper, characterId);
    }

    const decision = await this.characterAgent.decideAction(
      { definition: character.definition, state: character.state, sceneNarration, transcript: this.transcript },
      whisper,
    );

    this.addTranscript('character', `${character.definition.name}: ${decision.chosenAction}`, characterId);
    this.broadcastFn({
      type: 'action-taken',
      characterId,
      characterName: character.definition.name,
      action: decision.chosenAction,
      innerThought: decision.innerThought,
    });

    character.state.whisperTrust = Math.max(0, Math.min(1, character.state.whisperTrust + decision.trustDelta));

    const resolution = await this.dm.resolve(
      { preset: campaign.dm_preset, houseRules: campaign.house_rules, worldSummary, transcript: this.transcript, systemId: campaign.system_id },
      decision.chosenAction,
      null,
    );

    if (resolution.diceExpression) {
      const diceResult = rollDice(resolution.diceExpression);
      this.addTranscript('dice', diceResult.description);
      this.broadcastFn({ type: 'dice-roll', result: diceResult, context: decision.chosenAction });
    }

    for (const change of resolution.stateChanges) {
      this.applyStateChange(change.characterId, change.field, change.action, change.value);
    }

    this.addTranscript('dm', resolution.narration);
    this.broadcastFn({ type: 'resolution', text: resolution.narration });
    this.broadcastFn({ type: 'character-state-update', characterId, state: character.state });

    this.db.prepare("UPDATE characters SET state = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(character.state), characterId);

    saveCheckpoint(this.db, this.campaignId, this.state.currentScene, this.state.currentTurn, this.state);

    await this.maybeCompactTranscript();
  }

  private async maybeCompactTranscript(): Promise<void> {
    if (this.transcript.length < COMPACTION_THRESHOLD) return;

    const extractCount = this.transcript.length - COMPACTION_KEEP_RECENT;
    const toExtract = this.transcript.slice(0, extractCount);
    const toKeep = this.transcript.slice(extractCount);

    try {
      const facts = await this.extractor.extractFacts(toExtract, this.state.currentScene);
      this.worldBible.applyDiff(this.campaignId, facts);
    } catch (e) {
      console.error('Mid-scene fact extraction failed:', e);
    }

    const summary = await this.dm.summarizeScene(toExtract);

    this.transcript = [
      { role: 'system' as const, content: `[Session recap] ${summary}`, timestamp: new Date().toISOString() },
      ...toKeep,
    ];
  }

  private async endScene(): Promise<void> {
    const summary = await this.dm.summarizeScene(this.transcript);
    this.broadcastFn({ type: 'scene-end', summary, sceneNumber: this.state.currentScene });

    this.db.prepare('INSERT INTO scenes (id, campaign_id, scene_number, transcript, summary) VALUES (?, ?, ?, ?, ?)')
      .run(randomBytes(16).toString('hex'), this.campaignId, this.state.currentScene, JSON.stringify(this.transcript), summary);

    try {
      const facts = await this.extractor.extractFacts(this.transcript, this.state.currentScene);
      this.worldBible.applyDiff(this.campaignId, facts);
    } catch (e) {
      console.error('Fact extraction failed:', e);
    }

    this.transcript = [];
    this.state.currentScene++;
  }

  handleWhisper(text: string): void {
    if (this.pendingWhisperResolve) {
      this.pendingWhisperResolve(text);
      this.pendingWhisperResolve = null;
    }
  }

  private waitForWhisper(timeoutMs: number): Promise<string | null> {
    return new Promise(resolve => {
      this.pendingWhisperResolve = resolve;
      setTimeout(() => {
        if (this.pendingWhisperResolve === resolve) {
          this.pendingWhisperResolve = null;
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  private applyStateChange(characterId: string, field: string, action: string, value: unknown): void {
    const char = this.characters.get(characterId);
    if (!char) return;
    const state = char.state as Record<string, unknown>;
    if (action === 'set') {
      state[field] = value;
    } else if (action === 'add' && Array.isArray(state[field])) {
      (state[field] as unknown[]).push(value);
    } else if (action === 'remove' && Array.isArray(state[field])) {
      const arr = state[field] as unknown[];
      const idx = arr.indexOf(value);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  private addTranscript(role: TranscriptMessage['role'], content: string, characterId?: string): void {
    this.transcript.push({ role, content, characterId, timestamp: new Date().toISOString() });
  }
}
