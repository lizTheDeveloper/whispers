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
//     they are not stated), and a guard repairs he/she written for a character
//     whose gender nobody stated — NPCs and stated genders untouched.
//  3. Address. Biz calls Liz "Mom": "Liz, can you help me?" from Biz becomes
//     "Mom, can you help me?", and "Mom Liz" becomes "Mom".
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
    if (all.includes('Propose 2-4 actions')) {
      return { actions: [{ description: 'I take a numbered ticket from the dispenser', reasoning: 'queue' }, { description: 'I ask the clerk where we are', reasoning: 'talk' }] };
    }
    if (all.includes('Choose your action now')) {
      const who = all.match(/You ARE (\w+)/)?.[1] ?? '';
      const d = canned.decisions[who] ?? { chosenAction: 'I study the stamp on the nearest form very carefully', spokenWords: null };
      return { ...d, innerThought: 'The forms are the key to getting home.', whisperedInfluence: 'ignored', trustDelta: 0 };
    }
    if (all.includes('FATE resolution steps')) {
      return { diceExpression: '4dF', difficulty: 0, skill: 'Notice', outcome: 'success', narration: canned.resolution, stateChanges: [] };
    }
    if (all.includes('Summarize')) return { summary: 'The queue moved.' };
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
async function runLoop(opts: { seed?: WorldSeed; lizState?: typeof STATE; until: (m: ServerMessage, all: ServerMessage[]) => boolean; timeoutMs?: number }) {
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
    .run(lizId, campaignId, JSON.stringify(LIZ), JSON.stringify(opts.lizState ?? STATE));
  db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)')
    .run(bizId, campaignId, JSON.stringify(BIZ), JSON.stringify(STATE));
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
      if (opts.until(m, broadcasts)) setImmediate(() => { loop.stop(); resolve(); });
    }, () => {}, state, (_id, m) => broadcasts.push(m));
  });
  const running = loop.start().catch((e) => { console.error("LOOP FAILED", e); });
  await Promise.race([done, new Promise(r => setTimeout(r, opts.timeoutMs ?? 15_000))]);
  loop.stop();
  await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
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

describe('the pronoun guard', () => {
  const people = () => [
    { name: 'Liz', gender: 'f' as const, aliases: ['Mom'] },
    { name: 'Biz', gender: null, aliases: [] },
  ];

  it("repairs Biz's he/him/his and leaves Liz's her alone", async () => {
    const { repairPronouns } = await import('../src/server/narrative-guards.js');
    expect(repairPronouns('Liz pulls Biz close and places her hand on his shoulder.', people()))
      .toBe('Liz pulls Biz close and places her hand on their shoulder.');
    expect(repairPronouns('Biz grips the pen as he leans over the form.', people()))
      .toBe('Biz grips the pen as Biz leans over the form.');
    expect(repairPronouns('Biz steadies the stamp, keeping his hand clear.', people()))
      .toBe('Biz steadies the stamp, keeping their hand clear.');
    expect(repairPronouns('Liz wraps her arms around Biz and pulls him close.', people()))
      .toBe('Liz wraps her arms around Biz and pulls them close.');
  });

  it('follows the subject into the next sentence only when it is unambiguous', async () => {
    const { repairPronouns } = await import('../src/server/narrative-guards.js');
    expect(repairPronouns('Biz leans over the counter. He squints at the stamp.', people()))
      .toBe('Biz leans over the counter. Biz squints at the stamp.');
    // The previous sentence's subject is an NPC: leave it.
    expect(repairPronouns('The clerk stares at Biz. He frowns.', people()))
      .toBe('The clerk stares at Biz. He frowns.');
  });

  it('never touches NPCs, other named people, or dialogue', async () => {
    const { repairPronouns } = await import('../src/server/narrative-guards.js');
    const npc = 'Clerk Oswin Pell stamps the form and adjusts his spectacles.';
    expect(repairPronouns(npc, people())).toBe(npc);
    const shared = 'Biz watches Oswin adjust his spectacles.';
    expect(repairPronouns(shared, people())).toBe(shared);
    const noun = 'Biz hands the clerk his form.';
    expect(repairPronouns(noun, people())).toBe(noun);
    const quoted = 'Biz whispers, "He is watching us."';
    expect(repairPronouns(quoted, people())).toBe(quoted);
  });

  it('leaves a character with stated he/him alone', async () => {
    const { repairPronouns } = await import('../src/server/narrative-guards.js');
    const text = 'Liz pulls Biz close and places her hand on his shoulder.';
    expect(repairPronouns(text, [{ name: 'Liz', gender: 'f', aliases: [] }, { name: 'Biz', gender: 'm', aliases: [] }])).toBe(text);
  });

  it('turns "son"/"daughter" into "child" for a character with no stated gender', async () => {
    const { repairPronouns } = await import('../src/server/narrative-guards.js');
    expect(repairPronouns('Liz hugs her son Biz tightly.', people())).toBe('Liz hugs her child Biz tightly.');
    expect(repairPronouns("Biz, Liz's daughter, stares at the ceiling.", people())).toBe("Biz, Liz's child, stares at the ceiling.");
    // The possessive in "her son" is the parent's, even when the parent is not named here.
    expect(repairPronouns('Biz, her son, waits by the desk.', people())).toBe('Biz, her child, waits by the desk.');
    expect(repairPronouns('Liz hugs her son Biz tightly.', [{ name: 'Liz', gender: 'f', aliases: [] }, { name: 'Biz', gender: 'm', aliases: [] }]))
      .toBe('Liz hugs her son Biz tightly.');
  });

  it('runs on everything the loop broadcasts: DM narration, resolutions and actions', async () => {
    canned.narration = 'Liz pulls Biz close and places her hand on his shoulder as the queue lurches forward.';
    canned.resolution = 'Biz squints at the stamp, keeping his hand clear of the wet ink.';
    try {
      const { broadcasts } = await runLoop({ until: m => m.type === 'resolution' });
      const texts = [...narrations(broadcasts), ...broadcasts.filter(m => m.type === 'resolution').map(m => (m as any).text as string)];
      expect(texts.some(t => t.includes('places her hand on their shoulder'))).toBe(true);
      expect(texts.some(t => t.includes('keeping their hand clear'))).toBe(true);
      expect(texts.join('\n')).not.toMatch(/\bhis (shoulder|hand)\b/);
    } finally {
      canned.narration = 'A bell dings somewhere down the queue, and Clerk Oswin Pell looks up from a towering stack of forms.';
      canned.resolution = 'The form rustles; the clerk grunts and waves them on.';
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
