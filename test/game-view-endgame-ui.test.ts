// @vitest-environment jsdom
//
// The client half of End Game and the paused lock, from a live two-browser
// playtest: after End Game the whisper countdown kept ticking, logged
// "[You stayed silent.]" under the epilogue and left the whisper box, button
// and suggestion chips live on both tabs; the recap said "0 Scenes" for a
// game that played a whole scene; and while paused the chips stayed
// clickable even though the box they fill was locked.
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
  vi.restoreAllMocks();
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

const input = () => root.querySelector('#whisper-text') as HTMLInputElement;
const btn = () => root.querySelector('#whisper-btn') as HTMLButtonElement;
const area = () => root.querySelector('#whisper-area') as HTMLElement;
const chips = () => Array.from(root.querySelectorAll('.suggestion-btn')) as HTMLButtonElement[];
const logText = () => (root.querySelector('#narration-log') as HTMLElement).textContent ?? '';
const recapScenes = () => {
  const stats = Array.from(root.querySelectorAll('.session-recap .recap-stat'));
  const scenes = stats.find(s => s.querySelector('.recap-label')?.textContent === 'Scenes');
  return Number(scenes?.querySelector('.recap-num')?.textContent);
};

function prompt(characterId = 'c1'): ServerMessage {
  return {
    type: 'whisper-prompt', characterId, characterName: 'Liz',
    mood: 'Liz is tense.', suggestions: ['Check the filing cabinet', 'Ask Biz'],
  };
}
function narration(sceneNumber: number, text = 'The office hums.'): ServerMessage {
  return { type: 'narration', text, sceneNumber };
}
function action(characterId = 'c1'): ServerMessage {
  return { type: 'action-taken', characterId, characterName: 'Liz', action: 'Liz opens the drawer marked MISFILED.', innerThought: 'Here goes.', whisperInfluence: 'none' };
}

function expectFinished(): void {
  expect(input().disabled).toBe(true);
  expect(btn().disabled).toBe(true);
  for (const c of chips()) expect(c.disabled).toBe(true);
  expect(area().style.display).toBe('none');
}

describe('game-view after End Game', () => {
  it.each([
    ['a seated player', false, 'c1'],
    ['the host driving without a character', true, null],
  ] as const)('clears the countdown and locks the whisper box, button and chips for %s', (_who, isHost, charId) => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, isHost, charId);
    fake.emit(narration(1));
    fake.emit(prompt());
    vi.advanceTimersByTime(7_000);
    expect(btn().textContent).toBe('Whisper (23s)');

    fake.emit({ type: 'narration', text: 'And so the office fell quiet.', sceneNumber: 1, isEpilogue: true });
    fake.emit({ type: 'phase-change', phase: 'ended' });
    vi.advanceTimersByTime(60_000);

    expect(logText()).not.toContain('[You stayed silent.]');
    expect(btn().textContent).toBe('Whisper');
    expectFinished();

    // Nothing the table sends after the end reopens the box or adds a status line.
    fake.emit({ type: 'character-state-update', characterId: 'c1', state: { stress: 0, consequences: [], fatePoints: 3, whisperTrust: 0.4, inventory: [] } as any });
    fake.emit({ type: 'game-paused', paused: false, reason: null });
    expect(root.querySelector('#char-status')).toBeNull();
    expectFinished();
  });

  it('locks the box the moment the server says the game is ending, before the epilogue arrives', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false, 'c1');
    fake.emit(prompt());
    vi.advanceTimersByTime(7_000);

    fake.emit({ type: 'game-ending' });
    // The epilogue and closing reflections can take longer than the window.
    vi.advanceTimersByTime(60_000);
    expect(logText()).not.toContain('[You stayed silent.]');
    expectFinished();
    chips()[0]?.click();
    expect(input().value).toBe('');
  });

  it('counts the scene End Game interrupted in the recap when turns happened in it', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, true);
    fake.emit(narration(1));
    fake.emit(action());
    fake.emit(narration(1, 'The clerk frowns.'));
    fake.emit(action());
    fake.emit({ type: 'narration', text: 'Epilogue.', sceneNumber: 1, isEpilogue: true });
    fake.emit({ type: 'phase-change', phase: 'ended' });
    expect(recapScenes()).toBe(1);
  });

  it('counts finished scenes plus the interrupted one, but not a scene with no turns yet', () => {
    const noTurns = new FakeWs();
    renderGameView(root, noTurns as unknown as WsClient, true);
    noTurns.emit(narration(1));
    noTurns.emit(action());
    noTurns.emit({ type: 'scene-end', summary: 'The form was found.', sceneNumber: 1 });
    noTurns.emit(narration(2));
    noTurns.emit({ type: 'phase-change', phase: 'ended' });
    expect(recapScenes()).toBe(1);

    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.appendChild(root);
    const withTurns = new FakeWs();
    renderGameView(root, withTurns as unknown as WsClient, true);
    withTurns.emit(narration(1));
    withTurns.emit(action());
    withTurns.emit({ type: 'scene-end', summary: 'The form was found.', sceneNumber: 1 });
    withTurns.emit(narration(2));
    withTurns.emit(action());
    withTurns.emit({ type: 'phase-change', phase: 'ended' });
    expect(recapScenes()).toBe(2);
  });

  it('counts a replayed interrupted scene after a refresh', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false, 'c1');
    fake.emit({
      type: 'transcript-replay', omitted: 0,
      entries: [
        { type: 'narration', text: 'The office hums.', sceneNumber: 1 },
        { type: 'action-taken', characterId: 'c1', characterName: 'Liz', action: 'Liz opens the drawer.', innerThought: 'Here goes.', whisperInfluence: 'none' },
        { type: 'narration', text: 'Epilogue.', sceneNumber: 1, isEpilogue: true },
      ],
    });
    fake.emit({ type: 'phase-change', phase: 'ended' });
    expect(recapScenes()).toBe(1);
    expectFinished();
  });
});

describe('game-view suggestion chips while paused', () => {
  it('disables the chips while paused and re-enables them on resume', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false, 'c1');
    fake.emit(prompt());
    expect(chips().length).toBe(2);
    for (const c of chips()) expect(c.disabled).toBe(false);

    fake.emit({ type: 'game-paused', paused: true, reason: 'host' });
    for (const c of chips()) expect(c.disabled).toBe(true);
    chips()[0]!.click();
    expect(input().value).toBe('');

    fake.emit({ type: 'game-paused', paused: false, reason: null });
    for (const c of chips()) expect(c.disabled).toBe(false);
    chips()[0]!.click();
    expect(input().value).toBe('Check the filing cabinet');
  });

  it('renders chips disabled when a window opens while the table is paused', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false, 'c1');
    fake.emit({ type: 'game-paused', paused: true, reason: 'host' });
    fake.emit(prompt());
    for (const c of chips()) expect(c.disabled).toBe(true);
  });

  it('keeps chips usable on a quiet pause, where a whisper is what resumes play', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false, 'c1');
    fake.emit(prompt());
    fake.emit({ type: 'game-paused', paused: true, reason: 'quiet' });
    for (const c of chips()) expect(c.disabled).toBe(false);
  });
});
