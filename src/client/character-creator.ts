import type { WsClient } from './ws-client.js';
import type { CharacterDefinition } from '../shared/types.js';

function parseMarkdownCharacter(md: string): CharacterDefinition {
  const lines = md.split('\n');
  const def: CharacterDefinition = {
    name: '', highConcept: '', trouble: '',
    aspects: [], personality: '', backstory: '',
    skills: {}, stunts: [],
  };

  let currentSection = '';
  let sectionBuffer: string[] = [];

  function flushSection() {
    const text = sectionBuffer.join('\n').trim();
    if (!currentSection || !text) { sectionBuffer = []; return; }
    const key = currentSection.toLowerCase().replace(/[^a-z ]/g, '').trim();
    if (key === 'name' || key === 'character name') {
      def.name = text;
    } else if (key === 'high concept' || key === 'concept') {
      def.highConcept = text;
    } else if (key === 'trouble') {
      def.trouble = text;
    } else if (key === 'aspects' || key === 'other aspects' || key === 'additional aspects') {
      def.aspects = text.split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
    } else if (key === 'personality' || key === 'personality traits') {
      def.personality = text;
    } else if (key === 'backstory' || key === 'background' || key === 'history') {
      def.backstory = text;
    } else if (key === 'skills') {
      for (const line of text.split('\n')) {
        const m = line.match(/[-*]?\s*(.+?)[\s:]+\+?(\d+)/);
        if (m && m[1] && m[2]) def.skills[m[1].trim()] = parseInt(m[2], 10);
      }
    } else if (key === 'stunts' || key === 'special abilities') {
      def.stunts = text.split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
    }
    sectionBuffer = [];
  }

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)/);
    const boldLabel = line.match(/^\*\*(.+?)\*\*[:\s]*(.*)/);
    if (heading && heading[1]) {
      flushSection();
      currentSection = heading[1];
      continue;
    }
    if (boldLabel && boldLabel[1] && !currentSection) {
      flushSection();
      currentSection = boldLabel[1];
      if (boldLabel[2]?.trim()) sectionBuffer.push(boldLabel[2].trim());
      continue;
    }
    sectionBuffer.push(line);
  }
  flushSection();

  if (!def.name) {
    const firstHeading = lines.find(l => /^#\s+/.test(l));
    if (firstHeading) def.name = firstHeading.replace(/^#+\s*/, '').trim();
  }

  return def;
}

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
        <p class="paste-hint">Paste a character sheet from ChatGPT, Claude, or any markdown source. Use headings or <strong>bold labels</strong> for: Name, High Concept, Trouble, Aspects, Personality, Backstory, Skills, Stunts.</p>
        <textarea id="char-markdown" rows="16" placeholder="# Sigmund the Bold

## High Concept
Reformed Thief with a Heart of Gold

## Trouble
Can't Resist a Locked Door

## Aspects
- Quick Hands
- Loyal to a Fault

## Personality
Cautious but impulsive when gold is involved.

## Backstory
Born in the slums of Veridian...

## Skills
- Notice: +2
- Fight: +1
- Stealth: +1"></textarea>
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
  let lastActiveTab = 'form';

  markdownArea.addEventListener('input', () => {
    const parsed = parseMarkdownCharacter(markdownArea.value);
    if (parsed.name || parsed.highConcept || parsed.backstory) {
      preview.classList.remove('hidden');
      preview.innerHTML = `<strong>Parsed:</strong> ${parsed.name || '(no name)'}` +
        (parsed.highConcept ? ` — ${parsed.highConcept}` : '') +
        (parsed.aspects.length ? `<br>Aspects: ${parsed.aspects.join(', ')}` : '') +
        (Object.keys(parsed.skills).length ? `<br>Skills: ${Object.entries(parsed.skills).map(([k,v]) => `${k} +${v}`).join(', ')}` : '');
    } else {
      preview.classList.add('hidden');
    }
  });

  function getActiveTab(): string {
    const active = root.querySelector('.creator-tabs .tab.active') as HTMLButtonElement;
    return active?.dataset.tab || 'form';
  }

  const submitBtn = root.querySelector('#submit-char') as HTMLButtonElement;
  submitBtn.addEventListener('click', () => {
    let definition: CharacterDefinition;

    if (getActiveTab() === 'paste') {
      definition = parseMarkdownCharacter(markdownArea.value);
      if (!Object.keys(definition.skills).length) {
        definition.skills = { Notice: 2, Fight: 1, Stealth: 1 };
      }
    } else {
      definition = {
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
    }
    ws.send({ type: 'submit-character', definition });
    submitBtn.disabled = true;
    submitBtn.textContent = 'Awaiting DM review...';
  });

  ws.on('character-validated', (msg) => {
    if (msg.type !== 'character-validated') return;
    const feedback = root.querySelector('#dm-feedback') as HTMLElement;
    feedback.classList.remove('hidden');
    if (msg.approved) {
      feedback.textContent = 'Character approved! Waiting for game to start...';
      feedback.classList.add('approved');
      onApproved();
    } else {
      feedback.textContent = `DM feedback: ${msg.feedback}`;
      feedback.classList.add('rejected');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Resubmit';
    }
  });
}
