import { createHash } from 'node:crypto';

/**
 * Where the safety floor reports sexual content involving a minor.
 *
 * safety-floor.ts and tone-gate.ts are pure text functions; they call
 * noteSexualFloor() — once per checked text, with every flagged sentence or
 * phrase in it — and the server installs the handler that files the case in
 * the child-safety evidence vault (reporter.ts). Tests install a spy.
 *
 * The same module keeps the flagged text out of Whispers' own logs: the call
 * sites that log flagged sentences or phrases pass them through redactLog(),
 * which withholds an exact (normalised) match of anything reported here.
 * Nothing else is touched: no global console hook, no substring matching.
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

function remember(text: string): void {
  const n = norm(text);
  if (n.length < MIN_REDACT) return;
  const h = contentSha256(n);
  if (recentSet.has(h)) return;
  recentSet.add(h);
  recentHashes.push(h);
  if (recentHashes.length > RECENT_MAX) recentSet.delete(recentHashes.shift()!);
}

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

/** For tests. */
export function resetSexualFloorSink(): void {
  handler = null;
  recentHashes.length = 0;
  recentSet.clear();
}
