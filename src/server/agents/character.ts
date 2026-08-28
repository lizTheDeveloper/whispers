import { callLlm } from './llm-client.js';
import { ActionProposalSchema, ActionDecisionSchema } from './schemas.js';
import type { ActionProposal, ActionDecision } from './schemas.js';
import type { CharacterDefinition, CharacterState, TranscriptMessage } from '../../shared/types.js';

interface CharacterContext {
  definition: CharacterDefinition;
  state: CharacterState;
  sceneNarration: string;
  transcript: TranscriptMessage[];
}

export class CharacterAgent {
  async proposeActions(ctx: CharacterContext): Promise<ActionProposal> {
    const charPrompt = this.buildCharacterPrompt(ctx);
    const recentTranscript = ctx.transcript.slice(-10).map(m => `[${m.role}] ${m.content}`).join('\n');

    return callLlm({
      messages: [
        { role: 'system', content: charPrompt },
        { role: 'user', content: `Current scene:\n${ctx.sceneNarration}\n\nRecent events:\n${recentTranscript}\n\nWhat actions are you considering? Propose 2-4 actions that fit your personality and abilities. Respond as JSON: { "actions": [{ "description": "...", "reasoning": "..." }, ...] }` },
      ],
      schema: ActionProposalSchema,
    });
  }

  async decideAction(ctx: CharacterContext, whisper: string | null): Promise<ActionDecision> {
    const charPrompt = this.buildCharacterPrompt(ctx);
    const whisperText = whisper
      ? `\nA voice whispers in your mind: "${whisper}"\nYour trust in this voice: ${ctx.state.whisperTrust.toFixed(2)} (0=ignore, 1=obey). Consider the whisper alongside your personality.`
      : '\n(No whisper this turn — act on your own judgment.)';

    return callLlm({
      messages: [
        { role: 'system', content: charPrompt },
        { role: 'user', content: `You must now choose your action.${whisperText}\n\nRespond as JSON: { "chosenAction": "what you do", "innerThought": "your internal reasoning, showing how the whisper influenced (or didn't influence) your decision", "whisperedInfluence": "followed|partially-followed|ignored", "trustDelta": 0.0 }` },
      ],
      schema: ActionDecisionSchema,
    });
  }

  private buildCharacterPrompt(ctx: CharacterContext): string {
    const d = ctx.definition;
    return [
      `You ARE ${d.name}. Stay completely in character.`,
      `High concept: ${d.highConcept}`,
      `Trouble: ${d.trouble}`,
      `Personality: ${d.personality}`,
      `Aspects: ${d.aspects.join(', ')}`,
      `Skills: ${Object.entries(d.skills).map(([k, v]) => `${k}: +${v}`).join(', ')}`,
      `Current state: ${ctx.state.stress} stress, ${ctx.state.fatePoints} fate points, trust in the voice: ${ctx.state.whisperTrust.toFixed(2)}`,
      `Consequences: ${ctx.state.consequences.length > 0 ? ctx.state.consequences.join(', ') : 'none'}`,
      `\nAlways respond with valid JSON matching the requested format.`,
    ].join('\n');
  }
}
