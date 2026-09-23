import { WsClient } from './ws-client.js';
import { renderLobby } from './lobby.js';
import { renderCharacterCreator } from './character-creator.js';
import { renderGameView } from './game-view.js';
import { renderDmLobby } from './dm-lobby.js';
import { renderWaitingRoom } from './waiting-room.js';
import { getStoredSession, saveSession, removeSession, parseRoute, setRoute } from './session-store.js';
import { renderKey, screenFor } from './render-key.js';
import type { GamePhase, TableRole } from '../shared/types.js';

const root = document.getElementById('app')!;
const ws = new WsClient();

/**
 * Routing lives here and nowhere else. Every view used to register its own
 * 'room-joined'/'phase-change' handler, so a mid-game reconnect re-fired them
 * all and wiped whatever was on screen.
 */
let currentView: string | null = null;
// `${screenFor(...)}:${joinCode}` of what is actually mounted in #app right
// now. Every mount goes through here or the phase-change/error handlers
// below, which keep it in step.
let mountedScreen: string | null = null;
let isOwner = false;
let hostTableRole: TableRole | null = null;
// The seat's own character, learned from the server (room-joined carries it
// on join/rejoin; approval sets it mid-session). game-view needs it to know
// whose whisper windows are theirs — the server routes whispers by the same
// seat binding, never by a client-claimed target (MUL-73).
let myCharacterId: string | null = null;

function renderFor(joinCode: string, campaignId: string, owner: boolean, tableRole: TableRole | null, phase: GamePhase, gameName: string): void {
  const key = renderKey(owner, tableRole, joinCode, phase);
  if (currentView === key) return; // silent reconnect — leave the screen alone
  currentView = key;
  isOwner = owner;
  hostTableRole = tableRole;

  const screen = screenFor(owner, tableRole, phase);
  const mountId = `${screen}:${joinCode}`;
  if (screen === 'dm-lobby' && mountedScreen === mountId) {
    // Same DM lobby, same game — only the table role changed. The lobby
    // repaints its role buttons from this same room-joined itself; a
    // remount would throw away the host's setup conversation with the DM
    // (the server still has it, but sends it back only on rejoin).
    return;
  }
  mountedScreen = mountId;

  if (screen === 'game-view') {
    renderGameView(root, ws, owner, myCharacterId);
  } else if (screen === 'dm-lobby') {
    renderDmLobby(root, ws, joinCode, campaignId);
  } else if (screen === 'waiting-room') {
    renderWaitingRoom(root, ws, gameName, joinCode);
  } else {
    renderCharacterCreator(root, ws, joinCode, owner);
  }
}

ws.on('room-joined', (msg) => {
  if (msg.type !== 'room-joined') return;
  ws.setSession(msg.joinCode, msg.sessionToken);
  // A rejoin mid-game carries the seat's character; a join cannot have one
  // yet, and a later approval fills it in via character-validated below.
  if (msg.characterId) myCharacterId = msg.characterId;
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

ws.on('character-validated', (msg) => {
  // Sent only to the submitting player's own socket, and only for the
  // character that player built — an approval binds the seat.
  if (msg.type !== 'character-validated' || !msg.approved) return;
  myCharacterId = msg.characterId;
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
    mountedScreen = `game-view:${joinCode}`;
    renderGameView(root, ws, isOwner, myCharacterId);
  } else if (msg.phase === 'character-creation' && (!isOwner || hostTableRole === 'player')) {
    // A host who chose to play reaches the character creator exactly like
    // any other player once the table opens — there is no DM lobby left
    // for them to keep showing.
    const key = renderKey(isOwner, hostTableRole, joinCode, 'character-creation');
    if (currentView === key) return;
    currentView = key;
    mountedScreen = `character-creator:${joinCode}`;
    renderCharacterCreator(root, ws, joinCode, isOwner);
  } else if (msg.phase === 'character-creation' && isOwner) {
    // The DM lobby is already showing (dm-chat's own done:true handling put
    // it there) — just keep currentView in sync so a later reconnect doesn't
    // think it's stale and needlessly re-render it.
    currentView = renderKey(true, hostTableRole, joinCode, 'character-creation');
  }
});

ws.on('character-revoked', (msg) => {
  // The server clears the seat's DB binding on revoke, so whispers would
  // start coming back rejected — unbind here too and the whisper box stops
  // promising a voice the table just took away.
  if (msg.type !== 'character-revoked' || msg.characterId !== myCharacterId) return;
  myCharacterId = null;
});

ws.on('error', (msg) => {
  if (msg.type !== 'error') return;
  // A dead session token means the game is gone; stop offering it.
  if (msg.message.includes('session is no longer valid')) {
    const route = parseRoute();
    if (route.view !== 'lobby') removeSession(route.joinCode, route.view === 'dm' ? 'dm' : 'player');
    setRoute({ view: 'lobby' });
    currentView = null;
    mountedScreen = null;
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
