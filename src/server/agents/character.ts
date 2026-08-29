import { callLlm } from './llm-client.js';
import { ActionProposalSchema, ActionDecisionSchema } from './schemas.js';
import type { ActionProposal, ActionDecision } from './schemas.js';
import type { CharacterDefinition, CharacterState, TranscriptMessage } from '../../shared/types.js';
import type { CharacterMemory } from '../character-memory.js';

interface CharacterContext {
  definition: CharacterDefinition;
  state: CharacterState;
  sceneNarration: string;
  transcript: TranscriptMessage[];
  memories?: CharacterMemory[];
}

export class CharacterAgent {
  async proposeActions(ctx: CharacterContext): Promise<ActionProposal> {
    const charPrompt = this.buildCharacterPrompt(ctx);
    const recentTranscript = ctx.transcript.slice(-10).map(m => `[${m.role}] ${m.content}`).join('\n');

    return callLlm({
      messages: [
        { role: 'system', content: charPrompt },
        { role: 'user', content: `Current scene:\n${ctx.sceneNarration}\n\nRecent events:\n${recentTranscript}\n\nWhat actions are you considering? Propose 2-4 actions that fit your personality, abilities, and what you remember from past events. Respond as JSON: { "actions": [{ "description": "...", "reasoning": "..." }, ...] }` },
      ],
      schema: ActionProposalSchema,
    });
  }

  async decideAction(ctx: CharacterContext, whisper: string | null): Promise<ActionDecision> {
    const charPrompt = this.buildCharacterPrompt(ctx);
    let whisperText: string;
    if (whisper) {
      const trust = ctx.state.whisperTrust;
      const voiceQuality = trust > 0.7
        ? 'A familiar, trusted voice speaks clearly in your mind'
        : trust > 0.4
        ? 'A quiet voice whispers in your mind — you\'re uncertain whether to trust it'
        : 'A faint, distrusted voice murmurs at the edge of your thoughts';
      const guidance = trust > 0.5
        ? 'The voice has guided you before. Following it feels natural — you should follow or partially follow unless it contradicts your core values.'
        : 'You\'re wary of this voice. Follow only if the advice aligns with your instincts.';
      whisperText = `\n${voiceQuality}: "${whisper}"\nTrust level: ${trust.toFixed(2)} (0=ignore, 1=obey). ${guidance}\nSet trustDelta positive (+0.05 to +0.15) if the voice gives useful or insightful advice, negative (-0.05 to -0.15) if it seems harmful or wrong.`;
    } else {
      whisperText = '\n(No whisper this turn — act on your own judgment.)';
    }

    return callLlm({
      messages: [
        { role: 'system', content: charPrompt },
        { role: 'user', content: `You must now choose your action.${whisperText}\n\nRespond as JSON: { "chosenAction": "what you do", "innerThought": "your internal reasoning, showing how the whisper and your memories influenced (or didn't influence) your decision", "whisperedInfluence": "followed|partially-followed|ignored", "trustDelta": 0.0 }` },
      ],
      schema: ActionDecisionSchema,
    });
  }

  private buildCharacterPrompt(ctx: CharacterContext): string {
    const d = ctx.definition;
    const memoryBlock = ctx.memories && ctx.memories.length > 0
      ? this.formatMemories(ctx.memories)
      : '';

    return [
      `You ARE ${d.name}. Stay completely in character.`,
      `High concept: ${d.highConcept}`,
      `Trouble: ${d.trouble}`,
      `Personality: ${d.personality}`,
      `Aspects: ${d.aspects.join(', ')}`,
      `Skills: ${Object.entries(d.skills).map(([k, v]) => `${k}: +${v}`).join(', ')}`,
      `Current state: ${ctx.state.stress} stress, ${ctx.state.fatePoints} fate points, trust in the voice: ${ctx.state.whisperTrust.toFixed(2)}`,
      `Consequences: ${ctx.state.consequences.length > 0 ? ctx.state.consequences.join(', ') : 'none'}`,
      memoryBlock,
      `\nAlways respond with valid JSON matching the requested format.`,
    ].filter(Boolean).join('\n');
  }

  private formatMemories(memories: CharacterMemory[]): string {
    if (memories.length === 0) return '';

    const lines = memories.map(m => {
      const mood = m.emotionalValence > 0.3 ? '(positive)' : m.emotionalValence < -0.3 ? '(painful)' : '';
      return `- ${m.content} ${mood}`.trim();
    });

    return `\nYour memories from this adventure:\n${lines.join('\n')}`;
  }
}
