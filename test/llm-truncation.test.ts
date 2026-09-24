import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

/**
 * Replies cut off mid-sentence, seen live: the End Game epilogue stopped at
 * "...and the distant toll of the great clock", the world introduction at
 * "...twirls a feathered hat that blushes", an interview opener at "...You
 * glance toward". The model behind the proxy reasons before it writes, and
 * the reasoning spends the same max_tokens budget.
 *
 * The stub answers each request with the next queued reply and records the
 * max_tokens every request asked for.
 */
let server: Server;
let queue: Array<{ text: string; finish_reason?: string }> = [];
let budgets: number[] = [];

function startStub(): Promise<string> {
  return new Promise((resolve) => {
    server = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        budgets.push(JSON.parse(body).max_tokens);
        const next = queue.shift() ?? { text: 'Out of replies.' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(next));
      });
    });
    server.listen(0, () => resolve(`http://localhost:${(server.address() as AddressInfo).port}`));
  });
}

let llm: typeof import('../src/server/agents/llm-client.js');

beforeAll(async () => {
  process.env.LLM_PROXY_URL = await startStub();
  llm = await import('../src/server/agents/llm-client.js');
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { queue = []; budgets = []; });

const msgs = [{ role: 'user', content: 'Write the epilogue.' }];
const CUT = 'The lamp guttered as the last bell faded. Maren closed the ledger, and the distant toll of the great clock';
const FULL = 'The lamp guttered as the last bell faded. Maren closed the ledger and did not look back.';

describe('callProse: player-facing prose is never shown cut off', () => {
  it('retries a reply with no terminal punctuation at a larger budget and returns the finished one', async () => {
    queue = [{ text: CUT }, { text: FULL }];
    const text = await llm.callProse({ messages: msgs, maxTokens: 3072 });
    expect(text).toBe(FULL);
    expect(budgets).toHaveLength(2);
    expect(budgets[1]).toBeGreaterThan(budgets[0]!);
    expect(budgets[0]).toBe(3072);
  });

  it('retries when the provider reports finish_reason "length", even if the text happens to end on a period', async () => {
    queue = [{ text: 'The lamp guttered.', finish_reason: 'length' }, { text: FULL, finish_reason: 'stop' }];
    const text = await llm.callProse({ messages: msgs, maxTokens: 1000 });
    expect(text).toBe(FULL);
    expect(budgets).toEqual([1000, 2024]);
  });

  it('retries an empty or marker-only reply (reasoning ate the budget; the proxy says "*thinks quietly*")', async () => {
    queue = [{ text: '*thinks quietly*' }, { text: FULL }];
    expect(await llm.callProse({ messages: msgs, maxTokens: 512 })).toBe(FULL);
    expect(budgets).toHaveLength(2);
  });

  it('trims back to the last complete sentence when the retry is cut off too', async () => {
    queue = [{ text: CUT }, { text: `${CUT} and the` }];
    const text = await llm.callProse({ messages: msgs, maxTokens: 512 });
    expect(text).toBe('The lamp guttered as the last bell faded.');
    expect(llm.endsCleanly(text)).toBe(true);
  });

  it('returns "" rather than a half sentence when there is no complete sentence at all', async () => {
    queue = [{ text: 'Jolly de Sombra twirls a feathered hat that blushes' }, { text: 'Jolly de Sombra twirls a feathered' }];
    expect(await llm.callProse({ messages: msgs, maxTokens: 512 })).toBe('');
  });

  it('does not retry a finished reply', async () => {
    queue = [{ text: FULL }];
    expect(await llm.callProse({ messages: msgs, maxTokens: 3072 })).toBe(FULL);
    expect(budgets).toEqual([3072]);
  });

  it('counts a closing quote as a finished ending', async () => {
    queue = [{ text: 'Maren looks up. "Not tonight"' }];
    expect(await llm.callProse({ messages: msgs })).toBe('Maren looks up. "Not tonight"');
    expect(budgets).toHaveLength(1);
  });
});

describe('trimToLastSentence', () => {
  it('closes a quotation the cut leaves open', () => {
    expect(llm.trimToLastSentence('She says, "Run. Now we')).toBe('She says, "Run."');
  });
  it('does not treat a decimal point as a sentence end', () => {
    expect(llm.trimToLastSentence('It weighs 3.5 stone. The scale tips toward')).toBe('It weighs 3.5 stone.');
  });
});

describe('callLlm with a schema: a cut-off JSON reply', () => {
  const Schema = z.object({ reply: z.string().min(1), definition: z.object({ name: z.string() }).nullable().default(null) });

  it('is retried once at a larger budget, with the same prompt', async () => {
    queue = [
      { text: '{"reply": "You stand on the tidal stair. You glance toward' },
      { text: '{"reply": "You stand on the tidal stair. What makes you stop?", "definition": {"name": "Liz"}}' },
    ];
    const out = await llm.callLlm({ messages: msgs, schema: Schema, maxTokens: 2048 });
    expect(out.reply).toBe('You stand on the tidal stair. What makes you stop?');
    expect(out.definition?.name).toBe('Liz');
    expect(budgets).toEqual([2048, 4096]);
  });

  it('is retried when finish_reason is "length" even though the repaired JSON parses', async () => {
    queue = [
      { text: '{"reply": "Short."}', finish_reason: 'length' },
      { text: '{"reply": "Short and finished."}' },
    ];
    const out = await llm.callLlm({ messages: msgs, schema: Schema, maxTokens: 1000 });
    expect(out.reply).toBe('Short and finished.');
    expect(budgets).toEqual([1000, 2024]);
  });

  it('when still cut off, keeps the string value only up to its last complete sentence', async () => {
    queue = [
      { text: '{"reply": "You stand on the tidal stair. You glance toward' },
      { text: '{"reply": "You stand on the tidal stair. The water is rising. You glance toward' },
    ];
    const out = await llm.callLlm({ messages: msgs, schema: Schema, maxTokens: 2048 });
    expect(out.reply).toBe('You stand on the tidal stair. The water is rising.');
    expect(budgets).toHaveLength(2);
  });

  it('does not retry a complete JSON reply', async () => {
    queue = [{ text: '{"reply": "What makes you stop?", "definition": null}' }];
    await llm.callLlm({ messages: msgs, schema: Schema, maxTokens: 2048 });
    expect(budgets).toEqual([2048]);
  });
});
