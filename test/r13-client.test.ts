// @vitest-environment jsdom
//
// Round 13 (WXKC2C), the character creator:
//  - the readiness list stayed stale — still listing "high concept, skills,
//    stunts" after the preview came back complete;
//  - the host who chose to play read "You're running this world".
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
  name: 'Liz', highConcept: 'Unflappable Accountant Mom', trouble: 'I worry about Biz too much',
  aspects: ['Tote bag contains a granola bar', 'Tote bag contains a pen'], personality: 'Calm', backstory: '',
  skills: { Investigate: 3, Rapport: 3 }, stunts: ['Fine Print — once per scene finds a loophole in any form'], pronouns: 'she/her',
};

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
});

describe('the readiness list is refreshed on every update', () => {
  it('a complete preview after an unfinished checklist empties the list (live: it kept "high concept, skills, stunts")', () => {
    const ws = new FakeWs();
    renderCharacterCreator(root, ws as unknown as WsClient, 'WXKC2C', false);
    ws.emit({ type: 'character-readiness', readiness: { ready: false, unmet: ['highConcept', 'skills', 'stunts'], detail: ['What is this character, in a phrase? A high concept.', 'She needs at least 1 skill with a rating.', 'She needs at least 1 stunt.'] } });
    expect(root.querySelectorAll('#readiness-list li').length).toBe(3);
    ws.emit({ type: 'character-preview', definition: LIZ, readiness: { ready: true, unmet: [], detail: [] } });
    expect(root.querySelectorAll('#readiness-list li').length).toBe(0);
    expect((root.querySelector('#readiness-list') as HTMLElement).textContent).toBe('');
    expect(root.querySelector('#chat-readiness')!.classList.contains('hidden')).toBe(true);
  });

  it('a preview whose sheet still lacks something shows exactly what is left', () => {
    const ws = new FakeWs();
    renderCharacterCreator(root, ws as unknown as WsClient, 'WXKC2C', false);
    ws.emit({ type: 'character-readiness', readiness: { ready: false, unmet: ['highConcept', 'skills'], detail: ['A high concept.', 'A skill.'] } });
    ws.emit({ type: 'character-preview', definition: LIZ, readiness: { ready: false, unmet: ['skills'], detail: ['A skill.'] } });
    expect([...root.querySelectorAll('#readiness-list li')].map(li => li.textContent)).toEqual(['A skill.']);
  });
});

describe('the host\'s start hint follows their table role', () => {
  it('a host who chose to play is not told they are running the world', () => {
    const ws = new FakeWs();
    renderCharacterCreator(root, ws as unknown as WsClient, 'WXKC2C', true, 'player');
    const hint = root.querySelector('#start-game-hint')!.textContent ?? '';
    expect(hint).not.toMatch(/running this world/i);
    expect(hint).toMatch(/playing/i);
  });

  it('a host running the table keeps the old hint', () => {
    const ws = new FakeWs();
    renderCharacterCreator(root, ws as unknown as WsClient, 'WXKC2C', true, 'dm');
    expect(root.querySelector('#start-game-hint')!.textContent).toMatch(/running this world/i);
  });
});
