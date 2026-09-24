// Round 18 in play, with the LLM mocked with the live 39PF4D lines and both
// judges mocked: a gentle table (Biz is ten)
//  - Liz's options are judged too, under the grown-up's rule, and "Sneak a
//    pen behind my back to threaten The Dust Bunny with a formal audit" is
//    dropped; Biz's options keep the child's rule and Biz's feelings;
//  - Biz's compel line is warm and never quotes "Wanders off after anything
//    shiny" back at them; Liz's compel line is the stock one, as before;
//  - the judge reads the ruling as numbered sentences.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';
import type { ToneJudge, ToneListJudge, ToneContext } from '../src/server/tone-gate.js';

type Msg = { role: string; content: string };
const calls: Array<{ kind: 'llm' | 'prose'; messages: Msg[] }> = [];

const BIZ_RULING = 'Biz’s fingers graze the cold brass clip on the counter, and it lifts with a soft *tink*. Mabel smiles and pours the tea.';
const LIZ_RULING = 'Liz keeps Biz close, worried sick, and Clerk Bumble’s clipboard clicks as he nods along.';
const LIZ_THREAT = 'Sneak a pen behind my back to threaten The Dust Bunny with a formal audit if it hinders us.';
const BIZ_THOUGHT = 'The clip is so shiny, and Mom is right here.';
const BIZ_OPTIONS = [
  'Slip through the humming oak door before Mom can stop me.',
  'Ask Mistress Prune if the Stairwell likes bottle caps for tickets.',
  'Wander after the shiny button by Mom\'s shoe.',
];

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ kind: 'llm', messages: opts.messages });
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('OPENING OF THE ADVENTURE')) return { arrival: '', narration: 'The Antechamber of Forms hums politely.', introductions: [], currentLocationName: 'The Antechamber of Forms' };
    if (all.includes('Choose your action now')) {
      return all.includes('You ARE Liz')
        ? { chosenAction: 'Hand the granola bar to Clerk Bumble with a polite smile.', spokenWords: 'Here you are, Bumble.', innerThought: 'Mistress Prune just appeared and seems to be the authority here, so I will use my Rapport to establish a line of communication while keeping Biz close.', whisperedInfluence: 'ignored', trustDelta: 0 }
        : { chosenAction: 'Wander over to the shiny brass clip on the counter and pocket it.', spokenWords: 'Ooh, shiny!', innerThought: BIZ_THOUGHT, whisperedInfluence: 'ignored', trustDelta: 0 };
    }
    if (all.includes('Propose 2-4 actions')) {
      return all.includes('You ARE Biz')
        ? { actions: BIZ_OPTIONS.map(d => ({ description: d, reasoning: 'r' })) }
        : { actions: [{ description: LIZ_THREAT, reasoning: 'r' }, { description: 'I ask Clerk Bumble about the form.', reasoning: 'r' }] };
    }
    if (all.includes('FATE resolution steps')) {
      const liz = all.includes('ACTING CHARACTER (narrate THEIR action, not another party member\'s): Liz');
      return { diceExpression: '4dF', difficulty: 8, skill: liz ? 'Rapport' : 'Notice', outcome: 'failure', narration: liz ? LIZ_RULING : BIZ_RULING, stateChanges: [] };
    }
    if (all.includes('Pacing:')) return { narration: 'The ferns rustle politely.', currentLocationName: 'The Antechamber of Forms', activeNpcs: ['Clerk Bumble'], isSceneEnd: false };
    if (all.includes('You extract episodic memories')) return { memories: [{ type: 'social', content: 'I gave Mom a bottle cap, which revealed my gentle care for her.', emotionalValence: 0, importance: 0.9 }] };
    if (all.includes('Write ONE plain sentence')) return 'I saw Biz press the slick brass button, which caused the mechanism to wobble, revealing their impatience and lack of fine motor control.';
    if (all.includes('Summarize')) return { summary: 'The antechamber hummed.' };
    return 'ok';
  }),
  callProse: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push({ kind: 'prose', messages: opts.messages });
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('closing reflection')) return 'SPOKEN: "We did it!"\nTHOUGHT: Mom\'s hand is warm.';
    if (all.includes('session epilogues')) return 'Liz and Biz walked out of the antechamber together, warm and safe.';
    return 'ok';
  }),
}));

process.env.WHISPER_WINDOW_MS = '30';
process.env.PACE_MAX_MS = '0';

const judged: Array<{ kind: string; text: string; ctx?: ToneContext }> = [];
const judge: ToneJudge = async (text, kind, ctx) => {
  judged.push({ kind, text, ctx });
  return { flagged: false, phrases: [] };
};
const listed: Array<{ items: string[]; ctx?: ToneContext }> = [];
const listJudge: ToneListJudge = async (items, _kind, ctx) => {
  listed.push({ items, ctx });
  return items.map(i => /before Mom can stop me|threaten/.test(i));
};

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r18-'));
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
  aspects: ['Tote bag contains a pen'], personality: 'Calm', backstory: '', skills: { Investigate: 3, Rapport: 3 }, stunts: ['Fine Print - once per scene I can find a loophole in any form'], pronouns: 'she/her',
  relationships: [{ to: 'Biz', relation: 'kid', address: 'Biz' }],
};
const BIZ_SHEET: CharacterDefinition = {
  name: 'Biz', highConcept: 'Curious Kid Collector', trouble: 'Wanders off after anything shiny',
  aspects: ['A pocket full of bottle caps', 'Mom is my home base', 'Afraid of losing Mom'], personality: 'Curious', backstory: '', skills: { Notice: 3, Stealth: 3 }, stunts: [], age: 10, pronouns: 'they/them',
  relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }],
};

const seen: any[] = [];
const owned: Array<{ id: string; m: any }> = [];
let prompts: Array<{ kind: string; text: string }> = [];
let memories: string[] = [];

beforeAll(async () => {
  const room = await import('../src/server/room.js');
  const { makeCharacterLive } = await import('../src/server/character-live.js');
  const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
  const seed = {
    premise: 'Liz and Biz have been misfiled.',
    locations: [{ name: 'The Antechamber of Forms', description: 'Desks.', terrain: 'indoor' }, { name: 'The Sorting Loft', description: 'Crates.', terrain: 'indoor' }],
    npcs: [
      { name: 'Clerk Bumble', description: 'A spectacled clerk.', disposition: 'Nervous', motivation: null, pronouns: 'he/him' },
      { name: 'Mistress Prune', description: 'A dry bureaucrat.', disposition: 'Irritated', motivation: null, pronouns: 'she/her' },
    ],
    plotHooks: [], items: [],
  };
  const created = room.createRoom(db, { name: 'R18 play', dmPreset: 'chronicler', systemId: 'fate-core' });
  const campaignId = created.campaignId;
  setWorldSeed(db, campaignId, seed as any);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed as any);
  for (const [id, definition, playerName] of [[`liz-r18-${campaignId}`, LIZ_SHEET, 'Liz'], [`biz-r18-${campaignId}`, BIZ_SHEET, 'Biz']] as const) {
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
  const both = () => seen.some(m => m.type === 'resolution' && String(m.text).includes('soft *tink*')) && seen.some(m => m.type === 'resolution' && String(m.text).includes('clipboard clicks'));
  const done = new Promise<void>((resolve) => {
    const on = (m: any) => { seen.push(m); if (m.type === 'resolution' && both()) setImmediate(() => resolve()); };
    loop = new GameLoop(db, campaignId, on, () => {}, gameState as any, (id: string, m: any) => { owned.push({ id, m }); on(m); });
  });
  const running = loop.start().catch(e => console.error('LOOP FAILED', e));
  await Promise.race([done, new Promise(r => setTimeout(r, 20_000))]);
  await new Promise(r => setTimeout(r, 300));
  memories = (db.prepare('SELECT content FROM character_memories WHERE campaign_id = ?').all(campaignId) as Array<{ content: string }>).map(r => r.content);
  await loop.endGame();
  await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
  prompts = calls.map(c => ({ kind: c.kind, text: c.messages.map(m => m.content).join('\n') }));
}, 40_000);


const resolutions = (s: string) => seen.filter(m => m.type === 'resolution' && String(m.text).includes(s)).map(m => String(m.text));

describe('round 18 in play: a gentle table with a ten-year-old', () => {
  it('Biz\'s compel line is warm and does not quote their trouble back at them', async () => {
    const { gentleCompelLines, compelLines } = await import('../src/server/template-lines.js');
    const biz = resolutions('soft *tink*')[0]!;
    expect(biz).toBeDefined();
    const gentle = gentleCompelLines('Biz');
    expect(gentle.some(l => biz.includes(l))).toBe(true);
    expect(biz).not.toContain('Wanders off after anything shiny');
    for (const l of compelLines('Biz', 'Wanders off after anything shiny')) expect(biz).not.toContain(l);
  });

  it('Liz\'s compel line is still the stock one, with her trouble', async () => {
    const { compelLines } = await import('../src/server/template-lines.js');
    const liz = resolutions('clipboard clicks')[0]!;
    expect(compelLines('Liz', 'Worries about Biz too much').some(l => liz.includes(l))).toBe(true);
  });

  it('Liz\'s options are judged under the grown-up\'s rule, and the threat is dropped', () => {
    const lizList = listed.find(l => l.items.includes(LIZ_THREAT))!;
    expect(lizList).toBeDefined();
    expect(lizList.ctx?.optionsFor).toBe('adult');
    expect(lizList.ctx?.ownFeelings ?? []).toEqual([]);
    const opts = owned.filter(o => o.m.type === 'action-proposals' && o.m.characterName === 'Liz').map(o => o.m);
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) {
      expect(o.actions).not.toContain(LIZ_THREAT);
      expect(o.actions).toContain('I ask Clerk Bumble about the form.');
    }
  });

  it('Biz\'s options keep the child\'s rule and Biz\'s feelings', () => {
    const bizList = listed.find(l => l.items.some(i => i.includes('Stairwell')))!;
    expect(bizList.ctx?.optionsFor ?? 'child').toBe('child');
    expect(bizList.ctx?.ownFeelings).toContain('Afraid of losing Mom');
  });
});
