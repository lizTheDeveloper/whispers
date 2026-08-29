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
        { role: 'system', content: `You are a character sheet validation API. You receive TTRPG character data and return a JSON validation result. You do not roleplay, narrate, or produce any text other than the JSON response object.\n\nRules reference:\n${ruleContext}\n\nYou MUST respond with ONLY a JSON object. No prose, no asterisks, no narration, no markdown.` },
        { role: 'user', content: `Validate this character sheet against the rules:\n${JSON.stringify(definition, null, 2)}\n\nReturn ONLY this JSON (no other output):\n{"approved": true, "feedback": "one sentence summary", "modifications": null}` },
      ],
      schema: CharacterValidationSchema,
      temperature: 0.3,
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
