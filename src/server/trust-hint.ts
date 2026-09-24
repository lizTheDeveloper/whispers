import { capitalize, pronounSet, referTo } from '../shared/pronouns.js';

/**
 * The whisper panel's trust line, spoken about the character in their own
 * pronouns (or by name when none are stated). It used to be a fixed "They
 * listen, but weigh your words against their own judgment." for everyone —
 * wrong for Liz, whose sheet says she/her. Owner-only, like all of the panel.
 */
export function trustHint(trust: number, name: string, pronouns: string | null | undefined): string {
  const r = referTo(name, pronouns);
  const S = capitalize(r.subject);
  // Verb agreement: "She listens" / "They listen" / "Biz listens".
  const v = (singular: string, plural: string) => (r.plural ? plural : singular);
  if (trust >= 0.75) return `${S} ${v('trusts', 'trust')} your voice deeply — your words carry weight.`;
  if (trust >= 0.55) return `${S} ${v('listens', 'listen')}, but ${v('weighs', 'weigh')} your words against ${r.possessive} own judgment.`;
  if (trust >= 0.35) {
    const be = pronounSet(pronouns) ? `${S}${r.plural ? "'re" : "'s"}` : `${S} is`;
    return `${be} uncertain about you — choose your words carefully.`;
  }
  return `${S} barely ${v('hears', 'hear')} you. Only the most compelling whisper might reach ${r.object}.`;
}
