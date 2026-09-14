import { WsClient } from './ws-client.js';
import { renderLobby } from './lobby.js';
import { renderCharacterCreator } from './character-creator.js';
import { renderGameView } from './game-view.js';
import { renderDmLobby } from './dm-lobby.js';
import { renderWaitingRoom } from './waiting-room.js';
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
let isOwner = false;

function renderFor(joinCode: string, campaignId: string, owner: boolean, phase: GamePhase, gameName: string): void {
  const key = `${owner ? 'dm' : 'play'}:${joinCode}:${phase}`;
  if (currentView === key) return; // silent reconnect — leave the screen alone
  currentView = key;
  isOwner = owner;

  if (phase === 'playing' || phase === 'ended') {
    renderGameView(root, ws, owner);
  } else if (owner) {
    renderDmLobby(root, ws, joinCode, campaignId);
  } else if (phase === 'lobby') {
    renderWaitingRoom(root, ws, gameName, joinCode);
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
    role: msg.isOwner ? 'dm' : 'player',
    playerName: msg.playerName,
    sessionToken: msg.sessionToken,
    phase: msg.phase,
    lastSeen: Date.now(),
  });
  setRoute({ view: msg.isOwner ? 'dm' : 'play', joinCode: msg.joinCode });
  renderFor(msg.joinCode, msg.campaignId, msg.isOwner, msg.phase, msg.gameName);
});

ws.on('phase-change', (msg) => {
  if (msg.type !== 'phase-change') return;
  const parts = currentView?.split(':') ?? [];
  const joinCode = parts[1];
  if (!joinCode) return;
  if (msg.phase === 'playing') {
    if (currentView?.endsWith(':playing')) return;
    currentView = `${isOwner ? 'dm' : 'play'}:${joinCode}:playing`;
    renderGameView(root, ws, isOwner);
  } else if (msg.phase === 'character-creation' && !isOwner) {
    if (currentView?.endsWith(':character-creation')) return;
    currentView = `play:${joinCode}:character-creation`;
    renderCharacterCreator(root, ws, joinCode);
  } else if (msg.phase === 'character-creation' && isOwner) {
    // The DM lobby is already showing (dm-chat's own done:true handling put
    // it there) — just keep currentView in sync so a later reconnect doesn't
    // think it's stale and needlessly re-render it.
    currentView = `dm:${joinCode}:character-creation`;
  }
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
    root.innerHTML = `<div class="lobby"><h1>Whispers</h1><p class="subtitle" id="rejoin-subtitle"></p></div>`;
    (root.querySelector('#rejoin-subtitle') as HTMLElement).textContent = `Rejoining ${stored.gameName}…`;
    ws.setSession(stored.joinCode, stored.sessionToken);
    ws.send({ type: 'rejoin', joinCode: stored.joinCode, sessionToken: stored.sessionToken });
    return;
  }

  // Someone opened a shared link on a device that has never been in this game.
  // We can't prove they're the DM, so send them through the join form.
  renderLobby(root, ws, route.joinCode);
}

init().catch(console.error);
