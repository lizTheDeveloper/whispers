/**
 * Where a sentence ends, for every guard that works sentence by sentence.
 *
 * Terminal punctuation (and any closing quote after it) followed by space —
 * except the full stop of a title: "Ms.", "Mr.", "Mrs.", "Dr.", "St." and
 * the like. Live (WXKC2C): the repeat guard split "…while Ms. Prudence Hark
 * adjusts her glasses" after "Ms.", dropped "Prudence Hark adjusts her
 * glasses…" as a repeat, and the table read "while Ms. 'The stamp is
 * valid…'". Case matters: a sentence can end on "ms." or "st." in lower case.
 */
export const TITLE = String.raw`(?:Mr|Mrs|Ms|Mx|Dr|St|Prof|Capt|Sgt|Lt|Rev)`;

/** A title's full stop, just before `index` in `text` ("…while Ms."). */
export function endsInTitle(textBefore: string): boolean {
  return new RegExp(String.raw`(?<![\w'’-])${TITLE}\.["”’']?$`).test(textBefore);
}

/** The space after a sentence (no line breaks): for `text.split(SENTENCE_SPLIT)`. */
export const SENTENCE_SPLIT = new RegExp(String.raw`(?<=[.!?…]["”’']?)(?<!(?<![\w'’-])${TITLE}\.)\s+`);

/** The space after a sentence, or a line break: global, for matchAll and split. */
export const SENTENCE_BREAK = new RegExp(String.raw`(?<=[.!?…]["”’']?)(?<!(?<![\w'’-])${TITLE}\.)\s+|\n+`, 'g');

/** Sentences, split after terminal punctuation (and any closing quote) or a line break; never after a title. */
export function splitSentences(text: string): string[] {
  return text.split(SENTENCE_BREAK).map(s => s.trim()).filter(Boolean);
}
