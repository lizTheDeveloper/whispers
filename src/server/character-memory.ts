import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { callLlm } from './agents/llm-client.js';
import { z } from 'zod';

export type MemoryType = 'action' | 'outcome' | 'social' | 'whisper' | 'discovery' | 'emotional';

export interface CharacterMemory {
  id: string;
  characterId: string;
  campaignId: string;
  sceneNumber: number;
  turnNumber: number;
  type: MemoryType;
  content: string;
  emotionalValence: number; // -1 (traumatic) to 1 (joyful)
  importance: number;       // 0 to 1, decays over time
  decayRate: number;        // how fast importance fades per scene
  createdAt: string;
}

const MEMORY_TYPES = ['action', 'outcome', 'social', 'whisper', 'discovery', 'emotional'] as const;
const MemoryExtractionSchema = z.object({
  memories: z.array(z.object({
    type: z.string().transform(t => {
      const first = t.split(/[|,/]/).map(s => s.trim().toLowerCase())[0] ?? 'action';
      return (MEMORY_TYPES as readonly string[]).includes(first) ? first as MemoryType : 'action' as MemoryType;
    }),
    content: z.string(),
    emotionalValence: z.number().min(-1).max(1).default(0),
    importance: z.number().min(0).max(1).default(0.5),
  })),
});

export class CharacterMemoryStore {
  constructor(private db: Database.Database) {}

  async extractAndStore(
    characterId: string,
    campaignId: string,
    characterName: string,
    action: string,
    outcome: string,
    whisper: string | null,
    sceneNumber: number,
    turnNumber: number,
  ): Promise<CharacterMemory[]> {
    const whisperCtx = whisper ? `\nA voice whispered: "${whisper}"` : '';

    let memories: Array<{ type: MemoryType; content: string; emotionalValence: number; importance: number }>;
    try {
      const result = await callLlm({
        messages: [
          {
            role: 'system',
            content: `You extract episodic memories for a character named ${characterName}. Memories are first-person, concise (1-2 sentences), and capture what the character would actually remember — not a transcript summary. Focus on emotional impact, consequences, and relationships. Respond with ONLY a JSON object.`,
          },
          {
            role: 'user',
            content: `${characterName} did: "${action}"\nOutcome: "${outcome}"${whisperCtx}\n\nExtract 1-3 memories. Return ONLY JSON:\n{"memories": [{"type": "action|outcome|social|whisper|discovery|emotional", "content": "first-person memory", "emotionalValence": -1 to 1, "importance": 0 to 1}]}`,
          },
        ],
        schema: MemoryExtractionSchema,
        temperature: 0.3,
      });
      memories = result.memories.map(m => ({
        type: m.type as MemoryType,
        content: m.content,
        emotionalValence: m.emotionalValence ?? 0,
        importance: m.importance ?? 0.5,
      }));
    } catch {
      memories = [{
        type: 'action' as const,
        content: `I ${action.toLowerCase()}. ${outcome}`,
        emotionalValence: 0,
        importance: 0.5,
      }];
    }

    const stored: CharacterMemory[] = [];
    const insert = this.db.prepare(
      `INSERT INTO character_memories (id, character_id, campaign_id, scene_number, turn_number, type, content, emotional_valence, importance, decay_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const mem of memories) {
      const basDecay = mem.importance > 0.8 ? 0.02 : 0.05;
      const decayRate = (mem.type === 'social' || mem.type === 'discovery') ? basDecay * 0.5 : basDecay;
      const record: CharacterMemory = {
        id: randomBytes(16).toString('hex'),
        characterId,
        campaignId,
        sceneNumber,
        turnNumber,
        type: mem.type,
        content: mem.content,
        emotionalValence: mem.emotionalValence,
        importance: mem.importance,
        decayRate,
        createdAt: new Date().toISOString(),
      };
      insert.run(record.id, characterId, campaignId, sceneNumber, turnNumber, record.type, record.content, record.emotionalValence, record.importance, record.decayRate);
      stored.push(record);
    }

    return stored;
  }

  recall(characterId: string, limit = 10, sceneContext?: string): CharacterMemory[] {
    const rows = this.db.prepare(
      `SELECT * FROM character_memories WHERE character_id = ? ORDER BY importance DESC, created_at DESC LIMIT ?`,
    ).all(characterId, limit * 2) as any[];

    const all = rows.map(r => ({
      id: r.id,
      characterId: r.character_id,
      campaignId: r.campaign_id,
      sceneNumber: r.scene_number,
      turnNumber: r.turn_number,
      type: r.type as MemoryType,
      content: r.content as string,
      emotionalValence: r.emotional_valence as number,
      importance: r.importance as number,
      decayRate: r.decay_rate as number,
      createdAt: r.created_at as string,
    }));

    if (!sceneContext || all.length <= limit) return all.slice(0, limit);

    const contextWords = new Set(
      sceneContext.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2),
    );

    const capitalizedNames = new Set(
      sceneContext.match(/\b[A-Z][a-z]{2,}\b/g)?.map(w => w.toLowerCase()) ?? [],
    );

    const maxTurn = Math.max(...all.map(m => m.turnNumber), 1);
    const scored = all.map(m => {
      const words = m.content.toLowerCase().split(/\s+/);
      const contextHits = words.filter(w => contextWords.has(w)).length;
      const nameHits = capitalizedNames.size > 0
        ? words.filter(w => capitalizedNames.has(w)).length
        : 0;
      const recencyScore = m.turnNumber / maxTurn * 0.15;
      const emotionalBonus = Math.abs(m.emotionalValence) > 0.5 ? 0.1 : 0;
      const socialBonus = (m.type === 'social' || m.type === 'discovery') ? 0.05 : 0;
      return { memory: m, score: m.importance + contextHits * 0.15 + nameHits * 0.25 + recencyScore + emotionalBonus + socialBonus };
    });

    scored.sort((a, b) => b.score - a.score);

    const selected: typeof all = [];
    const sceneCounts = new Map<number, number>();
    for (const s of scored) {
      const sc = s.memory.sceneNumber;
      const count = sceneCounts.get(sc) ?? 0;
      if (count >= 3 && selected.length < limit) continue;
      selected.push(s.memory);
      sceneCounts.set(sc, count + 1);
      if (selected.length >= limit) break;
    }
    return selected;
  }

  recallByType(characterId: string, type: MemoryType, limit = 5): CharacterMemory[] {
    const rows = this.db.prepare(
      `SELECT * FROM character_memories WHERE character_id = ? AND type = ? ORDER BY importance DESC, created_at DESC LIMIT ?`,
    ).all(characterId, type, limit) as any[];

    return rows.map(r => ({
      id: r.id,
      characterId: r.character_id,
      campaignId: r.campaign_id,
      sceneNumber: r.scene_number,
      turnNumber: r.turn_number,
      type: r.type,
      content: r.content,
      emotionalValence: r.emotional_valence,
      importance: r.importance,
      decayRate: r.decay_rate,
      createdAt: r.created_at,
    }));
  }

  decayMemories(characterId: string): void {
    this.db.prepare(
      `UPDATE character_memories SET importance = MAX(0.01, importance - decay_rate) WHERE character_id = ? AND importance > 0.01`,
    ).run(characterId);
  }

  formatForPrompt(memories: CharacterMemory[]): string {
    if (memories.length === 0) return '';

    const lines = memories.map(m => {
      const mood = m.emotionalValence > 0.3 ? '(positive)' : m.emotionalValence < -0.3 ? '(painful)' : '';
      return `- ${m.content} ${mood}`.trim();
    });

    return `\nYour memories:\n${lines.join('\n')}`;
  }
}
