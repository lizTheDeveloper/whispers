import type { WsClient } from './ws-client.js';
import type { PauseReason, ServerMessage } from '../shared/protocol.js';
import { appendMarkdown, stripMarkdown } from './markdown.js';

// Banner copy per pause reason. 6 mirrors the server's
// QUIET_TURNS_BEFORE_PAUSE (src/server/game-loop.ts) — keep them in step.
const PAUSE_BANNER: Record<PauseReason, string> = {
  host: 'Paused by the host',
  'no-players': 'Paused: no players connected',
  quiet: 'Paused after 6 quiet turns — whisper or resume to continue',
  restart: 'Paused after a server restart',
};

export function renderGameView(root: HTMLElement, ws: WsClient, isHost: boolean, myCharacterId?: string | null): void {
  root.innerHTML = `
    <div class="game-view">
      <div class="scene-image-container" id="scene-image" style="display:none">
        <img id="scene-img" alt="" />
        <div class="scene-image-label" id="scene-label"></div>
      </div>
      <div class="location-bar" id="location-bar" style="display:none"></div>
      <div id="pause-banner" class="pause-banner hidden" role="status"></div>
      <div id="system-notice" class="system-notice hidden"></div>
      <div class="narration-log" id="narration-log"></div>
      <div id="action-area"></div>
      <div class="whisper-input" id="whisper-area" style="display:none">
        <span class="trust-display" id="trust-display"></span>
        <input type="text" id="whisper-text" placeholder="Whisper to your character..." maxlength="200" />
        <button id="whisper-btn">Whisper</button>
      </div>
      ${isHost ? '<div id="dm-controls"><button id="pause-btn">Pause</button> <button id="end-game-btn">End Game</button><div id="party-controls" class="party-controls"></div></div>' : ''}
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

  // Model-written text (narration, actions, thoughts, summaries): rendered
  // through the safe markdown renderer — DOM nodes only, never innerHTML.
  // `prefix` and `suffix` are plain text around it (a speaker's name, quotes).
  function appendProse(text: string, cls: string, prefix = '', suffix = ''): HTMLElement {
    const div = document.createElement('div');
    div.className = `narration-entry ${cls}`;
    if (prefix) div.appendChild(document.createTextNode(prefix));
    appendMarkdown(div, text);
    if (suffix) div.appendChild(document.createTextNode(suffix));
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
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
  // Scenes are only counted by scene-end, which a scene End Game interrupts
  // never gets — so the recap also counts the scene in progress once a turn
  // has been taken in it. Scene numbers run in order, so the highest scene
  // that ended or saw a turn is how many were played, even if a replay
  // omitted the oldest entries. The epilogue closes the tally: closing
  // reflections after it are not turns.
  let liveScene = 0;
  let turnInLiveScene = false;
  let lastEndedScene = 0;
  let epilogueSeen = false;
  function scenesPlayed(): number {
    return Math.max(sessionStats.scenes, lastEndedScene, turnInLiveScene ? liveScene : 0);
  }

  function renderNarration(msg: Extract<ServerMessage, { type: 'narration' }>): void {
    if (msg.isEpilogue) epilogueSeen = true;
    else if (msg.sceneNumber !== liveScene) {
      liveScene = msg.sceneNumber;
      turnInLiveScene = false;
    }
    const cls = msg.isEpilogue ? 'epilogue'
      : msg.text.startsWith('[Compel:') ? 'compel'
      : msg.text.includes('TAKEN OUT') ? 'taken-out'
      : 'dm';
    appendProse(msg.text, cls);
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
    appendProse(msg.text, 'resolution');
  }
  ws.on('resolution', (msg) => { if (msg.type === 'resolution') renderResolution(msg); });

  function renderSceneEnd(msg: Extract<ServerMessage, { type: 'scene-end' }>): void {
    sessionStats.scenes++;
    lastEndedScene = Math.max(lastEndedScene, msg.sceneNumber);
    if (msg.sceneNumber === liveScene) turnInLiveScene = false;
    const header = appendProse(msg.summary, 'system');
    header.prepend(document.createTextNode(`--- Scene ${msg.sceneNumber} End ---`), document.createElement('br'));

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
      appendMarkdown(li, msg.actions[i]!);
      if (msg.actionReasons && msg.actionReasons[i]) {
        const reason = document.createElement('span');
        reason.className = 'action-reason';
        reason.textContent = ' — ';
        appendMarkdown(reason, msg.actionReasons[i]!);
        li.appendChild(reason);
      }
      ul.appendChild(li);
    }
    container.appendChild(ul);
    actionArea.appendChild(container);
    trustDisplay.textContent = `Trust: ${(msg.whisperTrust * 100).toFixed(0)}%`;
  });

  // A whisper's whole life is server-acknowledged now (MUL-73): the box
  // stays usable between windows because the server SAVES out-of-window
  // whispers for the character's next decision instead of swallowing them,
  // and the "You whisper" line is drawn only when the table actually
  // accepted the words. windowCharId tracks the one live countdown this
  // client is watching; hasOwnCharacter splits the two UI modes — a seated
  // player (persistent queue-capable box) vs the world author driving the
  // table from a seat with no character (window-only box, matching the
  // server's driver path).
  const hasOwnCharacter = typeof myCharacterId === 'string' && myCharacterId.length > 0;
  let whisperTimer: ReturnType<typeof setInterval> | null = null;
  let windowCharId: string | null = null;
  // Only for a server that predates windowMs/remainingMs on whisper-prompt.
  const DEFAULT_WHISPER_WINDOW_MS = 30_000;
  function setWhisperQueueMode(): void {
    windowCharId = null;
    whisperBtn.textContent = 'Whisper';
    whisperInput.placeholder = 'Whisper to your character… (saved until their next choice)';
  }
  ws.on('whisper-prompt', (msg) => {
    if (msg.type !== 'whisper-prompt' || gameOver) return;
    // The prompt is a room broadcast so everyone sees WHO is deciding; the
    // server derives every whisper's target from the sender's own seat, so
    // a player must not countdown (or falsely log "[You stayed silent.]")
    // for someone else's moment. The world author with no seat-character of
    // their own keeps watching every window — that is the driver path.
    if (hasOwnCharacter && msg.characterId !== myCharacterId) return;
    if (msg.carryingQueued && msg.carryingQueued > 0) {
      // The server is spending this character's saved whispers on the
      // decision happening right now; there is no window to win a race
      // against, so no countdown — and anything typed next queues for the
      // choice after this one.
      appendLog(`[${msg.characterName} carries your saved ${msg.carryingQueued === 1 ? 'whisper' : msg.carryingQueued + ' whispers'} into this choice.]`, 'system');
      if (whisperTimer) { clearInterval(whisperTimer); whisperTimer = null; }
      if (hasOwnCharacter) {
        whisperArea.style.display = 'flex';
        setWhisperQueueMode();
      }
      return;
    }
    whisperArea.style.display = 'flex';
    whisperInput.focus();
    whisperInput.placeholder = `Whisper to ${msg.characterName}...`;
    // A new window starts with an empty panel; the owner's mood line, goals
    // and chips arrive right behind it in whisper-guidance (older servers
    // put them on the prompt itself, so those are honoured too).
    renderGuidance(msg);
    // Count down to the server's own deadline: the time left it sent
    // (shorter than the window for a tab that rejoined mid-window), measured
    // against this clock from the moment it arrived. Recomputed from the
    // clock on every tick rather than decremented, so a throttled
    // background tab still shows the truth when it comes back into view.
    const remainingMs = msg.remainingMs ?? msg.windowMs ?? DEFAULT_WHISPER_WINDOW_MS;
    const deadline = Date.now() + remainingMs;
    const secondsLeft = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    windowCharId = msg.characterId;
    if (whisperTimer) { clearInterval(whisperTimer); whisperTimer = null; }
    if (whisperLocked) {
      // A paused table holds the window; resume re-sends the prompt.
      whisperBtn.textContent = 'Whisper';
      return;
    }
    whisperBtn.textContent = `Whisper (${secondsLeft()}s)`;
    whisperTimer = setInterval(() => {
      const remaining = secondsLeft();
      if (remaining <= 0) {
        if (whisperTimer) { clearInterval(whisperTimer); whisperTimer = null; }
        appendLog('[You stayed silent.]', 'system');
        if (hasOwnCharacter) {
          // The moment passed, not the voice: the box stays so the next
          // words can wait for the next decision instead of evaporating.
          // A typed draft survives too — silence was a choice, the words
          // were not.
          setWhisperQueueMode();
        } else {
          whisperArea.style.display = 'none';
          setWhisperQueueMode();
          whisperInput.value = '';
        }
        return;
      }
      whisperBtn.textContent = `Whisper (${remaining}s)`;
    }, 250);
  });

  // The mood line, goals and suggestion chips of the open whisper window.
  // They are this character's private options, so the server sends them to
  // the seat that plays the character and to no one else.
  function renderGuidance(msg: { mood?: string; trustHint?: string; goals?: string[]; suggestions?: string[] }): void {
    whisperArea.querySelector('.whisper-context')?.remove();
    whisperArea.querySelector('.whisper-goals')?.remove();
    whisperArea.querySelector('.whisper-suggestions')?.remove();
    if (msg.mood || msg.trustHint) {
      const moodEl = document.createElement('div');
      moodEl.className = 'whisper-context';
      const parts: string[] = [];
      if (msg.mood) parts.push(stripMarkdown(msg.mood));
      if (msg.trustHint) parts.push(msg.trustHint);
      moodEl.textContent = parts.join(' ');
      whisperArea.insertBefore(moodEl, whisperArea.firstChild);
    }
    if (msg.goals && msg.goals.length > 0) {
      // msg.goals is LLM-generated text derived from player-influenced
      // memories — not a trusted constant — so build each tag with
      // textContent rather than concatenating it into HTML.
      const goalsDiv = document.createElement('div');
      goalsDiv.className = 'whisper-goals';
      for (const g of msg.goals) {
        const tag = document.createElement('span');
        tag.className = 'goal-tag';
        tag.textContent = stripMarkdown(g);
        goalsDiv.appendChild(tag);
      }
      whisperArea.insertBefore(goalsDiv, whisperInput);
    }
    if (msg.suggestions && msg.suggestions.length > 0) {
      const sugDiv = document.createElement('div');
      sugDiv.className = 'whisper-suggestions';
      for (const raw of msg.suggestions) {
        const sug = stripMarkdown(raw);
        const btn = document.createElement('button');
        btn.className = 'suggestion-btn';
        btn.textContent = sug;
        btn.disabled = whisperLocked || gameOver;
        btn.addEventListener('click', () => {
          // Same lock as the box the chip fills (the button is disabled too;
          // this is the belt to that brace).
          if (whisperLocked || gameOver) return;
          whisperInput.value = sug;
          whisperInput.focus();
        });
        sugDiv.appendChild(btn);
      }
      whisperArea.insertBefore(sugDiv, whisperInput);
    }
  }
  ws.on('whisper-guidance', (msg) => {
    if (msg.type !== 'whisper-guidance' || gameOver) return;
    if (hasOwnCharacter && msg.characterId !== myCharacterId) return;
    renderGuidance(msg);
  });

  // The public line of a turn: what the character did and said. Their inner
  // thought and how they took the whisper are private (character-thought,
  // sent only to the seat that plays them); a replayed row from before that
  // split may still carry them, so they are drawn only when present.
  function renderActionTaken(msg: Extract<ServerMessage, { type: 'action-taken' }>): void {
    if (!epilogueSeen) turnInLiveScene = true;
    appendProse(msg.action, 'character', `${msg.characterName}: `);
    if (msg.spokenWords) {
      appendProse(msg.spokenWords, 'dialogue', '"', '"');
    }
    renderThought(msg);
  }
  function renderThought(msg: { characterName: string; innerThought?: string; whisperInfluence?: string }): void {
    if (msg.innerThought) appendProse(msg.innerThought, 'whisper', '(', ')');
    if (msg.whisperInfluence && msg.whisperInfluence !== 'none') {
      const label = msg.whisperInfluence === 'followed' ? 'heeded your whisper'
        : msg.whisperInfluence === 'partially-followed' ? 'partially heeded your whisper'
        : 'resisted your whisper';
      appendLog(`[${msg.characterName} ${label}]`, 'system');
    }
  }
  ws.on('character-thought', (msg) => {
    if (msg.type === 'character-thought') renderThought(msg);
  });
  ws.on('action-taken', (msg) => {
    if (msg.type !== 'action-taken') return;
    // Panel resets are live-turn chrome, not log content — a replay never
    // sees them, which is correct: it restores what happened, not what the
    // whisper box was doing at the moment the page died. The whisper box
    // only resets for the character whose window just closed; another
    // player's turn must not tear down my queue-mode box.
    if (windowCharId === msg.characterId) {
      if (whisperTimer) { clearInterval(whisperTimer); whisperTimer = null; }
      if (hasOwnCharacter) setWhisperQueueMode();
      else {
        whisperArea.style.display = 'none';
        setWhisperQueueMode();
      }
    }
    actionArea.innerHTML = '';
    renderActionTaken(msg);
  });

  ws.on('character-state-update', (msg) => {
    if (msg.type !== 'character-state-update' || gameOver) return;
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
      showPaused(null);
      closeWhispers();

      const total = sessionStats.followed + sessionStats.partial + sessionStats.ignored;
      const recapDiv = document.createElement('div');
      recapDiv.className = 'narration-entry session-recap';
      let recapHtml = '<div class="recap-title">Session Complete</div>';
      recapHtml += '<div class="recap-grid">';
      recapHtml += `<div class="recap-stat"><span class="recap-num">${scenesPlayed()}</span><span class="recap-label">Scenes</span></div>`;
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

  // Pause state. Everyone gets the banner; the host's toggle flips between
  // Pause and Resume. While paused the whisper box is locked — the server has
  // no running turn to take the words — except after quiet turns, where a
  // whisper is exactly what picks play back up. A held whisper window's
  // countdown stops here too; the server re-sends its prompt on resume.
  const pauseBanner = root.querySelector('#pause-banner') as HTMLElement;
  const pauseBtn = isHost ? (root.querySelector('#pause-btn') as HTMLButtonElement | null) : null;
  let pausedReason: PauseReason | null = null;
  let whisperLocked = false;
  function showPaused(reason: PauseReason | null): void {
    pausedReason = reason;
    if (reason) {
      pauseBanner.textContent = PAUSE_BANNER[reason];
      pauseBanner.classList.remove('hidden');
    } else {
      pauseBanner.textContent = '';
      pauseBanner.classList.add('hidden');
    }
    if (pauseBtn) {
      pauseBtn.textContent = reason ? 'Resume' : 'Pause';
      pauseBtn.disabled = false;
    }
    whisperLocked = reason !== null && reason !== 'quiet';
    applyWhisperLock();
    if (whisperLocked && whisperTimer) {
      clearInterval(whisperTimer);
      whisperTimer = null;
      whisperBtn.textContent = 'Whisper';
    }
  }
  ws.on('game-paused', (msg) => {
    if (msg.type !== 'game-paused' || gameOver) return;
    showPaused(msg.paused ? (msg.reason ?? 'host') : null);
  });

  // The input, the Whisper button and every suggestion chip lock together:
  // while paused (a chip filling a locked box is a click that goes nowhere)
  // and for good once the game is over.
  let gameOver = false;
  function applyWhisperLock(): void {
    const locked = whisperLocked || gameOver;
    whisperInput.disabled = locked;
    whisperBtn.disabled = locked || pendingWhispers.length > 0;
    for (const chip of whisperArea.querySelectorAll<HTMLButtonElement>('.suggestion-btn')) chip.disabled = locked;
  }

  // The table is closing (game-ending, then phase-change 'ended'): the server
  // has already closed any open window without a turn, so the countdown
  // stops here — it must never run out into "[You stayed silent.]" under the
  // epilogue — and the whisper box goes away for everyone.
  function closeWhispers(): void {
    gameOver = true;
    if (whisperTimer) { clearInterval(whisperTimer); whisperTimer = null; }
    if (whisperAckTimer) { clearTimeout(whisperAckTimer); whisperAckTimer = null; }
    windowCharId = null;
    whisperBtn.textContent = 'Whisper';
    whisperInput.value = '';
    applyWhisperLock();
    whisperArea.style.display = 'none';
    actionArea.innerHTML = '';
  }
  ws.on('game-ending', (msg) => {
    if (msg.type === 'game-ending') closeWhispers();
  });

  // Sent whispers waiting on their whisper-ack. A socket delivers messages
  // to one handler in order and the server acks synchronously, so acks
  // return in send order and a FIFO pairs each one with its text.
  const pendingWhispers: string[] = [];
  let whisperAckTimer: ReturnType<typeof setTimeout> | null = null;
  function sendWhisper(): void {
    const text = whisperInput.value.trim();
    if (!text || pendingWhispers.length > 0) return;
    pendingWhispers.push(text);
    ws.send({ type: 'whisper', text });
    whisperInput.value = '';
    whisperBtn.disabled = true;
    if (whisperTimer) { clearInterval(whisperTimer); whisperTimer = null; }
    if (whisperAckTimer) clearTimeout(whisperAckTimer);
    // The server routes whispers synchronously on the same socket, so five
    // silent seconds means the wire died, not that the table is thinking.
    whisperAckTimer = setTimeout(() => {
      whisperAckTimer = null;
      const lost = pendingWhispers.shift() ?? '';
      whisperBtn.disabled = whisperLocked || gameOver;
      whisperInput.value = lost;
      showSystemNotice('The table did not answer — your whisper may not have been sent.');
    }, 5_000);
  }

  ws.on('whisper-ack', (msg) => {
    if (msg.type !== 'whisper-ack') return;
    const text = pendingWhispers.shift() ?? '';
    if (whisperAckTimer) { clearTimeout(whisperAckTimer); whisperAckTimer = null; }
    if (pendingWhispers.length === 0) whisperBtn.disabled = whisperLocked || gameOver;
    if (msg.status === 'rejected') {
      // The words were not heard, so nothing goes into the log and the
      // draft goes back into the box — MUL-73's silent loss, inverted: the
      // player sees the refusal and keeps the text.
      showSystemNotice(msg.message || 'The table refused your whisper.');
      if (whisperInput.value.trim().length === 0) whisperInput.value = text;
      return;
    }
    appendLog(`You whisper: "${text}"`, 'whisper');
    if (msg.status === 'queued') {
      appendLog(`[${msg.message}]`, 'system');
    }
    if (hasOwnCharacter) setWhisperQueueMode();
    else whisperArea.style.display = 'none';
  });

  ws.on('whisper-dropped', (msg) => {
    if (msg.type !== 'whisper-dropped') return;
    // The broadcast is room-visible, but the saved words were one player's;
    // only their client has the context to say so.
    if (msg.characterId !== myCharacterId) return;
    appendLog(msg.count === 1
      ? '[Your saved whisper fades away unheard.]'
      : `[Your ${msg.count} saved whispers fade away unheard.]`, 'system');
  });

  whisperBtn.addEventListener('click', sendWhisper);
  whisperInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendWhisper(); });

  // A seated player's voice never needs a prompt to open — between windows
  // the server saves the words; the box is only ever in a different mode.
  if (hasOwnCharacter) {
    whisperArea.style.display = 'flex';
    setWhisperQueueMode();
  }

  if (isHost) {
    root.querySelector('#end-game-btn')?.addEventListener('click', () => {
      // Ending is final for everyone at the table, and the button sits right
      // next to Pause — ask first.
      if (!confirm('End the game for everyone? The DM will narrate an epilogue and the session will close.')) return;
      ws.send({ type: 'end-game' });
    });
    pauseBtn?.addEventListener('click', () => {
      ws.send({ type: pausedReason ? 'resume-game' : 'pause-game' });
      // Re-enabled by the server's game-paused answer (or its error).
      pauseBtn.disabled = true;
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
    if (pauseBtn) pauseBtn.disabled = false;
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
        case 'character-thought': renderThought(entry); break;
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
