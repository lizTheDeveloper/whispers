import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getDb, getDataDir } from './db.js';
import { createRoom, joinRoom } from './room.js';
import { ingestText, ingestPdf } from './rag/ingest.js';
import { DmAgent } from './agents/dm.js';
import { GameLoop } from './game-loop.js';
import { NegotiationRoom } from './negotiation.js';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import type { CampaignMaterial } from '../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '3000', 10);

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception — game state may be inconsistent:', err.stack ?? err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});

const app = express();
app.use(express.json());

const uploadTokens = new Map<string, { campaignId: string; expires: number }>();

app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });

function loadPresetPrompt(presetName: string): string {
  const presetPath = join(getDataDir(), 'dm-presets', `${presetName}.txt`);
  if (existsSync(presetPath)) return readFileSync(presetPath, 'utf-8').trim();
  return `You are a TTRPG Dungeon Master with the "${presetName}" personality. Run the game faithfully.`;
}

function getCampaignMaterials(campaignId: string): CampaignMaterial[] {
  const db = getDb();
  const rows = db.prepare('SELECT id, filename, chunk_count, created_at FROM campaign_materials WHERE campaign_id = ? ORDER BY created_at DESC').all(campaignId) as any[];
  return rows.map(r => ({ id: r.id, filename: r.filename, chunkCount: r.chunk_count, createdAt: r.created_at }));
}

app.post('/api/campaigns/:id/materials', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  const db = getDb();
  const campaignId = req.params.id;
  const filename = (req.headers['x-filename'] as string) || 'uploaded-file.txt';
  const token = req.headers['x-upload-token'] as string | undefined;

  if (!token) { res.status(403).json({ error: 'Missing upload token' }); return; }
  const session = uploadTokens.get(token);
  if (!session || session.campaignId !== campaignId || session.expires < Date.now()) {
    uploadTokens.delete(token ?? '');
    res.status(403).json({ error: 'Invalid or expired upload token' });
    return;
  }

  const campaign = db.prepare('SELECT id, system_id FROM campaigns WHERE id = ?').get(campaignId) as any;
  if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }

  const materialId = randomBytes(16).toString('hex');
  const systemId = `campaign:${campaignId}`;

  try {
    let chunkCount: number;
    if (filename.endsWith('.pdf')) {
      chunkCount = await ingestPdf(db, systemId, filename, req.body as Buffer);
    } else {
      const text = (req.body as Buffer).toString('utf-8');
      chunkCount = ingestText(db, systemId, filename, text);
    }

    db.prepare('INSERT INTO campaign_materials (id, campaign_id, filename, chunk_count) VALUES (?, ?, ?, ?)')
      .run(materialId, campaignId, filename, chunkCount);

    const material: CampaignMaterial = { id: materialId, filename, chunkCount, createdAt: new Date().toISOString() };
    res.json(material);
  } catch (err) {
    console.error('[materials] Ingestion failed:', err);
    res.status(500).json({ error: 'Failed to process file' });
  }
});

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
  setupChat: Array<{ role: string; content: string }>;
  charChat: Array<{ role: string; content: string }>;
}

const rooms = new Map<string, ConnectedPlayer[]>();
const gameLoops = new Map<string, GameLoop>();

interface PendingCharacter {
  charId: string;
  definition: import('../shared/types.js').CharacterDefinition;
  playerWs: WebSocket;
  playerName: string;
  aiApproved: boolean;
  aiFeedback: string;
  campaignId: string;
}
const pendingCharacters = new Map<string, PendingCharacter>();
const negotiations = new Map<string, NegotiationRoom>();

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
      currentPlayer = { ws, playerName: 'Host', characterId: null, isHost: true, setupChat: [], charChat: [] };
      rooms.set(joinCode, [currentPlayer]);
      send(ws, { type: 'room-joined', campaignId, joinCode, isHost: true });

      const presetPrompt = loadPresetPrompt(msg.dmPreset);
      const uploadToken = randomBytes(32).toString('hex');
      uploadTokens.set(uploadToken, { campaignId, expires: Date.now() + 4 * 60 * 60 * 1000 });
      send(ws, {
        type: 'dm-settings',
        presetName: msg.dmPreset,
        presetPrompt,
        dmCustomPrompt: null,
        dmInstructions: null,
        materials: [],
        uploadToken,
      });

      const dm = new DmAgent(db);
      dm.setupChat(msg.dmPreset, []).then(reply => {
        if (currentPlayer) {
          currentPlayer.setupChat.push({ role: 'assistant', content: reply.reply });
        }
        send(ws, { type: 'dm-chat-reply', text: reply.reply, done: false });
      }).catch(e => console.error('[dm-setup] greeting failed:', e));
    }

    if (msg.type === 'join') {
      const campaign = joinRoom(db, msg.joinCode);
      if (!campaign) { send(ws, { type: 'error', message: 'Invalid join code' }); return; }
      currentJoinCode = msg.joinCode;
      currentPlayer = { ws, playerName: msg.playerName, characterId: null, isHost: false, setupChat: [], charChat: [] };
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
      const charId = randomBytes(16).toString('hex');

      let validation;
      try {
        validation = await dm.validateCharacter(msg.definition, campaign.systemId);
      } catch (e) {
        console.error('[submit-character] validation failed:', e);
        send(ws, { type: 'character-validated', characterId: charId, approved: false, feedback: 'Character validation failed — please try again.' });
        return;
      }

      let finalDef = msg.definition;
      if (validation.modifications) {
        finalDef = { ...msg.definition, ...validation.modifications } as typeof msg.definition;
      }

      const feedbackText = validation.modifications
        ? `${validation.feedback} (DM adjusted: ${Object.keys(validation.modifications).join(', ')})`
        : validation.feedback;

      if (!validation.approved) {
        send(ws, { type: 'character-validated', characterId: charId, approved: false, feedback: feedbackText });
        return;
      }

      send(ws, { type: 'character-validated', characterId: charId, approved: true, feedback: `AI DM approved: ${feedbackText}. Opening negotiation...` });

      const playerName = currentPlayer?.playerName ?? 'Unknown';
      pendingCharacters.set(charId, {
        charId, definition: finalDef, playerWs: ws,
        playerName, aiApproved: true, aiFeedback: feedbackText, campaignId: campaign.id,
      });

      const players = rooms.get(currentJoinCode);
      const host = players?.find(p => p.isHost);
      if (host) {
        const negotiation = new NegotiationRoom(
          charId, finalDef, feedbackText, playerName,
          ws, host.ws, campaign.id, campaign.dmPreset,
        );
        negotiations.set(charId, negotiation);
        negotiation.open().catch(e => console.error('[negotiation] open failed:', e));
      }
    }

    if (msg.type === 'host-approve-character' && currentJoinCode && currentPlayer?.isHost) {
      const pending = pendingCharacters.get(msg.characterId);
      if (!pending) return;
      const hostCampaign = joinRoom(db, currentJoinCode);
      if (!hostCampaign || hostCampaign.id !== pending.campaignId) return;
      const initialState = JSON.stringify({
        stress: 0, consequences: [], fatePoints: 3,
        inventory: [], xpMilestones: [], whisperTrust: 0.65,
      });
      db.prepare('INSERT INTO characters (id, campaign_id, player_user_id, definition, state) VALUES (?, ?, ?, ?, ?)')
        .run(pending.charId, pending.campaignId, null, JSON.stringify(pending.definition), initialState);

      const playerInRoom = rooms.get(currentJoinCode)?.find(p => p.ws === pending.playerWs);
      if (playerInRoom) playerInRoom.characterId = pending.charId;

      send(pending.playerWs, { type: 'character-validated', characterId: pending.charId, approved: true, feedback: 'Approved by both AI DM and host!' });
      broadcast(currentJoinCode, { type: 'character-submitted', characterId: pending.charId, definition: pending.definition });
      const neg = negotiations.get(msg.characterId);
      if (neg) { neg.close(); negotiations.delete(msg.characterId); }
      pendingCharacters.delete(msg.characterId);
    }

    if (msg.type === 'host-reject-character' && currentJoinCode && currentPlayer?.isHost) {
      const pending = pendingCharacters.get(msg.characterId);
      if (!pending) return;
      const hostCampaign = joinRoom(db, currentJoinCode);
      if (!hostCampaign || hostCampaign.id !== pending.campaignId) return;
      send(pending.playerWs, { type: 'character-validated', characterId: pending.charId, approved: false, feedback: `Host feedback: ${msg.reason}` });
      const neg = negotiations.get(msg.characterId);
      if (neg) { neg.close(); negotiations.delete(msg.characterId); }
      pendingCharacters.delete(msg.characterId);
    }

    if (msg.type === 'negotiation-message' && currentJoinCode && currentPlayer) {
      const negotiation = negotiations.get(msg.characterId);
      if (!negotiation || negotiation.isClosed()) return;
      const sender = negotiation.isParticipant(ws);
      if (!sender) return;
      negotiation.handleMessage(sender, currentPlayer.playerName, msg.text)
        .catch(e => console.error('[negotiation] message handling failed:', e));
    }

    if (msg.type === 'char-chat' && currentJoinCode && currentPlayer) {
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      currentPlayer.charChat.push({ role: 'user', content: msg.text });
      const dm = new DmAgent(db);
      try {
        const reply = await dm.interviewForCharacter(campaign.systemId, currentPlayer.charChat);
        currentPlayer.charChat.push({ role: 'assistant', content: reply.reply });
        send(ws, { type: 'char-chat-reply', text: reply.reply, definition: reply.definition });
      } catch (e) {
        console.error('[char-chat] error:', e);
        send(ws, { type: 'char-chat-reply', text: 'I had trouble building your character — could you rephrase or give me more details?', definition: null });
      }
    }

    if (msg.type === 'dm-chat' && currentJoinCode && currentPlayer?.isHost) {
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      currentPlayer.setupChat.push({ role: 'user', content: msg.text });
      const dm = new DmAgent(db);
      try {
        const reply = await dm.setupChat(campaign.dmPreset, currentPlayer.setupChat);
        currentPlayer.setupChat.push({ role: 'assistant', content: reply.reply });
        if (reply.done && reply.dmInstructions) {
          db.prepare("UPDATE campaigns SET dm_instructions = ?, dm_custom_prompt = ?, updated_at = datetime('now') WHERE id = ?")
            .run(reply.dmInstructions, reply.dmCustomPrompt, campaign.id);
        }
        send(ws, { type: 'dm-chat-reply', text: reply.reply, done: reply.done });
      } catch (e) {
        console.error('[dm-chat] error:', e);
        currentPlayer.setupChat.pop();
        send(ws, { type: 'dm-chat-reply', text: 'Sorry, I lost my train of thought. Could you repeat that?', done: false });
      }
    }

    if (msg.type === 'update-dm-settings' && currentJoinCode && currentPlayer?.isHost) {
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      db.prepare("UPDATE campaigns SET dm_instructions = ?, dm_custom_prompt = ?, updated_at = datetime('now') WHERE id = ?")
        .run(msg.dmInstructions, msg.dmCustomPrompt, campaign.id);
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
        { campaignId: campaign.id, joinCode: jc, phase: 'playing', currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null },
      );
      gameLoops.set(jc, gameLoop);
      gameLoop.start().catch(e => console.error('Game loop error:', e));
    }

    if (msg.type === 'whisper' && currentJoinCode) {
      const raw = msg.text;
      if (typeof raw !== 'string' || raw.trim().length === 0) return;
      const whisperText = raw.trim().slice(0, 200);
      const loop = gameLoops.get(currentJoinCode);
      loop?.handleWhisper(whisperText);
    }

    if (msg.type === 'end-game' && currentJoinCode && currentPlayer?.isHost) {
      const jc = currentJoinCode;
      const loop = gameLoops.get(jc);
      if (loop) {
        loop.endGame().then(() => {
          gameLoops.delete(jc);
        }).catch(e => {
          console.error('[server] endGame failed:', e);
          broadcast(jc, { type: 'phase-change', phase: 'ended' });
          gameLoops.delete(jc);
        });
      } else {
        broadcast(jc, { type: 'phase-change', phase: 'ended' });
      }
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
