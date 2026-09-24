import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { callLlm } from './agents/llm-client.js';
import { z } from 'zod';
import { quoteRuns } from './narrative-guards.js';

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Words after which a person is the object: "to Mom", "hugged Mom". */
const OBJECT_BEFORE = /\b(?:to|at|with|from|for|beside|behind|toward|towards|near|by|of|past|around|onto|into|against|hug|hugs|hugged|hugging|grab|grabs|grabbed|pull|pulls|pulled|tell|tells|told|ask|asks|asked|show|shows|showed|call|calls|called|follow|follows|followed|watch|watches|watched|help|helps|helped|squeeze|squeezes|squeezed|nudge|nudges|nudged|tug|tugs|tugged)\s+$/i;

/**
 * An observer's memory of a companion, in the observer's own words. The
 * observation is written from the actor's action, which calls the observer
 * what the actor calls them — live (Z9JKG2), Liz's own memory read "I
 * watched Biz squeeze Mom's hand" (Liz is Mom). In the observer's memory
 * "Mom's" / "Liz's" is "my", "Mom" after a verb or preposition is "me",
 * and any other "Mom" is the observer's name. Quoted speech is the actor's
 * and is left alone.
 */
export function observerOwnWords(content: string, observerName: string, aliases: string[]): string {
  if (!content) return content;
  const first = observerName.trim().split(/\s+/)[0] ?? observerName;
  const names = [...new Set([first, ...aliases].map(n => n.trim()).filter(Boolean))];
  if (names.length === 0) return content;
  const alt = names.map(escRe).join('|');
  const possessive = new RegExp(`(?<![\\w'’-])(?:${alt})['’]s\\b`, 'g');
  const bare = new RegExp(`(?<![\\w'’-])(${aliases.map(a => escRe(a.trim())).filter(Boolean).join('|') || '(?!)'})(?![\\w'’-])`, 'g');
  const out = quoteRuns(content).map(r => {
    if (r.quoted) return r.text;
    let t = r.text.replace(possessive, (m, offset: number, whole: string) => (/(?:^|[.!?]\s+)$/.test(whole.slice(0, offset)) ? 'My' : 'my'));
    t = t.replace(bare, (m, _a: string, offset: number, whole: string) => (OBJECT_BEFORE.test(whole.slice(0, offset)) ? 'me' : first));
    return t;
  }).join('');
  if (out !== content) console.log(`[memory] ${first}'s own memory in ${first}'s words: "${out.slice(0, 80)}"`);
  return out;
}

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

/**
 * What a memory is written with, beyond the event itself. Live (7MJXE5)
 * memories said "Barnaby… his tiny briefcase" (Barnaby is it/its), "Tick-Tock's
 * … his voice cracking" (it/its) and "to protect him" of Biz (they/them): the
 * memory prompts carried nobody's pronouns. Memories come back into every
 * later prompt, so a wrong pronoun there spreads.
 */
export interface MemoryWritingOptions {
  /** Everyone's pronouns — party and NPCs (castPronounLine). */
  pronounNote?: string;
  /** Who is who in the party (partyRolesLine): "Liz is Biz's mother". */
  rolesNote?: string;
  /** The deterministic text guards (NPC pronouns, the family-table softener), applied before a memory is stored. */
  repair?: (text: string) => string;
}

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
    opts: MemoryWritingOptions = {},
  ): Promise<CharacterMemory[]> {
    const whisperCtx = whisper ? `\nA voice whispered: "${whisper}"` : '';
    const pronounNote = (opts.pronounNote ? ` ${opts.pronounNote} Use exactly these pronouns for everyone the memory mentions.` : '') + (opts.rolesNote ? ` ${opts.rolesNote}` : '');

    let memories: Array<{ type: MemoryType; content: string; emotionalValence: number; importance: number }>;
    try {
      const result = await callLlm({
        messages: [
          {
            role: 'system',
            content: `You extract episodic memories for a character named ${characterName}. Memories are first-person, concise (1-2 sentences), and capture what the character would actually remember — not a transcript summary. Focus on emotional impact, consequences, and relationships.${pronounNote} Respond with ONLY a JSON object.`,
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
      if (opts.repair) mem.content = opts.repair(mem.content);
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

  async storeObservation(
    observerId: string,
    campaignId: string,
    observerName: string,
    actorName: string,
    action: string,
    outcome: string,
    sceneNumber: number,
    turnNumber: number,
    /** What the actor calls the observer ("Mom"): in the observer's own memory that is "me"/"my". */
    observerAliases: string[] = [],
    opts: MemoryWritingOptions = {},
  ): Promise<void> {
    let content: string;
    const pronounNote = (opts.pronounNote ? ` ${opts.pronounNote}` : '') + (opts.rolesNote ? ` ${opts.rolesNote}` : '');
    try {
      const text = await callLlm({
        messages: [
          { role: 'system', content: `You are ${observerName}. Write ONE plain sentence about what you just saw ${actorName} do. First person ("I saw/watched/noticed"). Be specific about what it reveals about ${actorName}. Attribute possessions and pockets exactly as narrated: "their pocket" in ${actorName}'s own action is ${actorName}'s own pocket, and a thing goes to someone else only when the outcome says so.${observerAliases.length > 0 ? ` When ${actorName} says ${observerAliases.map(a => `"${a}"`).join(' or ')}, that is you: write "me" and "my" ("my hand", never "${observerAliases[0]}'s hand").` : ''}${pronounNote} Plain text only — no asterisks, no quotes, no JSON.` },
          { role: 'user', content: `${actorName}: "${action}"\nOutcome: "${outcome}"` },
        ],
        temperature: 0.3,
        maxTokens: 100,
      });
      content = text.trim()
        .replace(/^["']|["']$/g, '')
        .replace(/\*[^*]*\*/g, '')
        .trim();
      if (!content || content.length < 10 || content.startsWith('*') || content.startsWith('{')) {
        content = this.fallbackObservation(actorName, action);
      }
    } catch {
      content = this.fallbackObservation(actorName, action);
    }
    content = observerOwnWords(content, observerName, observerAliases);
    if (opts.repair) content = opts.repair(content);

    this.db.prepare(
      `INSERT INTO character_memories (id, character_id, campaign_id, scene_number, turn_number, type, content, emotional_valence, importance, decay_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomBytes(16).toString('hex'), observerId, campaignId, sceneNumber, turnNumber, 'social', content, 0, 0.4, 0.04);
    console.log(`[memory] ${observerName} observed ${actorName}: "${content.slice(0, 60)}"`);
  }

  private fallbackObservation(actorName: string, action: string): string {
    const firstName = actorName.split(' ')[0]!;
    const cleaned = action
      .replace(/^I\s+/i, '')
      .replace(/\bmy\b/gi, `${firstName}'s`)
      .replace(/\bmyself\b/gi, firstName.toLowerCase())
      .replace(/\bI('m|'ll|'ve|'d)?\b/g, firstName)
      .slice(0, 80);
    return `I watched ${actorName} ${cleaned}.`;
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
