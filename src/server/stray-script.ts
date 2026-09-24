/**
 * Stray non-Latin script in English output (round 18, 39PF4D): qwen put a
 * Chinese character into one of Liz's options, "Sharply瞪 The Pigeon". The
 * game is played in English, so every letter of another script (Han, kana,
 * Hangul, Cyrillic, Greek, Arabic, Hebrew, Devanagari, Thai…) is dropped
 * from what the model writes, and the spacing around it tidied. Latin
 * letters with accents ("José", "café"), punctuation, symbols ("×", "—")
 * and emoji stay. CJK punctuation becomes its English mark.
 */

/** The language the game is played in. Only English is filtered. */
export function gameLanguage(): string {
  return (process.env.GAME_LANGUAGE ?? 'en').trim().toLowerCase() || 'en';
}

const CJK_PUNCTUATION: Record<string, string> = {
  '。': '.', '，': ',', '、': ',', '！': '!', '？': '?', '：': ':', '；': ';',
  '「': '"', '」': '"', '『': '"', '』': '"', '（': '(', '）': ')', '【': '[', '】': ']', '《': '"', '》': '"', '～': '~', '　': ' ',
};
const CJK_PUNCT_RE = new RegExp(`[${Object.keys(CJK_PUNCTUATION).join('')}]`, 'g');

/** A run of letters (with their combining marks) in any script but Latin. */
const NON_LATIN_RUN = /(?:(?!\p{Script=Latin})\p{L}\p{M}*)+/u;

/** What may follow a dropped word without a space before it: closing punctuation, a line end, the end. */
const TIGHT_AFTER = /^(?:$|[.,!?;:)\]}"”’'…\n])/;
/** What a dropped word may follow without a space after it: the start, a line start, an opening bracket or quote. */
const TIGHT_BEFORE = /(?:^|[\n(\[{"“‘'])$/;

export function withoutStrayScript(text: string): string {
  if (!text || !/[^\x00-ɏḀ-ỿ -⯿️\u{1F000}-\u{1FFFF}]/u.test(text)) return text;
  let out = text.replace(CJK_PUNCT_RE, c => CJK_PUNCTUATION[c] ?? c);
  const run = new RegExp(`[ \\t]*${NON_LATIN_RUN.source}[ \\t]*(?:([—–])[ \\t]*)?`, 'gu');
  out = out.replace(run, (_whole, dash: string | undefined, offset: number, all: string) => {
    const before = all.slice(0, offset);
    const after = all.slice(offset + _whole.length);
    // "sighs — привет — and": one dash, not two.
    if (dash && /[—–][ \t]*$/.test(before)) return ' ';
    if (dash) return TIGHT_BEFORE.test(before) ? `${dash} ` : ` ${dash} `;
    if (TIGHT_AFTER.test(after) || TIGHT_BEFORE.test(before)) return '';
    return ' ';
  });
  if (out !== text) console.log(`[guard] stray non-Latin script dropped: "${text.slice(0, 80)}" → "${out.slice(0, 80)}"`);
  return out;
}

/** withoutStrayScript when the game is played in English; the text as it is otherwise. */
export function englishOnly(text: string): string {
  return gameLanguage().startsWith('en') ? withoutStrayScript(text) : text;
}
