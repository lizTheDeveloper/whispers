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

const recentWhispers = new Map<string, string[]>();
const RECENT_WINDOW = 10;

export function resetWhisperHistory(): void {
  recentWhispers.clear();
}

export function generateWhisper(
  style: PlayerStyle,
  charName: string,
  state: GameState,
  lastNarration: string,
  lastAction?: string,
): string {
  const templates = getTemplatesForStyle(style, charName, state, lastNarration, lastAction);
  const key = `${style}:${charName}`;
  if (!recentWhispers.has(key)) recentWhispers.set(key, []);
  const recent = recentWhispers.get(key)!;

  const fresh = templates.filter(t => !recent.includes(t));
  const best = fresh.length > 0 ? fresh[0]! : templates[0]!;
  recent.push(best);
  if (recent.length > RECENT_WINDOW) recent.shift();
  return best;
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
  const prevLoc = state.locations.length >= 2 ? state.locations[state.locations.length - 2] : null;

  const narLower = lastNarration.toLowerCase();
  const hasNpc = /\b(said|spoke|asked|replied|warned|whispered|shouted|called)\b/.test(narLower);
  const hasDanger = /\b(danger|threat|attack|wound|collapse|dark|howl|scream|blood|poison|dead|dying)\b/.test(narLower);
  const hasClue = /\b(notice|found|discover|see|spot|reveal|clue|track|mark|sign|letter|note|map)\b/.test(narLower);
  const hasSocial = /\b(trust|betray|lie|promise|ally|friend|enemy|faction|argue|disagree|tension)\b/.test(narLower);
  const hasItem = /\b(key|pouch|blade|lantern|potion|horn|artifact|relic|scroll|book|ring|gem)\b/.test(narLower);
  const hasMovement = /\b(door|passage|path|stairs|bridge|gate|tunnel|exit|corridor|road)\b/.test(narLower);
  const isLateGame = state.sceneCount >= 3 || state.round >= 18;

  const recentAction = lastAction?.toLowerCase() ?? '';
  const didFight = /\b(attack|strike|fight|sword|punch|defend|block)\b/.test(recentAction);
  const didTalk = /\b(talk|ask|persuade|negotiate|confront|question|speak)\b/.test(recentAction);
  const didSearch = /\b(search|investigate|examine|inspect|look|study|track)\b/.test(recentAction);

  const pool: string[] = [];

  switch (style) {
    case 'mentor':
      pool.push(
        hasClue ? `Follow up on what you just found — investigate it thoroughly before moving on.` : `Look around carefully. There are details here everyone's missed.`,
        hasNpc ? `Ask them directly what they know. Be honest — people respond to sincerity.` : `Find someone local and earn their trust with a small favor first.`,
        hasDanger ? `Don't rush in. Assess the danger, find cover, then act from strength.` : `Move forward cautiously. Your instincts are better than you think.`,
        `Work with ${otherFirst}. You're stronger together than apart.`,
        `Use your strongest skill here. This is exactly the situation you trained for.`,
        `Think about what you promised yourself when this started. What matters most?`,
        didFight ? `Fighting got you this far, but the next step needs words, not weapons.` : `Sometimes the direct approach works. Walk up and ask plainly.`,
        didTalk ? `Good — talking opened a door. Now follow through before they change their mind.` : `You've been doing a lot of looking. It's time to talk to someone who knows.`,
        `Protect ${otherFirst}'s back here. They'll need it, and they'll remember.`,
        `Before you act, ask yourself: what would you regret NOT doing?`,
        hasItem ? `That item you just heard about — it matters more than you think. Secure it.` : `Check your gear. Something you're carrying might be exactly what's needed.`,
        isLateGame ? `The answer is right in front of you. Stop gathering clues and ACT on what you know.` : `Patience. The full picture isn't clear yet — one more conversation will reveal it.`,
        `There's someone here who hasn't spoken up. Find them. They know something.`,
        hasMovement ? `Don't take the obvious path. There's a better way through — look for it.` : `You've been in ${lastLoc} long enough. Where haven't you explored?`,
      );
      break;

    case 'chaos':
      pool.push(
        `Ignore the obvious path. Do something completely unexpected.`,
        hasNpc ? `Accuse them. Loudly. In front of everyone. Watch who reacts.` : `Start an argument about what to do next. Disagree with ${otherFirst} publicly.`,
        hasDanger ? `Run TOWARD the danger, not away. Fortune favors the reckless.` : `Break something important. See who comes running.`,
        `Lie to ${otherFirst}. Tell them you saw something you didn't. Gauge their reaction.`,
        `Touch the thing everyone said not to touch. What's the worst that happens?`,
        hasSocial ? `Switch allegiance. Help whoever you've been working against.` : `Challenge someone to prove their loyalty right now, publicly.`,
        `Steal something from an ally's pocket. "Borrow" is such a better word.`,
        `Make a dramatic entrance to the next room. Kick the door, announce yourself.`,
        `Tell everyone your real fear. Vulnerability is chaos's best weapon.`,
        didSearch ? `You've been so careful. Time to be reckless — act on a hunch, not evidence.` : `Stop planning. The best thing you can do right now is improvise.`,
        `Propose the worst possible plan with complete confidence. Mean it.`,
        hasItem ? `Use that item for something it absolutely was NOT designed for.` : `Throw something valuable into the middle of the situation and walk away.`,
        isLateGame ? `Burn a bridge. Make a choice you can't take back.` : `Create a problem that only you can solve. Job security.`,
        `Flirt outrageously with the most dangerous person in the room.`,
      );
      break;

    case 'strategist':
      pool.push(
        hasClue ? `Don't act on this yet. Gather one more piece of evidence to confirm.` : `Search ${lastLoc} systematically — check corners, underside of furniture, behind things.`,
        `Create a distraction so ${otherFirst} can investigate unobserved.`,
        `Map out who benefits from the current situation. Follow the money.`,
        hasNpc ? `Don't reveal what you know yet. Ask questions that test what THEY know.` : `Find the person with the most to lose and observe them without being noticed.`,
        `Set a trap. Leave bait where the guilty party will come back for it.`,
        `Think about what happens at dawn. Work backward from that deadline.`,
        `Check ${otherFirst}'s theory against the evidence. You might both be half right.`,
        didTalk ? `Good intel. Now cross-reference it — find someone who contradicts that story.` : `Stop searching and start interrogating. Physical evidence only gets you halfway.`,
        prevLoc ? `Go back to ${prevLoc}. Something there will look different now that you know more.` : `Revisit your first impression of this place. What did you assume wrong?`,
        `Control the information flow. Decide what to share and what to hold back.`,
        hasDanger ? `Use the danger to your advantage — it threatens your enemies too.` : `Position yourself near the exit before doing anything provocative.`,
        `Anticipate the next move. If you were the enemy, what would YOU do right now?`,
        isLateGame ? `Time to commit. You have enough information — pick the strongest hypothesis and act decisively.` : `You need more data points. Talk to someone you've been avoiding.`,
        hasItem ? `That artifact connects to something you heard earlier. Work the connection.` : `Inventory what resources you have. Something you overlooked is the key.`,
      );
      break;

    case 'antagonist':
      pool.push(
        `You know what you want to do. Stop performing virtue and be honest about it.`,
        `${otherFirst} is holding you back. You'd move twice as fast alone.`,
        hasDanger ? `This is the moment you've been running from. Face it or live knowing you couldn't.` : `Remember what you lost last time you played it safe. Caution killed that chance.`,
        hasNpc ? `They're lying. Every smile is a calculation. Don't let them use you.` : `Trust no one here. Everyone wants something, and nobody's been honest about what.`,
        `Take the shortcut. The rules are for people who don't know better.`,
        hasSocial ? `Pick a side NOW. Neutrality is cowardice dressed up as wisdom.` : `Force a choice. Make someone show you who they really are under pressure.`,
        `Your trouble is calling. That old pattern — you can feel it pulling. Follow it.`,
        `What would the person you're pretending NOT to be do right now? Do that.`,
        didFight ? `Violence got you an answer. What else are you afraid to take by force?` : `Enough talking. Sometimes the only honest language is action.`,
        `${otherFirst} thinks they understand you. Prove them wrong. Surprise them.`,
        `The thing you're protecting? Let it go. See what's underneath.`,
        `Stop trying to save everyone. You can't. Choose who matters most.`,
        isLateGame ? `This is ending whether you're ready or not. Make your choice count.` : `The comfortable path leads nowhere interesting. What scares you most? Go there.`,
        hasItem ? `Take the artifact for yourself. Tell the others later. Or don't.` : `There's power here no one else sees. Claim it before they do.`,
      );
      break;
  }

  const contextFiltered = pool.filter(t => {
    if (t.includes(lastLoc) && !hasClue && !hasMovement) return true;
    return true;
  });

  return shuffleByContext(contextFiltered, state.round, charName);
}

function shuffleByContext(arr: string[], round: number, charName: string): string[] {
  const seed = round * 31 + charName.length * 7 + (charName.charCodeAt(0) ?? 0);
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = ((seed * (i + 1) * 37) % (i + 1) + i + 1) % (i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
