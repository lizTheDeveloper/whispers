// Round 14 (7RAAQ7): the same NPC filed twice — "The Next Pigeon" and
// "Next Pigeon", "Button" and "The Glossy Button" — and the pronoun prompts
// for the seed and the character sheet.
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const llmCalls: Array<Array<{ role: string; content: string }>> = [];
vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Array<{ role: string; content: string }> }) => {
    llmCalls.push(opts.messages);
    return { premise: 'p', locations: [], npcs: [], plotHooks: [], items: [], reply: 'ok', definition: null };
  }),
}));

import { WorldBible } from '../src/server/world-bible.js';
import { seedWorld } from '../src/server/world-seed.js';
import { DmAgent } from '../src/server/agents/dm.js';

let dir: string;
let db: Database.Database;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'whispers-r14-npcs-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dir;
  const { getDb } = await import('../src/server/db.js');
  db = getDb();
  llmCalls.length = 0;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const SEED = {
  premise: 'Liz and Biz have arrived in Oze.',
  locations: [{ name: 'The Lobby of First Impressions', description: 'Obsidian.', terrain: 'indoor' }, { name: 'The Department of Minor Misunderstandings', description: 'Rubber desks.', terrain: 'indoor' }],
  npcs: [
    { name: 'Clerk Ozymandias', description: 'A tall, thin figure.', disposition: 'Meticulous', motivation: null, pronouns: 'he/him' },
    { name: 'Button', description: 'A small, round, red button. It speaks in a squeak.', disposition: 'Chaotic', motivation: null, pronouns: 'it/its' },
    { name: 'Mama Pigeon', description: 'A large, fluffy pigeon. She clucks.', disposition: 'Maternal', motivation: null, pronouns: 'she/her' },
  ],
  plotHooks: [], items: [],
};

function campaign(): string {
  const id = `c-${Math.random().toString(36).slice(2)}`;
  db.prepare('INSERT INTO campaigns (id, join_code, name, dm_preset) VALUES (?, ?, ?, ?)').run(id, id.slice(-6).toUpperCase(), 'R14', 'chronicler');
  return id;
}
const npcNames = (cid: string) => (db.prepare("SELECT name FROM entities WHERE campaign_id = ? AND type IN ('npc','creature') ORDER BY rowid").all(cid) as Array<{ name: string }>).map(r => r.name);
const entity = (name: string) => ({ name, type: 'npc' as const, description: null, disposition: null });
const diff = (names: string[]) => ({ newLocations: [], newEntities: names.map(entity), newItems: [], newEvents: [], newRelationships: [] });

describe('the same NPC is filed once', () => {
  it('"Next Pigeon" after "The Next Pigeon" (and the reverse) is the same pigeon', () => {
    const cid = campaign();
    seedWorld(db, cid, SEED as any);
    const wb = new WorldBible(db);
    const loc = wb.getLocationByName(cid, 'The Department of Minor Misunderstandings')!;
    wb.ensureEntity(cid, 'The Next Pigeon', loc.id);
    wb.applyDiff(cid, diff(['Next Pigeon']), { markKnown: true });
    wb.ensureEntity(cid, 'Next Pigeon', loc.id);
    expect(npcNames(cid).filter(n => /Next Pigeon/.test(n))).toEqual(['The Next Pigeon']);
    expect(wb.findSameNpc(cid, 'next pigeon')?.name).toBe('The Next Pigeon');
  });

  it('"The Glossy Button" is Button, and keeps Button\'s it/its', () => {
    const cid = campaign();
    seedWorld(db, cid, SEED as any);
    const wb = new WorldBible(db);
    wb.applyDiff(cid, diff(['The Glossy Button']), { markKnown: true });
    expect(npcNames(cid)).toEqual(['Clerk Ozymandias', 'Button', 'Mama Pigeon']);
    expect(wb.getNpcPronouns(cid)).toContainEqual({ name: 'Button', pronouns: 'it/its' });
  });

  it('two NPCs are still two: The Next Pigeon is not Mama Pigeon, and a bare "Pigeon" matches neither', () => {
    const cid = campaign();
    seedWorld(db, cid, SEED as any);
    const wb = new WorldBible(db);
    wb.applyDiff(cid, diff(['The Next Pigeon']), { markKnown: true });
    expect(npcNames(cid)).toContain('The Next Pigeon');
    expect(npcNames(cid)).toContain('Mama Pigeon');
    expect(wb.findSameNpc(cid, 'Pigeon')).toBeNull();
  });

  it('a short name after the full one ("Ozymandias") is the clerk', () => {
    const cid = campaign();
    seedWorld(db, cid, SEED as any);
    const wb = new WorldBible(db);
    wb.applyDiff(cid, diff(['Ozymandias']), { markKnown: true });
    expect(npcNames(cid)).toEqual(['Clerk Ozymandias', 'Button', 'Mama Pigeon']);
  });

  it('a seed\'s own NPCs are all kept, even when one\'s name contains another\'s', () => {
    const cid = campaign();
    seedWorld(db, cid, { ...SEED, npcs: [...SEED.npcs, { name: 'Button\'s Assistant', description: 'A paperclip.', disposition: 'Eager', motivation: null, pronouns: 'she/her' }] } as any);
    expect(npcNames(cid)).toContain('Button\'s Assistant');
  });
});

describe('pronouns in the seed and character-sheet prompts', () => {
  it('a redraft of the world tells the builder every NPC\'s pronouns are fixed — Button is "it", never "them"', async () => {
    await new DmAgent(db).draftWorldSeed({ preset: 'chronicler', systemId: 'fate-core', influences: ['Discworld'], dmInstructions: '', history: [{ role: 'user', content: 'Paperwork isekai.' }], existing: SEED as any });
    const prompt = llmCalls[0]!.map(m => m.content).join('\n');
    expect(prompt).toContain('Button: it/its');
    expect(prompt).toContain('Mama Pigeon: she/her');
    expect(prompt).toMatch(/no one remembers hiring it/);
  });

  it('a first draft still gets the rule with the it/its example', async () => {
    await new DmAgent(db).draftWorldSeed({ preset: 'chronicler', systemId: 'fate-core', influences: [], dmInstructions: '', history: [{ role: 'user', content: 'Paperwork isekai.' }], existing: null });
    expect(llmCalls[0]!.map(m => m.content).join('\n')).toMatch(/no one remembers hiring it/);
  });

  it('the interview keeps a companion\'s locked pronouns in the sheet: Biz is "afraid of losing her", not "them"', async () => {
    await new DmAgent(db).interviewForCharacter({
      systemId: 'fate-core', preset: 'chronicler', playerName: 'Biz', influences: [], seed: SEED as any,
      history: [{ role: 'user', content: 'I am Biz, I use they/them, Liz is my mom.' }], unmet: [],
      tableCharacters: [{ name: 'Liz', highConcept: 'Unflappable Accountant Mom', pronouns: 'she/her' }],
    });
    const prompt = llmCalls[0]!.map(m => m.content).join('\n');
    expect(prompt).toMatch(/personality, backstory/i);
    expect(prompt).toContain('afraid of losing her');
  });
});
