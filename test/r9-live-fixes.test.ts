// Round 9: what the round-8 live verification (game E9W9YT; qwen/qwen3.8-27b;
// Liz she/her, Biz they/them, Biz is ten) still got wrong. Each block quotes
// the live line.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition, WorldSeed } from '../src/shared/types.js';
import { repairGenderedNouns, neutralSetupNouns, sheetWithNeutralNouns, guardInterviewReply } from '../src/server/pronoun-consistency.js';
import { narratesItemTransfer, beatOverlap, repeatsRecentBeat, softenForChildren } from '../src/server/narrative-guards.js';
import { statedAddressTerms, withStatedAddressTerms, mergeCharacterDraft, addressDescribesSelf } from '../src/server/character-interview.js';
import { withoutSetupFieldDumps, withoutSeedSpoilers, seedWithHostNouns } from '../src/server/world-seed.js';
import { normalizeInfluences, influenceKey } from '../src/server/world-readiness.js';
import { assembleSystemPrompt, childToneRule } from '../src/server/agents/dm.js';

type Msg = { role: string; content: string };
const calls: Array<{ messages: Msg[] }> = [];

// The live repeated narration (replay log seq 24, then seq 35 a round later).
const BEAT_24 = "The Queue Manager’s stopwatch emits a final, bone-rattling *click*, and the air suddenly tastes of burnt toast and ozone as a heavy, iron-shuttered door slams shut behind the line with a thud that shakes the dust from the painted ceiling. Clerk 734, still entangled in his bow tie, squeaks that the 'Basement' requires a 'Level Two Clearance Stamp' which is currently 'stuck in the mail,' while the Cloud Child drifts closer, its mist releasing a low, humming tone that vibrates in Biz’s chest like a plucked string. The brass clip skitters out from under the ledger, not toward Biz, but directly toward the newly opened gap in the floor where a draft of cool, lavender-scented air exhales, pulling at their shirt like an invisible hand.";
const BEAT_35 = "The Queue Manager’s stopwatch emits a sharp, final *chime*, and the air suddenly tastes of burnt toast and ozone as the heavy iron shutter behind the line slams shut with a thud that shakes the dust from the painted ceiling. Clerk 734, still entangled in his bow tie, squeaks that the 'Basement' requires a 'Level Two Clearance Stamp' which is currently 'stuck in the mail,' while the Cloud Child drifts closer, its mist releasing a low, humming tone that vibrates in Biz’s chest like a plucked string. The brass clip skitters out from under the ledger, not toward Biz, but directly toward the newly opened gap in the floor where a draft of cool, lavender-scented air exhales, pulling at their shirt like an invisible hand.";
const BEAT_46 = "The Queue Manager’s whistle shrieks, a thin, piercing note that vibrates in Liz’s molars, snapping the moment as she turns to face a new arrival: a broad-shouldered man in a linen suit who is already shoving a crumpled form into her hands, his breath smelling of stale coffee and desperation.";
const FRESH = 'A trolley of unfiled ledgers rattles past, and Clerk 734 waves a pink form at the Cloud Child: "Name, rank and weather pattern, please."';

const play = {
  /** What narrate() returns, call by call (the last one repeats). */
  narrations: [BEAT_24] as string[],
  /** What narrate() returns when told it repeated a beat. */
  retry: FRESH,
  narrateCalls: 0,
};

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push(opts);
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('OPENING OF THE ADVENTURE')) return { narration: 'The Atrium hums.', introductions: [], currentLocationName: '' };
    if (all.includes('Choose your action now')) return { chosenAction: 'I read the fine print on the nearest form', spokenWords: null, innerThought: 'Forms.', whisperedInfluence: 'ignored', trustDelta: 0 };
    if (all.includes('Propose 2-4 actions')) return { actions: [{ description: 'I read the fine print on the nearest form', reasoning: 'r' }, { description: 'I ask Clerk 734 for a number', reasoning: 'r' }] };
    if (all.includes('FATE resolution steps')) return { diceExpression: '4dF', difficulty: 1, skill: 'Notice', outcome: 'success', narration: 'The form yields a footnote nobody has read in a century.', stateChanges: [] };
    if (all.includes('Pacing:')) {
      if (all.includes('<repeated>')) return { narration: play.retry, currentLocationName: '', activeNpcs: [], isSceneEnd: false };
      const text = play.narrations[Math.min(play.narrateCalls, play.narrations.length - 1)]!;
      play.narrateCalls++;
      return { narration: text, currentLocationName: '', activeNpcs: [], isSceneEnd: false };
    }
    if (all.includes('Summarize')) return { summary: 'The queue moved.' };
    return 'ok';
  }),
}));

process.env.WHISPER_WINDOW_MS = '30';
process.env.PACE_MAX_MS = '0';

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r9-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

const LIZ = { name: 'Liz', pronouns: 'she/her', relationships: [{ to: 'Biz', relation: 'kid' }] };
const BIZ = { name: 'Biz', pronouns: 'they/them', relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }] };
const PARTY = [LIZ, BIZ];

// ─── 1. No pronoun rewrite; only gendered nouns that name a member ─────────

describe('1. pronouns are never rewritten; a gendered noun naming a member is', () => {
  // The rewrite caused these live. The pre-rewrite prose (she / his / he / her)
  // must now reach the table exactly as written.
  it('the live lines the strict rewrite broke are left as written', () => {
    for (const t of [
      'The cap ricochets off the amber railing, drawing the Queue Manager’s silent, stony gaze directly to Liz. She flinches, not from the sound, but from the sudden, sharp pressure of the Manager’s stopwatch clicking shut.',
      'Biz’s small hand is suddenly, tightly wrapped around her fingers, their knuckles white.',
      "The Linen-Suited Man steps from the swirling violet mist and places a trembling hand on Liz's shoulder. 'I know you can't say no, Liz,' he whispers.",
      'Biz, standing just behind her, watches the clerk’s bow tie tighten around his neck.',
    ]) expect(repairGenderedNouns(t, PARTY)).toBe(t);
  });

  it('"her son Biz", "the boy Biz", "Biz, her son," and "Liz\'s son" become "kid" for a they/them Biz', () => {
    expect(repairGenderedNouns('Liz and her ten-year-old son Biz step up to Counter 4B.', PARTY)).toBe('Liz and her ten-year-old kid Biz step up to Counter 4B.');
    expect(repairGenderedNouns('The boy Biz tugs at the ledger.', PARTY)).toBe('Biz tugs at the ledger.');
    expect(repairGenderedNouns('Biz, her son, tugs at the ledger.', PARTY)).toBe('Biz, her kid, tugs at the ledger.');
    expect(repairGenderedNouns("Clerk 734 peers at Liz's son over his spectacles.", PARTY)).toBe("Clerk 734 peers at Liz's kid over his spectacles.");
    expect(repairGenderedNouns("Liz's little boy tugs at the ledger.", PARTY)).toBe("Liz's little kid tugs at the ledger.");
  });

  it('the opposite gender gets the counterpart; a noun that fits is kept', () => {
    const ana = [{ name: 'Ana', pronouns: 'she/her' }];
    expect(repairGenderedNouns('The boy Ana grins.', ana)).toBe('The girl Ana grins.');
    expect(repairGenderedNouns('Her son Tom waves.', [{ name: 'Tom', pronouns: 'he/him' }])).toBe('Her son Tom waves.');
  });

  it('never where the referent is not certain', () => {
    // "the boy" alone, "her son" alone, and "Liz's son" when Liz has two children or one outside the party.
    for (const t of ['The boy at the stall waves.', 'Liz hugs her son.', 'Biz watches a boy chase paper cranes.', "Liz's glance at the boy is quick."]) {
      expect(repairGenderedNouns(t, PARTY)).toBe(t);
    }
    const twoKids = [{ name: 'Liz', pronouns: 'she/her', relationships: [{ to: 'Biz', relation: 'kid' }, { to: 'Ozzy', relation: 'son' }] }, BIZ, { name: 'Ozzy', pronouns: 'he/him' }];
    expect(repairGenderedNouns("Liz's son waves.", twoKids)).toBe("Liz's son waves.");
    const kidOutside = [{ name: 'Liz', pronouns: 'she/her', relationships: [{ to: 'Biz', relation: 'kid' }, { to: 'Tomas', relation: 'son' }] }, BIZ];
    expect(repairGenderedNouns("Liz's son waves.", kidOutside)).toBe("Liz's son waves.");
    // Unstated pronouns: DM prose leaves them; the setup and sheets treat them as they/them.
    const unstated = [{ name: 'Liz', pronouns: 'she/her' }, { name: 'Biz', pronouns: null }];
    expect(repairGenderedNouns('her son Biz', unstated)).toBe('her son Biz');
    expect(repairGenderedNouns('her son Biz', unstated, { neutralWhenUnknown: true })).toBe('her kid Biz');
  });
});

// ─── 2. Gender assigned before pronouns were known ─────────────────────────

const HOST = [
  "I'm playing in this one, so no spoilers for me please — keep the NPCs' secrets and plot twists hidden from me.",
  "Premise: a mom, Liz, and her 10-year-old kid, Biz, get isekai'd into a Discworld-ish bureaucratic fantasy world because of a paperwork error at the Department of Summonings. Comedic, warm, a bit absurd.",
];
const LIVE_PREMISE = 'Liz and her ten-year-old son Biz have been deposited into the Grand Arrivals Atrium of the Department of Summonings due to a clerical error, and must now navigate an endless, whimsical bureaucracy to process their existence.';
const LIVE_BACKSTORY = 'Liz works in insurance claims and understands bureaucracy. She and her ten-year-old son Biz were deposited into the Grand Arrivals Atrium due to a clerical error.';
const LIVE_DMC = `You are the DM for a FATE Core game. The setting is a whimsical yet oppressive bureaucratic fantasy world (Discworld meets Brazil meets Spirited Away). The tone is comedic, warm, and absurd.
**Premise:** Liz and her 10-year-old son Biz were isekai'd due to a paperwork error at the Department of Summonings.
**Starting Location:** The Grand Arrivals Atrium. Vast, circular, painted sky ceiling, uneven marble floors, hundreds of concentric desks. Smells of old paper, lavender, and burnt toast.
**Current Situation:** Liz and Biz are in the Queue for Counter 4B. They have no file number. The previous clerk vanished, leaving a receipt and a note: "Check the Basement. Bring snacks." The only downward door says "RESTROOMS – MEN ONLY" (clearly a joke, but risky).
**Key NPCs:**
1. **Clerk 734:** Small, round, saucer spectacles, oversized bow tie. Polite, speaks in jargon, hasn't blinked in 45 mins. Impatient.
2. **The Queue Manager:** Tall, thin, severe bun, stopwatch, whistle. Doesn't speak. Taps foot in jazz rhythm. Eye contact causes an urge to apologize for existence.
**Safety Filter:** Strictly kid-friendly. No horror, violence, or gore. Only mild bureaucratic anxiety.
**Goal:** Help Liz and Biz navigate the queue, find a way to process their file (or find the "Basement"), and establish their FATE cards. Keep the humor dry, the world vibrant, and the stakes low but emotionally resonant.`;

describe('2a. the setup and the seed use the host\'s relation words', () => {
  it('the live seed premise: "son" → "kid", because the host said "kid"', () => {
    expect(neutralSetupNouns(LIVE_PREMISE, HOST)).toBe('Liz and her ten-year-old kid Biz have been deposited into the Grand Arrivals Atrium of the Department of Summonings due to a clerical error, and must now navigate an endless, whimsical bureaucracy to process their existence.');
    const seed: WorldSeed = { premise: LIVE_PREMISE, locations: [], npcs: [], plotHooks: ['Liz and her son Biz have no file number.'], items: [] };
    const fixed = seedWithHostNouns(seed, HOST);
    expect(fixed.premise).toContain('her ten-year-old kid Biz');
    expect(fixed.plotHooks[0]).toBe('Liz and her kid Biz have no file number.');
  });

  it('a noun the host used themselves is theirs', () => {
    expect(neutralSetupNouns('Liz and her son Biz arrive.', ['A mom, Liz, and her son Biz.'])).toBe('Liz and her son Biz arrive.');
  });

  it('the sheet that copied it: Liz\'s live backstory, while Biz\'s pronouns are unknown', () => {
    const sheet = { name: 'Liz', pronouns: 'she/her', backstory: LIVE_BACKSTORY, highConcept: 'Claims Adjuster Who Reads the Fine Print', relationships: [{ to: 'Biz', relation: 'kid' }] };
    const fixed = sheetWithNeutralNouns(sheet, [{ name: 'Liz', pronouns: 'she/her' }, { name: 'Biz', pronouns: null }]);
    expect(fixed.backstory).toBe('Liz works in insurance claims and understands bureaucracy. She and her ten-year-old kid Biz were deposited into the Grand Arrivals Atrium due to a clerical error.');
  });

  it('every DM prompt reads the stored direction with "kid"', () => {
    const { systemPrompt } = assembleSystemPrompt({
      preset: 'chronicler', dmCustomPrompt: LIVE_DMC, houseRules: null, dmInstructions: null, campaignMaterials: null, influences: [],
      party: [{ name: 'Liz', highConcept: 'x', pronouns: 'she/her', relationships: [{ to: 'Biz', relation: 'kid' }] }, { name: 'Biz', highConcept: 'y', pronouns: 'they/them', age: 10 }],
    });
    expect(systemPrompt).toContain('Liz and her 10-year-old kid Biz');
    expect(systemPrompt).not.toMatch(/son Biz/);
  });

  it('the setup chat and world-seed prompts forbid gendering the host\'s characters', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    const before = calls.length;
    await new DmAgent(db).setupChat({ preset: 'chronicler', systemId: 'fate-core', history: [{ role: 'user', content: HOST[1]! }], unmet: [] }).catch(() => null);
    await new DmAgent(db).draftWorldSeed({ preset: 'chronicler', systemId: 'fate-core', influences: [], dmInstructions: '', history: [], existing: null }).catch(() => null);
    const prompts = calls.slice(before).map(c => c.messages[0]!.content);
    expect(prompts.find(p => p.includes('helping set up a new game'))).toMatch(/never give the host's player characters a gender/);
    expect(prompts.find(p => p.includes('world builder'))).toMatch(/never give the host's player characters a gender/);
  });
});

describe('2b. the interview talks about another member by name until their pronouns are known', () => {
  it('the prompt carries each table member\'s pronouns, or says to use the name', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    const run = async (pronouns: string | null) => {
      const before = calls.length;
      await new DmAgent(db).interviewForCharacter({
        systemId: 'fate-core', preset: 'chronicler', playerName: 'Liz', influences: [], seed: null,
        history: [{ role: 'user', content: 'My character is Liz (she/her). Her kid Biz calls her Mom.' }], unmet: [],
        tableCharacters: [{ name: 'Biz', highConcept: 'Pocket Full of Found Things', pronouns }],
      }).catch(() => null);
      return calls.slice(before).map(c => c.messages[0]!.content).join('\n');
    };
    expect(await run(null)).toMatch(/Biz: Pocket Full of Found Things — pronouns NOT known to you: call Biz by name, never he\/him\/his or she\/her/);
    expect(await run(null)).toContain('never "she calls you Mom"');
    expect(await run('they/them')).toContain('Biz: Pocket Full of Found Things — pronouns they/them');
  });

  it('a gendered noun for a companion in the interview reply becomes "kid"; the pronoun is left (logged, not rewritten)', () => {
    const reply = "Got it, Liz. Biz is your son, and your son Biz calls you Mom.";
    const out = guardInterviewReply(reply, { name: 'Liz', pronouns: 'she/her', relationships: [{ to: 'Biz', relation: 'kid' }] }, [{ name: 'Biz', pronouns: null }]);
    expect(out).toBe("Got it, Liz. Biz is your son, and your kid Biz calls you Mom.");
  });
});

// ─── 3. "Her kid Biz calls her Mom" is Biz's address, not Liz's ─────────────

describe('3. an address term belongs to the one who says it', () => {
  const LIVE = "My character is Liz (she/her), a tired but resourceful mom in her late thirties who works in insurance claims back home, so she actually understands paperwork. Her kid Biz calls her Mom.";
  const lizCtx = { characterName: 'Liz', playerName: 'Liz', tableNames: [] as string[], relationships: [{ to: 'Biz', relation: 'kid' }] };

  it('the live line in Liz\'s interview puts nothing on Liz\'s sheet', () => {
    expect(statedAddressTerms(LIVE, lizCtx)).toEqual([]);
    expect(statedAddressTerms('Biz calls me Mom.', lizCtx)).toEqual([]);
    expect(statedAddressTerms('My kid calls me Mom.', lizCtx)).toEqual([]);
  });

  it('Biz\'s own interview still records it on Biz\'s sheet', () => {
    const bizCtx = { characterName: 'Biz', playerName: 'Biz', tableNames: ['Liz'], relationships: [{ to: 'Liz', relation: 'mother' }] };
    expect(statedAddressTerms("I'm playing Biz (they/them), a 10-year-old kid, Liz's child. Their trouble is 'Wanders off after anything shiny'. Biz calls Liz Mom — please keep 'calls Liz Mom' on the sheet.", bizCtx))
      .toEqual([{ to: 'Liz', address: 'Mom' }]);
    expect(statedAddressTerms('I call her Mom.', bizCtx)).toEqual([{ to: 'Liz', address: 'Mom' }]);
  });

  it('never a parent term on the tie to one\'s own kid: the live sheet {to: Biz, relation: kid, address: Mom} is repaired', () => {
    expect(addressDescribesSelf('kid', 'Mom')).toBe(true);
    expect(addressDescribesSelf('mother', 'Mom')).toBe(false);
    const liz = { name: 'Liz', relationships: [{ to: 'Biz', relation: 'kid', address: 'Mom' }] } as Partial<CharacterDefinition>;
    expect(withStatedAddressTerms(liz, []).relationships).toEqual([{ to: 'Biz', relation: 'kid' }]);
    expect(withStatedAddressTerms({ ...liz, relationships: [{ to: 'Biz', relation: 'kid' }] }, [{ to: 'Biz', address: 'Mom' }]).relationships).toEqual([{ to: 'Biz', relation: 'kid' }]);
    // The model writing it itself, turn by turn.
    expect(mergeCharacterDraft(null, liz).relationships).toEqual([{ to: 'Biz', relation: 'kid' }]);
    // Biz's side is untouched.
    const biz = { name: 'Biz', relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }] } as Partial<CharacterDefinition>;
    expect(mergeCharacterDraft(null, biz).relationships).toEqual([{ to: 'Liz', relation: 'mother', address: 'Mom' }]);
  });
});

// ─── 4. The brass key pressed into her palm ────────────────────────────────

describe('4. a hand-off is a transfer', () => {
  const LIVE = 'The Linen-Suited Man does not recoil; instead, he smiles with a terrifying, static-filled warmth, his hand remaining firmly on Liz’s shoulder, pressing the brass key into her palm with a gentle, inescapable pressure that feels like a brand.';

  it('the live ruling hands Liz the Brass Key', () => {
    expect(narratesItemTransfer(LIVE, 'Brass Key', 'Liz')).toBe(true);
    expect(narratesItemTransfer("Odo slips the brass key into Liz's pocket.", 'Brass Key', 'Liz')).toBe(true);
    expect(narratesItemTransfer('Odo offers the brass key, and Liz accepts it with a nod.', 'Brass Key', 'Liz')).toBe(true);
  });

  it('a claim in speech, a refusal, a negated hand-off or someone else\'s palm is not', () => {
    expect(narratesItemTransfer("'This brass key is mine now,' Liz declares, hand on her heart.", 'Brass Key', 'Liz')).toBe(false);
    expect(narratesItemTransfer('Liz claims the brass key is hers, but the clerk keeps it.', 'Brass Key', 'Liz')).toBe(false);
    expect(narratesItemTransfer('The Linen-Suited Man does not hand the brass key to Liz.', 'Brass Key', 'Liz')).toBe(false);
    expect(narratesItemTransfer("Liz presses the brass key into Odo's palm.", 'Brass Key', 'Liz')).toBe(false);
    expect(narratesItemTransfer('Liz presses the brass key into his palm.', 'Brass Key', 'Liz')).toBe(false);
  });
});

// ─── 5. The setup chat printed the DM's draft ──────────────────────────────

const REPLY_PLOT_HOOK = `Understood. FATE Core it is, with a strict 'kid-friendly' safety filter. No monsters, no gore, no existential dread—just the mild terror of a lost form and a very confused middle manager.

I have drafted the starting world based on your influences and premise. Here is the setup for the Arrivals Hall:

**Location 1: The Grand Arrivals Atrium of the Department of Summonings**
A vast, circular hall with a ceiling that stretches into a painted sky that never changes.

**NPC 1: Clerk 734**
A small, round man with spectacles the size of saucers. He is the one who will eventually process Liz and Biz’s file, provided they can find the correct form.

**Plot Hook:**
Liz and Biz have just arrived and are standing in the queue. However, they have no file number. The previous clerk who was supposed to process their entry vanished, leaving behind only a crumpled receipt and a sticky note that reads: 'Check the Basement. Bring snacks.'

Does this setup look good to you? If so, we can move on to character creation for Liz and Biz.`;

const REPLY_DUMP = `Excellent. The world is set, the tone is locked in, and the safety rails are up. We are ready to open the gate.

Here is the summary of how we will run this game:

**dmInstructions:**
Run a FATE Core session featuring Liz (mom) and Biz (10-year-old kid) isekai'd into a bureaucratic fantasy world. Tone: Comedic, warm, absurd.

**dmCustomPrompt:**
${LIVE_DMC}

Now, let's build Liz and Biz. What does Liz look like, and what is her biggest fear in this new world?`;

describe('5. the chat reply never carries the draft', () => {
  it('the live dump: no dmInstructions, dmCustomPrompt, Current Situation or Key NPCs — for any host', () => {
    for (const noSpoilers of [true, false]) {
      const out = withoutSetupFieldDumps(REPLY_DUMP, { noSpoilers });
      expect(out).not.toMatch(/dmInstructions|dmCustomPrompt|Current Situation|Key NPCs|vanished|Clerk 734/);
      expect(out).not.toMatch(/Here is the summary/);
      expect(out).toMatch(/^Excellent\. The world is set/);
      expect(out).toMatch(/Now, let's build Liz and Biz\. What does Liz look like/);
    }
  });

  it('the live "Plot Hook:" block goes for every host; a playing host also loses the NPC block', () => {
    const player = withoutSetupFieldDumps(REPLY_PLOT_HOOK, { noSpoilers: true });
    expect(player).not.toMatch(/Plot Hook|vanished|Check the Basement|Clerk 734|eventually process/);
    expect(player).toContain('**Location 1: The Grand Arrivals Atrium');
    expect(player).toContain('Does this setup look good to you?');
    const dmHost = withoutSetupFieldDumps(REPLY_PLOT_HOOK, { noSpoilers: false });
    expect(dmHost).not.toMatch(/Plot Hook|vanished/);
    expect(dmHost).toContain('**NPC 1: Clerk 734**');
  });

  it('markdown and inline variants', () => {
    expect(withoutSetupFieldDumps('Lovely. Plot Hooks: the clerk vanished.\nWhat tone?', {})).toBe('Lovely.\nWhat tone?');
    expect(withoutSetupFieldDumps('- **Secrets**: the mayor did it\n\nWhat tone?', {})).toBe('What tone?');
    expect(withoutSetupFieldDumps('Twist: nobody is real.', { fallback: 'Next question?' })).toBe('Next question?');
    expect(withoutSetupFieldDumps('Cosy it is. What tone?', {})).toBe('Cosy it is. What tone?');
  });

  it('a no-spoiler host: a secret of the direction still being drafted is dropped before any seed exists', () => {
    const reply = 'Love it — the Atrium is ready. The previous clerk vanished, leaving a receipt and a note. What tone should the danger have?';
    expect(withoutSeedSpoilers(reply, null, undefined, [LIVE_DMC])).toBe('Love it — the Atrium is ready. What tone should the danger have?');
    // The host's own premise, confirmed, is not a secret.
    expect(withoutSeedSpoilers('A paperwork error at the Department of Summonings — perfect. What tone?', null, undefined, [LIVE_DMC]))
      .toBe('A paperwork error at the Department of Summonings — perfect. What tone?');
  });
});

// ─── 6. Brazil, twice ──────────────────────────────────────────────────────

describe('6. influences are deduped by what they name', () => {
  it('the live list', () => {
    expect(normalizeInfluences(["Terry Pratchett's Discworld", 'Brazil (Terry Gilliam film)', 'Spirited Away', 'Brazil (the Terry Gilliam film)']))
      .toEqual(["Terry Pratchett's Discworld", 'Brazil (Terry Gilliam film)', 'Spirited Away']);
    expect(influenceKey('Brazil (the Terry Gilliam film)')).toBe(influenceKey('Brazil'));
    expect(influenceKey('The Lighthouse')).toBe(influenceKey('Lighthouse'));
    expect(influenceKey('Spirited Away')).not.toBe(influenceKey('Brazil'));
  });
});

// ─── 7. The same beat, twice ───────────────────────────────────────────────

describe('7. a beat that repeats an earlier one', () => {
  it('the live pair overlaps ≥ 90%; a different beat does not', () => {
    expect(beatOverlap(BEAT_35, BEAT_24)).toBeGreaterThanOrEqual(0.9);
    expect(repeatsRecentBeat(BEAT_35, ['The form yields a footnote.', BEAT_24])).toBe(BEAT_24);
    expect(beatOverlap(BEAT_46, BEAT_24)).toBeLessThan(0.5);
    expect(repeatsRecentBeat(BEAT_46, [BEAT_24])).toBeNull();
    expect(repeatsRecentBeat('[Biz takes a moment to recover]', ['[Biz takes a moment to recover]'])).toBeNull();
  });

  async function playTwoRounds(): Promise<{ seen: any[]; prompts: string[] }> {
    const { createRoom } = await import('../src/server/room.js');
    const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
    const { GameLoop } = await import('../src/server/game-loop.js');
    const seed = {
      premise: 'A mom and her kid arrive in the Department of Summonings.',
      locations: [{ name: 'The Grand Arrivals Atrium', description: 'Desks.', terrain: 'interior' }, { name: 'The Queue for Counter 4B', description: 'A line.', terrain: 'interior' }],
      npcs: [{ name: 'Clerk 734', description: 'A clerk.', disposition: 'polite', motivation: 'Order.' }, { name: 'The Queue Manager', description: 'Stopwatch.', disposition: 'stern', motivation: 'Order.' }],
      plotHooks: ['The queue never moves.'],
      items: [],
    };
    const { campaignId, joinCode } = createRoom(db, { name: 'R9 play', dmPreset: 'chronicler', systemId: 'fate-core' });
    setWorldSeed(db, campaignId, seed);
    markSeedAccepted(db, campaignId);
    seedWorld(db, campaignId, seed);
    const sheet = (name: string, pronouns: string, rel: { to: string; relation: string; address?: string }, age?: number): CharacterDefinition => ({
      name, pronouns, highConcept: `${name} the Traveller`, trouble: 'Too Curious', aspects: ['Quick'], personality: 'curious', backstory: '', skills: { Notice: 2 }, stunts: ['Keen: +2 Notice.'], relationships: [rel], ...(age ? { age } : {}),
    });
    const STATE = { stress: 0, consequences: [] as string[], fatePoints: 3, inventory: [] as string[], xpMilestones: [] as string[], whisperTrust: 0.6 };
    db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)').run(`liz-r9-${campaignId}`, campaignId, JSON.stringify(sheet('Liz', 'she/her', { to: 'Biz', relation: 'kid' })), JSON.stringify(STATE));
    db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)').run(`biz-r9-${campaignId}`, campaignId, JSON.stringify(sheet('Biz', 'they/them', { to: 'Liz', relation: 'mother', address: 'Mom' }, 10)), JSON.stringify(STATE));
    const state = { campaignId, joinCode, phase: 'playing' as const, currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null };
    const seen: any[] = [];
    const before = calls.length;
    let loop!: InstanceType<typeof GameLoop>;
    let resolutions = 0;
    const done = new Promise<void>((resolve) => {
      // Two rounds of two turns: the narration after round one is the repeat.
      const on = (m: any) => { seen.push(m); if (m.type === 'resolution' && ++resolutions === 3) setImmediate(() => { loop.stop(); resolve(); }); };
      loop = new GameLoop(db, campaignId, on, () => {}, state as any, (_id: string, m: any) => on(m));
    });
    const running = loop.start().catch(e => console.error('LOOP FAILED', e));
    await Promise.race([done, new Promise(r => setTimeout(r, 20_000))]);
    loop.stop();
    await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
    return { seen, prompts: calls.slice(before).map(c => c.messages.map(m => m.content).join('\n')) };
  }

  it('in play: the repeated narration is asked for once more, told what it repeated, and the fresh one is read', async () => {
    play.narrations = [BEAT_24, BEAT_35];
    play.retry = FRESH;
    play.narrateCalls = 0;
    const { seen, prompts } = await playTwoRounds();
    const narrations = seen.filter(m => m.type === 'narration').map(m => m.text as string);
    expect(narrations.filter(t => t.includes('The brass clip skitters out from under the ledger'))).toHaveLength(1);
    expect(narrations.some(t => t.includes('Name, rank and weather pattern'))).toBe(true);
    const retry = prompts.find(p => p.includes('<repeated>'))!;
    expect(retry).toContain('The brass clip skitters out from under the ledger');
  }, 40_000);

  it('in play: a retry that repeats too is dropped — the table reads the beat once', async () => {
    play.narrations = [BEAT_24, BEAT_35];
    play.retry = BEAT_35;
    play.narrateCalls = 0;
    const { seen } = await playTwoRounds();
    const narrations = seen.filter(m => m.type === 'narration').map(m => m.text as string);
    expect(narrations.filter(t => t.includes('The brass clip skitters out from under the ledger'))).toHaveLength(1);
    expect(seen.filter(m => m.type === 'resolution').length).toBeGreaterThanOrEqual(3);
  }, 40_000);
});

// ─── 8. A ten-year-old at the table ────────────────────────────────────────

describe('8. family-table tone', () => {
  it('the rule is in the prompt for this party (Biz is 10; Liz\'s sheet says "kid") and names the imagery', () => {
    const rule = childToneRule([{ name: 'Liz', highConcept: 'x', relationships: [{ to: 'Biz', relation: 'kid' }] }, { name: 'Biz', highConcept: 'y', age: 10 }]);
    expect(rule).toMatch(/^FAMILY TABLE: Biz is a child/);
    expect(rule).toMatch(/nooses/);
    expect(rule).toMatch(/bones cracking/);
    expect(rule).toMatch(/blood/);
    expect(rule).toMatch(/branding/);
    expect(rule).toMatch(/Peril and stakes are fine/);
    // The relationship alone is enough.
    expect(childToneRule([{ name: 'Liz', highConcept: 'x', relationships: [{ to: 'Biz', relation: 'kid' }] }, { name: 'Biz', highConcept: 'y' }])).toMatch(/Biz is a child/);
  });

  it('the live images are softened', () => {
    expect(softenForChildren('Biz, standing just behind her, watches the clerk’s bow tie tighten around his neck like a noose.'))
      .toBe('Biz, standing just behind her, watches the clerk’s bow tie tighten around his neck like a tangle of rope.');
    expect(softenForChildren('the Queue Manager’s stopwatch makes a loud, ticking *click* that sounds like a bone cracking.'))
      .toBe('the Queue Manager’s stopwatch makes a loud, ticking *click* that sounds like a twig snapping.');
    expect(softenForChildren('he smiles with a terrifying, static-filled warmth, … a gentle, inescapable pressure that feels like a brand.'))
      .toBe('he smiles with an unnerving, static-filled warmth, … a gentle, inescapable pressure that feels like a warm coin.');
    expect(softenForChildren('Terrifying!')).toBe('Unnerving!');
    expect(softenForChildren('A quiet hall.')).toBe('A quiet hall.');
  });
});
