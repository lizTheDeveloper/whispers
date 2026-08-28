import type { WsClient } from './ws-client.js';
import type { CharacterDefinition } from '../shared/types.js';

export function renderCharacterCreator(root: HTMLElement, ws: WsClient, joinCode: string, onApproved: () => void): void {
  root.innerHTML = `
    <div class="character-creator">
      <h2>Create Your Character</h2>
      <p>Join code: <strong>${joinCode}</strong> — share with friends</p>

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

      <button id="submit-char">Submit to DM for Approval</button>
      <div id="dm-feedback" class="feedback hidden"></div>
    </div>
  `;

  const submitBtn = root.querySelector('#submit-char') as HTMLButtonElement;
  submitBtn.addEventListener('click', () => {
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
