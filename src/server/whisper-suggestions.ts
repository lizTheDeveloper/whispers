/**
 * Text helpers for the whisper suggestion chips. The chips are built from a
 * character's proposed actions, which run long; they used to be clipped at a
 * fixed 50 characters ("…steal the stamped pass, and h.") and lower-cased
 * whole ("ask mister pippin"). Now a chip keeps whole clauses where it can,
 * cuts only at a word boundary (with an ellipsis) where it must, and only
 * ever changes the case of its first letter.
 */

export const SUGGESTION_MAX_CHARS = 60;

// Words a cut must not end on: "…can open a…" reads worse than "…can open…".
const DANGLING = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'yet', 'in', 'on', 'at', 'to', 'of', 'for', 'with',
  'by', 'from', 'into', 'onto', 'over', 'under', 'my', 'your', 'his', 'her', 'their', 'its', 'our',
  'this', 'that', 'these', 'those', 'as', 'if', 'than', 'then', 'while', 'before', 'after', 'about',
]);

function trimDangling(words: string[]): string[] {
  const out = [...words];
  while (out.length > 1 && DANGLING.has(out[out.length - 1]!.toLowerCase().replace(/[^a-z']/g, ''))) out.pop();
  return out;
}

/**
 * The gist of a proposed action, short enough for a chip: the first sentence,
 * minus "I try to"; if that is too long, as many leading clauses as fit; if
 * even the first clause is too long, whole words up to the limit and "…".
 * Never ends mid-word, never ends with a period (the caller punctuates).
 */
export function shortenSuggestion(action: string, max = SUGGESTION_MAX_CHARS): string {
  let s = action
    .replace(/[*_#`]+/g, '')
    .replace(/^\s*I\s+/i, '')
    .replace(/^(try|attempt|decide|choose|want) to\s+/i, '')
    .trim();
  s = (s.split(/(?<=[.!?])\s+/)[0] ?? s).replace(/[.!?]+$/, '').trim();
  if (s.length <= max) return s;

  const clauses = s.split(/\s*[,;:]\s+|\s+[—–]\s+|\s+-\s+/).map(c => c.trim()).filter(Boolean);
  let kept = '';
  for (const clause of clauses) {
    const next = kept ? `${kept}, ${clause}` : clause;
    if (next.length > max) break;
    kept = next;
  }
  if (kept.length >= 12) return trimDangling(kept.split(/\s+/)).join(' ').replace(/,$/, '');

  const words = s.split(/\s+/);
  const fit: string[] = [];
  for (const w of words) {
    if ([...fit, w].join(' ').length > max - 1) break;
    fit.push(w);
  }
  if (fit.length === 0) fit.push(words[0]!);
  return `${trimDangling(fit).join(' ').replace(/[,;:]+$/, '')}…`;
}

/**
 * Lower-case the first letter so the text reads mid-sentence ("Do it — slip
 * under…"), unless the first word is a name (or "I"). Nothing past the first
 * letter is touched, so "ask Mister Pippin" keeps its capitals.
 */
export function lowerFirst(text: string, names: Iterable<string> = []): string {
  const first = text.match(/^[\p{L}'’-]+/u)?.[0] ?? '';
  if (!first || first === 'I' || /^I['’]/.test(first)) return text;
  const nameWords = new Set<string>();
  for (const n of names) for (const w of n.split(/\s+/)) if (w) nameWords.add(w.toLowerCase());
  if (nameWords.has(first.toLowerCase())) return text;
  // An acronym or an all-caps word is not a sentence-start capital.
  if (first.length > 1 && first === first.toUpperCase()) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** "x" → "x." — but an ellipsis or other end mark stays as it is. */
export function endSentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}
