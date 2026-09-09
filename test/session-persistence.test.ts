import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { getFreePort, connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import type { CharacterDefinition } from '../src/shared/types.js';

let llmStub: Server;
let gameServer: { server: Server };
let port: number;
let dataDir: string;

const CHAR: CharacterDefinition = {
  name: 'Vex Ashgrove',
  backstory: 'Raised by cartographers on a dying moon.',
  personality: 'Curious, stubborn, allergic to authority.',
  highConcept: 'Runaway Star-Cartographer',
  trouble: 'Owes a debt to the Ledger Cult',
  aspects: ['Maps are promises', 'Never look back'],
  skills: { Notice: 3, Lore: 2, Will: 1 },
  stunts: ['Dead Reckoning: +2 to Notice when navigating.'],
};

/** Canned LLM proxy so these tests are deterministic and offline. */
function startLlmStub(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let text: string;
        if (body.includes('character sheet validation API')) {
          text = JSON.stringify({ approved: true, feedback: 'Solid sheet.', modifications: null });
        } else if (body.includes('helping set up a new game')) {
          text = JSON.stringify({ reply: 'What kind of game are we running?', done: false, dmInstructions: null, dmCustomPrompt: null });
        } else {
          text = 'Understood. Lets keep moving.';
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));
      });
    });
    server.listen(0, () => {
      const { port: p } = server.address() as { port: number };
      resolve({ server, url: `http://localhost:${p}` });
    });
  });
}

beforeAll(async () => {
  const stub = await startLlmStub();
  llmStub = stub.server;
  process.env.LLM_PROXY_URL = stub.url;
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-session-'));
  process.env.DATA_DIR = dataDir;
  port = await getFreePort();
  process.env.PORT = String(port);

  gameServer = await import('../src/server/index.js');
  if (!gameServer.server.listening) {
    await new Promise<void>((r) => gameServer.server.once('listening', () => r()));
  }
}, 30_000);

afterAll(async () => {
  await new Promise<void>((r) => gameServer.server.close(() => r()));
  await new Promise<void>((r) => llmStub.close(() => r()));
  rmSync(dataDir, { recursive: true, force: true });
});

async function createGame() {
  const ws = await connectWs(port);
  const q = new MessageQueue(ws);
  sendMsg(ws, { type: 'create', name: 'Refresh Test', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
  const joined = await q.waitFor('room-joined', 10_000) as any;
  return { ws, q, joined };
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((r) => { ws.once('close', () => r()); ws.close(); });
}

describe('DM session survives a page refresh', () => {
  it('hands the host a session token it can come back with', async () => {
    const { ws, joined } = await createGame();
    expect(joined.isHost).toBe(true);
    expect(typeof joined.sessionToken).toBe('string');
    expect((joined.sessionToken as string).length).toBeGreaterThan(16);
    await closeWs(ws);
  }, 20_000);

  it('restores host role on rejoin after the socket is gone (refresh)', async () => {
    const { ws, joined } = await createGame();
    const { joinCode, sessionToken } = joined;
    await closeWs(ws);

    const ws2 = await connectWs(port);
    const q2 = new MessageQueue(ws2);
    sendMsg(ws2, { type: 'rejoin', joinCode, sessionToken } as any);
    const rejoined = await q2.waitFor('room-joined', 10_000) as any;

    expect(rejoined.isHost).toBe(true);
    expect(rejoined.joinCode).toBe(joinCode);
    await closeWs(ws2);
  }, 20_000);

  it('re-sends DM lobby state (upload token) so the DM screen is usable again', async () => {
    const { ws, joined } = await createGame();
    const { joinCode, sessionToken } = joined;
    await closeWs(ws);

    const ws2 = await connectWs(port);
    const q2 = new MessageQueue(ws2);
    sendMsg(ws2, { type: 'rejoin', joinCode, sessionToken } as any);
    const settings = await q2.waitFor('dm-settings', 10_000) as any;
    expect(typeof settings.uploadToken).toBe('string');
    await closeWs(ws2);
  }, 20_000);
});

describe('Character submissions reach the DM even if the DM is away', () => {
  it('surfaces a character submitted while the host is disconnected once the host returns', async () => {
    const { ws: hostWs, joined } = await createGame();
    const { joinCode, sessionToken } = joined;

    // DM refreshes / drops off.
    await closeWs(hostWs);

    // Player joins and submits while no host socket exists.
    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Liz' });
    await pq.waitFor('room-joined', 10_000);
    sendMsg(playerWs, { type: 'submit-character', definition: CHAR });
    const validated = await pq.waitFor('character-validated', 20_000) as any;
    expect(validated.approved).toBe(true);

    // DM comes back — the pending submission must be waiting for them.
    const hostWs2 = await connectWs(port);
    const hq = new MessageQueue(hostWs2);
    sendMsg(hostWs2, { type: 'rejoin', joinCode, sessionToken } as any);
    const pending = await hq.waitFor('character-pending-review', 15_000) as any;

    expect(pending.playerName).toBe('Liz');
    expect(pending.definition.name).toBe(CHAR.name);

    await closeWs(playerWs);
    await closeWs(hostWs2);
  }, 40_000);

  it('lists players who joined while the host was away', async () => {
    const { ws: hostWs, joined } = await createGame();
    const { joinCode, sessionToken } = joined;
    await closeWs(hostWs);

    const playerWs = await connectWs(port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode, playerName: 'Wendy' });
    await pq.waitFor('room-joined', 10_000);

    const hostWs2 = await connectWs(port);
    const hq = new MessageQueue(hostWs2);
    sendMsg(hostWs2, { type: 'rejoin', joinCode, sessionToken } as any);
    const lobby = await hq.waitFor('lobby-state', 15_000) as any;
    expect(lobby.players).toContain('Wendy');

    await closeWs(playerWs);
    await closeWs(hostWs2);
  }, 30_000);
});
