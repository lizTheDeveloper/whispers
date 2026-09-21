import type { WsClient } from './ws-client.js';
import type { ServerMessage } from '../shared/protocol.js';

export function renderGameView(root: HTMLElement, ws: WsClient, isHost: boolean): void {
  root.innerHTML = `
    <div class="game-view">
      <div class="scene-image-container" id="scene-image" style="display:none">
        <img id="scene-img" alt="" />
        <div class="scene-image-label" id="scene-label"></div>
      </div>
      <div class="location-bar" id="location-bar" style="display:none"></div>
      <div id="system-notice" class="system-notice hidden"></div>
      <div class="narration-log" id="narration-log"></div>
      <div id="action-area"></div>
      <div class="whisper-input" id="whisper-area" style="display:none">
        <span class="trust-display" id="trust-display"></span>
        <input type="text" id="whisper-text" placeholder="Whisper to your character..." maxlength="200" />
        <button id="whisper-btn">Whisper</button>
      </div>
      ${isHost ? '<div id="dm-controls"><button id="end-game-btn">End Game</button><div id="party-controls" class="party-controls"></div></div>' : ''}
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

  // Server error text (a refused revoke, a rejected whisper, etc.) is
  // operational feedback about a click, not part of the story the DM is
  // telling — it must never land in narration-log next to the DM's own
  // 'system' entries, where a player has no way to tell "the game told you
  // this" apart from "the server told you this failed."
  const systemNotice = root.querySelector('#system-notice') as HTMLElement;
  let systemNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  function showSystemNotice(text: string): void {
    systemNotice.textContent = text;
    systemNotice.classList.remove('hidden');
    if (systemNoticeTimer) clearTimeout(systemNoticeTimer);
    systemNoticeTimer = setTimeout(() => systemNotice.classList.add('hidden'), 6000);
  }

  // The host's silent, non-blocking veto, reachable during play — before
  // this, revoke-character only had an affordance in the DM lobby, which
  // main.ts stops rendering for everyone (host included) the moment
  // phase === 'playing'. id -> name of every character still at the table;
  // fed by character-roster (sent once when the game starts, and again to a
  // reconnecting host so this doesn't stay empty after a refresh) and kept
  // current by character-revoked below. Every other client (not just the
  // host) also tracks this, purely to put a name on its own revoked-notice.
  const roster = new Map<string, string>();
  const partyControls = isHost ? (root.querySelector('#party-controls') as HTMLElement) : null;

  // Revoke buttons with a click sent and no server answer yet. The server's
  // 'error' message carries no characterId, so a refusal can't be routed to
  // one button — same limitation dm-lobby.ts's pendingCharacterActions
  // documents for the identical problem there. Restored to enabled only
  // when actually refused, and cleared wholesale on every re-render (below)
  // since renderPartyControls rebuilds every button from scratch, making any
  // stale reference here harmless but pointless to keep.
  const pendingRevokes = new Set<HTMLButtonElement>();

  function renderPartyControls(): void {
    if (!partyControls) return;
    pendingRevokes.clear();
    partyControls.replaceChildren();
    if (roster.size === 0) return;
    const heading = document.createElement('h4');
    heading.textContent = 'Party';
    partyControls.appendChild(heading);
    for (const [characterId, name] of roster) {
      const row = document.createElement('div');
      row.className = 'party-row';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'party-name';
      nameSpan.textContent = name;
      row.appendChild(nameSpan);

      const isLast = roster.size === 1;
      const revokeBtn = document.createElement('button');
      revokeBtn.className = 'revoke-btn ghost-btn';
      revokeBtn.textContent = isLast ? 'Revoke (ends game)' : 'Revoke';
      revokeBtn.addEventListener('click', () => {
        // Revoking the last live character empties the party, and an empty
        // party ends the session outright (there is no one left for the
        // loop to run turns for) — the host must not find that out only
        // after clicking.
        if (isLast && !confirm(`${name} is the last character left. Revoking them will end the game. Continue?`)) return;
        const reason = prompt('Reason for revoking (optional):') || undefined;
        ws.send({ type: 'revoke-character', characterId, reason });
        revokeBtn.disabled = true;
        pendingRevokes.add(revokeBtn);
      });
      row.appendChild(revokeBtn);
      partyControls.appendChild(row);
    }
  }

  ws.on('character-roster', (msg) => {
    if (msg.type !== 'character-roster') return;
    roster.clear();
    for (const c of msg.characters) roster.set(c.id, c.name);
    renderPartyControls();
  });

  ws.on('character-revoked', (msg) => {
    if (msg.type !== 'character-revoked') return;
    const name = roster.get(msg.characterId) ?? 'A character';
    appendLog(msg.reason ? `${name} has been removed from the table: ${msg.reason}` : `${name} has been removed from the table.`, 'system');
    roster.delete(msg.characterId);
    renderPartyControls();
  });

  const locationBar = root.querySelector('#location-bar') as HTMLElement;
  // The render paths below are shared with the 'transcript-replay' handler
  // at the bottom of this function: a replayed line must be styled by the
  // same code as a live one, or reload fidelity drifts the moment either
  // side changes. Live handlers keep their non-log side effects (location
  // bar, stat counters, panel resets) inside these same functions so a
  // replay restores those too — sessionStats is declared above them for
  // exactly that reason.
  const sessionStats = { scenes: 0, followed: 0, partial: 0, ignored: 0 };

  function renderNarration(msg: Extract<ServerMessage, { type: 'narration' }>): void {
    const cls = msg.isEpilogue ? 'epilogue'
      : msg.text.startsWith('[Compel:') ? 'compel'
      : msg.text.includes('TAKEN OUT') ? 'taken-out'
      : 'dm';
    appendLog(msg.text, cls);
    if (msg.locationName) {
      locationBar.textContent = msg.locationName;
      locationBar.style.display = 'block';
    }
  }
  ws.on('narration', (msg) => {
    if (msg.type !== 'narration') return;
    renderNarration(msg);
  });
  function renderDiceRoll(msg: Extract<ServerMessage, { type: 'dice-roll' }>): void {
    appendLog(`[dice] ${msg.result.description} (${msg.context})`, 'dice');
  }
  ws.on('dice-roll', (msg) => {
    if (msg.type === 'dice-roll') renderDiceRoll(msg);
  });
  function renderResolution(msg: Extract<ServerMessage, { type: 'resolution' }>): void {
    appendLog(msg.text, 'resolution');
  }
  ws.on('resolution', (msg) => { if (msg.type === 'resolution') renderResolution(msg); });

  function renderSceneEnd(msg: Extract<ServerMessage, { type: 'scene-end' }>): void {
    sessionStats.scenes++;
    appendLog(`--- Scene ${msg.sceneNumber} End ---\n${msg.summary}`, 'system');

    const stats = msg.whisperStats;
    if (stats && stats.length > 0) {
        const card = document.createElement('div');
        card.className = 'narration-entry whisper-stats-card';

        const title = document.createElement('div');
        title.className = 'stats-title';
        title.textContent = 'Your Influence This Scene';
        card.appendChild(title);

        for (const s of stats) {
          // s.name is character.definition.name — attacker-controlled (a
          // player can name a character anything, including markup), so it
          // must go through textContent, never be concatenated into HTML.
          const total = s.followed + s.partial + s.ignored;
          sessionStats.followed += s.followed;
          sessionStats.partial += s.partial;
          sessionStats.ignored += s.ignored;
          const pct = total > 0 ? Math.round((s.followed / total) * 100) : 0;
          const sign = s.trustDelta >= 0 ? '+' : '';

          const row = document.createElement('div');
          row.className = 'stats-row';

          const nameSpan = document.createElement('span');
          nameSpan.className = 'stats-name';
          nameSpan.textContent = s.name;
          row.appendChild(nameSpan);

          const barSpan = document.createElement('span');
          barSpan.className = 'stats-bar';
          const fillSpan = document.createElement('span');
          fillSpan.className = 'stats-fill';
          fillSpan.style.width = `${pct}%`;
          barSpan.appendChild(fillSpan);
          row.appendChild(barSpan);

          const detailSpan = document.createElement('span');
          detailSpan.className = 'stats-detail';
          detailSpan.textContent = `${s.followed}/${total} heeded · trust ${sign}${(s.trustDelta * 100).toFixed(0)}%`;
          row.appendChild(detailSpan);

          card.appendChild(row);
        }

      log.appendChild(card);
      log.scrollTop = log.scrollHeight;
    }

    const sceneImage = root.querySelector('#scene-image') as HTMLElement;
    sceneImage.style.display = 'none';
  }
  ws.on('scene-end', (msg) => { if (msg.type === 'scene-end') renderSceneEnd(msg); });

  ws.on('scene-image', (msg) => {
    if (msg.type !== 'scene-image') return;
    const container = root.querySelector('#scene-image') as HTMLElement;
    const img = root.querySelector('#scene-img') as HTMLImageElement;
    const label = root.querySelector('#scene-label') as HTMLElement;
    if (msg.imageUrl.startsWith('https://') || msg.imageUrl.startsWith('data:image/')) {
      img.src = msg.imageUrl;
    }
    img.alt = msg.locationName;
    label.textContent = msg.locationName;
    container.style.display = 'block';
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
    for (let i = 0; i < msg.actions.length; i++) {
      const li = document.createElement('li');
      li.textContent = msg.actions[i]!;
      if (msg.actionReasons && msg.actionReasons[i]) {
        const reason = document.createElement('span');
        reason.className = 'action-reason';
        reason.textContent = ` — ${msg.actionReasons[i]}`;
        li.appendChild(reason);
      }
      ul.appendChild(li);
    }
    container.appendChild(ul);
    actionArea.appendChild(container);
    trustDisplay.textContent = `Trust: ${(msg.whisperTrust * 100).toFixed(0)}%`;
  });

  let whisperTimer: ReturnType<typeof setInterval> | null = null;
  ws.on('whisper-prompt', (msg) => {
    if (msg.type !== 'whisper-prompt') return;
    whisperArea.style.display = 'flex';
    whisperInput.focus();
    whisperInput.placeholder = `Whisper to ${msg.characterName}...`;
    if (msg.mood || msg.trustHint) {
      const moodEl = whisperArea.querySelector('.whisper-context') ?? (() => {
        const el = document.createElement('div');
        el.className = 'whisper-context';
        whisperArea.insertBefore(el, whisperArea.firstChild);
        return el;
      })();
      const parts: string[] = [];
      if (msg.mood) parts.push(msg.mood);
      if (msg.trustHint) parts.push(msg.trustHint);
      (moodEl as HTMLElement).textContent = parts.join(' ');
    }
    const existingGoals = whisperArea.querySelector('.whisper-goals');
    if (existingGoals) existingGoals.remove();
    if (msg.goals && msg.goals.length > 0) {
      // msg.goals is LLM-generated text derived from player-influenced
      // memories — not a trusted constant — so build each tag with
      // textContent rather than concatenating it into HTML.
      const goalsDiv = document.createElement('div');
      goalsDiv.className = 'whisper-goals';
      for (const g of msg.goals) {
        const tag = document.createElement('span');
        tag.className = 'goal-tag';
        tag.textContent = g;
        goalsDiv.appendChild(tag);
      }
      whisperArea.insertBefore(goalsDiv, whisperInput);
    }
    const existingSuggestions = whisperArea.querySelector('.whisper-suggestions');
    if (existingSuggestions) existingSuggestions.remove();
    if (msg.suggestions && msg.suggestions.length > 0) {
      const sugDiv = document.createElement('div');
      sugDiv.className = 'whisper-suggestions';
      for (const sug of msg.suggestions) {
        const btn = document.createElement('button');
        btn.className = 'suggestion-btn';
        btn.textContent = sug;
        btn.addEventListener('click', () => {
          whisperInput.value = sug;
          whisperInput.focus();
        });
        sugDiv.appendChild(btn);
      }
      whisperArea.insertBefore(sugDiv, whisperInput);
    }
    let remaining = 30;
    whisperBtn.textContent = `Whisper (${remaining}s)`;
    if (whisperTimer) clearInterval(whisperTimer);
    whisperTimer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        if (whisperTimer) { clearInterval(whisperTimer); whisperTimer = null; }
        whisperArea.style.display = 'none';
        whisperBtn.textContent = 'Whisper';
        whisperInput.value = '';
        appendLog('[You stayed silent.]', 'system');
        return;
      }
      whisperBtn.textContent = `Whisper (${remaining}s)`;
    }, 1000);
  });

  function renderActionTaken(msg: Extract<ServerMessage, { type: 'action-taken' }>): void {
    appendLog(`${msg.characterName}: ${msg.action}`, 'character');
    if (msg.spokenWords) {
      appendLog(`"${msg.spokenWords}"`, 'dialogue');
    }
    appendLog(`(${msg.innerThought})`, 'whisper');
    if (msg.whisperInfluence && msg.whisperInfluence !== 'none') {
      const label = msg.whisperInfluence === 'followed' ? 'heeded your whisper'
        : msg.whisperInfluence === 'partially-followed' ? 'partially heeded your whisper'
        : 'resisted your whisper';
      appendLog(`[${msg.characterName} ${label}]`, 'system');
    }
  }
  ws.on('action-taken', (msg) => {
    if (msg.type !== 'action-taken') return;
    // Panel resets are live-turn chrome, not log content — a replay never
    // sees them, which is correct: it restores what happened, not what the
    // whisper box was doing at the moment the page died.
    whisperArea.style.display = 'none';
    if (whisperTimer) { clearInterval(whisperTimer); whisperTimer = null; }
    whisperBtn.textContent = 'Whisper';
    actionArea.innerHTML = '';
    renderActionTaken(msg);
  });

  ws.on('character-state-update', (msg) => {
    if (msg.type !== 'character-state-update') return;
    const s = msg.state as { stress: number; consequences: string[]; fatePoints: number; whisperTrust: number; inventory?: string[] };
    const trustPct = Math.round(s.whisperTrust * 100);
    const trustLabel = trustPct >= 70 ? 'trusting' : trustPct >= 40 ? 'uncertain' : 'wary';
    const parts = [`Trust: ${trustPct}% (${trustLabel})`, `Stress: ${s.stress}/3`, `FP: ${s.fatePoints}`];
    if (s.consequences.length > 0) parts.push(`Wounds: ${s.consequences.join(', ')}`);
    if (s.inventory && s.inventory.length > 0) parts.push(`Items: ${s.inventory.join(', ')}`);
    const existing = root.querySelector('#char-status') as HTMLElement;
    if (existing) {
      existing.textContent = parts.join(' | ');
    } else {
      const statusDiv = document.createElement('div');
      statusDiv.id = 'char-status';
      statusDiv.className = 'narration-entry system';
      statusDiv.textContent = parts.join(' | ');
      whisperArea.insertAdjacentElement('beforebegin', statusDiv);
    }
  });

  ws.on('dm-question', (msg) => {
    if (msg.type !== 'dm-question' || !isHost) return;
    actionArea.innerHTML = '';
    const container = document.createElement('div');
    container.className = 'dm-question-panel';
    const heading = document.createElement('h3');
    heading.textContent = 'The DM asks:';
    const questionP = document.createElement('p');
    questionP.className = 'dm-question-text';
    questionP.textContent = msg.question;
    const inputDiv = document.createElement('div');
    inputDiv.className = 'dm-question-input';
    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.id = 'dm-answer-input';
    inputEl.placeholder = 'Your answer...';
    const btnEl = document.createElement('button');
    btnEl.id = 'dm-answer-btn';
    btnEl.textContent = 'Answer';
    inputDiv.appendChild(inputEl);
    inputDiv.appendChild(btnEl);
    container.appendChild(heading);
    container.appendChild(questionP);
    container.appendChild(inputDiv);
    actionArea.appendChild(container);
    inputEl.focus();
    const submit = () => {
      const text = inputEl.value.trim();
      if (!text) return;
      ws.send({ type: 'dm-answer', text });
      actionArea.innerHTML = '';
      appendLog(`You answered: "${text}"`, 'system');
    };
    btnEl.addEventListener('click', submit);
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  });

  let shownTutorial = false;
  function showTutorial(): void {
    if (shownTutorial) return;
    shownTutorial = true;
    appendLog('You are the voice inside your character\'s head. When prompted, whisper a thought to guide them — but they may not listen. Trust is earned through good advice.', 'system');
  }
  ws.on('phase-change', (msg) => {
    if (msg.type === 'phase-change' && msg.phase === 'playing') {
      showTutorial();
    }
    if (msg.type === 'phase-change' && msg.phase === 'ended') {
      whisperArea.style.display = 'none';
      actionArea.innerHTML = '';

      const total = sessionStats.followed + sessionStats.partial + sessionStats.ignored;
      const recapDiv = document.createElement('div');
      recapDiv.className = 'narration-entry session-recap';
      let recapHtml = '<div class="recap-title">Session Complete</div>';
      recapHtml += '<div class="recap-grid">';
      recapHtml += `<div class="recap-stat"><span class="recap-num">${sessionStats.scenes}</span><span class="recap-label">Scenes</span></div>`;
      if (total > 0) {
        const influencePct = Math.round(((sessionStats.followed + sessionStats.partial * 0.5) / total) * 100);
        recapHtml += `<div class="recap-stat"><span class="recap-num">${total}</span><span class="recap-label">Whispers</span></div>`;
        recapHtml += `<div class="recap-stat"><span class="recap-num">${influencePct}%</span><span class="recap-label">Influence</span></div>`;
        recapHtml += `<div class="recap-stat"><span class="recap-num">${sessionStats.followed}</span><span class="recap-label">Heeded</span></div>`;
      }
      recapHtml += '</div>';
      if (total > 0) {
        const ratio = sessionStats.followed / total;
        const verdict = ratio >= 0.6 ? 'A trusted guide — your voice shaped the story.'
          : ratio >= 0.35 ? 'An uncertain influence — sometimes heard, sometimes doubted.'
          : 'A voice in the dark — mostly resisted, but never silenced.';
        recapHtml += `<div class="recap-verdict">${verdict}</div>`;
      }
      recapDiv.innerHTML = recapHtml;
      log.appendChild(recapDiv);
      log.scrollTop = log.scrollHeight;

      if (isHost) {
        const controls = root.querySelector('#dm-controls');
        if (controls) controls.innerHTML = '';
      }
    }
  });

  function sendWhisper(): void {
    const text = whisperInput.value.trim();
    if (!text) return;
    ws.send({ type: 'whisper', text });
    appendLog(`You whisper: "${text}"`, 'whisper');
    whisperInput.value = '';
    whisperArea.style.display = 'none';
    if (whisperTimer) { clearInterval(whisperTimer); whisperTimer = null; }
    whisperBtn.textContent = 'Whisper';
  }

  whisperBtn.addEventListener('click', sendWhisper);
  whisperInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendWhisper(); });

  if (isHost) {
    root.querySelector('#end-game-btn')?.addEventListener('click', () => {
      ws.send({ type: 'end-game' });
    });
  }

  // A refused revoke (stale id, already revoked, a second tab's click racing
  // this one) must not leave that row's button stuck disabled forever with
  // no explanation — same reasoning as the identical handler in dm-lobby.ts.
  // Scoped to pendingRevokes (buttons this screen itself disabled), not
  // every '.revoke-btn' on the page — and shown as a system notice, not
  // appended to narration-log: this text is about a click failing, not
  // something the DM said.
  ws.on('error', (msg) => {
    if (msg.type !== 'error') return;
    showSystemNotice(msg.message);
    for (const btn of pendingRevokes) btn.disabled = false;
    pendingRevokes.clear();
  });

  // The playing-phase analog of interview-replay: the server ships back
  // every #narration-log line this session's view would have shown before
  // the refresh (its own whispers included; other players' whispers are
  // filtered server-side). Each entry is re-rendered through the exact
  // live message's function — same classes, same stat accounting, same
  // location bar — so a reloading player sees the story so far, not just
  // that the game survived.
  ws.on('transcript-replay', (msg) => {
    if (msg.type !== 'transcript-replay') return;
    if (msg.entries.length === 0 && msg.omitted === 0) return;
    // A campaign can only have log entries because play started, and play
    // starting is what shows the one-time tutorial live. The server sends
    // this before the rejoin phase-change, so claim the tutorial here and
    // it lands where it did originally: on top of the transcript.
    showTutorial();
    if (msg.omitted > 0) appendLog(`— ${msg.omitted} earlier log entries omitted —`, 'system');
    for (const entry of msg.entries) {
      switch (entry.type) {
        case 'narration': renderNarration(entry); break;
        case 'resolution': renderResolution(entry); break;
        case 'dice-roll': renderDiceRoll(entry); break;
        case 'action-taken': renderActionTaken(entry); break;
        case 'scene-end': renderSceneEnd(entry); break;
        case 'whisper-echo': appendLog(`You whisper: "${entry.text}"`, 'whisper'); break;
        case 'revoked-note': appendLog(entry.text, 'system'); break;
      }
    }
    log.scrollTop = log.scrollHeight;
  });

  const connBanner = document.createElement('div');
  connBanner.className = 'connection-banner';
  connBanner.style.display = 'none';
  connBanner.textContent = 'Connection lost — reconnecting…';
  root.querySelector('.game-view')?.prepend(connBanner);
  ws.onStatus((connected) => {
    connBanner.style.display = connected ? 'none' : 'block';
    if (connected) appendLog('[Reconnected]', 'system');
  });
}
