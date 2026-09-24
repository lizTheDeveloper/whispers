// Live, two players (Liz and Biz): the status line "Trust: 70% (trusting) |
// Stress: 0/3 | FP: 2" showed whoever's turn it was, on BOTH tabs — Biz read
// Liz's trust and fate points during Liz's turn. character-state-update was a
// room broadcast. A character's trust in the voice, stress and fate points are
// the owner's own meta state: they now go only to the seat that plays that
// character, live and on rejoin, and each tab's status line is its own
// character's. The whisper panel (options, chips, trust line) was already
// owner-only; its trust line now speaks in the character's own pronouns.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectWs, sendMsg } from './lib/ws-helpers.js';
import { startHarness, type Harness } from './lib/server-harness.js';
import { finishWorldSetup } from './lib/finish-world-setup.js';
import { seatOn, waitForPhase, waitUntil, endGame, leave, type Seat } from './lib/playing-game.js';
import type { CharacterDefinition } from '../src/shared/types.js';
import type { ServerMessage } from '../src/shared/protocol.js';

process.env.WHISPER_WINDOW_MS = '200';
process.env.FIRST_WHISPER_WINDOW_MS = '200';

let harness: Harness;
beforeAll(async () => { harness = await startHarness(); }, 30_000);
afterAll(async () => { await harness.stop(); });

const sheet = (name: string, pronouns: string): CharacterDefinition => ({
  name, pronouns, backstory: `${name} grew up by the sea.`, personality: 'Steady.',
  highConcept: `${name} the Lamplighter`, trouble: 'Cannot leave a light unlit',
  aspects: ['Salt in the blood', 'Never leaves a friend behind'], skills: { Notice: 3, Will: 2 }, stunts: ['Keeper: +2 to Notice in the dark.'],
});

async function seatPlayer(joinCode: string, name: string, pronouns: string, host: Seat): Promise<{ seat: Seat; characterId: string }> {
  const seat = seatOn(await connectWs(harness.port));
  sendMsg(seat.ws, { type: 'join', joinCode, playerName: name });
  const joined = await seat.q.waitFor('room-joined', 10_000) as Extract<ServerMessage, { type: 'room-joined' }>;
  seat.token = joined.sessionToken;
  sendMsg(seat.ws, { type: 'submit-character', definition: sheet(name, pronouns) });
  const review = await host.q.waitFor('character-pending-review', 20_000) as Extract<ServerMessage, { type: 'character-pending-review' }>;
  sendMsg(host.ws, { type: 'host-approve-character', characterId: review.characterId });
  await seat.q.waitFor('character-submitted', 10_000);
  return { seat, characterId: review.characterId };
}

async function rejoin(joinCode: string, token: string): Promise<Seat> {
  const seat = seatOn(await connectWs(harness.port), token);
  sendMsg(seat.ws, { type: 'rejoin', joinCode, sessionToken: token });
  await seat.q.waitFor('room-joined', 10_000);
  return seat;
}

/** Every field anywhere in `msg` whose key is one of `keys`. */
function deepKeys(value: unknown, keys: string[], found: string[] = []): string[] {
  if (Array.isArray(value)) { for (const v of value) deepKeys(v, keys, found); return found; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (keys.includes(k)) found.push(k);
      deepKeys(v, keys, found);
    }
  }
  return found;
}

const OWNER_META = ['whisperTrust', 'fatePoints', 'stress', 'trustHint'];

/** Nothing this seat received tells it another character's trust, fate points or stress. */
function expectNoMetaAbout(log: ServerMessage[], otherId: string, who: string): void {
  for (const m of log) {
    if (!JSON.stringify(m).includes(otherId)) continue;
    expect(deepKeys(m, OWNER_META), `${who} got ${m.type} carrying another character's meta state`).toEqual([]);
  }
}

describe('trust, stress and fate points reach only the seat that plays the character', () => {
  it('Biz never receives Liz\'s status, live or on rejoin; each seat gets its own', async () => {
    const host = seatOn(await connectWs(harness.port));
    sendMsg(host.ws, { type: 'create', name: 'Two Seats', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
    const hostJoined = await host.q.waitFor('room-joined', 10_000) as Extract<ServerMessage, { type: 'room-joined' }>;
    host.token = hostJoined.sessionToken;
    await host.q.waitFor('dm-chat-reply', 10_000);
    await finishWorldSetup(host.ws, host.q);
    const jc = hostJoined.joinCode;

    const liz = await seatPlayer(jc, 'Liz', 'she/her', host);
    const biz = await seatPlayer(jc, 'Biz', 'he/him', host);
    sendMsg(host.ws, { type: 'start-game' });
    await waitForPhase(biz.seat.q, 'playing', 15_000);

    // Play until both characters have taken a turn and the round has moved on.
    const resolutionsFor = (log: ServerMessage[], id: string) =>
      log.filter(m => m.type === 'action-taken' && m.characterId === id).length;
    await waitUntil(() => resolutionsFor(biz.seat.log, liz.characterId) >= 1 && resolutionsFor(liz.seat.log, biz.characterId) >= 1
      && biz.seat.log.filter(m => m.type === 'resolution').length >= 2, 30_000, 'a turn each');

    const updates = (log: ServerMessage[]) => log.filter(m => m.type === 'character-state-update') as Array<Extract<ServerMessage, { type: 'character-state-update' }>>;
    // Each seat hears about its own character's state…
    expect(updates(liz.seat.log).length).toBeGreaterThan(0);
    expect(updates(biz.seat.log).length).toBeGreaterThan(0);
    expect(new Set(updates(liz.seat.log).map(u => u.characterId))).toEqual(new Set([liz.characterId]));
    expect(new Set(updates(biz.seat.log).map(u => u.characterId))).toEqual(new Set([biz.characterId]));
    // …and nothing it received, of any kind, carries the other's trust, FP or stress.
    expectNoMetaAbout(biz.seat.log, liz.characterId, 'Biz');
    expectNoMetaAbout(liz.seat.log, biz.characterId, 'Liz');
    // The host running the table plays no one here, so gets no one's.
    expect(updates(host.log)).toEqual([]);
    expectNoMetaAbout(host.log, liz.characterId, 'host');
    expectNoMetaAbout(host.log, biz.characterId, 'host');

    // The whisper panel's trust line speaks of each character in their own pronouns.
    const lizGuidance = liz.seat.log.find(m => m.type === 'whisper-guidance') as Extract<ServerMessage, { type: 'whisper-guidance' }>;
    const bizGuidance = biz.seat.log.find(m => m.type === 'whisper-guidance') as Extract<ServerMessage, { type: 'whisper-guidance' }>;
    expect(lizGuidance.trustHint).toMatch(/^She /);
    expect(lizGuidance.trustHint).not.toMatch(/\bThey\b|\btheir\b/);
    expect(bizGuidance.trustHint).toMatch(/^He /);

    // --- rejoin: the status line comes back, and it is still only your own ---
    await leave(biz.seat);
    const bizBack = await rejoin(jc, biz.seat.token);
    await bizBack.q.waitFor('transcript-replay', 10_000);
    const own = await bizBack.q.waitFor('character-state-update', 10_000) as Extract<ServerMessage, { type: 'character-state-update' }>;
    expect(own.characterId).toBe(biz.characterId);
    await new Promise(r => setTimeout(r, 400));
    expect(new Set(updates(bizBack.log).map(u => u.characterId))).toEqual(new Set([biz.characterId]));
    expectNoMetaAbout(bizBack.log, liz.characterId, 'Biz (rejoined)');
    // A rejoining tab gets whisper chips only for its own open window — never
    // a closed one's, never someone else's.
    for (const [i, m] of bizBack.log.entries()) {
      if (m.type !== 'whisper-guidance') continue;
      expect(m.characterId).toBe(biz.characterId);
      const prompt = bizBack.log.slice(0, i).reverse().find(p => p.type === 'whisper-prompt') as Extract<ServerMessage, { type: 'whisper-prompt' }> | undefined;
      expect(prompt?.characterId).toBe(biz.characterId);
    }

    const hostBack = await rejoin(jc, host.token);
    await hostBack.q.waitFor('transcript-replay', 10_000);
    await new Promise(r => setTimeout(r, 300));
    expectNoMetaAbout(hostBack.log, liz.characterId, 'host (rejoined)');
    expectNoMetaAbout(hostBack.log, biz.characterId, 'host (rejoined)');

    await endGame(hostBack);
    await leave(host, hostBack, liz.seat, bizBack);
  }, 90_000);
});
