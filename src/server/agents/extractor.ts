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
        { role: 'system', content: 'You are a JSON API that extracts world facts from TTRPG transcripts. Output ONLY a JSON object. No roleplay, no asterisks, no prose.' },
        { role: 'user', content: `Scene ${sceneNumber} transcript:\n${text}\n\nExtract new world facts. Example output:\n{"newLocations":[{"name":"The Cursed Well","description":"Ancient stone well with dark sigils","terrain":"village"}],"newEntities":[{"name":"Elder Mirra","type":"npc","description":"Village elder who knows about the curse","disposition":"fearful"}],"newItems":[],"newEvents":[{"sceneNumber":${sceneNumber},"description":"Kael discovered dark sigils on the well","participants":["Kael"],"outcome":"The sigils pulsed with dark energy"}],"newRelationships":[]}` },
      ],
      schema: FactExtractionSchema,
      temperature: 0.3,
      maxTokens: 2048,
    });
  }
}
