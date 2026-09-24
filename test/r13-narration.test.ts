// Round 13: what the round-12 live game (WXKC2C; qwen; Liz she/her, Biz
// they/them and ten, Biz calls Liz "Mom", the host asked for gentle peril
// and no spoilers, and plays Liz) still got wrong in the narration. Each
// block quotes the live line.
//  1. Biz was "her son", "the boy", and "its gaze" — and stayed that way.
//  2. Threats at the kid: filing, cataloguing, forgetting, swallowing, and a
//     partition sealing parent and child apart.
//  3. The gentle ending ended in the queue, and Biz called Mom "Liz".
//  4. "while Ms. 'The stamp is valid…'" — the name after "Ms." was cut.
//  5. An empty spoken line, a repeated interview reply, "Mrs. Miller", a
//     setup meta leak, a stale readiness list, the host's start hint, a
//     secret disposition shown to a no-spoiler host, and a stock line said
//     twice.
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { repairChildNouns, type PronounMember } from '../src/server/pronoun-consistency.js';
import { castPronounLine, partyPronounLine, correctNpcPronouns } from '../src/server/npc-pronouns.js';
import { childToneRule, describeParty } from '../src/server/agents/dm.js';
import { pronounRule } from '../src/server/agents/character.js';
import {
  softenForChildren, softenEnding, bleakEnding, repairAddress, withoutRepeatedSentences, withoutDmWhispers,
  spokenOrNull, withoutInventedPcSurnames,
} from '../src/server/narrative-guards.js';
import { splitSentences } from '../src/server/sentences.js';
import { publicReflection, publicEnding } from '../src/server/game-loop.js';
import { withoutSetupMechanics, seedForHost, withHiddenSeedFields, publicDisposition } from '../src/server/world-seed.js';
import { LineRotation, compelLines, invokeLines } from '../src/server/template-lines.js';
import { repeatsEarlierReply, interviewFallbackReply } from '../src/server/character-interview.js';
import { trimToLastSentence } from '../src/server/agents/llm-client.js';
import type { WorldSeed } from '../src/shared/types.js';

const LIZ: PronounMember = { name: 'Liz', pronouns: 'she/her', relationships: [{ to: 'Biz', relation: 'kid' }] };
const BIZ: PronounMember = { name: 'Biz', pronouns: 'they/them', relationships: [{ to: 'Liz', relation: 'mother' }] };
const PARTY = [LIZ, BIZ];
const NPCS = ['Clerk Barnaby Twist', 'Ms. Prudence Hark', 'Unit 7-G (The Filing Cabinet)'];
const fixKids = (t: string) => repairChildNouns(t, PARTY, { npcNames: NPCS });

// ─── 1. Biz is never son, boy or "it" ───────────────────────────────────────

describe('1a. a gendered child noun for Biz (they/them) becomes "kid"', () => {
  it('the live ruling: "…she looks down at the pen, then at her son, a quiet, steady warmth…"', () => {
    const live = 'Biz’s small hand closes around the cool, smooth barrel of the pen and guides it firmly into Liz’s waiting palm, the metal clicking softly against her knuckles with a reassuring, metallic chime. Liz’s fingers close around the instrument with the practiced ease of a woman who has signed thousands of invoices, and she looks down at the pen, then at her son, a quiet, steady warmth settling in her chest. Barnaby Twist lets out a small, relieved squeak, his bow-tie slackening as he scrambles to uncork the inkwell.';
    const out = fixKids(live);
    expect(out).toContain('then at her kid, a quiet, steady warmth');
    expect(out).not.toMatch(/\bson\b/);
    // Nothing else moves.
    expect(out.replace('her kid', 'her son')).toBe(live);
  });

  it('the live ruling: "Liz’s steady hand on Biz’s shoulder grounds the boy, who stops chewing…"', () => {
    const live = 'Liz’s steady hand on Biz’s shoulder grounds the boy, who stops chewing the bottle cap and looks up with wide, trusting eyes.';
    expect(fixKids(live)).toBe('Liz’s steady hand on Biz’s shoulder grounds the kid, who stops chewing the bottle cap and looks up with wide, trusting eyes.');
  });

  it('"Liz’s son" and "the little girl" (Biz named first) too', () => {
    expect(fixKids('Liz’s son tugs at her sleeve.')).toBe('Liz’s kid tugs at her sleeve.');
    expect(fixKids('Biz grins, and the little girl bounces on their toes.')).toBe('Biz grins, and the little kid bounces on their toes.');
  });

  it('the live ruling: "As Biz keeps its gaze locked on the shiny object" is "their gaze"', () => {
    const live = 'As Biz keeps its gaze locked on the shiny object, the air around the metal grows warm and sticky, smelling faintly of burnt sugar and ozone.';
    expect(fixKids(live)).toBe('As Biz keeps their gaze locked on the shiny object, the air around the metal grows warm and sticky, smelling faintly of burnt sugar and ozone.');
  });
});

describe('1b. …and never where someone else could be meant', () => {
  it('an NPC in the sentence: "Barnaby Twist pats his son on the head while Biz watches"', () => {
    const t = 'Barnaby Twist pats his son on the head while Biz watches.';
    expect(fixKids(t)).toBe(t);
  });

  it('a boy the story has just brought in: "Biz waves at the boy behind the counter"', () => {
    for (const t of ['Biz waves at the boy behind the counter.', 'Biz follows the boy who sells stamps.', 'The boy grins at Biz.', 'Liz waves at the boy.']) {
      expect(fixKids(t)).toBe(t);
    }
  });

  it('"its" that a thing or an it/its NPC could own', () => {
    for (const t of [
      'Biz watches Unit 7-G slide its drawer open.',
      'The cabinet hums as Biz taps its brass handle.',
      'Biz opens its lid and peers inside.',
    ]) expect(fixKids(t)).toBe(t);
  });

  it('a he/him or she/her member is not touched, nor anyone whose pronouns are not stated', () => {
    const party: PronounMember[] = [LIZ, { name: 'Bo', pronouns: 'he/him', relationships: [] }];
    expect(repairChildNouns('Liz looks at her son.', party, { npcNames: [] })).toBe('Liz looks at her son.');
    const unstated: PronounMember[] = [{ ...LIZ }, { name: 'Biz', pronouns: null, relationships: [{ to: 'Liz', relation: 'mother' }] }];
    expect(repairChildNouns('Liz looks at her son.', unstated, { npcNames: [] })).toBe('Liz looks at her son.');
  });

  it('two children in the party: "her son" is not certain', () => {
    const party: PronounMember[] = [
      { name: 'Liz', pronouns: 'she/her', relationships: [{ to: 'Biz', relation: 'kid' }, { to: 'Moss', relation: 'kid' }] },
      BIZ,
      { name: 'Moss', pronouns: 'he/him', relationships: [{ to: 'Liz', relation: 'mother' }] },
    ];
    expect(repairChildNouns('Liz looks at her son.', party, { npcNames: [] })).toBe('Liz looks at her son.');
  });
});

describe('1c. every prompt that can mention the party carries its pronouns, and "never son, boy, girl, daughter" for Biz', () => {
  const nounRule = (s: string) => {
    for (const w of ['son', 'daughter', 'boy', 'girl']) expect(s).toMatch(new RegExp(`\\b${w}\\b`));
    expect(s).toMatch(/Biz/);
  };

  it('the party line (memories, reflections, the epilogue)', () => {
    const line = partyPronounLine(PARTY);
    expect(line).toContain('Liz: she/her');
    expect(line).toContain('Biz: they/them');
    nounRule(line);
    expect(castPronounLine(PARTY, [])).toContain(line);
  });

  it('the DM\'s party block (every turn): pronouns, the noun rule, and no invented surnames', () => {
    const block = describeParty([
      { name: 'Liz', highConcept: 'Unflappable Accountant Mom', trouble: 'I worry about Biz too much', pronouns: 'she/her', relationships: [{ to: 'Biz', relation: 'kid' }] },
      { name: 'Biz', highConcept: 'Curious Kid Collector', trouble: 'Wanders off after anything shiny', pronouns: 'they/them', age: 10, relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }] },
    ] as any);
    nounRule(block);
    expect(block).toMatch(/surname/i);
    expect(block).toMatch(/Mrs\./);
  });

  it('a character\'s companion line', () => {
    const rule = pronounRule({ name: 'Biz', highConcept: 'Curious Kid Collector', trouble: 'x', pronouns: 'they/them' });
    expect(rule).toContain('Biz: they/them');
    nounRule(rule);
  });
});

// ─── 2. Gentle peril at a table with a child ───────────────────────────────

describe('2. no threats aimed at the kid', () => {
  const rule = childToneRule([{ name: 'Biz', highConcept: 'Curious Kid Collector', age: 10 } as any], { gentlePeril: true });

  it('the register rules out erasing, filing, processing, cataloguing or swallowing a person', () => {
    // Live: "this minor is clutter, and clutter goes in the Unprocessed
    // drawer", "an unregistered asset in need of immediate cataloging", "the
    // filing system will simply... forget you exist!", "I shall have no
    // choice but to alphabetize the rest of you".
    for (const w of [/\berase/i, /\bfil(?:e|ed|ing)\b/i, /\bprocess/i, /\bcatalog/i, /\bswallow/i, /forget/i, /alphabeti[sz]e/i]) expect(rule).toMatch(w);
    expect(rule).toMatch(/clutter|asset/i);
  });

  it('…separating the child from their grown-up (live: a partition sealed Liz and Biz apart)', () => {
    expect(rule).toMatch(/separat/i);
    expect(rule).toMatch(/partition|sealed apart|wall/i);
  });

  it('…and dismissing the kid\'s feelings (live: "your emotional outburst has been noted")', () => {
    expect(rule).toMatch(/feelings/i);
    expect(rule).toMatch(/outburst/i);
  });

  it('"…before Unit 7-G swallows us whole." (Biz\'s own thought) is softened', () => {
    const out = softenForChildren('I just need to get out of this office before Unit 7-G swallows us whole.');
    expect(out).not.toMatch(/swallow/i);
    expect(out).toBe('I just need to get out of this office before Unit 7-G sweeps us away.');
  });

  it('"or the filing system will simply... forget you exist!" is softened', () => {
    const out = softenForChildren('"…so I must move you and the child to the Department of Minor Adjustments immediately, or the filing system will simply... forget you exist!"');
    expect(out).not.toMatch(/forget you exist/i);
    expect(out).toContain('or the filing system will simply... misplace your paperwork!');
  });

  it('ordinary bureaucratic comedy is left alone', () => {
    for (const t of [
      'Ms. Hark stamps the form in triplicate and files it under Pending.',
      'The cabinet swallows the paperclip with a satisfied clunk.',
      'Unit 7-G insists on alphabetizing the bottle caps.',
      'Barnaby forgets his own stamp, again.',
    ]) expect(softenForChildren(t)).toBe(t);
  });
});

// ─── 3. The gentle ending ───────────────────────────────────────────────────

describe('3. a gentle ending that leaves the party stuck in the queue is asked for again', () => {
  it('the live epilogue, and both live reflections, are bleak', () => {
    expect(bleakEnding('The question of who misfiled the form remains unanswered, and the exit log stays unsigned, leaving them technically in Ms. Hark’s queue until the ink dries.')).toBe(true);
    expect(bleakEnding('I am grateful that Biz is safe and dry enough to keep their shiny evidence, even if we are stuck here until the violet puddle dries.')).toBe(true);
    expect(bleakEnding('We are still in the queue, Liz, because the ink is sticky and Barnaby is wet.')).toBe(true);
    expect(bleakEnding('We can\'t leave until the Ledger gets back.')).toBe(true);
    expect(bleakEnding('They are still trapped behind the counter.')).toBe(true);
  });

  it('a hopeful ending is not', () => {
    expect(bleakEnding('Liz and Biz walk out into the warm rain together, the queue behind them and a stamped form in Biz’s pocket.')).toBe(false);
    expect(bleakEnding('The question of the missing stamp is still open for next time.')).toBe(false);
  });

  it('"stuck here until…" is softened in an ending', () => {
    expect(softenEnding('even if we are stuck here until the violet puddle dries.')).toBe('even if we are waiting here until the violet puddle dries.');
  });

  it('Biz\'s reflection calls Liz "Mom": "We are still in the queue, Liz, because…"', () => {
    const terms = [{ name: 'Liz', address: 'Mom' }];
    expect(repairAddress('We are still in the queue, Liz, because the ink is sticky.', terms, { vocative: true }))
      .toBe('We are still in the queue, Mom, because the ink is sticky.');
    // A list is not a vocative.
    expect(repairAddress('I saw Barnaby, Liz, and Ms. Hark.', terms, { vocative: true })).toBe('I saw Barnaby, Liz, and Ms. Hark.');
    const out = publicReflection('SPOKEN: "We are still in the queue, Liz, because the ink is sticky."\nTHOUGHT: I am glad.', { self: BIZ, members: PARTY, familyTable: true, addressTerms: terms });
    expect(out.spoken).toBe('We are still in the queue, Mom, because the ink is sticky.');
  });
});

// ─── 4. "Ms." is not the end of a sentence ──────────────────────────────────

describe('4. titles do not end a sentence', () => {
  it('splitSentences keeps "Ms. Hark", "Mr. Twist", "Mrs.", "Dr." and "St." with the name', () => {
    expect(splitSentences('The doorway exhales while Ms. Prudence Hark adjusts her glasses. Mr. Twist sighs. Dr. Pell and Mrs. Oat walk to St. Ives. Done.'))
      .toEqual(['The doorway exhales while Ms. Prudence Hark adjusts her glasses.', 'Mr. Twist sighs.', 'Dr. Pell and Mrs. Oat walk to St. Ives.', 'Done.']);
  });

  it('the repeat guard never leaves "while Ms." hanging (live: "while Ms. \'The stamp is valid…\'")', () => {
    const recent = ['Ms. Prudence Hark adjusts her round, thick glasses and taps her oversized clipboard twice with a violet pen.'];
    const text = 'The amber doorway exhales a warm, cinnamon-scented gust that ruffles the floating forms into a neat, heavy stack, while Ms. Prudence Hark adjusts her round, thick glasses and taps her oversized clipboard twice with a violet pen. \'The stamp is valid, but the witness signature is missing,\' she announces, her voice slicing through the sudden silence like a paper cutter.';
    const out = withoutRepeatedSentences(text, recent);
    expect(out).not.toMatch(/\bMs\.\s*(?:['"‘“]|$)/);
    expect(out).not.toMatch(/^Prudence|\sPrudence Hark adjusts/);
  });

  it('the whisper filter drops the whole sentence, title and all', () => {
    const out = withoutDmWhispers('The rain stops. Ms. Hark hears a voice in her head that tells her to stamp it. Biz grins.');
    expect(out).toBe('The rain stops. Biz grins.');
  });

  it('the ending filter keeps the name with its title', () => {
    expect(publicEnding('Ms. Hark stamps the form. Liz and Biz walk home.', false)).toBe('Ms. Hark stamps the form. Liz and Biz walk home.');
  });

  it('a cut-off reply is not trimmed back to "…while Ms."', () => {
    expect(trimToLastSentence('Liz waits. The doorway sighs while Ms. Hark adjusts her')).toBe('Liz waits.');
  });

  it('the NPC pronoun fix reads "Ms. Hark… she" as one sentence', () => {
    const out = correctNpcPronouns('The drawer squeaks while Ms. Hark gasps, and he taps the clipboard.', [{ name: 'Ms. Prudence Hark', pronouns: 'she/her' }], PARTY, {}).text;
    expect(out).toBe('The drawer squeaks while Ms. Hark gasps, and she taps the clipboard.');
  });
});

// ─── 5. Other live bugs ─────────────────────────────────────────────────────

describe('5a. an empty spoken line is no line', () => {
  it('"", “”, \'\' and bare punctuation are dropped', () => {
    for (const s of ['""', '“”', "''", ' " " ', '...', '—', '', null, undefined]) expect(spokenOrNull(s as any)).toBeNull();
    expect(spokenOrNull('Mom, hold it.')).toBe('Mom, hold it.');
    expect(spokenOrNull('"Mom, hold it."')).toBe('"Mom, hold it."');
  });
});

describe('5b. an interview reply that repeats an earlier one word for word', () => {
  const first = 'It is wonderful to meet you, Liz. I have noted that you are a resourceful accountant who carries the weight of your world in a canvas tote. What is the one thing you are most determined to do to keep Biz safe here?';
  const history = [
    { role: 'user', content: 'I\'m Liz (she/her), a mom and a tired but resourceful accountant.' },
    { role: 'assistant', content: first },
    { role: 'user', content: 'I\'d calmly find a loophole in the fine print. High concept: Unflappable Accountant Mom.' },
  ];

  it('is recognised', () => {
    expect(repeatsEarlierReply(first, history)).toBe(true);
    expect(repeatsEarlierReply(`${first} `, history)).toBe(true);
    expect(repeatsEarlierReply('Unflappable Accountant Mom it is. What do you always carry?', history)).toBe(false);
  });

  it('the fallback is new, and says what is still needed or that the sheet is ready', () => {
    const ready = interviewFallbackReply({ ready: true, unmet: [], detail: [] });
    expect(ready).not.toBe(first);
    expect(ready).toMatch(/sheet|character/i);
    const notReady = interviewFallbackReply({ ready: false, unmet: ['skills'], detail: ['She needs at least 1 skill with a rating.'] });
    expect(notReady).toMatch(/skill/i);
  });
});

describe('5c. the DM never invents a surname for a player character', () => {
  const known = [...NPCS, 'The Intake Atrium', 'Form 7-C'];
  const fix = (t: string, party = PARTY) => withoutInventedPcSurnames(t, party, known);

  it('the live lines: "Hold your horses, Mrs. Miller!", "…Central Ledger, Mrs. Miller,\' Hark says"', () => {
    expect(fix('Clerk Barnaby Twist pokes his head through a narrow vent and squeaks, "Hold your horses, Mrs. Miller! I haven\'t found the correct signature stamp yet."'))
      .toBe('Clerk Barnaby Twist pokes his head through a narrow vent and squeaks, "Hold your horses, Liz! I haven\'t found the correct signature stamp yet."');
    expect(fix('\'The clause is void until the guardian\'s identity is cross-referenced with the Central Ledger, Mrs. Miller,\' Hark says.'))
      .toBe('\'The clause is void until the guardian\'s identity is cross-referenced with the Central Ledger, Liz,\' Hark says.');
    expect(fix('"You are a saint, Mrs. Miller, truly," he promises.')).toBe('"You are a saint, Liz, truly," he promises.');
  });

  it('a known NPC, a narrated person, or two possible PCs are left alone', () => {
    for (const t of [
      '"Good morning, Ms. Hark!" Liz says.',
      '"Hand me the pen, Mr. Twist," Liz says.',
      'Mrs. Miller waves from the tea cart. "Morning, Mrs. Miller!" Barnaby calls.',
    ]) expect(fix(t)).toBe(t);
    const twoShes: PronounMember[] = [LIZ, { name: 'Ann', pronouns: 'she/her', relationships: [] }];
    expect(fix('"Hold your horses, Mrs. Miller!"', twoShes)).toBe('"Hold your horses, Mrs. Miller!"');
    // A surname the sheet gives is hers.
    expect(fix('"Hold your horses, Mrs. Miller!"', [{ ...LIZ, name: 'Liz Miller' }, BIZ])).toBe('"Hold your horses, Mrs. Miller!"');
  });
});

describe('5d. the setup chat never narrates its own mechanics', () => {
  it('the live reply: "I am setting this to \'done\' so the world card can be generated for you to see."', () => {
    const live = 'You have given me a beautiful blueprint.\n\nInfluences recorded:\n1. Discworld\n2. Paddington\n\nI am setting this to \'done\' so the world card can be generated for you to see.';
    const out = withoutSetupMechanics(live, 'fallback');
    expect(out).not.toMatch(/done|world card can be generated/i);
    expect(out).toContain('Influences recorded:');
    expect(out).toContain('You have given me a beautiful blueprint.');
  });

  it('other mechanics: flags, JSON, dmInstructions', () => {
    const out = withoutSetupMechanics('Lovely. I\'ll mark this as done now. Setting "done": true in the JSON. Your world is taking shape.', 'fallback');
    expect(out).toBe('Lovely. Your world is taking shape.');
  });

  it('an ordinary "done" is kept', () => {
    const t = 'Are you done adding influences, or is there one more?';
    expect(withoutSetupMechanics(t, 'fallback')).toBe(t);
  });
});

describe('5e. a no-spoiler host never reads an NPC\'s secret trait', () => {
  const seed: WorldSeed = {
    premise: 'Liz and Biz arrive in Overage.',
    locations: [{ name: 'The Intake Atrium', description: 'Paper rain.', terrain: 'indoor' }],
    npcs: [
      { name: 'Ms. Prudence Hark', description: 'A small woman in a violet suit.', disposition: 'Formally polite, secretly frightened by chaos', motivation: 'Keep the queue', pronouns: 'she/her' },
      { name: 'Unit 7-G', description: 'A filing cabinet.', disposition: 'Opinionated, slow-moving, and loyal to routine', motivation: null, pronouns: 'it/its' },
      { name: 'Barnaby Twist', description: 'A clerk.', disposition: 'Secretly working for the Ledger', motivation: null, pronouns: 'he/him' },
    ],
    plotHooks: ['The stamp is missing.'],
  } as WorldSeed;

  it('the live disposition loses its "secretly…" clause', () => {
    expect(publicDisposition('Formally polite, secretly frightened by chaos')).toBe('Formally polite');
    expect(publicDisposition('Kind; privately a spy')).toBe('Kind');
    expect(publicDisposition('Opinionated, slow-moving, and loyal to routine')).toBe('Opinionated, slow-moving, and loyal to routine');
  });

  it('seedForHost hides it for a no-spoiler host, and only then', () => {
    const host = seedForHost(seed, true);
    expect(host.npcs[0]!.disposition).toBe('Formally polite');
    expect(host.npcs[1]!.disposition).toBe('Opinionated, slow-moving, and loyal to routine');
    expect(host.npcs[2]!.disposition).toBeNull();
    expect(JSON.stringify(host)).not.toMatch(/secretly/i);
    expect(seedForHost(seed, false).npcs[0]!.disposition).toBe('Formally polite, secretly frightened by chaos');
  });

  it('accepting the host\'s copy puts the hidden trait back', () => {
    const back = withHiddenSeedFields(seedForHost(seed, true), seed);
    expect(back.npcs[0]!.disposition).toBe('Formally polite, secretly frightened by chaos');
    expect(back.npcs[2]!.disposition).toBe('Secretly working for the Ledger');
    // A disposition the host rewrote is theirs.
    const edited = seedForHost(seed, true);
    edited.npcs[0] = { ...edited.npcs[0]!, disposition: 'Warm and brisk' };
    expect(withHiddenSeedFields(edited, seed).npcs[0]!.disposition).toBe('Warm and brisk');
  });
});

describe('5f. a stock line is never said twice in a game', () => {
  it('the live game: 19 compels alternating Biz and Liz, each line new ("Liz feels the pull of old habits…" came back)', () => {
    const lines = new LineRotation();
    const said: string[] = [];
    for (let i = 0; i < 19; i++) {
      const [name, trouble] = i % 2 === 0 ? ['Biz', 'Wanders off after anything shiny'] : ['Liz', 'I worry about Biz too much'];
      said.push(lines.pick('compel', compelLines(name, trouble), said.slice(-4).join('\n')));
    }
    expect(new Set(said).size).toBe(said.length);
  });

  it('…and the same for invokes', () => {
    const lines = new LineRotation();
    const said: string[] = [];
    for (let i = 0; i < 19; i++) {
      const [name, aspect] = i % 2 === 0 ? ['Biz', 'Curious Kid Collector'] : ['Liz', 'Unflappable Accountant Mom'];
      said.push(lines.pick('invoke', invokeLines(name, aspect), ''));
    }
    expect(new Set(said).size).toBe(said.length);
  });
});
