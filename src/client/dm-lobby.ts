import type { WsClient } from './ws-client.js';
import { renderNegotiationChat } from './negotiation-chat.js';
import { dmUrl, playUrl } from './session-store.js';
import type { GamePhase, TableRole, WorldReadiness, WorldSeed, WorldSeedItem, WorldSeedLocation, WorldSeedNpc } from '../shared/types.js';

/** Mirrors MIN_INFLUENCES in src/server/world-readiness.ts — display only, the server owns the actual gate. */
const MIN_INFLUENCES = 3;

export function renderDmLobby(root: HTMLElement, ws: WsClient, joinCode: string, campaignId: string): void {
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

        <div id="world-seed-panel" class="world-seed-panel hidden"></div>
      </div>

      <div class="dm-lobby-sidebar">
        <div class="sidebar-section" id="table-role-section">
          <h3>Table Role</h3>
          <div class="role-buttons">
            <button id="role-dm-btn" class="role-btn ghost-btn">I'm running this game</button>
            <button id="role-player-btn" class="role-btn ghost-btn">I'm playing in it</button>
          </div>
          <p class="role-current" id="role-current-line"></p>
        </div>

        <div class="sidebar-section">
          <h3 id="influences-heading">Influences</h3>
          <ul id="influence-list" class="influence-list"></ul>
        </div>

        <div class="sidebar-section">
          <h3>Readiness</h3>
          <ul id="readiness-list" class="readiness-list"></ul>
        </div>

        <div class="sidebar-section">
          <h3>Join Code</h3>
          <div class="join-code-display">${joinCode}</div>
          <button id="copy-code" class="ghost-btn">Copy code</button>
        </div>

        <div class="sidebar-section">
          <h3>Your DM Link</h3>
          <p class="paste-hint">Bookmark this — it brings you back to this chair.</p>
          <input type="text" id="dm-link" class="link-field" readonly value="${dmUrl(joinCode)}" />
          <button id="copy-dm-link" class="ghost-btn">Copy DM link</button>
        </div>

        <div class="sidebar-section">
          <h3>Player Link</h3>
          <p class="paste-hint">Send this to your players.</p>
          <input type="text" id="player-link" class="link-field" readonly value="${playUrl(joinCode)}" />
          <button id="copy-player-link" class="ghost-btn">Copy player link</button>
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
  const copyDmLinkBtn = root.querySelector('#copy-dm-link') as HTMLButtonElement;
  const copyPlayerLinkBtn = root.querySelector('#copy-player-link') as HTMLButtonElement;
  const startHint = root.querySelector('#start-hint') as HTMLElement;

  const tableRoleSection = root.querySelector('#table-role-section') as HTMLElement;
  const roleDmBtn = root.querySelector('#role-dm-btn') as HTMLButtonElement;
  const rolePlayerBtn = root.querySelector('#role-player-btn') as HTMLButtonElement;
  const roleCurrentLine = root.querySelector('#role-current-line') as HTMLElement;
  const influencesHeading = root.querySelector('#influences-heading') as HTMLElement;
  const influenceList = root.querySelector('#influence-list') as HTMLUListElement;
  const readinessList = root.querySelector('#readiness-list') as HTMLUListElement;
  const seedPanel = root.querySelector('#world-seed-panel') as HTMLElement;

  let playerCount = 0;
  let approvedCount = 0;
  let dmReady = false;
  let uploadToken = '';
  let phase: GamePhase = 'lobby';
  let hostTableRole: TableRole | null = null;
  let currentSeed: WorldSeed | null = null;

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

  function wireCopy(btn: HTMLButtonElement, value: string, label: string) {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(value).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = label; }, 2000);
      }).catch(() => { btn.textContent = 'Copy failed'; });
    });
  }
  wireCopy(copyBtn, joinCode, 'Copy code');
  wireCopy(copyDmLinkBtn, dmUrl(joinCode), 'Copy DM link');
  wireCopy(copyPlayerLinkBtn, playUrl(joinCode), 'Copy player link');

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
          headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': file.name, 'X-Upload-Token': uploadToken },
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

  ws.on('dm-settings', (msg) => {
    if (msg.type === 'dm-settings') uploadToken = msg.uploadToken;
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

  // ─── Table role ───

  function renderTableRole() {
    roleDmBtn.classList.toggle('active', hostTableRole === 'dm');
    rolePlayerBtn.classList.toggle('active', hostTableRole === 'player');
    if (hostTableRole === 'dm') {
      roleCurrentLine.textContent = "You're running this game — the seat at the head of the table.";
    } else if (hostTableRole === 'player') {
      roleCurrentLine.textContent = "You're playing in it — the AI DM runs the table.";
    } else {
      roleCurrentLine.textContent = 'Choose your seat before the table opens.';
    }
  }

  function updateTableRoleVisibility() {
    tableRoleSection.classList.toggle('hidden', phase !== 'lobby');
  }

  roleDmBtn.addEventListener('click', () => ws.send({ type: 'choose-table-role', role: 'dm' }));
  rolePlayerBtn.addEventListener('click', () => ws.send({ type: 'choose-table-role', role: 'player' }));

  ws.on('room-joined', (msg) => {
    if (msg.type !== 'room-joined') return;
    hostTableRole = msg.tableRole;
    renderTableRole();
  });

  // ─── Influences ───

  function renderInfluences(influences: string[]) {
    influencesHeading.textContent = `Influences (${influences.length}/${MIN_INFLUENCES})`;
    influenceList.replaceChildren();
    if (influences.length === 0) {
      const li = document.createElement('li');
      li.className = 'influence-empty';
      li.textContent = 'None named yet — the DM will ask.';
      influenceList.appendChild(li);
      return;
    }
    for (const influence of influences) {
      const li = document.createElement('li');
      li.textContent = influence;
      influenceList.appendChild(li);
    }
  }

  // ─── Readiness ───

  function renderReadiness(readiness: WorldReadiness | null) {
    readinessList.replaceChildren();
    if (!readiness) {
      const li = document.createElement('li');
      li.className = 'readiness-item';
      li.textContent = 'Keep chatting with the DM to get the world moving.';
      readinessList.appendChild(li);
      return;
    }
    if (readiness.ready) {
      const li = document.createElement('li');
      li.className = 'readiness-met';
      li.textContent = 'Ready to open the table';
      readinessList.appendChild(li);
      return;
    }
    for (const line of readiness.detail) {
      const li = document.createElement('li');
      li.className = 'readiness-item';
      li.textContent = line;
      readinessList.appendChild(li);
    }
  }

  // ─── World seed review panel ───

  function buildSeedList<T>(title: string, items: T[], renderItem: (item: T) => HTMLLIElement): HTMLElement {
    const section = document.createElement('div');
    section.className = 'seed-section';
    const h3 = document.createElement('h3');
    h3.textContent = title;
    section.appendChild(h3);
    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'seed-empty';
      empty.textContent = 'None yet.';
      section.appendChild(empty);
      return section;
    }
    const ul = document.createElement('ul');
    for (const item of items) ul.appendChild(renderItem(item));
    section.appendChild(ul);
    return section;
  }

  function locationItem(loc: WorldSeedLocation): HTMLLIElement {
    const li = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = loc.name;
    li.appendChild(strong);
    const desc = document.createElement('span');
    desc.textContent = loc.terrain ? ` — ${loc.description} (${loc.terrain})` : ` — ${loc.description}`;
    li.appendChild(desc);
    return li;
  }

  function npcItem(npc: WorldSeedNpc): HTMLLIElement {
    const li = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = npc.name;
    li.appendChild(strong);
    const desc = document.createElement('span');
    desc.textContent = ` — ${npc.description}`;
    li.appendChild(desc);
    const metaParts: string[] = [];
    if (npc.disposition) metaParts.push(`disposition: ${npc.disposition}`);
    if (npc.motivation) metaParts.push(`wants: ${npc.motivation}`);
    if (metaParts.length > 0) {
      const meta = document.createElement('span');
      meta.className = 'seed-npc-meta';
      meta.textContent = ` (${metaParts.join('; ')})`;
      li.appendChild(meta);
    }
    return li;
  }

  function plotHookItem(hook: string): HTMLLIElement {
    const li = document.createElement('li');
    li.textContent = hook;
    return li;
  }

  function itemItem(item: WorldSeedItem): HTMLLIElement {
    const li = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = item.name;
    li.appendChild(strong);
    const desc = document.createElement('span');
    desc.textContent = ` — ${item.description}`;
    li.appendChild(desc);
    return li;
  }

  function renderSeed(seed: WorldSeed, accepted: boolean) {
    currentSeed = seed;
    seedPanel.classList.remove('hidden');
    seedPanel.replaceChildren();

    const heading = document.createElement('h2');
    heading.textContent = 'The World';
    seedPanel.appendChild(heading);

    const premise = document.createElement('p');
    premise.className = 'seed-premise';
    premise.textContent = seed.premise;
    seedPanel.appendChild(premise);

    seedPanel.appendChild(buildSeedList('Locations', seed.locations, locationItem));
    seedPanel.appendChild(buildSeedList('NPCs', seed.npcs, npcItem));
    seedPanel.appendChild(buildSeedList('Plot Hooks', seed.plotHooks, plotHookItem));
    seedPanel.appendChild(buildSeedList('Items', seed.items, itemItem));

    const actions = document.createElement('div');
    actions.className = 'seed-actions';

    if (accepted) {
      const confirm = document.createElement('p');
      confirm.className = 'seed-accepted-line';
      confirm.textContent = 'World accepted — the table is open.';
      actions.appendChild(confirm);
    } else {
      const noteRow = document.createElement('div');
      noteRow.className = 'seed-note-row';
      const noteInput = document.createElement('input');
      noteInput.type = 'text';
      noteInput.id = 'seed-note-input';
      noteInput.placeholder = "Optional note for the redraft (e.g. 'more grounded, less magic')";
      noteRow.appendChild(noteInput);
      actions.appendChild(noteRow);

      const btnRow = document.createElement('div');
      btnRow.className = 'seed-buttons';

      const acceptBtn = document.createElement('button');
      acceptBtn.id = 'accept-seed-btn';
      acceptBtn.textContent = 'Accept this world';
      acceptBtn.addEventListener('click', () => {
        if (!currentSeed) return;
        acceptBtn.disabled = true;
        redraftBtn.disabled = true;
        ws.send({ type: 'accept-world-seed', seed: currentSeed });
      });

      const redraftBtn = document.createElement('button');
      redraftBtn.id = 'redraft-seed-btn';
      redraftBtn.className = 'ghost-btn';
      redraftBtn.textContent = 'Draft it again';
      redraftBtn.addEventListener('click', () => {
        acceptBtn.disabled = true;
        redraftBtn.disabled = true;
        redraftBtn.textContent = 'Drafting...';
        const note = noteInput.value.trim();
        ws.send({ type: 'regenerate-world-seed', note: note.length > 0 ? note : undefined });
      });

      btnRow.append(acceptBtn, redraftBtn);
      actions.appendChild(btnRow);
    }

    seedPanel.appendChild(actions);
  }

  function resetSeedButtons() {
    const acceptBtn = seedPanel.querySelector('#accept-seed-btn') as HTMLButtonElement | null;
    const redraftBtn = seedPanel.querySelector('#redraft-seed-btn') as HTMLButtonElement | null;
    if (acceptBtn) acceptBtn.disabled = false;
    if (redraftBtn) { redraftBtn.disabled = false; redraftBtn.textContent = 'Draft it again'; }
  }

  renderTableRole();
  renderInfluences([]);
  renderReadiness(null);

  function addPlayerToList(playerName: string) {
    if (playerList.querySelector(`li[data-name="${CSS.escape(playerName)}"]`)) return;
    const waiting = playerList.querySelector('.waiting');
    if (waiting) waiting.remove();
    playerCount++;
    const li = document.createElement('li');
    li.textContent = playerName;
    li.dataset.name = playerName;
    playerList.appendChild(li);
  }

  ws.on('player-joined', (msg) => {
    if (msg.type !== 'player-joined') return;
    addPlayerToList(msg.playerName);
  });

  // Sent on rejoin: everything that happened while the DM was away.
  ws.on('lobby-state', (msg) => {
    if (msg.type !== 'lobby-state') return;
    playerList.innerHTML = '<li class="waiting">Waiting for players...</li>';
    playerCount = 0;
    for (const name of msg.players) addPlayerToList(name);

    chatLog.innerHTML = '';
    for (const entry of msg.setupChat) {
      addChatMessage(entry.content, entry.role === 'user' ? 'host' : 'dm');
    }

    dmReady = msg.dmReady;
    approvedCount = msg.approvedCount;
    updateStartButton();

    phase = msg.phase;
    hostTableRole = msg.hostTableRole;
    renderTableRole();
    updateTableRoleVisibility();
    renderInfluences(msg.influences);
    renderReadiness(msg.readiness);
  });

  ws.on('phase-change', (msg) => {
    if (msg.type !== 'phase-change') return;
    phase = msg.phase;
    updateTableRoleVisibility();
  });

  ws.on('world-readiness', (msg) => {
    if (msg.type !== 'world-readiness') return;
    renderInfluences(msg.influences);
    renderReadiness(msg.readiness);
    resetSeedButtons();
  });

  ws.on('world-seed-draft', (msg) => {
    if (msg.type !== 'world-seed-draft') return;
    renderSeed(msg.seed, msg.accepted);
  });

  ws.on('player-left', (msg) => {
    if (msg.type !== 'player-left') return;
    playerCount--;
    const li = playerList.querySelector(`li[data-name="${CSS.escape(msg.playerName)}"]`);
    if (li) li.remove();
    if (playerCount === 0) {
      playerList.innerHTML = '<li class="waiting">Waiting for players...</li>';
    }
  });

  ws.on('character-pending-review', (msg) => {
    if (msg.type !== 'character-pending-review') return;
    // Replayed on rejoin as well as sent live — don't stack duplicate cards.
    if (submissions.querySelector(`[data-char-id="${CSS.escape(msg.characterId)}"]`)) return;
    const card = document.createElement('div');
    card.className = 'dm-char-card pending';
    card.dataset.charId = msg.characterId;

    const info = document.createElement('div');
    info.className = 'dm-char-info';
    const name = document.createElement('strong');
    name.textContent = `${msg.playerName}: ${msg.definition.name}`;
    const concept = document.createElement('span');
    concept.className = 'dm-char-concept';
    concept.textContent = msg.definition.highConcept;
    const aiFeedback = document.createElement('span');
    aiFeedback.className = 'dm-char-ai-feedback';
    aiFeedback.textContent = `AI DM: ${msg.aiFeedback}`;
    info.append(name, concept, aiFeedback);

    const actions = document.createElement('div');
    actions.className = 'dm-char-actions';
    const approveBtn = document.createElement('button');
    approveBtn.className = 'approve-btn';
    approveBtn.textContent = 'Approve';
    approveBtn.addEventListener('click', () => {
      ws.send({ type: 'host-approve-character', characterId: msg.characterId });
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      const status = card.querySelector('.dm-char-status');
      if (status) { status.textContent = 'Approved'; status.className = 'dm-char-status approved'; }
    });
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'reject-btn ghost-btn';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', () => {
      const reason = prompt('Reason for rejection:') || 'Character needs revision';
      ws.send({ type: 'host-reject-character', characterId: msg.characterId, reason });
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      const status = card.querySelector('.dm-char-status');
      if (status) { status.textContent = 'Rejected'; status.className = 'dm-char-status rejected'; }
    });
    actions.append(approveBtn, rejectBtn);

    const status = document.createElement('span');
    status.className = 'dm-char-status';
    status.textContent = 'Awaiting your review';

    card.append(info, status, actions);
    submissions.appendChild(card);
  });

  ws.on('character-submitted', (msg) => {
    if (msg.type !== 'character-submitted') return;
    const existing = submissions.querySelector(`[data-char-id="${CSS.escape(msg.characterId)}"]`);
    if (existing) {
      existing.classList.remove('pending');
      const actionsEl = existing.querySelector('.dm-char-actions');
      if (actionsEl) actionsEl.remove();
    }
    approvedCount++;
    updateStartButton();
  });

  ws.on('negotiation-opened', (msg) => {
    if (msg.type !== 'negotiation-opened') return;
    const existing = submissions.querySelector(`[data-char-id="${CSS.escape(msg.characterId)}"]`);
    if (existing) existing.remove();
    if (submissions.querySelector(`.negotiation-panel[data-char-id="${CSS.escape(msg.characterId)}"]`)) return;
    renderNegotiationChat(submissions, ws, msg.characterId, msg.characterName, msg.playerName, true);
  });

  startBtn.addEventListener('click', () => {
    ws.send({ type: 'start-game' });
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';
  });

  ws.on('error', (msg) => {
    if (msg.type !== 'error') return;
    hideTyping();
    chatSend.disabled = false;
    resetSeedButtons();
  });
}
