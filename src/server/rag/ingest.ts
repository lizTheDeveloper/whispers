import type Database from 'better-sqlite3';

const TARGET_CHUNK_CHARS = 2000;
const OVERLAP_CHARS = 200;

export function ingestText(db: Database.Database, systemId: string, sourceBook: string, text: string): number {
  const sections = splitBySections(text);
  const insert = db.prepare('INSERT INTO rule_chunks (system_id, source_book, section, content) VALUES (?, ?, ?, ?)');
  let count = 0;
  const tx = db.transaction(() => {
    for (const { heading, body } of sections) {
      const chunks = chunkText(body, TARGET_CHUNK_CHARS, OVERLAP_CHARS);
      for (const chunk of chunks) {
        insert.run(systemId, sourceBook, heading, chunk);
        count++;
      }
    }
  });
  tx();
  return count;
}

function splitBySections(text: string): Array<{ heading: string; body: string }> {
  const lines = text.split('\n');
  const sections: Array<{ heading: string; body: string }> = [];
  let currentHeading = 'General';
  let currentBody: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      if (currentBody.length > 0) {
        sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() });
      }
      currentHeading = headingMatch[1]!;
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentBody.length > 0) {
    sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() });
  }
  return sections.filter(s => s.body.length > 0);
}

function chunkText(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    chunks.push(text.slice(start, end));
    start = end - overlap;
    if (start >= text.length - overlap) break;
  }
  return chunks;
}

export async function ingestPdf(db: Database.Database, systemId: string, sourceBook: string, buffer: Buffer): Promise<number> {
  const pdfParse = (await import('pdf-parse')).default;
  const data = await pdfParse(buffer);
  return ingestText(db, systemId, sourceBook, data.text);
}
