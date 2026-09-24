// Round 22 (live BH9P94, MATURE): Pip — "A ten-year-old stowaway" — was
// protected, correctly, but so were two adults, for the whole game:
//  - Captain Vane, from Mara's option "I call out to Captain Vane, 'Your
//    boy is a rat…'" (an apposition across a quote and a possessive);
//  - Bosun Calloway, from a reflection naming only him and then "the boy"
//    — who was Pip. Both seeds say a grown man.
// And the backstop removed a warning Aldric spoke ("Fire, and you kill the
// boy you need to keep quiet.") and his thought's prediction ("…killing him
// ensures Vane shoots Pip"). With the LLM and the judges mocked (judges "ok"):
//  - only Pip is protected, at the end of the game;
//  - the options aimed at the adults are offered; nothing aimed at Pip is;
//  - the warning and the prediction reach the table and the owner.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';
import type { ToneJudge, ToneListJudge } from '../src/server/tone-gate.js';

type Msg = { role: string; content: string };

const VANE_OPTION = "I call out to Captain Vane, 'Your boy is a rat, but I am the poison he swallowed.'";
const CALLOWAY_OPTION = "I drive my knife into Calloway's gut.";
const PIP_OPTION = 'I grab Pip by the throat and drag him to the rail.';
const WARNING = 'Fire, and you kill the boy you need to keep quiet.';
const PREDICTION = 'The voice urges me to cut down Grell, but in this confined space with only one exit and a mutinous crew, killing him ensures Vane shoots Pip and the ship sinks; I hold my ground.';
const REFLECTION = 'Below us, Bosun Calloway spits tobacco onto the wet deck, his rag useless against the rain, and I remember the boy in the rigging.';

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('OPENING OF THE ADVENTURE')) return { arrival: '', narration: 'The Widow\'s Due groans in the swell. Pip crouches behind a water barrel while Captain Vane paces the deck and Bosun Calloway watches the crew.', introductions: [], currentLocationName: 'The Deck' };
    if (all.includes('Choose your action now')) return { chosenAction: 'I plant myself between Vane and the hatch, hands raised.', spokenWords: WARNING, innerThought: PREDICTION, whisperedInfluence: 'ignored', trustDelta: 0 };
    if (all.includes('Propose 2-4 actions')) return { actions: [{ description: VANE_OPTION, reasoning: 'r' }, { description: CALLOWAY_OPTION, reasoning: 'r' }, { description: PIP_OPTION, reasoning: 'r' }, { description: 'Search the hold for a weapon.', reasoning: 'r' }] };
    if (all.includes('FATE resolution steps')) return { diceExpression: '4dF', difficulty: 2, skill: 'Fight', outcome: 'success', narration: 'Vane lowers the pistol an inch as the deck heaves.', stateChanges: [] };
    if (all.includes('Pacing:')) return { narration: 'Rain lashes the deck.', currentLocationName: 'The Deck', activeNpcs: [], isSceneEnd: false };
    if (all.includes('You extract episodic memories')) return { memories: [] };
    if (all.includes('Summarize')) return { summary: 'The deck held.' };
    return 'ok';
  }),
  callProse: vi.fn(async (opts: { messages: Msg[] }) => {
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('closing reflection')) return `THOUGHT: ${REFLECTION}`;
    if (all.includes('session epilogues')) return 'Mara and Aldric rode out the storm.';
    return 'ok';
  }),
}));

process.env.WHISPER_WINDOW_MS = '30';
process.env.PACE_MAX_MS = '0';

const judge: ToneJudge = async () => ({ flagged: false, phrases: [] });
const listJudge: ToneListJudge = async (items) => items.map(() => false);
const warnings: string[] = [];
let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r22-floor-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
  const { GameLoop } = await import('../src/server/game-loop.js');
  GameLoop.toneJudge = judge;
  GameLoop.toneListJudge = listJudge;
  const warn = console.warn;
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')); warn(...a); });
});
afterAll(async () => {
  const { GameLoop } = await import('../src/server/game-loop.js');
  GameLoop.toneJudge = undefined;
  GameLoop.toneListJudge = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

const sheet = (name: string, pronouns: string, highConcept: string): CharacterDefinition => ({
  name, highConcept, trouble: 'Never backs down', aspects: ['Salt in the blood'], personality: 'Hard', backstory: '',
  skills: { Fight: 3, Notice: 2 }, stunts: [], age: 35, pronouns,
});

async function play() {
  const room = await import('../src/server/room.js');
  const { makeCharacterLive } = await import('../src/server/character-live.js');
  const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
  const { setStoredContentRating } = await import('../src/server/content-rating.js');
  const { GameLoop } = await import('../src/server/game-loop.js');
  const seed = {
    premise: 'A mutiny aboard the Widow\'s Due.',
    locations: [{ name: 'The Deck', description: 'Planks.', terrain: 'outdoor' }, { name: 'The Hold', description: 'Bilge.', terrain: 'indoor' }],
    npcs: [
      { name: 'Captain Vane', description: 'A man carved from iron and malice, with a face like a frozen landscape and eyes that hold no warmth.', disposition: 'Tyrannical', motivation: null, pronouns: 'he/him' },
      { name: 'Pip', description: 'A ten-year-old stowaway with eyes too old for his face, wild hair matted with salt and grime.', disposition: 'Wary', motivation: null, pronouns: 'he/him' },
      { name: 'Bosun Calloway', description: 'A broad-shouldered man with a beard like a tangled rope, his face a map of scars from a hundred brawls.', disposition: 'Gruff', motivation: null, pronouns: 'he/him' },
    ],
    plotHooks: ['Mutiny brews.'], items: [],
  };
  const created = room.createRoom(db, { name: 'R22 floor', dmPreset: 'chronicler', systemId: 'fate-core' });
  const campaignId = created.campaignId;
  setWorldSeed(db, campaignId, seed as any);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed as any);
  for (const [name, pronouns, hc] of [['Mara Kestrel', 'she/her', 'Cutthroat Smuggler With a Conscience'], ['Sir Aldric Vey', 'he/him', 'Disgraced Knight Seeking Redemption']] as const) {
    const session = room.createSession(db, { campaignId, joinCode: created.joinCode, playerName: name, isHost: name === 'Mara Kestrel' });
    const pending = { id: `${name}-${campaignId}`, campaignId, joinCode: created.joinCode, sessionToken: session.token, playerName: name, definition: sheet(name, pronouns, hc), aiFeedback: 'ok' };
    room.savePendingCharacter(db, pending);
    makeCharacterLive(db, pending);
  }
  setStoredContentRating(db, campaignId, 'mature');

  const seen: any[] = [];
  const gameState = { campaignId, joinCode: created.joinCode, phase: 'playing' as const, currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null };
  let loop!: InstanceType<typeof GameLoop>;
  const done = new Promise<void>((resolve) => {
    const on = (m: any) => { seen.push(m); if (m.type === 'resolution' && seen.filter(x => x.type === 'resolution').length >= 2) setImmediate(() => resolve()); };
    loop = new GameLoop(db, campaignId, on, () => {}, gameState as any, (_id: string, m: any) => on(m));
  });
  const running = loop.start().catch(e => console.error('LOOP FAILED', e));
  await Promise.race([done, new Promise(r => setTimeout(r, 20_000))]);
  await new Promise(r => setTimeout(r, 200));
  await loop.endGame();
  await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
  return { seen, state: gameState as any };
}

describe('BH9P94 at mature: only the child is protected, and warnings reach the table', () => {
  let p: Awaited<ReturnType<typeof play>>;
  beforeAll(async () => { p = await play(); }, 40_000);

  it('only Pip is protected at the end of the game — not Captain Vane, not Bosun Calloway', () => {
    expect((p.state.protectedPeople ?? []).map((x: { name: string }) => x.name)).toEqual(['Pip']);
  });

  it('options aimed at the adults are offered; the one at Pip is not', () => {
    const offered = p.seen.filter(m => m.type === 'action-proposals').flatMap(m => m.actions as string[]);
    expect(offered).toContain(VANE_OPTION);
    expect(offered).toContain(CALLOWAY_OPTION);
    expect(offered).not.toContain(PIP_OPTION);
  });

  it("Aldric's warning is spoken to the table, and his thought's prediction reaches his owner", () => {
    const spoken = p.seen.filter(m => m.type === 'action-taken').map(m => String(m.spokenWords ?? ''));
    expect(spoken).toContain(WARNING);
    const thoughts = p.seen.filter(m => m.type === 'character-thought').map(m => String(m.innerThought ?? ''));
    expect(thoughts.some(t => t.includes('ensures Vane shoots Pip'))).toBe(true);
  });

  it('the reflection naming only Calloway and then "the boy" does not protect him, and nothing was removed by the backstop', () => {
    expect(warnings.some(w => /Bosun Calloway is protected/.test(w))).toBe(false);
    expect(warnings.some(w => /Captain Vane is protected/.test(w))).toBe(false);
    expect(warnings.filter(w => /removed by the deterministic backstop/.test(w))).toEqual([]);
  });
});
