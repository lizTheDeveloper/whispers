// @vitest-environment jsdom
//
// The client half of private considerations: a character's inner thought and
// whisper chips are drawn only when the server sent them — which it does only
// to the seat that plays that character (see private-considerations.test.ts).
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
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.appendChild(root);
});

const log = () => root.querySelector('#narration-log') as HTMLElement;
const chips = () => Array.from(root.querySelectorAll<HTMLButtonElement>('.suggestion-btn')).map(b => b.textContent);

describe('private blocks render only when present', () => {
  it('a public action-taken shows the action and words, and no thought or verdict line', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, true);
    fake.emit({ type: 'action-taken', characterId: 'c1', characterName: 'Liz', action: 'She opens the drawer.', spokenWords: 'Now.' });
    expect(log().querySelector('.character')!.textContent).toBe('Liz: She opens the drawer.');
    expect(log().querySelector('.dialogue')!.textContent).toBe('"Now."');
    expect(log().querySelector('.whisper')).toBeNull();
    expect(log().textContent).not.toContain('whisper]');
  });

  it('the owner\'s character-thought adds the thought and the verdict after the action', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false, 'c1');
    fake.emit({ type: 'action-taken', characterId: 'c1', characterName: 'Liz', action: 'She opens the drawer.' });
    fake.emit({ type: 'character-thought', characterId: 'c1', characterName: 'Liz', innerThought: 'Here goes.', whisperInfluence: 'followed' });
    const lines = Array.from(log().querySelectorAll('.narration-entry')).map(l => l.textContent);
    const at = lines.indexOf('Liz: She opens the drawer.');
    expect(lines.slice(at)).toEqual(['Liz: She opens the drawer.', '(Here goes.)', '[Liz heeded your whisper]']);
  });

  it('whisper chips come from whisper-guidance, and a new prompt starts with an empty panel', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false, 'c1');
    fake.emit({ type: 'whisper-prompt', characterId: 'c1', characterName: 'Liz', windowMs: 30_000, remainingMs: 30_000 });
    expect(chips()).toEqual([]);
    fake.emit({ type: 'whisper-guidance', characterId: 'c1', mood: 'Liz is tense.', suggestions: ['Do it — grab the **ledger**.', 'Ask Mister Pippin.'] });
    expect(chips()).toEqual(['Do it — grab the ledger.', 'Ask Mister Pippin.']);
    expect(root.querySelector('.whisper-context')!.textContent).toBe('Liz is tense.');

    fake.emit({ type: 'whisper-prompt', characterId: 'c1', characterName: 'Liz', windowMs: 30_000, remainingMs: 30_000 });
    expect(chips()).toEqual([]);
    expect(root.querySelector('.whisper-context')).toBeNull();
  });

  it('guidance for someone else\'s character is ignored by a seated player', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false, 'c1');
    fake.emit({ type: 'whisper-guidance', characterId: 'c2', suggestions: ['Not yours.'] });
    expect(chips()).toEqual([]);
  });
});
