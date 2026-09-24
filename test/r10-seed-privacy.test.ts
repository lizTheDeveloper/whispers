// Round 10, live finding 2 (N7RQZ7 / R6KXDU): the world card hid NPC motives
// and plot hooks from a host who plays or asked for no spoilers, but the
// world-seed-draft frame carried them — devtools showed Luma "burying the
// truth about the recent 'incidents' under a mountain of paperwork". The
// server now never sends them to that host, on any message, while keeping
// the full seed for the DM.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { WebSocket } from 'ws';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, LLM_STUB_REPLIES, type Harness } from './lib/server-harness.js';

let harness: Harness;
beforeAll(async () => { harness = await startHarness(); }, 30_000);
afterAll(async () => { await harness.stop(); });

const SEED = LLM_STUB_REPLIES.worldSeed;
const SECRETS = [...SEED.plotHooks, ...SEED.npcs.map(n => n.motivation)];

/** Every frame this socket receives, raw. */
function recordFrames(ws: WebSocket): string[] {
  const frames: string[] = [];
  ws.on('message', (data: Buffer) => frames.push(data.toString()));
  return frames;
}

function leaks(frames: string[]): string[] {
  return SECRETS.filter(secret => frames.some(f => f.includes(JSON.stringify(secret).slice(1, -1))));
}

async function createHost(role: 'dm' | 'player' | null, firstLine: string) {
  const ws = await connectWs(harness.port);
  const frames = recordFrames(ws);
  const q = new MessageQueue(ws);
  sendMsg(ws, { type: 'create', name: 'Seed Privacy', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
  const joined = await q.waitFor('room-joined', 10_000) as any;
  await q.waitFor('dm-chat-reply', 10_000); // the DM's greeting
  if (role) {
    sendMsg(ws, { type: 'choose-table-role', role } as any);
    await q.waitFor('room-joined', 10_000);
  }
  sendMsg(ws, { type: 'dm-chat', text: firstLine });
  const draft = await q.waitFor('world-seed-draft', 20_000) as any;
  return { ws, q, frames, joined, draft };
}

function close(ws: WebSocket): Promise<void> {
  return new Promise(r => { ws.once('close', () => r()); ws.close(); });
}

describe('the seed a spoiler-free host is sent', () => {
  it('a playing host: no plot hook or motive in any frame — draft, accept, rejoin; the world still opens with them', async () => {
    const { ws, q, frames, joined, draft } = await createHost('player', "I'm playing in this one, so please no spoilers for me — surprise me. A haunted lighthouse, spooky but hopeful.");
    // What the card shows is there…
    expect(draft.seed.premise).toBe(SEED.premise);
    expect(draft.seed.npcs.map((n: any) => n.name)).toEqual(SEED.npcs.map(n => n.name));
    expect(draft.seed.npcs[0].description).toBe(SEED.npcs[0]!.description);
    expect(draft.seed.npcs[0].disposition).toBe(SEED.npcs[0]!.disposition);
    // …and the secrets are not.
    expect(draft.seed.plotHooks).toEqual([]);
    expect(draft.seed.npcs.every((n: any) => n.motivation === null)).toBe(true);

    // Accepting the copy they were sent opens the table: the server put the
    // withheld hooks back (the checklist needs at least one).
    sendMsg(ws, { type: 'accept-world-seed', seed: draft.seed } as any);
    let phase: any;
    do { phase = await q.waitFor('phase-change', 15_000); } while (phase.phase !== 'character-creation');
    expect(leaks(frames)).toEqual([]);

    // A rejoin replays the seed, the settings and the lobby: still nothing.
    const again = await connectWs(harness.port);
    const againFrames = recordFrames(again);
    const aq = new MessageQueue(again);
    sendMsg(again, { type: 'rejoin', joinCode: joined.joinCode, sessionToken: joined.sessionToken });
    const replayed = await aq.waitFor('world-seed-draft', 10_000) as any;
    expect(replayed.accepted).toBe(true);
    expect(replayed.seed.plotHooks).toEqual([]);
    await aq.waitFor('lobby-state', 10_000);
    expect(leaks(againFrames)).toEqual([]);
    await close(again);
    await close(ws);
  }, 60_000);

  it('a DM host who asked for no spoilers: stripped too', async () => {
    const { ws, frames, draft } = await createHost('dm', "I'm not playing — I'm running this for my friends. Please, no spoilers for me: a haunted lighthouse, spooky but hopeful.");
    expect(draft.seed.plotHooks).toEqual([]);
    expect(leaks(frames)).toEqual([]);
    await close(ws);
  }, 60_000);

  it('a DM host who did not ask sees the whole world', async () => {
    const { ws, draft } = await createHost('dm', 'A haunted lighthouse, spooky but hopeful.');
    expect(draft.seed.plotHooks).toEqual(SEED.plotHooks);
    expect(draft.seed.npcs.map((n: any) => n.motivation)).toEqual(SEED.npcs.map(n => n.motivation));
    await close(ws);
  }, 60_000);
});
