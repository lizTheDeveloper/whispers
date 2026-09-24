// @vitest-environment jsdom
//
// "render the markdown or tell them not to use it": model text (narration,
// actions, thoughts, options, chat replies) showed raw **asterisks**. The
// client now renders a small, safe subset of markdown — DOM nodes only, never
// innerHTML, because localStorage holds bearer session tokens.
import { describe, it, expect, beforeEach } from 'vitest';
import { appendMarkdown, stripMarkdown } from '../src/client/markdown.js';
import { renderGameView } from '../src/client/game-view.js';
import type { WsClient } from '../src/client/ws-client.js';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';

function render(text: string): HTMLElement {
  const el = document.createElement('div');
  appendMarkdown(el, text);
  return el;
}

describe('safe markdown renderer', () => {
  it('renders **bold**, *italic*, _italic_ and `code` as elements', () => {
    const el = render('The **iron door** is *cold* and _wet_; the plate reads `NO ENTRY`.');
    expect(el.querySelector('strong')!.textContent).toBe('iron door');
    expect(Array.from(el.querySelectorAll('em')).map(e => e.textContent)).toEqual(['cold', 'wet']);
    expect(el.querySelector('code')!.textContent).toBe('NO ENTRY');
    expect(el.textContent).toBe('The iron door is cold and wet; the plate reads NO ENTRY.');
  });

  it('renders bullet and numbered lists as lists, and headings as a bold line', () => {
    const el = render('## What you see\n\n- a lamp\n- a **ledger**\n\n1. run\n2. hide');
    const heading = el.querySelector('p > strong');
    expect(heading!.textContent).toBe('What you see');
    expect(el.textContent).not.toContain('#');
    const ul = el.querySelector('ul')!;
    expect(Array.from(ul.querySelectorAll('li')).map(li => li.textContent)).toEqual(['a lamp', 'a ledger']);
    expect(ul.querySelector('strong')!.textContent).toBe('ledger');
    const ol = el.querySelector('ol')!;
    expect(Array.from(ol.querySelectorAll('li')).map(li => li.textContent)).toEqual(['run', 'hide']);
  });

  it('keeps paragraphs and line breaks', () => {
    const el = render('First line\nsecond line\n\nNew paragraph.');
    const ps = el.querySelectorAll('p');
    expect(ps).toHaveLength(2);
    expect(ps[0]!.querySelector('br')).not.toBeNull();
    expect(ps[1]!.textContent).toBe('New paragraph.');
  });

  it('a single plain paragraph gets no wrapper, so one-line entries read as before', () => {
    const el = render('Rain on the glass.');
    expect(el.children).toHaveLength(0);
    expect(el.textContent).toBe('Rain on the glass.');
  });

  it('renders HTML in model text as literal text — no element is ever injected', () => {
    const hostile = '<script>alert(1)</script> **<img src=x onerror=alert(1)>** <b>bold?</b>';
    const el = render(hostile);
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toContain('<script>alert(1)</script>');
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    // The bold still renders, with the tag inside it as text.
    expect(el.querySelector('strong')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('leaves stray marks and snake_case alone', () => {
    const el = render('2 * 3 = 6 and file_name_here stays');
    expect(el.querySelector('em')).toBeNull();
    expect(el.textContent).toBe('2 * 3 = 6 and file_name_here stays');
  });

  it('stripMarkdown gives the plain words for buttons and inputs', () => {
    expect(stripMarkdown('Do it — **grab** the *ledger*.')).toBe('Do it — grab the ledger.');
  });
});

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

describe('game view renders model text through the renderer', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  it('narration, actions, thoughts, resolutions and options show formatting, not asterisks', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false, 'c1');
    fake.emit({ type: 'narration', text: 'The **Lamp Room** hums.', sceneNumber: 1 });
    fake.emit({ type: 'action-proposals', characterId: 'c1', characterName: 'Liz', actions: ['Open the *drawer*'], actionReasons: ['It is **marked**'], whisperTrust: 0.5 });
    const proposals = root.querySelector('.action-proposals') as HTMLElement;
    expect(proposals.textContent).not.toContain('*');
    expect(proposals.querySelector('li > em')!.textContent).toBe('drawer');
    expect(proposals.querySelector('.action-reason strong')!.textContent).toBe('marked');

    fake.emit({ type: 'action-taken', characterId: 'c1', characterName: 'Liz', action: 'She opens the *drawer*.', spokenWords: '**Now.**' });
    fake.emit({ type: 'character-thought', characterId: 'c1', characterName: 'Liz', innerThought: 'Here *goes*.', whisperInfluence: 'none' });
    fake.emit({ type: 'resolution', text: 'It **sticks**, then gives.' });

    const log = root.querySelector('#narration-log') as HTMLElement;
    expect(log.textContent).not.toContain('*');
    expect(Array.from(log.querySelectorAll('strong')).map(s => s.textContent)).toEqual(['Lamp Room', 'Now.', 'sticks']);
    expect(Array.from(log.querySelectorAll('em')).map(s => s.textContent)).toEqual(['drawer', 'goes']);
    const character = log.querySelector('.character')!;
    expect(character.textContent).toBe('Liz: She opens the drawer.');
    expect(log.querySelector('.dialogue')!.textContent).toBe('"Now."');
    expect(log.querySelector('.whisper')!.textContent).toBe('(Here goes.)');
  });

  it('a <script> in narration is text, not an element', () => {
    const fake = new FakeWs();
    renderGameView(root, fake as unknown as WsClient, false);
    fake.emit({ type: 'narration', text: '<script>window.__pwned = 1</script> The door **opens**.', sceneNumber: 1 });
    const log = root.querySelector('#narration-log') as HTMLElement;
    expect(log.querySelector('script')).toBeNull();
    expect(log.textContent).toContain('<script>window.__pwned = 1</script>');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
