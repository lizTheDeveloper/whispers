// @vitest-environment jsdom
//
// Task 12, Finding A + Finding C. This project deliberately has no jsdom
// configured globally (see render-key.test.ts) — routing logic gets pulled
// into pure functions instead so it's testable without a DOM. The two
// findings below are not routing logic, though: Finding A is "does a
// button exist and is it wired up correctly", and Finding C is "does an
// event handler reach into the DOM and put it back in a usable state" —
// neither has a pure-function shape to extract. This file opts into jsdom
// for itself only, via the docblock above, leaving every other test file's
// 'node' environment untouched.
import { describe, it, expect, beforeEach } from 'vitest';
import { renderCharacterCreator } from '../src/client/character-creator.js';
import type { WsClient } from '../src/client/ws-client.js';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';

/**
 * The subset of WsClient's public surface character-creator.ts actually
 * calls: on/send (every handler) and onStatus (unused here, but harmless to
 * omit since character-creator.ts never calls it). Cast to WsClient at the
 * call site rather than constructing a real one, which opens a browser
 * WebSocket this test has no server for.
 */
class FakeWs {
  sent: ClientMessage[] = [];
  private handlers = new Map<string, Array<(msg: ServerMessage) => void>>();
  send(msg: ClientMessage): void {
    this.sent.push(msg);
  }
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

describe('character-creator: host-as-player Start Game affordance (Finding A)', () => {
  // Finding A: a host who chose "I'm playing in it" lands on this screen
  // once world setup finishes and never leaves it again (main.ts stops
  // rendering the DM lobby for them the moment their table role is
  // 'player') — the DM lobby's own Start Game button is unreachable for
  // this host, and before this fix there was no other way in the UI to
  // send start-game at all.
  it('renders a Start Game button for the world author and sends start-game on click', () => {
    const fake = new FakeWs();
    renderCharacterCreator(root, fake as unknown as WsClient, 'ABCD', true);

    const btn = root.querySelector('#start-game-btn') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(false);

    btn!.click();

    expect(fake.sent).toContainEqual({ type: 'start-game' });
    expect(btn!.disabled).toBe(true);
    expect(btn!.textContent).toBe('Starting...');
  });

  // Gated on world authorship, same as the server's own isWorldAuthor gate
  // on 'start-game' — a non-owner player must never see an affordance for a
  // message the server would refuse from them.
  it('renders no Start Game button for a non-owner player', () => {
    const fake = new FakeWs();
    renderCharacterCreator(root, fake as unknown as WsClient, 'ABCD', false);
    expect(root.querySelector('#start-game-btn')).toBeNull();
  });

  // A refusal (no approved characters yet, a second click racing an
  // already-started table) must not leave the button stuck on "Starting..."
  // forever with no way to try again — the same "nobody left with no way
  // out and nothing said about it" theme this whole branch is about.
  it('re-enables the button and shows the refusal after a refused start-game', () => {
    const fake = new FakeWs();
    renderCharacterCreator(root, fake as unknown as WsClient, 'ABCD', true);
    const btn = root.querySelector('#start-game-btn') as HTMLButtonElement;

    btn.click();
    expect(btn.disabled).toBe(true);

    fake.emit({ type: 'error', message: 'You need at least one approved character before the game can start.' });

    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Start Game');
  });
});

describe('character-creator: character-revoked hands the player back a usable screen (Finding C)', () => {
  // Finding C: character-creation is the ONE phase where the server
  // actually reopens the player's interview after a revoke (see
  // src/server/index.ts's revoke-character handler) — this screen is the
  // only one ever shown during that phase, so it is the only place this
  // notice can land where the player can act on it. Before this fix there
  // was no character-revoked handler here at all, so the player saw
  // nothing and the submit button stayed stuck on "Awaiting DM review...".
  it('notifies the player and reopens the submit affordance when their OWN character is revoked', () => {
    const fake = new FakeWs();
    renderCharacterCreator(root, fake as unknown as WsClient, 'ABCD', false);

    // Teaches the screen its own character's id, exactly as a real approved
    // submission would.
    fake.emit({ type: 'character-validated', characterId: 'char-1', approved: true, feedback: 'Looks great.' });

    const submitBtn = root.querySelector('#submit-char') as HTMLButtonElement;
    // Mirrors the lockdown a real submit click leaves behind.
    submitBtn.disabled = true;
    submitBtn.textContent = 'Awaiting DM review...';

    fake.emit({ type: 'character-revoked', characterId: 'char-1', reason: 'Needs a rework' });

    const feedback = root.querySelector('#dm-feedback') as HTMLElement;
    expect(feedback.classList.contains('hidden')).toBe(false);
    expect(feedback.textContent).toMatch(/Needs a rework/);
    expect(submitBtn.disabled).toBe(false);
    expect(submitBtn.textContent).toBe('Submit to DM for Approval');
  });

  // revoke-character broadcasts to the whole room, not just the affected
  // player — this screen must not react to someone else's revoke.
  it('ignores a character-revoked broadcast for a different character', () => {
    const fake = new FakeWs();
    renderCharacterCreator(root, fake as unknown as WsClient, 'ABCD', false);

    fake.emit({ type: 'character-validated', characterId: 'char-1', approved: true, feedback: 'Looks great.' });
    const feedback = root.querySelector('#dm-feedback') as HTMLElement;
    const before = feedback.textContent;

    fake.emit({ type: 'character-revoked', characterId: 'someone-elses-character', reason: 'n/a' });

    expect(feedback.textContent).toBe(before);
  });
});
