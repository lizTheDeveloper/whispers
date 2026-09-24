// Round 20 over the wire: the host sets the content rating from the lobby
// (or the setup chat, from the host's answer); every seat is told, with the
// system line; only the host may change it; a rejoin gets it back.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';

let harness: Harness;
beforeAll(async () => { harness = await startHarness(); }, 30_000);
afterAll(async () => { await harness?.stop(); });

async function hostTable() {
  const ws = await connectWs(harness.port);
  const q = new MessageQueue(ws);
  sendMsg(ws, { type: 'create', name: 'R20 rating', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
  const joined = await q.waitFor('room-joined', 10_000) as Extract<import('../src/shared/protocol.js').ServerMessage, { type: 'room-joined' }>;
  const first = await q.waitFor('content-rating', 10_000);
  await q.waitFor('dm-chat-reply', 10_000); // the greeting
  return { ws, q, joined, first };
}

describe('round 20: the rating over the wire', () => {
  it('a new adult table starts at the storybook default; the host sets it, everyone hears, and a rejoin gets it back', async () => {
    const host = await hostTable();
    expect(host.first).toEqual({ type: 'content-rating', rating: 'storybook', explicit: false, childPresent: false });

    const pws = await connectWs(harness.port);
    const pq = new MessageQueue(pws);
    sendMsg(pws, { type: 'join', joinCode: host.joined.joinCode, playerName: 'Ada' });
    await pq.waitFor('room-joined', 10_000);
    expect(await pq.waitFor('content-rating', 10_000)).toMatchObject({ rating: 'storybook', explicit: false });

    sendMsg(host.ws, { type: 'set-content-rating', rating: 'mature' });
    const told = { type: 'content-rating', rating: 'mature', explicit: true, childPresent: false, line: 'The host set the rating to Mature.' };
    expect(await host.q.waitFor('content-rating', 10_000)).toEqual(told);
    expect(await pq.waitFor('content-rating', 10_000)).toEqual(told);

    // A player cannot change it.
    sendMsg(pws, { type: 'set-content-rating', rating: 'gentle' });
    expect(await pq.waitFor('error', 10_000)).toMatchObject({ message: 'Only the host can change the rating.' });
    // Nor can anyone set a level that does not exist.
    sendMsg(host.ws, { type: 'set-content-rating', rating: 'R' as never });
    expect(await host.q.waitFor('error', 10_000)).toMatchObject({ message: 'That is not a rating this game has.' });

    const rws = await connectWs(harness.port);
    const rq = new MessageQueue(rws);
    sendMsg(rws, { type: 'rejoin', joinCode: host.joined.joinCode, sessionToken: host.joined.sessionToken });
    await rq.waitFor('room-joined', 10_000);
    expect(await rq.waitFor('content-rating', 10_000)).toEqual({ type: 'content-rating', rating: 'mature', explicit: true, childPresent: false });
    for (const w of [host.ws, pws, rws]) w.close();
  });

  it('the setup chat asks about intensity, and sets the rating from the host\'s answer', async () => {
    const host = await hostTable();
    const before = harness.receivedBodies.length;
    sendMsg(host.ws, { type: 'dm-chat', text: "Two old friends, a heist. Let's rate it Adventure." });
    await host.q.waitFor('dm-chat-reply', 10_000);
    const setup = harness.receivedBodies.slice(before).find(b => b.includes('helping set up a new game'))!;
    expect(setup).toContain('CONTENT RATING: this table is rated Storybook');
    expect(setup).toContain('ask how intense this should get');
    expect(await host.q.waitFor('content-rating', 10_000)).toEqual({ type: 'content-rating', rating: 'adventure', explicit: true, childPresent: false, line: 'The host set the rating to Adventure.' });
    host.ws.close();
  });

  it('a host who asks for gentle peril gets the gentle default, told once', async () => {
    const host = await hostTable();
    sendMsg(host.ws, { type: 'dm-chat', text: 'A cosy mystery in a teashop, gentle peril please.' });
    await host.q.waitFor('dm-chat-reply', 10_000);
    expect(await host.q.waitFor('content-rating', 10_000)).toEqual({ type: 'content-rating', rating: 'gentle', explicit: false, childPresent: false });
    host.ws.close();
  });
});
