// @vitest-environment jsdom
//
// The client half of two live bugs from a two-player table (Liz and Biz):
//  - The status line ("Trust: 70% (trusting) | Stress: 0/3 | FP: 2") showed
//    whoever's turn it was. A tab's status line is its own character's,
//    always; an update about anyone else is not drawn (the server no longer
//    sends one — see owner-status-privacy.test.ts — this is the other half).
//  - The whisper panel never closed: after a player whispered (or the window
//    ran out, or the action was taken) their chips, mood line and "Trust: 64%"
//    stayed up through the other player's turn. A closed window's panel is
//    cleared, and chips only ever render into an open window of your own.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderGameView } from '../src/client/game-view.js';
import type { WsClient } from '../src/client/ws-client.js';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';
import type { CharacterState } from '../src/shared/types.js';

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

const status = () => root.querySelector('#char-status')?.textContent ?? null;
const chips = () => Array.from(root.querySelectorAll<HTMLButtonElement>('.suggestion-btn')).map(b => b.textContent);
const mood = () => root.querySelector('.whisper-context')?.textContent ?? null;
const goals = () => root.querySelectorAll('.goal-tag').length;
const trust = () => (root.querySelector('#trust-display') as HTMLElement).textContent;

const state = (whisperTrust: number, fatePoints: number, stress = 0): CharacterState =>
  ({ stress, consequences: [], fatePoints, inventory: [], xpMilestones: [], whisperTrust } as CharacterState);

function mount(myCharacterId: string | null, isHost = false): FakeWs {
  const fake = new FakeWs();
  renderGameView(root, fake as unknown as WsClient, isHost, myCharacterId);
  return fake;
}

/** Liz's window opens on her own tab: options, prompt, then the panel's guidance. */
function openWindow(fake: FakeWs, id = 'liz', name = 'Liz'): void {
  fake.emit({ type: 'action-proposals', characterId: id, characterName: name, actions: ['Open the drawer'], actionReasons: ['It is locked for a reason'], whisperTrust: 0.64 });
  fake.emit({ type: 'whisper-prompt', characterId: id, characterName: name, windowMs: 30_000, remainingMs: 30_000 });
  fake.emit({ type: 'whisper-guidance', characterId: id, mood: `${name} is focused and alert.`, trustHint: 'She listens.', goals: ['Find Biz'], suggestions: ['Open it.', 'Wait.'] });
}

function expectPanelClosed(): void {
  expect(chips()).toEqual([]);
  expect(mood()).toBeNull();
  expect(goals()).toBe(0);
  expect(trust()).toBe('');
}

describe('the status line is your own character\'s', () => {
  it('Biz\'s tab ignores Liz\'s state during Liz\'s turn and shows Biz\'s own', () => {
    const fake = mount('biz');
    fake.emit({ type: 'character-state-update', characterId: 'biz', state: state(0.5, 3, 1) });
    expect(status()).toBe('Trust: 50% (uncertain) | Stress: 1/3 | FP: 3');
    fake.emit({ type: 'character-state-update', characterId: 'liz', state: state(0.7, 2) });
    expect(status()).toBe('Trust: 50% (uncertain) | Stress: 1/3 | FP: 3');
    expect(root.textContent).not.toContain('70%');
  });

  it('no status line from someone else\'s update, even before your own arrives', () => {
    const fake = mount('biz');
    fake.emit({ type: 'character-state-update', characterId: 'liz', state: state(0.7, 2) });
    expect(status()).toBeNull();
  });

  it('a host playing no one shows no one\'s status', () => {
    const fake = mount(null, true);
    fake.emit({ type: 'character-state-update', characterId: 'liz', state: state(0.7, 2) });
    expect(status()).toBeNull();
  });
});

describe('the whisper panel closes with its window', () => {
  it('after your whisper is delivered: no chips, no mood, no trust readout', () => {
    const fake = mount('liz');
    openWindow(fake);
    expect(chips()).toEqual(['Open it.', 'Wait.']);
    expect(trust()).toBe('Trust: 64%');
    (root.querySelector('#whisper-text') as HTMLInputElement).value = 'Open it.';
    (root.querySelector('#whisper-btn') as HTMLButtonElement).click();
    fake.emit({ type: 'whisper-ack', status: 'delivered', characterId: 'liz', characterName: 'Liz', message: '' });
    expectPanelClosed();
    // The box itself stays, in queue mode: a seated player's next words wait
    // for their next choice (MUL-73).
    expect((root.querySelector('#whisper-btn') as HTMLButtonElement).textContent).toBe('Whisper');
  });

  it('after the window runs out', () => {
    const fake = mount('liz');
    openWindow(fake);
    vi.advanceTimersByTime(31_000);
    expect(root.querySelector('#narration-log')!.textContent).toContain('[You stayed silent.]');
    expectPanelClosed();
  });

  it('when the action is taken', () => {
    const fake = mount('liz');
    openWindow(fake);
    fake.emit({ type: 'action-taken', characterId: 'liz', characterName: 'Liz', action: 'She opens the drawer.' });
    expectPanelClosed();
  });

  it('when someone else\'s window opens, a stale panel of yours is gone', () => {
    const fake = mount('liz');
    openWindow(fake);
    fake.emit({ type: 'whisper-prompt', characterId: 'biz', characterName: 'Biz', windowMs: 30_000, remainingMs: 30_000 });
    expectPanelClosed();
  });

  it('the next window of your own opens a fresh panel', () => {
    const fake = mount('liz');
    openWindow(fake);
    fake.emit({ type: 'action-taken', characterId: 'liz', characterName: 'Liz', action: 'She opens the drawer.' });
    openWindow(fake);
    expect(chips()).toEqual(['Open it.', 'Wait.']);
    expect(trust()).toBe('Trust: 64%');
  });
});

describe('a rejoin does not restore a closed window', () => {
  it('guidance with no open window of your own is not drawn', () => {
    const fake = mount('liz');
    fake.emit({ type: 'transcript-replay', entries: [{ type: 'resolution', text: 'The drawer sticks.' }], omitted: 0 });
    fake.emit({ type: 'phase-change', phase: 'playing' });
    fake.emit({ type: 'whisper-prompt', characterId: 'biz', characterName: 'Biz', windowMs: 30_000, remainingMs: 12_000 });
    fake.emit({ type: 'whisper-guidance', characterId: 'liz', mood: 'Liz is tense.', suggestions: ['Stale chip.'] });
    expect(chips()).toEqual([]);
    expect(mood()).toBeNull();
  });

  it('a rejoin mid-window of your own gets that window\'s chips back', () => {
    const fake = mount('liz');
    fake.emit({ type: 'phase-change', phase: 'playing' });
    fake.emit({ type: 'whisper-prompt', characterId: 'liz', characterName: 'Liz', windowMs: 30_000, remainingMs: 12_000 });
    fake.emit({ type: 'whisper-guidance', characterId: 'liz', mood: 'Liz is tense.', suggestions: ['Live chip.'] });
    expect(chips()).toEqual(['Live chip.']);
  });
});
