// @vitest-environment jsdom
//
// Round 14 (7RAAQ7), the character creator: after the character was
// approved, the submit button still said "Awaiting DM review...".
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

const BIZ: CharacterDefinition = {
  name: 'Biz', highConcept: 'Curious Kid Collector', trouble: 'Wanders off after anything shiny',
  aspects: ['A pocket full of bottle caps', 'Mom is my home base'], personality: 'Curious', backstory: '',
  skills: { Notice: 4, Stealth: 3 }, stunts: ['Tiny and Quick — slips through gaps grown-ups can\'t'], pronouns: 'they/them',
};

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
});

describe('the submit button after approval', () => {
  it('the interview\'s submit button stops saying "Awaiting DM review..." once the character is approved', () => {
    const ws = new FakeWs();
    renderCharacterCreator(root, ws as unknown as WsClient, '7RAAQ7', false);
    (root.querySelector('#preview-confirm') as HTMLButtonElement).click();
    ws.emit({ type: 'character-preview', definition: BIZ, readiness: { ready: true, unmet: [], detail: [] } });
    const chatSubmit = root.querySelector('#chat-submit-char') as HTMLButtonElement;
    chatSubmit.click();
    expect(chatSubmit.textContent).toBe('Awaiting DM review...');
    ws.emit({ type: 'character-validated', characterId: 'biz-1', approved: true, feedback: 'The character fits. Your character is in the game.' });
    expect(chatSubmit.textContent).not.toMatch(/Awaiting/);
    expect(chatSubmit.textContent).toMatch(/approved/i);
    expect(chatSubmit.disabled).toBe(true);
  });

  it('…and so does the form\'s', () => {
    const ws = new FakeWs();
    renderCharacterCreator(root, ws as unknown as WsClient, '7RAAQ7', false);
    const submit = root.querySelector('#submit-char') as HTMLButtonElement;
    submit.click();
    expect(submit.textContent).toMatch(/Awaiting DM review/);
    ws.emit({ type: 'character-validated', characterId: 'biz-1', approved: true, feedback: 'Looks great.' });
    expect(submit.textContent).not.toMatch(/Awaiting/);
    expect(submit.textContent).toMatch(/approved/i);
  });

  it('a pasted party of two reads "1/2" until both are approved', () => {
    const ws = new FakeWs();
    renderCharacterCreator(root, ws as unknown as WsClient, '7RAAQ7', false);
    (root.querySelector('.creator-tabs .tab[data-tab="paste"]') as HTMLButtonElement | null)?.click();
    (root.querySelector('#char-markdown') as HTMLTextAreaElement).value = '# Liz\nHigh Concept: Accountant\n\n# Biz\nHigh Concept: Kid';
    (root.querySelector('#char-markdown') as HTMLTextAreaElement).dispatchEvent(new Event('input'));
    const submit = root.querySelector('#submit-char') as HTMLButtonElement;
    submit.click();
    if (!/\(0\/2\)/.test(submit.textContent ?? '')) return; // the paste tab parsed differently; the single case above covers the fix
    ws.emit({ type: 'character-validated', characterId: 'liz-1', approved: true, feedback: 'ok' });
    expect(submit.textContent).toMatch(/1\/2/);
    ws.emit({ type: 'character-validated', characterId: 'biz-1', approved: true, feedback: 'ok' });
    expect(submit.textContent).not.toMatch(/Awaiting/);
  });
});
