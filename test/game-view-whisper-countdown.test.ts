// @vitest-environment jsdom
//
// Live: on the second player's tab the first whisper prompt was already at
// "Whisper (3s)" when first looked at, and that player lost the turn. The
// client counted a fixed 30s from whenever the prompt reached it. It now
// counts down from the time the server says is left.
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
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

const btn = () => root.querySelector('#whisper-btn') as HTMLButtonElement;
const logText = () => (root.querySelector('#narration-log') as HTMLElement).textContent ?? '';

function mount(): FakeWs {
  const fake = new FakeWs();
  renderGameView(root, fake as unknown as WsClient, false, 'c1');
  return fake;
}
function prompt(extra: Partial<Extract<ServerMessage, { type: 'whisper-prompt' }>> = {}): ServerMessage {
  return { type: 'whisper-prompt', characterId: 'c1', characterName: 'Liz', ...extra };
}

describe('the whisper countdown', () => {
  it('counts down from the window length the server sent, not a fixed 30s', () => {
    const fake = mount();
    fake.emit(prompt({ windowMs: 60_000, remainingMs: 60_000 }));
    expect(btn().textContent).toBe('Whisper (60s)');
    vi.advanceTimersByTime(7_000);
    expect(btn().textContent).toBe('Whisper (53s)');
  });

  it('a tab that rejoins mid-window counts down from the remaining time and closes when the server does', () => {
    const fake = mount();
    fake.emit(prompt({ windowMs: 30_000, remainingMs: 12_400 }));
    expect(btn().textContent).toBe('Whisper (13s)');
    vi.advanceTimersByTime(12_000);
    expect(logText()).not.toContain('[You stayed silent.]');
    vi.advanceTimersByTime(500);
    expect(logText()).toContain('[You stayed silent.]');
    expect(btn().textContent).toBe('Whisper');
  });

  it('shows the true time left after the tab was throttled in the background', () => {
    const fake = mount();
    fake.emit(prompt({ windowMs: 30_000, remainingMs: 30_000 }));
    // A hidden tab's timers barely fire; the clock moves on regardless.
    vi.setSystemTime(Date.now() + 20_000);
    vi.advanceTimersByTime(250);
    expect(btn().textContent).toBe('Whisper (10s)');
  });

  it('falls back to 30s for a prompt with no window length', () => {
    const fake = mount();
    fake.emit(prompt());
    expect(btn().textContent).toBe('Whisper (30s)');
  });

  it('does not run a countdown for a window a pause is holding', () => {
    const fake = mount();
    fake.emit({ type: 'game-paused', paused: true, reason: 'host' });
    fake.emit(prompt({ windowMs: 30_000, remainingMs: 30_000 }));
    vi.advanceTimersByTime(40_000);
    expect(btn().textContent).toBe('Whisper');
    expect(logText()).not.toContain('[You stayed silent.]');
  });
});
