import { callLlm } from './llm-client.js';
import { DmNarrationSchema, DmResolutionSchema, CharacterValidationSchema, SceneSummarySchema, DmSetupReplySchema, CharInterviewReplySchema } from './schemas.js';
import type { DmNarration, DmResolution, CharacterValidation, DmSetupReply, CharInterviewReply } from './schemas.js';
import { searchRules, type RuleChunk } from '../rag/search.js';
import type Database from 'better-sqlite3';
import type { CharacterDefinition, TranscriptMessage, DiceResult } from '../../shared/types.js';

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

  async narrate(ctx: DmContext): Promise<DmNarration> {
    const recentTranscript = ctx.transcript.slice(-20).map(m => `[${m.role}${m.characterId ? ':' + m.characterId : ''}] ${m.content}`).join('\n');

    return callLlm({
      messages: [
        { role: 'system', content: this.buildSystemPrompt(ctx) },
        { role: 'user', content: `World state:\n${ctx.worldSummary}\n\nRecent transcript:\n${recentTranscript}\n\nNarrate what happens next. Respond as JSON: { "narration": "...", "currentLocationName": "...", "activeNpcs": [...], "isSceneEnd": false }` },
      ],
      schema: DmNarrationSchema,
    });
  }

  async resolve(ctx: DmContext, action: string, _diceResult: DiceResult | null): Promise<DmResolution> {
    const ruleContext = this.lookupRules(ctx.systemId, action);

    return callLlm({
      messages: [
        { role: 'system', content: this.buildSystemPrompt(ctx) },
        { role: 'user', content: `Action: "${action}"\n\nRelevant rules:\n${ruleContext}\n\nResolve this action. Respond as JSON: { "diceExpression": null, "difficulty": null, "skill": null, "outcome": "success|failure|tie|success-with-cost", "narration": "...", "stateChanges": [] }` },
      ],
      schema: DmResolutionSchema,
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

    const systemPrompt = `You are a friendly TTRPG character creation assistant. Help the player build their character through conversation.

Rules reference:
${ruleContext}

Ask about their character concept, backstory, personality, skills, and abilities. Be encouraging and creative. Help them if they're stuck — suggest ideas that fit their concept.

When you have enough info to build a complete character sheet, include the full "definition" object. Until then, set "definition" to null.

Respond as JSON: { "reply": "your message", "definition": null }
When ready: { "reply": "Here's your character! ...", "definition": { "name": "...", "highConcept": "...", "trouble": "...", "aspects": [...], "personality": "...", "backstory": "...", "skills": {"Skill": 3, ...}, "stunts": [...] } }`;

    return callLlm({
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
      ],
      schema: CharInterviewReplySchema,
    });
  }

  async validateCharacter(definition: CharacterDefinition, systemId: string): Promise<CharacterValidation> {
    const ruleContext = this.lookupRules(systemId, 'character creation skills aspects');

    return callLlm({
      messages: [
        { role: 'system', content: `You are a TTRPG Game Master validating a character sheet. Be fair but enforce the rules.\n\nRules reference:\n${ruleContext}` },
        { role: 'user', content: `Validate this character sheet:\n${JSON.stringify(definition, null, 2)}\n\nIf the sheet needs small fixes to match the rules (skill values, missing required fields, balance issues), approve it and include the fixes in "modifications" as a partial object with only the changed fields. If the concept itself is problematic, reject it.\n\nRespond as JSON: { "approved": true/false, "feedback": "...", "modifications": null or { "skills": {...}, ... } }` },
      ],
      schema: CharacterValidationSchema,
    });
  }

  async summarizeScene(transcript: TranscriptMessage[]): Promise<string> {
    const text = transcript.map(m => `[${m.role}] ${m.content}`).join('\n');
    const result = await callLlm({
      messages: [
        { role: 'system', content: 'Summarize this TTRPG scene in 2-3 sentences. Focus on what happened, who was involved, and what changed.' },
        { role: 'user', content: text },
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
      prompt = `You are a TTRPG Dungeon Master with the "${ctx.preset}" personality. Run the game faithfully.\n`;
    }
    if (ctx.houseRules) prompt += `\nHouse rules: ${ctx.houseRules}\n`;
    if (ctx.dmInstructions) prompt += `\nDM direction: ${ctx.dmInstructions}\n`;

    const campaignMaterials = this.lookupRules(`campaign:${ctx.campaignId}`, ctx.transcript.slice(-5).map(m => m.content).join(' '));
    if (campaignMaterials !== '(No rules found for this query)') {
      prompt += `\nCampaign reference materials:\n${campaignMaterials}\n`;
    }

    prompt += `\nAlways respond with valid JSON matching the requested format. Never fabricate dice rolls.`;
    return prompt;
  }

  private lookupRules(systemId: string, query: string): string {
    const chunks = searchRules(this.db, systemId, query, 3);
    if (chunks.length === 0) return '(No rules found for this query)';
    return chunks.map((c: RuleChunk) => `[${c.section}] ${c.content}`).join('\n\n');
  }
}
