import { callLlm } from './llm-client.js';
import { FactExtractionSchema } from './schemas.js';
import type { FactExtraction } from './schemas.js';
import type { TranscriptMessage } from '../../shared/types.js';

/**
 * Items: who holds a thing, and people are never things. Live (NUMMRL): "The
 * Smudged Compass" had no holder though Madame Quill held it up, and "Squeaky
 * Stool" — an NPC who talks — was filed as an item.
 */
export const EXTRACTOR_ITEM_RULE = 'For items: when the transcript shows an NPC holding, wearing or carrying a thing, add "heldBy": "<the NPC\'s exact name>" to it; otherwise leave heldBy out, and never put a player character there. A person, creature or NPC — even one that is an object, like a talking stool or a singing door — is an entity, never an item.';

export class ExtractorAgent {
  async extractFacts(transcript: TranscriptMessage[], sceneNumber: number): Promise<FactExtraction> {
    // Whispers are deliberately excluded: a whisper is private to one
    // character, and anything extracted here becomes world knowledge every
    // character's prompt draws on (and is marked known to the party).
    const narrative = transcript
      .filter(m => m.role === 'dm' || m.role === 'character')
      .slice(-30);
    const text = narrative.map(m => `[${m.role}] ${m.content}`).join('\n');

    return callLlm({
      messages: [
        { role: 'system', content: 'You are a JSON API that extracts world facts from TTRPG transcripts. Output ONLY a JSON object. No roleplay, no asterisks, no prose. Keep ALL descriptions under 10 words. Max 4 locations, 5 entities, 4 items, 6 events, 6 relationships per extraction.' },
        { role: 'user', content: `<transcript scene="${sceneNumber}">\n${text}\n</transcript>\n\n<task>\nExtract new world facts. For events: set outcome to null if unresolved (mystery discovered, threat introduced, clue found but not followed up). Set outcome to a string only when the event reached a conclusion. For relationships: extract EVERY meaningful connection between named characters/NPCs — alliances formed, trust broken, debts owed, secrets shared, grudges held, cooperation during combat, arguments, romantic interest, or protective bonds. Use exact character names as entityAName/entityBName (e.g. "Ambassador Elara Thorne" not "the diplomat"). Relationship types: "alliance", "distrust", "rivalry", "debt", "protects", "suspects", "cooperates-with", "fears", "admires", "manipulates", "betrayed-by". ${EXTRACTOR_ITEM_RULE}\n\nExample:\n{"newLocations":[{"name":"The Well","description":"Ancient well with sigils","terrain":"village"}],"newEntities":[{"name":"Elder Mirra","type":"npc","description":"Village elder","disposition":"fearful"}],"newItems":[{"name":"Obsidian Shard","description":"Dark pulsing shard","heldBy":"Elder Mirra"}],"newEvents":[{"sceneNumber":${sceneNumber},"description":"Dark sigils appeared on the well","participants":["Kael"],"outcome":null},{"sceneNumber":${sceneNumber},"description":"Kael pressed the elder","participants":["Kael","Mirra"],"outcome":"Elder revealed children vanished"}],"newRelationships":[{"entityAName":"Kael","entityBName":"Elder Mirra","type":"distrust","description":"Kael suspects the elder hides the truth"},{"entityAName":"Kael","entityBName":"Lyra","type":"protects","description":"Kael shielded Lyra from the blast"}]}\n</task>` },
      ],
      schema: FactExtractionSchema,
      temperature: 0.3,
      maxTokens: 2048,
    });
  }
}
