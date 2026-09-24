import { AsyncLocalStorage } from 'node:async_hooks';
import type { z } from 'zod';

const LLM_PROXY_URL = process.env.LLM_PROXY_URL ?? 'http://localhost:4242';
const DEFAULT_TIMEOUT = 60_000;

// Omitting `maxTokens` used to mean "omit `max_tokens` from the request
// entirely," which let the proxy apply whatever default IT happened to have
// — silently, with no error, and long replies truncated mid-sentence. That
// has now been found and one-off patched three separate times on this call
// site alone (draftWorldSeed's JSON, setupChat's readiness-panel reply,
// introduceWorld's opening prose). The fix is structural, not another patch:
// every call sends a real `max_tokens`, and a call site that forgets to
// specify one gets THIS ceiling instead of an unbounded unknown.
//
// 2048 is picked from what this codebase already treats as its "real prose
// or JSON reply" tier — narrate (2048), setupChat (2048), and the fact
// extractor (2048) all land here, with only single-field/one-sentence
// outputs (storeObservation, game-loop's short beats) going lower and only
// the densest structured payload (draftWorldSeed, 3+ locations/npcs/hooks)
// going higher at 4096. 2048 tokens is roughly 1500 words of English prose
// or JSON — comfortably more than any ordinary conversational turn or
// schema reply produces — so a call site relying on this default is never
// the one that truncates.
const DEFAULT_MAX_TOKENS = 2048;

interface CallLlmOpts<S extends z.ZodType | undefined = undefined> {
  messages: Array<{ role: string; content: string }>;
  schema?: S;
  temperature?: number;
  timeout?: number;
  maxTokens?: number;
  /**
   * Repetition penalties (OpenAI-style), sent when set. The shared game proxy
   * does not forward them yet (tools/llm-token-proxy/src/game-proxy.ts
   * builds its own forwardBody), so today they are a no-op upstream.
   */
  frequencyPenalty?: number;
  presencePenalty?: number;
  /**
   * Cancels the call: an aborted signal rejects promptly with an
   * LlmAbortError and is never retried (unlike a timeout or a bad reply).
   * When omitted, the ambient signal from runWithLlmSignal applies.
   */
  signal?: AbortSignal;
}

/**
 * Thrown when a caller's signal (not the timeout) cancels a call. A pause or
 * an end-game is a decision, not a failure: callers tell the two apart with
 * isLlmAbort so an aborted turn is never papered over with a fallback.
 */
export class LlmAbortError extends Error {
  constructor() {
    super('LLM call aborted');
    this.name = 'LlmAbortError';
  }
}

export function isLlmAbort(e: unknown): boolean {
  return e instanceof LlmAbortError;
}

// The game loop's turn makes its LLM calls through the agents (dm.ts,
// character.ts, extractor.ts, character-memory.ts), several of them
// fire-and-forget. Rather than thread a signal through every agent method,
// the loop runs its whole async chain inside runWithLlmSignal and every
// callLlm underneath picks the signal up here. The store is a getter, not a
// signal, because the loop swaps in a fresh AbortController on each resume.
const ambientSignal = new AsyncLocalStorage<(() => AbortSignal | null) | null>();

/**
 * Run `fn` with `getSignal` as the default signal for every callLlm in its
 * async call tree. Pass null to opt a subtree back out (the epilogue runs
 * after stop() has aborted the loop's signal and must still be written).
 */
export function runWithLlmSignal<T>(getSignal: (() => AbortSignal | null) | null, fn: () => T): T {
  return ambientSignal.run(getSignal, fn);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type CallLlmResult<S> = S extends z.ZodTypeAny ? z.output<S> : string;

/**
 * `truncated` is true when the object only parsed after closing structures
 * the model never closed — the reply ran out, it did not end. An open string
 * value is cut back to its last complete sentence before it is closed, so a
 * cut-off `narration` or `reply` never ends mid-word.
 */
function tryRepairJson(text: string): { json: string; truncated: boolean } | null {
  let candidate = text.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try { JSON.parse(candidate); return { json: candidate, truncated: false }; } catch {}
  }

  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;
  let fragment = text.slice(firstBrace);

  // Strip trailing incomplete key or value
  fragment = fragment.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, '');
  // Strip trailing incomplete object in an array (e.g. ,{"foo":"bar","ba )
  fragment = fragment.replace(/,\s*\{[^}]*$/, '');
  fragment = fragment.replace(/,\s*$/, '');

  // Count open braces/brackets and close them
  let braces = 0, brackets = 0;
  let inString = false, escape = false;
  let stringStart = -1;
  for (let i = 0; i < fragment.length; i++) {
    const ch = fragment[i]!;
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; if (inString) stringStart = i; continue; }
    if (inString) continue;
    if (ch === '{') braces++;
    if (ch === '}') braces--;
    if (ch === '[') brackets++;
    if (ch === ']') brackets--;
  }
  // Close any unterminated string — at its last complete sentence when it
  // has one (a short value like a name has none and is kept as it is).
  if (inString) {
    const body = fragment.slice(stringStart + 1).replace(/\\$/, '');
    const cut = lastSentenceEnd(body);
    fragment = fragment.slice(0, stringStart + 1) + (cut > 0 ? body.slice(0, cut) : body) + '"';
  }
  while (brackets > 0) { fragment += ']'; brackets--; }
  while (braces > 0) { fragment += '}'; braces--; }

  try { JSON.parse(fragment); return { json: fragment, truncated: true }; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Truncation. The proxy forwards to a reasoning model (gpt-oss-120b on Groq),
// whose hidden reasoning tokens count against max_tokens: too small a budget
// and the visible reply stops mid-sentence (or comes back empty) with no
// error anywhere. The proxy (/api/llm/think) currently returns only { text } —
// no finish_reason, no usage — so a finish reason is honoured when present
// (a future proxy, or a raw OpenAI-shaped body) and otherwise prose is judged
// by how it ends.
// ---------------------------------------------------------------------------

const TRUNCATION_FINISH_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens']);
/** Ceiling for a budget raised after a truncated reply. */
const MAX_RETRY_TOKENS = 8192;

export function growTokenBudget(maxTokens: number): number {
  return Math.min(MAX_RETRY_TOKENS, Math.max(maxTokens * 2, maxTokens + 1024));
}

function extractFinishReason(data: any): string | null {
  const reason = data?.finish_reason ?? data?.stop_reason ?? data?.choices?.[0]?.finish_reason ?? null;
  return typeof reason === 'string' ? reason : null;
}

// A sentence ends in . ! ? or …, optionally followed by closing quotes,
// brackets or markdown emphasis.
const SENTENCE_END = /[.!?…]["'”’»)\]*_]*/g;
const CLOSING_QUOTE_END = /["”’»]\s*$/;

/** Index just past the last complete sentence in `text`, or 0 if it has none. */
function lastSentenceEnd(text: string): number {
  let end = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    const after = m.index! + m[0].length;
    // Only a real boundary: end of text, or whitespace next ("3.5" is not one).
    if (after === text.length || /\s/.test(text[after]!)) end = after;
  }
  return end;
}

/** Prose that ends the way finished prose ends: terminal punctuation or a closing quote. */
export function endsCleanly(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return lastSentenceEnd(t) === t.length || CLOSING_QUOTE_END.test(t);
}

/**
 * Cut prose back to its last complete sentence. A quotation the cut leaves
 * open is closed, so `She says, "Run. Now` becomes `She says, "Run."`.
 * Returns '' when there is no complete sentence at all.
 */
export function trimToLastSentence(text: string): string {
  const t = text.trim();
  const end = lastSentenceEnd(t);
  if (end === 0) return '';
  let out = t.slice(0, end).trim();
  if ((out.match(/"/g) ?? []).length % 2 === 1) out += '"';
  if ((out.match(/“/g) ?? []).length > (out.match(/”/g) ?? []).length) out += '”';
  return out;
}

/** A reply that is only an action marker ("*thinks quietly*" — the proxy's stand-in for an empty reply). */
function isMarkerOnly(text: string): boolean {
  return /^\*[^*]+\*$/.test(text.trim());
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function fetchWithRetry(url: string, init: RequestInit & { signal: AbortSignal }, maxRetries = 3): Promise<Response> {
  for (let i = 0; i <= maxRetries; i++) {
    const response = await fetch(url, init);
    if (response.ok || !RETRYABLE_STATUS.has(response.status) || i === maxRetries) {
      return response;
    }
    const backoffMs = Math.min(1000 * Math.pow(2, i), 8000);
    console.log(`[llm-client] ${response.status} on attempt ${i + 1}/${maxRetries + 1}, retrying in ${backoffMs}ms`);
    await abortableSleep(backoffMs, init.signal);
  }
  throw new Error('unreachable');
}

/**
 * Everything callLlm does to a raw reply before judging it: thinking tags,
 * roleplay markers and code fences come off. Never rejects — an empty result
 * is for the caller to handle.
 */
function cleanReplyText(raw: string): string {
  let text = raw;
  // Strip Qwen3 thinking tags (closed or unclosed at end of output)
  text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  if (text.startsWith('<think>')) return '';

  // Strip roleplay markers that may wrap the response — leading and
  // trailing checked independently (not gated on one another), and NOT
  // gated on `schema`: a schema-less prose reply (world introduction,
  // negotiation dialogue, epilogue, character reflections, summarizeScene's
  // plain-text fallback) is exactly as susceptible to a stray
  // "*thinks quietly*" as a JSON one, and unlike JSON parsing it has no
  // downstream validation to catch it — a leftover marker there is not a
  // parse failure, it's just wrong text that gets stored and shown
  // forever (see sendWorldIntroduction: the intro turn is generated once
  // and never regenerated). This is post-processing only — never reject
  // the response, only clean it; an empty/unusable result after cleaning
  // is already handled separately by each caller.
  //
  // A single-asterisk pair like *nods* is a roleplay action marker; a
  // double-asterisk pair like **bold** is markdown emphasis that players
  // read. Both leading and trailing text can legitimately end in
  // **bold**, and the naive "strip *...* at the edge" version of this
  // (text.replace(/^\*[^*]*\*\s*/, '') / the trailing mirror) cannot
  // tell them apart: run against "He nodded. **Finally.**" it matches
  // just the closing "**" as an empty-content *[^*]** pair, leaving an
  // unbalanced "**Finally." behind. The (?<!\*)/(?!\*) guards on both
  // delimiters make a star that is adjacent to another star ineligible
  // as either the opening or closing delimiter of a marker, so a run of
  // two consecutive stars can never be mistaken for a single-star pair
  // — a real double-star bold run is left untouched, while a genuine
  // single-star action marker (with non-star content in between) is
  // still stripped.
  const LEADING_ACTION_MARKER = /^\*(?!\*)([^*]+)\*(?!\*)\s*/;
  const TRAILING_ACTION_MARKER = /\s*(?<!\*)\*(?!\*)([^*]+)\*(?!\*)$/;
  // Preserved so a response that is ENTIRELY marker-wrapped text (e.g.
  // "*just this*", with nothing left once the wrapper comes off) can
  // fall back to its unstripped self below, instead of the stripping
  // step manufacturing an empty response out of a real answer.
  const beforeMarkerStrip = text;
  if (LEADING_ACTION_MARKER.test(text)) {
    text = text.replace(LEADING_ACTION_MARKER, '').trim();
  }
  if (TRAILING_ACTION_MARKER.test(text)) {
    text = text.replace(TRAILING_ACTION_MARKER, '').trim();
  }
  // Strip markdown code fences — same reasoning, not gated on `schema`.
  text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  // Stripping cosmetic roleplay/fence markers must never manufacture an
  // empty response out of real model output — a reply that is nothing
  // BUT marker-wrapped text (e.g. "*acknowledges quietly*") strips to
  // nothing here. That is still an answer with cosmetic wrapping, which
  // is strictly better than throwing and failing the action outright, so
  // fall back to the unstripped text rather than treating this as empty.
  if (!text && beforeMarkerStrip) {
    text = beforeMarkerStrip;
  }

  return text;
}

interface Completion {
  text: string;
  /** The provider's finish reason when the proxy passes one through, else null. */
  finishReason: string | null;
}

/** True when the provider said it stopped for length. */
function hitTokenLimit(c: Completion): boolean {
  return c.finishReason !== null && TRUNCATION_FINISH_REASONS.has(c.finishReason.toLowerCase());
}

/** The user turn added to a request that has none (see withUserTurn). */
const MINIMAL_USER_TURN = 'Begin.';

/**
 * The messages as the model's chat template will accept them. Qwen's template
 * (qwen/qwen3.8-27b, behind the shared proxy) raises "No user query found in
 * messages" on a request with no user turn — live, the DM's setup greeting
 * (a system prompt and an empty history) failed with a 400 every time — and
 * rejects a system message anywhere but first. So, for every request, in one
 * place: a later system message is folded into the first, and a request with
 * no user turn gets a minimal one at the end. A request that is already fine
 * is returned as it is (the same array).
 */
export function withUserTurn<M extends { role: string; content: string }>(messages: M[]): M[] {
  let out = messages;
  if (out.some((m, i) => i > 0 && m.role === 'system')) {
    const extra = out.filter((m, i) => i > 0 && m.role === 'system').map(m => m.content);
    const rest = out.filter((m, i) => i === 0 || m.role !== 'system');
    out = rest[0]?.role === 'system'
      ? [{ ...rest[0], content: [rest[0].content, ...extra].join('\n\n') }, ...rest.slice(1)]
      : [{ ...(out.find((m, i) => i > 0 && m.role === 'system')!), content: extra.join('\n\n') }, ...rest];
  }
  if (!out.some(m => m.role === 'user')) {
    console.warn(`[llm-client] request had no user turn (roles: ${out.map(m => m.role).join(', ') || 'none'}); added "${MINIMAL_USER_TURN}"`);
    out = [...out, { role: 'user', content: MINIMAL_USER_TURN } as M];
  }
  return out;
}

/**
 * One POST to the proxy (with fetchWithRetry's transport retries) and the
 * cleaned reply. A cancelled call rejects with LlmAbortError.
 */
async function requestCompletion(opts: {
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  maxTokens: number;
  timeout: number;
  signal: AbortSignal | null;
  frequencyPenalty?: number;
  presencePenalty?: number;
}): Promise<Completion> {
  const { signal } = opts;
  if (signal?.aborted) throw new LlmAbortError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout);
  const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  try {
    const response = await fetchWithRetry(`${LLM_PROXY_URL}/api/llm/think`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Game': 'whispers',
      },
      body: JSON.stringify({
        messages: withUserTurn(opts.messages),
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        // Sent for a proxy that forwards them; today's game proxy drops them.
        ...(opts.frequencyPenalty !== undefined ? { frequency_penalty: opts.frequencyPenalty } : {}),
        ...(opts.presencePenalty !== undefined ? { presence_penalty: opts.presencePenalty } : {}),
      }),
      signal: requestSignal,
    });

    if (!response.ok) throw new Error(`LLM proxy returned ${response.status}`);

    const data = await response.json();
    const raw: string = (data?.text?.trim() ?? data?.choices?.[0]?.message?.content?.trim() ?? '') as string;
    return { text: cleanReplyText(raw), finishReason: extractFinishReason(data) };
  } catch (e) {
    if (signal?.aborted) throw new LlmAbortError();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function callLlm<S extends z.ZodType | undefined = undefined>(
  opts: CallLlmOpts<S>
): Promise<CallLlmResult<S>> {
  const { messages, schema, temperature, timeout = DEFAULT_TIMEOUT, maxTokens = DEFAULT_MAX_TOKENS } = opts;
  const signal = opts.signal ?? ambientSignal.getStore()?.() ?? null;
  const maxAttempts = schema ? 4 : 1;
  let lastBadResponse = '';
  // A reply that ran out of tokens gets ONE more try at a larger budget —
  // the same prompt, not the "that was not valid JSON" correction, because
  // nothing was wrong with it except where it stopped.
  let budget = maxTokens;
  let budgetRaised = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Every attempt, not just the first: the schema retries below `continue`
    // straight past the catch, and an abort landing between attempts must
    // still stop the next one from being sent.
    if (signal?.aborted) throw new LlmAbortError();
    const canRetry = attempt < maxAttempts - 1;

    try {
      let promptMessages: Array<{ role: string; content: string }>;
      if (attempt > 0 && lastBadResponse) {
        const isRoleplay = lastBadResponse.startsWith('*') || (!lastBadResponse.includes('{') && lastBadResponse.length < 100);
        if (isRoleplay) {
          const jsonPrefix = 'CRITICAL: You are a JSON API. Output ONLY a raw JSON object. No asterisks, no roleplay actions, no prose, no markdown. Start your response with { and end with }.\n\n';
          promptMessages = [
            { role: 'system', content: jsonPrefix + messages[0]!.content },
            ...messages.slice(1),
          ];
        } else {
          promptMessages = [
            ...messages,
            { role: 'assistant', content: lastBadResponse },
            { role: 'user', content: 'That was not valid JSON. You MUST respond with ONLY a raw JSON object matching the requested schema. No prose, no roleplay, no markdown fences, no narration. Output the JSON object and nothing else.' },
          ];
        }
      } else {
        promptMessages = messages;
      }

      const retryTemp = attempt > 0 ? Math.max(0.2, (temperature ?? 0.7) - attempt * 0.15) : (temperature ?? 0.7);

      const completion = await requestCompletion({ messages: promptMessages, temperature: retryTemp, maxTokens: budget, timeout, signal, frequencyPenalty: opts.frequencyPenalty, presencePenalty: opts.presencePenalty });
      const text = completion.text;
      const cutOff = hitTokenLimit(completion);
      if (cutOff) console.warn(`[llm-client] reply stopped at max_tokens=${budget} (finish_reason=${completion.finishReason})`);

      if (!schema) return text as CallLlmResult<S>;

      if (!text) {
        if (cutOff && !budgetRaised && canRetry) {
          budgetRaised = true;
          budget = growTokenBudget(budget);
          lastBadResponse = '';
          continue;
        }
        lastBadResponse = '(empty response after stripping thinking tags and markers)';
        if (canRetry) continue;
        throw new Error('LLM returned empty response after stripping thinking tags and markers');
      }

      const repaired = tryRepairJson(text);
      if (!repaired) {
        lastBadResponse = text;
        if (canRetry) continue;
        throw new Error(`LLM returned non-JSON: ${text.slice(0, 200)}`);
      }

      if ((cutOff || repaired.truncated) && !budgetRaised && canRetry) {
        console.warn(`[llm-client] JSON reply was cut off at max_tokens=${budget}; retrying with ${growTokenBudget(budget)}`);
        budgetRaised = true;
        budget = growTokenBudget(budget);
        lastBadResponse = '';
        continue;
      }

      const parsed = JSON.parse(repaired.json);
      try {
        const validated = schema.parse(parsed);
        return validated as CallLlmResult<S>;
      } catch (zodErr: any) {
        const zodIssues = zodErr.issues?.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ') ?? '';
        console.error('[llm-client] JSON parsed but Zod rejected:', zodIssues || JSON.stringify(parsed).slice(0, 300));
        lastBadResponse = `${repaired.json}\n\nValidation errors: ${zodIssues}`;
        if (!canRetry) throw zodErr;
        continue;
      }
    } catch (e) {
      // Checked first: a cancelled call must not burn its remaining retries.
      if (signal?.aborted || isLlmAbort(e)) throw new LlmAbortError();
      if (!canRetry) throw e;
      if (!lastBadResponse) lastBadResponse = String(e);
    }
  }
  throw new Error('LLM call failed after retries');
}

/**
 * Player-facing prose (the world introduction, the epilogue, closing
 * reflections, a plain-text scene summary): never shown cut off mid-sentence.
 *
 * A reply the provider stopped for length, or one that does not end the way
 * finished prose ends (terminal punctuation or a closing quote), or an empty
 * or marker-only one (reasoning ate the whole budget), is retried once with a
 * larger budget. If that is still cut off, the longer of the two is trimmed
 * back to its last complete sentence — possibly to '' when there is none,
 * which every caller already treats as "no text".
 */
export async function callProse(opts: Omit<CallLlmOpts<undefined>, 'schema'> & { retryMaxTokens?: number }): Promise<string> {
  const signal = opts.signal ?? ambientSignal.getStore()?.() ?? null;
  const base = {
    messages: opts.messages,
    temperature: opts.temperature ?? 0.7,
    timeout: opts.timeout ?? DEFAULT_TIMEOUT,
    signal,
    frequencyPenalty: opts.frequencyPenalty,
    presencePenalty: opts.presencePenalty,
  };
  const firstBudget = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const looksCutOff = (c: Completion) => hitTokenLimit(c) || isMarkerOnly(c.text) || !endsCleanly(c.text);

  const first = await requestCompletion({ ...base, maxTokens: firstBudget });
  if (!looksCutOff(first)) return first.text;

  const retryBudget = opts.retryMaxTokens ?? growTokenBudget(firstBudget);
  console.warn(`[llm-client] prose reply looks cut off at max_tokens=${firstBudget} (finish_reason=${first.finishReason ?? 'n/a'}, ${first.text.length} chars); retrying with ${retryBudget}`);
  let best = first;
  try {
    const second = await requestCompletion({ ...base, maxTokens: retryBudget });
    if (!looksCutOff(second)) return second.text;
    if (second.text.length > best.text.length || isMarkerOnly(best.text)) best = second;
  } catch (e) {
    if (isLlmAbort(e)) throw e;
    console.error('[llm-client] prose retry failed; trimming the first reply instead:', e);
  }
  if (isMarkerOnly(best.text)) return '';
  const trimmed = trimToLastSentence(best.text);
  console.warn(`[llm-client] prose still cut off after retry; trimmed ${best.text.length} -> ${trimmed.length} chars`);
  return trimmed;
}
