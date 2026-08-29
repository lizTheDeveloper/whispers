import { z } from 'zod';

export const DmNarrationSchema = z.object({
  narration: z.string().min(1),
  currentLocationName: z.string(),
  activeNpcs: z.array(z.string()),
  isSceneEnd: z.boolean(),
});
export type DmNarration = z.infer<typeof DmNarrationSchema>;

export const DmResolutionSchema = z.object({
  diceExpression: z.string().nullable().default(null),
  difficulty: z.number().nullable().default(null),
  skill: z.string().nullable().default(null),
  outcome: z.enum(['success', 'failure', 'tie', 'success-with-cost']).default('success'),
  narration: z.string().min(1),
  stateChanges: z.array(z.object({
    characterId: z.string().optional(),
    field: z.enum(['stress', 'consequences', 'fatePoints', 'inventory']).optional(),
    action: z.enum(['set', 'add', 'remove']).optional(),
    value: z.unknown().optional(),
  }).passthrough()).default([]),
});
export type DmResolution = z.infer<typeof DmResolutionSchema>;

export const DmQuestionSchema = z.object({
  hasQuestion: z.boolean(),
  question: z.string().nullable(),
});
export type DmQuestion = z.infer<typeof DmQuestionSchema>;

export const ActionProposalSchema = z.object({
  actions: z.array(z.object({
    description: z.string(),
    reasoning: z.string(),
  })).min(2).max(4),
});
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

export const ActionDecisionSchema = z.object({
  chosenAction: z.string(),
  innerThought: z.string().min(1),
  whisperedInfluence: z.enum(['followed', 'partially-followed', 'ignored']),
  trustDelta: z.number().min(-0.15).max(0.15),
});
export type ActionDecision = z.infer<typeof ActionDecisionSchema>;

export const FactExtractionSchema = z.object({
  newLocations: z.array(z.object({ name: z.string(), description: z.string().nullable(), terrain: z.string().nullable() })),
  newEntities: z.array(z.object({ name: z.string(), type: z.enum(['npc', 'creature', 'organization']), description: z.string().nullable(), disposition: z.string().nullable() })),
  newItems: z.array(z.object({ name: z.string(), description: z.string().nullable() })),
  newEvents: z.array(z.object({ sceneNumber: z.number(), description: z.string(), participants: z.array(z.string()), outcome: z.string().nullable() })),
  newRelationships: z.array(z.object({ entityAName: z.string(), entityBName: z.string(), type: z.string(), description: z.string().nullable() })),
});
export type FactExtraction = z.infer<typeof FactExtractionSchema>;

export const CharacterValidationSchema = z.object({
  approved: z.boolean(),
  feedback: z.string().default('Character reviewed.'),
  modifications: z.record(z.unknown()).nullable().default(null),
});
export type CharacterValidation = z.infer<typeof CharacterValidationSchema>;

export const DmSetupReplySchema = z.object({
  reply: z.string().min(1),
  done: z.boolean(),
  dmInstructions: z.string().nullable(),
  dmCustomPrompt: z.string().nullable(),
});
export type DmSetupReply = z.infer<typeof DmSetupReplySchema>;

export const CharInterviewReplySchema = z.object({
  reply: z.string().min(1),
  definition: z.object({
    name: z.string(),
    highConcept: z.string(),
    trouble: z.string(),
    aspects: z.array(z.string()),
    personality: z.string(),
    backstory: z.string(),
    skills: z.record(z.number()),
    stunts: z.array(z.string()),
  }).nullable(),
});
export type CharInterviewReply = z.infer<typeof CharInterviewReplySchema>;

export const SceneSummarySchema = z.object({
  summary: z.string().min(1),
});
export type SceneSummary = z.infer<typeof SceneSummarySchema>;
