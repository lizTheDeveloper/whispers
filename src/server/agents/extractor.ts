import { callLlm } from './llm-client.js';
import { FactExtractionSchema } from './schemas.js';
import type { FactExtraction } from './schemas.js';
import type { TranscriptMessage } from '../../shared/types.js';

export class ExtractorAgent {
  async extractFacts(transcript: TranscriptMessage[], sceneNumber: number): Promise<FactExtraction> {
    const narrative = transcript
      .filter(m => m.role === 'dm' || m.role === 'character' || m.role === 'whisper')
      .slice(-30);
    const text = narrative.map(m => `[${m.role}] ${m.content}`).join('\n');

    return callLlm({
      messages: [
        { role: 'system', content: 'You are a JSON API that extracts world facts from TTRPG transcripts. Output ONLY a JSON object. No roleplay, no asterisks, no prose. Keep ALL descriptions under 10 words. Max 4 locations, 5 entities, 4 items, 6 events, 6 relationships per extraction.' },
        { role: 'user', content: `<transcript scene="${sceneNumber}">\n${text}\n</transcript>\n\n<task>\nExtract new world facts. For events: set outcome to null if unresolved (mystery discovered, threat introduced, clue found but not followed up). Set outcome to a string only when the event reached a conclusion. For relationships: extract EVERY meaningful connection between named characters/NPCs — alliances formed, trust broken, debts owed, secrets shared, grudges held, cooperation during combat, arguments, romantic interest, or protective bonds. Use exact character names as entityAName/entityBName (e.g. "Ambassador Elara Thorne" not "the diplomat"). Relationship types: "alliance", "distrust", "rivalry", "debt", "protects", "suspects", "cooperates-with", "fears", "admires", "manipulates", "betrayed-by".\n\nExample:\n{"newLocations":[{"name":"The Well","description":"Ancient well with sigils","terrain":"village"}],"newEntities":[{"name":"Elder Mirra","type":"npc","description":"Village elder","disposition":"fearful"}],"newItems":[{"name":"Obsidian Shard","description":"Dark pulsing shard"}],"newEvents":[{"sceneNumber":${sceneNumber},"description":"Dark sigils appeared on the well","participants":["Kael"],"outcome":null},{"sceneNumber":${sceneNumber},"description":"Kael pressed the elder","participants":["Kael","Mirra"],"outcome":"Elder revealed children vanished"}],"newRelationships":[{"entityAName":"Kael","entityBName":"Elder Mirra","type":"distrust","description":"Kael suspects the elder hides the truth"},{"entityAName":"Kael","entityBName":"Lyra","type":"protects","description":"Kael shielded Lyra from the blast"}]}\n</task>` },
      ],
      schema: FactExtractionSchema,
      temperature: 0.3,
      maxTokens: 2048,
    });
  }
}
