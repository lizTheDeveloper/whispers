// Round 20: the default rating — gentle for a gentle ask or a child PC,
// else storybook — and the host's choice over it. Every server module is
// imported after STATE_DIR is set, so this file's database is its own.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';

describe('the default rating', () => {
  let dataDir: string;
  let db: Database.Database;
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'whispers-r20-setup-'));
    process.env.DATA_DIR = join(__dirname, '..', 'data');
    process.env.STATE_DIR = dataDir;
    const mod = await import('../src/server/db.js');
    // Never the repo's data/ database (another test file may hold it).
    expect(mod.getStateDir()).toBe(dataDir);
    db = mod.getDb();
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  const sheet = (name: string, age?: number): CharacterDefinition => ({ name, highConcept: 'x', trouble: 'y', aspects: [], personality: '', backstory: '', skills: {}, stunts: [], ...(age !== undefined ? { age } : {}) });

  async function table(opts: { hostSays?: string; sheets?: CharacterDefinition[] } = {}) {
    const room = await import('../src/server/room.js');
    const { makeCharacterLive } = await import('../src/server/character-live.js');
    const created = room.createRoom(db, { name: 'R20', dmPreset: 'chronicler', systemId: 'fate-core' });
    if (opts.hostSays) db.prepare('UPDATE campaigns SET setup_chat = ? WHERE id = ?').run(JSON.stringify([{ role: 'user', content: opts.hostSays }]), created.campaignId);
    for (const [i, definition] of (opts.sheets ?? []).entries()) {
      const session = room.createSession(db, { campaignId: created.campaignId, joinCode: created.joinCode, playerName: `p${i}`, isHost: i === 0 });
      const pending = { id: `c${i}-${created.campaignId}`, campaignId: created.campaignId, joinCode: created.joinCode, sessionToken: session.token, playerName: `p${i}`, definition, aiFeedback: 'ok' };
      room.savePendingCharacter(db, pending);
      makeCharacterLive(db, pending);
    }
    return created.campaignId;
  }

  it('is gentle when the host asked for gentle peril in the setup chat', async () => {
    const { tableRating } = await import('../src/server/content-rating.js');
    const id = await table({ hostSays: 'Gentle peril only, nothing scary.' });
    expect(tableRating(db, id)).toEqual({ rating: 'gentle', explicit: false, childPresent: false });
  });

  it('is gentle when a player character is a child', async () => {
    const { tableRating } = await import('../src/server/content-rating.js');
    const id = await table({ hostSays: 'A heist in a floating city.', sheets: [sheet('Liz', 40), sheet('Biz', 10)] });
    expect(tableRating(db, id)).toEqual({ rating: 'gentle', explicit: false, childPresent: true });
  });

  it('is storybook otherwise, and the host\'s choice beats the default — even with a child PC', async () => {
    const { tableRating, setStoredContentRating } = await import('../src/server/content-rating.js');
    const adults = await table({ hostSays: 'A heist.', sheets: [sheet('Ada', 30)] });
    expect(tableRating(db, adults).rating).toBe('storybook');
    const family = await table({ sheets: [sheet('Biz', 10)] });
    setStoredContentRating(db, family, 'adventure');
    expect(tableRating(db, family)).toEqual({ rating: 'adventure', explicit: true, childPresent: true });
  });
});
