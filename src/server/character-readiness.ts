import type { CharacterReadiness, CharacterReadinessItem } from '../shared/types.js';

export const MIN_ASPECTS = 2;
export const MIN_SKILLS = 1;
export const MIN_STUNTS = 1;

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function countNonEmptyStrings(v: unknown): number {
  if (!Array.isArray(v)) return 0;
  return v.filter(isNonEmptyString).length;
}

function countNumericSkills(v: unknown): number {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 0;
  return Object.entries(v as Record<string, unknown>)
    .filter(([name, rating]) => isNonEmptyString(name) && typeof rating === 'number' && Number.isFinite(rating))
    .length;
}

/**
 * The single definition of "this character sheet is finished".
 *
 * Takes `unknown` on purpose: the definition arrives from a model, so its
 * shape is as untrusted as its content. Nothing here may throw, and every
 * failure direction resolves to "not ready" — a sheet wrongly called finished
 * puts a hollow character at the table, which is the failure that matters.
 */
export function checkCharacterReadiness(def: unknown): CharacterReadiness {
  const unmet: CharacterReadinessItem[] = [];
  const detail: string[] = [];
  const d = (def && typeof def === 'object' && !Array.isArray(def)) ? def as Record<string, unknown> : {};

  if (!isNonEmptyString(d.name)) {
    unmet.push('name');
    detail.push('They still need a name.');
  }
  if (!isNonEmptyString(d.highConcept)) {
    unmet.push('highConcept');
    detail.push('What is this character, in a phrase? A high concept.');
  }
  if (!isNonEmptyString(d.trouble)) {
    unmet.push('trouble');
    detail.push('What complicates their life? A trouble that creates real dilemmas.');
  }
  if (countNonEmptyStrings(d.aspects) < MIN_ASPECTS) {
    unmet.push('aspects');
    detail.push(`They need at least ${MIN_ASPECTS} aspects — things that are true about them and can be leaned on.`);
  }
  if (countNumericSkills(d.skills) < MIN_SKILLS) {
    unmet.push('skills');
    detail.push(`They need at least ${MIN_SKILLS} skill with a rating.`);
  }
  if (countNonEmptyStrings(d.stunts) < MIN_STUNTS) {
    unmet.push('stunts');
    detail.push(`They need at least ${MIN_STUNTS} stunt — something they can do that others cannot.`);
  }

  return { ready: unmet.length === 0, unmet, detail };
}
