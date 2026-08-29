import { z } from 'zod';

export const DmNarrationSchema = z.object({
  narration: z.string().min(1),
  currentLocationName: z.string(),
  activeNpcs: z.array(z.union([
    z.string(),
    z.object({ name: z.string() }).passthrough().transform(o => o.name),
  ])),
  isSceneEnd: z.boolean(),
});
export type DmNarration = z.infer<typeof DmNarrationSchema>;

const StateChangeItem = z.union([
  z.object({
    characterId: z.string().optional(),
    field: z.enum(['stress', 'consequences', 'fatePoints', 'inventory']).optional(),
    action: z.enum(['set', 'add', 'remove']).optional(),
    value: z.unknown().optional(),
  }).passthrough(),
  z.string(),
]);

export const DmResolutionSchema = z.object({
  diceExpression: z.string().nullable().default(null),
  difficulty: z.number().nullable().default(null),
  skill: z.string().nullable().default(null),
  outcome: z.enum(['success', 'failure', 'tie', 'success-with-cost']).default('success'),
  narration: z.string().min(1).default('The action unfolds...'),
  stateChanges: z.array(StateChangeItem).default([]).transform(items =>
    items.filter((item): item is Exclude<typeof item, string> => typeof item !== 'string')
  ),
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
  innerThought: z.string().min(1).default('Something feels off...'),
  whisperedInfluence: z.enum(['followed', 'partially-followed', 'ignored']).default('ignored'),
  trustDelta: z.number().min(-0.15).max(0.15).default(0),
});
export type ActionDecision = z.infer<typeof ActionDecisionSchema>;

export const FactExtractionSchema = z.object({
  newLocations: z.array(z.object({ name: z.string(), description: z.string().nullable().default(null), terrain: z.string().nullable().default(null) }).passthrough()).default([]),
  newEntities: z.array(z.object({
    name: z.string(),
    type: z.string().transform(t => {
      const valid = ['npc', 'creature', 'organization'] as const;
      return valid.includes(t as any) ? t as typeof valid[number] : 'npc' as const;
    }),
    description: z.string().nullable().default(null),
    disposition: z.string().nullable().default(null),
  }).passthrough()).default([]),
  newItems: z.array(z.object({ name: z.string(), description: z.string().nullable().default(null) }).passthrough()).default([]),
  newEvents: z.array(z.object({ sceneNumber: z.number().default(0), description: z.string(), participants: z.array(z.string()).default([]), outcome: z.string().nullable().default(null) }).passthrough()).default([]),
  newRelationships: z.array(z.object({
    entityAName: z.string().optional(),
    entityBName: z.string().optional(),
    source: z.string().optional(),
    target: z.string().optional(),
    type: z.string(),
    description: z.string().nullable().default(null),
  }).passthrough().transform(r => ({
    entityAName: r.entityAName ?? r.source ?? '',
    entityBName: r.entityBName ?? r.target ?? '',
    type: r.type,
    description: r.description,
  }))).default([]),
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
