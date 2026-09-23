// Pausing or ending a game must stop LLM spend NOW, not after the call in
// flight finishes and its retries run out. callLlm takes an AbortSignal
// (explicitly, or ambiently from runWithLlmSignal — how the game loop scopes
// every call its turn makes, including fire-and-forget memory extraction):
// an aborted signal rejects promptly and is never retried, where a timeout or
// a bad reply still is.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

let server: Server;
let requests = 0;
let mode: 'hang' | 'unavailable' = 'hang';

async function startStub(): Promise<string> {
  return new Promise((resolve) => {
    server = createHttpServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        requests++;
        if (mode === 'unavailable') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        // 'hang': answer only after any sane test has given up on us.
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: 'not json' }));
        }, 5_000);
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
afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
beforeEach(() => { requests = 0; mode = 'hang'; });

const Schema = z.object({ ok: z.boolean() });
const msgs = [{ role: 'system', content: 'You are a JSON API.' }, { role: 'user', content: 'go' }];

describe('callLlm abort signal', () => {
  it('an already-aborted signal rejects without sending anything', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(llm.callLlm({ messages: msgs, schema: Schema, signal: ctrl.signal })).rejects.toSatisfy(llm.isLlmAbort);
    expect(requests).toBe(0);
  });

  it('aborting mid-request rejects promptly and does not retry, even with schema retries available', async () => {
    const ctrl = new AbortController();
    const started = Date.now();
    const call = llm.callLlm({ messages: msgs, schema: Schema, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 150);
    await expect(call).rejects.toSatisfy(llm.isLlmAbort);
    expect(Date.now() - started).toBeLessThan(1_000);
    await new Promise(r => setTimeout(r, 300));
    expect(requests).toBe(1);
  });

  it('aborting during a 503 retry backoff rejects promptly with no further request', async () => {
    mode = 'unavailable';
    const ctrl = new AbortController();
    const started = Date.now();
    const call = llm.callLlm({ messages: msgs, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 200); // first backoff is 1s
    await expect(call).rejects.toSatisfy(llm.isLlmAbort);
    expect(Date.now() - started).toBeLessThan(900);
    await new Promise(r => setTimeout(r, 1_200));
    expect(requests).toBe(1);
  });

  it('picks up an ambient signal from runWithLlmSignal, and a null scope opts back out', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(llm.runWithLlmSignal(() => ctrl.signal, () => llm.callLlm({ messages: msgs })))
      .rejects.toSatisfy(llm.isLlmAbort);
    expect(requests).toBe(0);

    // The epilogue runs after stop() aborted the loop's signal; it opts out.
    const optedOut = llm.runWithLlmSignal(() => ctrl.signal, () =>
      llm.runWithLlmSignal(null, () => llm.callLlm({ messages: msgs, timeout: 200 })));
    await expect(optedOut).rejects.not.toSatisfy(llm.isLlmAbort);
    expect(requests).toBe(1);
  });

  it('a plain timeout is still a timeout, not an abort', async () => {
    const call = llm.callLlm({ messages: msgs, timeout: 100 });
    await expect(call).rejects.not.toSatisfy(llm.isLlmAbort);
  });
});
