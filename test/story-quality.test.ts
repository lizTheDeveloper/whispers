// test/story-quality.test.ts
//
// Narration-quality bugs from a live verification game: a mom (Liz) and her
// 10-year-old kid (Biz) isekai'd into a bureaucratic fantasy world by a
// paperwork error, with a host who asked not to be spoiled.
//
//  1. The opening was scenery only — nobody arrived. The premise is ABOUT
//     them arriving, so the opening must be told from their point of view at
//     the moment the premise puts them there.
//  2. Introductions ended in "Biz is Liz's son." / "Liz is Biz's mother (Biz
//     calls her "Mom")." — a safety net appending sheet facts the DM prose had
//     already stated, in a form that read like leaked instructions.
//  3. Biz became a "son" although nobody gave Biz a gender.
//  4. NPCs called Liz "Mom": the address term reached the DM as if it were
//     Liz's name for everyone.
//  5. The world card told a no-spoilers host that "rumors hint at a
//     deliberate cover-up".
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorldSeed } from '../src/shared/types.js';
import type { PartyMember } from '../src/server/agents/dm.js';

const llmCalls: Array<Array<{ role: string; content: string }>> = [];
vi.mock('../src/server/agents/llm-client.js', () => ({
  callLlm: vi.fn(async (opts: { messages: Array<{ role: string; content: string }> }) => {
    llmCalls.push(opts.messages);
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('OPENING OF THE ADVENTURE')) return { narration: '', introductions: [], currentLocationName: '' };
    if (all.includes('world builder')) {
      return { premise: 'p', locations: [], npcs: [], plotHooks: [], items: [] };
    }
    if (all.includes('character creation API')) return { reply: 'Who are they?', definition: null };
    return 'The lamp is lit.';
  }),
}));

let dataDir: string;
let db: Database.Database;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-story-quality-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  const dbMod = await import('../src/server/db.js');
  db = dbMod.getDb();
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

const LIZ: PartyMember = {
  name: 'Liz',
  highConcept: 'Overworked Mom With a Clipboard Heart',
  age: 38,
  relationships: [{ to: 'Biz', relation: 'kid', address: 'Biz' }],
};
const BIZ: PartyMember = {
  name: 'Biz',
  highConcept: 'Ten-Year-Old Who Asks Why',
  age: 10,
  relationships: [{ to: 'Liz', relation: 'mother', address: 'Mom' }],
};

const ISEKAI_PREMISE = 'A clerical error in the Bureau of Misfiled Souls has isekaied a mother and her kid out of their own world and into Grand Postalopolis, a city run on forms.';

describe('the opening is an arrival, from the characters\' point of view', () => {
  it('tells the DM to open at the moment the premise puts the party there, arriving if the premise implies transport', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    const { createRoom } = await import('../src/server/room.js');
    const { campaignId } = createRoom(db, { name: 'Arrival', dmPreset: 'chronicler', systemId: 'fate-core' });
    llmCalls.length = 0;
    await new DmAgent(db).openScene({
      preset: 'chronicler', houseRules: null, dmInstructions: null, dmCustomPrompt: null,
      campaignId, worldSummary: '', transcript: [], systemId: 'fate-core', influences: [],
      party: [
        { ...LIZ, backstory: 'A single mom from Ohio who never misses a deadline.' },
        { ...BIZ, backstory: 'Ten years old, collects bottle caps, asks why.' },
      ],
    }, { premise: ISEKAI_PREMISE, scenarioOpening: null, places: [{ name: 'The Intake Hall', description: 'Endless queues.' }] });
    const sent = llmCalls[0]!.map(m => m.content).join('\n');
    expect(sent).toContain('OPENING OF THE ADVENTURE');
    expect(sent).toMatch(/from the characters' point of view/i);
    expect(sent).toMatch(/just arrived|arriving|arrival/i);
    expect(sent).toMatch(/disorient/i);
    expect(sent).toMatch(/not (just|only|merely) (scenery|a description of the place)/i);
    // The backstories inform where they come from, so the arrival can land.
    expect(sent).toContain('A single mom from Ohio');
    // Still no secrets.
    expect(sent).toMatch(/Do NOT reveal secrets/);
  });
});

describe('introductions do not append sheet facts the prose already states', () => {
  it('appends nothing when the DM prose already says "Biz\'s mother"', async () => {
    const { introduceCharacter } = await import('../src/server/agents/dm.js');
    const lizAsMother: PartyMember = { ...LIZ, relationships: [{ to: 'Biz', relation: 'son', address: 'Biz' }] };
    const prose = "Liz, Biz's mother, stands tall, a protective hand already reaching for her child's.";
    expect(introduceCharacter(lizAsMother, prose, [lizAsMother, BIZ])).toBe(prose);
  });

  it('accepts the relation word or its inverse, with the other character\'s name', async () => {
    const { introduceCharacter } = await import('../src/server/agents/dm.js');
    const prose = "Biz, Liz's ten-year-old kid, fidgets with a bottle cap.";
    // Biz's sheet says Liz is Biz's "mother"; the prose says Biz is Liz's kid — the same tie.
    expect(introduceCharacter(BIZ, prose, [LIZ, BIZ])).toBe(prose);
  });

  it('appends a natural clause — no parenthetical, no "calls her" — when the tie really is missing', async () => {
    const { introduceCharacter } = await import('../src/server/agents/dm.js');
    const prose = 'Biz fidgets with a bottle cap, eyes everywhere at once.';
    const text = introduceCharacter(BIZ, prose, [LIZ, BIZ]);
    expect(text.startsWith(prose)).toBe(true);
    const added = text.slice(prose.length);
    expect(added).toMatch(/Liz/);
    expect(added).toMatch(/mother/);
    expect(added).not.toContain('(');
    expect(added).not.toMatch(/calls (her|him|them)/);
    expect(added).not.toContain('Mom');
    expect(added).not.toMatch(/\bBiz is Liz's\b|\bLiz is Biz's\b/);
  });

  it('the sheet-only introduction is natural too', async () => {
    const { introduceCharacter } = await import('../src/server/agents/dm.js');
    const text = introduceCharacter(BIZ, undefined, [LIZ, BIZ]);
    expect(text).toContain('Ten-Year-Old Who Asks Why');
    expect(text).toMatch(/mother/);
    expect(text).not.toContain('(');
    expect(text).not.toContain('Mom');
  });
});

describe('gender is never guessed', () => {
  it('the inverse of a relation is gender-neutral unless pronouns are known', async () => {
    const { inverseRelation } = await import('../src/server/agents/dm.js');
    expect(inverseRelation('mother')).toBe('child');
    expect(inverseRelation('mom')).toBe('child');
    expect(inverseRelation('father', 'they/them')).toBe('child');
    expect(inverseRelation('mother', 'he/him')).toBe('son');
    expect(inverseRelation('mother', 'she/her')).toBe('daughter');
    expect(inverseRelation('son')).toBe('parent');
    expect(inverseRelation('kid', 'she/her')).toBe('mother');
  });

  it('no introduction generates "son" or "daughter" for a character with no stated pronouns', async () => {
    const { introduceCharacter } = await import('../src/server/agents/dm.js');
    for (const prose of [undefined, 'Biz fidgets.', 'Liz squares her shoulders.']) {
      for (const m of [LIZ, BIZ]) {
        const text = introduceCharacter(m, prose, [LIZ, BIZ]);
        expect(text).not.toMatch(/\b(son|daughter|boy|girl)\b/i);
      }
    }
  });

  it('uses pronouns in the party block when they are set', async () => {
    const { describeParty } = await import('../src/server/agents/dm.js');
    const block = describeParty([LIZ, { ...BIZ, pronouns: 'she/her' }]);
    expect(block).toMatch(/Biz[^\n]*pronouns: she\/her/);
  });

  it('tells the DM not to guess when pronouns are unset', async () => {
    const { describeParty } = await import('../src/server/agents/dm.js');
    const block = describeParty([LIZ, BIZ]);
    const bizLine = block.split('\n').find(l => l.startsWith('- Biz'))!;
    expect(bizLine).toMatch(/gender and pronouns (are )?(not stated|unspecified)/i);
    expect(bizLine).toMatch(/"they"/);
    expect(block).toMatch(/gender-neutral/i);
    expect(block).toMatch(/kid|child/);
  });

  it('the interview records pronouns only when stated, and never genders a relation the player did not', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    llmCalls.length = 0;
    await new DmAgent(db).interviewForCharacter({ systemId: 'fate-core', preset: 'chronicler', playerName: 'Biz', influences: [], seed: null, history: [{ role: 'user', content: "I'm Biz, I'm 10, and I'm here with my mom Liz" }], unmet: [] });
    const system = llmCalls[0]![0]!.content;
    expect(system).toContain('"pronouns"');
    expect(system).not.toMatch(/a boy whose mother/);
    expect(system).toMatch(/never assume a gender/i);
  });

  it('the interview schema keeps stated pronouns and drops empty ones', async () => {
    const { CharInterviewReplySchema } = await import('../src/server/agents/schemas.js');
    const base = { name: 'Biz', highConcept: 'x', trouble: 'y', aspects: [], personality: '', backstory: '', skills: {}, stunts: [] };
    expect(CharInterviewReplySchema.parse({ reply: 'ok', definition: { ...base, pronouns: 'she/her' } }).definition?.pronouns).toBe('she/her');
    expect(CharInterviewReplySchema.parse({ reply: 'ok', definition: { ...base, pronouns: null } }).definition?.pronouns).toBeUndefined();
    expect(CharInterviewReplySchema.parse({ reply: 'ok', definition: { ...base, pronouns: '  ' } }).definition?.pronouns).toBeUndefined();
  });
});

describe('address terms are personal to the relationship', () => {
  it('scopes "Mom" to Biz: everyone else calls her Liz', async () => {
    const { describeParty } = await import('../src/server/agents/dm.js');
    const block = describeParty([LIZ, BIZ]);
    expect(block).toMatch(/Biz calls Liz "Mom"/);
    expect(block).toMatch(/everyone else[^.\n]*calls (her|Liz) "?Liz"?/i);
    expect(block).not.toMatch(/\(Biz calls her "Mom"\)/);
    expect(block).toMatch(/address terms? (is|are) personal/i);
  });

  it('keeps address terms out of the relationship sentences the world bible and introductions use', async () => {
    const { describeRelationships } = await import('../src/server/agents/dm.js');
    const [line] = describeRelationships(BIZ);
    expect(line).toBe("Liz is Biz's mother.");
  });
});

describe('player-visible world text keeps the mystery hidden', () => {
  const seed: WorldSeed = {
    premise: ISEKAI_PREMISE,
    locations: [{ name: 'The Intake Hall', description: 'Queues.', terrain: 'interior' }],
    npcs: [{ name: 'Mirabel', description: 'A stamp clerk.', disposition: 'brisk', motivation: 'Keep her desk clear.' }],
    plotHooks: ['Form 27-B is missing.'],
    items: [],
  };

  it('the world seed forbids spoilers in every field the world card shows', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    llmCalls.length = 0;
    await new DmAgent(db).draftWorldSeed({ preset: 'chronicler', systemId: 'fate-core', influences: ['Pratchett'], dmInstructions: 'Bureaucratic isekai; host wants no spoilers.', history: [{ role: 'user', content: 'whose mistake was it? do not tell me' }], existing: null });
    const system = llmCalls[0]![0]!.content;
    expect(system).toMatch(/NO SPOILERS/);
    expect(system).toMatch(/host (will )?(reads?|sees?)/i);
    expect(system).toMatch(/culprit|who is responsible|who is behind/i);
    expect(system).toMatch(/rumou?rs? (that )?hint/i);
    for (const field of ['premise', 'descriptions', 'motivations', 'plotHooks']) expect(system).toContain(field);
  });

  it('introduceWorld forbids spoilers and hints at the answer', async () => {
    const { DmAgent } = await import('../src/server/agents/dm.js');
    llmCalls.length = 0;
    await new DmAgent(db).introduceWorld({ preset: 'chronicler', influences: [], seed });
    const system = llmCalls[0]![0]!.content;
    expect(system).toMatch(/NO SPOILERS/);
    expect(system).toMatch(/culprit|who is responsible|who is behind/i);
    expect(system).toMatch(/rumou?rs? (that )?hint/i);
  });
});
