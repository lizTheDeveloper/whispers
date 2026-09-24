// @vitest-environment jsdom
//
// Round 18 (39PF4D): the readiness panel read "Still shaping this
// character:" over an empty list once the sheet was complete.
import { describe, it, expect, beforeEach } from 'vitest';
import { renderCharacterCreator } from '../src/client/character-creator.js';
import type { WsClient } from '../src/client/ws-client.js';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';
import type { CharacterDefinition } from '../src/shared/types.js';

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
  emit(msg: ServerMessage): void { for (const h of this.handlers.get(msg.type) ?? []) h(msg); }
}

const LIZ: CharacterDefinition = {
  name: 'Liz', highConcept: 'Unflappable Accountant Mom', trouble: 'Worries about Biz too much',
  aspects: ['Tote bag contains a pen', 'Unflappable under pressure'], personality: 'Calm', backstory: '',
  skills: { Investigate: 3 }, stunts: ['Fine Print'], pronouns: 'she/her',
};

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
});

const visible = (el: Element | null) => !!el && !el.closest('.hidden');

describe('the readiness heading', () => {
  it('shows with something still to shape, and is hidden once nothing is', () => {
    const ws = new FakeWs();
    renderCharacterCreator(root, ws as unknown as WsClient, '39PF4D', false);
    const heading = root.querySelector('.readiness-heading');
    ws.emit({ type: 'character-readiness', readiness: { ready: false, unmet: ['stunts'], detail: ['She needs at least 1 stunt.'] } });
    expect(visible(heading)).toBe(true);
    ws.emit({ type: 'character-preview', definition: LIZ, readiness: { ready: true, unmet: [], detail: [] } });
    expect(visible(heading)).toBe(false);
  });

  it('a checklist with only blank lines, or a ready sheet, shows no heading', () => {
    const ws = new FakeWs();
    renderCharacterCreator(root, ws as unknown as WsClient, '39PF4D', false);
    const heading = root.querySelector('.readiness-heading');
    ws.emit({ type: 'character-readiness', readiness: { ready: false, unmet: [], detail: ['', '  '] } });
    expect(visible(heading)).toBe(false);
    expect(root.querySelectorAll('#readiness-list li').length).toBe(0);
    ws.emit({ type: 'character-readiness', readiness: { ready: true, unmet: [], detail: ['stale line'] } });
    expect(visible(heading)).toBe(false);
  });
});
