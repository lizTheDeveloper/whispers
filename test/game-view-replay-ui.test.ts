// @vitest-environment jsdom
//
// MUL-74: a mid-session reload must refill #narration-log from the server's
// 'transcript-replay' — with the same line classes, the same stat-card, the
// same location bar, and the tutorial still first. The WS integration test
// (rejoin-transcript-replay.test.ts) proves the server ships the right
// entries; this proves the client paints them like live messages.
import { describe, it, expect, beforeEach } from 'vitest';
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
});

function entries(): Extract<ServerMessage, { type: 'transcript-replay' }>['entries'] {
  return [
    { type: 'narration', text: 'Rain needles the lamp room glass.', sceneNumber: 2, locationName: 'The Lamp Room' },
    { type: 'whisper-echo', text: 'Check the ledger first.' },
    { type: 'action-taken', characterId: 'c1', characterName: 'Vex', action: 'She pries the ledger open', spokenWords: 'Not empty, then.', innerThought: 'Hands shaking. Steady.', whisperInfluence: 'followed' },
    { type: 'dice-roll', result: { expression: '4dF', total: 1, rolls: [1, 0, -1, 1], description: '4dF: [1, 0, -1, 1] = 1' }, context: 'She pries the ledger open' },
    { type: 'resolution', text: 'The ledger splits open on a pressed bookmark.' },
    { type: 'scene-end', summary: 'The ledger was a warning.', sceneNumber: 2, whisperStats: [{ name: 'Vex', followed: 1, partial: 0, ignored: 0, trustDelta: 0.05 }] },
    { type: 'revoked-note', text: 'Maren has been removed from the table.' },
  ];
}

describe('game-view transcript-replay rendering (MUL-74)', () => {
  it('paints every replayed line with the same classes the live messages use', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false);

    fake.emit({ type: 'transcript-replay', entries: entries(), omitted: 3 });

    const log = root.querySelector('#narration-log') as HTMLElement;
    const lines = Array.from(log.querySelectorAll('.narration-entry'));
    const classes = lines.map(l => l.className.replace('narration-entry ', ''));

    // Tutorial first — the replay claims it before the server's rejoin
    // phase-change gets a chance to (shownTutorial then makes that one a
    // no-op), so the log keeps its original shape after a refresh.
    expect(classes[0]).toBe('system');
    expect(lines[0]!.textContent).toContain("voice inside your character's head");
    expect(lines[1]!.textContent).toContain('3 earlier log entries omitted');

    expect(classes).toContain('dm');
    expect(classes).toContain('whisper');      // echo + inner thought
    expect(classes).toContain('dialogue');     // spoken words
    expect(classes).toContain('dice');
    expect(classes).toContain('resolution');
    expect(classes).toContain('character');

    const texts = lines.map(l => l.textContent!);
    expect(texts.some(t => t === '[dice] 4dF: [1, 0, -1, 1] = 1 (She pries the ledger open)')).toBe(true);
    expect(texts.some(t => t === 'You whisper: "Check the ledger first."')).toBe(true);
    expect(texts.some(t => t === '[Vex heeded your whisper]')).toBe(true);
    expect(texts.some(t => t!.startsWith('--- Scene 2 End ---'))).toBe(true);
    expect(texts.some(t => t === 'Maren has been removed from the table.')).toBe(true);

    // The influence card and the restored location bar come along too.
    expect(log.querySelector('.whisper-stats-card')).not.toBeNull();
    const bar = root.querySelector('#location-bar') as HTMLElement;
    expect(bar.textContent).toBe('The Lamp Room');
    expect(bar.style.display).toBe('block');
  });

  it('counts replayed scene stats so a post-reload session recap matches the live one', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false);

    fake.emit({ type: 'transcript-replay', entries: entries(), omitted: 0 });
    fake.emit({ type: 'phase-change', phase: 'ended' } as ServerMessage);

    const recap = root.querySelector('.session-recap');
    expect(recap).not.toBeNull();
    const nums = Array.from(recap!.querySelectorAll('.recap-num')).map(n => n.textContent);
    expect(nums).toContain('1');   // scenes
    expect(nums).toContain('1');   // whispers
    expect(nums).toContain('100%'); // influence — 1 followed of 1
  });

  it('renders nothing extra for an empty replay (games predating the log)', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false);
    fake.emit({ type: 'transcript-replay', entries: [], omitted: 0 });
    const log = root.querySelector('#narration-log') as HTMLElement;
    expect(log.querySelectorAll('.narration-entry').length).toBe(0);
  });
});
