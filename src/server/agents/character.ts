import { callLlm } from './llm-client.js';
import { PLAIN_PROSE_STYLE } from './style.js';
import { ActionProposalSchema, ActionDecisionSchema } from './schemas.js';
import type { ActionProposal, ActionDecision } from './schemas.js';
import type { CharacterDefinition, CharacterState, TranscriptMessage } from '../../shared/types.js';
import type { CharacterMemory } from '../character-memory.js';

const NAME_TITLES = new Set(['dame', 'sir', 'lord', 'lady', 'prince', 'princess', 'king', 'queen', 'duke', 'duchess', 'count', 'countess', 'baron', 'baroness', 'master', 'captain', 'elder', 'chief', 'sister', 'brother', 'father', 'mother', 'doctor', 'professor']);
function getFirstName(fullName: string): string {
  const parts = fullName.split(/\s+/);
  return parts.find(p => !NAME_TITLES.has(p.toLowerCase())) ?? parts[0]!;
}

export interface PartyMemberView {
  name: string;
  highConcept: string;
  trouble: string;
  stress?: number;
  lastAction?: string;
  /** What this companion is to the viewing character ("mother"). */
  relation?: string;
  /** What the viewing character calls them ("Mom"). */
  address?: string;
  /** What the viewing character is to them, when only their sheet states the tie ("son"). */
  viewerIsTheir?: string;
  age?: number | string;
  /** How to refer to them ("she/her"), as the sheets state it; unset = not stated. */
  pronouns?: string;
  /** What THEY call the viewing character, when it is not just the viewer's name. */
  callsYou?: string;
  /** Taken out (FATE): down, unable to act or speak until they recover. */
  takenOut?: boolean;
}

interface CharacterContext {
  definition: CharacterDefinition;
  state: CharacterState;
  sceneNarration: string;
  transcript: TranscriptMessage[];
  memories?: CharacterMemory[];
  worldContext?: string;
  partyMembers?: PartyMemberView[];
  /** This character's own pronouns as the sheets state them (their own, or a companion's relation word); unset = not stated. */
  ownPronouns?: string;
}

const FEMININE = /\b(mother|mom|mum|mama|sister|daughter|wife|aunt|grandmother|grandma|granny|niece|girlfriend|stepmother|stepdaughter|stepsister)\b/i;
const MASCULINE = /\b(father|dad|papa|brother|son|husband|uncle|grandfather|grandpa|nephew|boyfriend|stepfather|stepson|stepbrother)\b/i;
function pronounFor(relation: string | undefined): 'her' | 'him' | 'them' {
  if (relation && FEMININE.test(relation)) return 'her';
  if (relation && MASCULINE.test(relation)) return 'him';
  return 'them';
}

/** The companion's pronouns: stated on the sheets, or implied by the viewer's own relation word ("mother" → she/her). */
export function companionPronouns(p: PartyMemberView): string | null {
  if (p.pronouns?.trim()) return p.pronouns.trim();
  const implied = pronounFor(p.relation);
  return implied === 'her' ? 'she/her' : implied === 'him' ? 'he/him' : null;
}

/** "Biz — pronouns not stated: say "Biz" or "they", never he/him/his or she/her." */
export function pronounRule(p: PartyMemberView): string {
  const pron = companionPronouns(p);
  return pron
    ? `${p.name}: ${pron}`
    : `${p.name}: pronouns not stated — say "${getFirstName(p.name)}" or "they", never he/him/his or she/her`;
}

/**
 * How this character actually speaks to a companion: the address term from
 * their sheet ("Mom") when there is one, otherwise the companion's first name.
 */
export function addressTermFor(p: PartyMemberView): string {
  return p.address?.trim() || getFirstName(p.name);
}

/**
 * One companion line, from the viewer's side:
 * `- Liz — your mother (you call her "Mom"): Overworked Mom… (trouble: "…")`.
 */
export function describeCompanion(p: PartyMemberView): string {
  // Only the viewer's own relation word says anything about the companion's
  // gender ("mother" -> her); the reverse tie ("you are their son") does not.
  const pron = pronounFor(p.relation);
  let who = '';
  if (p.relation) {
    who = ` — your ${p.relation}`;
  } else if (p.viewerIsTheir) {
    who = ` — you are their ${p.viewerIsTheir}`;
  }
  const address = p.address && p.address.trim() && p.address.trim().toLowerCase() !== p.name.trim().toLowerCase()
    ? ` (you call ${pron} "${p.address.trim()}")`
    : '';
  const age = p.age !== undefined && String(p.age).trim() ? `, age ${String(p.age).trim()}` : '';
  const stated = companionPronouns(p);
  const pronouns = stated
    ? `; pronouns: ${stated}`
    : `; pronouns not stated — refer to them by name or "they", never "he" or "she"`;
  const callsYou = p.callsYou?.trim() ? `; they call you "${p.callsYou.trim()}"` : '';
  const out = p.takenOut
    ? ` [TAKEN OUT — down and out of action: cannot act, speak or help until someone helps them up or the scene ends. You could help them.]`
    : '';
  return `- ${p.name}${who}${address}: ${p.highConcept}${age}${pronouns}${callsYou} (trouble: "${p.trouble}")${out}`;
}

/** "Liz → "Mom"" for each companion this character has an address term for. */
function addressDirective(members: PartyMemberView[]): string {
  const terms = members.filter(p => p.address?.trim() && p.address.trim().toLowerCase() !== getFirstName(p.name).toLowerCase() && p.address.trim().toLowerCase() !== p.name.trim().toLowerCase());
  if (terms.length === 0) return '';
  return ` When your spokenWords talk TO a companion, call them what you call them: ${terms.map(p => `${getFirstName(p.name)} is "${p.address!.trim()}" ("${p.address!.trim()}, can you…?")`).join('; ')} — never their first name, and never "${terms[0]!.address!.trim()} ${getFirstName(terms[0]!.name)}".`;
}

const ADDRESS_DIRECTIVE = 'address them the way your character naturally would — by the name, title or relation you use for them';

export class CharacterAgent {
  private static SKILL_KEYWORDS: Record<string, string[]> = {
    Stealth: ['sneak', 'creep', 'slip past', 'slip into', 'slip through', 'shadow', 'hide', 'crouch', 'silent', 'quietly', 'unseen', 'unnoticed', 'stealthy', 'dart behind', 'trail behind', 'tiptoe', 'slink', 'ease past', 'skulk'],
    Fight: ['attack', 'strike', 'punch', 'kick', 'swing', 'slash', 'stab', 'fight', 'charge', 'tackle', 'grapple', 'block', 'parry', 'defend', 'hammer', 'smash', 'bash', 'shove', 'wrestle'],
    Athletics: ['climb', 'jump', 'run', 'sprint', 'leap', 'dodge', 'vault over', 'swim', 'scramble', 'dash', 'acrobat', 'rush', 'move quickly', 'race'],
    Physique: ['wedge', 'brace', 'shore', 'lift', 'push', 'pull', 'heave', 'carry', 'pry', 'force open', 'barricade'],
    Burglary: ['pick the lock', 'lockpick', 'crack the', 'crack open', 'disable the', 'disarm the', 'trap', 'mechanism', 'bypass', 'break in', 'jimmy', 'unlock', 'steal', 'pocket', 'swipe'],
    Notice: ['scan', 'watch for', 'observe', 'listen for', 'search for', 'inspect', 'peer', 'spot', 'survey', 'glance around', 'overhear', 'eavesdrop', 'scout ahead'],
    Investigate: ['investigate', 'clue', 'deduce', 'analyze', 'study the', 'research', 'piece together', 'figure out', 'scrutinize', 'compare', 'decipher'],
    Rapport: ['persuade', 'charm', 'befriend', 'negotiate', 'reason with', 'convince', 'appeal to', 'greet', 'introduce myself', 'confide', 'plead', 'whisper to'],
    Deceive: ['lie', 'bluff', 'trick', 'disguise', 'pretend', 'feign', 'mislead', 'con ', 'fake', 'impersonate', 'distract', 'divert', 'cover story'],
    Empathy: ['sense their', 'intuit', 'gauge', 'assess mood', 'empathize', 'read their face', 'body language', 'read their'],
    Provoke: ['taunt', 'intimidate', 'threaten', 'provoke', 'challenge', 'confront', 'demand', 'scare', 'accuse', 'corner them'],
    Will: ['resist', 'endure', 'concentrate', 'steel myself', 'brace', 'overcome fear', 'compose', 'steady myself', 'center'],
    Crafts: ['fix', 'repair', 'build', 'tinker', 'craft', 'modify', 'jury-rig', 'rewire', 'construct'],
    Lore: ['recall', 'knowledge', 'recognize', 'identify', 'remember lore', 'ancient', 'history'],
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

  private detectRepeatedOpeners(actions: string[]): string[] {
    if (actions.length < 2) return [];
    const openers = actions.map(a => {
      const words = a.replace(/^["']/, '').trim().split(/\s+/).slice(0, 3);
      return words.join(' ').toLowerCase();
    });
    const counts: Record<string, number> = {};
    for (const opener of openers) {
      counts[opener] = (counts[opener] ?? 0) + 1;
    }
    return Object.entries(counts)
      .filter(([, count]) => count >= 2)
      .map(([opener]) => opener);
  }

  private extractNearbyNpcs(worldContext: string | undefined): string[] {
    if (!worldContext) return [];
    const match = worldContext.match(/People nearby:\s*(.+?)(?:\n|$)/);
    if (!match) return [];
    return (match[1] ?? '').split(';').map(s => s.trim().split(/\s*\(/)[0]?.trim()).filter((n): n is string => !!n && n.length > 0);
  }

  async proposeActions(ctx: CharacterContext): Promise<ActionProposal> {
    const charPrompt = this.buildCharacterPrompt(ctx);
    const recentTranscript = ctx.transcript.slice(-10).map(m => `[${m.role}] ${m.content}`).join('\n');
    const worldBlock = ctx.worldContext ? `\n\nWhat you know about the world (from what the story has shown you so far — this is ALL you know beyond your own past and memories):\n${ctx.worldContext}` : '';
    const namePrefix = `${ctx.definition.name}: `;
    const nearbyNpcs = this.extractNearbyNpcs(ctx.worldContext);
    const ownActions = ctx.transcript
      .filter(m => m.role === 'character' && m.content.startsWith(namePrefix))
      .slice(-5)
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
          const forbidden = CharacterAgent.SKILL_KEYWORDS[dominant]?.slice(0, 6).join(', ') ?? '';
          return otherSkills.length > 0
            ? `\n\nSKILL ROTATION (MANDATORY): You've used ${dominant} in 2+ of your last 3 actions. This turn you MUST NOT ${dominant.toLowerCase()}. DO NOT use words like: ${forbidden}. Instead, propose actions using: ${otherSkills.join(', ')}. For example: fight someone, climb something, pick a lock, ask an NPC a question, or observe your surroundings.`
            : '';
        })()
      : '';

    const repeatedOpeners = this.detectRepeatedOpeners(ownActions);
    const phraseVarietyBlock = repeatedOpeners.length > 0
      ? `\n\nPHRASING VARIETY (MANDATORY): You keep starting actions with "${repeatedOpeners.join('", "')}". DO NOT begin your next action with those words. Start differently — "Turning to...", "With a sharp glance...", "Drawing my blade...", "Stepping forward...", "Confronting...", etc.`
      : '';

    const companionActions = ctx.partyMembers && ctx.partyMembers.length > 0
      ? ctx.transcript
          .filter(m => m.role === 'character' && !m.content.startsWith(namePrefix))
          .slice(-2)
          .map(m => m.content)
      : [];
    const companionNames = (ctx.partyMembers ?? []).map(addressTermFor).join(', ');
    const pronounBlock = (ctx.partyMembers ?? []).length > 0
      ? `\nWhen you mention a companion: ${(ctx.partyMembers ?? []).map(pronounRule).join('; ')}.`
      : '';
    const companionBlock = companionActions.length > 0
      ? `\n\nYour companions JUST did: ${companionActions.join('; ')}. DO NOT duplicate their actions — complement them. At least one proposed action MUST engage them directly — ${ADDRESS_DIRECTIVE} (${companionNames}): "I tell ${companionNames} to cover me while I..." or "I ask ${companionNames} what they think about..." or "I grab ${companionNames}'s arm and pull them toward...". Characters who never interact feel like strangers.`
      : '';

    const npcDirective = nearbyNpcs.length > 0
      ? `\nNPCs HERE NOW: ${nearbyNpcs.join(', ')}. One of your proposed actions MUST be talking directly to one of them by name — "I confront ${nearbyNpcs[0]} about..." or "I ask ${nearbyNpcs[nearbyNpcs.length > 1 ? 1 : 0]} what they know about..."`
      : '';

    const userMessage = [
      `<scene>\n${ctx.sceneNarration}\n</scene>`,
      worldBlock ? `\n<world>${worldBlock}\n</world>` : '',
      ownActionsBlock ? `\n<recent_actions>${ownActionsBlock}\n</recent_actions>` : '',
      companionBlock || pronounBlock ? `\n<companions>${companionBlock}${pronounBlock}\n</companions>` : '',
      skillRotationBlock ? `\n<skill_rotation>${skillRotationBlock}\n</skill_rotation>` : '',
      phraseVarietyBlock ? `\n<phrasing>${phraseVarietyBlock}\n</phrasing>` : '',
      npcDirective ? `\n<npcs>${npcDirective}\n</npcs>` : '',
      `\n<events>\n${recentTranscript}\n</events>`,
      `\n<task>`,
      `Propose 2-4 actions. Keep each description under 20 words. Include one bold/risky option. Each action should advance a SPECIFIC goal from your memories or the world state — follow up on a clue you found, confront someone whose behavior was suspicious, explore a location mentioned but not visited, or protect something you care about. Reference NPCs, items, or locations you know about BY NAME. Make at least one action SOCIAL — actually TALK to a named NPC (ask them a question, demand answers, plead for help, threaten them). "I ask the merchant about the missing shipments" not "I investigate the area." If you have companions, at least one action MUST involve them directly — ${ADDRESS_DIRECTIVE}: "I tell ${companionNames || 'my companion'} to watch the door" or "I ask ${companionNames || 'my companion'} for their opinion on..." — parties are parties because members interact.`,
      `AVOID repeating actions from recent events. If you recently smiled, try confronting instead. If you recently fought, try investigating. Vary your approach.`,
      `Respond as JSON: { "actions": [{ "description": "short action", "reasoning": "brief why" }, ...] }`,
      `</task>`,
    ].filter(Boolean).join('\n');

    return callLlm({
      messages: [
        { role: 'system', content: charPrompt + '\nRespond with JSON ONLY. No thinking, no prose, no markdown. Start your response with { immediately. Do not use <think> tags.\n' + PLAIN_PROSE_STYLE },
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
      .slice(-5)
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
          const forbidden = CharacterAgent.SKILL_KEYWORDS[dominant]?.slice(0, 6).join(', ') ?? '';
          return otherSkills.length > 0
            ? `\nSKILL ROTATION: You MUST NOT choose a ${dominant}-based action this turn. Avoid: ${forbidden}. Pick an action that uses ${otherSkills.join(' or ')} instead.`
            : '';
        })()
      : '';

    const decisionRepeatedOpeners = this.detectRepeatedOpeners(recentActions);
    const decisionPhraseBlock = decisionRepeatedOpeners.length > 0
      ? `\nPHRASING VARIETY: You keep starting actions with "${decisionRepeatedOpeners.join('", "')}". DO NOT begin this action with those words. Start with a completely different verb or phrase.`
      : '';

    const companionRecent = ctx.partyMembers && ctx.partyMembers.length > 0
      ? ctx.transcript
          .filter(m => m.role === 'character' && !m.content.startsWith(namePrefix))
          .slice(-1)
          .map(m => m.content)
      : [];
    const decideCompanionNames = (ctx.partyMembers ?? []).map(addressTermFor).join(', ');
    const companionHint = companionRecent.length > 0
      ? `\nYour companion just acted: "${companionRecent[0]}". COMPLEMENT their action — and if you're interacting with them, ${ADDRESS_DIRECTIVE} (${decideCompanionNames}). "I call out to ${decideCompanionNames}..." or "I move to cover ${decideCompanionNames}..." — parties that never speak to each other feel dead.`
      : '';

    const memoryGoals = this.deriveGoals(ctx.memories ?? []);
    const memoryGoalBlock = memoryGoals.length > 0
      ? `\n<memory_goals>\nYour active goals from past experience:\n${memoryGoals.map(g => `- ${g}`).join('\n')}\nLet these goals inform your choice — pursue, advance, or reference them.\n</memory_goals>`
      : '';

    const decisionMessage = [
      `<scene>\n${ctx.sceneNarration}\n</scene>`,
      `\n<events>\n${recentTranscript}\n</events>`,
      memoryGoalBlock,
      whisperText ? `\n<whisper>${whisperText}\n</whisper>` : '',
      itemReminder ? `\n<inventory>${itemReminder}\n</inventory>` : '',
      varietyBlock ? `\n<recent_actions>${varietyBlock}\n</recent_actions>` : '',
      decisionRotationBlock ? `\n<skill_rotation>${decisionRotationBlock}\n</skill_rotation>` : '',
      decisionPhraseBlock ? `\n<phrasing>${decisionPhraseBlock}\n</phrasing>` : '',
      companionHint ? `\n<companions>${companionHint}\n</companions>` : '',
      `\n<task>`,
      `Choose your action now.`,
      `IMPORTANT: Your innerThought must be SPECIFIC — name people, places, items, or events. Never write vague thoughts like "Something feels off" or "I need to be careful." Instead: "Cassius was near the wine cellar when the poison was placed — I should confront him" or "My bruised ankle means I can't outrun the Phantom, so I'll use the narrow passage as a chokepoint." Reference your memories, your state, and the current situation.${whisper ? ' Your FIRST sentence must address the whisper directly — explain WHY you chose to follow, partially follow, or resist it. "The voice urges caution, and my bruised ribs agree — I cannot afford another fight" (followed). "The voice wants me to steal the key, but Mirra trusted me with her secret — I will not betray that" (ignored). "The whisper has a point about the passage, though I will approach my own way" (partially-followed). The player who whispered needs to understand your reasoning.' : ''}`,
      `DIALOGUE: If your action involves talking, confronting, persuading, questioning, threatening, comforting, or arguing with ANYONE (NPC or companion), set "spokenWords" to your ACTUAL WORDS — not a description of speaking, but the words themselves. "Where did you hide the note, Cassius?" not "I ask Cassius about the note." If your action is purely physical (fighting, sneaking, searching), set spokenWords to null. Characters who speak feel alive; characters who only act feel like puppets.${addressDirective(ctx.partyMembers ?? [])}${(ctx.partyMembers ?? []).length > 0 ? ` Companions' pronouns — ${(ctx.partyMembers ?? []).map(pronounRule).join('; ')}.` : ''}`,
      `whisperedInfluence DEFINITIONS — pick the one that MATCHES your action:`,
      `- "followed": Your action DIRECTLY does what the whisper suggested (same target, same approach). The voice said "confront the merchant" and you confront the merchant.`,
      `- "partially-followed": The whisper SHAPED your thinking but you adapted it. The voice said "confront the merchant" and you investigated the merchant instead, or confronted someone else.`,
      `- "ignored": You did something UNRELATED to the whisper's suggestion. The voice said "confront the merchant" and you explored a tunnel instead. Also use "ignored" when you actively REJECT the advice.`,
      `Do NOT default to "partially-followed" — it is not a safe middle ground. Ask yourself: does my action do what the voice asked? YES = followed. SORT OF = partial. NO = ignored.`,
      `Respond as JSON: { "chosenAction": "what you do (under 30 words)", "spokenWords": "your actual dialogue or null", "innerThought": "your internal reasoning referencing specific details (2 sentences)", "whisperedInfluence": "followed|partially-followed|ignored", "trustDelta": <number> }`,
      `</task>`,
    ].filter(Boolean).join('\n');

    const forbiddenKeywords = dominant
      ? CharacterAgent.SKILL_KEYWORDS[dominant]?.slice(0, 8) ?? []
      : [];

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: charPrompt + '\nRespond with JSON ONLY. No thinking, no prose, no markdown. Start your response with { immediately. Do not use <think> tags.\n' + PLAIN_PROSE_STYLE },
      { role: 'user', content: decisionMessage },
    ];

    const result = await callLlm({ messages, schema: ActionDecisionSchema, maxTokens: 1536 });

    if (forbiddenKeywords.length > 0) {
      const actionLower = result.chosenAction.toLowerCase();
      const violated = forbiddenKeywords.filter(kw => actionLower.includes(kw));
      if (violated.length > 0) {
        console.log(`[character] Skill rotation ENFORCED: "${result.chosenAction.slice(0, 60)}" contains forbidden [${violated.join(', ')}] — retrying`);
        messages.push(
          { role: 'assistant', content: JSON.stringify(result) },
          { role: 'user', content: `REJECTED: Your action uses ${dominant} (contains: ${violated.join(', ')}). You MUST choose a completely different approach that does NOT involve ${dominant?.toLowerCase()}. Try a different skill entirely.` },
        );
        return callLlm({ messages, schema: ActionDecisionSchema, maxTokens: 1536 });
      }
    }

    return result;
  }

  private buildCharacterPrompt(ctx: CharacterContext): string {
    const d = ctx.definition;
    const memoryBlock = ctx.memories && ctx.memories.length > 0
      ? this.formatMemories(ctx.memories)
      : '';

    const sortedSkills = Object.entries(d.skills).sort((a, b) => b[1] - a[1]);
    const topSkills = sortedSkills.slice(0, 3).map(([k, v]) => `${k} (+${v})`).join(', ');
    const skillLine = sortedSkills.map(([k, v]) => `${k}: +${v}`).join(', ');

    const ageText = d.age !== undefined && String(d.age).trim() ? String(d.age).trim() : '';
    return [
      `You ARE ${d.name}. Stay completely in character.`,
      ageText ? `Age: ${ageText}. Think, talk and act like someone your age — how you see the world, what you notice, what you would and would not do.` : '',
      (ctx.ownPronouns ?? d.pronouns)?.trim()
        ? `Your pronouns: ${(ctx.ownPronouns ?? d.pronouns)!.trim()}.`
        : `Your pronouns have not been stated — others refer to you by name or "they".`,
      `High concept: ${d.highConcept}`,
      `Trouble: ${d.trouble}`,
      `Personality: ${d.personality}`,
      d.backstory && d.backstory.trim() ? `Backstory: ${d.backstory.trim()}` : '',
      `Aspects: ${d.aspects.join(', ')}`,
      d.stunts && d.stunts.length > 0 ? `Stunts: ${d.stunts.join('; ')}` : '',
      `Skills: ${skillLine}`,
      `Your best skills are ${topSkills}, but you have a full skill set. Use ALL your skills across the adventure — a thief can also fight, observe, negotiate, or run. Vary which skill drives each action; never use the same approach twice in a row.`,
      `You know only your own past, your memories, and what has happened in front of you in this story. When you name a person, place, or thing, it must be one you have actually met, seen, or heard of in the story — never invent or guess at names, secrets, or who is behind what.`,
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
            let line = describeCompanion(p);
            if (p.stress !== undefined && p.stress >= 2) line += ` [WOUNDED — stress ${p.stress}/3]`;
            if (p.lastAction) line += ` | Just did: ${p.lastAction.replace(/^[^:]+:\s*/, '').slice(0, 60)}`;
            return line;
          }).join('\n')}\nYou can cooperate with them, argue, protect them, or ask for their help. When you speak to them, ${ADDRESS_DIRECTIVE}. React to what they just did — support, question, or build on it.\n(In the events log, lines are labelled "Name: action". That label is bookkeeping, not how anyone speaks — never copy it as a form of address.)
A companion's high concept, trouble and aspects describe them — they are traits, never beings, creatures, places or names: never follow, warn or talk to "the ${ctx.partyMembers[0]!.trouble}"; talk to ${getFirstName(ctx.partyMembers[0]!.name)}.`
        : '',
      `\nAlways respond with valid JSON matching the requested format.`,
    ].filter(Boolean).join('\n');
  }

  deriveGoals(memories: CharacterMemory[]): string[] {
    if (memories.length === 0) return [];
    const goals: string[] = [];
    for (const m of memories) {
      if (m.type === 'discovery' && m.importance >= 0.4) {
        goals.push(`Investigate: ${m.content}`);
      } else if (m.type === 'social' && m.importance >= 0.5 && m.emotionalValence < -0.2) {
        goals.push(`Confront or resolve: ${m.content}`);
      } else if (m.type === 'outcome' && m.emotionalValence < -0.3 && m.importance >= 0.4) {
        goals.push(`Avoid repeating: ${m.content}`);
      }
      if (goals.length >= 2) break;
    }
    return goals;
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
