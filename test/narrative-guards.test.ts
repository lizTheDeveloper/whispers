// test/narrative-guards.test.ts
//
// A live verification of c54792c (Liz, a mom, and Biz, her 10-year-old, isekai'd
// into a bureaucratic fantasy world by a paperwork error; Biz's gender never
// stated) showed four things the prompts ASKED for but the model did not do.
// These tests pin the code that now ENFORCES them:
//
//  1. Arrival. An isekai/portal/summoned premise gets an arrival beat in the
//     opening even when the DM writes scenery only ("The marble floor beneath
//     my feet hums…").
//  2. Pronouns. Character agents are told each companion's pronouns (or that
//     they are not stated). The rule-based guard that once rewrote he/she in
//     model prose is gone — it wrote clumsy, mixed text — replaced by the
//     interview asking each player (see character-interview.test.ts).
//  3. Address. Biz calls Liz "Mom": "Liz, can you help me?" from Biz becomes
//     "Mom, can you help me?", and "Mom Liz" becomes "Mom". The other way
//     round in narration: "Biz steadies Mom." from the DM becomes "Biz
//     steadies Liz." — the address term belongs to Biz's speech only.
//  4. Taken out. A character who is taken out does not take normal turns until
//     they recover — at the next scene, or when a companion helps them up.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterDefinition, RoomState, WorldSeed } from '../src/shared/types.js';
import type { ServerMessage } from '../src/shared/protocol.js';

// Read by game-loop at import time: a closed whisper window must not cost a test 30s.
process.env.WHISPER_WINDOW_MS = '30';

type Msg = { role: string; content: string };
const llmCalls: Msg[][] = [];

// What the canned DM/agents say. Tests set these before running a loop.
const canned = {
  openingNarration: 'The marble floor beneath my feet hums with a low, rhythmic thrum… a chaotic symphony of bureaucracy.',
  openingArrival: undefined as string | undefined,
  narration: 'A bell dings somewhere down the queue, and Clerk Oswin Pell looks up from a towering stack of forms.',
  resolution: 'The form rustles; the clerk grunts and waves them on.',
  decisions: {} as Record<string, { chosenAction: string; spokenWords: string | null }>,
  epilogue: 'The queue closed behind them, and the Bureau went quiet.',
  proposals: undefined as string[] | undefined,
  /** What the pronoun-consistency rewrite returns (undefined → echo 'ok', which is rejected). */
  pronounRewrite: {} as Record<string, string>,
  /** The ruling's state changes (by character name → resolved to the id at call time). */
  stateChanges: [] as Array<{ characterId: string; field: string; action: string; value: unknown }>,
  /** How the character says it took the whisper. */
  influence: 'ignored' as 'followed' | 'partially-followed' | 'ignored',
};

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  // The loop's pause plumbing (runWithLlmSignal) stays real; only the model is canned.
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    llmCalls.push(opts.messages);
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('OPENING OF THE ADVENTURE')) {
      return { narration: canned.openingNarration, introductions: [], currentLocationName: '', ...(canned.openingArrival !== undefined ? { arrival: canned.openingArrival } : {}) };
    }
    if (all.includes('Pacing:')) {
      return { narration: canned.narration, currentLocationName: 'The Intake Hall', activeNpcs: [], isSceneEnd: false };
    }
    if (all.includes('You correct how people are referred to in a passage')) {
      const passage = all.split('Passage:\n')[1] ?? '';
      const hit = Object.entries(canned.pronounRewrite).find(([from]) => passage.includes(from));
      return hit ? passage.replace(hit[0], hit[1]) : 'ok';
    }
    if (all.includes('Propose 2-4 actions')) {
      if (canned.proposals) return { actions: canned.proposals.map(description => ({ description, reasoning: 'r' })) };
      return { actions: [{ description: 'I take a numbered ticket from the dispenser', reasoning: 'queue' }, { description: 'I ask the clerk where we are', reasoning: 'talk' }] };
    }
    if (all.includes('Choose your action now')) {
      const who = all.match(/You ARE (\w+)/)?.[1] ?? '';
      const d = canned.decisions[who] ?? { chosenAction: 'I study the stamp on the nearest form very carefully', spokenWords: null };
      return { ...d, innerThought: 'The forms are the key to getting home.', whisperedInfluence: canned.influence, trustDelta: 0 };
    }
    if (all.includes('FATE resolution steps')) {
      return { diceExpression: '4dF', difficulty: 0, skill: 'Notice', outcome: 'success', narration: canned.resolution, stateChanges: canned.stateChanges };
    }
    if (all.includes('Summarize')) return { summary: 'The queue moved.' };
    return 'ok';
  }),
  callProse: vi.fn(async (opts: { messages: Msg[] }) => {
    llmCalls.push(opts.messages);
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('session epilogues')) return canned.epilogue;
    if (all.includes('closing reflection')) return 'SPOKEN: "We made it."\nTHOUGHT: The forms were never the point.';
    return 'ok';
  }),
}));

let dataDir: string;
let db: Database.Database;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-narrative-guards-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  const dbMod = await import('../src/server/db.js');
  db = dbMod.getDb();
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

const LIZ: CharacterDefinition = {
  name: 'Liz',
  backstory: 'A single mom from Ohio who never misses a deadline.',
  personality: 'Organised, wry, fiercely protective.',
  highConcept: 'Overworked Mom With a Clipboard Heart',
  trouble: 'Cannot Stop Managing Everyone',
  aspects: ['Always Has Snacks', 'Reads the Fine Print'],
  skills: { Will: 3, Rapport: 2, Notice: 1 },
  stunts: ['Mom Voice: +2 to Provoke when someone is endangering a child.'],
  age: 38,
  relationships: [{ to: 'Biz', relation: 'kid', address: 'Biz' }],
};
// No pronouns: nobody at the table ever said.
const BIZ: CharacterDefinition = {
  name: 'Biz',
  backstory: 'Ten years old; collects bottle caps and questions.',
  personality: 'Curious, restless, brave in the way small kids are.',
  highConcept: 'Ten-Year-Old Who Asks Why',
  trouble: 'Wanders Off When Something Glows',
  aspects: ['Pocket Full of Bottle Caps', 'Fits Where Adults Cannot'],
  skills: { Notice: 3, Athletics: 2, Stealth: 1 },
  stunts: ['Small and Quick: +2 to Stealth in tight spaces.'],
  age: 10,
  relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }],
};
const STATE = { stress: 0, consequences: [] as string[], fatePoints: 3, inventory: [] as string[], xpMilestones: [] as string[], whisperTrust: 0.65 };

const ISEKAI_SEED: WorldSeed = {
  premise: 'A clerical paperwork error has isekaied a mother and child into the Bureau of Misfiled Souls, a kingdom run entirely on forms.',
  locations: [
    { name: 'The Intake Hall', description: 'Endless queues under humming lamps.', terrain: 'interior' },
    { name: 'The Stamp Gardens', description: 'Hedges trimmed into rubber stamps.', terrain: 'garden' },
    { name: 'Archive Nine', description: 'Shelves that rearrange at night.', terrain: 'interior' },
  ],
  npcs: [
    { name: 'Clerk Oswin Pell', description: 'A tired clerk with ink-stained cuffs.', disposition: 'wary', motivation: 'Hide the error.' },
    { name: 'The Registrar', description: 'Never seen, only signed.', disposition: 'unknown', motivation: 'Unknown.' },
    { name: 'Dot', description: 'A paper crane that delivers memos.', disposition: 'friendly', motivation: 'Deliver everything.' },
  ],
  plotHooks: ['Form 27-B was signed by someone who does not exist.'],
  items: [{ name: 'Blank Form 27-B', description: 'Warm, as if recently printed.' }],
};

let seq = 0;

/**
 * A fresh table with Liz and Biz, run until `until` says stop (or a timeout).
 * `lizState` lets a test start Liz already taken out.
 */
async function runLoop(opts: { seed?: WorldSeed; liz?: CharacterDefinition; biz?: CharacterDefinition; lizState?: typeof STATE; bizState?: typeof STATE; until: (m: ServerMessage, all: ServerMessage[]) => boolean; timeoutMs?: number; endGame?: boolean; setup?: (campaignId: string) => void; onMessage?: (m: ServerMessage, loop: any) => void }) {
  const { createRoom } = await import('../src/server/room.js');
  const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
  const { GameLoop } = await import('../src/server/game-loop.js');
  const seed = opts.seed ?? ISEKAI_SEED;
  const { campaignId, joinCode } = createRoom(db, { name: `Guards ${++seq}`, dmPreset: 'chronicler', systemId: 'fate-core' });
  setWorldSeed(db, campaignId, seed);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed);
  const lizId = `liz-g-${seq}`;
  const bizId = `biz-g-${seq}`;
  db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)')
    .run(lizId, campaignId, JSON.stringify(opts.liz ?? LIZ), JSON.stringify(opts.lizState ?? STATE));
  db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)')
    .run(bizId, campaignId, JSON.stringify(opts.biz ?? BIZ), JSON.stringify(opts.bizState ?? STATE));
  opts.setup?.(campaignId);
  const state: RoomState = {
    campaignId, joinCode, phase: 'playing', currentScene: 0, currentTurn: 0,
    initiativeOrder: [], activeCharacterId: null,
    awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null,
  };
  const broadcasts: ServerMessage[] = [];
  const callsBefore = llmCalls.length;
  let loop!: InstanceType<typeof GameLoop>;
  const done = new Promise<void>((resolve) => {
    loop = new GameLoop(db, campaignId, (m) => {
      broadcasts.push(m);
      opts.onMessage?.(m, loop);
      if (opts.until(m, broadcasts)) setImmediate(() => { loop.stop(); resolve(); });
    }, () => {}, state, (_id, m) => {
      broadcasts.push(m);
      opts.onMessage?.(m, loop);
      // Owner-only messages (options, guidance, thoughts) can end a run too.
      if (['whisper-guidance', 'character-thought'].includes(m.type) && opts.until(m, broadcasts)) setImmediate(() => { loop.stop(); resolve(); });
    });
  });
  const running = loop.start().catch((e) => { console.error("LOOP FAILED", e); });
  await Promise.race([done, new Promise(r => setTimeout(r, opts.timeoutMs ?? 15_000))]);
  loop.stop();
  await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
  if (opts.endGame) await loop.endGame();
  const calls = llmCalls.slice(callsBefore).map(c => c.map(m => m.content).join('\n'));
  return { broadcasts, calls, lizId, bizId, campaignId };
}

const narrations = (bs: ServerMessage[]) => bs.filter(m => m.type === 'narration').map(m => (m as Extract<ServerMessage, { type: 'narration' }>).text);

// ─── 1. Arrival ────────────────────────────────────────────────────────────

describe('an arrival premise always opens on an arrival beat', () => {
  it('detects premises and backstories that transport the party, and leaves native ones alone', async () => {
    const { premiseImpliesArrival } = await import('../src/server/narrative-guards.js');
    expect(premiseImpliesArrival(ISEKAI_SEED.premise)).toBe(true);
    expect(premiseImpliesArrival('Two strangers are summoned through a portal to the Glass Court.')).toBe(true);
    expect(premiseImpliesArrival('She woke up in a ward with no doors.')).toBe(true);
    expect(premiseImpliesArrival('A family is pulled into a painting.')).toBe(true);
    expect(premiseImpliesArrival('A lighthouse keeps something out, not in.')).toBe(false);
    expect(premiseImpliesArrival('The town guard investigates a theft at the docks.')).toBe(false);
  });

  it('the deterministic arrival names the party and where the premise sends them', async () => {
    const { fallbackArrival, hasArrivalBeat } = await import('../src/server/narrative-guards.js');
    const line = fallbackArrival(ISEKAI_SEED.premise, ['Liz', 'Biz']);
    expect(line).toContain('Liz and Biz');
    expect(line).toContain('Bureau of Misfiled Souls');
    expect(line).toMatch(/disorient/i);
    expect(hasArrivalBeat(line)).toBe(true);
    expect(hasArrivalBeat(canned.openingNarration)).toBe(false);
  });

  it('an improvised isekai opening gets an arrival even when the DM writes scenery only', async () => {
    canned.openingArrival = undefined;
    const { broadcasts, calls } = await runLoop({ until: m => m.type === 'whisper-prompt' });
    const opening = calls.find(c => c.includes('OPENING OF THE ADVENTURE'))!;
    expect(opening).toBeTruthy();
    // The DM is asked for a dedicated, required arrival field.
    expect(opening).toMatch(/"arrival"/);
    const first = narrations(broadcasts)[0]!;
    expect(first).toBeTruthy();
    const { hasArrivalBeat } = await import('../src/server/narrative-guards.js');
    expect(hasArrivalBeat(first)).toBe(true);
    expect(first).toMatch(/Liz/);
    expect(first).toMatch(/Biz/);
    // The DM's scenery is kept, after the arrival.
    expect(first).toContain('chaotic symphony of bureaucracy');
    expect(first.indexOf('chaotic symphony')).toBeGreaterThan(first.search(/disorient|arriv|land/i));
  }, 30_000);

  it("uses the DM's own arrival when it wrote one", async () => {
    canned.openingArrival = 'One moment Liz and Biz were filling in a school form at the kitchen table; the next, they tumble onto cold marble, dizzy and disoriented.';
    try {
      const { broadcasts } = await runLoop({ until: m => m.type === 'whisper-prompt' });
      const first = narrations(broadcasts)[0]!;
      expect(first).toContain('tumble onto cold marble');
      expect(first).not.toMatch(/Bureau of Misfiled Souls\. They blink/);
    } finally {
      canned.openingArrival = undefined;
    }
  }, 30_000);

  // Live: "Liz and Biz land hard… They blink, disoriented…" and then the
  // DM's own "A blinding flash… Liz and Biz are hurled from their waiting
  // room…" — transported twice. When the scene prose narrates the transport
  // itself, nothing is put in front of it.
  it('never puts a second transport in front of scene prose that already narrates one', async () => {
    const saved = canned.openingNarration;
    canned.openingNarration = 'A blinding flash snaps the kitchen into chaos, and Liz and Biz are hurled from their waiting room onto cold marble under humming lamps.';
    canned.openingArrival = undefined;
    try {
      const { broadcasts } = await runLoop({ until: m => m.type === 'whisper-prompt' });
      const first = narrations(broadcasts)[0]!;
      expect(first).toBe(canned.openingNarration);
      expect(first).not.toMatch(/land hard/);
    } finally {
      canned.openingNarration = saved;
    }
  }, 30_000);

  it("the DM's arrival comes first and the scene after it, once each", async () => {
    canned.openingArrival = 'Liz and Biz tumble onto cold marble, dizzy and disoriented.';
    try {
      const { broadcasts } = await runLoop({ until: m => m.type === 'whisper-prompt' });
      const first = narrations(broadcasts)[0]!;
      expect(first).toBe(`${canned.openingArrival}\n\n${canned.openingNarration}`);
    } finally {
      canned.openingArrival = undefined;
    }
  }, 30_000);

  it('a premise with nobody arriving is not forced into one', async () => {
    const seed: WorldSeed = { ...ISEKAI_SEED, premise: 'The Bureau of Misfiled Souls has run on forms for a thousand years, and today its oldest clerk has gone missing.' };
    const { broadcasts } = await runLoop({ seed, until: m => m.type === 'whisper-prompt' });
    const first = narrations(broadcasts)[0]!;
    expect(first).toBe(canned.openingNarration);
  }, 30_000);
});

// ─── 2. Pronouns ───────────────────────────────────────────────────────────

describe('character agents are told how to refer to each companion', () => {
  it('shows a companion\'s stated pronouns, and "not stated → name or they" for one without', async () => {
    const { CharacterAgent } = await import('../src/server/agents/character.js');
    const before = llmCalls.length;
    await new CharacterAgent().proposeActions({
      definition: LIZ, state: STATE, sceneNarration: 'The Intake Hall hums.',
      transcript: [{ role: 'character', characterId: 'biz', content: 'Biz: I tug at the form', timestamp: new Date().toISOString() }],
      partyMembers: [{ name: 'Biz', highConcept: BIZ.highConcept, trouble: BIZ.trouble, relation: 'kid', address: 'Biz' }],
    });
    const sent = llmCalls.slice(before).map(c => c.map(m => m.content).join('\n')).join('\n');
    const bizLine = sent.split('\n').find(l => l.startsWith('- Biz'))!;
    expect(bizLine).toMatch(/pronouns not stated — refer to (them|Biz) by name or "they"/);
    expect(sent).toMatch(/Your pronouns: she\/her|Your pronouns/);

    const before2 = llmCalls.length;
    await new CharacterAgent().proposeActions({
      definition: BIZ, state: STATE, sceneNarration: 'The Intake Hall hums.', transcript: [],
      partyMembers: [{ name: 'Liz', highConcept: LIZ.highConcept, trouble: LIZ.trouble, relation: 'mother', address: 'Mom', pronouns: 'she/her' }],
    });
    const sent2 = llmCalls.slice(before2).map(c => c.map(m => m.content).join('\n')).join('\n');
    expect(sent2.split('\n').find(l => l.startsWith('- Liz'))).toMatch(/pronouns: she\/her/);
    // Biz's own pronouns are not stated, and Biz is told so.
    expect(sent2).toMatch(/Your pronouns have not been stated/);
  });

  it('puts the address term where spokenWords is produced', async () => {
    const { CharacterAgent } = await import('../src/server/agents/character.js');
    const before = llmCalls.length;
    await new CharacterAgent().decideAction({
      definition: BIZ, state: STATE, sceneNarration: 'The Intake Hall hums.', transcript: [],
      partyMembers: [{ name: 'Liz', highConcept: LIZ.highConcept, trouble: LIZ.trouble, relation: 'mother', address: 'Mom', pronouns: 'she/her' }],
    }, null);
    const task = llmCalls.slice(before)[0]!.map(m => m.content).join('\n');
    const dialogue = task.split('\n').find(l => l.startsWith('DIALOGUE'))!;
    expect(dialogue).toMatch(/Liz[^.]*"Mom"/);
    expect(dialogue).toMatch(/never "Mom Liz"/);
  });

  it('in play, each companion line carries pronouns derived from the sheets', async () => {
    const { calls } = await runLoop({ until: (m, all) => all.filter(x => x.type === 'whisper-prompt').length >= 2 });
    const lizPrompt = calls.find(c => c.includes('You ARE Liz'))!;
    expect(lizPrompt.split('\n').find(l => l.startsWith('- Biz'))).toMatch(/pronouns not stated/);
    const bizPrompt = calls.find(c => c.includes('You ARE Biz'))!;
    // Biz's sheet calls Liz "mother": that states her gender.
    expect(bizPrompt.split('\n').find(l => l.startsWith('- Liz'))).toMatch(/she\/her/);
  }, 30_000);
});

describe('pronouns are asked for, not repaired', () => {
  // The rule-based he/she repair pass produced "…clinging to their boots as
  // Biz steps…" and mixed their/his in one sentence. It is removed; the
  // interview asks each player instead, and prompts carry the answer.
  it('no longer exports a pronoun repair pass', async () => {
    const guards = await import('../src/server/narrative-guards.js') as Record<string, unknown>;
    expect(guards.repairPronouns).toBeUndefined();
  });

  it('broadcasts DM prose with its pronouns as the model wrote them', async () => {
    canned.narration = 'Liz pulls Biz close and places her hand on his shoulder as the queue lurches forward.';
    try {
      const { broadcasts } = await runLoop({ until: m => m.type === 'resolution' });
      expect(narrations(broadcasts)).toContain(canned.narration);
    } finally {
      canned.narration = 'A bell dings somewhere down the queue, and Clerk Oswin Pell looks up from a towering stack of forms.';
    }
  }, 30_000);
});

// ─── 3. Address ────────────────────────────────────────────────────────────

describe('the address guard', () => {
  const terms = [{ name: 'Liz', address: 'Mom' }];

  it('replaces a first name used to address the companion with the address term', async () => {
    const { repairAddress } = await import('../src/server/narrative-guards.js');
    expect(repairAddress('Liz, can you help me?', terms, { vocative: true })).toBe('Mom, can you help me?');
    expect(repairAddress('Liz, can you help me see whose handwriting this is?', terms, { vocative: true })).toBe('Mom, can you help me see whose handwriting this is?');
    expect(repairAddress('Can you help me, Liz?', terms, { vocative: true })).toBe('Can you help me, Mom?');
    expect(repairAddress('Hey Liz, look!', terms, { vocative: true })).toBe('Hey Mom, look!');
  });

  it('collapses "Mom Liz" to "Mom"', async () => {
    const { repairAddress } = await import('../src/server/narrative-guards.js');
    expect(repairAddress('Mom Liz, look at this stamp!', terms, { vocative: true })).toBe('Mom, look at this stamp!');
    expect(repairAddress('Mom Liz would know what this form means.', terms, { vocative: false })).toBe('Mom would know what this form means.');
  });

  it('leaves the name alone when it is not direct address', async () => {
    const { repairAddress } = await import('../src/server/narrative-guards.js');
    expect(repairAddress("Is that Liz's handwriting?", terms, { vocative: true })).toBe("Is that Liz's handwriting?");
    expect(repairAddress('I think Liz is right about the queue.', terms, { vocative: true })).toBe('I think Liz is right about the queue.');
  });

  it("fixes Biz's spoken words in play, but not anyone else's", async () => {
    canned.decisions = {
      Biz: { chosenAction: 'I hold the crumpled form up to the lamp and squint at the signature', spokenWords: 'Liz, can you help me see whose handwriting this is?' },
      Liz: { chosenAction: 'I lean down to look at the signature on the crumpled form', spokenWords: 'Liz is my name, and I can read anything, sweetheart.' },
    };
    try {
      const { broadcasts } = await runLoop({ until: (m, all) => all.filter(x => x.type === 'action-taken').length >= 2 });
      const actions = broadcasts.filter(m => m.type === 'action-taken') as Array<Extract<ServerMessage, { type: 'action-taken' }>>;
      const biz = actions.find(a => a.characterName === 'Biz')!;
      expect(biz.spokenWords).toBe('Mom, can you help me see whose handwriting this is?');
      const liz = actions.find(a => a.characterName === 'Liz')!;
      expect(liz.spokenWords).toBe('Liz is my name, and I can read anything, sweetheart.');
    } finally {
      canned.decisions = {};
    }
  }, 30_000);
});

describe('narration calls party members by name', () => {
  const terms = [{ name: 'Liz', address: 'Mom' }];

  it('replaces an address term used as a name in DM prose', async () => {
    const { namesInNarration } = await import('../src/server/narrative-guards.js');
    expect(namesInNarration('Biz steadies Mom.', terms)).toBe('Biz steadies Liz.');
    expect(namesInNarration('Biz lifted Mom onto the slab, confirming the direction for Mom.', terms))
      .toBe('Biz lifted Liz onto the slab, confirming the direction for Liz.');
    expect(namesInNarration("Biz grips Mom's hand.", terms)).toBe("Biz grips Liz's hand.");
    expect(namesInNarration('Mom Liz squints at the form.', terms)).toBe('Liz squints at the form.');
  });

  it('leaves quoted speech, "her mom", and names that merely contain the word alone', async () => {
    const { namesInNarration } = await import('../src/server/narrative-guards.js');
    for (const text of [
      'Biz tugs a sleeve. "Mom, look at this stamp!"',
      'Biz tugs a sleeve. “Mom, look!”',
      "Biz tugs a sleeve: 'Mom, it's glowing!'",
      'The clerk asks after her mom.',
      'The clerk asks after his Mom.',
      'Liz uses her Mom Voice on the clerk.',
      'The Mom Voice echoes down the hall.',
    ]) expect(namesInNarration(text, terms)).toBe(text);
    // A term two characters use for two different people is not a name for either.
    expect(namesInNarration('Mom waits.', [{ name: 'Liz', address: 'Mom' }, { name: 'Ana', address: 'Mom' }])).toBe('Mom waits.');
  });

  // Live: the world bible held NPCs named "Liz", "Biz" and "Mom", extracted
  // from the DM's prose, and fed them back to the DM as people in the world.
  it('world facts never record a party member, or an address term, as an NPC', async () => {
    const { withoutPartyEntities } = await import('../src/server/narrative-guards.js');
    const facts = {
      newEntities: ['Liz', 'Biz', 'Mom', 'Clerk Thistledown', 'Wanderer'].map(name => ({ name, type: 'npc' })),
    };
    expect(withoutPartyEntities(facts, ['Liz', 'Biz'], ['Mom']).newEntities.map(e => e.name))
      .toEqual(['Clerk Thistledown', 'Wanderer']);
  });

  it("runs on the loop's narration, resolutions and epilogue, but not on Biz's own action", async () => {
    canned.narration = 'Biz steadies Mom as the queue lurches. "Mom, hold on," Biz whispers.';
    canned.resolution = "Biz grips Mom's hand and the stamp comes down clean.";
    canned.epilogue = 'In the end Biz hoisted Mom onto the slab, and the Bureau let them go.';
    canned.decisions = { Biz: { chosenAction: "I hold on tight, keeping Mom's hand in mine as the queue moves", spokenWords: null } };
    try {
      const { broadcasts } = await runLoop({ until: m => m.type === 'resolution', endGame: true });
      expect(narrations(broadcasts)).toContain('Biz steadies Liz as the queue lurches. "Mom, hold on," Biz whispers.');
      const resolutions = broadcasts.filter(m => m.type === 'resolution').map(m => (m as Extract<ServerMessage, { type: 'resolution' }>).text);
      expect(resolutions.length).toBeGreaterThan(0);
      expect(resolutions.join('\n')).not.toMatch(/Mom's hand/);
      const epilogue = broadcasts.find(m => m.type === 'narration' && m.isEpilogue) as Extract<ServerMessage, { type: 'narration' }>;
      expect(epilogue.text).toBe('In the end Biz hoisted Liz onto the slab, and the Bureau let them go.');
      const bizAction = broadcasts.find(m => m.type === 'action-taken' && m.characterName === 'Biz' && !m.action.startsWith('[')) as Extract<ServerMessage, { type: 'action-taken' }> | undefined;
      if (bizAction) expect(bizAction.action).toContain("Mom's hand");
    } finally {
      canned.narration = 'A bell dings somewhere down the queue, and Clerk Oswin Pell looks up from a towering stack of forms.';
      canned.resolution = 'The form rustles; the clerk grunts and waves them on.';
      canned.epilogue = 'The queue closed behind them, and the Bureau went quiet.';
      canned.decisions = {};
    }
  }, 30_000);
});

describe('the ending reads the characters as they are now', () => {
  // Live: the epilogue gave Liz "a cold pulse up her twisted ankle" after the
  // log said she recovered from it. Recovered consequences leave the state
  // at the scene break; the epilogue and closing reflections are given the
  // current ones and told the rest have healed.
  it("gives the epilogue each character's current injuries, and says any others have healed", async () => {
    const { calls } = await runLoop({
      bizState: { ...STATE, consequences: ['Sprained Wrist'] },
      until: m => m.type === 'whisper-prompt',
      endGame: true,
    });
    const epilogue = calls.find(c => c.includes('session epilogues'))!;
    expect(epilogue).toMatch(/Liz \([^)]*\): no current injuries/);
    expect(epilogue).toMatch(/Biz \([^)]*\): current injuries: Sprained Wrist/);
    expect(epilogue).toMatch(/has healed — never describe it as still hurting/);
  }, 30_000);

  it('describes the condition from the state alone', async () => {
    const { currentCondition } = await import('../src/server/game-loop.js');
    expect(currentCondition({ consequences: [] })).toBe('no current injuries');
    expect(currentCondition({ consequences: ['Twisted Ankle', 'Taken Out (recovering)'] })).toBe('current injuries: Twisted Ankle, taken out');
  });
});

describe('the whisper status line is grammatical', () => {
  // Live: `Liz is their trouble "I can't let Biz out of my sight…" is weighing on them.`
  it("puts the trouble in its own sentence, in the character's own pronouns or name", async () => {
    const { characterStatusLine } = await import('../src/server/game-loop.js');
    const trouble = "I can't let Biz out of my sight";
    expect(characterStatusLine({ name: 'Liz', pronouns: 'she/her', trouble, states: [], troublePull: true }))
      .toBe(`Liz's trouble, "${trouble}", is weighing on her.`);
    expect(characterStatusLine({ name: 'Liz', pronouns: 'she/her', trouble, states: ['under heavy stress'], troublePull: true }))
      .toBe(`Liz is under heavy stress. Liz's trouble, "${trouble}", is weighing on her.`);
    expect(characterStatusLine({ name: 'Biz', pronouns: null, trouble: 'Wanders off', states: [], troublePull: true }))
      .toBe('The trouble "Wanders off" is weighing on Biz.');
    expect(characterStatusLine({ name: 'Ash', pronouns: 'xe/xem', trouble: 'Owes a debt', states: [], troublePull: true }))
      .toBe('Ash\'s trouble, "Owes a debt", is weighing on xem.');
    expect(characterStatusLine({ name: 'Liz', pronouns: 'she/her', trouble, states: [], troublePull: false })).toBe('Liz is focused and alert.');
  });
});

// ─── 4. Taken out ──────────────────────────────────────────────────────────

describe('a taken-out character stays down until they recover', () => {
  const TAKEN_OUT = 'Taken Out (recovering)';

  it('gets no action turn while out, and the DM and companions are told', async () => {
    const { broadcasts, calls } = await runLoop({
      lizState: { ...STATE, stress: 1, consequences: [TAKEN_OUT] },
      until: m => m.type === 'whisper-prompt',
    });
    const proposals = broadcasts.filter(m => m.type === 'action-proposals') as Array<Extract<ServerMessage, { type: 'action-proposals' }>>;
    expect(proposals.map(p => p.characterName)).not.toContain('Liz');
    const prompt = broadcasts.find(m => m.type === 'whisper-prompt') as Extract<ServerMessage, { type: 'whisper-prompt' }>;
    expect(prompt.characterName).toBe('Biz');
    // The DM's party block says Liz is out.
    const narrate = calls.find(c => c.includes('Pacing:'))!;
    expect(narrate).toMatch(/Liz[^\n]*TAKEN OUT/);
    // Biz's companion line says so too.
    const bizPrompt = calls.find(c => c.includes('You ARE Biz'))!;
    expect(bizPrompt.split('\n').find(l => l.startsWith('- Liz'))).toMatch(/TAKEN OUT/);
  }, 30_000);

  it('recovers when a companion helps them up', async () => {
    canned.decisions = {
      Biz: { chosenAction: 'I kneel beside Mom and help her sit up, shaking her shoulder gently', spokenWords: 'Mom, wake up. Please.' },
    };
    try {
      const { broadcasts, lizId } = await runLoop({
        lizState: { ...STATE, stress: 1, consequences: [TAKEN_OUT] },
        until: m => m.type === 'whisper-prompt' && m.characterName === 'Liz',
        timeoutMs: 20_000,
      });
      const lizUpdates = broadcasts.filter(m => m.type === 'character-state-update' && m.characterId === lizId) as Array<Extract<ServerMessage, { type: 'character-state-update' }>>;
      expect(lizUpdates.some(u => !u.state.consequences.includes(TAKEN_OUT))).toBe(true);
      // …and Liz is back to taking turns.
      expect(broadcasts.some(m => m.type === 'whisper-prompt' && m.characterName === 'Liz')).toBe(true);
    } finally {
      canned.decisions = {};
    }
  }, 30_000);

  it('recovers at the next scene', async () => {
    const { recoverAtSceneBreak } = await import('../src/server/narrative-guards.js');
    expect(recoverAtSceneBreak([TAKEN_OUT])).toEqual({ kept: [], recovered: [TAKEN_OUT] });
    // A second, lasting consequence stays (as before); being taken out does not.
    expect(recoverAtSceneBreak([TAKEN_OUT, 'Sprained Wrist'])).toEqual({ kept: ['Sprained Wrist'], recovered: [TAKEN_OUT] });
    expect(recoverAtSceneBreak(['Sprained Wrist'])).toEqual({ kept: [], recovered: ['Sprained Wrist'] });
  });

  it('a DM narration that declares someone taken out makes it so', async () => {
    const { declaredTakenOut } = await import('../src/server/narrative-guards.js');
    expect(declaredTakenOut('The ledger slams shut and Liz is TAKEN OUT, lying on the cold stone.', ['Liz', 'Biz'])).toEqual(['Liz']);
    expect(declaredTakenOut('Liz is taken out by the falling filing cabinet.', ['Liz', 'Biz'])).toEqual(['Liz']);
    expect(declaredTakenOut('Biz worries the clerk will have Liz taken out of the queue.', ['Liz', 'Biz'])).toEqual([]);
    expect(declaredTakenOut('Biz takes out a bottle cap.', ['Liz', 'Biz'])).toEqual([]);
  });
});

// ─── 5. Pronoun consistency (checked in code, repaired by a small rewrite) ──
//
// Live (Liz = she/her, Biz = they/them, both STATED): a resolution read
// "…give way under his finger… tingles on his skin…" and the epilogue "left a
// tingling stain on his palm". Prompts alone were not followed. A cheap
// pre-filter finds a stated member near a conflicting word; only then is the
// model asked for a pronoun-only rewrite, which is kept only if it is close
// to the original.

const LIZ_STATED: CharacterDefinition = { ...LIZ, pronouns: 'she/her' };
const BIZ_STATED: CharacterDefinition = { ...BIZ, pronouns: 'they/them' };
const MEMBERS = [{ name: 'Liz', pronouns: 'she/her' }, { name: 'Biz', pronouns: 'they/them' }];

describe('the pronoun pre-filter', () => {
  it('fires on a conflicting pronoun in the same sentence as the name, or the next when that member is the only one named', async () => {
    const { findPronounConflicts } = await import('../src/server/pronoun-consistency.js');
    expect(findPronounConflicts('Biz touches the rune and it tingles on his skin.', MEMBERS).map(c => [c.name, c.word])).toEqual([['Biz', 'his']]);
    expect(findPronounConflicts('Biz presses the rune. It gives way under his finger.', MEMBERS).map(c => [c.name, c.word])).toEqual([['Biz', 'his']]);
    expect(findPronounConflicts('Biz grins. The boy at the stall waves.', MEMBERS).map(c => c.word)).toEqual(['boy']);
  });

  it('stays quiet when the pronouns match, when another named member owns the word, or when nothing is stated', async () => {
    const { findPronounConflicts } = await import('../src/server/pronoun-consistency.js');
    expect(findPronounConflicts('Biz touches the rune and it tingles on their skin.', MEMBERS)).toEqual([]);
    expect(findPronounConflicts('Liz takes Biz by the hand and tucks her map away.', MEMBERS)).toEqual([]);
    expect(findPronounConflicts('Liz frowns at the form; her pen is dry.', MEMBERS)).toEqual([]);
    // Not stated → never touched.
    expect(findPronounConflicts('Biz touches the rune and it tingles on his skin.', [{ name: 'Biz' }, { name: 'Liz', pronouns: 'she/her' }])).toEqual([]);
    // Two sentences away, or with another member named in between, is not "near".
    expect(findPronounConflicts('Biz presses the rune. Liz watches. The clerk scratches his chin.', MEMBERS).filter(c => c.name === 'Biz')).toEqual([]);
  });
});

describe('the pronoun rewrite', () => {
  it('uses the rewrite when the check fires', async () => {
    const { withConsistentPronouns } = await import('../src/server/pronoun-consistency.js');
    const seen: string[] = [];
    const out = await withConsistentPronouns('Biz presses the rune. It gives way under his finger and tingles on his skin.', MEMBERS, {
      llm: async (messages) => { seen.push(messages.map(m => m.content).join('\n')); return 'Biz presses the rune. It gives way under their finger and tingles on their skin.'; },
    });
    expect(out).toBe('Biz presses the rune. It gives way under their finger and tingles on their skin.');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/change nothing else/i);
    expect(seen[0]).toContain('- Biz: they/them');
    expect(seen[0]).toContain('- Liz: she/her');
  });

  it('makes no LLM call when nothing conflicts', async () => {
    const { withConsistentPronouns } = await import('../src/server/pronoun-consistency.js');
    let calls = 0;
    const text = 'Biz presses the rune; it tingles on their skin while Liz reads her form.';
    expect(await withConsistentPronouns(text, MEMBERS, { llm: async () => { calls++; return 'x'; } })).toBe(text);
    expect(await withConsistentPronouns('Biz rubs his palm.', [{ name: 'Biz' }], { llm: async () => { calls++; return 'x'; } })).toBe('Biz rubs his palm.');
    expect(calls).toBe(0);
  });

  it('keeps the original when the rewrite changes too much or drops a name', async () => {
    const { withConsistentPronouns, acceptRewrite } = await import('../src/server/pronoun-consistency.js');
    const text = 'Biz presses the rune. It gives way under his finger and tingles on his skin.';
    // The rejected rewrite is never used. Since round 8 a conflict the model
    // leaves in place twice is repaired in code where that is safe (only Biz
    // could own "his" here, and no NPC is near), so the result is the
    // original with just the pronouns changed — never the model's preamble
    // or its "The kid".
    const repaired = 'Biz presses the rune. It gives way under their finger and tingles on their skin.';
    expect(await withConsistentPronouns(text, MEMBERS, { llm: async () => 'Here is the corrected passage, with every pronoun fixed as requested: Biz presses the rune. It gives way under their finger and tingles on their skin.' })).toBe(repaired);
    expect(await withConsistentPronouns(text, MEMBERS, { llm: async () => 'The kid presses the rune. It gives way under their finger and tingles on their skin.' })).toBe(repaired);
    expect(await withConsistentPronouns(text, MEMBERS, { llm: async () => { throw new Error('proxy down'); } })).toBe(repaired);
    // Where the code cannot be sure (an NPC just before), a bad rewrite leaves the original.
    const nearNpc = 'Odo nods. It gives way under his finger.';
    expect(await withConsistentPronouns(`Biz presses the rune. ${nearNpc}`, MEMBERS, { llm: async () => 'The kid presses the rune. Odo nods. It gives way under their finger.' })).toBe(`Biz presses the rune. ${nearNpc}`);
    expect(acceptRewrite('abc Liz', '', ['Liz'])).toBe(false);
  });
});

describe('DM prose in play passes the pronoun check', () => {
  it('rewrites a resolution and the epilogue that misgender Biz, before the table sees them', async () => {
    const resolution = 'Biz presses the rune. It gives way under his finger and tingles on his skin, which makes his heart race.';
    const fixedResolution = 'Biz presses the rune. It gives way under their finger and tingles on their skin, which makes their heart race.';
    const epilogue = 'In the end Biz kept the rune; it left a tingling stain on his palm.';
    const fixedEpilogue = 'In the end Biz kept the rune; it left a tingling stain on their palm.';
    canned.resolution = resolution;
    canned.epilogue = epilogue;
    canned.pronounRewrite = { [resolution]: fixedResolution, [epilogue]: fixedEpilogue };
    try {
      const { broadcasts, calls } = await runLoop({ liz: LIZ_STATED, biz: BIZ_STATED, until: m => m.type === 'resolution', endGame: true });
      const resolutions = broadcasts.filter(m => m.type === 'resolution').map(m => (m as Extract<ServerMessage, { type: 'resolution' }>).text);
      expect(resolutions[0]).toContain(fixedResolution);
      expect(resolutions.join('\n')).not.toMatch(/\bhis\b/);
      const ep = broadcasts.find(m => m.type === 'narration' && m.isEpilogue) as Extract<ServerMessage, { type: 'narration' }>;
      expect(ep.text).toBe(fixedEpilogue);
      // The resolution's run needs the model; the one-sentence epilogue that
      // names only Biz is the simple case and is repaired in code (round 7).
      expect(calls.filter(c => c.includes('You correct how people are referred to')).length).toBeGreaterThanOrEqual(1);
    } finally {
      canned.resolution = 'The form rustles; the clerk grunts and waves them on.';
      canned.epilogue = 'The queue closed behind them, and the Bureau went quiet.';
      canned.pronounRewrite = {};
    }
  }, 30_000);

  it('asks for no rewrite when the pronouns already match', async () => {
    canned.resolution = 'Biz presses the rune. It gives way under their finger.';
    try {
      const { calls, broadcasts } = await runLoop({ liz: LIZ_STATED, biz: BIZ_STATED, until: m => m.type === 'resolution' });
      expect(calls.filter(c => c.includes('You correct how people are referred to'))).toEqual([]);
      const resolutions = broadcasts.filter(m => m.type === 'resolution').map(m => (m as Extract<ServerMessage, { type: 'resolution' }>).text);
      expect(resolutions[0]).toContain('Biz presses the rune. It gives way under their finger.');
    } finally {
      canned.resolution = 'The form rustles; the clerk grunts and waves them on.';
    }
  }, 30_000);
});

// ─── 6. "Mom Liz" ──────────────────────────────────────────────────────────

describe('"Mom Liz" is never said', () => {
  it("becomes \"Mom\" in Biz's action options", async () => {
    canned.proposals = ['I tell Mom Liz to keep Sir Tumblefoot busy while I check the drawer', 'I wait by the door'];
    try {
      const { broadcasts } = await runLoop({ until: (_m, all) => all.some(x => x.type === 'action-proposals' && x.characterName === 'Biz') });
      const biz = broadcasts.find(m => m.type === 'action-proposals' && m.characterName === 'Biz') as Extract<ServerMessage, { type: 'action-proposals' }>;
      expect(biz.actions[0]).toBe('I tell Mom to keep Sir Tumblefoot busy while I check the drawer');
    } finally {
      canned.proposals = undefined;
    }
  }, 30_000);

  it('becomes "Liz" in narration', async () => {
    const { namesInNarration } = await import('../src/server/narrative-guards.js');
    expect(namesInNarration('Biz is traveling with Mom Liz.', [{ name: 'Liz', address: 'Mom' }])).toBe('Biz is traveling with Liz.');
  });
});

describe('the character interview reply', () => {
  const bizSheet = { name: 'Biz', pronouns: null as string | null, relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }] };

  it('calls a companion by name, not "Mom Liz"', async () => {
    const { guardInterviewReply } = await import('../src/server/pronoun-consistency.js');
    const out = await guardInterviewReply('So Biz is traveling with Mom Liz. What does Biz carry?', { ...bizSheet, pronouns: 'they/them' }, ['Liz'], { llm: async () => { throw new Error('no call expected'); } });
    expect(out).toBe('So Biz is traveling with Liz. What does Biz carry?');
  });

  it('rewrites "her" for the character being made while their pronouns are unknown', async () => {
    const { guardInterviewReply } = await import('../src/server/pronoun-consistency.js');
    const prompts: string[] = [];
    const out = await guardInterviewReply('Great, Liz it is. What would catch her attention first?', { name: 'Liz', pronouns: null, relationships: [] }, [], {
      llm: async (m) => { prompts.push(m.map(x => x.content).join('\n')); return 'Great, Liz it is. What would catch their attention first?'; },
    });
    expect(out).toBe('Great, Liz it is. What would catch their attention first?');
    expect(prompts[0]).toMatch(/never he, him, his, she or her/);
  });

  it('leaves the reply alone once pronouns are stated, or when the pronoun belongs to someone else at the table', async () => {
    const { guardInterviewReply } = await import('../src/server/pronoun-consistency.js');
    const noCall = { llm: async (): Promise<string> => { throw new Error('no call expected'); } };
    expect(await guardInterviewReply('What would catch her attention?', { name: 'Liz', pronouns: 'she/her', relationships: [] }, [], noCall)).toBe('What would catch her attention?');
    expect(await guardInterviewReply('Does Liz let you out of her sight?', bizSheet, ['Liz'], noCall)).toBe('Does Liz let you out of her sight?');
  });
});

describe('asking for pronouns is not using them', () => {
  it('does not fire on a list of pronoun options', async () => {
    const { interviewGendersCharacter, findPronounConflicts } = await import('../src/server/pronoun-consistency.js');
    expect(interviewGendersCharacter('How should I refer to Liz — she/her, he/him, they/them, or something else?', [])).toBe(false);
    expect(findPronounConflicts('Biz wears a badge that says they / them, not he/him.', MEMBERS)).toEqual([]);
  });
});

// Live: "In the vaulted atrium of the Stamp Market" (the atrium is in the
// Department), and Liz closing on "now the Golden Seal is ours" after the
// seal was handed to the cabinet. The ending is given where things are.
describe('the ending knows where the items and places are', () => {
  it('gives the epilogue and the closing reflections item holders and the places visited, and says not to guess', async () => {
    const { calls } = await runLoop({
      until: m => m.type === 'whisper-prompt',
      endGame: true,
      setup: (campaignId) => {
        db.prepare("UPDATE items SET known_to_party = 1, holder_id = (SELECT id FROM entities WHERE campaign_id = ? AND name = 'Clerk Oswin Pell') WHERE campaign_id = ? AND name = 'Blank Form 27-B'").run(campaignId, campaignId);
        db.prepare("UPDATE locations SET visited = 1 WHERE campaign_id = ? AND name = 'Archive Nine'").run(campaignId);
        // Memories, so the closing reflections are written.
        for (const who of ['liz', 'biz']) {
          const id = db.prepare("SELECT id FROM characters WHERE campaign_id = ? AND id LIKE ?").get(campaignId, `${who}-g-%`) as { id: string };
          db.prepare("INSERT INTO character_memories (id, character_id, campaign_id, scene_number, turn_number, type, content, importance) VALUES (?, ?, ?, 1, 1, 'event', ?, 0.9)").run(`m-${id.id}`, id.id, campaignId, 'We handed the form over.');
        }
      },
    });
    const epilogue = calls.find(c => c.includes('session epilogues'))!;
    expect(epilogue).toMatch(/Blank Form 27-B[^\n]*Clerk Oswin Pell/);
    expect(epilogue).toMatch(/Archive Nine/);
    expect(epilogue).toMatch(/not sure where something happened or who has an item, do not say/i);
    expect(epilogue).toMatch(/Liz \([^)]*\):[^\n]*carrying nothing/);
    const reflection = calls.find(c => c.includes('closing reflection'));
    expect(reflection).toBeDefined();
    expect(reflection).toMatch(/Blank Form 27-B[^\n]*Clerk Oswin Pell/);
    expect(reflection).toMatch(/not sure where something happened or who has an item, do not say/i);
  }, 30_000);
});

// ─── Round 6: the same fixes, in play ──────────────────────────────────────

describe('round 6, in play', () => {
  it('the taken-out line speaks of Liz as "she"', async () => {
    const worn = { ...STATE, stress: 3, consequences: ['Bruised Ribs', 'Sprained Wrist'] };
    const { broadcasts, lizId } = await runLoop({
      liz: LIZ_STATED, biz: BIZ_STATED, lizState: worn, bizState: worn,
      setup: () => { canned.stateChanges = []; },
      until: m => m.type === 'narration' && m.text.includes('TAKEN OUT'),
      onMessage: (m, loop) => {
        // Whoever acts, their ruling adds a point of stress to Liz.
        if (m.type === 'dice-roll' && canned.stateChanges.length === 0) {
          const liz = [...loop.characters.keys()].find((k: string) => k.startsWith('liz-g-'));
          canned.stateChanges = [{ characterId: liz, field: 'stress', action: 'set', value: 3 }];
        }
      },
    });
    canned.stateChanges = [];
    void lizId;
    const line = narrations(broadcasts).find(t => t.includes('TAKEN OUT'))!;
    expect(line).toBeDefined();
    expect(line).toContain('Liz is TAKEN OUT — overwhelmed by stress and injuries, she collapses or is forced to retreat.');
  }, 30_000);

  it("a resolution about its actor that never names them is still checked", async () => {
    // Both they/them here, so whoever acts first is misgendered by "her".
    const resolution = "The ink's glow dims before her eyes. A cold tingle settles on her fingertips, and the path she hoped to find fades.";
    const fixed = "The ink's glow dims before their eyes. A cold tingle settles on their fingertips, and the path they hoped to find fades.";
    canned.resolution = resolution;
    canned.pronounRewrite = { [resolution]: fixed };
    try {
      const { broadcasts, calls } = await runLoop({ liz: { ...LIZ, pronouns: 'they/them' }, biz: BIZ_STATED, until: m => m.type === 'resolution' });
      expect(calls.filter(c => c.includes('You correct how people are referred to')).length).toBe(1);
      const res = broadcasts.find(m => m.type === 'resolution') as Extract<ServerMessage, { type: 'resolution' }>;
      expect(res.text).toContain(fixed);
    } finally {
      canned.resolution = 'The form rustles; the clerk grunts and waves them on.';
      canned.pronounRewrite = {};
    }
  }, 30_000);

  it('a high concept is never a name: not in DM prose, not in a chip', async () => {
    const bizCurious: CharacterDefinition = { ...BIZ_STATED, highConcept: 'Curious Kid With a Sketchbook' };
    const saved = canned.narration;
    canned.narration = 'A bell dings, and the Curious Kid With a Sketchbook steps forward while a curious hush falls over the queue.';
    try {
      const { broadcasts, calls } = await runLoop({
        biz: bizCurious,
        setup: (campaignId) => {
          // What fact extraction once recorded: the kid, described, as an NPC.
          db.prepare("INSERT INTO entities (id, campaign_id, type, name, alive) VALUES (?, ?, 'npc', 'Curious Kid With a Sketchbook', 1)").run(`hc-${campaignId}`, campaignId);
        },
        until: m => m.type === 'whisper-guidance',
      });
      const shown = narrations(broadcasts).join('\n');
      expect(shown).toContain('Biz steps forward');
      expect(shown).not.toMatch(/the Curious Kid With a Sketchbook steps/i);
      // The plain introduction still describes Biz beside the name.
      expect(shown).toContain('Biz — Curious Kid With a Sketchbook');
      const guidance = broadcasts.find(m => m.type === 'whisper-guidance') as Extract<ServerMessage, { type: 'whisper-guidance' }>;
      expect(guidance.suggestions.join(' ')).not.toMatch(/\bCurious\b/);
      // And the DM is told.
      expect(calls.some(c => /by their names?, never (?:by )?their high concept/i.test(c))).toBe(true);
    } finally {
      canned.narration = saved;
    }
  }, 30_000);

  it('"Mom, Liz" in Biz\'s options and chips is "Mom", even when the sheet gives no address term', async () => {
    const bizNoAddress: CharacterDefinition = { ...BIZ, relationships: [{ to: 'Liz', relation: 'mother' }] };
    canned.proposals = ['I whisper to Mom, Liz, to keep watch by the door', 'I hide and watch the clerk'];
    try {
      const { broadcasts } = await runLoop({ biz: bizNoAddress, until: (m) => m.type === 'whisper-guidance' && m.characterId.startsWith('biz-') });
      const props = broadcasts.find(m => m.type === 'action-proposals' && m.characterName === 'Biz') as Extract<ServerMessage, { type: 'action-proposals' }>;
      expect(props.actions[0]).toBe('I whisper to Mom to keep watch by the door');
      const g = broadcasts.find(m => m.type === 'whisper-guidance' && m.characterId.startsWith('biz-')) as Extract<ServerMessage, { type: 'whisper-guidance' }>;
      expect(g.suggestions.join(' ')).not.toMatch(/Mom, Liz/);
    } finally {
      canned.proposals = undefined;
    }
  }, 30_000);

  it('the closing reflections get the epilogue, the open threads, and "no item changed hands unless the record says so"', async () => {
    const { calls } = await runLoop({
      until: m => m.type === 'whisper-prompt',
      endGame: true,
      setup: (campaignId) => {
        db.prepare("INSERT INTO events (id, campaign_id, scene_number, description, participants, outcome) VALUES (?, ?, 1, 'Who stamped the Ever-Seal is still unknown', '[]', NULL)").run(`ev-${campaignId}`, campaignId);
        for (const who of ['liz', 'biz']) {
          const id = db.prepare("SELECT id FROM characters WHERE campaign_id = ? AND id LIKE ?").get(campaignId, `${who}-g-%`) as { id: string };
          db.prepare("INSERT INTO character_memories (id, character_id, campaign_id, scene_number, turn_number, type, content, importance) VALUES (?, ?, ?, 1, 1, 'event', ?, 0.9)").run(`m6-${id.id}`, id.id, campaignId, 'Tilly Tink eyed the seal.');
        }
      },
    });
    const epilogue = calls.find(c => c.includes('session epilogues'))!;
    expect(epilogue).toMatch(/Who stamped the Ever-Seal is still unknown/);
    const reflection = calls.find(c => c.includes('closing reflection'))!;
    expect(reflection).toBeDefined();
    expect(reflection).toContain(canned.epilogue);
    expect(reflection).toMatch(/Who stamped the Ever-Seal is still unknown/);
    expect(reflection).toMatch(/never say an item was handed over, given, taken or put anywhere unless the item list/i);
    expect(epilogue).toMatch(/never say an item was handed over, given, taken or put anywhere unless the item list/i);
  }, 30_000);

  it('a "followed" verdict for an action that shares nothing with the whisper is shown as partial', async () => {
    canned.influence = 'followed';
    canned.decisions = { Liz: { chosenAction: 'I climb the ladder to the top shelf and search the dusty ledgers', spokenWords: null }, Biz: { chosenAction: 'I climb the ladder to the top shelf and search the dusty ledgers', spokenWords: null } };
    try {
      let sent = false;
      const { broadcasts } = await runLoop({
        until: m => m.type === 'character-thought' && m.whisperInfluence !== 'none',
        onMessage: (m, loop) => {
          if (m.type === 'whisper-prompt' && !sent) {
            sent = true;
            setImmediate(() => loop.handleWhisper('Ask the clerk about the missing seal', { characterId: m.characterId, isOwner: false }));
          }
        },
      });
      const thought = broadcasts.find(m => m.type === 'character-thought' && m.whisperInfluence !== 'none') as Extract<ServerMessage, { type: 'character-thought' }>;
      expect(thought.whisperInfluence).toBe('partially-followed');
    } finally {
      canned.influence = 'ignored';
      canned.decisions = {};
    }
  }, 30_000);
});
