import { WsClient } from './ws-client.js';
import { renderLobby } from './lobby.js';
import { renderCharacterCreator } from './character-creator.js';
import { renderGameView } from './game-view.js';
import { renderDmLobby } from './dm-lobby.js';
import { renderWaitingRoom } from './waiting-room.js';
import { getStoredSession, saveSession, removeSession, parseRoute, setRoute } from './session-store.js';
import { renderKey } from './render-key.js';
import type { GamePhase, TableRole } from '../shared/types.js';

const root = document.getElementById('app')!;
const ws = new WsClient();

/**
 * Routing lives here and nowhere else. Every view used to register its own
 * 'room-joined'/'phase-change' handler, so a mid-game reconnect re-fired them
 * all and wiped whatever was on screen.
 */
let currentView: string | null = null;
let isOwner = false;
let hostTableRole: TableRole | null = null;

function renderFor(joinCode: string, campaignId: string, owner: boolean, tableRole: TableRole | null, phase: GamePhase, gameName: string): void {
  const key = renderKey(owner, tableRole, joinCode, phase);
  if (currentView === key) return; // silent reconnect — leave the screen alone
  currentView = key;
  isOwner = owner;
  hostTableRole = tableRole;

  if (phase === 'playing' || phase === 'ended') {
    renderGameView(root, ws, owner);
  } else if (owner && (phase === 'lobby' || tableRole !== 'player')) {
    // The owner runs world setup from the DM lobby regardless of which
    // table role they've chosen — table role only matters for where they
    // land once the table actually opens. A host who chose to play routes
    // like any other player from here on.
    renderDmLobby(root, ws, joinCode, campaignId);
  } else if (!owner && phase === 'lobby') {
    renderWaitingRoom(root, ws, gameName, joinCode);
  } else {
    renderCharacterCreator(root, ws, joinCode, owner);
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
  renderFor(msg.joinCode, msg.campaignId, msg.isOwner, msg.tableRole, msg.phase, msg.gameName);
});

ws.on('phase-change', (msg) => {
  if (msg.type !== 'phase-change') return;
  // currentView's format is fixed by renderKey: `${dm|play}:${tableRole}:${joinCode}:${phase}`.
  const parts = currentView?.split(':') ?? [];
  const joinCode = parts[2];
  if (!joinCode) return;
  if (msg.phase === 'playing') {
    const key = renderKey(isOwner, hostTableRole, joinCode, 'playing');
    if (currentView === key) return;
    currentView = key;
    renderGameView(root, ws, isOwner);
  } else if (msg.phase === 'character-creation' && (!isOwner || hostTableRole === 'player')) {
    // A host who chose to play reaches the character creator exactly like
    // any other player once the table opens — there is no DM lobby left
    // for them to keep showing.
    const key = renderKey(isOwner, hostTableRole, joinCode, 'character-creation');
    if (currentView === key) return;
    currentView = key;
    renderCharacterCreator(root, ws, joinCode, isOwner);
  } else if (msg.phase === 'character-creation' && isOwner) {
    // The DM lobby is already showing (dm-chat's own done:true handling put
    // it there) — just keep currentView in sync so a later reconnect doesn't
    // think it's stale and needlessly re-render it.
    currentView = renderKey(true, hostTableRole, joinCode, 'character-creation');
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
