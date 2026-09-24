/**
 * How a character took a whisper is the character model's own report
 * (whisperedInfluence), and live it said "followed" on a turn where Biz did
 * something else entirely — the table read "[Biz heeded your whisper]". The
 * loop can also swap the action after the fact (a degenerate action is
 * replaced by the first proposal), which the report never saw.
 *
 * This is a deliberately small, conservative check, not a classifier: a
 * "followed" whose action and spoken words share NO content word with the
 * whisper (after a crude stem) is downgraded to "partially-followed". Short
 * whispers ("Be careful", "Run!") are never second-guessed — paraphrase is
 * the norm there — and the other verdicts are never touched.
 */
export type WhisperVerdict = 'followed' | 'partially-followed' | 'ignored';

const STOP = new Set([
  'the', 'and', 'but', 'for', 'nor', 'yet', 'with', 'from', 'into', 'onto', 'over', 'under', 'about', 'around', 'this', 'that',
  'these', 'those', 'what', 'when', 'where', 'while', 'who', 'whom', 'why', 'how', 'you', 'your', 'yours', 'yourself', 'they',
  'them', 'their', 'she', 'her', 'his', 'him', 'its', 'our', 'can', 'could', 'should', 'would', 'will', 'shall', 'must', 'might',
  'may', 'just', 'now', 'then', 'than', 'too', 'very', 'really', 'maybe', 'perhaps', 'dont', "don't", 'not', 'all', 'any', 'some',
  'let', 'get', 'got', 'make', 'try', 'there', 'here', 'have', 'has', 'had', 'are', 'was', 'were', 'been', 'being', 'into', 'out',
  'before', 'after', 'again', 'still', 'also', 'only', 'even', 'please',
]);

/** A crude stem: lower case, no punctuation, common endings off, first 5 letters. */
function stem(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  return w.replace(/(?:ing|ed|es|s)$/, '').slice(0, 5);
}

function contentStems(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  return new Set(words.filter(w => w.length >= 3 && !STOP.has(w)).map(stem).filter(s => s.length >= 3));
}

/** The whisper verdict as reported, unless the action plainly shares nothing with the whisper. */
export function checkedWhisperVerdict(whisper: string, action: string, spokenWords: string | null | undefined, verdict: WhisperVerdict): WhisperVerdict {
  if (verdict !== 'followed') return verdict;
  const asked = contentStems(whisper);
  if (asked.size < 3) return verdict;
  const did = contentStems(`${action} ${spokenWords ?? ''}`);
  for (const s of asked) if (did.has(s)) return verdict;
  return 'partially-followed';
}
