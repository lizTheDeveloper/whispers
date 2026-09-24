// @vitest-environment jsdom
//
// Round 8, live finding 10: the host's world review card showed every NPC's
// motive ("wants: …") and the plot hooks to a host who had chosen "I'm
// playing in it" or asked for no spoilers. For those hosts the card shows the
// premise, the places, and the people's names and roles only; a DM host who
// did not ask keeps the full card.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';

class FakeWs {
  static instance: FakeWs | null = null;
  sent: ClientMessage[] = [];
  private handlers = new Map<string, Array<(msg: ServerMessage) => void>>();
  constructor() { FakeWs.instance = this; }
  connect(): Promise<void> { return Promise.resolve(); }
  setSession(): void {}
  send(msg: ClientMessage): void { this.sent.push(msg); }
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

const SEED = {
  premise: 'A family wakes in the Registry of the Departed.',
  locations: [{ name: 'The Grand Registry Hall', description: 'Endless desks under a paper sky.', terrain: 'interior' }],
  npcs: [
    { name: 'Lady Vex', description: 'Chief Registrar, brass ruler in hand', disposition: 'stern', motivation: 'Keep the family from ever leaving the Registry' },
    { name: 'Odo', description: 'A clerk in a stormcloud coat', disposition: 'nervous', motivation: 'Hide the form he misfiled' },
  ],
  plotHooks: ['A red form keeps reappearing on the conveyor belt.'],
  items: [],
};

function roomJoined(tableRole: 'dm' | 'player' | null): ServerMessage {
  return { type: 'room-joined', campaignId: 'camp-1', joinCode: 'ABCD', isOwner: true, tableRole, sessionToken: 'tok', gameName: 'Registry', playerName: 'Host', phase: 'lobby', characterId: null };
}

const card = () => document.querySelector('#world-seed-panel')!.textContent ?? '';

async function mount(role: 'dm' | 'player' | null, hostSays?: string) {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  await import('../src/client/main.js');
  const ws = FakeWs.instance!;
  ws.emit(roomJoined(role));
  if (hostSays) {
    (document.querySelector('#dm-chat-input') as HTMLInputElement).value = hostSays;
    (document.querySelector('#dm-chat-send') as HTMLButtonElement).click();
    ws.emit({ type: 'dm-chat-reply', text: 'Understood.', done: false });
  }
  ws.emit({ type: 'world-seed-draft', accepted: false, seed: SEED } as ServerMessage);
  return ws;
}

describe('the host\'s world card', () => {
  beforeEach(() => { FakeWs.instance = null; });

  it('a playing host: premise, places, names and roles — no motives, no plot hooks', async () => {
    await mount('player');
    const text = card();
    expect(text).toContain('A family wakes in the Registry of the Departed.');
    expect(text).toContain('The Grand Registry Hall');
    expect(text).toContain('Lady Vex');
    expect(text).toContain('Chief Registrar, brass ruler in hand');
    expect(text).not.toContain('Keep the family from ever leaving');
    expect(text).not.toContain('wants:');
    expect(text).not.toContain('A red form keeps reappearing');
    expect(text).not.toContain('Plot Hooks');
  });

  it('a DM host who asked for no spoilers: the same', async () => {
    await mount('dm', "No spoilers for me please, I'd like to be surprised.");
    const text = card();
    expect(text).not.toContain('Hide the form he misfiled');
    expect(text).not.toContain('A red form keeps reappearing');
    expect(text).toContain('Odo');
  });

  it('a DM host who did not ask keeps the whole card', async () => {
    await mount('dm', 'A cozy bureaucratic afterlife, please.');
    const text = card();
    expect(text).toContain('wants: Keep the family from ever leaving the Registry');
    expect(text).toContain('A red form keeps reappearing on the conveyor belt.');
  });

  it('switching to "I\'m playing in it" hides them on the card already shown', async () => {
    const ws = await mount('dm');
    expect(card()).toContain('Hide the form he misfiled');
    ws.emit(roomJoined('player'));
    expect(card()).not.toContain('Hide the form he misfiled');
  });
});
