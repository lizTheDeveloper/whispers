// Round 8: what the first live game on qwen/qwen3.8-27b got wrong (games
// EV94GS / 8KXSWC; Liz she/her, Biz they/them; NPCs Lady Vex she, Odo he).
// Each block quotes the live line.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition, CharacterState } from '../src/shared/types.js';
import { repairGenderedNouns, findPronounConflicts } from '../src/server/pronoun-consistency.js';
import { withoutWhisperMentions, withoutDmWhispers, narratesItemTransfer, repetitionNotes } from '../src/server/narrative-guards.js';
import { statedAddressTerms, withStatedAddressTerms, mergeCharacterDraft } from '../src/server/character-interview.js';
import { assembleSystemPrompt, influencesNamedIn, SETUP_REPEAT_NUDGE } from '../src/server/agents/dm.js';

type Msg = { role: string; content: string };
const calls: Array<{ messages: Msg[]; temperature?: number; frequencyPenalty?: number; presencePenalty?: number }> = [];

// A model that, once it has said "I hear you loud and clear…", says it again
// to whatever the host writes — the live EV94GS setup chat. Asked again with
// the host's latest message named, it answers that message.
const LOOP_REPLY = 'I hear you loud and clear. I will hold all the secrets close and let you discover them in play.';

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[]; temperature?: number; frequencyPenalty?: number; presencePenalty?: number }) => {
    calls.push(opts);
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('helping set up a new game')) {
      const last = opts.messages[opts.messages.length - 1]!;
      if (last.role === 'user' && last.content.startsWith(SETUP_REPEAT_NUDGE)) {
        const latest = last.content.match(/"([^"]{0,40})/)?.[1] ?? '';
        return { reply: `Got it — "${latest}". What should the table feel like?`, done: false, influences: [], dmInstructions: null, dmCustomPrompt: null };
      }
      return { reply: LOOP_REPLY, done: false, influences: [], dmInstructions: null, dmCustomPrompt: null };
    }
    if (all.includes('OPENING OF THE ADVENTURE')) return { narration: 'The Registry hums.', introductions: [], currentLocationName: '' };
    if (all.includes('Choose your action now')) {
      return { chosenAction: live.action, spokenWords: live.spoken, innerThought: 'The voice says run, and I trust it.', whisperedInfluence: 'followed', trustDelta: 0.05 };
    }
    if (all.includes('Propose 2-4 actions')) return { actions: [{ description: 'I study the conveyor belt for a way through', reasoning: 'r' }, { description: 'I ask Lady Vex where the exit is', reasoning: 'r' }] };
    if (all.includes('FATE resolution steps')) {
      const actorId = all.match(/ACTING CHARACTER[^\n]*\(id: ([^)]+)\)/)?.[1];
      return { diceExpression: '4dF', difficulty: 1, skill: 'Rapport', outcome: 'success', narration: live.resolution, stateChanges: actorId ? [{ characterId: actorId, field: 'inventory', action: 'add', value: 'Brass Ruler' }] : [] };
    }
    if (all.includes('Pacing:')) return { narration: live.narration, currentLocationName: '', activeNpcs: ['Lady Vex'], isSceneEnd: false };
    if (all.includes('Summarize')) return { summary: 'The belt moved.' };
    return 'ok';
  }),
}));

const live = {
  action: 'Sprint down the spiraling passage with Mom, ignoring the conveyor belt whisper.',
  spoken: null as string | null,
  // Liz's claim, and Vex keeping the ruler.
  resolution: "Lady Vex's eyes narrow, and she keeps tapping her Brass Ruler against the ledger. 'Property,' she says, 'is a matter of filing.'",
  narration: "The conveyor rattles past, stacked with forms. Then a sudden, urgent whisper in their ear hisses, 'Grab the red form on the belt before it reaches the shredder!' Lady Vex taps her ruler against the ledger.",
};

process.env.WHISPER_WINDOW_MS = '30';

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r8-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

const M = [{ name: 'Liz', pronouns: 'she/her' }, { name: 'Biz', pronouns: 'they/them' }];

// ─── 2. The setup chat stuck on one reply ──────────────────────────────────

describe('2. a no-spoiler host\'s setup chat keeps moving', () => {
  const HOST = [
    'No spoilers for me please, I want to be surprised. Who are the main people in this world?',
    'The premise: a family is pulled into an afterlife where everything runs on forms.',
    "Three influences: Terry Pratchett's Discworld, Spirited Away, and Brazil.",
    'Keep it cozy, with a little real danger.',
  ];

  it('four host messages never get the same reply twice, and the three influences are recorded', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    const dm = new DmAgent(db);
    const history: Msg[] = [{ role: 'assistant', content: 'Welcome! What kind of game shall we build?' }];
    const replies: string[] = [];
    let influences: string[] = [];
    for (const text of HOST) {
      history.push({ role: 'user', content: text });
      const reply = await dm.setupChat({ preset: 'chronicler', systemId: 'fate-core', history, unmet: ['Name at least 3 stylistic influences (currently 0).'], hostTableRole: 'dm' });
      history.push({ role: 'assistant', content: reply.reply });
      replies.push(reply.reply);
      if ((reply.influences ?? []).length > 0) influences = reply.influences!;
    }
    // Live: all four were LOOP_REPLY, word for word.
    expect(replies[0]).toBe(LOOP_REPLY);
    expect(new Set(replies).size).toBe(4);
    expect(influences).toEqual(["Terry Pratchett's Discworld", 'Spirited Away', 'Brazil']);
  });

  it('the secrets are still kept: the no-spoiler rule is in every setup prompt', () => {
    const setupCalls = calls.filter(c => c.messages[0]!.content.includes('helping set up a new game'));
    expect(setupCalls.length).toBeGreaterThan(0);
    for (const c of setupCalls) expect(c.messages[0]!.content).toContain('SPOILER-FREE HOST');
  });

  it('the host\'s latest message is the one the model is told to answer', () => {
    const last = calls.filter(c => c.messages[0]!.content.includes('helping set up a new game')).pop()!;
    const lastUser = [...last.messages].reverse().find(m => m.role === 'user')!;
    expect(lastUser.content).toMatch(/Keep it cozy|Reply to THIS message/);
  });

  it('influencesNamedIn reads the ways hosts name them', () => {
    expect(influencesNamedIn("Three influences: Terry Pratchett's Discworld, Spirited Away, and Brazil.")).toEqual(["Terry Pratchett's Discworld", 'Spirited Away', 'Brazil']);
    expect(influencesNamedIn('My influences are Annihilation, Twin Peaks and The Lighthouse. Keep it spooky.')).toEqual(['Annihilation', 'Twin Peaks', 'The Lighthouse']);
    expect(influencesNamedIn('Who are the main people?')).toEqual([]);
  });
});

// ─── 3. "the boy" for Biz, returned unchanged by the rewrite ───────────────

describe('3. gendered nouns for a they/them member', () => {
  const LINGER = "Biz ducks under the rollers, and a cold draft keeps lingering where the boy just was.";
  const NECK = "Liz grips the rail. Biz freezes, and a chill prickles the back of the boy's neck.";

  it('detection: both live sentences are flagged', () => {
    expect(findPronounConflicts(LINGER, M, { npcNames: ['Lady Vex'] }).map(c => [c.name, c.word])).toEqual([['Biz', 'boy']]);
    expect(findPronounConflicts(NECK, M, { npcNames: ['Lady Vex'] }).map(c => [c.name, c.word])).toEqual([['Biz', 'boy']]);
  });

  it('"young man", "young lady" are gendered words too', () => {
    expect(findPronounConflicts('Biz straightens up like a proper young man.', M).map(c => c.word)).toEqual(['young man']);
    expect(findPronounConflicts('Biz bows like a young lady at court.', M).map(c => c.word)).toEqual(['young lady']);
  });

  // Round 9: no rewrite is asked for any more (the strict second ask caused
  // the misgendering seen in E9W9YT). "the boy" alone could be anyone: it is
  // left as written; "the boy Biz" names Biz and is repaired.
  it('"the boy" alone is left as written; "the boy Biz" and "her son Biz" are repaired', () => {
    expect(repairGenderedNouns(LINGER, M)).toBe(LINGER);
    expect(repairGenderedNouns(NECK, M)).toBe(NECK);
    expect(repairGenderedNouns('The boy Biz ducks under the rollers.', M)).toBe('Biz ducks under the rollers.');
    expect(repairGenderedNouns('Liz pulls her son Biz close.', M)).toBe('Liz pulls her kid Biz close.');
  });

  it('a stray "a boy" (someone else) is never rewritten', () => {
    const text = 'Biz watches a boy chase paper cranes across the hall.';
    expect(repairGenderedNouns(text, M)).toBe(text);
  });
});

// ─── 4. Odo's coat is Odo's ─────────────────────────────────────────────────

describe('4. no pronoun is ever rewritten — an NPC\'s least of all', () => {
  it('"Odo steps forward, his stormcloud coat…" keeps "his"', () => {
    const text = "Odo steps forward, his stormcloud coat brushing Biz's shoulder.";
    expect(repairGenderedNouns(text, M)).toBe(text);
  });

  it('an NPC in the sentence before keeps "he"', () => {
    const text = 'Odo adjusts his hat. Biz watches as he walks off.';
    expect(repairGenderedNouns(text, M)).toBe(text);
  });

  it('even the plain case is left as written: pronoun ownership is too ambiguous for code', () => {
    expect(repairGenderedNouns('Biz tightens his grip on the ledger.', M)).toBe('Biz tightens his grip on the ledger.');
  });
});

// ─── 5. The whisper leaked into the public action line ─────────────────────

describe('5. a public action never mentions the whisper', () => {
  it('the live lines', () => {
    expect(withoutWhisperMentions('Sprint down the spiraling passage with Mom, ignoring the conveyor belt whisper.'))
      .toBe('Sprint down the spiraling passage with Mom.');
    expect(withoutWhisperMentions('I grab the red form, ignoring the whisper\'s specific target, and run.'))
      .toBe('I grab the red form, and run.');
  });

  it('"the voice" and "the suggestion" too; a whispered word to a companion is fine', () => {
    expect(withoutWhisperMentions('I hide behind the filing cabinet, just as the voice said.')).toBe('I hide behind the filing cabinet.');
    expect(withoutWhisperMentions('I open the drawer, following the suggestion')).toBe('I open the drawer');
    expect(withoutWhisperMentions('I whisper to Mom that we should run.')).toBe('I whisper to Mom that we should run.');
    expect(withoutWhisperMentions('I tell Mom in a whisper, keep low, and lower my voice.')).toBe('I tell Mom in a whisper, keep low, and lower my voice.');
  });

  it('the character agent is told its action and words are seen by everyone', async () => {
    const { CharacterAgent } = await import('../src/server/agents/character.js');
    const def: CharacterDefinition = { name: 'Biz', highConcept: 'Curious Kid', trouble: 'Wanders Off', aspects: ['Quick'], personality: 'curious', backstory: '', skills: { Notice: 2 }, stunts: [], pronouns: 'they/them' };
    const state: CharacterState = { stress: 0, consequences: [], fatePoints: 3, inventory: [], xpMilestones: [], whisperTrust: 0.5 };
    const before = calls.length;
    await new CharacterAgent().decideAction({ definition: def, state, sceneNarration: 'The belt rattles.', transcript: [] }, 'grab the red form on the conveyor belt');
    const prompt = calls.slice(before).map(c => c.messages.map(m => m.content).join('\n')).join('\n');
    expect(prompt).toMatch(/seen by everyone/i);
    expect(prompt).toMatch(/never mention the whisper/i);
  });
});

// ─── 6. "calls Liz Mom" kept on the sheet ───────────────────────────────────

describe('6. an address term the player states is recorded and kept', () => {
  const rels = [{ to: 'Liz', relation: 'mother' }];

  it('reads "calls Liz Mom", "calls her Mom" and "Biz calls me Mom"', () => {
    expect(statedAddressTerms("Please keep 'calls Liz Mom' in the sheet", { characterName: 'Biz', playerName: 'Biz', tableNames: ['Liz'], relationships: [] }))
      .toEqual([{ to: 'Liz', address: 'Mom' }]);
    expect(statedAddressTerms('Biz calls her Mom.', { characterName: 'Biz', playerName: 'Biz', tableNames: ['Liz'], relationships: rels }))
      .toEqual([{ to: 'Liz', address: 'Mom' }]);
    expect(statedAddressTerms('Biz calls me Mom, always.', { characterName: 'Biz', playerName: 'Liz', tableNames: ['Liz'], relationships: rels }))
      .toEqual([{ to: 'Liz', address: 'Mom' }]);
    expect(statedAddressTerms('Biz is ten and loves shiny things.', { characterName: 'Biz', playerName: 'Biz', tableNames: ['Liz'], relationships: rels })).toEqual([]);
  });

  it('a later turn that reports the relationship without the address does not drop it', () => {
    const base = { name: 'Biz', relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }] } as Partial<CharacterDefinition>;
    const update = { name: 'Biz', relationships: [{ to: 'Liz', relation: 'mother' }] } as Partial<CharacterDefinition>;
    expect(mergeCharacterDraft(base, update).relationships).toEqual([{ to: 'Liz', relation: 'mother', address: 'Mom' }]);
  });

  it('the stated term lands on the sheet, on the existing tie or as a new one', () => {
    const sheet = { name: 'Biz', highConcept: '', trouble: '', aspects: [], personality: '', backstory: '', skills: {}, stunts: [], relationships: [{ to: 'Liz', relation: 'mother' }] } as CharacterDefinition;
    expect(withStatedAddressTerms(sheet, [{ to: 'Liz', address: 'Mom' }]).relationships).toEqual([{ to: 'Liz', relation: 'mother', address: 'Mom' }]);
    const bare = { ...sheet, relationships: [] };
    expect(withStatedAddressTerms(bare, [{ to: 'Liz', address: 'Mom' }]).relationships).toEqual([{ to: 'Liz', relation: 'mother', address: 'Mom' }]);
  });
});

// ─── 7. The DM invented a whisper ───────────────────────────────────────────

describe('7. only players whisper', () => {
  const LIVE = "The conveyor rattles past, stacked with forms. Then a sudden, urgent whisper in their ear hisses, 'Grab the red form on the belt before it reaches the shredder!' Lady Vex taps her ruler against the ledger.";

  it('the DM sentence narrating a whisper in a character\'s ear is dropped', () => {
    expect(withoutDmWhispers(LIVE)).toBe('The conveyor rattles past, stacked with forms. Lady Vex taps her ruler against the ledger.');
  });

  it('NPCs whispering to each other, or a voice calling from the stacks, stay', () => {
    const ok = "Lady Vex whispers something to the clerk. A voice from the stacks calls, 'Next!' Odo whispers in her ear. The voice of the speaking tube says, 'Window four.' A voice at the head of the stairs calls for order.";
    expect(withoutDmWhispers(ok)).toBe(ok);
    expect(withoutDmWhispers("In Biz's head, a quiet voice murmurs, 'Run.' The belt stops.")).toBe('The belt stops.');
  });

  it('the DM is told whispers come only from the players', () => {
    const { systemPrompt } = assembleSystemPrompt({ preset: 'chronicler', dmCustomPrompt: null, houseRules: null, dmInstructions: null, campaignMaterials: null, influences: [] });
    expect(systemPrompt).toMatch(/Whispers come ONLY from the players/);
    expect(systemPrompt).toMatch(/never narrate a whisper/i);
  });
});

// ─── 8. Claiming an item in speech is not taking it ────────────────────────

describe('8. an item changes hands only when the ruling shows it', () => {
  it('Liz says "It is my property." and Lady Vex keeps tapping hers: no Brass Ruler for Liz', () => {
    const narration = "Lady Vex's eyes narrow, and she keeps tapping her Brass Ruler against the ledger. 'Property,' she says, 'is a matter of filing.'";
    expect(narratesItemTransfer(narration, 'Brass Ruler', 'Liz')).toBe(false);
  });

  it('a ruling that shows her taking it does', () => {
    expect(narratesItemTransfer('Liz snatches the Brass Ruler from the desk before Lady Vex can stop her.', 'Brass Ruler', 'Liz')).toBe(true);
    expect(narratesItemTransfer('Odo hands Liz the brass key without a word.', 'Brass Key', 'Liz')).toBe(true);
    expect(narratesItemTransfer('Liz reaches for the Brass Ruler, but Lady Vex refuses to give it up.', 'Brass Ruler', 'Liz')).toBe(false);
  });
});

// ─── 9. Repeated NPC lines and sensory words ───────────────────────────────

describe('9. the DM is shown what it has already said', () => {
  const lines = [
    "Lady Vex raps the desk. 'Every soul must be filed in triplicate, no exceptions.' The air smells of ozone and burnt sugar.",
    "Copper pipes tick overhead; ozone hangs in the air.",
    "Odo leans in. 'Every soul must be filed in triplicate, no exceptions.' Burnt sugar and copper linger.",
    'The belt shudders; a smell of ozone and copper rolls off the machinery.',
  ];

  it('quotes the lines of dialogue already spoken and names the words it keeps reaching for', () => {
    const notes = repetitionNotes(lines);
    expect(notes).toContain('Every soul must be filed in triplicate, no exceptions.');
    expect(notes).toMatch(/ozone/);
    expect(notes).toMatch(/copper/);
    expect(notes).toMatch(/do not repeat/i);
  });

  it('nothing to say about fresh prose', () => {
    expect(repetitionNotes(['The hall is quiet.'])).toBe('');
  });

  it('narrate() carries the notes and asks for mild repetition penalties', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    const before = calls.length;
    await new DmAgent(db).narrate({
      preset: 'chronicler', houseRules: null, dmInstructions: null, dmCustomPrompt: null, campaignId: 'c', worldSummary: '', systemId: 'fate-core', influences: [],
      transcript: lines.map(content => ({ role: 'dm' as const, content, timestamp: '' })),
    });
    const call = calls.slice(before).find(c => c.messages.some(m => m.content.includes('Pacing:')))!;
    expect(call.messages.map(m => m.content).join('\n')).toContain('Every soul must be filed in triplicate, no exceptions.');
    expect(call.frequencyPenalty).toBeGreaterThan(0);
    expect(call.presencePenalty).toBeGreaterThan(0);
  });
});

// ─── In play: the guards are wired where the text is made ──────────────────

describe('in play', () => {
  it('the table never sees the whisper, the DM\'s invented whisper is gone, and a claimed ruler stays Vex\'s', async () => {
    const { createRoom } = await import('../src/server/room.js');
    const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
    const { GameLoop } = await import('../src/server/game-loop.js');
    const seed = {
      premise: 'A family wakes in the Registry of the Departed.',
      locations: [{ name: 'The Grand Registry Hall', description: 'Desks.', terrain: 'interior' }, { name: 'The Sorting Floor', description: 'Belts.', terrain: 'interior' }],
      npcs: [{ name: 'Lady Vex', description: 'Chief Registrar.', disposition: 'stern', motivation: 'Order.' }, { name: 'Odo', description: 'A clerk.', disposition: 'nervous', motivation: 'Quiet.' }],
      plotHooks: ['A red form keeps reappearing.'],
      items: [{ name: 'Brass Ruler', description: "Lady Vex's ruler." }],
    };
    const { campaignId, joinCode } = createRoom(db, { name: 'R8 play', dmPreset: 'chronicler', systemId: 'fate-core' });
    setWorldSeed(db, campaignId, seed);
    markSeedAccepted(db, campaignId);
    seedWorld(db, campaignId, seed);
    const sheet = (name: string, pronouns: string, rel: { to: string; relation: string; address?: string }): CharacterDefinition => ({
      name, pronouns, highConcept: `${name} the Traveller`, trouble: 'Too Curious', aspects: ['Quick'], personality: 'curious', backstory: '', skills: { Rapport: 2, Notice: 2 }, stunts: ['Keen: +2 Notice.'], relationships: [rel],
    });
    const STATE = { stress: 0, consequences: [] as string[], fatePoints: 3, inventory: [] as string[], xpMilestones: [] as string[], whisperTrust: 0.6 };
    db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)').run(`liz-r8-${campaignId}`, campaignId, JSON.stringify(sheet('Liz', 'she/her', { to: 'Biz', relation: 'kid' })), JSON.stringify(STATE));
    db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)').run(`biz-r8-${campaignId}`, campaignId, JSON.stringify(sheet('Biz', 'they/them', { to: 'Liz', relation: 'mother', address: 'Mom' })), JSON.stringify(STATE));
    const state = { campaignId, joinCode, phase: 'playing' as const, currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null };
    const seen: any[] = [];
    let loop!: InstanceType<typeof GameLoop>;
    const done = new Promise<void>((resolve) => {
      const on = (m: any) => { seen.push(m); if (m.type === 'resolution') setImmediate(() => { loop.stop(); resolve(); }); };
      loop = new GameLoop(db, campaignId, on, () => {}, state as any, (_id: string, m: any) => on(m));
    });
    const running = loop.start().catch(e => console.error('LOOP FAILED', e));
    await Promise.race([done, new Promise(r => setTimeout(r, 15_000))]);
    loop.stop();
    await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);

    const action = seen.find(m => m.type === 'action-taken');
    expect(action.action).toBe('Sprint down the spiraling passage with Mom.');
    const narration = seen.filter(m => m.type === 'narration').map(m => m.text).join('\n');
    expect(narration).toContain('The conveyor rattles past, stacked with forms.');
    expect(narration).not.toMatch(/whisper in their ear/);
    const inventories = (db.prepare('SELECT state FROM characters WHERE campaign_id = ?').all(campaignId) as Array<{ state: string }>).map(r => JSON.parse(r.state).inventory);
    expect(inventories.flat()).not.toContain('Brass Ruler');
    const res = seen.find(m => m.type === 'resolution');
    expect(res.text).not.toMatch(/pockets the brass ruler/i);
  }, 30_000);
});
