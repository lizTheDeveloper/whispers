import type { WsClient } from './ws-client.js';
import type { CharacterDefinition } from '../shared/types.js';
import { parseOneCharacter, parseCharacters } from '../shared/markdown-parser.js';
import { renderNegotiationChat } from './negotiation-chat.js';

const FATE_SKILLS = [
  'Athletics', 'Burglary', 'Contacts', 'Crafts', 'Deceive', 'Drive',
  'Empathy', 'Fight', 'Investigate', 'Lore', 'Notice', 'Physique',
  'Provoke', 'Rapport', 'Resources', 'Shoot', 'Stealth', 'Will',
];

const SKILL_PYRAMID = [
  { rank: 4, label: 'Great (+4)', count: 1 },
  { rank: 3, label: 'Good (+3)', count: 2 },
  { rank: 2, label: 'Fair (+2)', count: 3 },
  { rank: 1, label: 'Average (+1)', count: 4 },
];

function buildSkillOptions(selectedValue: string): string {
  return `<option value="">—</option>` +
    FATE_SKILLS.map(s => `<option value="${s}"${s === selectedValue ? ' selected' : ''}>${s}</option>`).join('');
}

function renderSkillPyramid(container: HTMLElement, defaults?: Record<string, number>): void {
  container.innerHTML = '';
  for (const tier of SKILL_PYRAMID) {
    const row = document.createElement('div');
    row.className = 'skill-tier';
    const label = document.createElement('span');
    label.className = 'tier-label';
    label.textContent = tier.label;
    row.appendChild(label);
    const defaultsForRank = defaults
      ? Object.entries(defaults).filter(([, v]) => v === tier.rank).map(([k]) => k)
      : [];
    for (let i = 0; i < tier.count; i++) {
      const select = document.createElement('select');
      select.className = 'skill-select';
      select.dataset.rank = String(tier.rank);
      select.innerHTML = buildSkillOptions(defaultsForRank[i] ?? '');
      row.appendChild(select);
    }
    container.appendChild(row);
  }
}

function readSkillPyramid(container: HTMLElement): Record<string, number> {
  const skills: Record<string, number> = {};
  for (const select of container.querySelectorAll<HTMLSelectElement>('.skill-select')) {
    const name = select.value;
    const rank = Number(select.dataset.rank);
    if (name) skills[name] = rank;
  }
  return skills;
}

export function renderCharacterCreator(root: HTMLElement, ws: WsClient, joinCode: string): void {
  root.innerHTML = `
    <div class="character-creator">
      <h2>Create Your Character</h2>
      <p>Join code: <strong>${joinCode}</strong></p>

      <div id="world-intro" class="world-introduction hidden">
        <h3>The World</h3>
        <div id="world-intro-text"></div>
      </div>

      <div class="creator-tabs">
        <button class="tab active" data-tab="chat">Talk to DM</button>
        <button class="tab" data-tab="form">Build here</button>
        <button class="tab" data-tab="paste">Paste markdown</button>
      </div>

      <div class="tab-panel" id="panel-chat">
        <div id="char-chat-log" class="dm-chat-log"></div>
        <div class="dm-chat-input">
          <input type="text" id="char-chat-input" placeholder="Tell the DM about your character idea..." />
          <button id="char-chat-send">Send</button>
        </div>
        <div id="chat-readiness" class="readiness-panel hidden">
          <p class="readiness-heading">Still shaping this character:</p>
          <ul id="readiness-list" class="readiness-list"></ul>
        </div>
        <div id="chat-char-preview" class="character-preview hidden">
          <h3 id="preview-name"></h3>
          <p id="preview-concept" class="preview-concept"></p>
          <p id="preview-trouble" class="preview-trouble"></p>
          <div class="preview-section">
            <h4>Aspects</h4>
            <ul id="preview-aspects"></ul>
          </div>
          <div class="preview-section">
            <h4>Skills</h4>
            <ul id="preview-skills"></ul>
          </div>
          <div class="preview-section">
            <h4>Stunts</h4>
            <ul id="preview-stunts"></ul>
          </div>
          <p id="preview-confirmed-note" class="preview-confirmed-note hidden">Confirmed — ready to submit.</p>
          <div class="preview-actions">
            <button id="preview-confirm">Confirm this character</button>
            <button id="preview-keep-talking" class="ghost-btn">Keep talking</button>
          </div>
        </div>
        <button id="chat-submit-char" class="hidden">Submit this character to DM for approval</button>
      </div>

      <div class="tab-panel hidden" id="panel-form">
        <div class="form-grid">
          <label>Name <input type="text" id="char-name" placeholder="Sigmund the Bold" /></label>
          <label>High Concept <input type="text" id="char-concept" placeholder="Reformed Thief with a Heart of Gold" /></label>
          <label>Trouble <input type="text" id="char-trouble" placeholder="Can't Resist a Locked Door" /></label>
          <label>Aspect 1 <input type="text" id="char-aspect1" placeholder="Quick Hands" /></label>
          <label>Aspect 2 <input type="text" id="char-aspect2" placeholder="Loyal to a Fault" /></label>
          <label>Aspect 3 <input type="text" id="char-aspect3" placeholder="Haunted by the Past" /></label>
          <label>Personality <textarea id="char-personality" rows="3" placeholder="Cautious but impulsive when gold is involved."></textarea></label>
          <label>Backstory <textarea id="char-backstory" rows="5" placeholder="Write your character's story..."></textarea></label>
        </div>
        <h3 class="skill-heading">Skills <span class="skill-hint">(FATE pyramid: 1×Great, 2×Good, 3×Fair, 4×Average)</span></h3>
        <div class="skill-pyramid" id="skill-pyramid"></div>
        <h3 class="skill-heading">Stunts</h3>
        <textarea id="char-stunts" rows="3" placeholder="One stunt per line, e.g.: Quick Fingers: +2 to Stealth when picking locks"></textarea>
      </div>

      <div class="tab-panel hidden" id="panel-paste">
        <p class="paste-hint">Paste one or more character sheets from ChatGPT, Claude, or any markdown source. Separate multiple characters with <code>---</code> or use <code># Character Name</code> headings.</p>
        <textarea id="char-markdown" rows="18" placeholder="# Sigmund the Bold

## High Concept
Reformed Thief with a Heart of Gold

## Trouble
Can't Resist a Locked Door

## Aspects
- Quick Hands
- Loyal to a Fault

## Backstory
Born in the slums of Veridian...

---

# Elara Moonwhisper
..."></textarea>
        <div id="parse-preview" class="parse-preview hidden"></div>
      </div>

      <button id="submit-char" class="hidden">Submit to DM for Approval</button>
      <div id="dm-feedback" class="feedback hidden"></div>
    </div>
  `;

  const pyramidEl = root.querySelector('#skill-pyramid') as HTMLElement;
  renderSkillPyramid(pyramidEl);

  const tabs = root.querySelectorAll<HTMLButtonElement>('.creator-tabs .tab');
  const formPanel = root.querySelector('#panel-form') as HTMLElement;
  const pastePanel = root.querySelector('#panel-paste') as HTMLElement;
  const chatPanel = root.querySelector('#panel-chat') as HTMLElement;
  const submitBtn = root.querySelector('#submit-char') as HTMLButtonElement;

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      formPanel.classList.add('hidden');
      pastePanel.classList.add('hidden');
      chatPanel.classList.add('hidden');
      submitBtn.classList.remove('hidden');

      if (tab.dataset.tab === 'form') formPanel.classList.remove('hidden');
      else if (tab.dataset.tab === 'paste') pastePanel.classList.remove('hidden');
      else {
        chatPanel.classList.remove('hidden');
        submitBtn.classList.add('hidden');
      }
    });
  });

  // --- Chat with DM tab ---
  const chatLog = root.querySelector('#char-chat-log') as HTMLElement;
  const chatInput = root.querySelector('#char-chat-input') as HTMLInputElement;
  const chatSend = root.querySelector('#char-chat-send') as HTMLButtonElement;
  const chatSubmitBtn = root.querySelector('#chat-submit-char') as HTMLButtonElement;
  let chatDefinition: CharacterDefinition | null = null;
  const defaultSubmitLabel = submitBtn.textContent ?? 'Submit to DM for Approval';
  const defaultChatSubmitLabel = chatSubmitBtn.textContent ?? 'Submit this character to DM for approval';

  // The world introduction: model-written prose, rendered above the tabs and
  // kept visible for the whole interview (never hidden by a tab switch).
  const worldIntroEl = root.querySelector('#world-intro') as HTMLElement;
  const worldIntroText = root.querySelector('#world-intro-text') as HTMLElement;

  function renderWorldIntro(text: string) {
    worldIntroText.replaceChildren();
    const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    for (const p of paragraphs.length > 0 ? paragraphs : [text]) {
      const para = document.createElement('p');
      para.textContent = p;
      worldIntroText.appendChild(para);
    }
    worldIntroEl.classList.remove('hidden');
  }

  ws.on('world-introduction', (msg) => {
    if (msg.type !== 'world-introduction') return;
    renderWorldIntro(msg.text);
  });

  // The readiness checklist: shown when the DM proposed a sheet the server
  // judged unfinished. This is not a failure state — the interview is
  // continuing — so it reads as a checklist, not an error.
  const readinessPanel = root.querySelector('#chat-readiness') as HTMLElement;
  const readinessList = root.querySelector('#readiness-list') as HTMLElement;

  function renderReadiness(detail: string[]) {
    readinessList.replaceChildren();
    for (const line of detail) {
      const li = document.createElement('li');
      li.className = 'readiness-item';
      li.textContent = line;
      readinessList.appendChild(li);
    }
    readinessPanel.classList.toggle('hidden', detail.length === 0);
  }

  // The proposed sheet: name, high concept, trouble, aspects, skills, stunts.
  // Everything here is model-generated, so every field is set with
  // textContent and every list is rebuilt with replaceChildren — never
  // innerHTML with a value spliced in.
  const previewPanel = root.querySelector('#chat-char-preview') as HTMLElement;
  const previewName = root.querySelector('#preview-name') as HTMLElement;
  const previewConcept = root.querySelector('#preview-concept') as HTMLElement;
  const previewTrouble = root.querySelector('#preview-trouble') as HTMLElement;
  const previewAspects = root.querySelector('#preview-aspects') as HTMLElement;
  const previewSkills = root.querySelector('#preview-skills') as HTMLElement;
  const previewStunts = root.querySelector('#preview-stunts') as HTMLElement;
  const previewConfirmedNote = root.querySelector('#preview-confirmed-note') as HTMLElement;
  const previewConfirmBtn = root.querySelector('#preview-confirm') as HTMLButtonElement;
  const previewKeepTalkingBtn = root.querySelector('#preview-keep-talking') as HTMLButtonElement;
  // Set right before sending confirm-character, and consumed by the next
  // character-preview message — the server's ack of that confirmation has
  // the exact same shape as a fresh proposal, so this is how the client
  // tells them apart.
  let awaitingConfirmAck = false;

  function renderPreviewSheet(def: CharacterDefinition) {
    previewName.textContent = def.name;
    previewConcept.textContent = def.highConcept;
    previewTrouble.textContent = `Trouble: ${def.trouble}`;

    previewAspects.replaceChildren();
    for (const aspect of def.aspects) {
      const li = document.createElement('li');
      li.textContent = aspect;
      previewAspects.appendChild(li);
    }

    previewSkills.replaceChildren();
    for (const [skill, rank] of Object.entries(def.skills)) {
      const li = document.createElement('li');
      li.textContent = `${skill} (+${rank})`;
      previewSkills.appendChild(li);
    }

    previewStunts.replaceChildren();
    for (const stunt of def.stunts) {
      const li = document.createElement('li');
      li.textContent = stunt;
      previewStunts.appendChild(li);
    }
  }

  /**
   * Renders the proposed sheet. `confirmed` distinguishes the server's ack of
   * confirm-character from a fresh, not-yet-confirmed proposal: only once
   * confirmed does the submit affordance appear — confirming is the real
   * gate, this screen never lets the player edit the sheet afterward.
   */
  function showPreview(def: CharacterDefinition, confirmed: boolean) {
    chatDefinition = def;
    renderPreviewSheet(def);
    previewPanel.classList.remove('hidden');
    readinessPanel.classList.add('hidden');

    if (confirmed) {
      previewConfirmBtn.classList.add('hidden');
      previewKeepTalkingBtn.classList.add('hidden');
      previewConfirmedNote.classList.remove('hidden');
      chatSubmitBtn.classList.remove('hidden');
      chatSubmitBtn.disabled = false;
      chatSubmitBtn.textContent = `Submit ${def.name} to DM for approval`;
    } else {
      previewConfirmBtn.classList.remove('hidden');
      previewConfirmBtn.disabled = false;
      previewConfirmBtn.textContent = 'Confirm this character';
      previewKeepTalkingBtn.classList.remove('hidden');
      previewConfirmedNote.classList.add('hidden');
      chatSubmitBtn.classList.add('hidden');
    }
  }

  previewConfirmBtn.addEventListener('click', () => {
    awaitingConfirmAck = true;
    previewConfirmBtn.disabled = true;
    previewConfirmBtn.textContent = 'Confirming...';
    ws.send({ type: 'confirm-character' });
  });

  previewKeepTalkingBtn.addEventListener('click', () => {
    previewPanel.classList.add('hidden');
    chatInput.focus();
  });

  ws.on('character-preview', (msg) => {
    if (msg.type !== 'character-preview') return;
    const confirmed = awaitingConfirmAck;
    awaitingConfirmAck = false;
    showPreview(msg.definition, confirmed);
  });

  ws.on('character-readiness', (msg) => {
    if (msg.type !== 'character-readiness') return;
    awaitingConfirmAck = false;
    previewPanel.classList.add('hidden');
    // A confirmed sheet's submit button lives outside previewPanel, so
    // hiding the panel alone leaves it showing "Submit X..." right next to
    // "still shaping this character" — hide it too so the screen doesn't
    // contradict itself. Harmless server-side (a confirmed interview
    // resubmits its own stored definition either way); this is purely about
    // not telling the player two things at once.
    chatSubmitBtn.classList.add('hidden');
    renderReadiness(msg.readiness.detail);
  });

  ws.on('interview-replay', (msg) => {
    if (msg.type !== 'interview-replay') return;
    awaitingConfirmAck = false;
    chatSend.disabled = false;

    // The transcript's first turn IS the world introduction only while
    // introduction generation succeeded when this interview started —
    // sendWorldIntroduction can fail (LLM timeout/outage) and sends nothing,
    // in which case position 0 is the player's own first real message. Hoist
    // it into the intro container only when it is genuinely an assistant
    // turn; otherwise replay the whole transcript as chat bubbles so nothing
    // is silently relocated or dropped.
    const introTurn = msg.transcript[0]?.role === 'assistant' ? msg.transcript[0] : undefined;
    const rest = introTurn ? msg.transcript.slice(1) : msg.transcript;
    if (introTurn) renderWorldIntro(introTurn.content);

    const bubbles = rest.map(turn => {
      const bubble = document.createElement('div');
      bubble.className = `dm-chat-bubble ${turn.role === 'user' ? 'player' : 'dm'}`;
      bubble.textContent = turn.content;
      return bubble;
    });
    chatLog.replaceChildren(...bubbles);
    chatLog.scrollTop = chatLog.scrollHeight;

    readinessPanel.classList.add('hidden');
    if (msg.definition) {
      // A restored proposal is shown unconfirmed — re-confirming is a no-op
      // on the server, and the client has no way to know from this message
      // alone whether it was confirmed before the reconnect.
      showPreview(msg.definition, false);
    } else {
      previewPanel.classList.add('hidden');
    }
  });

  function addChatMsg(text: string, sender: 'dm' | 'player') {
    const bubble = document.createElement('div');
    bubble.className = `dm-chat-bubble ${sender}`;
    bubble.textContent = text;
    chatLog.appendChild(bubble);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function sendCharChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    addChatMsg(text, 'player');
    chatInput.value = '';
    chatSend.disabled = true;

    const typing = document.createElement('div');
    typing.className = 'dm-chat-bubble dm typing';
    typing.id = 'char-typing';
    typing.textContent = 'DM is thinking...';
    chatLog.appendChild(typing);
    chatLog.scrollTop = chatLog.scrollHeight;

    ws.send({ type: 'char-chat', text });
  }

  chatSend.addEventListener('click', sendCharChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendCharChat();
  });

  ws.on('char-chat-reply', (msg) => {
    if (msg.type !== 'char-chat-reply') return;
    const typing = chatLog.querySelector('#char-typing');
    if (typing) typing.remove();
    chatSend.disabled = false;

    addChatMsg(msg.text, 'dm');
  });

  chatSubmitBtn.addEventListener('click', () => {
    if (!chatDefinition) return;
    ws.send({ type: 'submit-character', definition: chatDefinition });
    pendingCount = 1;
    approvedCount = 0;
    chatSubmitBtn.disabled = true;
    chatSubmitBtn.textContent = 'Awaiting DM review...';
  });

  // --- Paste markdown tab ---
  const markdownArea = root.querySelector('#char-markdown') as HTMLTextAreaElement;
  const preview = root.querySelector('#parse-preview') as HTMLElement;

  markdownArea.addEventListener('input', () => {
    const chars = parseCharacters(markdownArea.value);
    const valid = chars.filter(c => c.name);
    if (valid.length === 0) {
      preview.classList.add('hidden');
      submitBtn.textContent = 'Submit to DM for Approval';
      return;
    }
    preview.classList.remove('hidden');
    if (valid.length === 1) {
      const c = valid[0]!;
      preview.textContent = `Parsed: ${c.name}` +
        (c.highConcept ? ` — ${c.highConcept}` : '');
      submitBtn.textContent = 'Submit to DM for Approval';
    } else {
      preview.textContent = `${valid.length} characters parsed: ` +
        valid.map(c => c.name).join(', ');
      submitBtn.textContent = `Submit all ${valid.length} characters`;
    }
  });

  // --- Submit logic ---
  function getActiveTab(): string {
    const active = root.querySelector('.creator-tabs .tab.active') as HTMLButtonElement;
    return active?.dataset.tab || 'chat';
  }

  let pendingCount = 0;
  let approvedCount = 0;

  submitBtn.addEventListener('click', () => {
    if (getActiveTab() === 'paste') {
      const chars = parseCharacters(markdownArea.value).filter(c => c.name);
      for (const def of chars) {
        ws.send({ type: 'submit-character', definition: def });
      }
      pendingCount = chars.length;
      approvedCount = 0;
      submitBtn.disabled = true;
      submitBtn.textContent = chars.length > 1
        ? `Awaiting DM review (0/${chars.length})...`
        : 'Awaiting DM review...';
    } else {
      const skills = readSkillPyramid(pyramidEl);
      const stuntsRaw = (root.querySelector('#char-stunts') as HTMLTextAreaElement).value.trim();
      const stunts = stuntsRaw ? stuntsRaw.split('\n').map(s => s.trim()).filter(Boolean) : [];
      const definition: CharacterDefinition = {
        name: (root.querySelector('#char-name') as HTMLInputElement).value.trim(),
        highConcept: (root.querySelector('#char-concept') as HTMLInputElement).value.trim(),
        trouble: (root.querySelector('#char-trouble') as HTMLInputElement).value.trim(),
        aspects: [
          (root.querySelector('#char-aspect1') as HTMLInputElement).value.trim(),
          (root.querySelector('#char-aspect2') as HTMLInputElement).value.trim(),
          (root.querySelector('#char-aspect3') as HTMLInputElement).value.trim(),
        ].filter(Boolean),
        personality: (root.querySelector('#char-personality') as HTMLTextAreaElement).value.trim(),
        backstory: (root.querySelector('#char-backstory') as HTMLTextAreaElement).value.trim(),
        skills,
        stunts,
      };
      ws.send({ type: 'submit-character', definition });
      pendingCount = 1;
      approvedCount = 0;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Awaiting DM review...';
    }
  });

  ws.on('character-validated', (msg) => {
    if (msg.type !== 'character-validated') return;
    // Handlers are never off()'d, so a stale one can still fire after this
    // view is gone (e.g. after phase-change swaps in the game view). Self-
    // disarm rather than deref a query that now returns null.
    const feedback = root.querySelector('#dm-feedback') as HTMLElement | null;
    if (!feedback) return;
    feedback.classList.remove('hidden');
    if (msg.approved) {
      approvedCount++;
      if (pendingCount > 1) {
        feedback.textContent = `${approvedCount}/${pendingCount} characters approved!`;
        submitBtn.textContent = `Awaiting DM review (${approvedCount}/${pendingCount})...`;
      }
      if (approvedCount >= pendingCount) {
        // 'approved' arrives twice — once from the AI DM, once from the human
        // host. Only the server knows which stage this is, so use its words
        // rather than claiming the character is cleared to play.
        feedback.textContent = pendingCount > 1
          ? `All ${pendingCount} characters approved. ${msg.feedback}`
          : msg.feedback;
        feedback.classList.add('approved');
      }
    } else {
      feedback.textContent = `DM feedback: ${msg.feedback}`;
      feedback.classList.add('rejected');
      submitBtn.disabled = false;
      chatSubmitBtn.disabled = false;
      submitBtn.textContent = 'Resubmit';
      chatSubmitBtn.textContent = 'Resubmit character';
    }
  });

  ws.on('negotiation-opened', (msg) => {
    if (msg.type !== 'negotiation-opened') return;
    const feedback = root.querySelector('#dm-feedback') as HTMLElement | null;
    if (!feedback) return;
    feedback.classList.remove('hidden');
    feedback.textContent = 'AI DM approved your character. Entering negotiation with the host...';
    feedback.className = 'feedback';

    const negContainer = document.createElement('div');
    negContainer.id = 'negotiation-container';
    root.querySelector('.character-creator')!.appendChild(negContainer);
    renderNegotiationChat(negContainer, ws, msg.characterId, msg.characterName, msg.playerName, false);
  });

  // A submission or interview can be refused server-side (e.g. the world
  // isn't built yet — a backstop against a stale tab). Without this, the
  // submit button is stuck on "Awaiting DM review..." forever and/or the
  // chat leaves a permanent "DM is thinking..." spinner. main.ts already
  // handles the 'session is no longer valid' case by routing back to the
  // lobby, so leave that one alone here.
  ws.on('error', (msg) => {
    if (msg.type !== 'error') return;
    if (msg.message.includes('session is no longer valid')) return;

    // Handlers are never off()'d, so this can still fire after the player
    // has moved on to another view (phase-change swapped root's contents
    // out from under it). Self-disarm rather than deref a stale query.
    const feedback = root.querySelector('#dm-feedback') as HTMLElement | null;
    if (!feedback) return;

    submitBtn.disabled = false;
    submitBtn.textContent = defaultSubmitLabel;

    chatSubmitBtn.disabled = false;
    chatSubmitBtn.textContent = defaultChatSubmitLabel;

    chatSend.disabled = false;
    const typing = chatLog.querySelector('#char-typing');
    if (typing) typing.remove();

    // A rejected confirm-character (e.g. "not finished yet") must not leave
    // the confirm button stuck disabled on "Confirming...", awaiting an ack
    // that is never coming.
    if (awaitingConfirmAck) {
      awaitingConfirmAck = false;
      previewConfirmBtn.disabled = false;
      previewConfirmBtn.textContent = 'Confirm this character';
    }

    // A previous 'approved' class must not linger under a rejection — set
    // the full class list rather than adding on top of it, matching
    // negotiation-opened's approach above.
    feedback.className = 'feedback rejected';
    feedback.textContent = msg.message;
  });
}
