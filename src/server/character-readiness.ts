import type { CharacterReadiness, CharacterReadinessItem } from '../shared/types.js';
import { agree, capitalize, pronounSet, referTo } from '../shared/pronouns.js';

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
    // Above +0: a +0 (Mediocre) skill is the default every skill has, not a
    // rating — live (7RAAQ7) Biz's sheet came back Notice 0, Stealth 0,
    // Athletics 0, Rapport 0, was called finished, and the checklist hid.
    .filter(([name, rating]) => isNonEmptyString(name) && typeof rating === 'number' && Number.isFinite(rating) && rating > 0)
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

  // In the character's own pronouns once they are stated — live, the hint
  // read "They need at least 1 stunt" while building she/her Liz — else
  // their name, else "they" (nobody has said yet).
  const name = isNonEmptyString(d.name) ? d.name.trim().split(/\s+/)[0]! : '';
  const set = pronounSet(isNonEmptyString(d.pronouns) ? d.pronouns : null);
  const r = set ?? (name ? referTo(name, null) : pronounSet('they')!);
  const Subj = capitalize(r.subject);
  const needs = agree(r, 'needs', 'need');

  if (!isNonEmptyString(d.name)) {
    unmet.push('name');
    detail.push(`${set ? Subj : 'They'} still ${set ? agree(set, 'needs', 'need') : 'need'} a name.`);
  }
  if (!isNonEmptyString(d.highConcept)) {
    unmet.push('highConcept');
    detail.push('What is this character, in a phrase? A high concept.');
  }
  if (!isNonEmptyString(d.trouble)) {
    unmet.push('trouble');
    detail.push(`What complicates ${r.possessive} life? A trouble that creates real dilemmas.`);
  }
  if (countNonEmptyStrings(d.aspects) < MIN_ASPECTS) {
    unmet.push('aspects');
    detail.push(`${Subj} ${needs} at least ${MIN_ASPECTS} aspects — things that are true about ${r.object} and can be leaned on.`);
  }
  if (countNumericSkills(d.skills) < MIN_SKILLS) {
    unmet.push('skills');
    detail.push(`${Subj} ${needs} at least ${MIN_SKILLS} skill rated above +0.`);
  }
  if (countNonEmptyStrings(d.stunts) < MIN_STUNTS) {
    unmet.push('stunts');
    detail.push(`${Subj} ${needs} at least ${MIN_STUNTS} stunt — something ${r.subject} can do that others cannot.`);
  }

  return { ready: unmet.length === 0, unmet, detail };
}

/** A gendered pronoun: fine once the player has said how the character is referred to, a guess before that. */
const GENDERED = /\b(?:he|him|his|himself|she|her|hers|herself)\b/i;

/** Every piece of the sheet that describes the character in prose. */
function describingText(d: Record<string, unknown>): string[] {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter(isNonEmptyString) : []);
  return [d.highConcept, d.trouble, d.personality, d.backstory, ...list(d.aspects), ...list(d.stunts)].filter(isNonEmptyString);
}

/**
 * "Finished" for a sheet built in the character interview: everything
 * checkCharacterReadiness asks for, plus how the character is referred to.
 * The interview ASKS each player for pronouns; until they are stated the
 * sheet must not gender the character either — "Fast on his feet" for a
 * character nobody has called "he" is a guess, and it is refused here
 * (reported as unmet "pronouns") rather than repaired, so the interviewer
 * asks and rewrites it. Other ways of submitting a sheet (the form, pasted
 * markdown) keep checkCharacterReadiness alone.
 */
export function checkInterviewReadiness(def: unknown): CharacterReadiness {
  const base = checkCharacterReadiness(def);
  const d = (def && typeof def === 'object' && !Array.isArray(def)) ? def as Record<string, unknown> : {};
  if (isNonEmptyString(d.pronouns)) return base;
  const guessed = describingText(d).some(t => GENDERED.test(t));
  const unmet: CharacterReadinessItem[] = [...base.unmet, 'pronouns'];
  const detail = [...base.detail, guessed
    ? 'The sheet calls them he or she, but nobody has said how they are referred to yet — ask, and until then use their name.'
    : 'How should people refer to them — she/her, he/him, they/them, or something else?'];
  return { ready: false, unmet, detail };
}
