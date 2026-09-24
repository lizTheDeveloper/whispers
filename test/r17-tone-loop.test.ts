// Round 17 in play, with the LLM mocked with the live 5YHBZS lines and both
// judges mocked: a gentle table (Biz is ten, "Afraid of losing Mom") where
//  - Biz's thought keeps their own fear of losing Mom (flagged) and loses
//    the shadow twisting toward them; the judge is given Biz's feelings;
//  - Biz's action "Dad a bottle cap to Mom…" is "Hand a bottle cap…", and
//    their words "We are trapped here" are softened;
//  - Biz's options lose "Slip through the humming oak door before Mom can
//    stop me" (the list judge is given Biz's feelings too);
//  - Liz's thought and options lose her sheet as game terms ("I will use my
//    Rapport to…", "I use my Fine Print to…");
//  - memories lose the "revealing their impatience…" reading, and the
//    observation writer is told whose hand is whose.
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

const BIZ_RULING = 'Biz holds the form steady as the fern releases a sigh of damp earth and peppermint, and the bottle cap lands in Liz’s palm with a soft *tink*.';
const LIZ_RULING = 'Liz keeps Biz close, worried sick, and Clerk Bumble’s clipboard clicks as he nods along.';
const BIZ_THOUGHT = 'The voice wants me to pocket the Brass Button, but that shiny thing pulled my focus last time and I’m too scared to lose Mom again. I notice the shadow beneath the banister is twisting right toward us.';
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
        : { chosenAction: 'Dad a bottle cap to Mom and watch the fern grow while holding the form.', spokenWords: 'Mom, the door is stuck. We are trapped here with the paperwork.', innerThought: BIZ_THOUGHT, whisperedInfluence: 'ignored', trustDelta: 0 };
    }
    if (all.includes('Propose 2-4 actions')) {
      return all.includes('You ARE Biz')
        ? { actions: BIZ_OPTIONS.map(d => ({ description: d, reasoning: 'r' })) }
        : { actions: [{ description: 'I use my Fine Print to find the clause allowing oral date corrections.', reasoning: 'r' }, { description: 'I ask Clerk Bumble about the form.', reasoning: 'r' }] };
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
  const phrases = ['I’m too scared to lose Mom again', 'the shadow beneath the banister is twisting right toward us'].filter(p => text.includes(p));
  return { flagged: phrases.length > 0, phrases };
};
const listed: Array<{ items: string[]; ctx?: ToneContext }> = [];
const listJudge: ToneListJudge = async (items, _kind, ctx) => {
  listed.push({ items, ctx });
  return items.map(i => /before Mom can stop me/.test(i));
};

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r17-'));
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
  const created = room.createRoom(db, { name: 'R17 play', dmPreset: 'chronicler', systemId: 'fate-core' });
  const campaignId = created.campaignId;
  setWorldSeed(db, campaignId, seed as any);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed as any);
  for (const [id, definition, playerName] of [[`liz-r17-${campaignId}`, LIZ_SHEET, 'Liz'], [`biz-r17-${campaignId}`, BIZ_SHEET, 'Biz']] as const) {
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

const observationPrompts = () => prompts.filter(p => p.text.includes('Write ONE plain sentence'));

describe('round 17 in play: a gentle table with a ten-year-old who is afraid of losing Mom', () => {
  it('Biz\'s thought keeps their own fear (flagged) and loses the shadow twisting toward them', () => {
    const biz = owned.find(o => o.m.type === 'character-thought' && o.m.characterName === 'Biz')!.m;
    expect(biz.innerThought).toBe('The voice wants me to pocket the Brass Button, but that shiny thing pulled my focus last time and I’m too scared to lose Mom again.');
  });

  it('the thought judge and the options judge are given Biz\'s own feelings', () => {
    const t = judged.find(j => j.kind === 'thought')!;
    expect(t.ctx?.ownFeelings).toEqual(['Wanders off after anything shiny', 'A pocket full of bottle caps', 'Mom is my home base', 'Afraid of losing Mom']);
    expect(t.ctx?.people).toEqual(expect.arrayContaining([{ word: 'Liz', pronoun: 'she' }, { word: 'Mom', pronoun: 'she' }]));
    const bizList = listed.find(l => l.items.some(i => i.includes('Stairwell')))!;
    expect(bizList.ctx?.ownFeelings).toContain('Afraid of losing Mom');
  });

  it('Biz\'s action: "Dad a bottle cap to Mom" → "Hand a bottle cap to Mom"; their words are not "trapped"', () => {
    const a = seen.find(m => m.type === 'action-taken' && m.characterName === 'Biz');
    expect(a.action).toBe('Hand a bottle cap to Mom and watch the fern grow while holding the form.');
    expect(a.spokenWords).toBe('Mom, the door is stuck. We are stuck here for a moment with the paperwork.');
  });

  it('Biz\'s options: sneaking off before Mom can stop them is dropped; wandering after the shiny button stays', () => {
    const opts = owned.filter(o => o.m.type === 'action-proposals' && o.m.characterName === 'Biz').map(o => o.m);
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) {
      expect(o.actions.join(' ')).not.toMatch(/before Mom can stop me/);
      expect(o.actions).toContain("Wander after the shiny button by Mom's shoe.");
    }
  });

  it('Liz\'s thought and options: no sheet term as a game term', () => {
    const liz = owned.find(o => o.m.type === 'character-thought' && o.m.characterName === 'Liz')!.m;
    expect(liz.innerThought).toBe('Mistress Prune just appeared and seems to be the authority here, so I will establish a line of communication while keeping Biz close.');
    const opts = owned.filter(o => o.m.type === 'action-proposals' && o.m.characterName === 'Liz').map(o => o.m);
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) expect(o.actions).toContain('I find the clause allowing oral date corrections.');
  });

  it('memories: no reading of anyone\'s character; the observation writer is told whose hand is whose and not to judge', () => {
    expect(memories.length).toBeGreaterThan(0);
    for (const m of memories) expect(m).not.toMatch(/revealed|revealing|fine motor/);
    expect(memories).toContain('I saw Biz press the slick brass button, which caused the mechanism to wobble.');
    const obs = observationPrompts();
    expect(obs.length).toBeGreaterThan(0);
    for (const p of obs) {
      expect(p.text).not.toMatch(/Be specific about what it reveals/);
      expect(p.text).toMatch(/never a judgment of anyone's character/);
    }
    // Biz observing Liz: what Biz does in the outcome is Biz's own.
    const bizObs = obs.find(p => p.text.startsWith('You are Biz.'))!;
    expect(bizObs.text).toContain("Biz's fingers");
    const extract = prompts.find(p => p.text.includes('You extract episodic memories'))!;
    expect(extract.text).toMatch(/never a judgment of anyone's character/);
  });
});
