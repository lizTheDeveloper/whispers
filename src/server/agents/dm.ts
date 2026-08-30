import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLlm } from './llm-client.js';
import { DmNarrationSchema, DmResolutionSchema, CharacterValidationSchema, SceneSummarySchema, DmSetupReplySchema, CharInterviewReplySchema } from './schemas.js';
import type { DmNarration, DmResolution, CharacterValidation, DmSetupReply, CharInterviewReply } from './schemas.js';
import { searchRules, type RuleChunk } from '../rag/search.js';
import type Database from 'better-sqlite3';
import type { CharacterDefinition, TranscriptMessage, DiceResult } from '../../shared/types.js';

const presetCache = new Map<string, string>();
function loadPresetText(presetName: string): string | null {
  if (!/^[a-z0-9-]{1,64}$/.test(presetName)) return null;
  if (presetCache.has(presetName)) return presetCache.get(presetName)!;
  const base = dirname(fileURLToPath(import.meta.url));
  const presetsDir = resolve(base, '../../data/dm-presets');
  const p = resolve(presetsDir, `${presetName}.txt`);
  if (!p.startsWith(presetsDir + '/')) return null;
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf-8').trim();
  presetCache.set(presetName, text);
  return text;
}

export interface ScenePacing {
  sceneNumber: number;
  sceneTurnCount: number;
  characterSummaries: string;
  partySize: number;
  sessionTurnCount?: number;
}

interface DmContext {
  preset: string;
  houseRules: string | null;
  dmInstructions: string | null;
  dmCustomPrompt: string | null;
  campaignId: string;
  worldSummary: string;
  transcript: TranscriptMessage[];
  systemId: string;
}

export class DmAgent {
  constructor(private db: Database.Database) {}

  async narrate(ctx: DmContext, pacing?: ScenePacing): Promise<DmNarration> {
    const recentTranscript = ctx.transcript.slice(-20).map(m => `[${m.role}${m.characterId ? ':' + m.characterId : ''}] ${m.content}`).join('\n');

    const turnCount = pacing?.sceneTurnCount ?? 0;
    const partySize = pacing?.partySize ?? 1;
    const roundCount = Math.floor(turnCount / partySize);
    const sceneNum = pacing?.sceneNumber ?? 1;

    const sessionTurn = pacing?.sessionTurnCount ?? 0;

    // Session-level three-act structure (Act III at scene 4+ so a ~25-turn session reaches resolution)
    let sessionArc: string;
    if (sceneNum <= 1) {
      sessionArc = 'ACT I (Setup): Establish the world, introduce the central mystery or threat. Plant clues and introduce key NPCs. The dramatic question should be clear by scene end.';
    } else if (sceneNum <= 3) {
      sessionArc = 'ACT II (Confrontation): Escalate complications. Alliances are tested, secrets are revealed, the threat becomes personal. Make the characters pay a cost for progress.';
    } else if (sceneNum <= 4) {
      sessionArc = 'ACT III (Resolution): Drive toward the climax. The dramatic question MUST be answered this act. Converge all threads toward a final confrontation or revelation. Stop introducing new complications — use what exists.';
    } else {
      sessionArc = `SESSION FINALE (scene ${sceneNum}): This is the LAST scene. Let it play out over multiple turns — do NOT try to narrate several rounds in one response. Each narration is ONE moment: describe what happens, let the character act, then you narrate again. No new locations or mysteries. Use established NPCs, items, and threads. Build toward a decisive confrontation, then end with a denouement. Do NOT set isSceneEnd on the opening narration.`;
    }

    if (sessionTurn >= 20 && sceneNum >= 4) {
      if (sceneNum >= 5 && roundCount >= 5) {
        sessionArc += ` WRAP UP NOW (turn ${sessionTurn}, round ${roundCount}): narrate the final outcome — victory, defeat, or bittersweet resolution — and set isSceneEnd to true. The story must end.`;
      } else if (sceneNum >= 5 && roundCount >= 3) {
        sessionArc += ` (Turn ${sessionTurn}, round ${roundCount} — the climax should land THIS round. After one more decisive action, narrate the resolution and end the scene.)`;
      } else {
        sessionArc += ` (Turn ${sessionTurn} of session — converge toward resolution, but give the ending room to breathe.)`;
      }
    }

    // Scale pacing thresholds: larger parties generate more content per round
    const developThreshold = partySize <= 1 ? 2 : 2;
    const escalateThreshold = partySize <= 1 ? 5 : Math.max(3, 5 - partySize);

    const pacingHint = roundCount === 0
      ? 'This is the opening of a new scene. Set the stage vividly — describe the location, atmosphere, and any sensory details. Hint at trouble or opportunity.'
      : roundCount < developThreshold
      ? 'The scene is developing. Introduce complications, NPCs with agendas, or environmental obstacles. Not everything should go smoothly.'
      : roundCount < escalateThreshold
      ? 'The scene is in full swing. Escalate stakes — consequences from earlier actions catch up, allies may be threatened, hard choices emerge. Move toward a dramatic turning point.'
      : roundCount < escalateThreshold + 3
      ? `The scene has run for ${roundCount} rounds. Actively look for a climactic moment to end the scene. If a dramatic beat just landed, tension peaked, the party reached a new location, combat concluded, or a key revelation dropped — set isSceneEnd to true. Transition to keep the narrative moving.`
      : `SCENE OVERRUN: ${roundCount} rounds. You MUST end this scene NOW. Narrate a dramatic climax or cliffhanger and set isSceneEnd to true. Do not continue — the story needs to move forward.`;

    const charBlock = pacing?.characterSummaries ? `\n\nParty status:\n${pacing.characterSummaries}` : '';
    const sceneLabel = pacing ? `Scene ${pacing.sceneNumber}, round ${roundCount + 1} (turn ${turnCount + 1})` : 'Scene';

    return callLlm({
      messages: [
        { role: 'system', content: this.buildSystemPrompt(ctx) },
        { role: 'user', content: `${sceneLabel}${charBlock}\n\nWorld state:\n${ctx.worldSummary}\n\nRecent transcript:\n${recentTranscript}\n\nSession arc: ${sessionArc}\n\nPacing: ${pacingHint}\n\nNarrate what happens next in 2-4 vivid sentences. Describe ONE moment, not multiple rounds.\n\nRespond as JSON: { "narration": "...", "currentLocationName": "...", "activeNpcs": ["name1", ...], "isSceneEnd": true|false }` },
      ],
      schema: DmNarrationSchema,
      maxTokens: 2048,
    });
  }

  async resolve(ctx: DmContext, action: string, diceResult: DiceResult | null, sceneNumber?: number, characterInfo?: { id: string; name: string; skills: Record<string, number>; stress: number; consequences: string[]; fatePoints: number }): Promise<DmResolution> {
    const ruleContext = this.lookupRules(ctx.systemId, action);

    const diceBlock = diceResult
      ? `\nDice result: ${diceResult.description} (total: ${diceResult.total}). Use this roll to determine the outcome — do not invent your own. In FATE, add the relevant skill rank to the total and compare against the difficulty you set. Failures and success-with-cost make better stories than constant success.`
      : '';

    const consequenceGuide = (sceneNumber ?? 1) >= 4
      ? ' In Act III, failures should feel final and successes should resolve plot threads decisively.'
      : '';

    const charBlock = characterInfo
      ? `\nCharacter: ${characterInfo.name} (id: ${characterInfo.id})\nSkills: ${Object.entries(characterInfo.skills).map(([k, v]) => `${k}:+${v}`).join(', ')}\nStress: ${characterInfo.stress}/3 | Consequences: ${characterInfo.consequences.join(', ') || 'none'} | Fate Points: ${characterInfo.fatePoints}\n`
      : '';

    return callLlm({
      messages: [
        { role: 'system', content: this.buildSystemPrompt(ctx) },
        { role: 'user', content: `${charBlock}Action: "${action}"${diceBlock}\n\nRelevant rules:\n${ruleContext}\n\nResolve this action. Determine the appropriate skill, set a fair difficulty (0=Mediocre, 2=Fair, 4=Great), and narrate the outcome based on the dice. A wounded character (high stress, existing consequences) should struggle more. Apply meaningful consequences for failures — stress, complications, or narrative setbacks.${consequenceGuide}\n\nRespond as JSON: { "diceExpression": "${diceResult?.expression ?? 'null'}", "difficulty": <number>, "skill": "<skill>", "outcome": "success|failure|tie|success-with-cost", "narration": "2-3 sentences describing what happens", "stateChanges": [{"characterId": "${characterInfo?.id ?? '<id>'}", "field": "stress|consequences|fatePoints|inventory", "action": "set|add|remove", "value": <value>}] }\nstateChanges must be objects, not strings. Use [] if no mechanical changes apply.` },
      ],
      schema: DmResolutionSchema,
      maxTokens: 1024,
    });
  }

  async setupChat(presetName: string, history: Array<{ role: string; content: string }>): Promise<DmSetupReply> {
    const systemPrompt = `You are a TTRPG Dungeon Master helping set up a new game. Your base personality is "${presetName}".

Have a natural conversation with the game host to figure out:
1. What TTRPG system to use (suggest free ones: FATE Core, Dungeon World, Cairn, MORK BORG, Knave, Basic Fantasy RPG — or they can upload their own rulebook)
2. What kind of adventure/setting/tone they want
3. Any house rules or special requests
4. How many players to expect

Be conversational and enthusiastic. Ask one or two questions at a time, not a checklist.
If they upload materials, acknowledge them.
When you have enough info, set "done": true and fill in dmInstructions (summary of their preferences) and dmCustomPrompt (your tailored system prompt for running this game).
Until you have enough info, set "done": false and dmInstructions/dmCustomPrompt to null.

Respond as JSON: { "reply": "your message", "done": false, "dmInstructions": null, "dmCustomPrompt": null }`;

    return callLlm({
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
      ],
      schema: DmSetupReplySchema,
    });
  }

  async interviewForCharacter(systemId: string, history: Array<{ role: string; content: string }>): Promise<CharInterviewReply> {
    const ruleContext = this.lookupRules(systemId, 'character creation aspects skills stunts');

    const systemPrompt = `You are a character creation API for a TTRPG game. You help players build characters through conversation.

Rules reference:
${ruleContext}

Ask about their concept, backstory, skills. Be encouraging. Help if they're stuck.

CRITICAL: You MUST respond with ONLY a JSON object. No asterisks, no roleplay actions, no narration outside the JSON. Every response must be valid JSON.

When you don't have enough info yet: {"reply": "your question here", "definition": null}
When you have enough info: {"reply": "summary", "definition": {"name": "...", "highConcept": "...", "trouble": "...", "aspects": ["..."], "personality": "...", "backstory": "...", "skills": {"Skill": 3}, "stunts": ["..."]}}`;

    const lastMsg = history[history.length - 1];
    const augmentedHistory = lastMsg?.role === 'user'
      ? [...history.slice(0, -1), { role: 'user', content: `${lastMsg.content}\n\n(Remember: respond with ONLY a JSON object, no other text)` }]
      : history;

    return callLlm({
      messages: [
        { role: 'system', content: systemPrompt },
        ...augmentedHistory,
      ],
      schema: CharInterviewReplySchema,
      temperature: 0.5,
    });
  }

  async validateCharacter(definition: CharacterDefinition, systemId: string): Promise<CharacterValidation> {
    const ruleContext = this.lookupRules(systemId, 'character creation skills aspects');

    return callLlm({
      messages: [
        { role: 'system', content: `You are a character sheet validation API. You output ONLY JSON. No roleplay, no asterisks, no prose.\n\nRules reference:\n${ruleContext}\n\nApproval criteria — approve if ALL are present:\n- name (non-empty string)\n- highConcept (non-empty string)\n- trouble (non-empty string)\n- aspects (array with at least 2 entries)\n- skills (object with at least 1 entry)\n- stunts (array with at least 1 entry)\n\nIf all criteria are met, set approved=true. Only reject if required fields are missing or empty.` },
        { role: 'user', content: `Validate:\n${JSON.stringify(definition, null, 2)}\n\nReturn ONLY: {"approved": true, "feedback": "one sentence", "modifications": null}` },
      ],
      schema: CharacterValidationSchema,
      temperature: 0.2,
    });
  }

  async summarizeScene(transcript: TranscriptMessage[]): Promise<string> {
    const text = transcript.map(m => `[${m.role}] ${m.content}`).join('\n');
    const result = await callLlm({
      messages: [
        { role: 'system', content: 'You are a JSON API. Summarize TTRPG scenes. Output ONLY a JSON object.' },
        { role: 'user', content: `${text}\n\nSummarize in 2-3 sentences. Focus on what happened, who was involved, and what changed.\n\nRespond as JSON: {"summary": "your summary here"}` },
      ],
      schema: SceneSummarySchema,
    });
    return result.summary;
  }

  private buildSystemPrompt(ctx: DmContext): string {
    let prompt: string;
    if (ctx.dmCustomPrompt) {
      prompt = ctx.dmCustomPrompt + '\n';
    } else {
      const presetText = loadPresetText(ctx.preset);
      prompt = presetText ? presetText + '\n' : `You are a TTRPG Dungeon Master with the "${ctx.preset}" personality.\n`;
    }

    prompt += `
Storytelling principles:
- Actions have real consequences. Not every plan works. Failure creates drama.
- NPCs have their own goals and react to the party's actions, even between scenes.
- The world moves forward whether characters act or not — time pressure matters.
- Introduce complications that force hard choices, not just combat encounters.
- Use the environment as an active element — weather, terrain, crowds, lighting.
- When characters succeed, success should change the situation, not just confirm it.
- WEAVE BACK earlier threads: if the world state lists UNRESOLVED THREADS, advance at least one per narration. Reintroduce NPCs, revisit locations, or reveal consequences of past actions.
- VARY your imagery: do not repeat the same visual motifs (e.g. "skeletal hands," "black water") more than twice in a scene. Introduce new sensory details — sounds, smells, temperature, texture — to keep the world alive.
- Build toward a dramatic question — each scene should move the story closer to answering: will the party succeed, and at what cost?
- WHISPER AWARENESS: Characters hear a mysterious voice (the player's whispers). When the transcript shows a character heeded or resisted a whisper, weave that into the narrative. A character following dangerous whispers might attract dark attention; one resisting wise counsel might face harder consequences. The whisper influence is the game's central tension — make it matter in the story.
`;

    if (ctx.houseRules) prompt += `\nHouse rules: ${ctx.houseRules}\n`;
    if (ctx.dmInstructions) prompt += `\nDM direction: ${ctx.dmInstructions}\n`;

    const campaignMaterials = this.lookupRules(`campaign:${ctx.campaignId}`, ctx.transcript.slice(-5).map(m => m.content).join(' '));
    if (campaignMaterials !== '(No rules found for this query)') {
      prompt += `\nCampaign reference materials:\n${campaignMaterials}\n`;
    }

    prompt += `\nAlways respond with valid JSON matching the requested format. Never fabricate dice rolls — use only rolls provided to you.`;
    return prompt;
  }

  private lookupRules(systemId: string, query: string): string {
    const chunks = searchRules(this.db, systemId, query, 3);
    if (chunks.length === 0) return '(No rules found for this query)';
    return chunks.map((c: RuleChunk) => `[${c.section}] ${c.content}`).join('\n\n');
  }
}
