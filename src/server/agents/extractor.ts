import { callLlm } from './llm-client.js';
import { FactExtractionSchema } from './schemas.js';
import type { FactExtraction } from './schemas.js';
import type { TranscriptMessage } from '../../shared/types.js';

export class ExtractorAgent {
  async extractFacts(transcript: TranscriptMessage[], sceneNumber: number): Promise<FactExtraction> {
    const text = transcript.map(m => `[${m.role}] ${m.content}`).join('\n');

    return callLlm({
      messages: [
        { role: 'system', content: 'You extract world facts from a TTRPG scene transcript. Identify NEW locations, NPCs, creatures, organizations, items, events, and relationships that were established in this scene. Only include facts that are clearly stated or strongly implied — do not invent. If a character is just "the shopkeeper" with no name, use "the shopkeeper" as the name. Respond with valid JSON.' },
        { role: 'user', content: `Scene ${sceneNumber} transcript:\n${text}\n\nExtract all new world facts as JSON: { "newLocations": [...], "newEntities": [...], "newItems": [...], "newEvents": [...], "newRelationships": [...] }` },
      ],
      schema: FactExtractionSchema,
      temperature: 0.3,
    });
  }
}
