import type { ServerMessage } from '../shared/protocol.js';

/**
 * Reading-time pacing between story beats. Players said the table "moves very
 * fast": narration, a character's options, the chosen action and the DM's
 * ruling landed back to back, faster than anyone could read. The game loop
 * now holds each beat back until the previous one has had time to be read.
 *
 * delay = clamp(words / wordsPerSec, minMs, maxMs). All three come from the
 * environment (read when a GameLoop is built, so tests can set them), and
 * PACE_MAX_MS=0 turns pacing off — the test config does exactly that.
 */
export interface Pacing {
  wordsPerSec: number;
  minMs: number;
  maxMs: number;
}

function envNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function pacingFromEnv(env: NodeJS.ProcessEnv = process.env): Pacing {
  return {
    wordsPerSec: envNumber(env.PACE_WORDS_PER_SEC, 3.5) || 3.5,
    minMs: envNumber(env.PACE_MIN_MS, 2000),
    maxMs: envNumber(env.PACE_MAX_MS, 12000),
  };
}

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** How long a reader needs for `text`. 0 when pacing is off or there is nothing to read. */
export function readingDelayMs(text: string, p: Pacing): number {
  if (p.maxMs <= 0) return 0;
  const words = countWords(text);
  if (words === 0) return 0;
  const raw = (words / p.wordsPerSec) * 1000;
  return Math.round(Math.min(p.maxMs, Math.max(p.minMs, raw)));
}

/**
 * The text of a message that is a beat someone reads, or null for chrome
 * (prompts, state updates, dice — dice arrive with the action they belong
 * to). The epilogue is the last thing said, so nothing waits on it.
 */
export function beatText(msg: ServerMessage): string | null {
  switch (msg.type) {
    case 'narration': return msg.isEpilogue ? null : msg.text;
    case 'resolution': return msg.text;
    case 'scene-end': return msg.summary;
    case 'action-taken': return [msg.action, msg.spokenWords ?? ''].join(' ');
    case 'character-thought': return msg.innerThought;
    case 'action-proposals': return [...msg.actions, ...(msg.actionReasons ?? [])].join(' ');
    default: return null;
  }
}
