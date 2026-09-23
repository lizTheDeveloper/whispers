// @vitest-environment jsdom
//
// "When I click 'I'm playing in it' it deletes the DM conversation from the
// browser." The conversation was never deleted — the server keeps it in
// currentPlayer.setupChat and the campaign's setup_chat row, and a refresh
// brings it back via lobby-state. What wiped it was the client router: the
// server answers choose-table-role with a fresh 'room-joined' carrying the
// new tableRole, renderKey changes (dm:none -> dm:player), and main.ts's
// renderFor remounted renderDmLobby from scratch — an empty #dm-chat-log with
// no lobby-state to refill it — and the influences, readiness and world-seed
// panels went with it. In the lobby phase both seats route to the same DM
// lobby, so there is nothing to remount.
//
// This drives the real main.ts router with the WebSocket swapped for a fake.
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
  // Array iteration visits handlers appended mid-dispatch, same as the real
  // client's Set.forEach — dm-lobby relies on that to see its own room-joined.
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

function roomJoined(tableRole: 'dm' | 'player' | null): ServerMessage {
  return {
    type: 'room-joined', campaignId: 'camp-1', joinCode: 'ABCD', isOwner: true,
    tableRole, sessionToken: 'tok', gameName: 'Test Game', playerName: 'Host',
    phase: 'lobby', characterId: null,
  };
}

function chatTexts(): string[] {
  const log = document.querySelector('#dm-chat-log') as HTMLElement;
  return Array.from(log.querySelectorAll('.dm-chat-bubble')).map(b => b.textContent ?? '');
}

describe('host picks a table role in the DM lobby', () => {
  let ws: FakeWs;

  beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import('../src/client/main.js');
    ws = FakeWs.instance!;
    ws.emit(roomJoined(null));
    ws.emit({ type: 'dm-chat-reply', text: 'Welcome! What kind of game do you want?', done: false });
    (document.querySelector('#dm-chat-input') as HTMLInputElement).value = 'A haunted lighthouse mystery';
    (document.querySelector('#dm-chat-send') as HTMLButtonElement).click();
    ws.emit({ type: 'dm-chat-reply', text: 'Lovely. Who keeps the lamp?', done: false });
    ws.emit({
      type: 'world-readiness',
      influences: ['Twin Peaks', 'The Lighthouse', 'Annihilation'],
      readiness: { ready: false, unmet: ['tableRole'], detail: ['Choose your seat at the table.'] },
    });
    ws.emit({
      type: 'world-seed-draft', accepted: false,
      seed: { premise: 'A lamp that shines inward.', locations: [], npcs: [], plotHooks: [], items: [] },
    });
  });

  function sidePanels() {
    return {
      influencesHeading: document.querySelector('#influences-heading')!.textContent,
      influences: Array.from(document.querySelectorAll('#influence-list li')).map(li => li.textContent),
      readiness: Array.from(document.querySelectorAll('#readiness-list li')).map(li => li.textContent),
      seedPremise: document.querySelector('#world-seed-panel .seed-premise')?.textContent ?? null,
    };
  }

  it('keeps the DM conversation on screen after "I\'m playing in it"', () => {
    const before = chatTexts();
    expect(before).toEqual([
      'Welcome! What kind of game do you want?',
      'A haunted lighthouse mystery',
      'Lovely. Who keeps the lamp?',
    ]);
    const liveLog = document.querySelector('#dm-chat-log');
    const panelsBefore = sidePanels();
    expect(panelsBefore.influencesHeading).toBe('Influences (3/3)');
    expect(panelsBefore.seedPremise).toBe('A lamp that shines inward.');

    (document.querySelector('#role-player-btn') as HTMLButtonElement).click();
    expect(ws.sent.at(-1)).toEqual({ type: 'choose-table-role', role: 'player' });
    // What the server answers with (index.ts choose-table-role handler).
    ws.emit(roomJoined('player'));

    expect(chatTexts()).toEqual(before);
    expect(document.querySelector('#dm-chat-log')).toBe(liveLog);
    // Influences, readiness and the world-seed draft lived in the same
    // remounted DOM and were wiped along with the chat.
    expect(sidePanels()).toEqual(panelsBefore);
    expect(document.querySelector('#role-player-btn')!.classList.contains('active')).toBe(true);
    expect(document.querySelector('#role-current-line')!.textContent).toContain("You're playing in it");
  });

  it('keeps it when switching back to "I\'m running this game"', () => {
    const before = chatTexts();
    const panelsBefore = sidePanels();
    (document.querySelector('#role-dm-btn') as HTMLButtonElement).click();
    ws.emit(roomJoined('dm'));
    expect(chatTexts()).toEqual(before);
    expect(sidePanels()).toEqual(panelsBefore);
    expect(document.querySelector('#role-dm-btn')!.classList.contains('active')).toBe(true);
  });

  it('keeps talking to one lobby — no duplicate bubbles from a stale second mount', () => {
    ws.emit({ type: 'dm-chat-reply', text: 'The lamp keeper is missing.', done: false });
    const texts = chatTexts();
    expect(texts.filter(t => t === 'The lamp keeper is missing.')).toHaveLength(1);
    expect(document.querySelectorAll('#dm-chat-log')).toHaveLength(1);
  });
});
