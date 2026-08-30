import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { DmAgent } from './agents/dm.js';
import { CharacterAgent } from './agents/character.js';
import { ExtractorAgent } from './agents/extractor.js';
import { WorldBible } from './world-bible.js';
import { CharacterMemoryStore } from './character-memory.js';
import { rollDice } from './dice.js';
import { saveCheckpoint, loadCheckpoint } from './checkpoint.js';
import { generateSceneImage, clearCampaignImageCache } from './image-gen.js';
import type { Character, TranscriptMessage, RoomState } from '../shared/types.js';
import type { ServerMessage } from '../shared/protocol.js';

const COMPACTION_THRESHOLD = 35;
const COMPACTION_KEEP_RECENT = 12;

export class GameLoop {
  private dm: DmAgent;
  private characterAgent = new CharacterAgent();
  private extractor = new ExtractorAgent();
  private worldBible: WorldBible;
  private memoryStore: CharacterMemoryStore;
  private transcript: TranscriptMessage[] = [];
  private state: RoomState;
  private characters = new Map<string, Character>();
  private pendingWhisperResolve: ((text: string | null) => void) | null = null;
  private stopped = false;
  private sceneTurnCount = 0;

  constructor(
    private db: Database.Database,
    private campaignId: string,
    private broadcastFn: (msg: ServerMessage) => void,
    private sendToHostFn: (msg: ServerMessage) => void,
    initialState: RoomState,
  ) {
    this.dm = new DmAgent(db);
    this.worldBible = new WorldBible(db);
    this.memoryStore = new CharacterMemoryStore(db);
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

    const checkpoint = loadCheckpoint(this.db, this.campaignId);
    if (checkpoint && checkpoint.currentTurn > 0) {
      this.state = { ...this.state, ...checkpoint, phase: 'playing' };
      this.state.initiativeOrder = Array.from(this.characters.keys());
      this.sceneTurnCount = 0;

      const lastScene = this.db.prepare('SELECT summary FROM scenes WHERE campaign_id = ? ORDER BY scene_number DESC LIMIT 1').get(this.campaignId) as any;
      if (lastScene?.summary) {
        this.transcript = [{ role: 'system' as const, content: `[Resumed] ${lastScene.summary}`, timestamp: new Date().toISOString() }];
      }
      console.log(`[game-loop] Resuming from checkpoint: scene ${this.state.currentScene}, turn ${this.state.currentTurn}`);
    } else {
      this.state.phase = 'playing';
      this.state.currentScene = 1;
      this.state.currentTurn = 0;
      this.state.initiativeOrder = Array.from(this.characters.keys());
    }

    this.broadcastFn({ type: 'phase-change', phase: 'playing' });
    const campaign = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(this.campaignId) as any;

    if (campaign.scenario_id && !checkpoint) {
      await this.seedScenario(campaign.scenario_id);
    }

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
    if ((this.state.currentTurn ?? 0) >= 50) {
      console.log(`[game-loop] Session hard limit (50 turns) — ending session`);
      await this.endScene();
      this.broadcastFn({ type: 'phase-change', phase: 'ended' });
      this.stopped = true;
      return;
    }

    const worldSummary = this.worldBible.getSummary(this.campaignId);
    let narration;
    try {
      narration = await this.dm.narrate({
        preset: campaign.dm_preset,
        houseRules: campaign.house_rules,
        dmInstructions: campaign.dm_instructions ?? null,
        dmCustomPrompt: campaign.dm_custom_prompt ?? null,
        campaignId: this.campaignId,
        worldSummary,
        transcript: this.transcript,
        systemId: campaign.system_id,
      }, {
        sceneNumber: this.state.currentScene,
        sceneTurnCount: this.sceneTurnCount,
        characterSummaries: this.getCharacterSummaries(),
        partySize: this.characters.size || 1,
        sessionTurnCount: this.state.currentTurn,
      });
    } catch (e) {
      console.error('[game-loop] narration failed:', e);
      narration = { narration: 'The scene continues...', currentLocationName: '', activeNpcs: [], isSceneEnd: false };
    }

    this.addTranscript('dm', narration.narration);
    this.broadcastFn({ type: 'narration', text: narration.narration, sceneNumber: this.state.currentScene });

    if (narration.currentLocationName) {
      generateSceneImage(this.campaignId, narration.currentLocationName, narration.narration)
        .then(result => {
          if (result.imageUrl) {
            this.broadcastFn({ type: 'scene-image', imageUrl: result.imageUrl, locationName: narration.currentLocationName });
          }
        })
        .catch(() => {});
    }

    const partySize = this.characters.size || 1;
    const roundCount = Math.floor(this.sceneTurnCount / partySize);
    const isFinale = this.state.currentScene >= 5 && (this.state.currentTurn ?? 0) >= 20;
    const hardCap = isFinale ? 6 : 10;
    const forceSceneEnd = roundCount >= hardCap;
    if (forceSceneEnd) {
      console.log(`[game-loop] Forcing scene end at round ${roundCount} (${isFinale ? 'finale' : 'hard'} cap)`);
    }

    const minRounds = (this.state.currentScene >= 5) ? 3 : 2;
    const allowSceneEnd = roundCount >= minRounds || forceSceneEnd;
    if ((narration.isSceneEnd && allowSceneEnd) || forceSceneEnd) {
      await this.endScene();
      if (isFinale) {
        console.log(`[game-loop] Finale scene concluded — session complete`);
        this.broadcastFn({ type: 'phase-change', phase: 'ended' });
        this.stopped = true;
        return;
      }
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
    this.sceneTurnCount++;
    this.state.activeCharacterId = characterId;

    const worldSummary = this.worldBible.getSummary(this.campaignId);
    const charWorldContext = this.worldBible.getCompactSummary(this.campaignId);
    const sceneNarration = this.transcript.filter(m => m.role === 'dm').slice(-3).map(m => m.content).join('\n');

    const memories = this.memoryStore.recall(characterId, 8, sceneNarration);

    let proposals;
    try {
      proposals = await this.characterAgent.proposeActions({
        definition: character.definition,
        state: character.state,
        sceneNarration,
        transcript: this.transcript,
        memories,
        worldContext: charWorldContext,
      });
    } catch (e) {
      console.error('[game-loop] action proposal failed:', e);
      proposals = { actions: [{ description: 'Look around cautiously', reasoning: 'Default action' }, { description: 'Press forward despite the uncertainty', reasoning: 'Fallback bold option' }] };
    }

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

    let decision;
    try {
      decision = await this.characterAgent.decideAction(
        { definition: character.definition, state: character.state, sceneNarration, transcript: this.transcript, memories, worldContext: charWorldContext },
        whisper,
      );
    } catch (e) {
      console.error('[game-loop] action decision failed:', e);
      decision = {
        chosenAction: proposals.actions[0]?.description ?? 'Waits and observes',
        innerThought: 'Something feels off...',
        whisperedInfluence: 'ignored' as const,
        trustDelta: 0,
      };
    }

    this.addTranscript('character', `${character.definition.name}: ${decision.chosenAction}`, characterId);
    if (whisper) {
      const influenceNote = decision.whisperedInfluence === 'followed'
        ? `${character.definition.name} heeded the whisper`
        : decision.whisperedInfluence === 'partially-followed'
        ? `${character.definition.name} partially heeded the whisper`
        : `${character.definition.name} resisted the whisper`;
      this.addTranscript('system', `[${influenceNote}, trust: ${character.state.whisperTrust.toFixed(2)}]`, characterId);
    }
    this.broadcastFn({
      type: 'action-taken',
      characterId,
      characterName: character.definition.name,
      action: decision.chosenAction,
      innerThought: decision.innerThought,
      whisperInfluence: whisper ? decision.whisperedInfluence : 'none',
    });

    let effectiveDelta = decision.trustDelta;
    if (whisper && effectiveDelta === 0) {
      effectiveDelta = decision.whisperedInfluence === 'ignored' ? -0.05 : 0.03;
    }
    // Trust drops fast (up to -0.15) but recovers slowly (capped at +0.05)
    if (effectiveDelta > 0.05) effectiveDelta = 0.05;
    character.state.whisperTrust = Math.max(0, Math.min(0.95, character.state.whisperTrust + effectiveDelta));

    const diceResult = rollDice(this.getSystemDefaultDice(campaign.system_id));
    this.addTranscript('dice', diceResult.description);
    this.broadcastFn({ type: 'dice-roll', result: diceResult, context: decision.chosenAction });

    let resolution;
    try {
      resolution = await this.dm.resolve(
        {
          preset: campaign.dm_preset, houseRules: campaign.house_rules,
          dmInstructions: campaign.dm_instructions ?? null, dmCustomPrompt: campaign.dm_custom_prompt ?? null,
          campaignId: this.campaignId, worldSummary, transcript: this.transcript, systemId: campaign.system_id,
        },
        decision.chosenAction,
        diceResult,
        this.state.currentScene,
      );
    } catch (e) {
      console.error('[game-loop] resolution failed, narrating without mechanics:', e);
      resolution = {
        diceExpression: null, difficulty: null, skill: null,
        outcome: 'success' as const,
        narration: `${character.definition.name} attempts to ${decision.chosenAction.toLowerCase()}...`,
        stateChanges: [],
      };
    }

    if (resolution.narration === 'The action unfolds...') {
      const outcomeWord = resolution.outcome === 'failure' ? 'struggles with' : resolution.outcome === 'tie' ? 'barely manages' : 'pushes through';
      resolution.narration = `${character.definition.name} ${outcomeWord} the attempt to ${decision.chosenAction.toLowerCase()}.`;
    }

    for (const change of resolution.stateChanges) {
      if (change.characterId && change.field && change.action) {
        this.applyStateChange(change.characterId, change.field, change.action, change.value);
      }
    }

    this.addTranscript('dm', resolution.narration);
    this.broadcastFn({ type: 'resolution', text: resolution.narration });
    this.broadcastFn({ type: 'character-state-update', characterId, state: character.state });

    this.db.prepare("UPDATE characters SET state = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(character.state), characterId);

    this.memoryStore.extractAndStore(
      characterId, this.campaignId, character.definition.name,
      decision.chosenAction, resolution.narration, whisper,
      this.state.currentScene, this.state.currentTurn,
    ).catch(e => console.error('[memory] extraction failed:', e));

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
    let summary: string;
    try {
      summary = await this.dm.summarizeScene(this.transcript);
    } catch (e) {
      console.error('[game-loop] Scene summary failed:', e);
      summary = 'The scene draws to a close.';
    }
    this.broadcastFn({ type: 'scene-end', summary, sceneNumber: this.state.currentScene });

    this.db.prepare('INSERT INTO scenes (id, campaign_id, scene_number, transcript, summary) VALUES (?, ?, ?, ?, ?)')
      .run(randomBytes(16).toString('hex'), this.campaignId, this.state.currentScene, JSON.stringify(this.transcript), summary);

    try {
      const facts = await this.extractor.extractFacts(this.transcript, this.state.currentScene);
      console.log('[game-loop] Fact extraction succeeded:', JSON.stringify({
        locations: facts.newLocations.length,
        entities: facts.newEntities.length,
        items: facts.newItems.length,
        events: facts.newEvents.length,
        relationships: facts.newRelationships.length,
      }));
      this.worldBible.applyDiff(this.campaignId, facts);
    } catch (e: any) {
      console.error('[game-loop] Fact extraction failed:', e.message?.slice(0, 200));
    }

    for (const charId of this.characters.keys()) {
      this.memoryStore.decayMemories(charId);
    }

    this.transcript = [
      { role: 'system' as const, content: `[Previous scene] ${summary}`, timestamp: new Date().toISOString() },
    ];
    this.sceneTurnCount = 0;
    this.state.currentScene++;
    clearCampaignImageCache(this.campaignId);
  }

  private async seedScenario(scenarioId: string): Promise<void> {
    if (!/^[a-z0-9-]{1,64}$/.test(scenarioId)) {
      console.warn(`[game-loop] Invalid scenario id: ${scenarioId}`);
      return;
    }
    try {
      const base = dirname(fileURLToPath(import.meta.url));
      const scenariosDir = resolve(base, '../../data/scenarios');
      const scenarioPath = resolve(scenariosDir, `${scenarioId}.json`);
      if (!scenarioPath.startsWith(scenariosDir + '/')) {
        console.warn(`[game-loop] Scenario path traversal blocked: ${scenarioId}`);
        return;
      }
      const scenario = JSON.parse(readFileSync(scenarioPath, 'utf-8'));

      const diff = {
        newLocations: (scenario.locations ?? []).map((l: any) => ({ name: l.name, description: l.description, terrain: l.terrain ?? null })),
        newEntities: (scenario.npcs ?? []).map((n: any) => ({ name: n.name, type: 'npc', description: n.description, disposition: n.disposition ?? null })),
        newItems: [] as any[],
        newEvents: (scenario.plotHooks ?? []).map((hook: string, i: number) => ({ sceneNumber: 0, description: hook, participants: [], outcome: null })),
        newRelationships: [] as any[],
      };
      this.worldBible.applyDiff(this.campaignId, diff);

      if (scenario.openingNarration) {
        this.transcript.push({ role: 'system' as const, content: `[Scenario] ${scenario.openingNarration}`, timestamp: new Date().toISOString() });
      }
      console.log(`[game-loop] Seeded scenario "${scenario.name}": ${diff.newLocations.length} locations, ${diff.newEntities.length} NPCs, ${diff.newEvents.length} plot hooks`);
    } catch (e: any) {
      console.warn(`[game-loop] Failed to load scenario ${scenarioId}: ${e.message}`);
    }
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
    const state = char.state as unknown as Record<string, unknown>;
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

  private getSystemDefaultDice(systemId: string): string {
    switch (systemId) {
      case 'fate-core': return '4dF';
      case 'dnd-5e': return '1d20';
      default: return '4dF';
    }
  }

  private getCharacterSummaries(): string {
    return Array.from(this.characters.values())
      .map(c => {
        const d = c.definition;
        const s = c.state;
        return `${d.name}: ${d.highConcept} | Stress: ${s.stress} | Consequences: ${s.consequences.join(', ') || 'none'} | FP: ${s.fatePoints}`;
      })
      .join('\n');
  }

  private addTranscript(role: TranscriptMessage['role'], content: string, characterId?: string): void {
    this.transcript.push({ role, content, characterId, timestamp: new Date().toISOString() });
  }
}
