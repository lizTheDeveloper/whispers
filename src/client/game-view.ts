import type { WsClient } from './ws-client.js';

export function renderGameView(root: HTMLElement, ws: WsClient, isHost: boolean): void {
  root.innerHTML = `
    <div class="game-view">
      <div class="scene-image-container" id="scene-image" style="display:none">
        <img id="scene-img" alt="" />
        <div class="scene-image-label" id="scene-label"></div>
      </div>
      <div class="location-bar" id="location-bar" style="display:none"></div>
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

  const locationBar = root.querySelector('#location-bar') as HTMLElement;
  ws.on('narration', (msg) => {
    if (msg.type !== 'narration') return;
    const cls = (msg as any).isEpilogue ? 'epilogue'
      : msg.text.startsWith('[Compel:') ? 'compel'
      : msg.text.includes('TAKEN OUT') ? 'taken-out'
      : 'dm';
    appendLog(msg.text, cls);
    if (msg.locationName) {
      locationBar.textContent = msg.locationName;
      locationBar.style.display = 'block';
    }
  });
  ws.on('resolution', (msg) => { if (msg.type === 'resolution') appendLog(msg.text, 'resolution'); });
  const sessionStats = { scenes: 0, followed: 0, partial: 0, ignored: 0 };

  ws.on('scene-end', (msg) => {
    if (msg.type === 'scene-end') {
      sessionStats.scenes++;
      appendLog(`--- Scene ${msg.sceneNumber} End ---\n${msg.summary}`, 'system');

      const stats = (msg as any).whisperStats as Array<{ name: string; followed: number; partial: number; ignored: number; trustDelta: number }> | undefined;
      if (stats && stats.length > 0) {
        const card = document.createElement('div');
        card.className = 'narration-entry whisper-stats-card';
        let html = '<div class="stats-title">Your Influence This Scene</div>';
        for (const s of stats) {
          const total = s.followed + s.partial + s.ignored;
          sessionStats.followed += s.followed;
          sessionStats.partial += s.partial;
          sessionStats.ignored += s.ignored;
          const pct = total > 0 ? Math.round((s.followed / total) * 100) : 0;
          const sign = s.trustDelta >= 0 ? '+' : '';
          html += `<div class="stats-row">`;
          html += `<span class="stats-name">${s.name}</span>`;
          html += `<span class="stats-bar"><span class="stats-fill" style="width:${pct}%"></span></span>`;
          html += `<span class="stats-detail">${s.followed}/${total} heeded &middot; trust ${sign}${(s.trustDelta * 100).toFixed(0)}%</span>`;
          html += `</div>`;
        }
        card.innerHTML = html;
        log.appendChild(card);
        log.scrollTop = log.scrollHeight;
      }

      const sceneImage = root.querySelector('#scene-image') as HTMLElement;
      sceneImage.style.display = 'none';
    }
  });

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

  ws.on('action-taken', (msg) => {
    if (msg.type !== 'action-taken') return;
    whisperArea.style.display = 'none';
    if (whisperTimer) { clearInterval(whisperTimer); whisperTimer = null; }
    whisperBtn.textContent = 'Whisper';
    actionArea.innerHTML = '';
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
  ws.on('phase-change', (msg) => {
    if (msg.type === 'phase-change' && msg.phase === 'playing' && !shownTutorial) {
      shownTutorial = true;
      appendLog('You are the voice inside your character\'s head. When prompted, whisper a thought to guide them — but they may not listen. Trust is earned through good advice.', 'system');
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
}
