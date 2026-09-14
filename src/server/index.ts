import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getDb, getDataDir } from './db.js';
import {
  createRoom, joinRoom, createSession, getSession, touchSession, setSessionCharacter,
  savePendingCharacter, listPendingCharacters, deletePendingCharacter,
  saveSetupChat, loadSetupChat, setCampaignPhase, advancePhaseIfLobby, setHostTableRole,
  type PendingCharacterRow,
} from './room.js';
import { ingestText, ingestPdf } from './rag/ingest.js';
import { DmAgent } from './agents/dm.js';
import { GameLoop } from './game-loop.js';
import { NegotiationRoom } from './negotiation.js';
import { hasDmAuthority, isWorldAuthor } from './seat.js';
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
  sessionToken: string;
  playerName: string;
  characterId: string | null;
  isOwner: boolean;
  setupChat: Array<{ role: string; content: string }>;
  charChat: Array<{ role: string; content: string }>;
}

const rooms = new Map<string, ConnectedPlayer[]>();
const gameLoops = new Map<string, GameLoop>();
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

function socketFor(joinCode: string, sessionToken: string): WebSocket | null {
  const p = rooms.get(joinCode)?.find(x => x.sessionToken === sessionToken);
  return p && p.ws.readyState === WebSocket.OPEN ? p.ws : null;
}

function hostSocket(joinCode: string): WebSocket | null {
  const h = rooms.get(joinCode)?.find(p => p.isOwner);
  return h && h.ws.readyState === WebSocket.OPEN ? h.ws : null;
}

function pendingReviewMsg(p: PendingCharacterRow): ServerMessage {
  return {
    type: 'character-pending-review',
    characterId: p.id,
    definition: p.definition,
    aiApproved: true,
    aiFeedback: p.aiFeedback,
    playerName: p.playerName,
  };
}

function openNegotiation(
  campaign: { id: string; dmPreset: string },
  joinCode: string,
  pending: PendingCharacterRow,
): void {
  if (negotiations.has(pending.id)) return;
  const negotiation = new NegotiationRoom(
    pending.id, pending.definition, pending.aiFeedback, pending.playerName,
    () => socketFor(joinCode, pending.sessionToken),
    () => hostSocket(joinCode),
    campaign.id, campaign.dmPreset,
  );
  negotiations.set(pending.id, negotiation);
  negotiation.open().catch(e => console.error('[negotiation] open failed:', e));
}

function sendDmSettings(ws: WebSocket, campaign: import('../shared/types.js').Campaign): void {
  const uploadToken = randomBytes(32).toString('hex');
  uploadTokens.set(uploadToken, { campaignId: campaign.id, expires: Date.now() + 4 * 60 * 60 * 1000 });
  send(ws, {
    type: 'dm-settings',
    presetName: campaign.dmPreset,
    presetPrompt: loadPresetPrompt(campaign.dmPreset),
    dmCustomPrompt: campaign.dmCustomPrompt,
    dmInstructions: campaign.dmInstructions,
    materials: getCampaignMaterials(campaign.id),
    uploadToken,
  });
}

/**
 * Rebuild a reconnecting participant's screen from durable state. Without this
 * a refresh leaves the DM staring at an empty lobby even once their host role
 * is restored.
 */
function sendLobbyState(ws: WebSocket, campaign: import('../shared/types.js').Campaign, joinCode: string): void {
  const db = getDb();
  const players = (rooms.get(joinCode) ?? []).filter(p => !p.isOwner).map(p => p.playerName);
  const approved = db.prepare('SELECT COUNT(*) AS c FROM characters WHERE campaign_id = ?').get(campaign.id) as { c: number };
  send(ws, {
    type: 'lobby-state',
    players: [...new Set(players)],
    setupChat: loadSetupChat(db, campaign.id),
    dmReady: Boolean(campaign.dmInstructions),
    approvedCount: approved.c,
  });
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
      const session = createSession(db, { campaignId, joinCode, playerName: 'Host', isHost: true });
      currentJoinCode = joinCode;
      currentPlayer = { ws, sessionToken: session.token, playerName: 'Host', characterId: null, isOwner: true, setupChat: [], charChat: [] };
      rooms.set(joinCode, [currentPlayer]);

      const campaign = joinRoom(db, joinCode);
      send(ws, {
        type: 'room-joined',
        campaignId, joinCode, isOwner: true, tableRole: campaign ? campaign.hostTableRole : null,
        sessionToken: session.token,
        gameName: msg.name,
        playerName: 'Host',
        phase: 'lobby',
      });

      if (campaign) sendDmSettings(ws, campaign);

      const dm = new DmAgent(db);
      dm.setupChat(msg.dmPreset, []).then(reply => {
        if (currentPlayer) {
          currentPlayer.setupChat.push({ role: 'assistant', content: reply.reply });
          saveSetupChat(db, campaignId, currentPlayer.setupChat);
        }
        send(ws, { type: 'dm-chat-reply', text: reply.reply, done: false });
      }).catch(e => console.error('[dm-setup] greeting failed:', e));
    }

    if (msg.type === 'join') {
      const campaign = joinRoom(db, msg.joinCode);
      if (!campaign) { send(ws, { type: 'error', message: 'Invalid join code' }); return; }
      const session = createSession(db, { campaignId: campaign.id, joinCode: msg.joinCode, playerName: msg.playerName, isHost: false });
      currentJoinCode = msg.joinCode;
      currentPlayer = { ws, sessionToken: session.token, playerName: msg.playerName, characterId: null, isOwner: false, setupChat: [], charChat: [] };
      const players = rooms.get(msg.joinCode) ?? [];
      players.push(currentPlayer);
      rooms.set(msg.joinCode, players);
      send(ws, {
        type: 'room-joined',
        campaignId: campaign.id, joinCode: msg.joinCode, isOwner: false, tableRole: campaign.hostTableRole,
        sessionToken: session.token,
        gameName: campaign.name,
        playerName: msg.playerName,
        phase: campaign.phase,
      });
      broadcast(msg.joinCode, { type: 'player-joined', playerName: msg.playerName, characterId: null });
    }

    if (msg.type === 'rejoin') {
      const campaign = joinRoom(db, msg.joinCode);
      if (!campaign) { send(ws, { type: 'error', message: 'Invalid join code' }); return; }

      // A rejoin reclaims an existing seat, so it must prove ownership of that
      // seat. The session token is the only proof there is: the join code is
      // public by design (it is handed to every player), and the host's display
      // name is the fixed string 'Host'. Matching on either would let any
      // player claim the DM chair and hijack its socket. There is deliberately
      // no fallback — every client path sends a token, and a caller without one
      // is asking to become someone else. New arrivals use 'join'.
      const session = msg.sessionToken ? getSession(db, msg.sessionToken) : null;
      if (!session || session.joinCode !== msg.joinCode) {
        send(ws, { type: 'error', message: 'That session is no longer valid — rejoin with the code.' });
        return;
      }

      const playerName = session.playerName;
      const isOwner = session.isHost;
      currentJoinCode = msg.joinCode;

      const players = rooms.get(msg.joinCode) ?? [];
      if (!rooms.has(msg.joinCode)) rooms.set(msg.joinCode, players);

      const existing = players.find(p => p.sessionToken === session.token);

      if (existing) {
        existing.ws = ws;
        existing.isOwner = isOwner;
        currentPlayer = existing;
      } else {
        currentPlayer = {
          ws, sessionToken: session.token, playerName,
          characterId: session.characterId,
          isOwner, setupChat: [], charChat: [],
        };
        players.push(currentPlayer);
      }
      touchSession(db, session.token);
      console.log(`[server] "${playerName}" rejoined room ${msg.joinCode} as ${isOwner ? 'host' : 'player'}`);

      send(ws, {
        type: 'room-joined',
        campaignId: campaign.id, joinCode: msg.joinCode, isOwner: currentPlayer.isOwner, tableRole: campaign.hostTableRole,
        sessionToken: currentPlayer.sessionToken,
        gameName: campaign.name,
        playerName,
        phase: campaign.phase,
      });

      if (currentPlayer.isOwner) {
        currentPlayer.setupChat = loadSetupChat(db, campaign.id);
        sendDmSettings(ws, campaign);
        sendLobbyState(ws, campaign, msg.joinCode);
        // Anything submitted while the DM was away is waiting here.
        for (const pending of listPendingCharacters(db, campaign.id)) {
          send(ws, pendingReviewMsg(pending));
          const neg = negotiations.get(pending.id);
          if (neg && !neg.isClosed()) neg.replayTo(ws);
          else openNegotiation(campaign, msg.joinCode, pending);
        }
      } else {
        sendLobbyState(ws, campaign, msg.joinCode);
        for (const pending of listPendingCharacters(db, campaign.id)) {
          if (pending.sessionToken !== currentPlayer.sessionToken) continue;
          const neg = negotiations.get(pending.id);
          if (neg && !neg.isClosed()) neg.replayTo(ws);
        }
        broadcast(msg.joinCode, { type: 'player-joined', playerName, characterId: currentPlayer.characterId });
      }

      send(ws, { type: 'phase-change', phase: campaign.phase });
    }

    if (msg.type === 'submit-character' && currentJoinCode) {
      const submitCampaign = joinRoom(db, currentJoinCode);
      if (!submitCampaign) return;
      if (submitCampaign.phase === 'lobby') {
        send(ws, { type: 'error', message: 'The DM is still building the world — character creation opens when it is ready.' });
        return;
      }
      const campaign = submitCampaign;
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

      if (!currentPlayer?.sessionToken) {
        send(ws, { type: 'error', message: 'Join the game before submitting a character.' });
        return;
      }
      const playerName = currentPlayer.playerName;
      const pending: PendingCharacterRow = {
        id: charId,
        campaignId: campaign.id,
        joinCode: currentJoinCode,
        sessionToken: currentPlayer.sessionToken,
        playerName,
        definition: finalDef,
        aiFeedback: feedbackText,
      };
      // Persist first: the submission must survive the DM being away, refreshing,
      // or the server restarting, otherwise it is silently lost.
      savePendingCharacter(db, pending);

      const host = hostSocket(currentJoinCode);
      send(ws, {
        type: 'character-validated',
        characterId: charId,
        approved: true,
        feedback: host
          ? `AI DM approved: ${feedbackText}. Opening negotiation...`
          : `AI DM approved: ${feedbackText}. The DM isn't at the table right now — your character is queued for their review.`,
      });

      if (host) {
        send(host, pendingReviewMsg(pending));
        openNegotiation(campaign, currentJoinCode, pending);
      }
    }

    if (msg.type === 'choose-table-role' && currentJoinCode && isWorldAuthor(currentPlayer)) {
      if (msg.role !== 'dm' && msg.role !== 'player') return;
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      if (campaign.phase === 'playing' || campaign.phase === 'ended') {
        send(ws, { type: 'error', message: 'The table role is fixed once the game opens.' });
        return;
      }
      setHostTableRole(db, campaign.id, msg.role);
      send(ws, {
        type: 'room-joined',
        campaignId: campaign.id, joinCode: currentJoinCode,
        isOwner: true, tableRole: msg.role,
        sessionToken: currentPlayer!.sessionToken,
        gameName: campaign.name, playerName: currentPlayer!.playerName,
        phase: campaign.phase,
      });
    }

    if (msg.type === 'host-approve-character' && currentJoinCode) {
      const hostCampaign = joinRoom(db, currentJoinCode);
      if (!hostCampaign || !hasDmAuthority(currentPlayer, hostCampaign.hostTableRole)) return;
      const pending = listPendingCharacters(db, hostCampaign.id).find(p => p.id === msg.characterId);
      if (!pending) return;
      const initialState = JSON.stringify({
        stress: 0, consequences: [], fatePoints: 3,
        inventory: [], xpMilestones: [], whisperTrust: 0.65,
      });
      db.prepare('INSERT OR REPLACE INTO characters (id, campaign_id, player_user_id, definition, state) VALUES (?, ?, ?, ?, ?)')
        .run(pending.id, pending.campaignId, null, JSON.stringify(pending.definition), initialState);

      const playerInRoom = rooms.get(currentJoinCode)?.find(p => p.sessionToken === pending.sessionToken);
      if (playerInRoom) playerInRoom.characterId = pending.id;
      if (pending.sessionToken) setSessionCharacter(db, pending.sessionToken, pending.id);

      const playerWs = socketFor(currentJoinCode, pending.sessionToken);
      if (playerWs) send(playerWs, { type: 'character-validated', characterId: pending.id, approved: true, feedback: 'Approved by both AI DM and host!' });
      broadcast(currentJoinCode, { type: 'character-submitted', characterId: pending.id, definition: pending.definition });
      const neg = negotiations.get(msg.characterId);
      if (neg) { neg.close(); negotiations.delete(msg.characterId); }
      deletePendingCharacter(db, msg.characterId);
    }

    if (msg.type === 'host-reject-character' && currentJoinCode) {
      const hostCampaign = joinRoom(db, currentJoinCode);
      if (!hostCampaign || !hasDmAuthority(currentPlayer, hostCampaign.hostTableRole)) return;
      const pending = listPendingCharacters(db, hostCampaign.id).find(p => p.id === msg.characterId);
      if (!pending) return;
      const playerWs = socketFor(currentJoinCode, pending.sessionToken);
      if (playerWs) send(playerWs, { type: 'character-validated', characterId: pending.id, approved: false, feedback: `Host feedback: ${msg.reason}` });
      const neg = negotiations.get(msg.characterId);
      if (neg) { neg.close(); negotiations.delete(msg.characterId); }
      deletePendingCharacter(db, msg.characterId);
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
      if (campaign.phase === 'lobby') {
        send(ws, { type: 'error', message: 'The DM is still building the world — character creation opens when it is ready.' });
        return;
      }
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

    if (msg.type === 'dm-chat' && currentJoinCode && currentPlayer && isWorldAuthor(currentPlayer)) {
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
          // World setup is what opens the table. Build step 2 replaces this
          // trigger with server-verified readiness plus seed acceptance.
          // The write is atomic and conditional on the DB row still being
          // 'lobby' (not the stale in-handler `campaign` snapshot) because
          // message handlers on a socket are not serialized — a second
          // dm-chat, or a start-game, can race this one to the write.
          if (advancePhaseIfLobby(db, campaign.id)) {
            broadcast(currentJoinCode, { type: 'phase-change', phase: 'character-creation' });
          }
        }
        saveSetupChat(db, campaign.id, currentPlayer.setupChat);
        send(ws, { type: 'dm-chat-reply', text: reply.reply, done: reply.done });
      } catch (e) {
        console.error('[dm-chat] error:', e);
        currentPlayer.setupChat.pop();
        send(ws, { type: 'dm-chat-reply', text: 'Sorry, I lost my train of thought. Could you repeat that?', done: false });
      }
    }

    if (msg.type === 'update-dm-settings' && currentJoinCode && isWorldAuthor(currentPlayer)) {
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      db.prepare("UPDATE campaigns SET dm_instructions = ?, dm_custom_prompt = ?, updated_at = datetime('now') WHERE id = ?")
        .run(msg.dmInstructions, msg.dmCustomPrompt, campaign.id);
    }

    if (msg.type === 'start-game' && currentJoinCode && isWorldAuthor(currentPlayer)) {
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      const players = rooms.get(currentJoinCode);
      if (!players) return;
      const jc = currentJoinCode;
      const gameLoop = new GameLoop(
        db, campaign.id,
        (m) => broadcast(jc, m),
        (m) => { const host = players.find(p => p.isOwner); if (host) send(host.ws, m); },
        { campaignId: campaign.id, joinCode: jc, phase: 'playing', currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null },
      );
      gameLoops.set(jc, gameLoop);
      setCampaignPhase(db, campaign.id, 'playing');
      gameLoop.start().catch(e => console.error('Game loop error:', e));
    }

    if (msg.type === 'whisper' && currentJoinCode) {
      const raw = msg.text;
      if (typeof raw !== 'string' || raw.trim().length === 0) return;
      const whisperText = raw.trim().slice(0, 200);
      const loop = gameLoops.get(currentJoinCode);
      loop?.handleWhisper(whisperText);
    }

    if (msg.type === 'end-game' && currentJoinCode && isWorldAuthor(currentPlayer)) {
      const jc = currentJoinCode;
      const endedCampaign = joinRoom(db, jc);
      if (endedCampaign) setCampaignPhase(db, endedCampaign.id, 'ended');
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
    // A rejoin reuses this seat object and repoints it at the new socket, so a
    // late close from the socket we replaced must not evict the live seat —
    // that would drop the reconnected DM out of the room (no host socket, no
    // broadcasts) and announce a departure that never happened.
    if (currentPlayer.ws !== ws) return;
    const players = rooms.get(currentJoinCode);
    if (players) {
      const idx = players.indexOf(currentPlayer);
      if (idx >= 0) players.splice(idx, 1);
      if (players.length === 0) {
        const jc = currentJoinCode;
        setTimeout(() => {
          const stillEmpty = rooms.get(jc);
          if (!stillEmpty || stillEmpty.length === 0) {
            rooms.delete(jc);
            const loop = gameLoops.get(jc);
            if (loop) { loop.stop(); gameLoops.delete(jc); }
            console.log(`[server] Room ${jc} cleaned up after reconnect grace period`);
          }
        }, 30_000);
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
