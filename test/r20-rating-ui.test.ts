// @vitest-environment jsdom
//
// Round 20, the client: every seat sees the table's rating as a small badge;
// the host changes it from a control — beside Pause and End Game in the game
// view, in the DM lobby's sidebar — and the table reads the change as a
// system line. A child PC at a rating above gentle gets a one-line notice,
// never a block.
import { describe, it, expect, beforeEach } from 'vitest';
import { renderGameView } from '../src/client/game-view.js';
import { renderDmLobby } from '../src/client/dm-lobby.js';
import { renderWaitingRoom } from '../src/client/waiting-room.js';
import { resetContentRating, CHILD_NOTICE } from '../src/client/content-rating.js';
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
  resetContentRating();
});

const badge = () => root.querySelector('.rating-badge') as HTMLElement;
const select = () => root.querySelector('.rating-select') as HTMLSelectElement | null;
const notice = () => root.querySelector('.rating-child-notice') as HTMLElement;
const logLines = () => Array.from(root.querySelectorAll('#narration-log .narration-entry')).map(e => e.textContent);

describe('the rating badge', () => {
  it('shows every player the rating, and follows a change', () => {
    const ws = new FakeWs();
    renderGameView(root, ws as unknown as WsClient, false, 'c1');
    expect(badge().classList.contains('hidden')).toBe(true);
    ws.emit({ type: 'content-rating', rating: 'storybook', explicit: false, childPresent: false });
    expect(badge().classList.contains('hidden')).toBe(false);
    expect(badge().textContent).toBe('Rated Storybook');
    ws.emit({ type: 'content-rating', rating: 'mature', explicit: true, childPresent: false, line: 'The host set the rating to Mature.' });
    expect(badge().textContent).toBe('Rated Mature');
    expect(badge().dataset.rating).toBe('mature');
    // Players get no control.
    expect(select()).toBeNull();
  });

  it('a change mid-game is a system line in the story log; a plain resend is not', () => {
    const ws = new FakeWs();
    renderGameView(root, ws as unknown as WsClient, false, 'c1');
    ws.emit({ type: 'content-rating', rating: 'storybook', explicit: false, childPresent: false });
    expect(logLines()).toEqual([]);
    ws.emit({ type: 'content-rating', rating: 'adventure', explicit: true, childPresent: false, line: 'The host set the rating to Adventure.' });
    expect(logLines()).toEqual(['The host set the rating to Adventure.']);
  });

  it('a refresh replays the change line from the log', () => {
    const ws = new FakeWs();
    renderGameView(root, ws as unknown as WsClient, false, 'c1');
    ws.emit({ type: 'transcript-replay', entries: [{ type: 'rating-note', text: 'The host set the rating to Mature.' }], omitted: 0 });
    expect(logLines()).toContain('The host set the rating to Mature.');
  });

  it('a view mounted after the rating arrived paints it at once (the waiting room, then the game)', () => {
    const ws = new FakeWs();
    renderWaitingRoom(root, ws as unknown as WsClient, 'Sky', 'ABCD');
    ws.emit({ type: 'content-rating', rating: 'adventure', explicit: true, childPresent: false });
    expect(badge().textContent).toBe('Rated Adventure');
    renderGameView(root, ws as unknown as WsClient, false, 'c1');
    expect(badge().textContent).toBe('Rated Adventure');
  });
});

describe('the host\'s rating control', () => {
  it('sits beside Pause and End Game in the game view, and asks the server for the change', () => {
    const ws = new FakeWs();
    renderGameView(root, ws as unknown as WsClient, true);
    const control = root.querySelector('#dm-controls .rating-select') as HTMLSelectElement;
    expect(control).not.toBeNull();
    expect(Array.from(control.options).map(o => o.textContent)).toEqual(['Gentle', 'Storybook', 'Adventure', 'Mature']);
    ws.emit({ type: 'content-rating', rating: 'storybook', explicit: false, childPresent: false });
    expect(control.value).toBe('storybook');
    expect(root.querySelector('.rating-blurb')!.textContent).toContain('The default');

    control.value = 'mature';
    control.dispatchEvent(new Event('change'));
    expect(ws.sent.at(-1)).toEqual({ type: 'set-content-rating', rating: 'mature' });
    expect(control.disabled).toBe(true);
    ws.emit({ type: 'content-rating', rating: 'mature', explicit: true, childPresent: false, line: 'The host set the rating to Mature.' });
    expect(control.disabled).toBe(false);
    expect(control.value).toBe('mature');
    expect(badge().textContent).toBe('Rated Mature');
  });

  it('a refused change puts the control back as the server has it', () => {
    const ws = new FakeWs();
    renderGameView(root, ws as unknown as WsClient, true);
    ws.emit({ type: 'content-rating', rating: 'gentle', explicit: true, childPresent: false });
    select()!.value = 'adventure';
    select()!.dispatchEvent(new Event('change'));
    ws.emit({ type: 'error', message: 'The story is over — the rating can no longer change.' });
    expect(select()!.value).toBe('gentle');
    expect(select()!.disabled).toBe(false);
  });

  it('with a child PC above gentle: a one-line notice, and the choice still goes through', () => {
    const ws = new FakeWs();
    renderGameView(root, ws as unknown as WsClient, true);
    ws.emit({ type: 'content-rating', rating: 'gentle', explicit: false, childPresent: true });
    expect(notice().classList.contains('hidden')).toBe(true);
    select()!.value = 'adventure';
    select()!.dispatchEvent(new Event('change'));
    expect(notice().classList.contains('hidden')).toBe(false);
    expect(notice().textContent).toBe(CHILD_NOTICE);
    expect(ws.sent.at(-1)).toEqual({ type: 'set-content-rating', rating: 'adventure' });
    ws.emit({ type: 'content-rating', rating: 'adventure', explicit: true, childPresent: true, line: 'The host set the rating to Adventure.' });
    expect(notice().classList.contains('hidden')).toBe(false);
    ws.emit({ type: 'content-rating', rating: 'gentle', explicit: true, childPresent: true, line: 'The host set the rating to Gentle.' });
    expect(notice().classList.contains('hidden')).toBe(true);
  });

  it('is in the DM lobby\'s sidebar too, and the setup chat shows the change as a note', () => {
    const ws = new FakeWs();
    renderDmLobby(root, ws as unknown as WsClient, 'ABCD', 'camp');
    const control = root.querySelector('#rating-section .rating-select') as HTMLSelectElement;
    expect(control).not.toBeNull();
    ws.emit({ type: 'content-rating', rating: 'storybook', explicit: false, childPresent: false });
    expect(control.value).toBe('storybook');
    ws.emit({ type: 'content-rating', rating: 'mature', explicit: true, childPresent: false, line: 'The host set the rating to Mature.' });
    expect(control.value).toBe('mature');
    const notes = Array.from(root.querySelectorAll('#dm-chat-log .dm-chat-bubble.system')).map(b => b.textContent);
    expect(notes).toContain('The host set the rating to Mature.');
  });
});
