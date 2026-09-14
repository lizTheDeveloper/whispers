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

      <div class="creator-tabs">
        <button class="tab" data-tab="chat">Talk to DM</button>
        <button class="tab active" data-tab="form">Build here</button>
        <button class="tab" data-tab="paste">Paste markdown</button>
      </div>

      <div class="tab-panel hidden" id="panel-chat">
        <div id="char-chat-log" class="dm-chat-log"></div>
        <div class="dm-chat-input">
          <input type="text" id="char-chat-input" placeholder="Tell the DM about your character idea..." />
          <button id="char-chat-send">Send</button>
        </div>
        <div id="chat-char-preview" class="parse-preview hidden"></div>
        <button id="chat-submit-char" class="hidden">Submit this character to DM for approval</button>
      </div>

      <div class="tab-panel" id="panel-form">
        <div class="form-grid">
          <label>Name <input type="text" id="char-name" value="Sigmund the Bold" /></label>
          <label>High Concept <input type="text" id="char-concept" value="Reformed Thief with a Heart of Gold" /></label>
          <label>Trouble <input type="text" id="char-trouble" value="Can't Resist a Locked Door" /></label>
          <label>Aspect 1 <input type="text" id="char-aspect1" value="Quick Hands" /></label>
          <label>Aspect 2 <input type="text" id="char-aspect2" value="Loyal to a Fault" /></label>
          <label>Aspect 3 <input type="text" id="char-aspect3" value="Haunted by the Past" /></label>
          <label>Personality <textarea id="char-personality" rows="3">Cautious but impulsive when gold is involved.</textarea></label>
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

      <button id="submit-char">Submit to DM for Approval</button>
      <div id="dm-feedback" class="feedback hidden"></div>
    </div>
  `;

  const pyramidEl = root.querySelector('#skill-pyramid') as HTMLElement;
  renderSkillPyramid(pyramidEl, { Burglary: 4, Stealth: 3, Notice: 3, Athletics: 2, Deceive: 2, Contacts: 2, Fight: 1, Rapport: 1, Investigate: 1, Will: 1 });

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
  const chatPreview = root.querySelector('#chat-char-preview') as HTMLElement;
  const chatSubmitBtn = root.querySelector('#chat-submit-char') as HTMLButtonElement;
  let chatDefinition: CharacterDefinition | null = null;
  const defaultSubmitLabel = submitBtn.textContent ?? 'Submit to DM for Approval';
  const defaultChatSubmitLabel = chatSubmitBtn.textContent ?? 'Submit this character to DM for approval';

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

    if (msg.definition) {
      chatDefinition = msg.definition;
      chatPreview.classList.remove('hidden');
      chatPreview.textContent = `${msg.definition.name} — ${msg.definition.highConcept}`;
      chatSubmitBtn.classList.remove('hidden');
      chatSubmitBtn.textContent = `Submit ${msg.definition.name} to DM for approval`;
    }
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
    return active?.dataset.tab || 'form';
  }

  let pendingCount = 0;
  let approvedCount = 0;

  submitBtn.addEventListener('click', () => {
    if (getActiveTab() === 'paste') {
      const chars = parseCharacters(markdownArea.value).filter(c => c.name);
      for (const def of chars) {
        if (!Object.keys(def.skills).length) {
          def.skills = { Notice: 2, Fight: 1, Stealth: 1 };
        }
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
      if (Object.keys(skills).length === 0) {
        skills['Notice'] = 2;
        skills['Fight'] = 1;
        skills['Stealth'] = 1;
      }
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

    // A previous 'approved' class must not linger under a rejection — set
    // the full class list rather than adding on top of it, matching
    // negotiation-opened's approach above.
    feedback.className = 'feedback rejected';
    feedback.textContent = msg.message;
  });
}
