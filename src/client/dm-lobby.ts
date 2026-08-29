import type { WsClient } from './ws-client.js';

export function renderDmLobby(root: HTMLElement, ws: WsClient, joinCode: string, onGameStart: () => void): void {
  root.innerHTML = `
    <div class="character-creator">
      <h2>You are the Dungeon Master</h2>
      <p>Share this code with your players: <strong class="join-code-display">${joinCode}</strong></p>
      <button id="copy-code" class="ghost-btn">Copy code</button>

      <div class="dm-player-list">
        <h3>Players</h3>
        <ul id="player-list">
          <li class="waiting">Waiting for players to join...</li>
        </ul>
      </div>

      <div id="character-submissions" class="dm-submissions"></div>

      <button id="start-game-btn" disabled>Start Game</button>
      <p class="paste-hint" id="start-hint">At least one player must submit a character before starting.</p>
    </div>
  `;

  const playerList = root.querySelector('#player-list') as HTMLUListElement;
  const submissions = root.querySelector('#character-submissions') as HTMLElement;
  const startBtn = root.querySelector('#start-game-btn') as HTMLButtonElement;
  const copyBtn = root.querySelector('#copy-code') as HTMLButtonElement;
  const startHint = root.querySelector('#start-hint') as HTMLElement;

  let playerCount = 0;
  let approvedCount = 0;

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(joinCode).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy code'; }, 2000);
    });
  });

  ws.on('player-joined', (msg) => {
    if (msg.type !== 'player-joined') return;
    playerCount++;
    const waiting = playerList.querySelector('.waiting');
    if (waiting) waiting.remove();
    const li = document.createElement('li');
    li.textContent = msg.playerName;
    li.dataset.name = msg.playerName;
    playerList.appendChild(li);
  });

  ws.on('player-left', (msg) => {
    if (msg.type !== 'player-left') return;
    playerCount--;
    const li = playerList.querySelector(`li[data-name="${msg.playerName}"]`);
    if (li) li.remove();
    if (playerCount === 0) {
      playerList.innerHTML = '<li class="waiting">Waiting for players to join...</li>';
    }
  });

  ws.on('character-submitted', (msg) => {
    if (msg.type !== 'character-submitted') return;
    const card = document.createElement('div');
    card.className = 'dm-char-card';
    card.dataset.charId = msg.characterId;

    const name = document.createElement('strong');
    name.textContent = msg.definition.name;
    const concept = document.createElement('span');
    concept.className = 'dm-char-concept';
    concept.textContent = msg.definition.highConcept;
    const status = document.createElement('span');
    status.className = 'dm-char-status';
    status.textContent = 'Awaiting approval...';

    card.append(name, concept, status);
    submissions.appendChild(card);
  });

  ws.on('character-validated', (msg) => {
    if (msg.type !== 'character-validated') return;
    const card = submissions.querySelector(`[data-char-id="${msg.characterId}"]`);
    if (!card) return;
    const status = card.querySelector('.dm-char-status');
    if (status) {
      if (msg.approved) {
        status.textContent = 'Approved';
        status.classList.add('approved');
        approvedCount++;
        startBtn.disabled = false;
        startHint.textContent = `${approvedCount} character${approvedCount > 1 ? 's' : ''} ready.`;
      } else {
        status.textContent = `Rejected: ${msg.feedback}`;
        status.classList.add('rejected');
      }
    }
  });

  startBtn.addEventListener('click', () => {
    ws.send({ type: 'start-game' });
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';
  });

  ws.on('phase-change', (msg) => {
    if (msg.type === 'phase-change' && msg.phase === 'playing') {
      onGameStart();
    }
  });
}
