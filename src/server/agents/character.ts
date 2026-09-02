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
  private static SKILL_KEYWORDS: Record<string, string[]> = {
    Stealth: ['sneak', 'creep', 'slip', 'shadow', 'hide', 'crouch', 'silent', 'quietly', 'unseen', 'unnoticed', 'stealthy', 'dart'],
    Fight: ['attack', 'strike', 'punch', 'kick', 'swing', 'slash', 'stab', 'fight', 'charge', 'tackle', 'grapple', 'block', 'parry', 'defend'],
    Athletics: ['climb', 'jump', 'run', 'sprint', 'leap', 'dodge', 'vault', 'swim', 'scramble', 'dash', 'acrobat'],
    Burglary: ['pick', 'lock', 'crack', 'safe', 'disable', 'disarm', 'trap', 'mechanism', 'bypass', 'break in', 'jimmy'],
    Notice: ['scan', 'watch', 'observe', 'look', 'listen', 'search', 'inspect', 'examine', 'peer', 'spot', 'survey'],
    Investigate: ['investigate', 'clue', 'deduce', 'analyze', 'study', 'research', 'examine', 'piece together', 'figure out'],
    Rapport: ['talk', 'ask', 'persuade', 'charm', 'befriend', 'negotiate', 'reason with', 'convince', 'appeal'],
    Deceive: ['lie', 'bluff', 'trick', 'disguise', 'pretend', 'feign', 'mislead', 'con', 'fake', 'impersonate'],
    Empathy: ['read', 'sense', 'feel', 'intuit', 'understand', 'gauge', 'assess mood', 'empathize'],
    Provoke: ['taunt', 'intimidate', 'threaten', 'provoke', 'challenge', 'confront', 'demand', 'scare'],
    Will: ['resist', 'endure', 'concentrate', 'focus', 'steel', 'brace', 'overcome fear'],
    Crafts: ['fix', 'repair', 'build', 'tinker', 'craft', 'modify', 'jury-rig', 'rewire', 'construct'],
    Lore: ['recall', 'know', 'knowledge', 'recognize', 'identify', 'remember lore', 'ancient', 'history'],
    Contacts: ['contact', 'know someone', 'call in', 'favor', 'connection', 'ally', 'informant'],
  };

  private detectDominantSkill(actions: string[], characterSkills: Record<string, number>): string | null {
    if (actions.length < 2) return null;
    const counts: Record<string, number> = {};
    for (const action of actions) {
      const lower = action.toLowerCase();
      for (const [skill, keywords] of Object.entries(CharacterAgent.SKILL_KEYWORDS)) {
        if (!(skill in characterSkills)) continue;
        if (keywords.some(kw => lower.includes(kw))) {
          counts[skill] = (counts[skill] ?? 0) + 1;
        }
      }
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0 && sorted[0]![1] >= 2) return sorted[0]![0];
    return null;
  }

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

    const dominant = this.detectDominantSkill(ownActions, ctx.definition.skills);
    const skillRotationBlock = dominant
      ? (() => {
          const otherSkills = Object.entries(ctx.definition.skills)
            .filter(([k, v]) => k !== dominant && v >= 1)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([k, v]) => `${k} (+${v})`);
          return otherSkills.length > 0
            ? `\n\nSKILL ROTATION: You've been over-relying on ${dominant}. This turn, lead with a DIFFERENT skill: ${otherSkills.join(', ')}. A thief can also fight, observe, talk, or run — show range.`
            : '';
        })()
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

    const userMessage = [
      `<scene>\n${ctx.sceneNarration}\n</scene>`,
      worldBlock ? `\n<world>${worldBlock}\n</world>` : '',
      ownActionsBlock ? `\n<recent_actions>${ownActionsBlock}\n</recent_actions>` : '',
      companionBlock ? `\n<companions>${companionBlock}\n</companions>` : '',
      skillRotationBlock ? `\n<skill_rotation>${skillRotationBlock}\n</skill_rotation>` : '',
      `\n<events>\n${recentTranscript}\n</events>`,
      `\n<task>`,
      `Propose 2-4 actions. Keep each description under 20 words. Include one bold/risky option. Each action should advance a SPECIFIC goal from your memories or the world state — follow up on a clue you found, confront someone whose behavior was suspicious, explore a location mentioned but not visited, or protect something you care about. Reference NPCs, items, or locations you know about BY NAME. Make at least one action SOCIAL — actually TALK to a named NPC (ask them a question, demand answers, plead for help, threaten them). "I ask the merchant about the missing shipments" not "I investigate the area." If you have companions, at least one action should INVOLVE them — coordinate an attack, ask for their expertise, protect them, or argue about strategy.`,
      `AVOID repeating actions from recent events. If you recently smiled, try confronting instead. If you recently fought, try investigating. Vary your approach.`,
      `Respond as JSON: { "actions": [{ "description": "short action", "reasoning": "brief why" }, ...] }`,
      `</task>`,
    ].filter(Boolean).join('\n');

    return callLlm({
      messages: [
        { role: 'system', content: charPrompt + '\nRespond with JSON ONLY. No thinking, no prose, no markdown. Start your response with { immediately. Do not use <think> tags.' },
        { role: 'user', content: userMessage },
      ],
      schema: ActionProposalSchema,
      maxTokens: 1536,
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

    const dominant = this.detectDominantSkill(recentActions, ctx.definition.skills);
    const decisionRotationBlock = dominant
      ? (() => {
          const otherSkills = Object.entries(ctx.definition.skills)
            .filter(([k, v]) => k !== dominant && v >= 1)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([k, v]) => `${k} (+${v})`);
          return otherSkills.length > 0
            ? `\nYou've leaned on ${dominant} too much — choose an action that uses ${otherSkills.join(' or ')} instead.`
            : '';
        })()
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

    const decisionMessage = [
      `<scene>\n${ctx.sceneNarration}\n</scene>`,
      `\n<events>\n${recentTranscript}\n</events>`,
      whisperText ? `\n<whisper>${whisperText}\n</whisper>` : '',
      itemReminder ? `\n<inventory>${itemReminder}\n</inventory>` : '',
      varietyBlock ? `\n<recent_actions>${varietyBlock}\n</recent_actions>` : '',
      decisionRotationBlock ? `\n<skill_rotation>${decisionRotationBlock}\n</skill_rotation>` : '',
      companionHint ? `\n<companions>${companionHint}\n</companions>` : '',
      `\n<task>`,
      `Choose your action now.`,
      `IMPORTANT: Your innerThought must be SPECIFIC — name people, places, items, or events. Never write vague thoughts like "Something feels off" or "I need to be careful." Instead: "Cassius was near the wine cellar when the poison was placed — I should confront him" or "My bruised ankle means I can't outrun the Phantom, so I'll use the narrow passage as a chokepoint." Reference your memories, your state, and the current situation.`,
      `Respond as JSON: { "chosenAction": "what you do (under 30 words)", "innerThought": "your internal reasoning referencing specific details (2 sentences)", "whisperedInfluence": "followed|partially-followed|ignored", "trustDelta": <number> }`,
      `</task>`,
    ].filter(Boolean).join('\n');

    return callLlm({
      messages: [
        { role: 'system', content: charPrompt + '\nRespond with JSON ONLY. No thinking, no prose, no markdown. Start your response with { immediately. Do not use <think> tags.' },
        { role: 'user', content: decisionMessage },
      ],
      schema: ActionDecisionSchema,
      maxTokens: 1536,
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
      `Your best skills are ${topSkills}, but you have a full skill set. Use ALL your skills across the adventure — a thief can also fight, observe, negotiate, or run. Vary which skill drives each action; never use the same approach twice in a row.`,
      `Current state: ${ctx.state.stress}/3 stress, ${ctx.state.fatePoints} fate points, trust in the voice: ${ctx.state.whisperTrust.toFixed(2)}`,
      ctx.state.fatePoints > 0
        ? `You have ${ctx.state.fatePoints} fate point${ctx.state.fatePoints > 1 ? 's' : ''}.${ctx.state.fatePoints >= 4 ? ' You are OVERFLOWING with fate points — SPEND them!' : ''} To spend a fate point for a +2 bonus, mention an aspect naturally in a NARRATIVE action (not "spending" or "invoking" — those are game terms). Your aspects: "${d.highConcept}", "${d.trouble}", ${d.aspects.map(a => `"${a}"`).join(', ')}. Example: "I call on my ${d.aspects[0]} and charge into the fray" — describe WHAT YOU DO, weaving the aspect into the story.`
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

    return `\nYour memories from this adventure (these MUST shape your actions — form GOALS from discoveries: if you found a clue, pursue it; if you witnessed something alarming, investigate it; if you made a promise, keep it. Avoid repeating past mistakes, build on what worked, and react to people you remember by name):\n${lines.join('\n')}`;
  }
}
