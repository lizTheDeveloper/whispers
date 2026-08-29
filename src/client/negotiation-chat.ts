import type { WsClient } from './ws-client.js';

export function renderNegotiationChat(container: HTMLElement, ws: WsClient, characterId: string, characterName: string, playerName: string, isHost: boolean): void {
  const panel = document.createElement('div');
  panel.className = 'negotiation-panel';
  panel.dataset.charId = characterId;

  const header = document.createElement('h3');
  header.textContent = `Character Negotiation: ${characterName}`;
  panel.appendChild(header);

  const subline = document.createElement('p');
  subline.className = 'negotiation-subline';
  subline.textContent = `Player: ${playerName} — discuss the character sheet with the DM and each other.`;
  panel.appendChild(subline);

  const log = document.createElement('div');
  log.className = 'negotiation-log';
  panel.appendChild(log);

  const inputRow = document.createElement('div');
  inputRow.className = 'negotiation-input';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = isHost ? 'Respond as the host...' : 'Respond as the player...';
  const sendBtn = document.createElement('button');
  sendBtn.textContent = 'Send';
  inputRow.append(input, sendBtn);
  panel.appendChild(inputRow);

  if (isHost) {
    const actions = document.createElement('div');
    actions.className = 'negotiation-actions';
    const approveBtn = document.createElement('button');
    approveBtn.className = 'approve-btn';
    approveBtn.textContent = 'Approve Character';
    approveBtn.addEventListener('click', () => {
      ws.send({ type: 'host-approve-character', characterId });
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
    });
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'reject-btn ghost-btn';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', () => {
      const reason = prompt('Reason for rejection:') || 'Character needs revision';
      ws.send({ type: 'host-reject-character', characterId, reason });
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
    });
    actions.append(approveBtn, rejectBtn);
    panel.appendChild(actions);
  }

  container.appendChild(panel);

  function addMessage(sender: string, senderType: string, text: string) {
    const bubble = document.createElement('div');
    bubble.className = `negotiation-bubble ${senderType}`;
    const label = document.createElement('span');
    label.className = 'negotiation-sender';
    label.textContent = sender;
    const body = document.createElement('span');
    body.textContent = text;
    bubble.append(label, body);
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
  }

  function doSend() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    ws.send({ type: 'negotiation-message', characterId, text });
  }

  sendBtn.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSend();
  });

  ws.on('negotiation-message', (msg) => {
    if (msg.type !== 'negotiation-message') return;
    if (msg.characterId !== characterId) return;
    addMessage(msg.senderName, msg.sender, msg.text);
  });

  ws.on('character-submitted', (msg) => {
    if (msg.type !== 'character-submitted') return;
    if (msg.characterId !== characterId) return;
    const notice = document.createElement('div');
    notice.className = 'negotiation-bubble system';
    notice.textContent = 'Character approved! Negotiation complete.';
    log.appendChild(notice);
    input.disabled = true;
    sendBtn.disabled = true;
  });

  ws.on('character-validated', (msg) => {
    if (msg.type !== 'character-validated') return;
    if (msg.characterId !== characterId) return;
    if (!msg.approved) {
      const notice = document.createElement('div');
      notice.className = 'negotiation-bubble system';
      notice.textContent = `Character rejected: ${msg.feedback}`;
      log.appendChild(notice);
      input.disabled = true;
      sendBtn.disabled = true;
    }
  });
}
