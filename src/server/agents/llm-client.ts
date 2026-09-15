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
}

type CallLlmResult<S> = S extends z.ZodTypeAny ? z.output<S> : string;

function tryRepairJson(text: string): string | null {
  let candidate = text.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try { JSON.parse(candidate); return candidate; } catch {}
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
  for (const ch of fragment) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braces++;
    if (ch === '}') braces--;
    if (ch === '[') brackets++;
    if (ch === ']') brackets--;
  }
  // Close any unterminated string
  if (inString) fragment += '"';
  while (brackets > 0) { fragment += ']'; brackets--; }
  while (braces > 0) { fragment += '}'; braces--; }

  try { JSON.parse(fragment); return fragment; } catch { return null; }
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
    await new Promise(r => setTimeout(r, backoffMs));
  }
  throw new Error('unreachable');
}

export async function callLlm<S extends z.ZodType | undefined = undefined>(
  opts: CallLlmOpts<S>
): Promise<CallLlmResult<S>> {
  const { messages, schema, temperature, timeout = DEFAULT_TIMEOUT, maxTokens = DEFAULT_MAX_TOKENS } = opts;
  const maxAttempts = schema ? 4 : 1;
  let lastBadResponse = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

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

      const response = await fetchWithRetry(`${LLM_PROXY_URL}/api/llm/think`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Game': 'whispers',
        },
        body: JSON.stringify({ messages: promptMessages, temperature: retryTemp, max_tokens: maxTokens }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`LLM proxy returned ${response.status}`);

      const data = await response.json();
      let text: string = (data?.text?.trim() ?? data?.choices?.[0]?.message?.content?.trim() ?? '') as string;

      // Strip Qwen3 thinking tags (closed or unclosed at end of output)
      text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
      if (text.startsWith('<think>')) text = '';

      if (schema && !text) {
        lastBadResponse = '(empty response after stripping thinking tags)';
        if (attempt < maxAttempts - 1) continue;
        throw new Error('LLM returned empty response after stripping thinking tags');
      }

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

      if (schema && !text) {
        lastBadResponse = '(empty response after stripping roleplay/fence markers)';
        if (attempt < maxAttempts - 1) continue;
        throw new Error('LLM returned empty response after stripping markers');
      }

      if (!schema) return text as CallLlmResult<S>;

      const repaired = tryRepairJson(text);
      if (!repaired) {
        lastBadResponse = text;
        if (attempt < maxAttempts - 1) continue;
        throw new Error(`LLM returned non-JSON: ${text.slice(0, 200)}`);
      }

      const parsed = JSON.parse(repaired);
      try {
        const validated = schema.parse(parsed);
        return validated as CallLlmResult<S>;
      } catch (zodErr: any) {
        const zodIssues = zodErr.issues?.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ') ?? '';
        console.error('[llm-client] JSON parsed but Zod rejected:', zodIssues || JSON.stringify(parsed).slice(0, 300));
        lastBadResponse = `${repaired}\n\nValidation errors: ${zodIssues}`;
        if (attempt >= maxAttempts - 1) throw zodErr;
        continue;
      }
    } catch (e) {
      if (attempt >= maxAttempts - 1) throw e;
      if (!lastBadResponse) lastBadResponse = String(e);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('LLM call failed after retries');
}
