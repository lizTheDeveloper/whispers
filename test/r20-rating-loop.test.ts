// Round 20 in play: the content rating is the one switch every tone path
// reads. With the LLM and both judges mocked:
//  - mature: no judge call at all, no softener, the MATURE register in
//    every DM prompt, and a bleak ending goes out as written;
//  - adventure: the light judge (tier 'adventure') reads the prose, and the
//    ending is not forced warm — no warm-close instruction, no ending
//    softener, no closed-thread repair;
//  - storybook (the default for adults): the judge reads with the
//    storybook criteria; a host's change mid-game is persisted, written to
//    the replay log, broadcast with its system line, carried by the
//    checkpoint (and restored from it), and the NEXT DM prompt runs in the
//    new register.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';
import type { ToneJudge, ToneListJudge, ToneContext, ToneKind } from '../src/server/tone-gate.js';
import type { ContentRating } from '../src/shared/rating.js';

type Msg = { role: string; content: string };
const calls: Array<{ kind: 'llm' | 'prose'; text: string }> = [];

const ADA_RULING = 'Ada vaults the rail with terrifying speed as the storm eats the whole deck.';
const ROOK_RULING = 'Rook braces the door; the hinges groan.';
const BLEAK_EPILOGUE = 'Ada and Rook stood frozen as the storm sealed the exit. The question of the stolen ledger remains unanswered.';

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    const all = opts.messages.map(m => m.content).join('\n');
    calls.push({ kind: 'llm', text: all });
    if (all.includes('OPENING OF THE ADVENTURE')) return { arrival: '', narration: 'The airship deck creaks.', introductions: [], currentLocationName: 'The Deck' };
    if (all.includes('Choose your action now')) {
      return all.includes('You ARE Ada')
        ? { chosenAction: 'Vault the rail toward the rigging.', spokenWords: null, innerThought: 'Now or never.', whisperedInfluence: 'ignored', trustDelta: 0 }
        : { chosenAction: 'Brace the cabin door against the wind.', spokenWords: null, innerThought: 'Hold.', whisperedInfluence: 'ignored', trustDelta: 0 };
    }
    if (all.includes('Propose 2-4 actions')) return { actions: [{ description: 'Climb the rigging.', reasoning: 'r' }, { description: 'Hold the door.', reasoning: 'r' }] };
    if (all.includes('FATE resolution steps')) {
      const ada = all.includes('ACTING CHARACTER (narrate THEIR action, not another party member\'s): Ada');
      return { diceExpression: '4dF', difficulty: 2, skill: 'Athletics', outcome: 'success', narration: ada ? ADA_RULING : ROOK_RULING, stateChanges: [] };
    }
    if (all.includes('Pacing:')) return { narration: 'Wind howls across the deck.', currentLocationName: 'The Deck', activeNpcs: [], isSceneEnd: false };
    if (all.includes('You extract episodic memories')) return { memories: [] };
    if (all.includes('Summarize')) return { summary: 'The deck held.' };
    return 'ok';
  }),
  callProse: vi.fn(async (opts: { messages: Msg[] }) => {
    const all = opts.messages.map(m => m.content).join('\n');
    calls.push({ kind: 'prose', text: all });
    if (all.includes('closing reflection')) return 'SPOKEN: "We lost."\nTHOUGHT: I am stuck here with nothing but my fear.';
    if (all.includes('session epilogues')) return BLEAK_EPILOGUE;
    return 'ok';
  }),
}));

process.env.WHISPER_WINDOW_MS = '30';
process.env.PACE_MAX_MS = '0';

const judged: Array<{ kind: ToneKind; ctx?: ToneContext }> = [];
const judge: ToneJudge = async (_text, kind, ctx) => { judged.push({ kind, ctx }); return { flagged: false, phrases: [] }; };
const listed: Array<{ ctx?: ToneContext }> = [];
const listJudge: ToneListJudge = async (items, _kind, ctx) => { listed.push({ ctx }); return items.map(() => false); };

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r20-'));
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

const sheet = (name: string, age: number): CharacterDefinition => ({
  name, highConcept: `${name} the Bold`, trouble: 'Never backs down', aspects: ['Sky-born'], personality: 'Brave', backstory: '',
  skills: { Athletics: 3, Physique: 2 }, stunts: [], age, pronouns: 'she/her',
});

interface Played {
  campaignId: string;
  seen: any[];
  calls: typeof calls;
  judged: typeof judged;
  listed: typeof listed;
  /** calls.length (within this table's slice) when the rating was changed mid-game. */
  changedAt: number;
  loop: any;
}

async function play(opts: { rating?: ContentRating; changeTo?: ContentRating }): Promise<Played> {
  const room = await import('../src/server/room.js');
  const { makeCharacterLive } = await import('../src/server/character-live.js');
  const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
  const { setStoredContentRating } = await import('../src/server/content-rating.js');
  const { GameLoop } = await import('../src/server/game-loop.js');
  const seed = {
    premise: 'A storm-bound airship.',
    locations: [{ name: 'The Deck', description: 'Planks.', terrain: 'outdoor' }, { name: 'The Hold', description: 'Crates.', terrain: 'indoor' }],
    npcs: [{ name: 'Captain Vey', description: 'A scarred captain.', disposition: 'Grim', motivation: null, pronouns: 'she/her' }],
    plotHooks: [], items: [],
  };
  const created = room.createRoom(db, { name: 'R20 play', dmPreset: 'chronicler', systemId: 'fate-core' });
  const campaignId = created.campaignId;
  db.prepare('UPDATE campaigns SET setup_chat = ? WHERE id = ?').run(JSON.stringify([{ role: 'user', content: 'A sky-pirate heist for two adults.' }]), campaignId);
  setWorldSeed(db, campaignId, seed as any);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed as any);
  for (const [name, age] of [['Ada', 34], ['Rook', 41]] as const) {
    const session = room.createSession(db, { campaignId, joinCode: created.joinCode, playerName: name, isHost: name === 'Ada' });
    const pending = { id: `${name}-${campaignId}`, campaignId, joinCode: created.joinCode, sessionToken: session.token, playerName: name, definition: sheet(name, age), aiFeedback: 'ok' };
    room.savePendingCharacter(db, pending);
    makeCharacterLive(db, pending);
  }
  db.prepare("UPDATE characters SET state = json_set(state, '$.fatePoints', 1) WHERE campaign_id = ?").run(campaignId);
  if (opts.rating) setStoredContentRating(db, campaignId, opts.rating);

  const callsFrom = calls.length, judgedFrom = judged.length, listedFrom = listed.length;
  const seen: any[] = [];
  let changedAt = -1;
  const gameState = { campaignId, joinCode: created.joinCode, phase: 'playing' as const, currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null };
  let loop!: InstanceType<typeof GameLoop>;
  const rulings = () => seen.filter(m => m.type === 'resolution').length;
  const done = new Promise<void>((resolve) => {
    const on = (m: any) => {
      seen.push(m);
      if (m.type !== 'resolution') return;
      if (opts.changeTo && changedAt < 0) {
        changedAt = calls.length - callsFrom;
        loop.setContentRating(opts.changeTo);
      }
      if (rulings() >= 2) setImmediate(() => resolve());
    };
    loop = new GameLoop(db, campaignId, on, () => {}, gameState as any, (_id: string, m: any) => on(m));
  });
  const running = loop.start().catch(e => console.error('LOOP FAILED', e));
  await Promise.race([done, new Promise(r => setTimeout(r, 20_000))]);
  await new Promise(r => setTimeout(r, 200));
  await loop.endGame();
  await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
  return { campaignId, seen, calls: calls.slice(callsFrom), judged: judged.slice(judgedFrom), listed: listed.slice(listedFrom), changedAt, loop };
}

const dmPrompts = (p: Played) => p.calls.filter(c => c.text.includes('FATE resolution steps') || c.text.includes('Pacing:') || c.text.includes('OPENING OF THE ADVENTURE'));
const epilogueOf = (p: Played) => p.seen.find(m => m.type === 'narration' && m.isEpilogue)?.text as string | undefined;
const epiloguePrompt = (p: Played) => p.calls.find(c => c.text.includes('session epilogues'))!.text;

describe('round 20 in play: mature', () => {
  let p: Played;
  beforeAll(async () => { p = await play({ rating: 'mature' }); }, 40_000);

  it('the tone gate is skipped: no judge, no list judge', () => {
    expect(p.seen.filter(m => m.type === 'resolution').length).toBeGreaterThanOrEqual(2);
    expect(p.judged).toEqual([]);
    expect(p.listed).toEqual([]);
  });

  it('every DM prompt runs in the MATURE register, with the safety floor, never the gentle one', () => {
    const prompts = dmPrompts(p);
    expect(prompts.length).toBeGreaterThan(2);
    for (const c of prompts) {
      expect(c.text).toContain('CONTENT RATING: MATURE');
      expect(c.text).toContain('SAFETY FLOOR');
      expect(c.text).not.toContain('GENTLE PERIL register');
    }
  });

  it('the softener is off: the ruling goes out as written', () => {
    const ada = p.seen.find(m => m.type === 'resolution' && String(m.text).includes('Ada vaults'))!;
    expect(ada.text).toContain('terrifying speed');
    expect(ada.text).toContain('the storm eats the whole deck');
  });

  it('a bleak ending goes out as the story earned it', () => {
    expect(epilogueOf(p)).toBe(BLEAK_EPILOGUE);
    expect(epiloguePrompt(p)).not.toContain('This is a gentle table');
    expect(epiloguePrompt(p)).not.toContain('This is a storybook table');
  });
});

describe('round 20 in play: adventure', () => {
  let p: Played;
  beforeAll(async () => { p = await play({ rating: 'adventure' }); }, 40_000);

  it('the light judge reads the prose with the adventure criteria; no options or thoughts are judged', () => {
    expect(p.judged.length).toBeGreaterThan(0);
    expect(p.judged.every(j => j.ctx?.tier === 'adventure')).toBe(true);
    expect(p.judged.map(j => j.kind)).toContain('ruling');
    expect(p.listed).toEqual([]);
  });

  it('endings are not forced warm: no warm-close instruction, no ending softener, no closed-thread repair', () => {
    expect(epiloguePrompt(p)).not.toContain('This is a gentle table');
    expect(epiloguePrompt(p)).not.toContain('let the last note be hopeful');
    expect(epiloguePrompt(p)).toContain('The ending may be open, bittersweet or bleak');
    // At a gentle table this becomes "stood still … hid the exit for now", the open thread cut and a warm close added.
    expect(epilogueOf(p)).toBe(BLEAK_EPILOGUE);
    const reflection = p.seen.find(m => m.type === 'action-taken' && String(m.action).startsWith('[Final reflection]'));
    expect(reflection?.action).toContain('stuck here with nothing but my fear');
  });
});

describe('round 20 in play: storybook by default, changed mid-game to adventure', () => {
  let p: Played;
  beforeAll(async () => { p = await play({ changeTo: 'adventure' }); }, 40_000);

  it('an adult table with no gentle ask starts at storybook, judged by the storybook criteria', async () => {
    const first = p.judged.find(j => j.kind === 'opening' || j.kind === 'narration');
    expect(first?.ctx?.tier).toBe('storybook');
    expect(dmPrompts(p)[0]!.text).toContain('CONTENT RATING: STORYBOOK');
  });

  it('the change is broadcast with its system line, persisted, and in the replay log', async () => {
    const note = p.seen.find(m => m.type === 'content-rating');
    expect(note).toEqual({ type: 'content-rating', rating: 'adventure', explicit: true, childPresent: false, line: 'The host set the rating to Adventure.' });
    const { storedContentRating } = await import('../src/server/content-rating.js');
    expect(storedContentRating(db, p.campaignId)).toBe('adventure');
    const { loadReplayLog } = await import('../src/server/replay-log.js');
    expect(loadReplayLog(db, p.campaignId, null).entries).toContainEqual({ type: 'rating-note', text: 'The host set the rating to Adventure.' });
  });

  it('the next DM prompt uses the new register', () => {
    const after = p.calls.slice(p.changedAt).filter(c => c.text.includes('FATE resolution steps') || c.text.includes('Pacing:'));
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]!.text).toContain('CONTENT RATING: ADVENTURE');
    expect(after[0]!.text).not.toContain('CONTENT RATING: STORYBOOK');
    expect(after[0]!.text).toContain('The host set the rating to Adventure.');
  });

  it('the checkpoint carries it, and a resume restores it when the campaign row lost it', async () => {
    const { loadCheckpoint } = await import('../src/server/checkpoint.js');
    expect(loadCheckpoint(db, p.campaignId)?.state.contentRating).toBe('adventure');
    const { setStoredContentRating, storedContentRating } = await import('../src/server/content-rating.js');
    setStoredContentRating(db, p.campaignId, null);
    db.prepare("UPDATE campaigns SET phase = 'playing' WHERE id = ?").run(p.campaignId);
    const { GameLoop } = await import('../src/server/game-loop.js');
    const resumed = new GameLoop(db, p.campaignId, () => {}, () => {}, { campaignId: p.campaignId, joinCode: 'x', phase: 'playing', currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null } as any);
    const running = resumed.start().catch(() => {});
    await new Promise(r => setTimeout(r, 50));
    expect(storedContentRating(db, p.campaignId)).toBe('adventure');
    expect(resumed.rating()).toBe('adventure');
    await resumed.endGame();
    await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
  }, 20_000);
});
