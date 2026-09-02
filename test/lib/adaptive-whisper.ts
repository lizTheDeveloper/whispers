import type { ServerMessage } from '../../src/shared/protocol.js';

export type PlayerStyle = 'mentor' | 'chaos' | 'strategist' | 'antagonist';

export interface GameState {
  round: number;
  sceneCount: number;
  narrations: string[];
  actions: Array<{ char: string; action: string }>;
  locations: string[];
  characterNames: string[];
}

const STYLE_PROMPTS: Record<PlayerStyle, string> = {
  mentor: 'You are a helpful, experienced player guiding characters toward smart decisions. Suggest actions that use their strengths, protect allies, and advance the plot. Be warm but specific.',
  chaos: 'You are a mischievous player who creates drama. Suggest risky, surprising, or socially disruptive actions. Stir conflict between characters, push them toward dangerous choices, tempt them with shortcuts. Never boring, never safe.',
  strategist: 'You are a tactical player who plans ahead. Suggest actions that gather information, create advantages, and set up future moves. Think two steps ahead. Coordinate between characters for maximum effect.',
  antagonist: 'You are a player who tests characters by pushing their flaws. Reference their trouble aspects, tempt them with what they want, and suggest actions that create internal conflict. You want dramatic moments, not easy wins.',
};

export function generateWhisper(
  style: PlayerStyle,
  charName: string,
  state: GameState,
  lastNarration: string,
  lastAction?: string,
): string {
  const stylePrompt = STYLE_PROMPTS[style];
  const recentContext = state.narrations.slice(-2).join(' ');

  const templates = getTemplatesForStyle(style, charName, state, lastNarration, lastAction);
  const idx = (state.round + charName.length) % templates.length;
  return templates[idx]!;
}

function getTemplatesForStyle(
  style: PlayerStyle,
  charName: string,
  state: GameState,
  lastNarration: string,
  lastAction?: string,
): string[] {
  const firstName = charName.split(' ')[0]!;
  const otherChars = state.characterNames.filter(n => n !== charName);
  const otherFirst = otherChars[0]?.split(' ')[0] ?? 'your companion';
  const lastLoc = state.locations[state.locations.length - 1] ?? 'here';

  const narLower = lastNarration.toLowerCase();
  const hasNpc = /\b(said|spoke|asked|replied|warned|whispered|shouted|called)\b/.test(narLower);
  const hasDanger = /\b(danger|threat|attack|wound|collapse|dark|howl|scream|blood|poison)\b/.test(narLower);
  const hasClue = /\b(notice|found|discover|see|spot|reveal|clue|track|mark|sign)\b/.test(narLower);
  const hasSocial = /\b(trust|betray|lie|promise|ally|friend|enemy|faction)\b/.test(narLower);

  switch (style) {
    case 'mentor':
      return [
        hasClue ? `Follow up on what you just found — investigate it thoroughly before moving on.` : `Look around carefully. There are clues here you haven't found yet.`,
        hasNpc ? `Ask them directly what they know. Be honest — people respond to honesty.` : `Find someone who knows this place and talk to them.`,
        hasDanger ? `Don't rush in. Assess the danger first, then act from a position of strength.` : `Move forward but stay alert. Trust your instincts.`,
        `Work with ${otherFirst}. You're stronger together than apart.`,
        `Use your strongest skill here. This is exactly what you're good at.`,
        `Think about what you promised yourself. What matters most right now?`,
      ];

    case 'chaos':
      return [
        `Ignore the obvious path. Do something completely unexpected.`,
        hasNpc ? `Accuse them. Loudly. In front of everyone.` : `Start an argument about what to do next. Disagree with ${otherFirst}.`,
        hasDanger ? `Run toward the danger, not away. Fortune favors the bold.` : `Break something. See what happens.`,
        `Lie to ${otherFirst}. Tell them you saw something you didn't.`,
        `Touch the thing everyone said not to touch.`,
        hasSocial ? `Switch sides. Betray the faction you've been helping.` : `Challenge someone to prove their loyalty.`,
      ];

    case 'strategist':
      return [
        hasClue ? `Don't act on this yet. Gather one more piece of evidence first.` : `Search ${lastLoc} systematically — you're missing something.`,
        `Create a distraction so ${otherFirst} can investigate unobserved.`,
        `Map out who benefits from the current situation. Follow the motive.`,
        hasNpc ? `Don't reveal what you know yet. Ask questions that test what THEY know.` : `Find the person with the most to lose and watch them.`,
        `Set a trap. Leave something where the thief will come back for it.`,
        `Think about what happens at dawn. Work backward from the deadline.`,
      ];

    case 'antagonist':
      return [
        `You know what you want to do. Stop pretending to be the hero.`,
        `${otherFirst} is holding you back. You'd be faster alone.`,
        hasDanger ? `This is the moment you've been afraid of. Face it or prove the fear right.` : `Remember what you lost. This place reminds you of it.`,
        hasNpc ? `They're lying. You can feel it. Don't let them manipulate you.` : `Trust no one here. Everyone has an agenda, including ${otherFirst}.`,
        `Take the shortcut. Yes, it's risky. That's why it's worth it.`,
        hasSocial ? `Pick a side. Staying neutral is just cowardice with better PR.` : `Force a choice. Make them decide who they really are.`,
      ];
  }
}
