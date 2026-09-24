/**
 * The forms of a character's stated pronouns, for text the server writes
 * about them (the whisper panel's lines, status text). Sheets store pronouns
 * as a free string: "she/her", "He / Him", "they", "she/they", "xe/xem".
 *
 * Only sets whose every form we know are read — she, he, they, it. Anything
 * else (neopronouns, "any", nothing stated) is null, and callers use the
 * character's name instead: a name is always right, a guessed form is not.
 * The first listed set wins ("she/they" → she), as people usually list the
 * one they prefer first.
 */
export interface PronounSet {
  /** Lowercase: she / he / they / it. */
  subject: string;
  /** her / him / them / it */
  object: string;
  /** her / his / their / its (determiner: "her own judgment") */
  possessive: string;
  /** true for they: "they listen", not "they listens". */
  plural: boolean;
}

const KNOWN: Record<string, PronounSet> = {
  she: { subject: 'she', object: 'her', possessive: 'her', plural: false },
  he: { subject: 'he', object: 'him', possessive: 'his', plural: false },
  they: { subject: 'they', object: 'them', possessive: 'their', plural: true },
  it: { subject: 'it', object: 'it', possessive: 'its', plural: false },
};

export function pronounSet(pronouns: string | null | undefined): PronounSet | null {
  const first = pronouns?.trim().toLowerCase().split(/[\/,\s]+/).filter(Boolean)[0];
  if (!first) return null;
  const set = KNOWN[first];
  return set ? { ...set } : null;
}

/**
 * How to refer to a character in a sentence: their pronouns when known,
 * else their name in every slot (possessive "Biz's"). `plural` is for verb
 * agreement — false for a name.
 */
export function referTo(name: string, pronouns: string | null | undefined): PronounSet {
  return pronounSet(pronouns) ?? { subject: name, object: name, possessive: `${name}'s`, plural: false };
}

/** "she" → "She"; a name is returned as written. */
export function capitalize(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1) : word;
}

/**
 * Verb agreement for `r`'s subject: "she collapses" / "they collapse" /
 * "Ash collapses". Irregulars are passed in: agree(r, 'is', 'are').
 */
export function agree(r: PronounSet, singular: string, plural: string): string {
  return r.plural ? plural : singular;
}

const IRREGULAR_PLURAL: Record<string, string> = {
  is: 'are', was: 'were', has: 'have', does: 'do', goes: 'go',
  "isn't": "aren't", "wasn't": "weren't", "hasn't": "haven't", "doesn't": "don't",
  "isn’t": "aren’t", "wasn’t": "weren’t", "hasn’t": "haven’t", "doesn’t": "don’t",
};

/**
 * The plural (they-form) of a present-tense verb written for he/she:
 * "declares" → "declare", "watches" → "watch", "carries" → "carry",
 * "is" → "are". A word that is not a third-person-singular verb form
 * ("declared", "can", "must") is returned as written. For use with agree():
 * agree(r, verb, pluralVerb(verb)).
 */
export function pluralVerb(verb: string): string {
  const lower = verb.toLowerCase();
  const irregular = IRREGULAR_PLURAL[lower];
  let out: string;
  if (irregular) out = irregular;
  else if (/[^aeiou]ies$/.test(lower) && lower.length > 4) out = lower.slice(0, -3) + 'y';
  else if (/(?:ss|sh|ch|x|z|o)es$/.test(lower)) out = lower.slice(0, -2);
  else if (/[^su]s$/.test(lower) && lower.length > 2) out = lower.slice(0, -1);
  else return verb;
  return /^[A-Z]/.test(verb) ? capitalize(out) : out;
}
