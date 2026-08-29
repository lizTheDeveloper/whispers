import type { WsClient } from './ws-client.js';

export function renderDmLobby(root: HTMLElement, ws: WsClient, joinCode: string, campaignId: string, onGameStart: () => void): void {
  root.innerHTML = `
    <div class="dm-lobby">
      <div class="dm-lobby-main">
        <div class="dm-chat-panel">
          <h2>Setting Up Your Game</h2>
          <div id="dm-chat-log" class="dm-chat-log"></div>
          <div class="dm-chat-input">
            <input type="text" id="dm-chat-input" placeholder="Tell the DM what kind of game you want..." />
            <label class="upload-btn ghost-btn" title="Upload rulebook or materials">
              <input type="file" id="material-upload" accept=".txt,.md,.pdf" multiple hidden />
              +
            </label>
            <button id="dm-chat-send">Send</button>
          </div>
          <div id="upload-status" class="upload-status hidden"></div>
        </div>
      </div>

      <div class="dm-lobby-sidebar">
        <div class="sidebar-section">
          <h3>Join Code</h3>
          <div class="join-code-display">${joinCode}</div>
          <button id="copy-code" class="ghost-btn">Copy code</button>
        </div>

        <div class="sidebar-section">
          <h3>Players</h3>
          <ul id="player-list">
            <li class="waiting">Waiting for players...</li>
          </ul>
        </div>

        <div id="character-submissions" class="dm-submissions"></div>

        <button id="start-game-btn" disabled>Start Game</button>
        <p class="paste-hint" id="start-hint">Chat with the DM and wait for players to join.</p>
      </div>
    </div>
  `;

  const chatLog = root.querySelector('#dm-chat-log') as HTMLElement;
  const chatInput = root.querySelector('#dm-chat-input') as HTMLInputElement;
  const chatSend = root.querySelector('#dm-chat-send') as HTMLButtonElement;
  const fileInput = root.querySelector('#material-upload') as HTMLInputElement;
  const uploadStatus = root.querySelector('#upload-status') as HTMLElement;
  const playerList = root.querySelector('#player-list') as HTMLUListElement;
  const submissions = root.querySelector('#character-submissions') as HTMLElement;
  const startBtn = root.querySelector('#start-game-btn') as HTMLButtonElement;
  const copyBtn = root.querySelector('#copy-code') as HTMLButtonElement;
  const startHint = root.querySelector('#start-hint') as HTMLElement;

  let playerCount = 0;
  let approvedCount = 0;
  let dmReady = false;

  function addChatMessage(text: string, sender: 'dm' | 'host') {
    const bubble = document.createElement('div');
    bubble.className = `dm-chat-bubble ${sender}`;
    bubble.textContent = text;
    chatLog.appendChild(bubble);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function showTyping() {
    const el = document.createElement('div');
    el.className = 'dm-chat-bubble dm typing';
    el.id = 'dm-typing';
    el.textContent = 'DM is thinking...';
    chatLog.appendChild(el);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function hideTyping() {
    const el = chatLog.querySelector('#dm-typing');
    if (el) el.remove();
  }

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    addChatMessage(text, 'host');
    chatInput.value = '';
    chatSend.disabled = true;
    showTyping();
    ws.send({ type: 'dm-chat', text });
  }

  chatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(joinCode).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy code'; }, 2000);
    });
  });

  fileInput.addEventListener('change', async () => {
    const files = fileInput.files;
    if (!files || files.length === 0) return;

    for (const file of Array.from(files)) {
      uploadStatus.classList.remove('hidden');
      uploadStatus.textContent = `Uploading ${file.name}...`;

      try {
        const buffer = await file.arrayBuffer();
        const base = location.pathname.replace(/\/+$/, '');
        const resp = await fetch(`${base}/api/campaigns/${campaignId}/materials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': file.name },
          body: buffer,
        });

        if (resp.ok) {
          const material = await resp.json();
          uploadStatus.textContent = `Uploaded ${file.name} (${material.chunkCount} chunks indexed)`;
          addChatMessage(`[Uploaded: ${file.name}]`, 'host');
        } else {
          uploadStatus.textContent = `Failed to upload ${file.name}`;
        }
      } catch {
        uploadStatus.textContent = `Upload error for ${file.name}`;
      }
    }
    fileInput.value = '';
    setTimeout(() => { uploadStatus.classList.add('hidden'); }, 4000);
  });

  ws.on('dm-chat-reply', (msg) => {
    if (msg.type !== 'dm-chat-reply') return;
    hideTyping();
    chatSend.disabled = false;
    addChatMessage(msg.text, 'dm');
    if (msg.done) {
      dmReady = true;
      updateStartButton();
    }
  });

  function updateStartButton() {
    startBtn.disabled = !dmReady;
    if (dmReady && approvedCount > 0) {
      startHint.textContent = `DM ready, ${approvedCount} character${approvedCount > 1 ? 's' : ''} approved. Let's go!`;
    } else if (dmReady) {
      startHint.textContent = 'DM is ready! Waiting for players to submit characters...';
    }
  }

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
      playerList.innerHTML = '<li class="waiting">Waiting for players...</li>';
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
    status.textContent = 'Approved';
    status.classList.add('approved');

    card.append(name, concept, status);
    submissions.appendChild(card);
    approvedCount++;
    updateStartButton();
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

  ws.on('error', (msg) => {
    if (msg.type !== 'error') return;
    hideTyping();
    chatSend.disabled = false;
  });
}
