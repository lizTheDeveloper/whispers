import type { WsClient } from './ws-client.js';

export function renderGameView(root: HTMLElement, ws: WsClient, isHost: boolean): void {
  root.innerHTML = `
    <div class="game-view">
      <div class="narration-log" id="narration-log"></div>
      <div id="action-area"></div>
      <div class="whisper-input" id="whisper-area" style="display:none">
        <span class="trust-display" id="trust-display"></span>
        <input type="text" id="whisper-text" placeholder="Whisper to your character..." maxlength="200" />
        <button id="whisper-btn">Whisper</button>
      </div>
      ${isHost ? '<div id="dm-controls"><button id="end-game-btn">End Game</button></div>' : ''}
    </div>
  `;

  const log = root.querySelector('#narration-log') as HTMLElement;
  const actionArea = root.querySelector('#action-area') as HTMLElement;
  const whisperArea = root.querySelector('#whisper-area') as HTMLElement;
  const whisperInput = root.querySelector('#whisper-text') as HTMLInputElement;
  const whisperBtn = root.querySelector('#whisper-btn') as HTMLButtonElement;
  const trustDisplay = root.querySelector('#trust-display') as HTMLElement;

  function appendLog(text: string, cls: string): void {
    const div = document.createElement('div');
    div.className = `narration-entry ${cls}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  ws.on('narration', (msg) => { if (msg.type === 'narration') appendLog(msg.text, 'dm'); });
  ws.on('resolution', (msg) => { if (msg.type === 'resolution') appendLog(msg.text, 'dm'); });
  ws.on('scene-end', (msg) => { if (msg.type === 'scene-end') appendLog(`--- Scene ${msg.sceneNumber} End ---\n${msg.summary}`, 'system'); });

  ws.on('dice-roll', (msg) => {
    if (msg.type === 'dice-roll') appendLog(`[dice] ${msg.result.description} (${msg.context})`, 'dice');
  });

  ws.on('action-proposals', (msg) => {
    if (msg.type !== 'action-proposals') return;
    actionArea.innerHTML = '';
    const container = document.createElement('div');
    container.className = 'action-proposals';
    const h3 = document.createElement('h3');
    h3.textContent = `${msg.characterName} is considering:`;
    container.appendChild(h3);
    const ul = document.createElement('ul');
    for (const a of msg.actions) {
      const li = document.createElement('li');
      li.textContent = a;
      ul.appendChild(li);
    }
    container.appendChild(ul);
    actionArea.appendChild(container);
    trustDisplay.textContent = `Trust: ${(msg.whisperTrust * 100).toFixed(0)}%`;
  });

  ws.on('whisper-prompt', (msg) => {
    if (msg.type !== 'whisper-prompt') return;
    whisperArea.style.display = 'flex';
    whisperInput.focus();
    whisperInput.placeholder = `Whisper to ${msg.characterName}...`;
  });

  ws.on('action-taken', (msg) => {
    if (msg.type !== 'action-taken') return;
    whisperArea.style.display = 'none';
    actionArea.innerHTML = '';
    appendLog(`${msg.characterName}: ${msg.action}`, 'character');
    appendLog(`(${msg.innerThought})`, 'whisper');
  });

  ws.on('dm-question', (msg) => {
    if (msg.type !== 'dm-question' || !isHost) return;
    const answer = prompt(`DM asks: ${msg.question}`);
    if (answer) ws.send({ type: 'dm-answer', text: answer });
  });

  function sendWhisper(): void {
    const text = whisperInput.value.trim();
    if (!text) return;
    ws.send({ type: 'whisper', text });
    appendLog(`You whisper: "${text}"`, 'whisper');
    whisperInput.value = '';
    whisperArea.style.display = 'none';
  }

  whisperBtn.addEventListener('click', sendWhisper);
  whisperInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendWhisper(); });

  if (isHost) {
    root.querySelector('#end-game-btn')?.addEventListener('click', () => {
      ws.send({ type: 'end-game' });
    });
  }
}
