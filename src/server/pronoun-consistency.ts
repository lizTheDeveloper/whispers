/**
 * Pronoun consistency for DM-authored prose, checked in code and repaired by
 * a small, focused LLM rewrite.
 *
 * A live table (Liz = she/her, Biz = they/them, both stated in the
 * interview) still got "give way under his finger… tingles on his skin" in a
 * resolution and "a tingling stain on his palm" in the epilogue. The prompts
 * carry every stated pronoun; the model does not always follow them. A
 * rule-based rewrite of he/she was tried once and wrote clumsy, mixed prose
 * ("…clinging to their boots as Biz steps…"), so the repair here is the
 * model's, and the code only decides WHEN to ask and whether to KEEP it:
 *
 *  1. A cheap deterministic pre-filter (findPronounConflicts). The check runs
 *     only when a party member with STATED pronouns is named and a pronoun
 *     or gendered word that conflicts with them sits "near" the name: in the
 *     same sentence, or in the following sentence when that member is the
 *     only party member named and the next sentence names none. A word
 *     another party member named in that sentence could own ("her" beside
 *     Liz) is not a conflict. Members with no stated pronouns are never
 *     checked.
 *  2. When it fires, one LLM call with a tiny prompt: rewrite the passage so
 *     each party member has their stated pronouns, change nothing else.
 *  3. The rewrite is kept only when it is close to the original — length
 *     within ±15% and every party name the original used still present.
 *     Otherwise the original stands: a missed repair is a slip, a rewritten
 *     scene is a bug.
 */
import { callLlm, isLlmAbort } from './agents/llm-client.js';
import { namesInNarration } from './narrative-guards.js';
import type { CharacterDefinition } from '../shared/types.js';

export interface PronounMember {
  name: string;
  /** As the player stated it ("she/her", "they/them", "xe/xem"). Unset = not stated: never checked. */
  pronouns?: string | null;
}

type Key = 'she' | 'he' | 'they' | 'other';

const FORMS: Record<'she' | 'he' | 'they', string[]> = {
  she: ['she', 'her', 'hers', 'herself'],
  he: ['he', 'him', 'his', 'himself'],
  they: ['they', 'them', 'their', 'theirs', 'themself', 'themselves'],
};
/** Nouns that state a gender about the person they describe. Kept tight: "man" and "woman" are too often someone else. */
const WORDS: Record<'she' | 'he', string[]> = {
  she: ['girl', 'daughter', 'lass'],
  he: ['boy', 'son', 'lad'],
};

function keyOf(pronouns: string | null | undefined): Key | null {
  const first = pronouns?.trim().toLowerCase().split(/[\/,\s]+/).filter(Boolean)[0];
  if (!first) return null;
  if (first === 'she' || first === 'her') return 'she';
  if (first === 'he' || first === 'him') return 'he';
  if (first === 'they' || first === 'them') return 'they';
  return 'other';
}

/** Words that misgender someone with these pronouns. "they" is never one: it is also the plural. */
function conflictingWords(key: Key): Set<string> {
  switch (key) {
    case 'she': return new Set([...FORMS.he, ...WORDS.he]);
    case 'he': return new Set([...FORMS.she, ...WORDS.she]);
    default: return new Set([...FORMS.he, ...FORMS.she, ...WORDS.he, ...WORDS.she]);
  }
}

/** Words that could belong to this member. Unstated pronouns could own any of them. */
function couldOwn(member: PronounMember, word: string): boolean {
  const key = keyOf(member.pronouns);
  if (!key) return true;
  return !conflictingWords(key).has(word);
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mentions(sentence: string, member: PronounMember): boolean {
  return new RegExp(`\\b${esc(firstName(member.name))}\\b`).test(sentence);
}

/** Sentences, split after terminal punctuation (and any closing quote) or a line break. */
export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?…]["”’']?)\s+|\n+/).map(s => s.trim()).filter(Boolean);
}

/**
 * The words of a sentence, minus pronoun sets written as options ("she/her",
 * "he/him/his", "they / them"): asking which pronouns to use is not using one.
 */
function wordsIn(sentence: string): string[] {
  const withoutOptions = sentence.toLowerCase().replace(/\b[a-z]+(?:\s*\/\s*[a-z]+)+\b/g, ' ');
  return (withoutOptions.match(/[a-z]+/g) ?? []);
}

export interface PronounConflict {
  name: string;
  pronouns: string;
  word: string;
  sentence: string;
}

/**
 * Every place a party member with stated pronouns is called by a word that
 * contradicts them. Empty when there is nothing to fix — the common case,
 * which costs no LLM call.
 */
export function findPronounConflicts(text: string, members: PronounMember[]): PronounConflict[] {
  if (!text) return [];
  const sentences = splitSentences(text);
  const out: PronounConflict[] = [];
  const seen = new Set<string>();
  const add = (m: PronounMember, word: string, sentence: string) => {
    const k = `${m.name}|${word}|${sentence}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ name: m.name, pronouns: m.pronouns!.trim(), word, sentence });
  };
  sentences.forEach((sentence, i) => {
    const named = members.filter(m => mentions(sentence, m));
    for (const m of named) {
      const key = keyOf(m.pronouns);
      if (!key) continue;
      const bad = conflictingWords(key);
      for (const w of wordsIn(sentence)) {
        if (!bad.has(w)) continue;
        // "Liz takes Biz's hand in her own": the word is Liz's to own.
        if (named.some(o => o !== m && couldOwn(o, w))) continue;
        add(m, w, sentence);
      }
      // "Biz presses the rune. It gives way under his finger." — the next
      // sentence, when Biz is the only one named here and nobody is named there.
      const next = sentences[i + 1];
      if (named.length === 1 && next && !members.some(o => mentions(next, o))) {
        for (const w of wordsIn(next)) if (bad.has(w)) add(m, w, next);
      }
    }
  });
  return out;
}

/**
 * A rewrite is kept only when it is the same passage: within ±15% of the
 * original's length, and still naming every party member the original named.
 */
export function acceptRewrite(original: string, rewrite: string | null | undefined, names: string[]): boolean {
  const r = rewrite?.trim();
  if (!r) return false;
  const o = original.trim();
  if (Math.abs(r.length - o.length) > o.length * 0.15) return false;
  for (const n of names) {
    const re = new RegExp(`\\b${esc(firstName(n))}\\b`);
    if (re.test(o) && !re.test(r)) return false;
  }
  return true;
}

type Llm = (messages: Array<{ role: string; content: string }>) => Promise<string>;

const defaultLlm: Llm = async (messages) => String(await callLlm({
  messages,
  temperature: 0.2,
  // Short passage out, but the reasoning model spends this budget thinking first.
  maxTokens: 2048,
}));

/** The marker the rewrite prompt starts with (tests key their stubs on it). */
export const PRONOUN_REWRITE_MARKER = 'You correct how people are referred to in a passage';

const REWRITE_RULES = 'Change NOTHING else: keep every other word, sentence, name, line break and punctuation mark as it is, apart from the pronoun and whatever verb agreement it needs ("they are", not "they is"). Pronouns and words for anyone else — NPCs, creatures, objects — stay exactly as written. Reply with the passage only: no preamble, no quotation marks around it, no notes.';

/**
 * Run the rewrite and keep it only if acceptRewrite does. Never throws for a
 * failed or bad rewrite (the original is returned); a cancelled call (pause,
 * End Game) is re-thrown so the loop's pause handling sees it.
 */
async function rewrite(text: string, system: string, user: string, names: string[], llm: Llm, label: string): Promise<string> {
  let out: string;
  try {
    out = await llm([{ role: 'system', content: system }, { role: 'user', content: user }]);
  } catch (e) {
    if (isLlmAbort(e)) throw e;
    console.error(`[pronouns] ${label} rewrite failed; keeping the original:`, e);
    return text;
  }
  const cleaned = out.trim();
  if (!acceptRewrite(text, cleaned, names)) {
    console.warn(`[pronouns] ${label} rewrite rejected (changed too much); keeping the original`);
    return text;
  }
  if (cleaned !== text.trim()) console.log(`[pronouns] ${label}: "${text.slice(0, 80)}" → "${cleaned.slice(0, 80)}"`);
  return cleaned;
}

/**
 * DM prose with every party member referred to by their stated pronouns.
 * No LLM call unless findPronounConflicts finds something.
 */
export async function withConsistentPronouns(text: string, members: PronounMember[], opts: { llm?: Llm } = {}): Promise<string> {
  const conflicts = findPronounConflicts(text, members);
  if (conflicts.length === 0) return text;
  const stated = members.filter(m => keyOf(m.pronouns));
  const list = stated.map(m => `- ${m.name}: ${m.pronouns!.trim()}`).join('\n');
  const system = `${PRONOUN_REWRITE_MARKER}. Rewrite this passage so that each party member listed is referred to with their stated pronouns. ${REWRITE_RULES}`;
  const user = `Party members and their stated pronouns:\n${list}\n\nPassage:\n${text}`;
  console.log(`[pronouns] ${conflicts.map(c => `"${c.word}" near ${c.name} (${c.pronouns})`).join('; ')} — asking for a rewrite`);
  return rewrite(text, system, user, members.map(m => m.name), opts.llm ?? defaultLlm, 'narration');
}

const GENDERED = new Set([...FORMS.he, ...FORMS.she]);

/**
 * An interview reply about a character whose pronouns nobody has stated yet
 * uses their name or "they" — never he or she. The pre-filter: a gendered
 * pronoun in a sentence that names no one else at the table (a sentence
 * about Liz, whose player said she/her, may call her "her").
 */
export function interviewGendersCharacter(reply: string, otherNames: string[]): boolean {
  return splitSentences(reply).some(s => {
    if (otherNames.some(n => n.trim() && new RegExp(`\\b${esc(firstName(n))}\\b`).test(s))) return false;
    return wordsIn(s).some(w => GENDERED.has(w));
  });
}

/**
 * The interview reply with the character being made referred to by name or
 * "they" until their pronouns are stated. No LLM call unless a gendered
 * pronoun appears in a sentence that could only be about them.
 */
export async function interviewReplyWithoutGuessedGender(reply: string, character: { name?: string | null; otherNames: string[] }, opts: { llm?: Llm } = {}): Promise<string> {
  if (!reply || !interviewGendersCharacter(reply, character.otherNames)) return reply;
  const who = character.name?.trim() ? `the character being created, ${character.name.trim()}` : 'the character being created (the player\'s character)';
  const system = `${PRONOUN_REWRITE_MARKER}. Nobody has said yet how ${who} should be referred to. Rewrite this passage so that every word referring to that character uses their name or they/them/their — never he, him, his, she or her. ${REWRITE_RULES}`;
  const user = `Passage:\n${reply}`;
  const names = [...(character.name?.trim() ? [character.name.trim()] : []), ...character.otherNames];
  return rewrite(reply, system, user, names, opts.llm ?? defaultLlm, 'interview');
}

/**
 * The character interviewer's reply as the player sees it. It is the DM
 * talking, so a companion is called by name ("traveling with Mom Liz" →
 * "traveling with Liz"; quoted speech untouched), and until the sheet
 * states pronouns the character being made is never he or she.
 */
export async function guardInterviewReply(
  reply: string,
  sheet: Pick<CharacterDefinition, 'name' | 'pronouns' | 'relationships'> | null,
  tableNames: string[],
  opts: { llm?: Llm } = {},
): Promise<string> {
  if (!reply) return reply;
  const terms = (sheet?.relationships ?? []).flatMap(r => r.address?.trim() && r.to?.trim() ? [{ name: r.to.trim(), address: r.address.trim() }] : []);
  let out = terms.length > 0 ? namesInNarration(reply, terms) : reply;
  if (!sheet?.pronouns?.trim()) {
    const otherNames = [...new Set([...tableNames, ...terms.map(t => t.name)])].filter(n => !sheet?.name || firstName(n).toLowerCase() !== firstName(sheet.name).toLowerCase());
    out = await interviewReplyWithoutGuessedGender(out, { name: sheet?.name ?? null, otherNames }, opts);
  }
  return out;
}
