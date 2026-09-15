import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getDb, getDataDir } from './db.js';
import { safeDataFile, dataPath } from './data-paths.js';
import {
  createRoom, joinRoom, createSession, getSession, touchSession,
  savePendingCharacter, listPendingCharacters, deletePendingCharacter,
  saveSetupChat, loadSetupChat, setCampaignPhase, advancePhaseIfLobby, setHostTableRole,
  countLiveCharacters, beginPlayIfReady, getInfluences, setInfluences,
  revokeCharacter, clearSessionCharacter, getSessionTokenForCharacter,
  type PendingCharacterRow,
} from './room.js';
import { makeCharacterLive } from './character-live.js';
import {
  getWorldSeed, setWorldSeed, setWorldSeedIfNotAccepted, markSeedAccepted, isSeedAccepted, seedWorld, loadStockScenario,
} from './world-seed.js';
import { checkWorldReadiness, normalizeInfluences, MIN_INFLUENCES } from './world-readiness.js';
import { WorldSeedSchema } from './agents/schemas.js';
import { ingestText, ingestPdf } from './rag/ingest.js';
import { DmAgent } from './agents/dm.js';
import { GameLoop } from './game-loop.js';
import { NegotiationRoom } from './negotiation.js';
import { hasDmAuthority, isWorldAuthor, effectiveTableRole } from './seat.js';
import {
  getOrCreateInterview, appendInterviewTurn, setInterviewDefinition, setInterviewStatus, getInterviewBySession,
  type InterviewTurn,
} from './character-interview.js';
import { checkCharacterReadiness } from './character-readiness.js';
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
  const p = safeDataFile('dm-presets', presetName, '.txt');
  if (p) return readFileSync(p, 'utf-8').trim();
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

// Sane upper bounds on free-text fields the client controls. This is not the
// full CharacterDefinition schema (that's a later, planned task) — just a
// floor against pathological/abusive payloads reaching the DB, the LLM, or
// (post the innerHTML fixes in game-view.ts) every other client's DOM.
const MAX_SHORT_FIELD = 256;
const MAX_LONG_FIELD = 5000;
const MAX_LIST_ITEMS = 20;
// The FATE ladder this game actually implements (game-loop.ts's difficulty
// cap/floor) runs Mediocre(0) through Legendary(8) with no named rungs below
// 0 — so a skill rating outside that range cannot come from a legitimate
// build, only from a malformed or adversarial payload.
const MIN_SKILL_RATING = 0;
const MAX_SKILL_RATING = 8;

function isValidShortField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SHORT_FIELD;
}

function isValidLongField(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_LONG_FIELD;
}

/**
 * `skills` was the one field validateCharacterDefinitionShape never checked
 * — not type, not key length, not entry count, not value range — despite
 * being client-reachable, persisted, and injected into every DM prompt.
 * Bounded the same way aspects/stunts are: reject rather than coerce.
 */
function isValidSkillsRecord(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_LIST_ITEMS) return false;
  return entries.every(([name, rating]) =>
    isValidShortField(name) &&
    typeof rating === 'number' && Number.isFinite(rating) &&
    rating >= MIN_SKILL_RATING && rating <= MAX_SKILL_RATING
  );
}

/**
 * Rejects (never truncates) an over-long or malformed character definition.
 * Silent truncation would hand the player back a character that doesn't
 * match what they submitted; an explicit error lets them fix and resubmit.
 */
function validateCharacterDefinitionShape(def: unknown): string | null {
  if (!def || typeof def !== 'object') return 'Character definition is missing.';
  const d = def as Record<string, unknown>;
  if (!isValidShortField(d.name)) return `Character name must be 1-${MAX_SHORT_FIELD} characters.`;
  if (!isValidShortField(d.highConcept)) return `High concept must be 1-${MAX_SHORT_FIELD} characters.`;
  if (!isValidShortField(d.trouble)) return `Trouble must be 1-${MAX_SHORT_FIELD} characters.`;
  if (!isValidLongField(d.backstory)) return `Backstory must be at most ${MAX_LONG_FIELD} characters.`;
  if (!isValidLongField(d.personality)) return `Personality must be at most ${MAX_LONG_FIELD} characters.`;
  if (!Array.isArray(d.aspects) || d.aspects.length > MAX_LIST_ITEMS || !d.aspects.every(isValidShortField)) {
    return `Aspects must be at most ${MAX_LIST_ITEMS} entries of ${MAX_SHORT_FIELD} characters each.`;
  }
  if (!Array.isArray(d.stunts) || d.stunts.length > MAX_LIST_ITEMS || !d.stunts.every(isValidShortField)) {
    return `Stunts must be at most ${MAX_LIST_ITEMS} entries of ${MAX_SHORT_FIELD} characters each.`;
  }
  if (!isValidSkillsRecord(d.skills)) {
    return `Skills must be at most ${MAX_LIST_ITEMS} entries, each a name up to ${MAX_SHORT_FIELD} characters with a rating from ${MIN_SKILL_RATING} to ${MAX_SKILL_RATING}.`;
  }
  return null;
}

// Every interview message is capped at MAX_LONG_FIELD chars, but the
// TRANSCRIPT LENGTH is not — it is durable now, unlike the old in-memory
// chat that self-limited by being wiped on rejoin. Left uncapped, a
// long-running interview eventually exceeds the model's context window, and
// every retry re-sends the same oversized history: that session can never
// interview again. Window it before it reaches the model while still
// persisting everything (appendInterviewTurn is unaffected by this).
//
// N=40: the same order of magnitude as the scene transcript's own
// compaction threshold (35 messages — see CLAUDE.md), so the two
// subsystems share a design language for "how much raw conversation is too
// much to keep replaying." At the per-message cap, 40 turns is at most
// ~200,000 characters (~50k tokens) of transcript, which leaves headroom
// under any model this proxy fronts even with the system prompt, rules
// excerpt and world block layered on top.
const INTERVIEW_HISTORY_WINDOW = 40;

/**
 * Keeps the world introduction (turn 0) in the window regardless of where it
 * falls — it is the world context every later question is grounded in, not
 * just another chat message, and it is the one turn sendWorldIntroduction
 * guarantees is never regenerated differently.
 */
function windowInterviewHistory(transcript: InterviewTurn[]): InterviewTurn[] {
  if (transcript.length <= INTERVIEW_HISTORY_WINDOW) return transcript;
  const intro = transcript[0]!;
  const recent = transcript.slice(-(INTERVIEW_HISTORY_WINDOW - 1));
  return recent[0] === intro ? recent : [intro, ...recent];
}

function isValidBoundedString(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length <= max;
}

function isValidNullableBoundedString(value: unknown, max: number): boolean {
  return value === null || isValidBoundedString(value, max);
}

/**
 * WorldSeedSchema validates shape but not size — a host-supplied seed is
 * persisted verbatim, expanded into unbounded locations/entities/items/events
 * rows, and then injected into every DM prompt for the rest of the campaign.
 * Bound it the same way submit-character bounds a character definition:
 * reject rather than truncate, so the host gets an explicit reason instead of
 * a silently thinned-out world.
 */
function validateWorldSeedShape(seed: import('../shared/types.js').WorldSeed): string | null {
  if (!isValidLongField(seed.premise)) return `Premise must be at most ${MAX_LONG_FIELD} characters.`;
  if (seed.locations.length > MAX_LIST_ITEMS) return `At most ${MAX_LIST_ITEMS} locations are allowed.`;
  for (const loc of seed.locations) {
    if (!isValidShortField(loc.name)) return `Location names must be 1-${MAX_SHORT_FIELD} characters.`;
    if (!isValidLongField(loc.description)) return `Location descriptions must be at most ${MAX_LONG_FIELD} characters.`;
    if (!isValidNullableBoundedString(loc.terrain, MAX_SHORT_FIELD)) return `Location terrain must be at most ${MAX_SHORT_FIELD} characters.`;
  }
  if (seed.npcs.length > MAX_LIST_ITEMS) return `At most ${MAX_LIST_ITEMS} NPCs are allowed.`;
  for (const npc of seed.npcs) {
    if (!isValidShortField(npc.name)) return `NPC names must be 1-${MAX_SHORT_FIELD} characters.`;
    if (!isValidLongField(npc.description)) return `NPC descriptions must be at most ${MAX_LONG_FIELD} characters.`;
    if (!isValidNullableBoundedString(npc.disposition, MAX_SHORT_FIELD)) return `NPC disposition must be at most ${MAX_SHORT_FIELD} characters.`;
    if (!isValidNullableBoundedString(npc.motivation, MAX_LONG_FIELD)) return `NPC motivation must be at most ${MAX_LONG_FIELD} characters.`;
  }
  if (seed.plotHooks.length > MAX_LIST_ITEMS) return `At most ${MAX_LIST_ITEMS} plot hooks are allowed.`;
  if (!seed.plotHooks.every(h => isValidLongField(h))) return `Plot hooks must be at most ${MAX_LONG_FIELD} characters each.`;
  if (seed.items.length > MAX_LIST_ITEMS) return `At most ${MAX_LIST_ITEMS} items are allowed.`;
  for (const item of seed.items) {
    if (!isValidShortField(item.name)) return `Item names must be 1-${MAX_SHORT_FIELD} characters.`;
    if (!isValidLongField(item.description)) return `Item descriptions must be at most ${MAX_LONG_FIELD} characters.`;
  }
  return null;
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
 * The single definition of "is this world ready to open the table", read off
 * the database rather than trusted from any in-handler snapshot. Everything
 * that decides whether to draft a seed, accept one, or advance the phase goes
 * through this.
 */
function currentReadiness(campaign: import('../shared/types.js').Campaign) {
  const db = getDb();
  return checkWorldReadiness({
    influences: getInfluences(db, campaign.id),
    seed: getWorldSeed(db, campaign.id),
    dmInstructions: campaign.dmInstructions,
    hostTableRole: campaign.hostTableRole,
    seedAccepted: isSeedAccepted(db, campaign.id),
  });
}

function sendReadiness(ws: WebSocket, campaign: import('../shared/types.js').Campaign): void {
  send(ws, { type: 'world-readiness', readiness: currentReadiness(campaign), influences: getInfluences(getDb(), campaign.id) });
}

/**
 * Rebuild a reconnecting participant's screen from durable state. Without this
 * a refresh leaves the DM staring at an empty lobby even once their host role
 * is restored.
 */
/**
 * A non-owner is a player rejoining a lobby, not the host — the host's setup
 * chat with the DM is where a TTRPG's twists get decided, and hostTableRole/
 * readiness/influences are host-only bookkeeping the player views never
 * render. Only players/phase/approvedCount are shared, since those are what
 * the waiting-room view actually uses.
 */
function sendLobbyState(ws: WebSocket, campaign: import('../shared/types.js').Campaign, joinCode: string, isOwner: boolean): void {
  const db = getDb();
  const players = (rooms.get(joinCode) ?? []).filter(p => !p.isOwner).map(p => p.playerName);
  const approvedCount = countLiveCharacters(db, campaign.id);
  send(ws, {
    type: 'lobby-state',
    players: [...new Set(players)],
    setupChat: isOwner ? loadSetupChat(db, campaign.id) : [],
    dmReady: Boolean(campaign.dmInstructions),
    approvedCount,
    phase: campaign.phase,
    influences: isOwner ? getInfluences(db, campaign.id) : [],
    hostTableRole: isOwner ? campaign.hostTableRole : null,
    readiness: isOwner ? currentReadiness(campaign) : { ready: false, unmet: [], detail: [] },
  });
}

/**
 * The player's first sight of the world, sent once character creation opens.
 * Written in the fiction, not as a briefing (see DmAgent.introduceWorld) — it
 * must exist before a player is asked who they are, but it must never BLOCK
 * that: introduceWorld calls the LLM with no schema, so any failure here
 * (timeout, outage, malformed proxy response) is caught, logged, and sends
 * nothing rather than stall or corrupt character creation.
 */
async function sendWorldIntroduction(ws: WebSocket, campaign: import('../shared/types.js').Campaign, sessionToken: string): Promise<void> {
  try {
    const db = getDb();
    // The interview record is the natural home for this text, and once
    // generated it must never be regenerated: the client auto-rejoins on
    // any socket blip, and a reconnect before the player's first message
    // would otherwise hand back a fresh temperature-0.9 generation — a
    // different first sight of the same world every time. It was also the
    // one part of this conversation that was not otherwise persisted.
    const interview = getOrCreateInterview(db, campaign.id, sessionToken);
    const stored = interview.transcript[0];
    if (stored) {
      send(ws, { type: 'world-introduction', text: stored.content });
      return;
    }
    const seed = getWorldSeed(db, campaign.id);
    if (!seed) {
      console.warn(`[world-introduction] no world seed yet for campaign ${campaign.id}`);
      return;
    }
    const dm = new DmAgent(db);
    const text = await dm.introduceWorld({
      preset: campaign.dmPreset,
      influences: getInfluences(db, campaign.id),
      seed,
    });
    // introduceWorld calls callLlm with no schema, so a proxy hiccup (outage,
    // an all-whitespace body, a response that was nothing but thinking tags)
    // comes back as '' rather than throwing. Appending that would store an
    // empty turn PERMANENTLY — unlike the "no introduction yet" state this
    // function already tolerates, an empty stored one is never regenerated
    // (see the `stored` check above) and rides into every later
    // interviewForCharacter call, where some providers reject an
    // empty-content message outright. Do neither: log and leave the
    // interview exactly as it was, so the next join/rejoin gets a real
    // attempt instead of a blank "The World" panel forever.
    if (!text.trim()) {
      console.warn(`[world-introduction] empty introduction from LLM for campaign ${campaign.id} — not persisting, will retry on next join`);
      return;
    }
    appendInterviewTurn(db, interview.id, { role: 'assistant', content: text });
    send(ws, { type: 'world-introduction', text });
  } catch (e) {
    console.error('[world-introduction] failed:', e);
  }
}

wss.on('connection', (ws) => {
  const db = getDb();
  let currentJoinCode: string | null = null;
  let currentPlayer: ConnectedPlayer | null = null;

  ws.on('message', async (raw) => {
    let msg: ClientMessage;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'create') {
      if (!isValidShortField(msg.name)) {
        send(ws, { type: 'error', message: `Game name must be 1-${MAX_SHORT_FIELD} characters.` });
        return;
      }
      const { campaignId, joinCode } = createRoom(db, {
        name: msg.name,
        dmPreset: msg.dmPreset,
        systemId: msg.systemId,
        scenarioId: msg.scenarioId ?? undefined,
        houseRules: msg.houseRules ?? undefined,
      });
      const session = createSession(db, { campaignId, joinCode, playerName: 'Host', isHost: true });
      currentJoinCode = joinCode;
      currentPlayer = { ws, sessionToken: session.token, playerName: 'Host', characterId: null, isOwner: true, setupChat: [] };
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
      dm.setupChat({ preset: msg.dmPreset, systemId: msg.systemId, history: [], unmet: [] }).then(reply => {
        if (currentPlayer) {
          currentPlayer.setupChat.push({ role: 'assistant', content: reply.reply });
          saveSetupChat(db, campaignId, currentPlayer.setupChat);
        }
        send(ws, { type: 'dm-chat-reply', text: reply.reply, done: false });
      }).catch(e => console.error('[dm-setup] greeting failed:', e));
    }

    if (msg.type === 'join') {
      if (!isValidShortField(msg.playerName)) {
        send(ws, { type: 'error', message: `Player name must be 1-${MAX_SHORT_FIELD} characters.` });
        return;
      }
      const campaign = joinRoom(db, msg.joinCode);
      if (!campaign) { send(ws, { type: 'error', message: 'Invalid join code' }); return; }
      const session = createSession(db, { campaignId: campaign.id, joinCode: msg.joinCode, playerName: msg.playerName, isHost: false });
      currentJoinCode = msg.joinCode;
      currentPlayer = { ws, sessionToken: session.token, playerName: msg.playerName, characterId: null, isOwner: false, setupChat: [] };
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
      if (campaign.phase === 'character-creation') {
        await sendWorldIntroduction(ws, campaign, session.token);
      }
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
          isOwner, setupChat: [],
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
        const seed = getWorldSeed(db, campaign.id);
        if (seed) send(ws, { type: 'world-seed-draft', seed, accepted: isSeedAccepted(db, campaign.id) });
        sendReadiness(ws, campaign);
        sendLobbyState(ws, campaign, msg.joinCode, true);
        // Anything submitted while the DM was away is waiting here.
        for (const pending of listPendingCharacters(db, campaign.id)) {
          send(ws, pendingReviewMsg(pending));
          const neg = negotiations.get(pending.id);
          if (neg && !neg.isClosed()) neg.replayTo(ws);
          else openNegotiation(campaign, msg.joinCode, pending);
        }
      } else {
        sendLobbyState(ws, campaign, msg.joinCode, false);
        for (const pending of listPendingCharacters(db, campaign.id)) {
          if (pending.sessionToken !== currentPlayer.sessionToken) continue;
          const neg = negotiations.get(pending.id);
          if (neg && !neg.isClosed()) neg.replayTo(ws);
        }
        broadcast(msg.joinCode, { type: 'player-joined', playerName, characterId: currentPlayer.characterId });

        if (campaign.phase === 'character-creation') {
          // The introduction now lives as the interview's own first turn, so
          // "has this player actually done anything beyond meet the world"
          // is "is there a user turn in the transcript" — not merely "does a
          // transcript exist". A transcript containing only the stored
          // introduction is handled below (replayed, not regenerated), not
          // here.
          const interview = getInterviewBySession(db, campaign.id, currentPlayer.sessionToken);
          const hasChatted = interview?.transcript.some(t => t.role === 'user') ?? false;
          if (hasChatted && interview) {
            send(ws, { type: 'interview-replay', transcript: interview.transcript, definition: interview.definition });
          }
        }
      }

      send(ws, { type: 'phase-change', phase: campaign.phase });

      // Sent last and deliberately not awaited: sendWorldIntroduction makes an
      // LLM call with its own multi-second/retry timeout, and a slow or
      // failing proxy must not withhold room-joined/lobby-state/phase-change
      // — already sent above — from a reconnecting player. The helper owns
      // its own try/catch, so a failure here just logs, and it replays a
      // stored introduction rather than regenerating one.
      if (!currentPlayer.isOwner && campaign.phase === 'character-creation') {
        const interview = getInterviewBySession(db, campaign.id, currentPlayer.sessionToken);
        const hasChatted = interview?.transcript.some(t => t.role === 'user') ?? false;
        if (!hasChatted) {
          void sendWorldIntroduction(ws, campaign, currentPlayer.sessionToken);
        }
      }
    }

    if (msg.type === 'submit-character' && currentJoinCode) {
      const submitCampaign = joinRoom(db, currentJoinCode);
      if (!submitCampaign) return;
      // Widened from "refuse only in lobby" to match char-chat below: a
      // character interview is refused outside character-creation, but a
      // pasted or form-built character could still be submitted mid-game
      // (playing/ended) and flow straight to host approval. That asymmetry
      // was never intended — the checklist this whole step exists for must
      // hold on every path into `characters`, not just the interview one.
      if (submitCampaign.phase !== 'character-creation') {
        const message = submitCampaign.phase === 'lobby'
          ? 'The DM is still building the world — character creation opens when it is ready.'
          : 'Character creation is not open right now.';
        send(ws, { type: 'error', message });
        return;
      }
      // The submit gate is keyed on the INTERVIEW, not on whether the
      // submitted content happens to match it — content matching is
      // trivially defeated by editing the previewed sheet at all (even a
      // single-character edit), and once confirmed once it must not stay
      // permanently open for every later definition. So: if this session has
      // an interview-derived definition, it must be confirmed before ANY
      // submission proceeds, and once confirmed the client does not get to
      // supply its own copy of an interview character — the server submits
      // the interview's own stored definition, ignoring whatever arrived on
      // the socket. The "Build here" and "Paste markdown" tabs have no
      // interview record for this session and are completely unaffected.
      if (currentPlayer?.sessionToken) {
        const interview = getInterviewBySession(db, submitCampaign.id, currentPlayer.sessionToken);
        if (interview?.definition) {
          if (interview.status !== 'confirmed') {
            send(ws, { type: 'error', message: 'Confirm the character you were shown before submitting it.' });
            return;
          }
          msg.definition = interview.definition;
        }
      }
      // No schema validates msg.definition before this point — it is
      // whatever JSON arrived on the socket (or, for a confirmed interview
      // character, the interview's own stored definition, substituted
      // above). Reject (don't silently truncate) anything outside sane
      // bounds before it reaches the LLM, the DB, or any other client's
      // screen.
      const shapeError = validateCharacterDefinitionShape(msg.definition);
      if (shapeError) {
        send(ws, { type: 'error', message: shapeError });
        return;
      }
      // Shape only bounds sizes/types — it has no notion of "finished".
      // A confirmed interview definition has already cleared this same
      // readiness bar (that is what "confirmed" means), so this is a
      // no-op for that path. The "Build here" and "Paste markdown" tabs
      // have no readiness gate of their own, so without this a sheet with
      // a name, high concept and trouble but zero skills/aspects/stunts
      // would sail through — a character that cannot roll anything.
      // Named per-character (not just "unmet: skills") because the paste
      // tab can submit several characters from one click, and the 'error'
      // message is a plain string with no submission-correlation id to
      // otherwise tell the player which sheet the refusal is about.
      const readiness = checkCharacterReadiness(msg.definition);
      if (!readiness.ready) {
        send(ws, { type: 'error', message: `${msg.definition.name} is not ready: ${readiness.detail.join(' ')}` });
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

      // validation.modifications is CharacterValidationSchema's
      // z.record(z.unknown()).nullable() — entirely unvalidated model
      // output — and msg.definition has already cleared both shape and
      // readiness at this point. Spreading modifications over it without
      // re-checking would let a bad model edit (an over-long name, an
      // emptied-out skills object) punch straight through the one gate this
      // whole step exists to guarantee. Re-run both checks on the merged
      // result; if either fails, drop the modifications and keep the
      // player's own already-valid definition rather than failing their
      // submission over the model's mistake.
      let finalDef = msg.definition;
      let modifications = validation.modifications;
      if (modifications) {
        const merged = { ...msg.definition, ...modifications } as typeof msg.definition;
        const mergedShapeError = validateCharacterDefinitionShape(merged);
        const mergedReadiness = mergedShapeError ? null : checkCharacterReadiness(merged);
        if (mergedShapeError || !mergedReadiness!.ready) {
          console.warn(
            `[submit-character] discarding DM modifications for ${charId} (${JSON.stringify(modifications)}) — merged definition failed ${
              mergedShapeError ? `shape validation: ${mergedShapeError}` : `readiness: ${mergedReadiness!.detail.join(' ')}`
            }`
          );
          modifications = null;
        } else {
          finalDef = merged;
        }
      }

      const feedbackText = modifications
        ? `${validation.feedback} (DM adjusted: ${Object.keys(modifications).join(', ')})`
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
      // or the server restarting, otherwise it is silently lost. It is also
      // written before the table-role branch below, so the AI-approval path
      // and the host-review path share one shape, and a crash between the
      // write and the branch leaves a reviewable row rather than nothing.
      savePendingCharacter(db, pending);

      const approver = effectiveTableRole(campaign.hostTableRole);
      if (approver === 'player') {
        // The host is at the table as a player, so there is no human to
        // approve. The AI DM's validation is the decision — the character
        // goes live immediately and the host keeps a veto they can use later.
        makeCharacterLive(db, pending);

        // Everything below only fires after the transaction above has
        // committed — announcing a character before the write lands is how a
        // client ends up showing something the database does not have.
        const playerInRoom = rooms.get(currentJoinCode)?.find(p => p.sessionToken === pending.sessionToken);
        if (playerInRoom) playerInRoom.characterId = pending.id;

        send(ws, { type: 'character-validated', characterId: pending.id, approved: true, feedback: `${feedbackText} Your character is in the game.` });
        broadcast(currentJoinCode, { type: 'character-submitted', characterId: pending.id, definition: pending.definition });
        return;
      }

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

      makeCharacterLive(db, pending);

      // Everything below only fires after the transaction above has
      // committed — announcing a character before the write lands is how a
      // client ends up showing something the database does not have.
      const playerInRoom = rooms.get(currentJoinCode)?.find(p => p.sessionToken === pending.sessionToken);
      if (playerInRoom) playerInRoom.characterId = pending.id;

      const playerWs = socketFor(currentJoinCode, pending.sessionToken);
      if (playerWs) send(playerWs, { type: 'character-validated', characterId: pending.id, approved: true, feedback: 'Approved by both AI DM and host!' });
      broadcast(currentJoinCode, { type: 'character-submitted', characterId: pending.id, definition: pending.definition });
      const neg = negotiations.get(msg.characterId);
      if (neg) { neg.close(); negotiations.delete(msg.characterId); }
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

    // The host keeps a silent, non-blocking veto over a character even after
    // it went live — owner-only via isWorldAuthor (not hasDmAuthority),
    // because a host who is playing must still be able to remove a character
    // the AI DM already approved. That is the whole point of this handler.
    if (msg.type === 'revoke-character' && currentJoinCode) {
      if (!isWorldAuthor(currentPlayer)) {
        send(ws, { type: 'error', message: 'Only the host can revoke a character.' });
        return;
      }
      const revokeCampaign = joinRoom(db, currentJoinCode);
      if (!revokeCampaign) return;
      if (msg.reason !== undefined && !isValidLongField(msg.reason)) {
        send(ws, { type: 'error', message: `Revoke reason must be at most ${MAX_LONG_FIELD} characters.` });
        return;
      }
      const reason = msg.reason ?? '';

      // revokeCharacter's UPDATE carries `AND revoked_at IS NULL`, so it
      // returns false for both an unknown id and one already revoked — that
      // boolean is the whole refusal signal, no separate existence check.
      if (!revokeCharacter(db, msg.characterId)) {
        send(ws, { type: 'error', message: 'That character cannot be revoked — it may already be gone.' });
        return;
      }

      // The durable campaign_sessions row is what resolves this character
      // back to its owning session, not the in-memory rooms list: rejoin
      // trusts session.characterId with no revoked check and nothing else
      // reconciles it, so a player who is offline right now must still get
      // their session claim cleared and interview reopened here, or they
      // reconnect still holding the revoked character. The in-memory seat
      // (if one is even connected) is also not reliable for this lookup —
      // a seat that rejoined before its character was approved can carry a
      // stale characterId. DB writes first, then refresh whichever
      // in-memory seat happens to be live, then tell the room.
      const ownerToken = getSessionTokenForCharacter(db, revokeCampaign.id, msg.characterId);
      if (ownerToken) {
        clearSessionCharacter(db, ownerToken);
        const interview = getInterviewBySession(db, revokeCampaign.id, ownerToken);
        if (interview) setInterviewStatus(db, interview.id, 'open');
      }

      const playerInRoom = rooms.get(currentJoinCode)?.find(p => p.sessionToken === ownerToken);
      if (playerInRoom) playerInRoom.characterId = null;

      broadcast(currentJoinCode, { type: 'character-revoked', characterId: msg.characterId, reason });
    }

    if (msg.type === 'negotiation-message' && currentJoinCode && currentPlayer) {
      const negotiation = negotiations.get(msg.characterId);
      if (!negotiation || negotiation.isClosed()) return;
      const sender = negotiation.isParticipant(ws);
      if (!sender) return;
      negotiation.handleMessage(sender, currentPlayer.playerName, msg.text)
        .catch(e => console.error('[negotiation] message handling failed:', e));
    }

    if (msg.type === 'char-chat' && currentJoinCode && currentPlayer?.sessionToken) {
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      // Widened from "refuse only in lobby" — an interview left reachable
      // during playing/ended was never intended; character creation is only
      // open during the character-creation phase.
      if (campaign.phase !== 'character-creation') {
        send(ws, { type: 'error', message: 'Character creation is not open right now.' });
        return;
      }
      if (!isValidLongField(msg.text) || !msg.text.trim()) {
        send(ws, { type: 'error', message: 'That message was too long to send.' });
        return;
      }

      const interview = getOrCreateInterview(db, campaign.id, currentPlayer.sessionToken);
      appendInterviewTurn(db, interview.id, { role: 'user', content: msg.text });

      const dm = new DmAgent(db);
      try {
        const before = checkCharacterReadiness(interview.definition);
        const fullHistory = getInterviewBySession(db, campaign.id, currentPlayer.sessionToken)?.transcript ?? [];
        const history = windowInterviewHistory(fullHistory);
        const reply = await dm.interviewForCharacter({
          systemId: campaign.systemId,
          preset: campaign.dmPreset,
          playerName: currentPlayer.playerName,
          influences: getInfluences(db, campaign.id),
          seed: getWorldSeed(db, campaign.id),
          history,
          unmet: before.detail,
        });
        appendInterviewTurn(db, interview.id, { role: 'assistant', content: reply.reply });

        // A clarifying question ("can she be called Ash?") gets `definition:
        // null` back from the model — it isn't re-proposing a sheet, just
        // answering. Falling back to the interview's own stored definition
        // means readiness reflects what the player's character actually IS,
        // not "nothing was proposed this turn". Without this, a confirmed,
        // complete character gets told it is missing all six fields on its
        // very next follow-up message.
        const readiness = checkCharacterReadiness(reply.definition ?? interview.definition);
        if (reply.definition && readiness.ready) {
          setInterviewDefinition(db, interview.id, reply.definition);
          send(ws, { type: 'char-chat-reply', text: reply.reply, definition: reply.definition });
          send(ws, { type: 'character-preview', definition: reply.definition, readiness });
        } else if (!reply.definition && interview.definition && readiness.ready) {
          // Nothing new was proposed, but the stored sheet is still ready —
          // re-send it as a preview instead of a false "still shaping this
          // character" checklist. Does NOT touch interview status: if it was
          // already confirmed, the confirm button reappearing and requiring
          // one more click is a minor inconvenience, not a lie about the
          // character's state.
          send(ws, { type: 'char-chat-reply', text: reply.reply, definition: null });
          send(ws, { type: 'character-preview', definition: interview.definition, readiness });
        } else {
          // A proposed-but-incomplete sheet is NOT shown as a definition — the
          // model does not get to decide the interview is finished.
          send(ws, { type: 'char-chat-reply', text: reply.reply, definition: null });
          send(ws, { type: 'character-readiness', readiness });
        }
      } catch (e) {
        console.error('[char-chat] error:', e);
        send(ws, { type: 'char-chat-reply', text: 'I had trouble following that — could you say it another way?', definition: null });
      }
    }

    if (msg.type === 'confirm-character' && currentJoinCode && currentPlayer?.sessionToken) {
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      const interview = getInterviewBySession(db, campaign.id, currentPlayer.sessionToken);
      if (!interview?.definition) {
        send(ws, { type: 'error', message: 'There is no character to confirm yet.' });
        return;
      }
      const readiness = checkCharacterReadiness(interview.definition);
      if (!readiness.ready) {
        send(ws, { type: 'error', message: 'That character is not finished yet.' });
        return;
      }
      setInterviewStatus(db, interview.id, 'confirmed');
      send(ws, { type: 'character-preview', definition: interview.definition, readiness });
    }

    if (msg.type === 'dm-chat' && currentJoinCode && currentPlayer && isWorldAuthor(currentPlayer)) {
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      // Once the world is accepted it is no longer up for renegotiation by
      // chat — otherwise a stray message rewrites a world players are already
      // building characters against.
      if (campaign.phase !== 'lobby') {
        send(ws, { type: 'error', message: 'The world is set. Start the game when your players are ready.' });
        return;
      }
      currentPlayer.setupChat.push({ role: 'user', content: msg.text });
      const dm = new DmAgent(db);
      let after: import('../shared/types.js').Campaign | null = null;
      // This try/catch exists for "the setupChat call failed" — it pops the
      // user message pushed above and apologizes. draftWorldSeed must not sit
      // inside it: by the time a draft can be attempted, the assistant reply
      // has already been pushed to history, persisted by saveSetupChat, and
      // sent to the host. If this catch fired for a draft failure it would
      // pop the ASSISTANT message instead, desync in-memory history from the
      // database, and the next saveSetupChat would permanently delete a
      // message the host already watched arrive.
      try {
        const before = currentReadiness(campaign);
        const reply = await dm.setupChat({
          preset: campaign.dmPreset,
          systemId: campaign.systemId,
          history: currentPlayer.setupChat,
          unmet: before.detail,
        });
        currentPlayer.setupChat.push({ role: 'assistant', content: reply.reply });

        const influences = normalizeInfluences(reply.influences);
        if (influences.length > 0) setInfluences(db, campaign.id, influences);

        if (reply.done && reply.dmInstructions) {
          db.prepare("UPDATE campaigns SET dm_instructions = ?, dm_custom_prompt = ?, updated_at = datetime('now') WHERE id = ?")
            .run(reply.dmInstructions, reply.dmCustomPrompt, campaign.id);
        }
        saveSetupChat(db, campaign.id, currentPlayer.setupChat);

        after = joinRoom(db, currentJoinCode);
        if (!after) return;

        send(ws, { type: 'dm-chat-reply', text: reply.reply, done: reply.done });
        sendReadiness(ws, after);
      } catch (e) {
        console.error('[dm-chat] error:', e);
        currentPlayer.setupChat.pop();
        send(ws, { type: 'dm-chat-reply', text: 'Sorry, I lost my train of thought. Could you repeat that?', done: false });
        return;
      }

      // Draft a world as soon as there is enough to build one. The phase does
      // NOT advance here any more — only accepting the seed opens the table.
      const readiness = currentReadiness(after);
      const needsSeed = readiness.unmet.includes('seed');
      const canDraft = getInfluences(db, after.id).length >= MIN_INFLUENCES && Boolean(after.dmInstructions);

      if (needsSeed && canDraft) {
        // Its own try/catch: an LLM outage or a Zod rejection here is routine
        // and must not touch chat history, which is already saved and shown.
        try {
          const stock = after.scenarioId ? loadStockScenario(after.scenarioId) : null;
          const seed = await dm.draftWorldSeed({
            preset: after.dmPreset,
            systemId: after.systemId,
            influences: getInfluences(db, after.id),
            dmInstructions: after.dmInstructions ?? '',
            history: currentPlayer.setupChat,
            existing: getWorldSeed(db, after.id) ?? stock?.seed ?? null,
          });

          // accept-world-seed is fully synchronous and can complete — mark
          // accepted, seed the world bible, advance the phase — during this
          // await. An unconditional write here would clobber the accepted
          // seed with a draft nobody accepted, the same failure mode
          // setWorldSeedIfNotAccepted was introduced to close off for
          // regenerate-world-seed. The phase re-check catches the case where
          // the campaign moved on while this was in flight even when the
          // WHERE clause alone would not (e.g. accepted then somehow cleared).
          const latest = joinRoom(db, currentJoinCode);
          if (!latest || latest.phase !== 'lobby') return;
          if (!setWorldSeedIfNotAccepted(db, after.id, seed)) return;

          send(ws, { type: 'world-seed-draft', seed, accepted: false });
          sendReadiness(ws, joinRoom(db, currentJoinCode)!);
        } catch (e) {
          console.error('[dm-chat] draft failed:', e);
          send(ws, { type: 'error', message: 'The DM replied, but could not draft a world yet. Try again.' });
        }
      }
    }

    if (msg.type === 'accept-world-seed' && currentJoinCode && isWorldAuthor(currentPlayer)) {
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      if (campaign.phase !== 'lobby') { send(ws, { type: 'error', message: 'The table is already open.' }); return; }

      const parsed = WorldSeedSchema.safeParse(msg.seed);
      if (!parsed.success) { send(ws, { type: 'error', message: 'That world could not be read. Ask the DM to redraft it.' }); return; }

      const sizeError = validateWorldSeedShape(parsed.data);
      if (sizeError) { send(ws, { type: 'error', message: sizeError }); return; }

      // Check readiness with the seed the host is actually accepting, and with
      // acceptance assumed — so the only thing left to decide is whether the
      // rest of the checklist passes. Checked BEFORE anything is written: the
      // incoming seed must not overwrite the last good stored draft unless it
      // actually clears the checklist — otherwise a rejected accept (e.g. a
      // thinned-out edit) would clobber a perfectly acceptable draft with the
      // one that just failed.
      const readiness = checkWorldReadiness({
        influences: getInfluences(db, campaign.id),
        seed: parsed.data,
        dmInstructions: campaign.dmInstructions,
        hostTableRole: campaign.hostTableRole,
        seedAccepted: true,
      });
      if (!readiness.ready) {
        send(ws, { type: 'world-readiness', readiness, influences: getInfluences(db, campaign.id) });
        return;
      }

      // Persisting the accepted seed, marking it accepted, seeding the world
      // bible, and advancing the phase must land together or not at all — a
      // throw partway through (e.g. inside seedWorld) must not leave the
      // campaign accepted-but-unseeded, or seeded-but-still-in-lobby, the way
      // it would if these were four unwrapped writes.
      try {
        const advanced = db.transaction(() => {
          setWorldSeed(db, campaign.id, parsed.data);
          markSeedAccepted(db, campaign.id);
          seedWorld(db, campaign.id, parsed.data);
          return advancePhaseIfLobby(db, campaign.id);
        })();
        send(ws, { type: 'world-seed-draft', seed: parsed.data, accepted: true });
        if (advanced) {
          broadcast(currentJoinCode, { type: 'phase-change', phase: 'character-creation' });
        }
        // Sent before the introductions below so the host's own UI is never
        // waiting on N player LLM calls it has nothing to do with.
        sendReadiness(ws, joinRoom(db, currentJoinCode)!);
        if (advanced) {
          // Every player already at the table meets the world the moment it
          // opens, rather than waiting for their first char-chat message.
          // Fired concurrently and not awaited: one slow or hung generation
          // must not delay the others', or the host, by piling up N serial
          // LLM latencies. sendWorldIntroduction owns its own try/catch.
          const others = (rooms.get(currentJoinCode) ?? []).filter(p => !p.isOwner);
          for (const p of others) {
            void sendWorldIntroduction(p.ws, campaign, p.sessionToken);
          }
        }
      } catch (e) {
        console.error('[accept-world-seed] failed:', e);
        send(ws, { type: 'error', message: 'Could not open the table with that world. Try again.' });
      }
    }

    if (msg.type === 'regenerate-world-seed' && currentJoinCode && isWorldAuthor(currentPlayer)) {
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      if (campaign.phase !== 'lobby') { send(ws, { type: 'error', message: 'The table is already open.' }); return; }
      const dm = new DmAgent(db);
      try {
        const history = [...currentPlayer!.setupChat];
        // A bad note (too long, wrong type) should not fail the redraft — it
        // just doesn't get folded into the prompt, the same as no note at all.
        if (isValidLongField(msg.note) && msg.note.trim()) {
          history.push({ role: 'user', content: `Redraft the world: ${msg.note}` });
        }
        const seed = await dm.draftWorldSeed({
          preset: campaign.dmPreset,
          systemId: campaign.systemId,
          influences: getInfluences(db, campaign.id),
          dmInstructions: campaign.dmInstructions ?? '',
          history,
          existing: getWorldSeed(db, campaign.id),
        });
        // The draft above sat behind a real LLM call, which the host's own
        // accept-world-seed (fully synchronous, no await of its own) can
        // complete during and after. If that happened, the seed actually in
        // the world bible is the one that got accepted — this write must not
        // clobber campaigns.world_seed with a redraft nobody accepted, or a
        // rejoining host would see this seed labelled accepted: true even
        // though it was never seeded. The WHERE clause makes that check and
        // the write atomic; a stale in-handler `campaign` snapshot is not
        // safe to gate it on for the same reason advancePhaseIfLobby doesn't
        // trust one either.
        if (!setWorldSeedIfNotAccepted(db, campaign.id, seed)) {
          send(ws, { type: 'error', message: 'The world was already accepted while redrafting.' });
          return;
        }
        send(ws, { type: 'world-seed-draft', seed, accepted: false });
        sendReadiness(ws, joinRoom(db, currentJoinCode)!);
      } catch (e) {
        console.error('[regenerate-world-seed] failed:', e);
        send(ws, { type: 'error', message: 'The DM could not redraft the world. Try again.' });
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
      // An empty party makes runScene recurse forever: every safety valve is
      // keyed off counters that only advance inside the per-character loop.
      if (countLiveCharacters(db, campaign.id) === 0) {
        send(ws, { type: 'error', message: 'You need at least one approved character before the game can start.' });
        return;
      }
      const players = rooms.get(currentJoinCode);
      if (!players) return;
      const jc = currentJoinCode;
      // Atomic and conditional on the DB row still being 'character-creation'
      // (not the stale in-handler `campaign` snapshot) for the same reason as
      // advancePhaseIfLobby: message handlers on a socket are not serialized,
      // and two DM tabs on the same seat — a workflow the sidebar explicitly
      // invites via "Bookmark this chair" — can both fire 'start-game'. Only
      // the call that wins the write may construct a GameLoop; a second one
      // would orphan-run forever with nothing able to stop it.
      if (!beginPlayIfReady(db, campaign.id)) {
        send(ws, { type: 'error', message: 'The game has already started.' });
        return;
      }
      const gameLoop = new GameLoop(
        db, campaign.id,
        (m) => broadcast(jc, m),
        (m) => { const host = players.find(p => p.isOwner); if (host) send(host.ws, m); },
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

function verifyDataDir(): void {
  const missing: string[] = [];
  if (!safeDataFile('dm-presets', 'chronicler', '.txt')) missing.push('dm-presets/');
  if (!existsSync(dataPath('systems'))) missing.push('systems/');
  if (!safeDataFile('scenarios', 'collapsed-mine', '.json')) missing.push('scenarios/');
  if (missing.length > 0 && process.env.NODE_ENV !== 'test') {
    console.error(`[server] DATA DIRECTORY INCOMPLETE at ${getDataDir()} — missing: ${missing.join(', ')}. DM presets and rules lookups will silently degrade. Set DATA_DIR to the directory containing dm-presets/, scenarios/, and systems/.`);
  }
}

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

verifyDataDir();
bootstrapRules();
server.listen(PORT, () => {
  console.log(`Whispers server listening on port ${PORT}`);
});

export { app, server, wss };
