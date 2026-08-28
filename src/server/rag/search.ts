import type Database from 'better-sqlite3';

export interface RuleChunk {
  systemId: string;
  sourceBook: string;
  section: string;
  content: string;
}

export function searchRules(db: Database.Database, systemId: string, query: string, limit = 3): RuleChunk[] {
  const safeQuery = query.replace(/['"]/g, '').trim();
  if (!safeQuery) return [];
  try {
    const rows = db.prepare(`
      SELECT system_id, source_book, section, content
      FROM rule_chunks
      WHERE rule_chunks MATCH ? AND system_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(safeQuery, systemId, limit) as any[];
    return rows.map(r => ({
      systemId: r.system_id,
      sourceBook: r.source_book,
      section: r.section,
      content: r.content,
    }));
  } catch {
    return [];
  }
}
