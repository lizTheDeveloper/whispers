import { createHash } from 'node:crypto';

/**
 * Where the safety floor reports sexual content involving a minor.
 *
 * safety-floor.ts and tone-gate.ts are pure text functions; they call
 * noteSexualFloor() — once per checked text, with every flagged sentence or
 * phrase in it — and the server installs the handler that files the case in
 * the child-safety evidence vault (reporter.ts). Tests install a spy.
 *
 * The same module keeps the flagged text out of Whispers' own logs, in two
 * layers, both by hash of the exact (normalised) flagged text — never by
 * substring, so common words never hide a line:
 *  - call sites that log model or player text pass it through redactLog()
 *    (which also knows the truncated forms the logs print: the first 80 and
 *    160 characters);
 *  - installLogRedaction() wraps the console as a backstop: any quoted run
 *    or sentence of a log line whose hash is a flagged sentence's is withheld.
 */

export type FloorDetector = 'backstop' | 'judge';

export interface SexualFloorFlag {
  /** Every flagged sentence or phrase in the checked text, exactly as it appeared. */
  items: string[];
  detector: FloorDetector;
  /** What was being checked ("narration (scene 2)", "whisper", …). */
  label: string;
  /** Who produced the text: an AI agent's draft, or a human's own words. */
  origin: 'ai' | 'human';
  /** A window of the passage around the flagged text (passageWindow), when the passage is longer. */
  passage?: string;
}

type Handler = (flag: SexualFloorFlag) => void;
let handler: Handler | null = null;

export function setSexualFloorHandler(h: Handler | null): void {
  handler = h;
}

/** Normalised text longer than this is hashed by its first MAX_NORM chars. */
const MAX_NORM = 2000;
/** Shorter strings are never withheld (a common word must not hide log lines). */
const MIN_REDACT = 12;
const RECENT_MAX = 1000;
const recentHashes: string[] = [];
const recentSet = new Set<string>();

export function contentSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const norm = (s: string) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, MAX_NORM);

function rememberOne(text: string): void {
  const n = norm(text);
  if (n.length < MIN_REDACT) return;
  const h = contentSha256(n);
  if (recentSet.has(h)) return;
  recentSet.add(h);
  recentHashes.push(h);
  if (recentHashes.length > RECENT_MAX) recentSet.delete(recentHashes.shift()!);
}

/** A sentence split good enough for log lines. */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+|\n+/).map(t => t.trim()).filter(Boolean);
}

/** The flagged text, each of its sentences, and the truncated forms logs print. */
function remember(text: string): void {
  for (const t of [text, ...sentencesOf(text)]) {
    rememberOne(t);
    for (const n of TRUNCATIONS) if (t.length > n) rememberOne(t.slice(0, n));
  }
}

/** The prefixes call sites print ("…".slice(0, N)). */
const TRUNCATIONS = [60, 80, 120, 160];

/** True when `text` is (after normalisation) exactly something reported to the vault. */
export function isWithheld(text: string): boolean {
  const n = norm(text);
  return n.length >= MIN_REDACT && recentSet.has(contentSha256(n));
}

/** Report one checked text's flags. Never throws: a broken handler must not break the game. */
export function noteSexualFloor(flag: SexualFloorFlag): void {
  const items = flag.items.filter(i => i && i.trim());
  if (items.length === 0) return;
  for (const i of items) remember(i);
  if (!handler) return;
  try {
    handler({ ...flag, items });
  } catch (e) {
    console.error('[child-safety] could not file a safety-floor flag:', e instanceof Error ? e.message : e);
  }
}

/** The marker logs carry instead of flagged content. */
export function withheld(text: string): string {
  return `[withheld: child-safety evidence ${contentSha256(norm(text)).slice(0, 12)}]`;
}

/** `text` for a log line: withheld when it is exactly something reported to the vault. */
export function redactLog(text: string): string {
  return isWithheld(text) ? withheld(text) : text;
}

const WINDOW = 400;
const PASSAGE_MAX = 4000;
/**
 * The part of `passage` around the flagged items, for a case's context:
 * WINDOW characters either side of each, merged, at most PASSAGE_MAX in all.
 */
export function passageWindow(passage: string, items: string[]): string {
  const spans: Array<[number, number]> = [];
  for (const item of items) {
    const at = passage.indexOf(item);
    if (at < 0) continue;
    spans.push([Math.max(0, at - WINDOW), Math.min(passage.length, at + item.length + WINDOW)]);
  }
  if (spans.length === 0) return passage.slice(0, PASSAGE_MAX);
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  let out = '';
  for (const [a, b] of merged) {
    const piece = `${a > 0 ? '…' : ''}${passage.slice(a, b)}${b < passage.length ? '…' : ''}`;
    if (out.length + piece.length > PASSAGE_MAX) { out = out ? `${out}\n[…]` : piece.slice(0, PASSAGE_MAX); break; }
    out += (out ? '\n' : '') + piece;
  }
  return out;
}

/**
 * A log line with every quoted run or sentence that hashes to flagged text
 * withheld. Exact matches only.
 */
export function redactLine(line: string): string {
  if (recentSet.size === 0 || typeof line !== 'string' || line.length < MIN_REDACT) return line;
  let out = line.replace(/"([^"\n]{12,})"/g, (whole, inner: string) => (isWithheld(inner) ? `"${withheld(inner)}"` : whole));
  for (const sentence of sentencesOf(out)) {
    if (isWithheld(sentence)) out = out.replace(sentence, withheld(sentence));
  }
  return isWithheld(out) ? withheld(out) : out;
}

let consoleWrapped = false;
/** Defence in depth: every console line goes through redactLine (a no-op while nothing is flagged). */
export function installLogRedaction(): void {
  if (consoleWrapped) return;
  consoleWrapped = true;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => orig(...(recentSet.size === 0 ? args : args.map(a => (typeof a === 'string' ? redactLine(a) : a))));
  }
}

/** For tests. */
export function resetSexualFloorSink(): void {
  handler = null;
  recentHashes.length = 0;
  recentSet.clear();
}
