import type { z } from 'zod';

const LLM_PROXY_URL = process.env.LLM_PROXY_URL ?? 'http://localhost:4242';
const DEFAULT_TIMEOUT = 60_000;

interface CallLlmOpts<S extends z.ZodType | undefined = undefined> {
  messages: Array<{ role: string; content: string }>;
  schema?: S;
  temperature?: number;
  timeout?: number;
  maxTokens?: number;
}

type CallLlmResult<S> = S extends z.ZodType<infer T> ? T : string;

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

export async function callLlm<S extends z.ZodType | undefined = undefined>(
  opts: CallLlmOpts<S>
): Promise<CallLlmResult<S>> {
  const { messages, schema, temperature, timeout = DEFAULT_TIMEOUT, maxTokens } = opts;
  const maxAttempts = schema ? 4 : 1;
  let lastBadResponse = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      let promptMessages: Array<{ role: string; content: string }>;
      if (attempt > 0 && lastBadResponse) {
        promptMessages = [
          ...messages,
          { role: 'assistant', content: lastBadResponse },
          { role: 'user', content: 'That was not valid JSON. You MUST respond with ONLY a raw JSON object matching the requested schema. No prose, no roleplay, no markdown fences, no narration. Output the JSON object and nothing else.' },
        ];
      } else {
        promptMessages = messages;
      }

      const retryTemp = attempt > 0 ? Math.max(0.2, (temperature ?? 0.7) - attempt * 0.15) : (temperature ?? 0.7);

      const response = await fetch(`${LLM_PROXY_URL}/api/llm/think`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Game': 'whispers',
        },
        body: JSON.stringify({ messages: promptMessages, temperature: retryTemp, ...(maxTokens ? { max_tokens: maxTokens } : {}) }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`LLM proxy returned ${response.status}`);

      const data = await response.json();
      const text: string = (data?.text?.trim() ?? data?.choices?.[0]?.message?.content?.trim() ?? '') as string;

      if (!schema) return text as CallLlmResult<S>;

      const repaired = tryRepairJson(text);
      if (!repaired) {
        lastBadResponse = text;
        if (attempt < maxAttempts - 1) continue;
        throw new Error(`LLM returned non-JSON: ${text.slice(0, 200)}`);
      }

      const parsed = JSON.parse(repaired);
      const validated = schema.parse(parsed);
      return validated as CallLlmResult<S>;
    } catch (e) {
      if (attempt >= maxAttempts - 1) throw e;
      if (!lastBadResponse) lastBadResponse = String(e);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('LLM call failed after retries');
}
