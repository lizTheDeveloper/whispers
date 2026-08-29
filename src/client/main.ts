import { WsClient } from './ws-client.js';
import { renderLobby } from './lobby.js';
import { renderCharacterCreator } from './character-creator.js';
import { renderGameView } from './game-view.js';
import { renderDmLobby } from './dm-lobby.js';

const root = document.getElementById('app')!;
const ws = new WsClient();

async function init() {
  await ws.connect();

  renderLobby(root, ws, (campaignId, joinCode, isHost) => {
    if (isHost) {
      renderDmLobby(root, ws, joinCode, campaignId, () => {
        renderGameView(root, ws, true);
      });
    } else {
      renderCharacterCreator(root, ws, joinCode, () => {
        ws.on('phase-change', (msg) => {
          if (msg.type === 'phase-change' && msg.phase === 'playing') {
            renderGameView(root, ws, false);
          }
        });
      });
    }
  });
}

init().catch(console.error);
