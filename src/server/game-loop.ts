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
import { callLlm } from './agents/llm-client.js';
import { rollDice } from './dice.js';
import { saveCheckpoint, loadCheckpoint } from './checkpoint.js';
import { generateSceneImage, clearCampaignImageCache } from './image-gen.js';
import type { Character, TranscriptMessage, RoomState } from '../shared/types.js';
import type { ServerMessage } from '../shared/protocol.js';

const BASE_COMPACTION_THRESHOLD = 35;
const BASE_COMPACTION_KEEP_RECENT = 12;

const TITLES = new Set(['dame', 'sir', 'lord', 'lady', 'prince', 'princess', 'king', 'queen', 'duke', 'duchess', 'count', 'countess', 'baron', 'baroness', 'master', 'captain', 'elder', 'chief']);
function getFirstName(fullName: string): string {
  const parts = fullName.split(/\s+/);
  return parts.find(p => !TITLES.has(p.toLowerCase())) ?? parts[0]!;
}

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
  private locationTurnCount = 0;
  private lastLocationName = '';

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
      this.sceneTurnCount = checkpoint.sceneTurnCount ?? 0;

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

  async endGame(): Promise<void> {
    this.stop();
    await this.generateEpilogue();
    this.broadcastFn({ type: 'phase-change', phase: 'ended' });
  }

  private async runScene(campaign: any): Promise<void> {
    if (this.stopped) return;
    const partySize = this.characters.size || 1;
    const sessionHardLimit = 50 + (partySize - 1) * 10;
    if ((this.state.currentTurn ?? 0) >= sessionHardLimit) {
      console.log(`[game-loop] Session hard limit (${sessionHardLimit} turns, party ${partySize}) — ending session`);
      await this.endScene();
      await this.generateEpilogue();
      this.broadcastFn({ type: 'phase-change', phase: 'ended' });
      this.stopped = true;
      return;
    }

    const worldSummary = this.worldBible.getSummary(this.campaignId, this.state.currentLocationId ?? undefined);
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
        locationTurnCount: this.locationTurnCount,
        currentLocationName: this.lastLocationName || undefined,
      });
    } catch (e) {
      console.error('[game-loop] narration failed:', e);
      narration = { narration: 'The scene continues...', currentLocationName: '', activeNpcs: [], isSceneEnd: false };
    }

    this.addTranscript('dm', narration.narration);
    this.broadcastFn({ type: 'narration', text: narration.narration, sceneNumber: this.state.currentScene, locationName: narration.currentLocationName || undefined });

    if (narration.currentLocationName) {
      if (narration.currentLocationName === this.lastLocationName) {
        this.locationTurnCount++;
      } else {
        this.locationTurnCount = 1;
        this.lastLocationName = narration.currentLocationName;
      }
      let loc = this.worldBible.getLocationByName(this.campaignId, narration.currentLocationName);
      if (!loc) {
        const newId = randomBytes(16).toString('hex');
        this.worldBible.addLocation({ id: newId, campaignId: this.campaignId, name: narration.currentLocationName, description: null, terrain: null, connections: [], coords: null });
        loc = { id: newId, campaignId: this.campaignId, name: narration.currentLocationName, description: null, terrain: null, connections: [], coords: null };
        console.log(`[game-loop] Auto-created location "${narration.currentLocationName}" from DM narration`);
      }
      this.state.currentLocationId = loc.id;
      this.worldBible.markLocationVisited(this.campaignId, loc.id);
      if (narration.activeNpcs.length > 0) {
        console.log(`[game-loop] Location: "${loc.name}" (${this.locationTurnCount} turns) — NPCs present: ${narration.activeNpcs.join(', ')}`);
      }
      for (const npcName of narration.activeNpcs) {
        this.worldBible.updateEntityLocation(this.campaignId, npcName, loc.id);
        this.worldBible.ensureEntity(this.campaignId, npcName, loc.id);
      }

      generateSceneImage(this.campaignId, narration.currentLocationName, narration.narration)
        .then(result => {
          if (result.imageUrl) {
            this.broadcastFn({ type: 'scene-image', imageUrl: result.imageUrl, locationName: narration.currentLocationName });
          }
        })
        .catch(() => {});
    }

    const roundCount = Math.floor(this.sceneTurnCount / partySize);
    const isFinale = this.state.currentScene >= 5 && (this.state.currentTurn ?? 0) >= 20;
    const baseHardCap = partySize >= 3 ? Math.max(4, 7 - partySize) : partySize === 2 ? 5 : Math.max(4, 8 - partySize);
    const hardCap = isFinale ? Math.min(baseHardCap, 5) : baseHardCap;
    const forceSceneEnd = roundCount >= hardCap;
    if (forceSceneEnd) {
      console.log(`[game-loop] Forcing scene end at round ${roundCount} (${isFinale ? 'finale' : 'hard'} cap)`);
    }

    const minRounds = this.state.currentScene <= 1
      ? (partySize >= 3 ? 3 : partySize === 2 ? 3 : 4)
      : this.state.currentScene >= 5 ? 2
      : (partySize >= 3 ? 2 : partySize === 2 ? 2 : 3);
    const allowSceneEnd = roundCount >= minRounds || forceSceneEnd;
    if ((narration.isSceneEnd && allowSceneEnd) || forceSceneEnd) {
      await this.endScene();
      if (isFinale) {
        console.log(`[game-loop] Finale scene concluded — session complete`);
        await this.generateEpilogue();
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

    const worldSummary = this.worldBible.getSummary(this.campaignId, this.state.currentLocationId ?? undefined);
    const charWorldContext = this.worldBible.getCompactSummary(this.campaignId, this.state.currentLocationId ?? undefined);
    const sceneNarration = this.transcript.filter(m => m.role === 'dm').slice(-3).map(m => m.content).join('\n');

    const recallContext = [sceneNarration, charWorldContext].filter(Boolean).join('\n');
    const memories = this.memoryStore.recall(characterId, 8, recallContext);
    if (memories.length > 0) console.log(`[memory] ${character.definition.name}: recalled ${memories.length} memories for context`);

    const partyMembers = Array.from(this.characters.entries())
      .filter(([id]) => id !== characterId)
      .map(([id, c]) => {
        const lastAction = this.transcript.filter(m => m.role === 'character' && m.characterId === id).slice(-1)[0]?.content;
        return { name: c.definition.name, highConcept: c.definition.highConcept, trouble: c.definition.trouble, stress: c.state.stress, lastAction: lastAction || undefined };
      });

    let proposals;
    try {
      proposals = await this.characterAgent.proposeActions({
        definition: character.definition,
        state: character.state,
        sceneNarration,
        transcript: this.transcript,
        memories,
        worldContext: charWorldContext,
        partyMembers,
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

    this.broadcastFn({ type: 'character-state-update', characterId, state: character.state });
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
        { definition: character.definition, state: character.state, sceneNarration, transcript: this.transcript, memories, worldContext: charWorldContext, partyMembers },
        whisper,
      );
    } catch (e) {
      console.error('[game-loop] action decision failed:', e);
      const fallbackAction = proposals.actions[0]?.description ?? 'Waits and observes';
      decision = {
        chosenAction: fallbackAction,
        innerThought: `I should ${fallbackAction.toLowerCase()} — the situation demands action, even if I'm uncertain.`,
        whisperedInfluence: 'ignored' as const,
        trustDelta: 0,
      };
    }

    if (decision.chosenAction.trim().length < 10) {
      console.log(`[game-loop] Degenerate action detected (${decision.chosenAction.length} chars: "${decision.chosenAction}"), using proposal fallback`);
      decision.chosenAction = proposals.actions[0]?.description ?? 'Surveys the surroundings, weighing the options carefully';
    }

    const genericPatterns = [
      /^something (feels|is|seems|isn't|doesn't feel) (off|wrong|right)/i,
      /^i (need|should|must|have) to be careful/i,
      /^i (should|must|need to) (proceed|be) cautious/i,
      /^i (sense|feel) (something|danger|that something)/i,
      /^(this|something) (doesn't feel|isn't|seems) (right|wrong|off)/i,
      /^i have a bad feeling/i,
      /^i need to act now\.?$/i,
      /^i must tread carefully/i,
      /^(caution|careful|cautious|vigilant|wary)/i,
    ];
    if (genericPatterns.some(p => p.test(decision.innerThought))) {
      const truncAtWord = (s: string, max: number) => {
        if (s.length <= max) return s;
        const cut = s.lastIndexOf(' ', max);
        let result = cut > max * 0.4 ? s.slice(0, cut) : s.slice(0, max);
        result = result.replace(/\s+(a|an|the|and|or|but|in|on|at|to|of|for|with|my|their|its|this|that)\s*$/i, '');
        return result;
      };
      const actionSnippet = truncAtWord(decision.chosenAction
        .replace(/^I\s+/i, '')
        .replace(/^(try|attempt|decide|choose|want|drawing on|invoking|using) (to\s+)?/i, '')
        .split(/[.!]/)[0]?.trim() ?? 'act', 50);
      const rawMemory = memories.length > 0
        ? truncAtWord(memories[0]!.content.split(/[.!]/)[0]?.trim() ?? '', 60) || null
        : null;
      const fixPronouns = (s: string) => s.replace(/\bi\b/g, 'I').replace(/\bi'/g, "I'");
      let memoryPhrase: string | null = null;
      if (rawMemory) {
        const memIdx = Math.floor(character.state.stress + character.state.fatePoints + (this.state.currentTurn ?? 0)) % 4;
        if (/^I\s/i.test(rawMemory)) {
          const verb = fixPronouns(rawMemory.replace(/^I\s+/i, '').toLowerCase());
          const starters = [`The memory of when I ${verb} steadies me`, `I recall ${verb}`, `Having ${verb} before, I know what to do`, `Drawing on when I ${verb}`];
          memoryPhrase = starters[memIdx]!;
        } else {
          const starters = [`I recall ${fixPronouns(rawMemory.toLowerCase())}`, `The thought of ${fixPronouns(rawMemory.toLowerCase())} lingers`, `Remembering ${fixPronouns(rawMemory.toLowerCase())}`, `${fixPronouns(rawMemory)} echoes in my mind`];
          memoryPhrase = starters[memIdx]!;
        }
      }
      const contextDetail = memoryPhrase
        ? `${memoryPhrase} — now I need to ${actionSnippet.toLowerCase()}`
        : `I'm going to ${actionSnippet.toLowerCase()} — ${character.state.stress >= 2 ? 'the pressure is mounting and I cannot afford another mistake' : 'this is my best move given what I know'}`;
      decision.innerThought = `${contextDetail}.`;
    }

    decision.innerThought = decision.innerThought.replace(/\bi\b/g, 'I').replace(/\bi'/g, "I'");

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
      if (decision.whisperedInfluence === 'ignored') {
        effectiveDelta = -0.05;
      } else {
        effectiveDelta = character.state.whisperTrust < 0.50 ? 0.06 : 0.03;
      }
    }
    const currentTrust = character.state.whisperTrust;
    const recoveryCap = currentTrust < 0.50 && effectiveDelta > 0 ? 0.08 : 0.05;
    if (effectiveDelta > recoveryCap) effectiveDelta = recoveryCap;
    character.state.whisperTrust = Math.max(0, Math.min(0.95, currentTrust + effectiveDelta));
    if (recoveryCap === 0.08 && effectiveDelta > 0) {
      console.log(`[game-loop] Low-trust recovery boost: ${character.definition.name} trust ${currentTrust.toFixed(2)} → ${character.state.whisperTrust.toFixed(2)} (+${effectiveDelta.toFixed(2)}, cap raised to 0.08)`);
    }

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
        {
          id: characterId, name: character.definition.name, skills: character.definition.skills,
          stress: character.state.stress, consequences: character.state.consequences, fatePoints: character.state.fatePoints,
          aspects: character.definition.aspects, highConcept: character.definition.highConcept, trouble: character.definition.trouble,
          inventory: character.state.inventory,
          partyMembers: Array.from(this.characters.entries())
            .filter(([id]) => id !== characterId)
            .map(([id, c]) => ({ id, name: c.definition.name })),
        },
      );
    } catch (e) {
      console.error('[game-loop] resolution failed, narrating without mechanics:', e);
      const actionSummary = (decision.chosenAction
        .replace(/^I\s+/i, '')
        .replace(/^(try|attempt|decide|choose|want) to\s+/i, '')
        .split(/[.!]/)[0] ?? '')
        .trim()
        .slice(0, 80);
      resolution = {
        diceExpression: null, difficulty: null, skill: null,
        outcome: 'tie' as const,
        narration: `${getFirstName(character.definition.name)} pushes through, but the cost is felt immediately.`,
        stateChanges: [{ characterId, field: 'stress' as const, action: 'set' as const, value: Math.min(character.state.stress + 1, 3) }],
      };
    }

    if (resolution.narration === '__FALLBACK__') {
      const fallbackAction = (decision.chosenAction
        .replace(/^I\s+/i, '')
        .replace(/^(try|attempt|decide|choose|want|drawing on|invoking|using) (to\s+)?/i, '')
        .replace(/\bmy\b/gi, 'the')
        .replace(/\bmyself\b/gi, getFirstName(character.definition.name).toLowerCase())
        .replace(/\bI('m|'ll|'ve|'d)?\b/g, getFirstName(character.definition.name))
        .split(/[.!]/)[0] ?? '')
        .trim()
        .slice(0, 80);
      const firstName = getFirstName(character.definition.name);
      const outcomeNarration = resolution.outcome === 'failure'
        ? `${firstName}'s effort falls short — the situation worsens despite the attempt.`
        : resolution.outcome === 'tie'
        ? `${firstName} pushes through, but the cost is felt immediately.`
        : resolution.outcome === 'success-with-cost'
        ? `${firstName} succeeds, but not without a price.`
        : `${firstName} acts decisively, and the moment shifts in their favor.`;
      resolution.narration = outcomeNarration;
    }

    if (diceResult && resolution.difficulty != null && resolution.skill && campaign.system_id === 'fate-core') {
      if (resolution.difficulty > 8) {
        console.log(`[game-loop] FATE difficulty capped: DM set ${resolution.difficulty}, max is 8 (Legendary)`);
        resolution.difficulty = 8;
      }
      if (resolution.difficulty < 0) resolution.difficulty = 0;
      const skillKey = Object.keys(character.definition.skills).find(k => k.toLowerCase() === resolution.skill!.toLowerCase());
      const skillRank = skillKey ? (character.definition.skills[skillKey] ?? 0) : 0;
      const effort = diceResult.total + skillRank;
      const shifts = effort - resolution.difficulty;
      const correctOutcome: 'success' | 'failure' | 'tie' | 'success-with-cost' =
        shifts >= 1 ? 'success'
        : shifts === 0 ? 'tie'
        : shifts >= -2 ? 'success-with-cost'
        : 'failure';
      if (resolution.outcome !== correctOutcome) {
        console.log(`[game-loop] FATE outcome corrected: DM said ${resolution.outcome}, math says ${correctOutcome} (effort ${effort} vs diff ${resolution.difficulty}, shifts ${shifts})`);
        resolution.outcome = correctOutcome;
      }

      if (campaign.dm_preset === 'professor') {
        const ladderNames = ['Mediocre', 'Average', 'Fair', 'Good', 'Great', 'Superb', 'Fantastic', 'Epic', 'Legendary'];
        const diffName = ladderNames[resolution.difficulty] ?? `+${resolution.difficulty}`;
        const effortName = ladderNames[Math.max(0, Math.min(effort, 8))] ?? `+${effort}`;
        const dSign = diceResult.total >= 0 ? '+' : '';
        const aside = shifts >= 1
          ? `(${resolution.skill} +${skillRank} with dice ${dSign}${diceResult.total} = ${effortName} (+${effort}) vs ${diffName} (+${resolution.difficulty}) — ${shifts} shift${shifts !== 1 ? 's' : ''} of success!)`
          : shifts === 0
          ? `(${resolution.skill} +${skillRank} ties the ${diffName} (+${resolution.difficulty}) difficulty — a tie means you succeed, but at a minor cost.)`
          : `(${resolution.skill} +${skillRank} with dice ${dSign}${diceResult.total} = +${effort} vs ${diffName} (+${resolution.difficulty}) — ${Math.abs(shifts)} shift${Math.abs(shifts) !== 1 ? 's' : ''} short.${character.state.fatePoints > 0 ? ' An aspect invoke for +2 could have changed this!' : ''})`;
        resolution.narration = resolution.narration.trimEnd().replace(/\.?$/, '. ') + aside;
      }
    }

    const fpSpentByDm = resolution.stateChanges.some(c => c.field === 'fatePoints' && c.action === 'set' && typeof c.value === 'number' && c.value < character.state.fatePoints);
    if (!fpSpentByDm && character.state.fatePoints > 0) {
      const searchText = `${decision.chosenAction} ${decision.innerThought}`.toLowerCase();
      const allAspects = [character.definition.highConcept, ...character.definition.aspects].filter(Boolean);

      const intentPhrases = /\b(drawing on|invoking|calling upon|channeling|relying on|using)\s+(my|the|their)\b/i;
      const hasInvokeIntent = intentPhrases.test(decision.chosenAction) || intentPhrases.test(decision.innerThought);

      const stopWords = new Set(['never', 'that', 'tell', 'have', 'been', 'from', 'with', 'into', 'over', 'even', 'just', 'only', 'also', 'very', 'when', 'then', 'than', 'them', 'they', 'this', 'what', 'will', 'more', 'some', 'know', 'take', 'come', 'make']);
      const invoked = allAspects.some(aspect => {
        const words = aspect.toLowerCase().split(/[\s-]+/).filter(w => w.length > 3 && !stopWords.has(w));
        if (words.length === 0) return false;
        const matches = words.filter(w => searchText.includes(w));
        return matches.length >= 1;
      });
      const peakSkillRank = Math.max(...Object.values(character.definition.skills), 0);
      const usedSkillIsTop = resolution.skill && peakSkillRank >= 3 &&
        Object.entries(character.definition.skills).some(([k, v]) =>
          k.toLowerCase() === resolution.skill!.toLowerCase() && v >= peakSkillRank);
      const skillMasteryInvoke = usedSkillIsTop && (resolution.difficulty ?? 0) >= 3;

      if (invoked || hasInvokeIntent || skillMasteryInvoke) {
        const newFp = character.state.fatePoints - 1;
        resolution.stateChanges.push({ characterId, field: 'fatePoints' as const, action: 'set' as const, value: newFp });
        const reason = invoked ? 'aspect keyword match' : hasInvokeIntent ? 'invoke-intent phrase' : `skill mastery (${resolution.skill} +${peakSkillRank} vs diff ${resolution.difficulty})`;
        console.log(`[game-loop] Aspect invocation (${reason}) in "${decision.chosenAction.slice(0, 60)}" — ${character.definition.name} spends 1 FP (${character.state.fatePoints} → ${newFp})`);
      }
    }

    const fpAlreadySpentThisTurn = resolution.stateChanges.some(c => c.field === 'fatePoints' && c.action === 'set' && typeof c.value === 'number' && c.value < character.state.fatePoints);
    if (campaign.system_id === 'fate-core' && character.state.fatePoints >= 2 && !fpSpentByDm && !fpAlreadySpentThisTurn) {
      if (resolution.outcome === 'tie' || resolution.outcome === 'success-with-cost') {
        const currentFp = character.state.fatePoints;
        const newFp = currentFp - 1;
        resolution.stateChanges.push({ characterId, field: 'fatePoints' as const, action: 'set' as const, value: newFp });
        const upgradedOutcome = resolution.outcome === 'tie' ? 'success' : 'success';
        const bestAspect = character.definition.highConcept;
        console.log(`[game-loop] Auto-invoke: ${character.definition.name} spends 1 FP (${currentFp} → ${newFp}) on "${bestAspect}" — ${resolution.outcome} → ${upgradedOutcome}`);
        resolution.outcome = upgradedOutcome;
        const invokeFirst = getFirstName(character.definition.name);
        const invokeBeats = [
          `${invokeFirst} draws on "${bestAspect}" — and the tide turns.`,
          `Something shifts — "${bestAspect}" — and ${invokeFirst} finds a way through.`,
          `${invokeFirst} channels "${bestAspect}," turning a near-miss into a decisive moment.`,
        ];
        resolution.narration += ' ' + invokeBeats[(this.state.currentTurn ?? 0) % invokeBeats.length];
        this.addTranscript('system', `[${character.definition.name} invokes "${bestAspect}" for +2 — outcome upgraded to ${upgradedOutcome}! (${newFp} FP remaining)]`);
      }
    }

    const affectedCharIds = new Set<string>();
    for (const change of resolution.stateChanges) {
      if (change.characterId && change.field && change.action) {
        this.applyStateChange(change.characterId, change.field, change.action, change.value);
        affectedCharIds.add(change.characterId);
      }
    }

    for (const cid of affectedCharIds) {
      const c = this.characters.get(cid);
      if (c && c.state.stress >= 3 && c.state.consequences.length >= 2) {
        const takenOutMsg = `${c.definition.name} is TAKEN OUT — overwhelmed by stress and injuries, they collapse or are forced to retreat. The opposition decides what happens next.`;
        this.addTranscript('system', takenOutMsg);
        this.broadcastFn({ type: 'narration', text: takenOutMsg, sceneNumber: this.state.currentScene });
        c.state.stress = 1;
        if (!c.state.consequences.includes('Taken Out (recovering)')) {
          c.state.consequences.push('Taken Out (recovering)');
          (c as any)._takenOutScene = this.state.currentScene;
        }
      }
    }

    const lastCompelTurn = (character as any)._lastCompelTurn ?? -Infinity;
    if (this.state.currentTurn - lastCompelTurn >= 3) {
      let shouldCompel = false;
      if (resolution.outcome === 'failure') {
        shouldCompel = true;
      } else if (resolution.outcome === 'success-with-cost') {
        shouldCompel = true;
      } else if (resolution.outcome === 'tie' && character.state.fatePoints <= 1) {
        shouldCompel = true;
      }
      if (shouldCompel) {
        character.state.fatePoints = Math.min(character.state.fatePoints + 1, 5);
        (character as any)._lastCompelTurn = this.state.currentTurn;
        console.log(`[game-loop] Compel triggered: "${character.definition.trouble}" on ${resolution.outcome} — ${character.definition.name} now at ${character.state.fatePoints} FP`);
        this.addTranscript('system', `[Compel: "${character.definition.trouble}" — ${character.definition.name} earns a fate point (${character.state.fatePoints} FP)]`);
        const compelFirst = getFirstName(character.definition.name);
        const compelTrouble = character.definition.trouble;
        const compelVariants = [
          `${compelFirst} feels the pull of old habits — "${compelTrouble}" — and the universe grants a small mercy in return.`,
          `But "${compelTrouble}" rears its head, complicating everything — though fate offers ${compelFirst} a consolation.`,
          `"${compelTrouble}" — the words could be ${compelFirst}'s epitaph. But fate is generous to those it torments.`,
          `The shadow of "${compelTrouble}" falls across ${compelFirst}'s path once more, and with it comes a glimmer of fate's favor.`,
          `${compelFirst}'s "${compelTrouble}" makes itself known at precisely the wrong moment — as it always does.`,
        ];
        resolution.narration += `\n\n${compelVariants[(this.state.currentTurn ?? 0) % compelVariants.length]}`;
        affectedCharIds.add(characterId);
      }
    }

    const actionWords = new Set(decision.chosenAction.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 3));
    if (actionWords.size > 0) {
      const sentences = resolution.narration.split(/(?<=[.!?])\s+/);
      if (sentences.length > 1) {
        const firstWords = sentences[0]!.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 3);
        const overlap = firstWords.filter(w => actionWords.has(w)).length;
        if (overlap >= Math.min(4, actionWords.size * 0.6)) {
          resolution.narration = sentences.slice(1).join(' ');
          console.log(`[game-loop] Stripped echo sentence (${overlap} overlapping words)`);
        }
      }
    }

    this.addTranscript('dm', resolution.narration);
    this.broadcastFn({ type: 'resolution', text: resolution.narration });

    affectedCharIds.add(characterId);
    for (const cid of affectedCharIds) {
      const c = this.characters.get(cid);
      if (c) {
        this.broadcastFn({ type: 'character-state-update', characterId: cid, state: c.state });
        this.db.prepare("UPDATE characters SET state = ?, updated_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(c.state), cid);
      }
    }

    this.memoryStore.extractAndStore(
      characterId, this.campaignId, character.definition.name,
      decision.chosenAction, resolution.narration, whisper,
      this.state.currentScene, this.state.currentTurn,
    ).then(stored => {
      if (stored.length > 0) console.log(`[memory] ${character.definition.name}: stored ${stored.length} memories (${stored.map(m => m.type).join(', ')})`);
    }).catch(e => console.error('[memory] extraction failed:', e));

    for (const [observerId, observer] of this.characters) {
      if (observerId === characterId) continue;
      this.memoryStore.storeObservation(
        observerId, this.campaignId, observer.definition.name,
        character.definition.name, decision.chosenAction, resolution.narration,
        this.state.currentScene, this.state.currentTurn,
      ).catch(e => console.error(`[memory] observer extraction failed for ${observer.definition.name}:`, e));
    }

    this.state.sceneTurnCount = this.sceneTurnCount;
    saveCheckpoint(this.db, this.campaignId, this.state.currentScene, this.state.currentTurn, this.state);

    await this.maybeCompactTranscript();
  }

  private async maybeCompactTranscript(): Promise<void> {
    const partySize = this.characters.size || 1;
    const compactionThreshold = BASE_COMPACTION_THRESHOLD + (partySize - 1) * 12;
    const compactionKeepRecent = BASE_COMPACTION_KEEP_RECENT + (partySize - 1) * 4;
    if (this.transcript.length < compactionThreshold) return;

    console.log(`[game-loop] Transcript compaction triggered at ${this.transcript.length} messages (threshold: ${compactionThreshold}, party: ${partySize})`);
    const extractCount = this.transcript.length - compactionKeepRecent;
    const toExtract = this.transcript.slice(0, extractCount);
    const toKeep = this.transcript.slice(extractCount);

    try {
      const facts = await this.extractor.extractFacts(toExtract, this.state.currentScene);
      this.worldBible.applyDiff(this.campaignId, facts);
    } catch (e) {
      console.error('Mid-scene fact extraction failed:', e);
    }

    const charNames = Array.from(this.characters.values()).map(c => c.definition.name);
    const worldState = this.worldBible.getCompactSummary(this.campaignId, this.state.currentLocationId ?? undefined);
    let summary: string;
    try {
      summary = await this.dm.summarizeScene(toExtract, charNames, worldState);
    } catch (e) {
      console.error('[game-loop] Compaction summary failed, using last DM narration as recap:', e);
      const lastDm = toExtract.filter(m => m.role === 'dm').slice(-1)[0]?.content;
      summary = lastDm ?? 'The adventure continues...';
    }

    this.transcript = [
      { role: 'system' as const, content: `[Session recap] ${summary}`, timestamp: new Date().toISOString() },
      ...toKeep,
    ];
    console.log(`[game-loop] Compaction complete: ${extractCount} messages → 1 summary + ${toKeep.length} kept = ${this.transcript.length} total`);
  }

  private async endScene(): Promise<void> {
    let summary: string;
    const charNames = Array.from(this.characters.values()).map(c => c.definition.name);
    const worldState = this.worldBible.getCompactSummary(this.campaignId, this.state.currentLocationId ?? undefined);
    try {
      summary = await this.dm.summarizeScene(this.transcript, charNames, worldState);
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

    for (const [charId, char] of this.characters) {
      const oldStress = char.state.stress;
      char.state.stress = 0;

      const recoverable: string[] = [];
      const kept: string[] = [];
      for (const c of char.state.consequences) {
        if (c === 'Taken Out (recovering)') {
          const scenesOut = (char as any)._takenOutScene ?? 0;
          if (this.state.currentScene - scenesOut >= 1) {
            recoverable.push(c);
          } else {
            kept.push(c);
          }
        } else if (char.state.consequences.length > 1) {
          kept.push(c);
        } else {
          recoverable.push(c);
        }
      }
      char.state.consequences = kept;

      if (oldStress > 0 || recoverable.length > 0) {
        const parts: string[] = [];
        if (oldStress > 0) parts.push('stress clears');
        if (recoverable.length > 0) parts.push(`recovers from: ${recoverable.join(', ')}`);
        console.log(`[game-loop] Scene recovery: ${char.definition.name} — ${parts.join(', ')}`);
        this.broadcastFn({ type: 'narration', text: `[${char.definition.name} takes a moment to recover — ${parts.join(', ')}]`, sceneNumber: this.state.currentScene });
        this.broadcastFn({ type: 'character-state-update', characterId: charId, state: char.state });
        this.db.prepare("UPDATE characters SET state = ?, updated_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(char.state), charId);
      }
    }

    this.transcript = [
      { role: 'system' as const, content: `[Previous scene] ${summary}`, timestamp: new Date().toISOString() },
    ];
    this.sceneTurnCount = 0;
    this.locationTurnCount = 0;
    this.lastLocationName = '';
    this.state.currentScene++;
    clearCampaignImageCache(this.campaignId);
  }

  private async generateEpilogue(): Promise<void> {
    const scenes = this.db.prepare(
      'SELECT scene_number, summary FROM scenes WHERE campaign_id = ? ORDER BY scene_number ASC'
    ).all(this.campaignId) as Array<{ scene_number: number; summary: string }>;

    const charLines = Array.from(this.characters.values()).map(c => {
      const memories = this.memoryStore.recall(c.id, 3);
      const memText = memories.map(m => m.content).join('. ');
      return `${c.definition.name} (${c.definition.highConcept}): stress ${c.state.stress}/3, ${c.state.fatePoints} FP, trust ${c.state.whisperTrust.toFixed(2)}. Key memories: ${memText || 'none'}`;
    }).join('\n');

    const sceneSummaries = scenes.map(s => `Scene ${s.scene_number}: ${s.summary}`).join('\n\n');
    const worldState = this.worldBible.getCompactSummary(this.campaignId);

    try {
      const epilogue = await callLlm({
        messages: [
          { role: 'system', content: 'You write brief TTRPG session epilogues. Plain text only, no JSON, no asterisks. Write in the DM\'s voice — warm, reflective, slightly bittersweet. 3-5 sentences.' },
          { role: 'user', content: `Session complete: ${this.state.currentScene} scenes, ${this.state.currentTurn} turns.\n\nScenes:\n${sceneSummaries}\n\nCharacters:\n${charLines}\n\nWorld:\n${worldState}\n\nWrite a brief closing narration. What did the characters accomplish? What was lost along the way? What questions linger? End with one evocative image — the kind players remember.` },
        ],
        maxTokens: 512,
      });
      const text = epilogue.trim();
      if (text && text.length > 20) {
        this.broadcastFn({ type: 'narration', text, sceneNumber: this.state.currentScene });
        console.log(`[game-loop] Epilogue generated (${text.length} chars)`);
      }
    } catch (e) {
      console.error('[game-loop] Epilogue generation failed:', e);
    }
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
        newEntities: (scenario.npcs ?? []).map((n: any) => ({
          name: n.name,
          type: 'npc',
          description: n.motivation ? `${n.description} [Motivation: ${n.motivation}]` : n.description,
          disposition: n.disposition ?? null,
        })),
        newItems: (scenario.items ?? []).map((item: any) => ({ name: item.name, description: item.description, properties: item.properties ?? {} })),
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
      if (Array.isArray(state[field]) && !Array.isArray(value)) {
        (state[field] as unknown[]).push(value);
      } else {
        state[field] = value;
      }
      if (field === 'stress' && typeof value === 'number') {
        state.stress = Math.max(0, Math.min(value, 3));
      }
      if (field === 'fatePoints' && typeof value === 'number') {
        state.fatePoints = Math.max(0, Math.min(value, 5));
      }
    } else if (action === 'add' && Array.isArray(state[field])) {
      (state[field] as unknown[]).push(value);
    } else if (action === 'remove' && Array.isArray(state[field])) {
      const arr = state[field] as unknown[];
      const idx = arr.indexOf(value);
      if (idx >= 0) arr.splice(idx, 1);
    }
    if (field === 'inventory' && typeof value === 'string') {
      if (action === 'remove') {
        this.worldBible.updateItemHolder(this.campaignId, value, null);
      } else {
        this.worldBible.updateItemHolder(this.campaignId, value, characterId);
      }
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
    const charIds = Array.from(this.characters.keys());
    return Array.from(this.characters.values())
      .map(c => {
        const d = c.definition;
        const s = c.state;
        const namePrefix = `${d.name}: `;
        const recentActions = this.transcript
          .filter(m => m.role === 'character' && m.characterId === c.id)
          .slice(-5)
          .map(m => m.content.replace(namePrefix, ''));
        const lastAction = recentActions.slice(-1)[0] ?? '';
        const recentMemories = this.memoryStore.recall(c.id, 2);
        const mood = recentMemories.length > 0
          ? recentMemories.map(m => m.content).join('; ')
          : '';
        const whisperAttitude = s.whisperTrust > 0.7
          ? 'trusts the voice'
          : s.whisperTrust > 0.4
          ? 'uncertain about the voice'
          : 'deeply distrusts the voice — create situations where GOOD advice would help them, forcing the player to earn back trust';

        const behaviorHints: string[] = [];
        if (recentActions.length >= 3) {
          const cautious = /\b(look|observe|wait|cautious|careful|hide|watch|listen|stay)\b/i;
          const social = /\b(talk|speak|ask|persuade|convince|argue|negotiate|confront|shout)\b/i;
          const otherNames = charIds.filter(id => id !== c.id).map(id => this.characters.get(id)!.definition.name.split(' ')[0]!.toLowerCase());
          const cautiousCount = recentActions.filter(a => cautious.test(a)).length;
          const socialCount = recentActions.filter(a => social.test(a)).length;
          const companionMentions = otherNames.length > 0 ? recentActions.filter(a => otherNames.some(n => a.toLowerCase().includes(n))).length : 0;
          if (cautiousCount >= 3) behaviorHints.push('PLAYING TOO SAFE — force a confrontation they cannot avoid');
          if (socialCount === 0 && recentActions.length >= 4) behaviorHints.push('NEVER TALKS TO ANYONE — introduce an NPC who blocks their path and demands conversation');
          if (otherNames.length > 0 && companionMentions === 0 && recentActions.length >= 3) behaviorHints.push('IGNORING COMPANIONS — create a crisis that requires teamwork');
        }

        let line = `${d.name}: ${d.highConcept} (trouble: "${d.trouble}") | Stress: ${s.stress}/3 | Consequences: ${s.consequences.join(', ') || 'none'} | FP: ${s.fatePoints} | Trust: ${s.whisperTrust.toFixed(2)} (${whisperAttitude})`;
        if (lastAction) line += ` | Last: ${lastAction.slice(0, 60)}`;
        if (mood) line += ` | Mindset: ${mood.slice(0, 80)}`;
        if (s.inventory && s.inventory.length > 0) line += ` | Carrying: ${s.inventory.join(', ')}`;
        if (behaviorHints.length > 0) line += ` | DM NOTE: ${behaviorHints.join('; ')}`;
        return line;
      })
      .join('\n');
  }

  private addTranscript(role: TranscriptMessage['role'], content: string, characterId?: string): void {
    this.transcript.push({ role, content, characterId, timestamp: new Date().toISOString() });
  }
}
