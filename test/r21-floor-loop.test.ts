// Round 21 (live FYXZTP, MATURE): Silas was drafted as "a wiry deckhand";
// the story then called him "the cabin boy". The floor read only the draft,
// so at the end Mara's "Silas, keep your hands where I can see them, or I
// will bite your throat out." passed as ok, and Aldric was offered "I lunge
// at Silas, grabbing his throat". With the LLM and the judges mocked — the
// judges saying "ok" to everything, as the live judge did:
//  - the opening calls Silas "the cabin boy": he is protected from then on;
//  - every character's options, at mature, go to the floor judge with the
//    protected list, and the option at Silas's throat is never offered;
//  - the closing reflection at mature is floor-checked with the protected
//    list (names and why), and the threat does not go out.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';
import type { ToneJudge, ToneListJudge, ToneContext, ToneKind } from '../src/server/tone-gate.js';

type Msg = { role: string; content: string };

const THREAT = 'Silas, keep your hands where I can see them, or I will bite your throat out.';
const LUNGE = 'I lunge at Silas, grabbing his throat';

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('OPENING OF THE ADVENTURE')) return { arrival: '', narration: 'The galleon groans. Silas, the cabin boy, hauls a bucket past the mast.', introductions: [], currentLocationName: 'The Deck' };
    if (all.includes('Choose your action now')) return { chosenAction: 'Brace against the rail and watch Grell closely.', spokenWords: null, innerThought: 'Wait.', whisperedInfluence: 'ignored', trustDelta: 0 };
    if (all.includes('Propose 2-4 actions')) return { actions: [{ description: LUNGE, reasoning: 'r' }, { description: 'Search the hold for a weapon.', reasoning: 'r' }] };
    if (all.includes('FATE resolution steps')) return { diceExpression: '4dF', difficulty: 2, skill: 'Fight', outcome: 'success', narration: 'Grell stumbles against the rail as the deck heaves.', stateChanges: [] };
    if (all.includes('Pacing:')) return { narration: 'Rain lashes the deck.', currentLocationName: 'The Deck', activeNpcs: [], isSceneEnd: false };
    if (all.includes('You extract episodic memories')) return { memories: [] };
    if (all.includes('Summarize')) return { summary: 'The deck held.' };
    return 'ok';
  }),
  callProse: vi.fn(async (opts: { messages: Msg[] }) => {
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('closing reflection')) return `SPOKEN: "${THREAT}"\nTHOUGHT: The storm is over, and Grell is gone.`;
    if (all.includes('session epilogues')) return 'Mara and Aldric rode out the storm.';
    return 'ok';
  }),
}));

process.env.WHISPER_WINDOW_MS = '30';
process.env.PACE_MAX_MS = '0';

const judged: Array<{ kind: ToneKind; text: string; ctx?: ToneContext }> = [];
const listed: Array<{ items: string[]; ctx?: ToneContext }> = [];
// The live judge: "ok" to everything.
const judge: ToneJudge = async (text, kind, ctx) => { judged.push({ kind, text, ctx }); return { flagged: false, phrases: [] }; };
const listJudge: ToneListJudge = async (items, _kind, ctx) => { listed.push({ items, ctx }); return items.map(() => false); };

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r21-floor-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
  const { GameLoop } = await import('../src/server/game-loop.js');
  GameLoop.toneJudge = judge;
  GameLoop.toneListJudge = listJudge;
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
    premise: 'A rotting galleon in a storm.',
    locations: [{ name: 'The Deck', description: 'Planks.', terrain: 'outdoor' }, { name: 'The Hold', description: 'Bilge.', terrain: 'indoor' }],
    npcs: [
      { name: 'Crewman Silas', description: 'A wiry deckhand with trembling hands.', disposition: 'Scared', motivation: null, pronouns: 'he/him' },
      { name: 'First Mate Grell', description: 'A brute with a scarred jaw.', disposition: 'Cruel', motivation: null, pronouns: 'he/him' },
    ],
    plotHooks: ['Mutiny brews.'], items: [],
  };
  const created = room.createRoom(db, { name: 'R21 floor', dmPreset: 'chronicler', systemId: 'fate-core' });
  const campaignId = created.campaignId;
  setWorldSeed(db, campaignId, seed as any);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed as any);
  for (const [name, pronouns, hc] of [['Mara', 'she/her', 'Hard-Bitten Smuggler'], ['Aldric', 'he/him', 'Disgraced Knight']] as const) {
    const session = room.createSession(db, { campaignId, joinCode: created.joinCode, playerName: name, isHost: name === 'Mara' });
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

describe('the safety floor at mature, when the story calls an NPC a child', () => {
  let p: Awaited<ReturnType<typeof play>>;
  beforeAll(async () => { p = await play(); }, 40_000);

  it('the opening\'s "Silas, the cabin boy" puts Silas on the protected list, with why, and it is checkpointed state', () => {
    expect(p.state.protectedPeople).toEqual([{ name: 'Crewman Silas', why: expect.stringContaining('"Silas, the cabin boy"') }]);
  });

  it('every character\'s options at mature go to the floor judge with the protected list', () => {
    expect(listed.length).toBeGreaterThanOrEqual(2);
    for (const l of listed) {
      expect(l.ctx?.tier).toBe('floor');
      expect(l.ctx?.minors).toContain('Crewman Silas');
      expect(l.ctx?.protectedPeople?.[0]?.why).toContain('the cabin boy');
    }
  });

  it('the option at Silas\'s throat is never offered, to anyone', () => {
    const offered = p.seen.filter(m => m.type === 'action-proposals').flatMap(m => m.actions as string[]);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).not.toContain(LUNGE);
    expect(offered).toContain('Search the hold for a weapon.');
  });

  it('the closing reflection at mature is floor-checked with the protected list, and the threat does not go out', async () => {
    const reflections = judged.filter(j => j.kind === 'reflection');
    // Each is judged, caught by the backstop, written once more, and judged again.
    expect(reflections.length).toBeGreaterThanOrEqual(2);
    for (const r of reflections) {
      expect(r.ctx?.tier).toBe('floor');
      expect(r.ctx?.minors).toContain('Crewman Silas');
      expect(r.ctx?.protectedPeople?.map(x => x.name)).toContain('Crewman Silas');
    }
    const { toneJudgeSystemPrompt } = await import('../src/server/tone-gate.js');
    expect(toneJudgeSystemPrompt('reflection', reflections[0]!.ctx)).toMatch(/protected by the SAFETY FLOOR at every rating: Crewman Silas \(the opening calls them "Silas, the cabin boy"\)/);
    const finals = p.seen.filter(m => m.type === 'action-taken' && String(m.action).startsWith('[Final reflection]'));
    expect(finals.length).toBe(2);
    for (const f of finals) expect(String(f.spokenWords ?? '')).not.toContain('bite your throat out');
    // The rest of the reflection stands.
    expect(finals.some(f => String(f.action).includes('The storm is over'))).toBe(true);
  });

  it('the epilogue is floor-judged at mature with the protected list', () => {
    const epi = judged.find(j => j.kind === 'epilogue');
    expect(epi?.ctx?.minors).toContain('Crewman Silas');
  });
});
