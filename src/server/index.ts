import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getDb, getDataDir } from './db.js';
import { createRoom, joinRoom } from './room.js';
import { ingestText } from './rag/ingest.js';
import { DmAgent } from './agents/dm.js';
import { GameLoop } from './game-loop.js';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '3000', 10);

const app = express();
app.use(express.json());

app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });

const clientDir = join(__dirname, '..', '..', 'client');
if (existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get('{*path}', (_req, res) => { res.sendFile(join(clientDir, 'index.html')); });
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

interface ConnectedPlayer {
  ws: WebSocket;
  playerName: string;
  characterId: string | null;
  isHost: boolean;
}

const rooms = new Map<string, ConnectedPlayer[]>();
const gameLoops = new Map<string, GameLoop>();

function broadcast(joinCode: string, msg: ServerMessage): void {
  const players = rooms.get(joinCode);
  if (!players) return;
  const data = JSON.stringify(msg);
  for (const p of players) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  const db = getDb();
  let currentJoinCode: string | null = null;
  let currentPlayer: ConnectedPlayer | null = null;

  ws.on('message', async (raw) => {
    let msg: ClientMessage;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'create') {
      const { campaignId, joinCode } = createRoom(db, {
        name: msg.name,
        dmPreset: msg.dmPreset,
        systemId: msg.systemId,
        scenarioId: msg.scenarioId ?? undefined,
        houseRules: msg.houseRules ?? undefined,
      });
      currentJoinCode = joinCode;
      currentPlayer = { ws, playerName: 'Host', characterId: null, isHost: true };
      rooms.set(joinCode, [currentPlayer]);
      send(ws, { type: 'room-joined', campaignId, joinCode, isHost: true });
    }

    if (msg.type === 'join') {
      const campaign = joinRoom(db, msg.joinCode);
      if (!campaign) { send(ws, { type: 'error', message: 'Invalid join code' }); return; }
      currentJoinCode = msg.joinCode;
      currentPlayer = { ws, playerName: msg.playerName, characterId: null, isHost: false };
      const players = rooms.get(msg.joinCode) ?? [];
      players.push(currentPlayer);
      rooms.set(msg.joinCode, players);
      send(ws, { type: 'room-joined', campaignId: campaign.id, joinCode: msg.joinCode, isHost: false });
      broadcast(msg.joinCode, { type: 'player-joined', playerName: msg.playerName, characterId: null });
    }

    if (msg.type === 'submit-character' && currentJoinCode) {
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      const dm = new DmAgent(db);
      const validation = await dm.validateCharacter(msg.definition, campaign.systemId);
      const charId = randomBytes(16).toString('hex');
      if (validation.approved) {
        const initialState = JSON.stringify({
          stress: 0, consequences: [], fatePoints: 3,
          inventory: [], xpMilestones: [], whisperTrust: 0.5,
        });
        db.prepare('INSERT INTO characters (id, campaign_id, player_user_id, definition, state) VALUES (?, ?, ?, ?, ?)')
          .run(charId, campaign.id, null, JSON.stringify(msg.definition), initialState);
        if (currentPlayer) currentPlayer.characterId = charId;
      }
      send(ws, { type: 'character-validated', characterId: charId, approved: validation.approved, feedback: validation.feedback });
      if (validation.approved) {
        broadcast(currentJoinCode, { type: 'character-submitted', characterId: charId, definition: msg.definition });
      }
    }

    if (msg.type === 'start-game' && currentJoinCode && currentPlayer?.isHost) {
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      const players = rooms.get(currentJoinCode);
      if (!players) return;
      const jc = currentJoinCode;
      const gameLoop = new GameLoop(
        db, campaign.id,
        (m) => broadcast(jc, m),
        (m) => { const host = players.find(p => p.isHost); if (host) send(host.ws, m); },
        { campaignId: campaign.id, joinCode: jc, phase: 'playing', currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false },
      );
      gameLoops.set(jc, gameLoop);
      gameLoop.start().catch(e => console.error('Game loop error:', e));
    }

    if (msg.type === 'whisper' && currentJoinCode) {
      const loop = gameLoops.get(currentJoinCode);
      loop?.handleWhisper(msg.text);
    }

    if (msg.type === 'end-game' && currentJoinCode && currentPlayer?.isHost) {
      const loop = gameLoops.get(currentJoinCode);
      if (loop) {
        loop.stop();
        gameLoops.delete(currentJoinCode);
      }
      broadcast(currentJoinCode, { type: 'phase-change', phase: 'ended' });
    }
  });

  ws.on('close', () => {
    if (!currentJoinCode || !currentPlayer) return;
    const players = rooms.get(currentJoinCode);
    if (players) {
      const idx = players.indexOf(currentPlayer);
      if (idx >= 0) players.splice(idx, 1);
      if (players.length === 0) {
        rooms.delete(currentJoinCode);
        const loop = gameLoops.get(currentJoinCode);
        if (loop) { loop.stop(); gameLoops.delete(currentJoinCode); }
      } else {
        broadcast(currentJoinCode, { type: 'player-left', playerName: currentPlayer.playerName });
      }
    }
  });
});

function bootstrapRules(): void {
  const db = getDb();
  const dataDir = getDataDir();
  const chunksExist = db.prepare("SELECT COUNT(*) as c FROM rule_chunks WHERE system_id = 'fate-core'").get() as { c: number };
  if (chunksExist.c === 0) {
    const srdPath = join(dataDir, 'systems', 'fate-core', 'srd.txt');
    if (existsSync(srdPath)) {
      const text = readFileSync(srdPath, 'utf-8');
      const count = ingestText(db, 'fate-core', 'FATE Core SRD', text);
      console.log(`Ingested FATE Core SRD: ${count} chunks`);
    }
  }
}

bootstrapRules();
server.listen(PORT, () => {
  console.log(`Whispers server listening on port ${PORT}`);
});

export { app, server, wss };
