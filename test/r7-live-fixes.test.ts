// Round 7: what the round-6 live verification (game X95BPY; Liz she/her,
// Biz they/them; NPCs Quillwick he, Mayor Penstroke he, Pip "its") still got
// wrong. Each block quotes the live line.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterDefinition, RoomState, WorldSeed } from '../src/shared/types.js';
import type { ServerMessage } from '../src/shared/protocol.js';
import { pluralVerb } from '../src/shared/pronouns.js';
import {
  findPronounConflicts, repairGenderedNouns, guardInterviewReply,
} from '../src/server/pronoun-consistency.js';
import {
  withoutPartyEntities, sheetPhrases, isSheetPhraseName, sheetPhrasesToNames, optionsWithoutSheetBeings, namesInNarration,
} from '../src/server/narrative-guards.js';
import { npcPronounInNarration, askWhatHidingChip, hearThemOutChip } from '../src/server/whisper-suggestions.js';
import { ReadingClock, WINDOW_READ_OVERLAP_MAX_MS } from '../src/server/pacing.js';

process.env.WHISPER_WINDOW_MS = '30';

type Msg = { role: string; content: string };
const llmCalls: Msg[][] = [];
const canned = {
  narration: 'A bell dings, and Quillwick looks up from a towering stack of forms.',
  resolution: 'The form rustles; the clerk grunts and waves them on.',
  epilogue: 'The Registry fell quiet behind them.',
  activeNpcs: [] as string[],
  proposals: undefined as string[] | undefined,
};

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    llmCalls.push(opts.messages);
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('OPENING OF THE ADVENTURE')) return { narration: 'The Registry hums.', introductions: [], currentLocationName: '' };
    if (all.includes('Pacing:')) return { narration: canned.narration, currentLocationName: 'The Grand Registry Hall', activeNpcs: canned.activeNpcs, isSceneEnd: false };
    if (all.includes('Propose 2-4 actions')) {
      if (canned.proposals) return { actions: canned.proposals.map(description => ({ description, reasoning: 'r' })) };
      return { actions: [{ description: 'I take a numbered ticket from the dispenser', reasoning: 'queue' }, { description: 'I ask the clerk where we are', reasoning: 'talk' }] };
    }
    if (all.includes('Choose your action now')) return { chosenAction: 'I study the stamp on the nearest form very carefully', spokenWords: null, innerThought: 'Forms.', whisperedInfluence: 'ignored', trustDelta: 0 };
    if (all.includes('FATE resolution steps')) return { diceExpression: '4dF', difficulty: 0, skill: 'Notice', outcome: 'success', narration: canned.resolution, stateChanges: [] };
    if (all.includes('Summarize')) return { summary: 'The queue moved.' };
    if (all.includes('helping set up a new game')) return { reply: 'Lovely.', done: false, influences: [], dmInstructions: null, dmCustomPrompt: null };
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
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r7-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

const M = [{ name: 'Liz', pronouns: 'she/her' }, { name: 'Biz', pronouns: 'they/them' }];
const NPCS = ['Quillwick', 'Mayor Penstroke', 'Pip'];

// ─── 1. Biz still "he" in a resolution and in the epilogue ─────────────────

// The live resolution, around its three quoted fragments.
const RIDDLE = "Biz's voice rings clear as he declares 'A letter.' The riddle-door sighs, and a storm of parchment wings swirls around him. Liz steps beside Biz, her hand resting reassuringly on his shoulder.";

describe('1. the riddle resolution: detection fired, the repair was thrown away', () => {
  it('detection: all three sentences are flagged ("Biz\'s" names Biz; the quote does not hide it)', () => {
    const found = findPronounConflicts(RIDDLE, M, { actor: 'Biz', npcNames: NPCS });
    expect(new Set(found.map(c => c.sentence))).toEqual(new Set([
      "Biz's voice rings clear as he declares 'A letter.'",
      'The riddle-door sighs, and a storm of parchment wings swirls around him.',
      'Liz steps beside Biz, her hand resting reassuringly on his shoulder.',
    ]));
  });

  // Round 9: the pronoun rewrite is gone (it did more harm than good with
  // qwen — see pronoun-consistency.ts). Detection still logs; the text is
  // left as written, and only a gendered noun naming a member is repaired.
  it('since round 9 no pronoun is rewritten: the riddle resolution is left as written', () => {
    expect(repairGenderedNouns(RIDDLE, M)).toBe(RIDDLE);
    const epilogue = 'Biz could still feel the invisible bureaucratic pressure pulse through his chest.';
    expect(repairGenderedNouns(epilogue, M)).toBe(epilogue);
  });

  it('why the epilogue was missed: the trouble, stored as an NPC, made "After" a name', () => {
    const text = 'After the last stamp thudded home, Biz could still feel the invisible bureaucratic pressure pulse through his chest.';
    // With the polluted NPC list: the sentence "names an NPC" and is skipped.
    expect(findPronounConflicts(text, M, { npcNames: [...NPCS, 'Wanders Off After Anything Shiny'] })).toEqual([]);
    // With the list cleaned (see 2.), it is Biz's.
    expect(findPronounConflicts(text, M, { npcNames: NPCS }).map(c => [c.name, c.word])).toEqual([['Biz', 'his']]);
  });

  it('NPC safety: NPC and companion pronouns are never touched', () => {
    for (const t of ['Biz shows Quillwick the letter, and he grins.', 'Quillwick sets down his quill. Biz nods at him.', 'Biz leans into her embrace.']) {
      expect(repairGenderedNouns(t, M)).toBe(t);
    }
  });

  it('pluralVerb agrees a he/she verb with they', () => {
    expect(['declares', 'watches', 'carries', 'is', 'has', 'does', 'goes', 'passes', 'sees', 'lies', "doesn't", 'declared', 'can'].map(pluralVerb))
      .toEqual(['declare', 'watch', 'carry', 'are', 'have', 'do', 'go', 'pass', 'see', 'lie', "don't", 'declared', 'can']);
  });
});

// ─── 2. A trouble is not a creature ────────────────────────────────────────

const BIZ_SHEET = {
  highConcept: 'Curious Kid With a Sketchbook',
  trouble: 'Wanders Off After Anything Shiny',
  aspects: ['Pocket Full of Bottle Caps', 'Fits Where Adults Cannot'],
  stunts: ['Small and Quick: +2 to Stealth in tight spaces.'],
};
const LIZ_SHEET = {
  highConcept: 'Office Manager Who Speaks Fluent Bureaucracy',
  trouble: 'Cannot Stop Managing Everyone',
  aspects: ['Always Has Snacks'],
  stunts: ['Mom Voice: +2 to Provoke when someone is endangering a child.'],
};
const OWNERS = [{ name: 'Liz', phrases: sheetPhrases(LIZ_SHEET) }, { name: 'Biz', phrases: sheetPhrases(BIZ_SHEET) }];

describe('2. sheet phrases are traits, never beings', () => {
  it('sheetPhrases: high concept, trouble, aspects and stunt names', () => {
    expect(sheetPhrases(BIZ_SHEET)).toEqual(['Curious Kid With a Sketchbook', 'Wanders Off After Anything Shiny', 'Pocket Full of Bottle Caps', 'Fits Where Adults Cannot', 'Small and Quick']);
  });

  it('the extractor never stores a trouble, an aspect or a fragment of one as an entity', () => {
    const phrases = [...sheetPhrases(BIZ_SHEET), ...sheetPhrases(LIZ_SHEET)];
    const facts = { newEntities: ['Wanders Off After Anything Shiny', 'the Wanders Off After Anything Shiny', '"Wanders Off After Anything Shiny"', 'Office Manager Who Speaks Fluent Bureaucracy', 'Quillwick', 'Pip', 'Mayor Penstroke'].map(name => ({ name })) };
    expect(withoutPartyEntities(facts, ['Liz', 'Biz'], ['Mom'], phrases).newEntities.map(e => e.name)).toEqual(['Quillwick', 'Pip', 'Mayor Penstroke']);
    // Only the whole phrase: a part of one may be a real NPC's name.
    expect(isSheetPhraseName('Shiny', phrases)).toBe(false);
    expect(isSheetPhraseName('Quillwick the Archivist', ['Quillwick the Archivist Owes Me'])).toBe(false);
  });

  it('DM prose: the apposition is dropped, the noun becomes the owner', () => {
    expect(sheetPhrasesToNames('Near the ledger, a shimmering paper sprite—Wanders Off After Anything Shiny—flits toward a glittering golden stamp.', OWNERS))
      .toBe('Near the ledger, a shimmering paper sprite flits toward a glittering golden stamp.');
    expect(sheetPhrasesToNames("Above the shelf, the wandering 'Wanders Off After Anything Shiny' hovers.", OWNERS))
      .toBe('Above the shelf, Biz hovers.');
  });

  it('left alone: an invocation, a possessive, the compel lines, the plain verb, quoted speech', () => {
    const keep = [
      'Liz draws on Office Manager Who Speaks Fluent Bureaucracy, and the clerk relents.',
      "Biz's Wanders Off After Anything Shiny kicks in at the worst moment.",
      'Biz feels the pull of old habits — "Wanders Off After Anything Shiny" — and the universe grants a small mercy in return.',
      'But "Wanders Off After Anything Shiny" rears its head, complicating everything — though fate offers Biz a consolation.',
      '"Wanders Off After Anything Shiny" — the words could be Biz\'s motto. But fate is generous to those it tests.',
      'Biz\'s "Wanders Off After Anything Shiny" makes itself known at precisely the wrong moment — as it always does.',
      'Biz wanders off after anything shiny, as always.',
      'Biz — Wanders Off After Anything Shiny, 10 years old.',
      '"Is that the Wanders Off After Anything Shiny?" Pip asks.',
    ];
    for (const t of keep) expect(sheetPhrasesToNames(t, OWNERS)).toBe(t);
  });

  it('options: a companion\'s trait becomes their name; my own trait as a being is dropped', () => {
    const liz = optionsWithoutSheetBeings([{ description: 'Hold up the letter, warning the Wanders Off not to distract us' }, { description: 'Ask Quillwick about the stair' }], 'Liz', OWNERS);
    expect(liz.map(o => o.description)).toEqual(['Hold up the letter, warning Biz not to distract us', 'Ask Quillwick about the stair']);
    const biz = optionsWithoutSheetBeings([
      { description: 'I follow Wanders Off After Anything Shiny toward the sealed shelf' },
      { description: 'I sketch the riddle-door' },
      { description: 'I ask Pip about the stamp' },
    ], 'Biz', OWNERS);
    expect(biz.map(o => o.description)).toEqual(['I sketch the riddle-door', 'I ask Pip about the stamp']);
  });
});

// ─── 3. Chips use the NPC's pronoun from narration ─────────────────────────

describe('3. "Ask Pip what they\'re hiding" while narration says "its"', () => {
  it('reads the pronoun narration uses for the NPC, or falls back to the name', () => {
    const narration = 'Pip flutters its paper wings and settles on the shelf. Liz watches her step. Quillwick taps his pen.';
    expect(npcPronounInNarration('Pip', narration, ['Liz', 'Biz'])).toBe('it');
    expect(npcPronounInNarration('Quillwick', narration, ['Liz', 'Biz'])).toBe('he');
    expect(npcPronounInNarration('Mayor', 'The Mayor waits.', ['Liz', 'Biz'])).toBe(null);
    expect(askWhatHidingChip('Pip', 'it')).toBe("Ask Pip what it's hiding.");
    expect(askWhatHidingChip('Pip', null)).toBe('Ask Pip what Pip is hiding.');
    expect(hearThemOutChip('Pip', 'it')).toBe('Pip might be an ally. Hear it out.');
  });
});

// ─── 4. "calls Liz Mom" is left alone ──────────────────────────────────────

describe('4. a sentence that states the address term keeps it', () => {
  const terms = [{ name: 'Liz', address: 'Mom' }];
  it('in narration and in the interview summary', async () => {
    for (const t of [
      'Biz is a curious kid who wanders off after anything shiny, and calls Liz Mom.',
      'Biz is a curious kid who wanders off after anything shiny, and calls her Mom.',
      "Biz is a curious kid who wanders off after anything shiny, and calls Liz 'Mom'.",
      'Biz is a curious kid who wanders off after anything shiny, and calls her Mom, Liz.',
      'Biz is a curious kid who wanders off after anything shiny, and calls Mom Liz.',
    ]) {
      expect(namesInNarration(t, terms)).toBe(t);
      expect(guardInterviewReply(t, { name: 'Biz', pronouns: 'they/them', relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }] }, ['Liz'])).toBe(t);
    }
    // Still repaired where the term is used AS a name.
    expect(namesInNarration('Biz steadies Mom.', terms)).toBe('Biz steadies Liz.');
    expect(namesInNarration('So Biz is traveling with their mom Liz.', terms)).toBe('So Biz is traveling with Liz.');
  });
});

// ─── 5. No spoilers in the world interview ─────────────────────────────────

describe('5. a host who asks for no spoilers gets none, in every reply', () => {
  it('the setup-chat prompt carries the spoiler-free rule once the host asks', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    llmCalls.length = 0;
    await new DmAgent(db).setupChat({
      preset: 'chronicler', systemId: 'fate-core', unmet: [],
      history: [{ role: 'user', content: "No spoilers for me please, I'm playing in it too." }, { role: 'assistant', content: 'Understood!' }, { role: 'user', content: 'Something bureaucratic and cosy.' }],
    });
    const system = llmCalls[0]![0]!.content;
    expect(system).toMatch(/SPOILER-FREE HOST/);
    expect(system).toMatch(/EVERY reply/);
    expect(system).toMatch(/may NOT list or describe the NPCs/);
    expect(system).toMatch(/plot hooks/);
  });

  it('…and not for a host who has not asked (and is not playing)', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    llmCalls.length = 0;
    await new DmAgent(db).setupChat({ preset: 'chronicler', systemId: 'fate-core', unmet: [], history: [{ role: 'user', content: 'Something cosy.' }] });
    expect(llmCalls[0]![0]!.content).not.toMatch(/SPOILER-FREE HOST/);
  });

  it('a reply that repeats the drafted plot hook or an NPC motive loses those sentences', async () => {
    // Imported here: world-seed opens the database, which must be the test's.
    const { withoutSeedSpoilers } = await import('../src/server/world-seed.js');
    const seed: WorldSeed = {
      premise: 'A registry of lost letters.',
      locations: [{ name: 'The Grand Registry Hall', description: 'x', terrain: 'interior' }],
      npcs: [{ name: 'Quillwick', description: 'An archivist.', disposition: 'kind', motivation: 'Keep the hidden stair a secret from the Mayor.' }],
      plotHooks: ['A letter addressed to nobody has been stamped urgent.'],
      items: [],
    };
    const reply = 'Wonderful — cosy bureaucracy it is. Quillwick wants to keep the hidden stair a secret from the Mayor. And a letter addressed to nobody has been stamped urgent! What tone should the danger have?';
    expect(withoutSeedSpoilers(reply, seed)).toBe('Wonderful — cosy bureaucracy it is. What tone should the danger have?');
    expect(withoutSeedSpoilers('Cosy it is. What tone?', seed)).toBe('Cosy it is. What tone?');
  });
});

// ─── 7. Pacing: the whisper window opens under the tail of the reading ─────

describe('7. the whisper window may overlap the last beat\'s reading', () => {
  it('half the last beat, at most 4s, runs under the open window', () => {
    let now = 0;
    const clock = new ReadingClock({ wordsPerSec: 3.5, minMs: 1500, maxMs: 8000 }, () => now);
    clock.mark({ type: 'narration', text: Array(60).fill('word').join(' '), sceneNumber: 1 });
    expect(clock.remainingMs()).toBe(8000);
    expect(clock.remainingBeforeWindowMs()).toBe(8000 - WINDOW_READ_OVERLAP_MAX_MS);
    now = 3000; // the next character's options call took 3s
    expect(clock.remainingBeforeWindowMs()).toBe(1000);
    clock.hold();
    expect(clock.remainingBeforeWindowMs()).toBe(5000); // paused: the full rest
  });
});

// ─── In play ────────────────────────────────────────────────────────────────

const LIZ: CharacterDefinition = {
  name: 'Liz', backstory: 'An office manager from Ohio.', personality: 'Wry.', ...LIZ_SHEET,
  skills: { Will: 3, Rapport: 2, Notice: 1 }, age: 38, pronouns: 'she/her',
  relationships: [{ to: 'Biz', relation: 'kid', address: 'Biz' }],
};
const BIZ: CharacterDefinition = {
  name: 'Biz', backstory: 'Ten years old.', personality: 'Curious.', ...BIZ_SHEET,
  skills: { Notice: 3, Athletics: 2, Stealth: 1 }, age: 10, pronouns: 'they/them',
  relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }],
};
const STATE = { stress: 0, consequences: [] as string[], fatePoints: 3, inventory: [] as string[], xpMilestones: [] as string[], whisperTrust: 0.65 };
const SEED: WorldSeed = {
  premise: 'A registry of lost letters, where Liz and Biz arrive by mistake.',
  locations: [{ name: 'The Grand Registry Hall', description: 'Endless pigeonholes.', terrain: 'interior' }, { name: 'The Sealed Shelf', description: 'Locked.', terrain: 'interior' }],
  npcs: [
    { name: 'Quillwick', description: 'An archivist.', disposition: 'kind', motivation: 'Keep order.' },
    { name: 'Pip', description: 'A paper bird.', disposition: 'curious', motivation: 'Deliver.' },
    { name: 'Mayor Penstroke', description: 'The mayor.', disposition: 'stern', motivation: 'Order.' },
  ],
  plotHooks: ['A letter addressed to nobody.'],
  items: [],
};

let seq = 0;
async function runLoop(opts: { until: (m: ServerMessage) => boolean; setup?: (campaignId: string) => void; endGame?: boolean }) {
  const { createRoom } = await import('../src/server/room.js');
  const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
  const { GameLoop } = await import('../src/server/game-loop.js');
  const { campaignId, joinCode } = createRoom(db, { name: `R7 ${++seq}`, dmPreset: 'chronicler', systemId: 'fate-core' });
  setWorldSeed(db, campaignId, SEED);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, SEED);
  db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)').run(`liz-r7-${seq}`, campaignId, JSON.stringify(LIZ), JSON.stringify(STATE));
  db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)').run(`biz-r7-${seq}`, campaignId, JSON.stringify(BIZ), JSON.stringify(STATE));
  opts.setup?.(campaignId);
  const state: RoomState = { campaignId, joinCode, phase: 'playing', currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null };
  const broadcasts: ServerMessage[] = [];
  const before = llmCalls.length;
  let loop!: InstanceType<typeof GameLoop>;
  const done = new Promise<void>((resolve) => {
    const on = (m: ServerMessage) => { broadcasts.push(m); if (opts.until(m)) setImmediate(() => { loop.stop(); resolve(); }); };
    loop = new GameLoop(db, campaignId, on, () => {}, state, (_id, m) => on(m));
  });
  const running = loop.start().catch((e) => { console.error('LOOP FAILED', e); });
  await Promise.race([done, new Promise(r => setTimeout(r, 15_000))]);
  loop.stop();
  await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
  if (opts.endGame) await loop.endGame();
  return { broadcasts, calls: llmCalls.slice(before).map(c => c.map(m => m.content).join('\n')), campaignId, loop };
}

describe('in play', () => {
  it('2/3. a polluted trouble row is retired, never a chip or a present NPC; the DM is told traits are not beings; Pip is "it"', async () => {
    const savedNarration = canned.narration;
    canned.narration = 'Pip flutters its paper wings above the counter, and a shimmering paper sprite—Wanders Off After Anything Shiny—flits toward a glittering golden stamp.';
    canned.activeNpcs = ['Pip', 'Wanders Off After Anything Shiny'];
    try {
      const { broadcasts, calls, campaignId } = await runLoop({
        setup: (cid) => db.prepare("INSERT INTO entities (id, campaign_id, type, name, alive) VALUES (?, ?, 'npc', 'Wanders Off After Anything Shiny', 1)").run(`wo-${cid}`, cid),
        until: m => m.type === 'whisper-guidance',
      });
      const shown = broadcasts.filter(m => m.type === 'narration').map(m => (m as { text: string }).text).join('\n');
      expect(shown).toContain('a shimmering paper sprite flits toward a glittering golden stamp');
      expect(shown).not.toContain('sprite—Wanders Off');
      const row = db.prepare("SELECT alive FROM entities WHERE campaign_id = ? AND name = 'Wanders Off After Anything Shiny'").get(campaignId) as { alive: number };
      expect(row.alive).toBe(0);
      const guidance = broadcasts.find(m => m.type === 'whisper-guidance') as Extract<ServerMessage, { type: 'whisper-guidance' }>;
      const chips = guidance.suggestions.join(' ');
      expect(chips).not.toMatch(/Wanders/);
      expect(chips).not.toMatch(/what they're hiding|Hear them out/);
      expect(calls.some(c => /troubles, aspects and stunts are character traits — never beings/i.test(c))).toBe(true);
    } finally {
      canned.narration = savedNarration;
      canned.activeNpcs = [];
    }
  }, 30_000);

  it('1. since round 9 the live resolution reaches the table as written — no rewrite is asked for', async () => {
    canned.resolution = RIDDLE;
    try {
      const { broadcasts, calls } = await runLoop({ until: m => m.type === 'resolution' });
      const res = broadcasts.find(m => m.type === 'resolution') as Extract<ServerMessage, { type: 'resolution' }>;
      expect(res.text).toContain("Biz's voice rings clear as he declares 'A letter.'");
      expect(calls.some(c => c.includes('You correct how people are referred to'))).toBe(false);
    } finally {
      canned.resolution = 'The form rustles; the clerk grunts and waves them on.';
    }
  }, 30_000);

  it('6. the ending knows where the party is and who did what', async () => {
    const saved = canned.resolution;
    canned.resolution = 'Quillwick smiles and presses a hidden latch; the stair yawns open.';
    try {
      const { calls } = await runLoop({
        until: m => m.type === 'resolution',
        endGame: true,
        setup: (cid) => {
          for (const who of ['liz', 'biz']) {
            const id = `${who}-r7-${seq}`;
            db.prepare("INSERT INTO character_memories (id, character_id, campaign_id, scene_number, turn_number, type, content, importance) VALUES (?, ?, ?, 1, 1, 'event', ?, 0.9)").run(`m7-${id}`, id, cid, 'We found a stair.');
          }
        },
      });
      const epilogue = calls.find(c => c.includes('session epilogues'))!;
      expect(epilogue).toContain('Quillwick smiles and presses a hidden latch; the stair yawns open.');
      expect(epilogue).toMatch(/Credit every deed to whoever did it/);
      expect(epilogue).toMatch(/Where the party is as the session ends: The Grand Registry Hall/);
      const reflection = calls.find(c => c.includes('closing reflection'))!;
      expect(reflection).toMatch(/you are in The Grand Registry Hall\. You are already there/);
      expect(reflection).toContain('Quillwick smiles and presses a hidden latch');
    } finally {
      canned.resolution = saved;
    }
  }, 30_000);

  it('6. narration is told not to invent a chair', async () => {
    const { calls } = await runLoop({ until: m => m.type === 'whisper-prompt' });
    expect(calls.some(c => c.includes('Do not give a character a chair, a seat, a posture or a prop the story has not set up'))).toBe(true);
  }, 30_000);
});
