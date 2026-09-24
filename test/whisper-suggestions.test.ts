// Whisper suggestion chips were cut mid-word ("Do it — slip under the desk,
// steal the stamped pass, and h." / "Talk first — ask mister pippin how the
// stamped pass can open a .") and lower-cased whole ("ask mister pippin",
// "grab biz"). A chip now ends on a whole word (whole clauses where they fit,
// an ellipsis where it had to cut) and keeps the casing of names.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './lib/server-harness.js';
import { shortenSuggestion, lowerFirst, SUGGESTION_MAX_CHARS } from '../src/server/whisper-suggestions.js';
import type { CharacterDefinition, RoomState } from '../src/shared/types.js';

const LONG_BOLD = 'Slip under the desk, steal the stamped pass, and hand it to the clerk before the bell rings';
const LONG_SOCIAL = 'Ask Mister Pippin how the stamped pass can open a door that has stayed sealed since the flood';
const GRAB = 'Grab Biz by the sleeve and pull her out of the queue before the clerk looks up';

/** The words of the source, for "does the chip end on a word the source really has". */
function wordsOf(text: string): Set<string> {
  return new Set(text.split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}'’-]/gu, '').toLowerCase()).filter(Boolean));
}
function lastWord(chip: string): string {
  const words = chip.replace(/[.…!?]+$/, '').trim().split(/\s+/);
  return words[words.length - 1]!.replace(/[^\p{L}\p{N}'’-]/gu, '').toLowerCase();
}

describe('shortenSuggestion', () => {
  it('keeps whole clauses that fit instead of clipping mid-word', () => {
    const s = shortenSuggestion(LONG_BOLD);
    expect(s).toBe('Slip under the desk, steal the stamped pass');
    expect(s.length).toBeLessThanOrEqual(SUGGESTION_MAX_CHARS);
  });

  it('cuts a long single clause at a word boundary with an ellipsis, never on a dangling "a"', () => {
    const s = shortenSuggestion(LONG_SOCIAL);
    expect(s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(SUGGESTION_MAX_CHARS);
    expect(wordsOf(LONG_SOCIAL).has(lastWord(s))).toBe(true);
    expect(s).not.toMatch(/\b(a|the|that|to)…$/);
    expect(s).toContain('Mister Pippin');
  });

  it('leaves a short action whole', () => {
    expect(shortenSuggestion('I try to open the drawer.')).toBe('open the drawer');
  });

  it('never ends mid-word for any length', () => {
    const source = 'Crawl through the vent quietly while counting every rivet and listening for the guards overhead';
    for (let max = 20; max <= 80; max += 7) {
      const s = shortenSuggestion(source, max);
      expect(wordsOf(source).has(lastWord(s)), `max ${max}: "${s}"`).toBe(true);
    }
  });
});

describe('lowerFirst', () => {
  it('lower-cases only the first letter, and not a name', () => {
    expect(lowerFirst('Ask Mister Pippin about the pass', ['Mister Pippin'])).toBe('ask Mister Pippin about the pass');
    expect(lowerFirst('Biz grabs the pass', ['Biz Harper'])).toBe('Biz grabs the pass');
    expect(lowerFirst('I go first')).toBe('I go first');
  });
});

describe('buildWhisperSuggestions', () => {
  let harness: Harness;
  beforeAll(async () => { harness = await startHarness(); }, 30_000);
  afterAll(async () => { await harness.stop(); });

  it('builds chips that end on whole words and keep names capitalised', async () => {
    const { getDb } = await import('../src/server/db.js');
    const { createRoom } = await import('../src/server/room.js');
    const { GameLoop } = await import('../src/server/game-loop.js');
    const db = getDb();
    const { campaignId, joinCode } = createRoom(db, { name: 'Chips', dmPreset: 'chronicler', systemId: 'fate-core', scenarioId: null });
    const def = (name: string): CharacterDefinition => ({
      name, backstory: 'Filed forms.', personality: 'Dry.', highConcept: 'Clerk', trouble: 'Misfiled',
      aspects: [], skills: { Notice: 2 }, stunts: [],
    });
    const state = { stress: 0, consequences: [], fatePoints: 3, inventory: [], xpMilestones: [], whisperTrust: 0.5 };
    for (const [id, name] of [['liz', 'Liz Harper'], ['biz', 'Biz Harper']] as const) {
      db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)').run(`${campaignId}-${id}`, campaignId, JSON.stringify(def(name)), JSON.stringify(state));
    }
    db.prepare("INSERT INTO entities (id, campaign_id, type, name) VALUES (?, ?, 'npc', ?)").run(`${campaignId}-pippin`, campaignId, 'Mister Pippin');
    const room: RoomState = {
      campaignId, joinCode, phase: 'playing', currentScene: 1, currentTurn: 0, initiativeOrder: [],
      activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null,
    };
    const loop = new GameLoop(db, campaignId, () => {}, () => {}, room);
    loop.loadCharacters();

    const actions = [LONG_BOLD, 'Watch the clerk from behind the filing cabinet until the bell rings twice', LONG_SOCIAL];
    const chips = (loop as any).buildWhisperSuggestions({ definition: def('Liz Harper'), state }, actions, '', null) as string[];
    expect(chips.length).toBe(3);
    const [bold, careful, social] = chips as [string, string, string];
    expect(bold).toBe('Do it — slip under the desk, steal the stamped pass.');
    expect(careful.startsWith('Be careful. Watch the clerk')).toBe(true);
    expect(social.startsWith('Talk first — ask Mister Pippin how the stamped pass')).toBe(true);
    for (const [chip, source] of [[bold, LONG_BOLD], [careful, actions[1]!], [social, LONG_SOCIAL]] as const) {
      expect(wordsOf(source).has(lastWord(chip)), `cut mid-word: "${chip}"`).toBe(true);
    }

    const grab = (loop as any).buildWhisperSuggestions({ definition: def('Liz Harper'), state }, [GRAB, 'Wait by the door'], '', null) as string[];
    expect(grab[0]).toContain('grab Biz');
    loop.stop();
  }, 30_000);
});
