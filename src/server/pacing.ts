import type { ServerMessage } from '../shared/protocol.js';

/**
 * Reading-time pacing between story beats. Players said the table "moves very
 * fast": narration, a character's options, the chosen action and the DM's
 * ruling landed back to back, faster than anyone could read. The game loop
 * now holds each beat back until the previous one has had time to be read.
 *
 * delay = clamp(words / wordsPerSec, minMs, maxMs), from THAT beat's text
 * alone. All three come from the environment (read when a GameLoop is built,
 * so tests can set them), and PACE_MAX_MS=0 turns pacing off — the test
 * config does exactly that.
 *
 * Defaults, re-tuned after a live two-player table (every gap was a flat 12s,
 * the ruling 18-24s after the action):
 *  - 3.5 words/s (210 wpm): a little under the ~240 wpm adults read prose
 *    silently, because players are also deciding what to whisper next.
 *  - 1.5s floor: long enough for a one-line beat ("[Vex is still down]", the
 *    dice) to register, short enough that it never feels like dead air.
 *  - 8s ceiling (~28 words): the old 12s ceiling was hit by nearly every
 *    narration and ruling, so the table ticked at a flat 12s. Text stays on
 *    screen, so the tail of a long paragraph is read while the next LLM call
 *    (itself several seconds, and overlapped with this wait) runs.
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
    minMs: envNumber(env.PACE_MIN_MS, 1500),
    maxMs: envNumber(env.PACE_MAX_MS, 8000),
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
 * The text of a PUBLIC beat — one every seat reads — or null for anything
 * else: chrome (prompts, state updates), the epilogue (the last thing said,
 * nothing waits on it), and a character's private thinking (options, whisper
 * guidance, inner thought). Private beats go to one seat; if they held the
 * loop, every other player would sit through reading time for text they
 * never see — which is exactly what happened live.
 */
export function beatText(msg: ServerMessage): string | null {
  switch (msg.type) {
    case 'narration': return msg.isEpilogue ? null : msg.text;
    case 'resolution': return msg.text;
    case 'scene-end': return msg.summary;
    case 'action-taken': return [msg.action, msg.spokenWords ?? ''].join(' ');
    default: return null;
  }
}

/** The wait a beat earns: its own text's reading time; the dice, a glance (the floor) before the ruling. */
export function beatDelayMs(msg: ServerMessage, p: Pacing): number {
  if (p.maxMs <= 0) return 0;
  if (msg.type === 'dice-roll') return p.minMs;
  const text = beatText(msg);
  return text === null ? 0 : readingDelayMs(text, p);
}

/**
 * When the table will have read everything shown so far. mark() each beat
 * as it goes out; remainingMs() is how long the next one must still wait.
 * Beats sent in one burst add up (both must be read); a beat sent after the
 * previous one was already read starts a fresh wait of its own length, so
 * time the loop spent on an LLM call counts as reading time — nothing is
 * waited for twice. hold()/release() freeze and resume the wait for a pause.
 */
export class ReadingClock {
  private readyAt = 0;
  private heldMs: number | null = null;

  constructor(readonly pacing: Pacing, private now: () => number = Date.now) {}

  mark(msg: ServerMessage): number {
    const delay = beatDelayMs(msg, this.pacing);
    if (delay <= 0) return 0;
    if (this.heldMs !== null) this.heldMs += delay;
    else this.readyAt = Math.max(this.now(), this.readyAt) + delay;
    return delay;
  }

  remainingMs(): number {
    return this.heldMs ?? Math.max(0, this.readyAt - this.now());
  }

  hold(): void {
    if (this.heldMs === null) this.heldMs = Math.max(0, this.readyAt - this.now());
  }

  release(): void {
    if (this.heldMs === null) return;
    this.readyAt = this.now() + this.heldMs;
    this.heldMs = null;
  }
}
