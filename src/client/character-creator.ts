import type { WsClient } from './ws-client.js';
import type { CharacterDefinition } from '../shared/types.js';
import { parseOneCharacter, parseCharacters } from '../shared/markdown-parser.js';

export function renderCharacterCreator(root: HTMLElement, ws: WsClient, joinCode: string, onApproved: () => void): void {
  root.innerHTML = `
    <div class="character-creator">
      <h2>Create Your Character</h2>
      <p>Join code: <strong>${joinCode}</strong> — share with friends</p>

      <div class="creator-tabs">
        <button class="tab active" data-tab="form">Build here</button>
        <button class="tab" data-tab="paste">Paste markdown</button>
      </div>

      <div class="tab-panel" id="panel-form">
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
      </div>

      <div class="tab-panel hidden" id="panel-paste">
        <p class="paste-hint">Paste one or more character sheets from ChatGPT, Claude, or any markdown source. Separate multiple characters with <code>---</code> or use <code># Character Name</code> headings. Each character uses headings or <strong>bold labels</strong> for: Name, High Concept, Trouble, Aspects, Personality, Backstory, Skills, Stunts.</p>
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

## High Concept
Elven Sage Who Speaks to Stars

## Trouble
Cryptic to a Fault

## Aspects
- Ancient Knowledge
- Patient as Stone

## Backstory
Elara left the Silver Court..."></textarea>
        <div id="parse-preview" class="parse-preview hidden"></div>
      </div>

      <button id="submit-char">Submit to DM for Approval</button>
      <div id="dm-feedback" class="feedback hidden"></div>
    </div>
  `;

  const tabs = root.querySelectorAll<HTMLButtonElement>('.creator-tabs .tab');
  const formPanel = root.querySelector('#panel-form') as HTMLElement;
  const pastePanel = root.querySelector('#panel-paste') as HTMLElement;
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      if (tab.dataset.tab === 'form') {
        formPanel.classList.remove('hidden');
        pastePanel.classList.add('hidden');
      } else {
        formPanel.classList.add('hidden');
        pastePanel.classList.remove('hidden');
      }
    });
  });

  const markdownArea = root.querySelector('#char-markdown') as HTMLTextAreaElement;
  const preview = root.querySelector('#parse-preview') as HTMLElement;
  const submitBtn = root.querySelector('#submit-char') as HTMLButtonElement;

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
      preview.innerHTML = `<strong>Parsed:</strong> ${c.name}` +
        (c.highConcept ? ` — ${c.highConcept}` : '') +
        (c.aspects.length ? `<br>Aspects: ${c.aspects.join(', ')}` : '') +
        (Object.keys(c.skills).length ? `<br>Skills: ${Object.entries(c.skills).map(([k,v]) => `${k} +${v}`).join(', ')}` : '');
      submitBtn.textContent = 'Submit to DM for Approval';
    } else {
      preview.innerHTML = `<strong>${valid.length} characters parsed:</strong><br>` +
        valid.map((c, i) => `${i + 1}. <strong>${c.name}</strong>` +
          (c.highConcept ? ` — ${c.highConcept}` : '') +
          (c.aspects.length ? ` (${c.aspects.length} aspects)` : '')
        ).join('<br>');
      submitBtn.textContent = `Submit all ${valid.length} characters`;
    }
  });

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
        skills: { Notice: 2, Fight: 1, Stealth: 1 },
        stunts: [],
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
    const feedback = root.querySelector('#dm-feedback') as HTMLElement;
    feedback.classList.remove('hidden');
    if (msg.approved) {
      approvedCount++;
      if (pendingCount > 1) {
        feedback.textContent = `${approvedCount}/${pendingCount} characters approved!`;
        submitBtn.textContent = `Awaiting DM review (${approvedCount}/${pendingCount})...`;
      }
      if (approvedCount >= pendingCount) {
        feedback.textContent = pendingCount > 1
          ? `All ${pendingCount} characters approved! Waiting for game to start...`
          : 'Character approved! Waiting for game to start...';
        feedback.classList.add('approved');
        onApproved();
      }
    } else {
      feedback.textContent = `DM feedback: ${msg.feedback}`;
      feedback.classList.add('rejected');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Resubmit';
    }
  });
}
