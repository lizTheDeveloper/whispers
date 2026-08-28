import type { z } from 'zod';

const LLM_PROXY_URL = process.env.LLM_PROXY_URL ?? 'http://localhost:4242';
const DEFAULT_TIMEOUT = 15_000;

interface CallLlmOpts<S extends z.ZodType | undefined = undefined> {
  messages: Array<{ role: string; content: string }>;
  schema?: S;
  temperature?: number;
  timeout?: number;
}

type CallLlmResult<S> = S extends z.ZodType<infer T> ? T : string;

export async function callLlm<S extends z.ZodType | undefined = undefined>(
  opts: CallLlmOpts<S>
): Promise<CallLlmResult<S>> {
  const { messages, schema, temperature, timeout = DEFAULT_TIMEOUT } = opts;
  const maxAttempts = schema ? 2 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const promptMessages = attempt > 0
        ? [...messages, { role: 'system', content: 'Your previous response was not valid JSON. Respond with ONLY a JSON object matching the requested schema, no other text.' }]
        : messages;

      const response = await fetch(`${LLM_PROXY_URL}/api/llm/think`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Game': 'whispers',
        },
        body: JSON.stringify({ messages: promptMessages, temperature: temperature ?? 0.7 }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`LLM proxy returned ${response.status}`);

      const data = await response.json();
      const text: string = (data?.text?.trim() ?? data?.choices?.[0]?.message?.content?.trim() ?? '') as string;

      if (!schema) return text as CallLlmResult<S>;

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        if (attempt < maxAttempts - 1) continue;
        throw new Error(`LLM returned non-JSON: ${text.slice(0, 200)}`);
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const validated = schema.parse(parsed);
      return validated as CallLlmResult<S>;
    } catch (e) {
      if (attempt >= maxAttempts - 1) throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('LLM call failed after retries');
}
