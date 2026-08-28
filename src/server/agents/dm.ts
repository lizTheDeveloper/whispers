import { callLlm } from './llm-client.js';
import { DmNarrationSchema, DmResolutionSchema, CharacterValidationSchema, SceneSummarySchema } from './schemas.js';
import type { DmNarration, DmResolution, CharacterValidation } from './schemas.js';
import { searchRules, type RuleChunk } from '../rag/search.js';
import type Database from 'better-sqlite3';
import type { CharacterDefinition, TranscriptMessage, DiceResult } from '../../shared/types.js';

interface DmContext {
  preset: string;
  houseRules: string | null;
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

  async validateCharacter(definition: CharacterDefinition, systemId: string): Promise<CharacterValidation> {
    const ruleContext = this.lookupRules(systemId, 'character creation skills aspects');

    return callLlm({
      messages: [
        { role: 'system', content: `You are a TTRPG Game Master validating a character sheet. Be fair but enforce the rules.\n\nRules reference:\n${ruleContext}` },
        { role: 'user', content: `Validate this character sheet:\n${JSON.stringify(definition, null, 2)}\n\nRespond as JSON: { "approved": true/false, "feedback": "..." }` },
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
    let prompt = `You are a TTRPG Dungeon Master with the "${ctx.preset}" personality. Run the game faithfully.\n`;
    if (ctx.houseRules) prompt += `\nHouse rules: ${ctx.houseRules}\n`;
    prompt += `\nAlways respond with valid JSON matching the requested format. Never fabricate dice rolls.`;
    return prompt;
  }

  private lookupRules(systemId: string, query: string): string {
    const chunks = searchRules(this.db, systemId, query, 3);
    if (chunks.length === 0) return '(No rules found for this query)';
    return chunks.map((c: RuleChunk) => `[${c.section}] ${c.content}`).join('\n\n');
  }
}
