import { callLlm } from './llm-client.js';
import { FactExtractionSchema } from './schemas.js';
import type { FactExtraction } from './schemas.js';
import type { TranscriptMessage } from '../../shared/types.js';

export class ExtractorAgent {
  async extractFacts(transcript: TranscriptMessage[], sceneNumber: number): Promise<FactExtraction> {
    const narrative = transcript
      .filter(m => m.role === 'dm' || m.role === 'character' || m.role === 'whisper')
      .slice(-20);
    const text = narrative.map(m => `[${m.role}] ${m.content}`).join('\n');

    return callLlm({
      messages: [
        { role: 'system', content: 'You are a JSON API that extracts world facts from TTRPG transcripts. Output ONLY a JSON object. No roleplay, no asterisks, no prose. Keep ALL descriptions under 15 words. Be terse.' },
        { role: 'user', content: `Scene ${sceneNumber} transcript:\n${text}\n\nExtract new world facts. For events: set outcome to null if unresolved (mystery discovered, threat introduced, clue found but not followed up). Set outcome to a string only when the event reached a conclusion.\n\nExample:\n{"newLocations":[{"name":"The Well","description":"Ancient well with sigils","terrain":"village"}],"newEntities":[{"name":"Elder Mirra","type":"npc","description":"Village elder","disposition":"fearful"}],"newItems":[{"name":"Obsidian Shard","description":"Dark pulsing shard"}],"newEvents":[{"sceneNumber":${sceneNumber},"description":"Dark sigils appeared on the well","participants":["Kael"],"outcome":null},{"sceneNumber":${sceneNumber},"description":"Kael pressed the elder","participants":["Kael","Mirra"],"outcome":"Elder revealed children vanished"}],"newRelationships":[]}` },
      ],
      schema: FactExtractionSchema,
      temperature: 0.3,
      maxTokens: 2048,
    });
  }
}
