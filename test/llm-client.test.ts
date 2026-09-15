import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

/**
 * callLlm reads LLM_PROXY_URL at MODULE-IMPORT time (same reasoning as
 * PORT/DATA_DIR in test/lib/server-harness.ts), so this stub must be up and
 * the env var set before the dynamic import below.
 */
let server: Server;
let nextText = '';
let lastRequestBody: any = null;

async function startStub(): Promise<string> {
  return new Promise((resolve) => {
    server = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { lastRequestBody = JSON.parse(body); } catch { lastRequestBody = null; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: nextText }));
      });
    });
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://localhost:${port}`);
    });
  });
}

let callLlm: typeof import('../src/server/agents/llm-client.js').callLlm;

beforeAll(async () => {
  const url = await startStub();
  process.env.LLM_PROXY_URL = url;
  ({ callLlm } = await import('../src/server/agents/llm-client.js'));
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('callLlm marker/fence stripping applies to schema-less responses too', () => {
  // The live bug: introduceWorld (and every other free-prose call — negotiation
  // replies, the epilogue, character closing reflections, summarizeScene's
  // fallback) call callLlm with no `schema`. Roleplay-marker and code-fence
  // stripping used to be gated on `schema` being present, so a stray
  // "*thinks quietly*" the model prepended to an otherwise-fine introduction
  // rode straight through to the stored/broadcast text, permanently — the
  // introduction turn is generated once and never regenerated.
  it('strips a leading roleplay marker from a schema-less response', async () => {
    nextText = '*thinks quietly* The lamp has been lit every night for thirty years.';
    const result = await callLlm({ messages: [{ role: 'user', content: 'Introduce them to this world.' }] });
    expect(result).not.toContain('*thinks quietly*');
    expect(result).toContain('The lamp has been lit every night for thirty years.');
  });

  it('strips a trailing roleplay marker from a schema-less response', async () => {
    nextText = 'The lamp has been lit every night for thirty years. *falls silent*';
    const result = await callLlm({ messages: [{ role: 'user', content: 'Introduce them to this world.' }] });
    expect(result).not.toContain('*falls silent*');
    expect(result).toContain('The lamp has been lit every night for thirty years.');
  });

  it('leaves an ordinary schema-less response untouched', async () => {
    nextText = 'A quiet coastal town holds its breath.';
    const result = await callLlm({ messages: [{ role: 'user', content: 'Introduce them to this world.' }] });
    expect(result).toBe('A quiet coastal town holds its breath.');
  });

  // C12: the trailing-marker strip's regex (`/\s*\*[^*]*\*$/`) does not
  // distinguish a single-asterisk *action* marker from the closing "**" of
  // markdown bold. Against "He nodded. **Finally.**" it matches only the
  // last two characters as an empty-content *[^*]* pair (there is no
  // asterisk between them to require content), stripping the closing "**"
  // and leaving an unbalanced "**Finally." for players to read.
  it('does not mangle a balanced **bold** run at the end of a line', async () => {
    nextText = 'He nodded. **Finally.**';
    const result = await callLlm({ messages: [{ role: 'user', content: 'Narrate.' }] });
    expect(result).toBe('He nodded. **Finally.**');
  });

  it('does not mangle a balanced **bold** run at the start of a line', async () => {
    nextText = '**Finally.** He nodded.';
    const result = await callLlm({ messages: [{ role: 'user', content: 'Narrate.' }] });
    expect(result).toBe('**Finally.** He nodded.');
  });

  it('still strips a genuine trailing *action* marker next to real prose', async () => {
    nextText = 'The door creaks open. *he steps back*';
    const result = await callLlm({ messages: [{ role: 'user', content: 'Narrate.' }] });
    expect(result).toBe('The door creaks open.');
  });

  it('strips a trailing action marker while leaving earlier **bold** intact (mixed text)', async () => {
    nextText = '**Bold text** and then *he smiles*';
    const result = await callLlm({ messages: [{ role: 'user', content: 'Narrate.' }] });
    expect(result).toBe('**Bold text** and then');
  });
});

// Task 12, Finding D: widening marker/fence stripping to every response
// (not just JSON ones — see the describe block above) made it reachable
// on far more paths for a NEW failure: a response that is ENTIRELY
// marker-wrapped text strips to nothing, and for a schema-required call
// that manufactured empty string was then thrown as "LLM returned empty
// response after stripping markers" — discarding real model output over
// cosmetic wrapping. Observed live as "Character validation failed —
// please try again."
describe('callLlm never manufactures an empty response by stripping markers', () => {
  it('falls back to the unstripped text — and still finds the JSON inside it — instead of throwing, for a schema-required call', async () => {
    // The whole reply is one marker pair wrapped around otherwise-valid
    // JSON, so LEADING_ACTION_MARKER's `^\*...\*` consumes the entire
    // string in one match, stripping to ''. Before the fix, that empty
    // string was schema-required, so callLlm threw immediately. After the
    // fix, it falls back to this original, unstripped text — which
    // tryRepairJson can still find and parse a JSON object inside despite
    // the leftover asterisks, so the call succeeds instead of failing the
    // action outright.
    nextText = '*{"ok":true}*';
    const result = await callLlm({
      messages: [{ role: 'user', content: 'Validate.' }],
      schema: z.object({ ok: z.boolean() }),
    });
    expect(result).toEqual({ ok: true });
  });

  it('leaves an ordinary schema-required JSON response untouched', async () => {
    nextText = '{"ok":true}';
    const result = await callLlm({
      messages: [{ role: 'user', content: 'Validate.' }],
      schema: z.object({ ok: z.boolean() }),
    });
    expect(result).toEqual({ ok: true });
  });
});

// The class of bug this guards against: `max_tokens` used to be omitted
// entirely from the request body whenever a caller passed no `maxTokens`,
// which let the proxy apply whatever default IT happened to have — silently,
// with no error. That has truncated draftWorldSeed (never validated, host
// could never open their table), setupChat (desynced the readiness panel),
// and introduceWorld (the player's first prose cut off mid-sentence). Three
// separate one-off patches later, the fix is structural: callLlm must always
// send `max_tokens`, including — especially — when the caller sends nothing.
// A future call site that forgets `maxTokens` should inherit a real ceiling
// automatically instead of reintroducing this bug a fourth time.
describe('callLlm always sends max_tokens, even when the caller omits it', () => {
  it('includes max_tokens in the request body when the caller passes an explicit value', async () => {
    nextText = 'fine';
    lastRequestBody = null;
    await callLlm({ messages: [{ role: 'user', content: 'Hi.' }], maxTokens: 777 });
    expect(lastRequestBody).not.toBeNull();
    expect(lastRequestBody.max_tokens).toBe(777);
  });

  it('still includes a numeric max_tokens when the caller omits maxTokens entirely', async () => {
    nextText = 'fine';
    lastRequestBody = null;
    await callLlm({ messages: [{ role: 'user', content: 'Introduce them to this world.' }] });
    expect(lastRequestBody).not.toBeNull();
    expect(typeof lastRequestBody.max_tokens).toBe('number');
    expect(lastRequestBody.max_tokens).toBeGreaterThan(0);
  });
});
