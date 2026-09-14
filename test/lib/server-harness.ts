import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFreePort } from './ws-helpers.js';

export const LLM_STUB_REPLIES = {
  validation: { approved: true, feedback: 'Solid sheet.', modifications: null },
  setupOpen: { reply: 'What kind of game are we running?', done: false, dmInstructions: null, dmCustomPrompt: null },
  setupDone: { reply: 'Got it — I have what I need.', done: true, dmInstructions: 'A haunted lighthouse, spooky but hopeful.', dmCustomPrompt: 'You are running a haunted lighthouse game.' },
};

export interface Harness {
  port: number;
  stop(): Promise<void>;
}

/**
 * Boots the real server (src/server/index.ts) against a throwaway data dir and
 * a canned LLM proxy. The server reads PORT/DATA_DIR/LLM_PROXY_URL at import
 * time, so they must be set before the dynamic import below.
 */
export async function startHarness(): Promise<Harness> {
  const llm = await startLlmStub();
  process.env.LLM_PROXY_URL = llm.url;

  const dataDir = mkdtempSync(join(tmpdir(), 'whispers-test-'));
  process.env.DATA_DIR = dataDir;

  const port = await getFreePort();
  process.env.PORT = String(port);

  const mod = await import('../../src/server/index.js');
  if (!mod.server.listening) {
    await new Promise<void>((r) => mod.server.once('listening', () => r()));
  }

  return {
    port,
    async stop() {
      await new Promise<void>((r) => mod.server.close(() => r()));
      await new Promise<void>((r) => llm.server.close(() => r()));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * The host says "done" only after at least one message, so a test can drive a
 * campaign to "world set up" deterministically by sending exactly one dm-chat.
 */
function startLlmStub(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let text: string;
        if (body.includes('character sheet validation API')) {
          text = JSON.stringify(LLM_STUB_REPLIES.validation);
        } else if (body.includes('helping set up a new game')) {
          const hostSpoke = body.includes('"role":"user"');
          text = JSON.stringify(hostSpoke ? LLM_STUB_REPLIES.setupDone : LLM_STUB_REPLIES.setupOpen);
        } else {
          text = 'Understood. Lets keep moving.';
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));
      });
    });
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}
