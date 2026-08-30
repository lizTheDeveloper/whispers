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
  worldContext?: string;
}

export class CharacterAgent {
  async proposeActions(ctx: CharacterContext): Promise<ActionProposal> {
    const charPrompt = this.buildCharacterPrompt(ctx);
    const recentTranscript = ctx.transcript.slice(-10).map(m => `[${m.role}] ${m.content}`).join('\n');
    const worldBlock = ctx.worldContext ? `\n\nWhat you know about the world:\n${ctx.worldContext}` : '';

    return callLlm({
      messages: [
        { role: 'system', content: charPrompt },
        { role: 'user', content: `Current scene:\n${ctx.sceneNarration}${worldBlock}\n\nRecent events:\n${recentTranscript}\n\nPropose 2-4 actions. Keep each description under 20 words. Include one bold/risky option. Reference NPCs, items, or locations you know about.\n\nRespond as JSON: { "actions": [{ "description": "short action", "reasoning": "brief why" }, ...] }` },
      ],
      schema: ActionProposalSchema,
      maxTokens: 768,
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
        ? 'The voice has guided you before. Following it feels natural — but ALWAYS evaluate the advice on its own merits. Even a trusted voice can give bad advice. If the suggestion would clearly harm you, betray an ally, or be suicidal/reckless, IGNORE it and set a negative trustDelta.'
        : 'You\'re wary of this voice. Follow only if the advice aligns with your instincts and common sense.';
      whisperText = `\n${voiceQuality}: "${whisper}"\nTrust level: ${trust.toFixed(2)} (0=ignore, 1=obey). ${guidance}

trustDelta rules (ALWAYS set a non-zero value when a whisper is present):
- Advice that helps you survive, discover, or connect: trustDelta = +0.05 to +0.10
- Advice you partially follow or find reasonable: trustDelta = +0.03 to +0.05
- Advice that would harm you, betray allies, or is clearly reckless: trustDelta = -0.08 to -0.15
- Advice you ignore because it's irrelevant (not harmful): trustDelta = -0.02 to -0.05
NEVER set trustDelta to exactly 0.0 when a whisper was given.`;
    } else {
      whisperText = '\n(No whisper this turn — act on your own judgment.)';
    }

    const recentTranscript = ctx.transcript.slice(-6).map(m => `[${m.role}] ${m.content}`).join('\n');

    return callLlm({
      messages: [
        { role: 'system', content: charPrompt },
        { role: 'user', content: `Current scene:\n${ctx.sceneNarration}\n\nRecent events:\n${recentTranscript}\n\nYou must now choose your action.${whisperText}\n\nRespond as JSON: { "chosenAction": "what you do (under 30 words)", "innerThought": "your internal reasoning (1-2 sentences)", "whisperedInfluence": "followed|partially-followed|ignored", "trustDelta": <number> }` },
      ],
      schema: ActionDecisionSchema,
      maxTokens: 512,
    });
  }

  private buildCharacterPrompt(ctx: CharacterContext): string {
    const d = ctx.definition;
    const memoryBlock = ctx.memories && ctx.memories.length > 0
      ? this.formatMemories(ctx.memories)
      : '';

    const sortedSkills = Object.entries(d.skills).sort((a, b) => b[1] - a[1]);
    const topSkills = sortedSkills.slice(0, 3).map(([k, v]) => `${k} (+${v})`).join(', ');
    const skillLine = sortedSkills.map(([k, v]) => `${k}: +${v}`).join(', ');

    return [
      `You ARE ${d.name}. Stay completely in character.`,
      `High concept: ${d.highConcept}`,
      `Trouble: ${d.trouble}`,
      `Personality: ${d.personality}`,
      `Aspects: ${d.aspects.join(', ')}`,
      `Skills: ${skillLine}`,
      `Your strengths are ${topSkills} — lean into these when proposing actions. A character with high Lore uses knowledge, not swords. A character with high Fight charges in. Play to YOUR strengths.`,
      `Current state: ${ctx.state.stress}/3 stress, ${ctx.state.fatePoints} fate points, trust in the voice: ${ctx.state.whisperTrust.toFixed(2)}`,
      ctx.state.consequences.length > 0
        ? `Consequences: ${ctx.state.consequences.join(', ')} — these injuries and conditions LIMIT what you can do. A broken arm means no climbing. A frightened mind means hesitation. Propose actions that acknowledge your wounds.`
        : `Consequences: none`,
      ctx.state.stress >= 2
        ? `You are badly stressed (${ctx.state.stress}/3). You are rattled, exhausted, or hurt. Favor cautious, defensive, or desperate actions over bold ones.`
        : '',
      memoryBlock,
      `\nAlways respond with valid JSON matching the requested format.`,
    ].filter(Boolean).join('\n');
  }

  private formatMemories(memories: CharacterMemory[]): string {
    if (memories.length === 0) return '';

    const lines = memories.map(m => {
      const mood = m.emotionalValence > 0.3 ? '(positive)' : m.emotionalValence < -0.3 ? '(painful)' : '';
      return `- [${m.type}] ${m.content} ${mood}`.trim();
    });

    return `\nYour memories from this adventure (these MUST shape your actions — reference them in your reasoning, avoid repeating past mistakes, build on what worked, and react to people you remember):\n${lines.join('\n')}`;
  }
}
