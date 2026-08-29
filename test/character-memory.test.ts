import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CharacterMemoryStore } from '../src/server/character-memory.js';

let db: Database.Database;
let store: CharacterMemoryStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE character_memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      scene_number INTEGER NOT NULL,
      turn_number INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      emotional_valence REAL NOT NULL DEFAULT 0.0,
      importance REAL NOT NULL DEFAULT 0.5,
      decay_rate REAL NOT NULL DEFAULT 0.05,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  store = new CharacterMemoryStore(db);
});

afterEach(() => {
  db.close();
});

describe('CharacterMemoryStore', () => {
  describe('recall', () => {
    it('returns memories ordered by importance', () => {
      const insert = db.prepare(
        `INSERT INTO character_memories (id, character_id, campaign_id, scene_number, turn_number, type, content, emotional_valence, importance, decay_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run('m1', 'char1', 'camp1', 1, 1, 'action', 'I drew my sword', 0, 0.3, 0.05);
      insert.run('m2', 'char1', 'camp1', 1, 2, 'emotional', 'The betrayal cut deep', -0.8, 0.9, 0.02);
      insert.run('m3', 'char1', 'camp1', 1, 3, 'discovery', 'Found the hidden passage', 0.5, 0.6, 0.05);

      const memories = store.recall('char1');
      expect(memories).toHaveLength(3);
      expect(memories[0].content).toBe('The betrayal cut deep');
      expect(memories[1].content).toBe('Found the hidden passage');
      expect(memories[2].content).toBe('I drew my sword');
    });

    it('respects limit', () => {
      const insert = db.prepare(
        `INSERT INTO character_memories (id, character_id, campaign_id, scene_number, turn_number, type, content, emotional_valence, importance, decay_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 0; i < 20; i++) {
        insert.run(`m${i}`, 'char1', 'camp1', 1, i, 'action', `Memory ${i}`, 0, Math.random(), 0.05);
      }

      const memories = store.recall('char1', 5);
      expect(memories).toHaveLength(5);
    });

    it('isolates memories by character', () => {
      const insert = db.prepare(
        `INSERT INTO character_memories (id, character_id, campaign_id, scene_number, turn_number, type, content, emotional_valence, importance, decay_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run('m1', 'char1', 'camp1', 1, 1, 'action', 'Char1 memory', 0, 0.5, 0.05);
      insert.run('m2', 'char2', 'camp1', 1, 1, 'action', 'Char2 memory', 0, 0.5, 0.05);

      const char1Memories = store.recall('char1');
      expect(char1Memories).toHaveLength(1);
      expect(char1Memories[0].content).toBe('Char1 memory');
    });
  });

  describe('recallByType', () => {
    it('filters by memory type', () => {
      const insert = db.prepare(
        `INSERT INTO character_memories (id, character_id, campaign_id, scene_number, turn_number, type, content, emotional_valence, importance, decay_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run('m1', 'char1', 'camp1', 1, 1, 'action', 'Swung my axe', 0, 0.5, 0.05);
      insert.run('m2', 'char1', 'camp1', 1, 2, 'whisper', 'The voice told me to run', -0.2, 0.7, 0.05);
      insert.run('m3', 'char1', 'camp1', 1, 3, 'action', 'Blocked the strike', 0.2, 0.6, 0.05);

      const whisperMemories = store.recallByType('char1', 'whisper');
      expect(whisperMemories).toHaveLength(1);
      expect(whisperMemories[0].content).toBe('The voice told me to run');
    });
  });

  describe('decayMemories', () => {
    it('reduces importance by decay_rate', () => {
      const insert = db.prepare(
        `INSERT INTO character_memories (id, character_id, campaign_id, scene_number, turn_number, type, content, emotional_valence, importance, decay_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run('m1', 'char1', 'camp1', 1, 1, 'action', 'Drew my sword', 0, 0.5, 0.1);
      insert.run('m2', 'char1', 'camp1', 1, 2, 'emotional', 'The betrayal', -0.8, 0.9, 0.02);

      store.decayMemories('char1');

      const memories = store.recall('char1');
      const m1 = memories.find(m => m.id === 'm1')!;
      const m2 = memories.find(m => m.id === 'm2')!;
      expect(m1.importance).toBeCloseTo(0.4, 1);
      expect(m2.importance).toBeCloseTo(0.88, 1);
    });

    it('does not decay below 0.01', () => {
      const insert = db.prepare(
        `INSERT INTO character_memories (id, character_id, campaign_id, scene_number, turn_number, type, content, emotional_valence, importance, decay_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run('m1', 'char1', 'camp1', 1, 1, 'action', 'Old memory', 0, 0.03, 0.1);

      store.decayMemories('char1');

      const memories = store.recall('char1');
      expect(memories[0].importance).toBeGreaterThanOrEqual(0.01);
    });
  });

  describe('formatForPrompt', () => {
    it('formats memories with emotional tags', () => {
      const memories = [
        { id: '1', characterId: 'c', campaignId: 'c', sceneNumber: 1, turnNumber: 1, type: 'emotional' as const, content: 'Lost my friend', emotionalValence: -0.8, importance: 0.9, decayRate: 0.02, createdAt: '' },
        { id: '2', characterId: 'c', campaignId: 'c', sceneNumber: 1, turnNumber: 2, type: 'action' as const, content: 'Found the key', emotionalValence: 0.5, importance: 0.6, decayRate: 0.05, createdAt: '' },
        { id: '3', characterId: 'c', campaignId: 'c', sceneNumber: 1, turnNumber: 3, type: 'action' as const, content: 'Walked through town', emotionalValence: 0, importance: 0.3, decayRate: 0.05, createdAt: '' },
      ];

      const prompt = store.formatForPrompt(memories);
      expect(prompt).toContain('Lost my friend (painful)');
      expect(prompt).toContain('Found the key (positive)');
      expect(prompt).toContain('Walked through town');
      expect(prompt).not.toContain('Walked through town (');
    });

    it('returns empty string for no memories', () => {
      expect(store.formatForPrompt([])).toBe('');
    });
  });
});
