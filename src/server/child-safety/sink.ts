import { createHash } from 'node:crypto';

/**
 * Where the safety floor reports sexual content involving a minor.
 *
 * safety-floor.ts and tone-gate.ts are pure text functions; they call
 * noteSexualFloor() and the server installs the handler that files the case
 * in the child-safety evidence vault (reporter.ts). Tests install a spy.
 *
 * The same module keeps the flagged text out of Whispers' own logs:
 * redactLog() replaces anything reported here with a withheld marker.
 */

export type FloorDetector = 'backstop' | 'judge';

export interface SexualFloorFlag {
  /** The flagged text exactly as it appeared. */
  content: string;
  detector: FloorDetector;
  /** What was being checked ("narration (scene 2)", "whisper", …). */
  label: string;
  /** Who produced the text: an AI agent's draft, or a human's own words. */
  origin: 'ai' | 'human';
  /** The whole passage the flagged text came from, when it is longer. */
  passage?: string;
}

type Handler = (flag: SexualFloorFlag) => void;
let handler: Handler | null = null;

export function setSexualFloorHandler(h: Handler | null): void {
  handler = h;
}

const RECENT_MAX = 500;
const recent: string[] = [];

export function contentSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Report one flag. Never throws: a broken handler must not break the game. */
export function noteSexualFloor(flag: SexualFloorFlag): void {
  const n = norm(flag.content);
  if (!n) return;
  if (!recent.includes(n)) {
    recent.push(n);
    if (recent.length > RECENT_MAX) recent.shift();
  }
  if (!handler) return;
  try {
    handler(flag);
  } catch (e) {
    console.error('[child-safety] could not file a safety-floor flag:', e instanceof Error ? e.message : e);
  }
}

/** The marker logs carry instead of flagged content. */
export function withheld(text: string): string {
  return `[withheld: child-safety evidence ${contentSha256(text).slice(0, 12)}]`;
}

/** `text` for a log line: withheld when it overlaps anything reported to the vault. */
export function redactLog(text: string): string {
  const n = norm(text ?? '');
  if (!n) return text;
  for (const r of recent) {
    if (n.includes(r) || (n.length >= 12 && r.includes(n))) return withheld(text);
  }
  return text;
}

/**
 * A whole log line with every piece of reported content withheld: the exact
 * text wherever it appears, and any quoted run ("…") that overlaps it — log
 * lines quote truncated sentences and the judge's phrases.
 */
export function redactLine(line: string): string {
  if (recent.length === 0 || typeof line !== 'string' || !line) return line;
  let out = line.replace(/"([^"\n]{3,})"/g, (whole, inner: string) => {
    const r = redactLog(inner.replace(/…$/, ''));
    return r === inner.replace(/…$/, '') ? whole : `"${r}"`;
  });
  const lower = out.toLowerCase().replace(/\s+/g, ' ');
  if (recent.some(r => lower.includes(r))) {
    for (const r of recent) {
      const at = out.toLowerCase().indexOf(r);
      if (at >= 0) out = `${out.slice(0, at)}${withheld(out.slice(at, at + r.length))}${out.slice(at + r.length)}`;
    }
  }
  return out;
}

let consoleWrapped = false;
/**
 * Wrap console.log/info/warn/error/debug so no line carries reported content
 * — Whispers' own logs, and whatever captures the console downstream
 * (docker logs, error-reporting breadcrumbs). A no-op while nothing has been
 * reported.
 */
export function installLogRedaction(): void {
  if (consoleWrapped) return;
  consoleWrapped = true;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => orig(...(recent.length === 0 ? args : args.map(a => (typeof a === 'string' ? redactLine(a) : a))));
  }
}

/** For tests. */
export function resetSexualFloorSink(): void {
  handler = null;
  recent.length = 0;
}
