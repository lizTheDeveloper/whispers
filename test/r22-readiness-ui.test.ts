// @vitest-environment jsdom
//
// Round 22 (live BH9P94): the host sidebar said "DM is ready! Waiting for
// players to submit characters..." while the readiness checklist beside it
// still listed unmet items (the world not drafted or not accepted). The DM's
// "done" only means the direction is saved; the label now waits for the
// whole checklist.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';

class FakeWs {
  static instance: FakeWs | null = null;
  sent: ClientMessage[] = [];
  private handlers = new Map<string, Array<(msg: ServerMessage) => void>>();
  constructor() { FakeWs.instance = this; }
  connect(): Promise<void> { return Promise.resolve(); }
  setSession(): void {}
  send(msg: ClientMessage): void { this.sent.push(msg); }
  on(type: string, handler: (msg: ServerMessage) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }
  onAny(): void {}
  onStatus(): void {}
  off(): void {}
  emit(msg: ServerMessage): void {
    for (const h of this.handlers.get(msg.type) ?? []) h(msg);
  }
}

vi.mock('../src/client/ws-client.js', () => ({ WsClient: FakeWs }));

const hint = () => document.querySelector('#start-hint')!.textContent ?? '';
const startBtn = () => document.querySelector('#start-game-btn') as HTMLButtonElement;
const unready = { ready: false, unmet: ['seed', 'seedAccepted'], detail: ['The world needs a premise, at least 2 locations, 2 NPCs, and 1 plot hook.', 'Review and accept the starting world.'] };

describe('the host sidebar\'s "DM is ready!" waits for the readiness checklist', () => {
  let ws: FakeWs;
  beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import('../src/client/main.js');
    ws = FakeWs.instance!;
    ws.emit({ type: 'room-joined', campaignId: 'c', joinCode: 'ABCD', isOwner: true, tableRole: 'dm', sessionToken: 't', gameName: 'G', playerName: 'Host', phase: 'lobby', characterId: null });
  });

  it('the DM set done while the world is still unmet: not "DM is ready!", and the checklist is named', () => {
    // The live order: the reply (done) and the readiness that still lists the world.
    ws.emit({ type: 'dm-chat-reply', text: 'We have the tone, the influences, and the core premise.', done: true });
    ws.emit({ type: 'world-readiness', influences: ['A', 'B', 'C'], readiness: unready });
    expect(hint()).not.toMatch(/DM is ready/);
    expect(hint()).toMatch(/checklist|still needed/i);
    expect(startBtn().disabled).toBe(true);
  });

  it('…in the other order too', () => {
    ws.emit({ type: 'world-readiness', influences: ['A', 'B', 'C'], readiness: unready });
    ws.emit({ type: 'dm-chat-reply', text: 'Anything else?', done: true });
    expect(hint()).not.toMatch(/DM is ready/);
  });

  it('once the checklist is met, the label says the DM is ready', () => {
    ws.emit({ type: 'world-readiness', influences: ['A', 'B', 'C'], readiness: { ready: true, unmet: [], detail: [] } });
    expect(hint()).toBe('DM is ready! Waiting for players to submit characters...');
    expect(startBtn().disabled).toBe(false);
  });

  it('a lobby-state with the direction saved but the world unaccepted is not ready either', () => {
    ws.emit({ type: 'lobby-state', players: [], setupChat: [], dmReady: true, approvedCount: 0, phase: 'lobby', influences: ['A', 'B', 'C'], hostTableRole: 'dm', readiness: unready });
    expect(hint()).not.toMatch(/DM is ready/);
  });
});
