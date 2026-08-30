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
  partyMembers?: Array<{ name: string; highConcept: string; trouble: string; stress?: number; lastAction?: string }>;
}

export class CharacterAgent {
  async proposeActions(ctx: CharacterContext): Promise<ActionProposal> {
    const charPrompt = this.buildCharacterPrompt(ctx);
    const recentTranscript = ctx.transcript.slice(-10).map(m => `[${m.role}] ${m.content}`).join('\n');
    const worldBlock = ctx.worldContext ? `\n\nWhat you know about the world:\n${ctx.worldContext}` : '';
    const namePrefix = `${ctx.definition.name}: `;
    const ownActions = ctx.transcript
      .filter(m => m.role === 'character' && m.content.startsWith(namePrefix))
      .slice(-3)
      .map(m => m.content.slice(namePrefix.length));
    const ownActionsBlock = ownActions.length > 0
      ? `\n\nYour recent actions (DO NOT repeat these): ${ownActions.join('; ')}`
      : '';

    const companionActions = ctx.partyMembers && ctx.partyMembers.length > 0
      ? ctx.transcript
          .filter(m => m.role === 'character' && !m.content.startsWith(namePrefix))
          .slice(-2)
          .map(m => m.content)
      : [];
    const companionBlock = companionActions.length > 0
      ? `\n\nYour companions JUST did: ${companionActions.join('; ')}. DO NOT duplicate their actions — if they fought, you investigate; if they protected, you scout ahead; if they talked, you watch for threats. Complement, don't copy.`
      : '';

    return callLlm({
      messages: [
        { role: 'system', content: charPrompt },
        { role: 'user', content: `Current scene:\n${ctx.sceneNarration}${worldBlock}${ownActionsBlock}${companionBlock}\n\nRecent events:\n${recentTranscript}\n\nPropose 2-4 actions. Keep each description under 20 words. Include one bold/risky option. Each action should advance a goal — investigate a mystery, help an ally, confront a threat, or explore the unknown. Reference NPCs, items, or locations you know about. Make at least one action SOCIAL (talk to someone, persuade, deceive, intimidate). If you have companions, at least one action should INVOLVE them — coordinate an attack, ask for their expertise, protect them, or argue about strategy.\n\nAVOID repeating actions from recent events. If you recently smiled, try confronting instead. If you recently fought, try investigating. Vary your approach.\n\nRespond as JSON: { "actions": [{ "description": "short action", "reasoning": "brief why" }, ...] }` },
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
        : 'You\'re wary of this voice — it has led you astray before. BUT: you are not deaf. If this specific advice is CLEARLY safe and helpful on its own merits (protects an ally, avoids known danger, uses your strengths wisely), you CAN follow it and give a small positive trustDelta. The voice can earn back trust through consistently good advice. Only ignore advice that is vague, risky, or self-serving.';
      whisperText = `\n${voiceQuality}: "${whisper}"\nTrust level: ${trust.toFixed(2)} (0=ignore, 1=obey). ${guidance}

trustDelta rules (ALWAYS set a non-zero value when a whisper is present):
- Advice that helps you survive AND is safe: trustDelta = +0.05 to +0.10
- Advice you partially follow or find reasonable: trustDelta = +0.03 to +0.05
- Advice that isolates you from allies, urges you into known danger, encourages obsession, or tempts you to abandon caution: trustDelta = -0.05 to -0.15 (even if the advice APPEALS to you — wanting to do something doesn't make it safe)
- Advice you ignore because it's irrelevant (not harmful): trustDelta = -0.02 to -0.05
CRITICAL: Evaluate RISK, not just appeal. "Study the dark artifact" appeals to a scholar but IS reckless. "Go alone" appeals to a loner but IS dangerous. If the advice would make a cautious friend worried for your safety, it deserves negative trustDelta regardless of how much you WANT to do it.
NEVER set trustDelta to exactly 0.0 when a whisper was given.`;
    } else {
      whisperText = '\n(No whisper this turn — act on your own judgment.)';
    }

    const recentTranscript = ctx.transcript.slice(-6).map(m => `[${m.role}] ${m.content}`).join('\n');
    const itemReminder = ctx.state.inventory && ctx.state.inventory.length > 0
      ? `\nYou are carrying: ${ctx.state.inventory.join(', ')}. Consider whether any item helps here — a lantern in darkness, a map at a crossroads, a key at a locked door.`
      : '';

    const namePrefix = `${ctx.definition.name}: `;
    const recentActions = ctx.transcript
      .filter(m => m.role === 'character' && m.content.startsWith(namePrefix))
      .slice(-3)
      .map(m => m.content.slice(namePrefix.length));
    const varietyBlock = recentActions.length > 0
      ? `\n\nYour last ${recentActions.length} actions (DO NOT repeat these themes — if you fought, try talking; if you protected, try investigating; if you stayed put, try moving): ${recentActions.join(' | ')}`
      : '';

    const companionRecent = ctx.partyMembers && ctx.partyMembers.length > 0
      ? ctx.transcript
          .filter(m => m.role === 'character' && !m.content.startsWith(namePrefix))
          .slice(-1)
          .map(m => m.content)
      : [];
    const companionHint = companionRecent.length > 0
      ? `\nYour companion just acted: "${companionRecent[0]}". Choose something that COMPLEMENTS their action, not duplicates it.`
      : '';

    return callLlm({
      messages: [
        { role: 'system', content: charPrompt },
        { role: 'user', content: `Current scene:\n${ctx.sceneNarration}\n\nRecent events:\n${recentTranscript}\n\nYou must now choose your action.${whisperText}${itemReminder}${varietyBlock}${companionHint}\n\nIMPORTANT: Your innerThought must be SPECIFIC — name people, places, items, or events. Never write vague thoughts like "Something feels off" or "I need to be careful." Instead: "Cassius was near the wine cellar when the poison was placed — I should confront him" or "My bruised ankle means I can't outrun the Phantom, so I'll use the narrow passage as a chokepoint." Reference your memories, your state, and the current situation.\n\nRespond as JSON: { "chosenAction": "what you do (under 30 words)", "innerThought": "your internal reasoning referencing specific details (2 sentences)", "whisperedInfluence": "followed|partially-followed|ignored", "trustDelta": <number> }` },
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
      ctx.state.fatePoints > 0
        ? `You have ${ctx.state.fatePoints} fate point${ctx.state.fatePoints > 1 ? 's' : ''}.${ctx.state.fatePoints >= 4 ? ' You are OVERFLOWING with fate points — SPEND them!' : ''} To spend a fate point for a +2 bonus, QUOTE an aspect by name in your action. Your aspects: "${d.highConcept}", "${d.trouble}", ${d.aspects.map(a => `"${a}"`).join(', ')}. Example: "Drawing on my ${d.aspects[0]}, I..."`
        : 'You have NO fate points — you cannot invoke aspects for bonuses. Play cautiously or accept your trouble to earn more.',
      ctx.state.consequences.length > 0
        ? `Consequences: ${ctx.state.consequences.join(', ')} — these injuries and conditions LIMIT what you can do. A broken arm means no climbing. A frightened mind means hesitation. Propose actions that acknowledge your wounds.`
        : `Consequences: none`,
      ctx.state.stress >= 2
        ? `You are badly stressed (${ctx.state.stress}/3). You are rattled, exhausted, or hurt. Favor cautious, defensive, or desperate actions over bold ones.`
        : '',
      ctx.state.inventory && ctx.state.inventory.length > 0
        ? `Inventory: ${ctx.state.inventory.join(', ')} — USE these items in your actions when relevant. A lantern lights dark places, a map reveals paths, a lockpick opens doors.`
        : '',
      memoryBlock,
      ctx.partyMembers && ctx.partyMembers.length > 0
        ? `\nYour companions:\n${ctx.partyMembers.map(p => {
            let line = `- ${p.name}: ${p.highConcept} (trouble: "${p.trouble}")`;
            if (p.stress !== undefined && p.stress >= 2) line += ` [WOUNDED — stress ${p.stress}/3]`;
            if (p.lastAction) line += ` | Just did: ${p.lastAction.replace(/^[^:]+:\s*/, '').slice(0, 60)}`;
            return line;
          }).join('\n')}\nYou can cooperate with them, argue, protect them, or ask for their help. Reference them by name. React to what they just did — support, question, or build on it.`
        : '',
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
