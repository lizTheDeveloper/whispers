import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';
import type { WebSocket } from 'ws';

// The DM lobby's Readiness panel lists what world setup still needs,
// including "Choose whether you are running this game or playing in it."
// choose-table-role used to answer with room-joined only, so after the host
// picked a seat the panel kept asking them to pick one until some unrelated
// update happened to refresh it.

let harness: Harness;
let port: number;

beforeAll(async () => { harness = await startHarness(); port = harness.port; }, 30_000);
afterAll(async () => { await harness.stop(); });

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((r) => { ws.once('close', () => r()); ws.close(); });
}

async function createGame() {
  const ws = await connectWs(port);
  const q = new MessageQueue(ws);
  sendMsg(ws, { type: 'create', name: 'Seat Readiness Test', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
  await q.waitFor('room-joined', 10_000);
  await q.waitFor('dm-chat-reply', 10_000); // the DM's opening greeting
  return { ws, q };
}

const SEAT_PROMPT = /running this game or playing in it/i;

describe('Choosing a table role refreshes world readiness', () => {
  for (const role of ['player', 'dm'] as const) {
    it(`sends readiness without the seat prompt after choosing '${role}'`, async () => {
      const { ws, q } = await createGame();

      sendMsg(ws, { type: 'choose-table-role', role });
      const joined = await q.waitFor('room-joined', 10_000) as any;
      expect(joined.tableRole).toBe(role);

      const update = await q.waitFor('world-readiness', 5_000) as any;
      expect(update.readiness.detail.join(' ')).not.toMatch(SEAT_PROMPT);
      expect(Array.isArray(update.influences)).toBe(true);

      await closeWs(ws);
    }, 30_000);
  }
});
