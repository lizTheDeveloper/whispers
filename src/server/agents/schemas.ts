import { z } from 'zod';

export const DmNarrationSchema = z.object({
  narration: z.string().min(1),
  currentLocationName: z.string(),
  activeNpcs: z.array(z.union([
    z.string(),
    z.object({ name: z.string() }).passthrough().transform(o => o.name),
  ])),
  isSceneEnd: z.boolean().default(false),
});
export type DmNarration = z.infer<typeof DmNarrationSchema>;

/** The narration-only opening: the arrival, and each character as the others see them. */
export const DmOpeningSchema = z.object({
  /** The moment of arrival, when the premise transports the party. Optional here; the game loop enforces it. */
  arrival: z.string().nullish().transform(v => v ?? ''),
  narration: z.string().default(''),
  currentLocationName: z.string().nullish().transform(v => v ?? ''),
  introductions: z.array(z.object({ name: z.string(), text: z.string() })).catch([]).default([]),
});
export type DmOpening = z.infer<typeof DmOpeningSchema>;

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
  outcome: z.enum(['success', 'failure', 'tie', 'success-with-cost']).default('tie'),
  narration: z.string().min(1).default('__FALLBACK__'),
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
  })).min(1).max(4),
});
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

export const ActionDecisionSchema = z.object({
  chosenAction: z.string(),
  spokenWords: z.string().nullable().optional().default(null),
  innerThought: z.string().min(1).default('I need to act now.'),
  whisperedInfluence: z.enum(['followed', 'partially-followed', 'ignored']).default('ignored'),
  trustDelta: z.number().min(-1).max(1).default(0),
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
  // Deliberately NOT defaulted (unlike DmSetupReplySchema.done): a missing
  // verdict must not be silently converted INTO a verdict — true fabricates
  // an approval nobody gave, false fabricates a rejection nobody issued.
  // Absence here is survivable (checkWorldReadiness already ran before
  // validateCharacter is called, so a thrown Zod error just surfaces as an
  // error and the player resubmits) in a way `done`'s omission was not, so
  // there is no unambiguous safe default to fall back on. Do not "fix" this
  // inconsistency with `done` — it is intentional.
  approved: z.boolean(),
  feedback: z.string().default('Character reviewed.'),
  modifications: z.record(z.unknown()).nullable().default(null),
});
export type CharacterValidation = z.infer<typeof CharacterValidationSchema>;

export const DmSetupReplySchema = z.object({
  reply: z.string().min(1),
  // Models routinely omit `done` entirely rather than sending `done: false` —
  // an omission the prompt never asked for, so re-prompting for it doesn't
  // help (see llm-client's retry-on-Zod-rejection path, which just burns
  // calls on the same omission). Absence is unambiguous here: "not finished"
  // is the safe reading, the setup loop already handles done: false by
  // simply continuing the conversation, and the Task 9 persistence gate
  // (`reply.done && Boolean(reply.dmInstructions)`) stays correct unchanged.
  done: z.boolean().default(false),
  influences: z.array(z.string()).nullable().default(null),
  dmInstructions: z.union([z.string(), z.record(z.unknown()).transform(v => JSON.stringify(v))]).nullable().default(null),
  dmCustomPrompt: z.union([z.string(), z.record(z.unknown()).transform(v => JSON.stringify(v))]).nullable().default(null),
});
export type DmSetupReply = z.infer<typeof DmSetupReplySchema>;

export const CharacterRelationshipSchema = z.object({
  to: z.string().min(1),
  relation: z.string().min(1),
  address: z.string().nullish().transform(v => (v && v.trim() ? v.trim() : undefined)),
});

export const CharInterviewReplySchema = z.object({
  reply: z.string().min(1),
  definition: z.object({
    name: z.string().default(''),
    highConcept: z.string().default(''),
    trouble: z.string().default(''),
    aspects: z.array(z.string()).default([]),
    personality: z.string().default(''),
    backstory: z.string().default(''),
    skills: z.record(z.number()).default({}),
    stunts: z.array(z.string()).default([]),
    // Optional extras: a malformed age or relationship entry is dropped, never
    // allowed to sink an otherwise-good sheet (and a retry) over a nicety.
    age: z.union([z.number(), z.string()]).nullish().catch(undefined)
      .transform(v => (v === null || v === undefined || (typeof v === 'string' && !v.trim()) ? undefined : v)),
    // Only what the player stated; blank or malformed means unspecified.
    pronouns: z.string().nullish().catch(undefined)
      .transform(v => (v && v.trim() ? v.trim() : undefined)),
    relationships: z.array(z.unknown()).catch([]).default([]).transform(items => items.flatMap(item => {
      const r = CharacterRelationshipSchema.safeParse(item);
      return r.success ? [r.data] : [];
    })),
  }).nullable().default(null),
});
export type CharInterviewReply = z.infer<typeof CharInterviewReplySchema>;

export const SceneSummarySchema = z.object({
  summary: z.string().min(1).default('The scene unfolds...'),
});
export type SceneSummary = z.infer<typeof SceneSummarySchema>;

/**
 * A world seed's shape, not its sufficiency. Minimum counts are NOT enforced
 * here — checkWorldReadiness (src/server/world-readiness.ts) owns that
 * separately, so a short draft can still round-trip to the host for editing
 * rather than being rejected outright.
 */
export const WorldSeedSchema = z.object({
  premise: z.string().min(1),
  locations: z.array(z.object({
    name: z.string().min(1),
    description: z.string().default(''),
    terrain: z.string().nullable().default(null),
  })).default([]),
  npcs: z.array(z.object({
    name: z.string().min(1),
    description: z.string().default(''),
    disposition: z.string().nullable().default(null),
    motivation: z.string().nullable().default(null),
  })).default([]),
  plotHooks: z.array(z.string().min(1)).default([]),
  items: z.array(z.object({
    name: z.string().min(1),
    description: z.string().default(''),
  })).default([]),
});
export type WorldSeedParsed = z.infer<typeof WorldSeedSchema>;
