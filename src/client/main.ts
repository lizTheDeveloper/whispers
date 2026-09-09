import { WsClient } from './ws-client.js';
import { renderLobby } from './lobby.js';
import { renderCharacterCreator } from './character-creator.js';
import { renderGameView } from './game-view.js';
import { renderDmLobby } from './dm-lobby.js';
import { getStoredSession, saveSession, removeSession, parseRoute, setRoute } from './session-store.js';
import type { GamePhase } from '../shared/types.js';

const root = document.getElementById('app')!;
const ws = new WsClient();

/**
 * Routing lives here and nowhere else. Every view used to register its own
 * 'room-joined'/'phase-change' handler, so a mid-game reconnect re-fired them
 * all and wiped whatever was on screen.
 */
let currentView: string | null = null;
let isHost = false;

function renderFor(joinCode: string, campaignId: string, host: boolean, phase: GamePhase): void {
  const key = `${host ? 'dm' : 'play'}:${joinCode}:${phase}`;
  if (currentView === key) return; // silent reconnect — leave the screen alone
  currentView = key;
  isHost = host;

  if (phase === 'playing' || phase === 'ended') {
    renderGameView(root, ws, host);
  } else if (host) {
    renderDmLobby(root, ws, joinCode, campaignId);
  } else {
    renderCharacterCreator(root, ws, joinCode);
  }
}

ws.on('room-joined', (msg) => {
  if (msg.type !== 'room-joined') return;
  ws.setSession(msg.joinCode, msg.sessionToken);
  saveSession({
    campaignId: msg.campaignId,
    joinCode: msg.joinCode,
    gameName: msg.gameName,
    role: msg.isHost ? 'dm' : 'player',
    playerName: msg.playerName,
    sessionToken: msg.sessionToken,
    phase: msg.phase,
    lastSeen: Date.now(),
  });
  setRoute({ view: msg.isHost ? 'dm' : 'play', joinCode: msg.joinCode });
  renderFor(msg.joinCode, msg.campaignId, msg.isHost, msg.phase);
});

ws.on('phase-change', (msg) => {
  if (msg.type !== 'phase-change') return;
  if (msg.phase !== 'playing') return;
  if (currentView?.endsWith(':playing')) return;
  const [, joinCode] = currentView?.split(':') ?? [];
  if (!joinCode) return;
  currentView = `${isHost ? 'dm' : 'play'}:${joinCode}:playing`;
  renderGameView(root, ws, isHost);
});

ws.on('error', (msg) => {
  if (msg.type !== 'error') return;
  // A dead session token means the game is gone; stop offering it.
  if (msg.message.includes('session is no longer valid')) {
    const route = parseRoute();
    if (route.view !== 'lobby') removeSession(route.joinCode, route.view === 'dm' ? 'dm' : 'player');
    setRoute({ view: 'lobby' });
    currentView = null;
    renderLobby(root, ws);
  }
});

async function init() {
  await ws.connect();

  const route = parseRoute();
  if (route.view === 'lobby') {
    renderLobby(root, ws);
    return;
  }

  const stored = getStoredSession(route.joinCode, route.view === 'dm' ? 'dm' : 'player');
  if (stored) {
    root.innerHTML = `<div class="lobby"><h1>Whispers</h1><p class="subtitle">Rejoining ${stored.gameName}…</p></div>`;
    ws.setSession(stored.joinCode, stored.sessionToken);
    ws.send({ type: 'rejoin', joinCode: stored.joinCode, sessionToken: stored.sessionToken });
    return;
  }

  // Someone opened a shared link on a device that has never been in this game.
  // We can't prove they're the DM, so send them through the join form.
  renderLobby(root, ws, route.joinCode);
}

init().catch(console.error);
