import type { WsClient } from './ws-client.js';
import { loadSessions, removeSession, type StoredSession } from './session-store.js';

function relativeTime(ts: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function renderYourGames(container: HTMLElement): void {
  const sessions = loadSessions();
  container.innerHTML = '';
  if (sessions.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  const heading = document.createElement('h2');
  heading.textContent = 'Your Games';
  container.appendChild(heading);

  const hint = document.createElement('p');
  hint.className = 'paste-hint';
  hint.textContent = 'Saved on this browser. Resume where you left off.';
  container.appendChild(hint);

  const list = document.createElement('ul');
  list.className = 'saved-game-list';

  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = 'saved-game';

    const link = document.createElement('a');
    link.className = 'saved-game-link';
    link.href = `#/${s.role === 'dm' ? 'dm' : 'play'}/${s.joinCode}`;
    // A hash change alone won't re-run init(), so reload into the new route.
    link.addEventListener('click', () => { setTimeout(() => location.reload(), 0); });

    const name = document.createElement('strong');
    name.textContent = s.gameName || 'Untitled game';
    const meta = document.createElement('span');
    meta.className = 'saved-game-meta';
    const roleLabel = s.role === 'dm' ? 'DM' : `Playing as ${s.playerName}`;
    meta.textContent = `${roleLabel} · ${s.joinCode} · ${relativeTime(s.lastSeen)}`;
    link.append(name, meta);

    const forget = document.createElement('button');
    forget.className = 'ghost-btn forget-btn';
    forget.textContent = 'Forget';
    forget.title = 'Remove this game from this browser';
    forget.addEventListener('click', (e) => {
      e.preventDefault();
      removeSession(s.joinCode, s.role);
      renderYourGames(container);
    });

    li.append(link, forget);
    list.appendChild(li);
  }
  container.appendChild(list);
}

export function renderLobby(root: HTMLElement, ws: WsClient, prefillJoinCode?: string): void {
  root.innerHTML = `
    <div class="lobby">
      <h1>Whispers</h1>
      <p class="subtitle">Agentic TTRPG — You are the voice in their head</p>
      <div id="ws-status" class="ws-status ws-connected">Connected</div>
      <div id="lobby-error" class="lobby-error hidden"></div>

      <div id="your-games" class="panel saved-games hidden"></div>

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
          <input type="text" id="join-code" placeholder="Enter 6-letter code" maxlength="6" value="${prefillJoinCode ?? ''}" />
          <input type="text" id="player-name" placeholder="Your name" />
          <button id="join-btn">Join</button>
        </div>
      </div>
    </div>
  `;

  renderYourGames(root.querySelector('#your-games') as HTMLElement);

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

  // room-joined is handled centrally in main.ts, which owns view routing.
  // This handler stays registered on the shared ws instance for the life of the
  // app (WsClient has no off()), so it keeps firing for errors from whatever view
  // is on screen later — a blocking alert() here would pop up over the DM lobby or
  // the game view too. Surface it in-page instead: createElement/textContent only,
  // never innerHTML, since localStorage holds bearer session tokens and this text
  // comes from the server.
  const lobbyError = root.querySelector('#lobby-error') as HTMLElement;
  ws.on('error', (msg) => {
    if (msg.type !== 'error') return;
    lobbyError.textContent = msg.message;
    lobbyError.classList.remove('hidden');
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
