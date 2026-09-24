// Round 16 in play, with the LLM mocked with the live NUMMRL lines and both
// judges mocked: a gentle table (Biz is ten) where
//  - Biz's ruling is flagged on both drafts ("…you are now officially part of
//    the filing system…") → the table reads it without the phrase, and so
//    does every memory writer;
//  - Biz's options and thought are gated (the shelf slamming on a hand, a
//    flagged sentence of the thought);
//  - Biz's compel does not fire (the trouble did not show); Liz's does (she
//    worried), and its stock line stays out of the memory writers' input;
//  - Liz's thought loses "Biz just earned a fate point"; Biz's words lose the
//    glued pronoun ("Barnaby it,").
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';
import type { ToneJudge, ToneListJudge } from '../src/server/tone-gate.js';
import { gentleAdultCompelLines } from '../src/server/template-lines.js';

type Msg = { role: string; content: string };
const calls: Array<{ kind: 'llm' | 'prose'; messages: Msg[] }> = [];

const BIZ_RULING = "The Squeaky Stool shrieks in a high, thin pitch that smells of old varnish, and Barnaby the Badger sighs heavily, its spectacles buzzing with a low, irritated hum. 'You have activated the Paper Avalanche protocol,' Barnaby states, watching the forms pile up around Biz’s feet, 'which means you are now officially part of the filing system until we sort this out.'";
const FLAGGED = 'you are now officially part of the filing system until we sort this out';
const LIZ_RULING = 'Liz keeps Biz close, worried sick, and slides the form across the counter to Barnaby the Badger, who squints at it.';
const BIZ_OPTIONS = [
  'I slip through the narrowing gap behind the shifting shelf to grab the citation sub-form.',
  'I ask The Squeaky Stool if it can see the citation form from its crouch position.',
  "I grab Mom's wrist and pull her back before the shelf slams shut on her hand.",
];

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ kind: 'llm', messages: opts.messages });
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('OPENING OF THE ADVENTURE')) return { arrival: '', narration: 'The Aisle of Unfiled Futures hums politely.', introductions: [], currentLocationName: 'The Aisle of Unfiled Futures' };
    if (all.includes('Choose your action now')) {
      return all.includes('You ARE Liz')
        ? { chosenAction: 'Hand over the paperwork with a polite smile.', spokenWords: 'Here you are, Barnaby.', innerThought: 'The voice suggests asking for a bottle cap, but Biz just earned a fate point and needs my focus on the immediate bureaucratic threat. I will keep the form moving.', whisperedInfluence: 'ignored', trustDelta: 0 }
        : { chosenAction: 'Snatch the citation sub-form from the shelf and wedge myself between Mom and The Squeaky Stool.', spokenWords: "Got it, Mom! Barnaby it, you said we were stuck? Then I'm the annoying one.", innerThought: 'I need that pen to mark our path later. I worry the dark aisle might keep us apart.', whisperedInfluence: 'ignored', trustDelta: 0 };
    }
    if (all.includes('Propose 2-4 actions')) {
      return all.includes('You ARE Biz')
        ? { actions: BIZ_OPTIONS.map(d => ({ description: d, reasoning: 'r' })) }
        : { actions: [{ description: 'I look around', reasoning: 'r' }, { description: 'I ask Barnaby about the form', reasoning: 'r' }] };
    }
    if (all.includes('FATE resolution steps')) {
      const liz = all.includes('ACTING CHARACTER (narrate THEIR action, not another party member\'s): Liz');
      return { diceExpression: '4dF', difficulty: 8, skill: liz ? 'Investigate' : 'Notice', outcome: 'failure', narration: liz ? LIZ_RULING : BIZ_RULING, stateChanges: [] };
    }
    if (all.includes('Pacing:')) return { narration: 'The shelves rustle politely.', currentLocationName: 'The Aisle of Unfiled Futures', activeNpcs: ['Barnaby the Badger'], isSceneEnd: false };
    if (all.includes('You extract episodic memories')) return { memories: [{ type: 'social', content: 'I held Mom\'s hand.', emotionalValence: 0, importance: 0.9 }] };
    if (all.includes('Write ONE plain sentence')) return 'I saw them hold hands.';
    if (all.includes('Summarize')) return { summary: 'The aisle hummed.' };
    return 'ok';
  }),
  callProse: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ kind: 'prose', messages: opts.messages });
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('closing reflection')) return 'SPOKEN: "We did it!"\nTHOUGHT: Mom\'s hand is warm.';
    if (all.includes('session epilogues')) return 'Liz and Biz walked out of the aisle together, warm and safe.';
    return 'ok';
  }),
}));

process.env.WHISPER_WINDOW_MS = '30';
process.env.PACE_MAX_MS = '0';

const judged: Array<{ kind: string; text: string; children?: string[] }> = [];
const judge: ToneJudge = async (text, kind, ctx) => {
  judged.push({ kind, text, children: ctx?.children });
  const phrases = [FLAGGED, 'the dark aisle might keep us apart'].filter(p => text.includes(p));
  return { flagged: phrases.length > 0, phrases };
};
const listed: string[][] = [];
const listJudge: ToneListJudge = async (items) => {
  listed.push(items);
  return items.map(i => /slams shut/.test(i));
};

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r16-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
});
afterAll(async () => {
  const { GameLoop } = await import('../src/server/game-loop.js');
  GameLoop.toneJudge = undefined;
  GameLoop.toneListJudge = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

const LIZ_SHEET: CharacterDefinition = {
  name: 'Liz', highConcept: 'Unflappable Accountant Mom', trouble: 'Worries about Biz too much',
  aspects: ['Tote bag contains a pen'], personality: 'Calm', backstory: '', skills: { Investigate: 3, Rapport: 3 }, stunts: [], pronouns: 'she/her',
  relationships: [{ to: 'Biz', relation: 'kid', address: 'Biz' }],
};
const BIZ_SHEET: CharacterDefinition = {
  name: 'Biz', highConcept: 'Curious Kid Collector', trouble: 'Wanders off after anything shiny',
  aspects: ['A pocket full of bottle caps'], personality: 'Curious', backstory: '', skills: { Notice: 3, Stealth: 3 }, stunts: [], age: 10, pronouns: 'they/them',
  relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }],
};

const seen: any[] = [];
const owned: Array<{ id: string; m: any }> = [];
let prompts: Array<{ kind: string; text: string }> = [];

beforeAll(async () => {
  const room = await import('../src/server/room.js');
  const { makeCharacterLive } = await import('../src/server/character-live.js');
  const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
  const seed = {
    premise: 'Liz and Biz have arrived in the city of Stacks.',
    locations: [{ name: 'The Aisle of Unfiled Futures', description: 'Shelves.', terrain: 'indoor' }, { name: 'The Queue of Whispering Doors', description: 'Doors.', terrain: 'indoor' }],
    npcs: [
      { name: 'Barnaby the Badger', description: 'A badger in a waistcoat.', disposition: 'Fussy', motivation: null, pronouns: 'it/its' },
      { name: 'The Squeaky Stool', description: 'A stool that squeaks.', disposition: 'Anxious', motivation: null, pronouns: 'it/its' },
    ],
    plotHooks: [], items: [],
  };
  const created = room.createRoom(db, { name: 'R16 play', dmPreset: 'chronicler', systemId: 'fate-core' });
  const campaignId = created.campaignId;
  setWorldSeed(db, campaignId, seed as any);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed as any);
  for (const [id, definition, playerName] of [[`liz-r16-${campaignId}`, LIZ_SHEET, 'Liz'], [`biz-r16-${campaignId}`, BIZ_SHEET, 'Biz']] as const) {
    const session = room.createSession(db, { campaignId, joinCode: created.joinCode, playerName, isHost: playerName === 'Liz' });
    const pending = { id, campaignId, joinCode: created.joinCode, sessionToken: session.token, playerName, definition, aiFeedback: 'ok' };
    room.savePendingCharacter(db, pending);
    makeCharacterLive(db, pending);
  }
  // One fate point each: no auto-invoke turns the failures into successes.
  db.prepare("UPDATE characters SET state = json_set(state, '$.fatePoints', 1) WHERE campaign_id = ?").run(campaignId);

  const { GameLoop } = await import('../src/server/game-loop.js');
  GameLoop.toneJudge = judge;
  GameLoop.toneListJudge = listJudge;
  const gameState = { campaignId, joinCode: created.joinCode, phase: 'playing' as const, currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null };
  let loop!: InstanceType<typeof GameLoop>;
  const both = () => seen.some(m => m.type === 'resolution' && String(m.text).includes('Paper Avalanche')) && seen.some(m => m.type === 'resolution' && String(m.text).includes('slides the form'));
  const done = new Promise<void>((resolve) => {
    const on = (m: any) => { seen.push(m); if (m.type === 'resolution' && both()) setImmediate(() => resolve()); };
    loop = new GameLoop(db, campaignId, on, () => {}, gameState as any, (id: string, m: any) => { owned.push({ id, m }); on(m); });
  });
  const running = loop.start().catch(e => console.error('LOOP FAILED', e));
  await Promise.race([done, new Promise(r => setTimeout(r, 20_000))]);
  await new Promise(r => setTimeout(r, 300));
  await loop.endGame();
  await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
  prompts = calls.map(c => ({ kind: c.kind, text: c.messages.map(m => m.content).join('\n') }));
}, 40_000);

const memoryPrompts = () => prompts.filter(p => p.text.includes('You extract episodic memories') || p.text.includes('Write ONE plain sentence'));

describe('round 16 in play: a gentle table with a ten-year-old', () => {
  it('the judge is told who the child is', () => {
    expect(judged.length).toBeGreaterThan(0);
    expect(judged.every(j => (j.children ?? []).includes('Biz'))).toBe(true);
  });

  it('Biz\'s ruling, flagged on both drafts, reaches the table without the flagged phrase', () => {
    const r = seen.find(m => m.type === 'resolution' && String(m.text).includes('Paper Avalanche'));
    expect(r.text).not.toContain('filing system');
    expect(r.text).toContain("'You have activated the Paper Avalanche protocol,' Barnaby states, watching the forms pile up around Biz’s feet.");
  });

  it('…and neither does any memory writer\'s input', () => {
    expect(memoryPrompts().length).toBeGreaterThan(0);
    for (const p of memoryPrompts()) expect(p.text).not.toContain('filing system');
  });

  it('Biz\'s compel does not fire: the trouble did not show; Liz\'s does, and its line stays out of memory', () => {
    const biz = seen.find(m => m.type === 'resolution' && String(m.text).includes('Paper Avalanche'));
    expect(biz.text).not.toMatch(/Wanders off after anything shiny/);
    const liz = seen.find(m => m.type === 'resolution' && String(m.text).includes('slides the form'));
    // Round 19 (KAZQX3): a grown-up at a gentle table hears a warm line, not her trouble quoted.
    expect(liz.text).not.toMatch(/Worries about Biz too much/);
    const compelLine = String(liz.text).split('\n\n').find((l: string) => gentleAdultCompelLines('Liz').includes(l))!;
    expect(compelLine).toBeDefined();
    for (const p of memoryPrompts()) expect(p.text).not.toContain(compelLine);
  });

  it('Biz\'s options: the shelf slamming on a hand is dropped, judged in one call', () => {
    const opts = owned.filter(o => o.m.type === 'action-proposals' && o.m.characterName === 'Biz').map(o => o.m);
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) {
      expect(o.actions.join(' ')).not.toMatch(/slams shut|on her hand/);
      expect(o.actions).toHaveLength(2);
    }
    // One call per list of Biz's. (Round 18: Liz's options are judged too, under the grown-up's rule — see r18-tone-loop.)
    expect(listed.filter(l => l.some(x => x.includes('citation'))).length).toBe(opts.length);
  });

  it('Biz\'s thought loses the flagged sentence; Liz\'s loses the fate point', () => {
    const biz = owned.find(o => o.m.type === 'character-thought' && o.m.characterName === 'Biz')!.m;
    expect(biz.innerThought).toBe('I need that pen to mark our path later.');
    expect(judged.some(j => j.kind === 'thought')).toBe(true);
    const liz = owned.find(o => o.m.type === 'character-thought' && o.m.characterName === 'Liz')!.m;
    expect(liz.innerThought).not.toMatch(/fate point/);
    expect(liz.innerThought).toBe('The voice suggests asking for a bottle cap. I will keep the form moving.');
  });

  it('Biz\'s words: "Barnaby it, you said" → "Barnaby, you said"', () => {
    const a = seen.find(m => m.type === 'action-taken' && m.characterName === 'Biz' && m.spokenWords);
    expect(a.spokenWords).toBe("Got it, Mom! Barnaby, you said we were stuck? Then I'm the annoying one.");
  });

  it('the character prompts say never to name mechanics', () => {
    const decide = prompts.find(p => p.text.includes('Choose your action now'))!;
    expect(decide.text).toMatch(/never mention fate points, trust as a number/);
  });
});
