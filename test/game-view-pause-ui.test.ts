// @vitest-environment jsdom
//
// The client half of pause/stop: the host gets a Pause/Resume toggle beside
// End Game (which now asks first), and everyone gets a banner that says the
// table is paused and why. The whisper box is locked while paused — except
// after quiet turns, where a whisper is exactly what picks play back up.
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
  vi.restoreAllMocks();
});

const banner = () => root.querySelector('#pause-banner') as HTMLElement;
const pauseBtn = () => root.querySelector('#pause-btn') as HTMLButtonElement | null;

describe('game-view pause controls', () => {
  it('gives the host a Pause/Resume toggle that sends pause-game / resume-game', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, true);
    expect(pauseBtn()!.textContent).toBe('Pause');
    pauseBtn()!.click();
    expect(fake.sent.at(-1)).toEqual({ type: 'pause-game' });

    fake.emit({ type: 'game-paused', paused: true, reason: 'host', by: 'Host' });
    expect(pauseBtn()!.textContent).toBe('Resume');
    expect(pauseBtn()!.disabled).toBe(false);
    pauseBtn()!.click();
    expect(fake.sent.at(-1)).toEqual({ type: 'resume-game' });

    fake.emit({ type: 'game-paused', paused: false, reason: null });
    expect(pauseBtn()!.textContent).toBe('Pause');
  });

  it('shows players no pause button', () => {
    renderGameView(root, new FakeWs() as unknown as WsClient, false, 'c1');
    expect(pauseBtn()).toBeNull();
  });

  it.each([
    ['host', 'Paused by the host'],
    ['no-players', 'Paused: no players connected'],
    ['quiet', 'Paused after 6 quiet turns — whisper or resume to continue'],
    ['restart', 'Paused after a server restart'],
  ] as const)('explains a %s pause to everyone', (reason, text) => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false, 'c1');
    expect(banner().classList.contains('hidden')).toBe(true);
    fake.emit({ type: 'game-paused', paused: true, reason });
    expect(banner().classList.contains('hidden')).toBe(false);
    expect(banner().textContent).toBe(text);
    fake.emit({ type: 'game-paused', paused: false, reason: null });
    expect(banner().classList.contains('hidden')).toBe(true);
  });

  it('locks the whisper box while paused, except after quiet turns', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false, 'c1');
    const input = root.querySelector('#whisper-text') as HTMLInputElement;
    const btn = root.querySelector('#whisper-btn') as HTMLButtonElement;

    fake.emit({ type: 'game-paused', paused: true, reason: 'host' });
    expect(input.disabled).toBe(true);
    expect(btn.disabled).toBe(true);

    fake.emit({ type: 'game-paused', paused: true, reason: 'quiet' });
    expect(input.disabled).toBe(false);
    expect(btn.disabled).toBe(false);

    fake.emit({ type: 'game-paused', paused: true, reason: 'restart' });
    expect(input.disabled).toBe(true);
    fake.emit({ type: 'game-paused', paused: false, reason: null });
    expect(input.disabled).toBe(false);
    expect(btn.disabled).toBe(false);
  });

  it('asks before ending the game, and sends nothing if the host backs out', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, true);
    const endBtn = root.querySelector('#end-game-btn') as HTMLButtonElement;

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    endBtn.click();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(fake.sent.some(m => m.type === 'end-game')).toBe(false);

    confirmSpy.mockReturnValue(true);
    endBtn.click();
    expect(fake.sent.at(-1)).toEqual({ type: 'end-game' });
  });

  it('clears the banner when the game ends', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, true);
    fake.emit({ type: 'game-paused', paused: true, reason: 'host' });
    fake.emit({ type: 'phase-change', phase: 'ended' });
    expect(banner().classList.contains('hidden')).toBe(true);
  });
});
