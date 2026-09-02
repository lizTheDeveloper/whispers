import type { WsClient } from './ws-client.js';

export function renderLobby(root: HTMLElement, ws: WsClient, onJoined: (campaignId: string, joinCode: string, isHost: boolean) => void): void {
  root.innerHTML = `
    <div class="lobby">
      <h1>Whispers</h1>
      <p class="subtitle">Agentic TTRPG — You are the voice in their head</p>
      <div id="ws-status" class="ws-status ws-connected">Connected</div>

      <div class="lobby-panels">
        <div class="panel">
          <h2>Create Game</h2>
          <input type="text" id="game-name" placeholder="Game name" value="A New Adventure" />
          <select id="dm-preset">
            <option value="chronicler">The Chronicler — Classic &amp; faithful</option>
            <option value="trickster">The Trickster — Chaotic &amp; surprising</option>
            <option value="professor">The Professor — Explains as you go</option>
          </select>
          <select id="system-id">
            <option value="fate-core">FATE Core (recommended)</option>
            <option value="dnd5e">D&amp;D 5e SRD (experimental)</option>
          </select>
          <select id="scenario-id">
            <option value="">No scenario — improvise</option>
            <option value="collapsed-mine">The Collapsed Mine — dungeon crawl (beginner)</option>
            <option value="haunted-masquerade">The Haunted Masquerade — social intrigue (intermediate)</option>
            <option value="clockwork-vault">The Clockwork Vault — heist (intermediate)</option>
            <option value="frontier-outpost">The Frontier Outpost — frontier diplomacy (intermediate)</option>
          </select>
          <button id="create-btn">Create Game</button>
        </div>

        <div class="panel">
          <h2>Join Game</h2>
          <input type="text" id="join-code" placeholder="Enter 6-letter code" maxlength="6" />
          <input type="text" id="player-name" placeholder="Your name" />
          <button id="join-btn">Join</button>
        </div>
      </div>
    </div>
  `;

  const createBtn = root.querySelector('#create-btn') as HTMLButtonElement;
  createBtn.addEventListener('click', () => {
    const name = (root.querySelector('#game-name') as HTMLInputElement).value.trim();
    const dmPreset = (root.querySelector('#dm-preset') as HTMLSelectElement).value;
    const systemId = (root.querySelector('#system-id') as HTMLSelectElement).value;
    const scenarioId = (root.querySelector('#scenario-id') as HTMLSelectElement).value || null;
    ws.send({ type: 'create', name, dmPreset, scenarioId, systemId, houseRules: null });
  });

  const joinBtn = root.querySelector('#join-btn') as HTMLButtonElement;
  joinBtn.addEventListener('click', () => {
    const joinCode = (root.querySelector('#join-code') as HTMLInputElement).value.trim().toUpperCase();
    const playerName = (root.querySelector('#player-name') as HTMLInputElement).value.trim() || 'Adventurer';
    ws.send({ type: 'join', joinCode, playerName });
  });

  ws.on('room-joined', (msg) => {
    if (msg.type === 'room-joined') {
      ws.setRejoinInfo(msg.joinCode, msg.isHost ? 'Host' : (root.querySelector('#player-name') as HTMLInputElement)?.value.trim() || 'Adventurer');
      onJoined(msg.campaignId, msg.joinCode, msg.isHost);
    }
  });

  ws.on('error', (msg) => {
    if (msg.type === 'error') alert(msg.message);
  });

  const statusEl = root.querySelector('#ws-status') as HTMLElement;
  const updateStatus = (connected: boolean) => {
    statusEl.textContent = connected ? 'Connected' : 'Reconnecting…';
    statusEl.className = `ws-status ${connected ? 'ws-connected' : 'ws-disconnected'}`;
    createBtn.disabled = !connected;
    joinBtn.disabled = !connected;
  };
  ws.onStatus(updateStatus);
  updateStatus(ws.connected);
}
