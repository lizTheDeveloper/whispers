// @vitest-environment jsdom
//
// Client half of scene-stats-privacy.test.ts: the influence card renders from
// the owner-only scene-stats message, live and on replay.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderGameView } from '../src/client/game-view.js';
import type { WsClient } from '../src/client/ws-client.js';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';

class FakeWs {
  sent: ClientMessage[] = [];
  private handlers = new Map<string, Array<(msg: ServerMessage) => void>>();
  send(msg: ClientMessage): void { this.sent.push(msg); }
  on(type: string, handler: (msg: ServerMessage) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }
  onStatus(): void {}
  emit(msg: ServerMessage): void {
    for (const h of this.handlers.get(msg.type) ?? []) h(msg);
  }
}

describe('scene whisper stats are owner-only (client)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.appendChild(root);
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('renders the influence card from the owner\'s scene-stats, live and on replay', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false, 'biz');
    fake.emit({ type: 'scene-end', summary: 'The stalls sealed.', sceneNumber: 1 } as ServerMessage);
    expect(root.querySelectorAll('.whisper-stats-card')).toHaveLength(0);
    fake.emit({ type: 'scene-stats', sceneNumber: 1, whisperStats: [{ name: 'Biz', followed: 1, partial: 1, ignored: 0, trustDelta: -0.05 }] } as ServerMessage);
    const cards = root.querySelectorAll('.whisper-stats-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain('Biz');
    expect(cards[0]!.textContent).not.toContain('Liz');

    fake.emit({ type: 'transcript-replay', omitted: 0, entries: [
      { type: 'scene-end', summary: 'Earlier.', sceneNumber: 1 },
      { type: 'scene-stats', sceneNumber: 1, whisperStats: [{ name: 'Biz', followed: 0, partial: 0, ignored: 1, trustDelta: 0 }] },
    ] } as ServerMessage);
    expect(root.querySelectorAll('.whisper-stats-card')).toHaveLength(2);
  });
});
