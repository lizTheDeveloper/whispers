/**
 * The gentle-table tone gate (round 14).
 *
 * Rounds 10–13 answered each new piece of child-directed menace from qwen
 * with another line in GENTLE_PERIL_REGISTER and another softenForChildren
 * pattern, and the model kept finding new ones (live 7RAAQ7: "re-file your
 * entire identity under the category of Unresolved Naps", "or the queue will
 * think you are two separate forms!", "eyes that are less eyes and more
 * swirling vortices of ink", "You and your companion stand bare-chested").
 * Patterns only catch what has already happened. This is a gate instead:
 *
 *  - At a gentle table (the host asked for gentle peril, or a child PC is
 *    present) each DM output — ruling, narration, opening, world
 *    introduction, epilogue — and each closing reflection is read by a
 *    short judge call on the same proxy and model, which returns a verdict
 *    and the offending phrases, copied from the text.
 *  - Flagged: the output is generated ONCE more with those phrases quoted as
 *    feedback in the prompt. The LLM never rewrites the text (the round-9
 *    rewrite machinery stays removed): it writes a fresh draft.
 *  - Still flagged: the draft with fewer flagged phrases is kept, and the
 *    deterministic softener runs over it.
 *  - The judge is bounded: a timeout, and on a timeout, an error or a reply
 *    that cannot be read the text goes out as written (fail-open) with a log
 *    line. Every verdict is logged.
 *
 * The register and the softener stay: the register steers the first draft,
 * the softener is the floor under whatever is kept.
 */
import { callLlm, ambientLlmSignal, isLlmAbort, LlmAbortError } from './agents/llm-client.js';

export type ToneKind = 'ruling' | 'narration' | 'opening' | 'world-intro' | 'epilogue' | 'reflection';

export interface ToneVerdict {
  flagged: boolean;
  /** The offending phrases, as they appear in the text. */
  phrases: string[];
}

/** A judge: null when it could not give a verdict (timeout, error, unreadable reply) — the gate then fails open. */
export type ToneJudge = (text: string, kind: ToneKind) => Promise<ToneVerdict | null>;

/** How long the judge may take before the text goes out as written. WHISPERS_TONE_JUDGE_MS overrides. */
export function toneJudgeTimeoutMs(): number {
  const env = Number(process.env.WHISPERS_TONE_JUDGE_MS);
  return Number.isFinite(env) && env > 0 ? env : 6000;
}

const ENDINGS = new Set<ToneKind>(['epilogue', 'reflection']);

const KIND_LABEL: Record<ToneKind, string> = {
  ruling: 'what happens after a character acts',
  narration: 'a story beat',
  opening: 'the opening of the adventure',
  'world-intro': "the player's first look at the world",
  epilogue: 'the closing narration of the whole story',
  reflection: "a character's last words and last thought as the story ends",
};

/**
 * The judge's criteria, from the real misses of 7RAAQ7. Kept short: the
 * judge is a classification call, not a second DM.
 */
export function toneJudgeSystemPrompt(kind: ToneKind): string {
  const ending = ENDINGS.has(kind);
  return [
    'TONE JUDGE for a family tabletop game. A child of about ten is at this table, or the host asked for gentle peril. You read ONE passage the game is about to show them and flag only what is wrong for that table. Real stakes, mishaps, grumpy officials, silly danger, mysteries and mild suspense are FINE — never flag those.',
    'Flag a phrase when it:',
    '1. threatens to file, re-file, process, stamp, catalogue, erase or delete a PERSON, or to take away who they are or their name — "re-file your entire identity under the category of Unresolved Naps", "mistakes must be filed" (said at the kid), "a lullaby that makes one forget one\'s own name";',
    '2. separates the child from their grown-up, even as a joke — "or the queue will think you are two separate forms!";',
    '3. uses creepy or bodily imagery around people: burying them, chewing or biting, hungry things that want them, floors dissolving under them, eyes that are not eyes — "bury them in a paperwork avalanche", "as if their presence has just been chewed on", "very sticky ghosts … all very hungry", "pull them back from the dissolving floor", "eyes that are less eyes and more swirling vortices of ink";',
    '4. describes a player character\'s body, bare skin or undress — "You and your companion stand bare-chested".',
    ending
      ? '5. THIS IS AN ENDING. It must close warm and resolved enough: the party together and safe, the day\'s trouble settled enough to rest. Flag the closing words if they leave a question hanging, the party waiting, stuck or in limbo, the world still pulsing or unsettled, or a hope that is only half there — "remains unanswered, and the beige ripples … continue their slow, wet pulse", "…is still open, and we face it together." A thread may stay open for next time only when the last note is warm and settled.'
      : '',
    'Reply with JSON only: {"verdict":"ok","phrases":[]} or {"verdict":"flag","phrases":["exact words copied from the passage"]}. Copy each phrase exactly as written, a few words up to one clause, at most 5. When in doubt, "ok".',
  ].filter(Boolean).join('\n');
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

/**
 * The phrases that are really in `text` (the judge's quote, allowing an
 * ellipsis for a cut: "bury them in a … avalanche"). A phrase the judge
 * made up is not evidence of anything.
 */
export function phrasesInText(text: string, phrases: string[]): string[] {
  const hay = norm(text);
  return phrases.filter(p => {
    if (typeof p !== 'string') return false;
    const parts = norm(p).replace(/^["']|["']$/g, '').split(/\s*(?:…|\.\.\.)\s*/).map(x => x.trim()).filter(x => x.length >= 3);
    if (parts.length === 0) return false;
    let from = 0;
    for (const part of parts) {
      const at = hay.indexOf(part, from);
      if (at < 0) return false;
      from = at + part.length;
    }
    return true;
  });
}

/** Reads the judge's reply; null when it is not a verdict. */
export function parseToneVerdict(reply: unknown, text: string): ToneVerdict | null {
  let obj: any = reply;
  if (typeof reply === 'string') {
    const json = reply.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    try { obj = JSON.parse(json); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || typeof obj.verdict !== 'string') return null;
  const verdict = obj.verdict.trim().toLowerCase();
  if (verdict === 'ok') return { flagged: false, phrases: [] };
  if (verdict !== 'flag') return null;
  const quoted = Array.isArray(obj.phrases) ? obj.phrases.filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0) : [];
  const found = phrasesInText(text, quoted);
  if (quoted.length > 0 && found.length === 0) {
    console.log(`[tone-gate] judge flagged phrases that are not in the text (${quoted.map((q: string) => `"${q.slice(0, 60)}"`).join(', ')}) — treated as ok`);
    return { flagged: false, phrases: [] };
  }
  return { flagged: found.length > 0, phrases: found.slice(0, 5) };
}

/**
 * The judge on the game's proxy and model: one short call, no reasoning
 * pass (/no_think), no schema retries, and a hard timeout. Never throws but
 * for a pause or stop of the game (LlmAbortError): anything else is null.
 */
export const llmToneJudge: ToneJudge = async (text, kind) => {
  const ambient = ambientLlmSignal();
  const budget = toneJudgeTimeoutMs();
  const timer = new AbortController();
  const t = setTimeout(() => timer.abort(), budget);
  const started = Date.now();
  try {
    const reply = await callLlm({
      messages: [
        { role: 'system', content: toneJudgeSystemPrompt(kind) },
        { role: 'user', content: `Passage (${KIND_LABEL[kind]}):\n"""\n${text}\n"""\nYour verdict, as JSON:` },
      ],
      temperature: 0,
      // A one-line JSON verdict; room for a short think if the model ignores /no_think.
      maxTokens: 768,
      timeout: budget,
      noThink: true,
      signal: ambient ? AbortSignal.any([ambient, timer.signal]) : timer.signal,
    });
    const verdict = parseToneVerdict(reply, text);
    if (!verdict) console.warn(`[tone-gate] ${kind}: judge reply unreadable after ${Date.now() - started}ms — kept as written (fail-open): ${String(reply).slice(0, 120)}`);
    return verdict;
  } catch (e) {
    if (ambient?.aborted) throw new LlmAbortError();
    if (timer.signal.aborted || isLlmAbort(e)) console.warn(`[tone-gate] ${kind}: judge timed out after ${budget}ms — kept as written (fail-open)`);
    else console.warn(`[tone-gate] ${kind}: judge failed after ${Date.now() - started}ms — kept as written (fail-open):`, e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(t);
  }
};

/** The feedback a flagged draft's second try is given: the phrases, quoted. Never the draft itself. */
export function toneFeedback(phrases: string[], kind: ToneKind): string {
  const quoted = phrases.map(p => `"${p}"`).join('; ');
  const ending = ENDINGS.has(kind)
    ? ' This is the ending: close warm and settled — the party together and safe, the trouble done enough to rest — never on an open question, a wait or something still unsettled.'
    : '';
  return `A reader for this gentle table flagged these phrases in your last draft: ${quoted}. Write it fresh, telling the same events, with none of these phrases and nothing like them: no filing, erasing or forgetting a person, nothing that parts the child from their grown-up, no creepy or bodily imagery, nothing about anyone's body.${ending}`;
}

export interface GateResult<T> {
  value: T;
  /** The kept draft was still flagged: the caller's softener has run over it. */
  stillFlagged: boolean;
  regenerated: boolean;
}

/**
 * Judge `first`; when flagged, generate once more with the phrases as
 * feedback and judge that; keep the better one. `extraFlags` adds
 * deterministic flags (the epilogue's bleakEnding) to the judge's.
 * `soften` runs over a draft that is kept while still flagged.
 */
export async function gateGentleTone<T>(opts: {
  kind: ToneKind;
  first: T;
  textOf: (value: T) => string;
  regenerate: (feedback: string) => Promise<T | null | undefined>;
  soften: (value: T) => T;
  judge?: ToneJudge;
  extraFlags?: (text: string) => string[];
  /** For the log: whose reflection, which scene. */
  label?: string;
}): Promise<GateResult<T>> {
  const judge = opts.judge ?? llmToneJudge;
  const what = opts.label ? `${opts.kind} (${opts.label})` : opts.kind;
  const assess = async (value: T): Promise<{ verdict: ToneVerdict | null; ms: number }> => {
    const text = opts.textOf(value) ?? '';
    const started = Date.now();
    if (!text.trim()) return { verdict: { flagged: false, phrases: [] }, ms: 0 };
    const judged = await judge(text, opts.kind);
    const extra = opts.extraFlags?.(text) ?? [];
    if (!judged && extra.length === 0) return { verdict: null, ms: Date.now() - started };
    const phrases = [...new Set([...(judged?.phrases ?? []), ...extra])];
    return { verdict: { flagged: (judged?.flagged ?? false) || extra.length > 0, phrases }, ms: Date.now() - started };
  };

  const a = await assess(opts.first);
  if (!a.verdict) {
    console.log(`[tone-gate] ${what}: no verdict (${a.ms}ms) — kept as written`);
    return { value: opts.first, stillFlagged: false, regenerated: false };
  }
  if (!a.verdict.flagged) {
    console.log(`[tone-gate] ${what}: ok (${a.ms}ms)`);
    return { value: opts.first, stillFlagged: false, regenerated: false };
  }
  console.warn(`[tone-gate] ${what}: flagged (${a.ms}ms) ${a.verdict.phrases.map(p => `"${p}"`).join(', ')} — generating once more`);

  let second: T | null | undefined;
  try {
    second = await opts.regenerate(toneFeedback(a.verdict.phrases.length > 0 ? a.verdict.phrases : ['(the passage as a whole)'], opts.kind));
  } catch (e) {
    if (isLlmAbort(e)) throw e;
    console.error(`[tone-gate] ${what}: second draft failed — keeping the first, softened:`, e);
  }
  if (second === null || second === undefined || !opts.textOf(second)?.trim()) {
    return { value: opts.soften(opts.first), stillFlagged: true, regenerated: false };
  }

  const b = await assess(second);
  if (!b.verdict) {
    console.log(`[tone-gate] ${what}: second draft not judged (${b.ms}ms) — keeping it, softened`);
    return { value: opts.soften(second), stillFlagged: false, regenerated: true };
  }
  if (!b.verdict.flagged) {
    console.log(`[tone-gate] ${what}: second draft ok (${b.ms}ms)`);
    return { value: second, stillFlagged: false, regenerated: true };
  }
  // Both flagged: the one with fewer flagged phrases (the second on a tie —
  // it was written against the first's list), softened.
  const keepFirst = a.verdict.phrases.length < b.verdict.phrases.length;
  console.warn(`[tone-gate] ${what}: second draft still flagged (${b.ms}ms) ${b.verdict.phrases.map(p => `"${p}"`).join(', ')} — keeping the ${keepFirst ? 'first' : 'second'} (${Math.min(a.verdict.phrases.length, b.verdict.phrases.length)} vs ${Math.max(a.verdict.phrases.length, b.verdict.phrases.length)} phrases), softened`);
  return { value: opts.soften(keepFirst ? opts.first : second), stillFlagged: true, regenerated: true };
}
