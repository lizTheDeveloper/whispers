// @vitest-environment jsdom
//
// Live: Biz's recap read "5 WHISPERS / 5 HEEDED" after Biz sent 7 whispers
// (6 heeded, 1 partly heeded). The totals were summed from the per-scene
// influence cards, so the scene End Game interrupted — which never gets a
// card — was not counted. The recap now counts every verdict the owner was
// shown, as it is shown: live, or restored by a replay.
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

let root: HTMLElement;
beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.appendChild(root);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

const recap = (label: string) => {
  const stats = Array.from(root.querySelectorAll('.session-recap .recap-stat'));
  const s = stats.find(x => x.querySelector('.recap-label')?.textContent === label);
  return s ? Number(s.querySelector('.recap-num')?.textContent?.replace('%', '')) : null;
};
const thought = (whisperInfluence: 'followed' | 'partially-followed' | 'ignored' | 'none'): ServerMessage =>
  ({ type: 'character-thought', characterId: 'biz', characterName: 'Biz', innerThought: 'Hm.', whisperInfluence });

describe('the session recap counts every whisper the owner sent', () => {
  it('includes the unfinished scene and partly heeded whispers', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false, 'biz');
    // Scene 1: five heeded, closed with its influence card.
    fake.emit({ type: 'narration', text: 'Scene one.', sceneNumber: 1 } as ServerMessage);
    for (let i = 0; i < 5; i++) fake.emit(thought('followed'));
    fake.emit({ type: 'scene-end', summary: 'Done.', sceneNumber: 1 } as ServerMessage);
    fake.emit({ type: 'scene-stats', sceneNumber: 1, whisperStats: [{ name: 'Biz', followed: 5, partial: 0, ignored: 0, trustDelta: 0.1 }] } as ServerMessage);
    // Scene 2, ended by End Game: one heeded, one partly heeded, no card.
    fake.emit({ type: 'narration', text: 'Scene two.', sceneNumber: 2 } as ServerMessage);
    fake.emit(thought('followed'));
    fake.emit(thought('partially-followed'));
    fake.emit(thought('none'));
    fake.emit({ type: 'phase-change', phase: 'ended' } as ServerMessage);
    expect(recap('Whispers')).toBe(7);
    expect(recap('Heeded')).toBe(6);
  });

  it('counts the same after a refresh restores the log', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false, 'biz');
    fake.emit({ type: 'transcript-replay', omitted: 0, entries: [
      { type: 'narration', text: 'Scene one.', sceneNumber: 1 },
      thought('followed'), thought('ignored'),
      { type: 'scene-end', summary: 'Done.', sceneNumber: 1 },
      { type: 'scene-stats', sceneNumber: 1, whisperStats: [{ name: 'Biz', followed: 1, partial: 0, ignored: 1, trustDelta: 0 }] },
      { type: 'narration', text: 'Scene two.', sceneNumber: 2 },
      thought('partially-followed'),
    ] } as ServerMessage);
    fake.emit({ type: 'phase-change', phase: 'ended' } as ServerMessage);
    expect(recap('Whispers')).toBe(3);
    expect(recap('Heeded')).toBe(1);
  });
});
