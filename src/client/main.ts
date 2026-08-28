import { WsClient } from './ws-client.js';
import { renderLobby } from './lobby.js';
import { renderCharacterCreator } from './character-creator.js';
import { renderGameView } from './game-view.js';

const root = document.getElementById('app')!;
const ws = new WsClient();

async function init() {
  await ws.connect();

  renderLobby(root, ws, (_campaignId, joinCode, isHost) => {
    renderCharacterCreator(root, ws, joinCode, () => {
      ws.on('phase-change', (msg) => {
        if (msg.type === 'phase-change' && msg.phase === 'playing') {
          renderGameView(root, ws, isHost);
        }
      });
    });
  });
}

init().catch(console.error);
