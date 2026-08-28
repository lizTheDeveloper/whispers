import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE VIRTUAL TABLE rule_chunks USING fts5(system_id, source_book, section, content, tokenize='porter');`);
  return db;
}

describe('RAG rulebook system', () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('ingests text and returns chunk count', async () => {
    const { ingestText } = await import('../src/server/rag/ingest.js');
    const text = `# Skills\nSkills represent training.\n\n# Aspects\nAspects describe who your character is.`;
    const count = ingestText(db, 'fate-core', 'FATE Core SRD', text);
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('searches for rules by keyword', async () => {
    const { ingestText } = await import('../src/server/rag/ingest.js');
    const { searchRules } = await import('../src/server/rag/search.js');
    ingestText(db, 'fate-core', 'FATE Core SRD', `# Combat\nTo attack, roll your Fight skill vs the opponent.\n\n# Social\nTo persuade, roll Rapport vs Will.`);
    const results = searchRules(db, 'fate-core', 'attack combat fight', 3);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.content).toContain('attack');
  });

  it('scopes search to a specific system', async () => {
    const { ingestText } = await import('../src/server/rag/ingest.js');
    const { searchRules } = await import('../src/server/rag/search.js');
    ingestText(db, 'fate-core', 'FATE Core', '# Magic\nFATE has no magic system by default.');
    ingestText(db, 'dnd5e', 'D&D 5e SRD', '# Magic\nSpellcasters can cast spells using spell slots.');
    const fateResults = searchRules(db, 'fate-core', 'magic', 3);
    const dndResults = searchRules(db, 'dnd5e', 'magic', 3);
    expect(fateResults[0]!.content).toContain('no magic system');
    expect(dndResults[0]!.content).toContain('spell slots');
  });

  it('returns empty array for no matches', async () => {
    const { searchRules } = await import('../src/server/rag/search.js');
    const results = searchRules(db, 'fate-core', 'xyzzy', 3);
    expect(results).toEqual([]);
  });
});
