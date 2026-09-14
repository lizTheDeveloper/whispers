import type { WsClient } from './ws-client.js';

/**
 * Shown to a player who arrives while the host is still building the world.
 * main.ts swaps this for the character creator on phase-change.
 */
export function renderWaitingRoom(root: HTMLElement, ws: WsClient, gameName: string, joinCode: string): void {
  root.innerHTML = `
    <div class="waiting-room">
      <h1 id="waiting-room-title"></h1>
      <p class="subtitle">You're in. The DM is building the world.</p>
      <div id="ws-status" class="ws-status ws-connected">Connected</div>

      <div class="panel waiting-panel">
        <div class="waiting-pulse" aria-hidden="true"></div>
        <p class="waiting-note">
          Character creation opens once the world is ready — then the DM will
          introduce you to it before you decide who you are in it.
        </p>
        <h3>At the table</h3>
        <ul id="waiting-player-list"><li class="waiting">Just you so far...</li></ul>
        <p class="paste-hint">Join code: <code>${joinCode}</code></p>
      </div>
    </div>
  `;

  (root.querySelector('#waiting-room-title') as HTMLElement).textContent = gameName || 'Whispers';

  const list = root.querySelector('#waiting-player-list') as HTMLUListElement;

  // Both 'lobby-state' (sent on join/rejoin, includes the sender) and
  // 'player-joined' (broadcast to everyone, also includes the sender) can
  // report the same player. Route both through one helper keyed on
  // dataset.name so the dedupe actually sees what got rendered — see
  // dm-lobby.ts's addPlayerToList for the same shape.
  function addPlayer(name: string) {
    if (list.querySelector(`li[data-name="${CSS.escape(name)}"]`)) return;
    const waiting = list.querySelector('.waiting');
    if (waiting) waiting.remove();
    const li = document.createElement('li');
    li.textContent = name;
    li.dataset.name = name;
    list.appendChild(li);
  }

  ws.on('lobby-state', (msg) => {
    if (msg.type !== 'lobby-state') return;
    list.innerHTML = '<li class="waiting">Just you so far...</li>';
    for (const name of msg.players) addPlayer(name);
  });

  ws.on('player-joined', (msg) => {
    if (msg.type !== 'player-joined') return;
    addPlayer(msg.playerName);
  });

  const statusEl = root.querySelector('#ws-status') as HTMLElement;
  ws.onStatus((connected) => {
    statusEl.textContent = connected ? 'Connected' : 'Reconnecting…';
    statusEl.className = `ws-status ${connected ? 'ws-connected' : 'ws-disconnected'}`;
  });
}
