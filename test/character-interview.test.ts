import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let db: any;
let mod: typeof import('../src/server/character-interview.js');
let createRoom: typeof import('../src/server/room.js').createRoom;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-interview-'));
  process.env.DATA_DIR = dataDir;
  // DATA_DIR is bound at module load, so import after setting it.
  db = (await import('../src/server/db.js')).getDb();
  mod = await import('../src/server/character-interview.js');
  ({ createRoom } = await import('../src/server/room.js'));
});

afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

function newCampaign() {
  return createRoom(db, { name: 'Interview Test', dmPreset: 'chronicler', systemId: 'fate-core' }).campaignId;
}

describe('interview persistence', () => {
  it('creates one record per session and returns the same one afterwards', () => {
    const c = newCampaign();
    const a = mod.getOrCreateInterview(db, c, 'token-a');
    const b = mod.getOrCreateInterview(db, c, 'token-a');
    expect(b.id).toBe(a.id);
    expect(mod.getOrCreateInterview(db, c, 'token-b').id).not.toBe(a.id);
  });

  it('appends turns in order and survives a fresh read', () => {
    const c = newCampaign();
    const rec = mod.getOrCreateInterview(db, c, 'tok');
    mod.appendInterviewTurn(db, rec.id, { role: 'assistant', content: 'What are you thinking about?' });
    mod.appendInterviewTurn(db, rec.id, { role: 'user', content: 'The dust.' });

    const read = mod.getInterviewBySession(db, c, 'tok')!;
    expect(read.transcript.map(t => t.content)).toEqual(['What are you thinking about?', 'The dust.']);
  });

  it('stores a derived definition and a status', () => {
    const c = newCampaign();
    const rec = mod.getOrCreateInterview(db, c, 'tok');
    expect(rec.definition).toBeNull();
    expect(rec.status).toBe('open');

    mod.setInterviewDefinition(db, rec.id, { name: 'Vesper Ash' } as any);
    mod.setInterviewStatus(db, rec.id, 'confirmed');

    const read = mod.getInterviewBySession(db, c, 'tok')!;
    expect(read.definition?.name).toBe('Vesper Ash');
    expect(read.status).toBe('confirmed');
  });

  it('keeps the transcript after the definition is derived — the raw conversation is the point', () => {
    const c = newCampaign();
    const rec = mod.getOrCreateInterview(db, c, 'tok');
    mod.appendInterviewTurn(db, rec.id, { role: 'user', content: 'I never look back.' });
    mod.setInterviewDefinition(db, rec.id, { name: 'Vesper Ash' } as any);
    mod.setInterviewStatus(db, rec.id, 'live');

    const read = mod.getInterviewBySession(db, c, 'tok')!;
    expect(read.transcript).toHaveLength(1);
    expect(read.transcript[0]!.content).toBe('I never look back.');
  });

  it('degrades to an empty transcript rather than throwing on corrupt JSON', () => {
    const c = newCampaign();
    const rec = mod.getOrCreateInterview(db, c, 'tok');
    db.prepare('UPDATE character_interviews SET transcript = ? WHERE id = ?').run('not json{', rec.id);
    const read = mod.getInterviewBySession(db, c, 'tok')!;
    expect(read.transcript).toEqual([]);
  });

  it('returns null for a session that has no interview', () => {
    expect(mod.getInterviewBySession(db, newCampaign(), 'nobody')).toBeNull();
  });
});
