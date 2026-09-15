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

  // Declared here (not inside the `if (isHost)` block below) so the 'error'
  // handler further down — which must be able to restore a refused
  // approve/reject regardless of how this panel was built — can reach them.
  let approveBtn: HTMLButtonElement | null = null;
  let rejectBtn: HTMLButtonElement | null = null;
  // Set only while this panel has its own approve/reject click in flight — an
  // 'error' arriving with neither button disabled came from somewhere else
  // (another panel, another request) and must not touch this one.
  let actionPending = false;
  // Set once the round cap closes this discussion (negotiation-closed) so
  // doSend can refuse locally — input.disabled alone doesn't stop a queued
  // keydown handler from firing on a field a click already raced past.
  let closed = false;

  if (isHost) {
    const actions = document.createElement('div');
    actions.className = 'negotiation-actions';
    approveBtn = document.createElement('button');
    approveBtn.className = 'approve-btn';
    approveBtn.textContent = 'Approve Character';
    approveBtn.addEventListener('click', () => {
      ws.send({ type: 'host-approve-character', characterId });
      approveBtn!.disabled = true;
      rejectBtn!.disabled = true;
      actionPending = true;
    });
    rejectBtn = document.createElement('button');
    rejectBtn.className = 'reject-btn ghost-btn';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', () => {
      const reason = prompt('Reason for rejection:') || 'Character needs revision';
      ws.send({ type: 'host-reject-character', characterId, reason });
      approveBtn!.disabled = true;
      rejectBtn!.disabled = true;
      actionPending = true;
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
    if (closed) return;
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

  // The round cap closes the DISCUSSION, not the decision — approve/reject
  // stay live (see negotiation.ts's closeAtCap). Without this, the input box
  // stays live too: everything typed into it after the cap vanishes with no
  // local echo, because the server's negotiation-message handler silently
  // drops anything sent to a closed negotiation.
  ws.on('negotiation-closed', (msg) => {
    if (msg.type !== 'negotiation-closed') return;
    if (msg.characterId !== characterId) return;
    closed = true;
    input.disabled = true;
    sendBtn.disabled = true;
    const notice = document.createElement('div');
    notice.className = 'negotiation-bubble system';
    notice.textContent = 'The discussion is closed — approve or reject the character to finish.';
    log.appendChild(notice);
    log.scrollTop = log.scrollHeight;
  });

  ws.on('character-submitted', (msg) => {
    if (msg.type !== 'character-submitted') return;
    if (msg.characterId !== characterId) return;
    actionPending = false;
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
      actionPending = false;
      const notice = document.createElement('div');
      notice.className = 'negotiation-bubble system';
      notice.textContent = `Character rejected: ${msg.feedback}`;
      log.appendChild(notice);
      input.disabled = true;
      sendBtn.disabled = true;
    }
  });

  // The player's side learns a reject happened from character-validated
  // above. The host's own socket gets nothing from that message — it goes
  // only to the player — so without this, a host who rejects from this
  // panel sees both buttons go disabled and then silence forever, with no
  // sign the reject ever took effect (or that it didn't).
  ws.on('character-rejected', (msg) => {
    if (msg.type !== 'character-rejected') return;
    if (msg.characterId !== characterId) return;
    actionPending = false;
    const notice = document.createElement('div');
    notice.className = 'negotiation-bubble system';
    notice.textContent = `Character rejected: ${msg.reason}`;
    log.appendChild(notice);
    input.disabled = true;
    sendBtn.disabled = true;
  });

  // A refused approve/reject (no authority, no such pending character, wrong
  // phase) must not leave this panel's buttons permanently disabled with no
  // explanation — that is the exact bug this panel existed to avoid on the
  // success path. Restore them and surface the reason, built with
  // createElement/textContent only: this message came from the server and
  // must never be handed to innerHTML.
  ws.on('error', (msg) => {
    if (msg.type !== 'error') return;
    if (!actionPending) return;
    actionPending = false;
    if (approveBtn) approveBtn.disabled = false;
    if (rejectBtn) rejectBtn.disabled = false;
    const notice = document.createElement('div');
    notice.className = 'negotiation-bubble system';
    notice.textContent = msg.message;
    log.appendChild(notice);
  });
}
