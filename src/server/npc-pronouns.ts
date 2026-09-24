import { npcPronounInNarration } from './whisper-suggestions.js';

/**
 * An NPC's pronouns, fixed once and handed to the DM every turn. Live
 * (Z9JKG2): the seed called Clerk Marni and Odo the Owl "their"; by
 * mid-game Marni was "her saucer eyes" and Odo "his shelf… he lands". Every
 * narrate call started from nothing, so each one picked again.
 *
 * Deterministic only: the pronouns are read from the seed (a stated field,
 * else its description) or from the first narration that shows them, and
 * stored. Nothing here rewrites prose — the LLM pronoun rewrite was removed
 * in round 9 for misgendering more than it fixed.
 */

export type PronounWord = 'he' | 'she' | 'it' | 'they';

const FULL: Record<PronounWord, string> = { he: 'he/him', she: 'she/her', it: 'it/its', they: 'they/them' };

export function pronounsFromWord(w: PronounWord): string {
  return FULL[w];
}

/**
 * The pronouns a seed description uses for the NPC it describes ("…magnify
 * their eyes… They wear a uniform…" → they/them). The whole description is
 * about them. Null when it uses none, or two equally.
 */
export function pronounsInDescription(description: string | null | undefined): string | null {
  if (!description?.trim()) return null;
  const words = description.toLowerCase().replace(/"[^"]*"|“[^”]*”/g, ' ').match(/[a-z']+/g) ?? [];
  const counts: Record<PronounWord, number> = { he: 0, she: 0, it: 0, they: 0 };
  for (const w of words) {
    if (['he', 'him', 'his', 'himself'].includes(w)) counts.he++;
    else if (['she', 'her', 'hers', 'herself'].includes(w)) counts.she++;
    else if (['its', 'itself'].includes(w)) counts.it++;
    else if (['they', 'them', 'their', 'theirs', 'themself', 'themselves'].includes(w)) counts.they++;
  }
  const ranked = (Object.entries(counts) as Array<[PronounWord, number]>).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[1]![1] === ranked[0]![1]) return null;
  return FULL[ranked[0]![0]];
}

/**
 * The pronouns a stretch of narration uses for `name`, read only from
 * sentences that name them and no one else in `otherNames` (a party member
 * or another NPC — "Odo lands beside Liz and she smiles" is not evidence
 * about Odo). Null when it never says, or says two things.
 */
export function pronounsInNarration(name: string, text: string, otherNames: string[] = []): string | null {
  const w = npcPronounInNarration(name, text, otherNames);
  return w ? FULL[w] : null;
}

/** The DM's standing instruction: each NPC's pronouns, to be used every time. '' when none are set. */
export function npcPronounBlock(list: Array<{ name: string; pronouns: string }>): string {
  if (list.length === 0) return '';
  return `NPC pronouns — fixed; use exactly these for each NPC every time, in narration and in anyone's speech (never switch an NPC's pronouns mid-game): ${list.map(n => `${n.name}: ${n.pronouns}`).join('; ')}.`;
}
