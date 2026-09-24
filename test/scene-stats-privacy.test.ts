// The end-of-scene "Your Influence This Scene" card is each player's own:
// how many of THEIR whispers their character heeded and how their trust
// moved. It used to ride on the public scene-end broadcast, so every seat saw
// every character's whisper record and trust delta — the last place the
// owner-only rule for a character's relationship with the voice leaked.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './lib/server-harness.js';
import type { ServerMessage } from '../src/shared/protocol.js';
import type { RoomState } from '../src/shared/types.js';

let harness: Harness;
beforeAll(async () => { harness = await startHarness(); }, 30_000);
afterAll(async () => { await harness.stop(); });

describe('scene whisper stats are owner-only (server)', () => {
  it('the public scene-end carries no stats; each owner gets only their own row', async () => {
    const { getDb } = await import('../src/server/db.js');
    const { createRoom } = await import('../src/server/room.js');
    const { GameLoop } = await import('../src/server/game-loop.js');
    const db = getDb();
    const { campaignId, joinCode } = createRoom(db, { name: 'Scene stats privacy', dmPreset: 'chronicler', systemId: 'fate-core' });
    const state: RoomState = {
      campaignId, joinCode, phase: 'playing', currentScene: 1, currentTurn: 3,
      initiativeOrder: [], activeCharacterId: null,
      awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null,
    };
    const broadcasts: ServerMessage[] = [];
    const owned: Array<{ characterId: string; msg: ServerMessage }> = [];
    const loop = new GameLoop(db, campaignId, (m) => broadcasts.push(m), () => {}, state,
      (characterId, msg) => owned.push({ characterId, msg }));
    const stats = (loop as any).sceneWhisperStats as Map<string, any>;
    stats.set('liz', { name: 'Liz', followed: 2, partial: 0, ignored: 1, trustStart: 0.6, trustEnd: 0.7 });
    stats.set('biz', { name: 'Biz', followed: 1, partial: 1, ignored: 0, trustStart: 0.5, trustEnd: 0.45 });

    await (loop as any).endScene();
    loop.stop();

    const sceneEnd = broadcasts.find(m => m.type === 'scene-end') as any;
    expect(sceneEnd).toBeTruthy();
    expect(sceneEnd.whisperStats).toBeUndefined();
    expect(JSON.stringify(broadcasts)).not.toMatch(/trustDelta|"followed"/);

    const lizStats = owned.filter(o => o.msg.type === 'scene-stats' && o.characterId === 'liz').map(o => o.msg as any);
    const bizStats = owned.filter(o => o.msg.type === 'scene-stats' && o.characterId === 'biz').map(o => o.msg as any);
    expect(lizStats).toHaveLength(1);
    expect(bizStats).toHaveLength(1);
    expect(lizStats[0].whisperStats.map((s: any) => s.name)).toEqual(['Liz']);
    expect(bizStats[0].whisperStats.map((s: any) => s.name)).toEqual(['Biz']);
    expect(bizStats[0].whisperStats[0].trustDelta).toBeCloseTo(-0.05);
  }, 30_000);

  it('a stored scene-end row from before this fix replays without anyone\'s stats', async () => {
    const { getDb } = await import('../src/server/db.js');
    const { createRoom } = await import('../src/server/room.js');
    const { appendReplayEntry, loadReplayLog } = await import('../src/server/replay-log.js');
    const db = getDb();
    const { campaignId } = createRoom(db, { name: 'Old scene-end row', dmPreset: 'chronicler', systemId: 'fate-core' });
    appendReplayEntry(db, campaignId, {
      type: 'scene-end', summary: 'The stalls sealed.', sceneNumber: 1,
      whisperStats: [{ name: 'Liz', followed: 2, partial: 0, ignored: 1, trustDelta: 0.1 }],
    } as ServerMessage);
    const { entries } = loadReplayLog(db, campaignId, null);
    const row = entries.find(e => e.type === 'scene-end') as any;
    expect(row.summary).toBe('The stalls sealed.');
    expect(row.whisperStats).toBeUndefined();
  });
});

