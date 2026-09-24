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
  setCampaignPaused, getCampaignPause, pauseInterruptedGames,
  type PendingCharacterRow,
} from './room.js';
import { makeCharacterLive } from './character-live.js';
import {
  getWorldSeed, setWorldSeed, setWorldSeedIfNotAccepted, markSeedAccepted, isSeedAccepted, seedWorld, loadStockScenario,
  withoutSeedSpoilers, withoutSetupFieldDumps, withoutSetupMechanics, withoutFalseDraftClaim, setupUnmetForModel, seedWithHostNouns, seedForHost, withHiddenSeedFields,
} from './world-seed.js';
import { checkWorldReadiness, normalizeInfluences, MIN_INFLUENCES } from './world-readiness.js';
import { WorldSeedSchema } from './agents/schemas.js';
import { ingestText, ingestPdf } from './rag/ingest.js';
import { DmAgent, wantsNoSpoilers, nextSetupQuestion } from './agents/dm.js';
import { GameLoop, campaignWantsGentlePeril, worldIntroductionAsShown } from './game-loop.js';
import { gateGentleTone } from './tone-gate.js';
import { guardInterviewReply, neutralSetupNouns, sheetWithNeutralNouns, type PronounMember } from './pronoun-consistency.js';
import { NegotiationRoom } from './negotiation.js';
import { hasDmAuthority, isWorldAuthor, effectiveTableRole, type TableRole } from './seat.js';
import {
  getOrCreateInterview, appendInterviewTurn, setInterviewDefinition, setInterviewDraft, setInterviewStatus, getInterviewBySession, listTableCharacters,
  interviewSheet, mergeCharacterDraft, statedAddressTerms, withStatedAddressTerms, withStatedStuntDescriptions, repeatsEarlierReply, interviewFallbackReply,
  type InterviewTurn,
} from './character-interview.js';
import { checkCharacterReadiness, checkInterviewReadiness } from './character-readiness.js';
import { appendReplayEntry, loadReplayLog } from './replay-log.js';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import type { CampaignMaterial } from '../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '3000', 10);
// Same reasoning as PORT/DATA_DIR/LLM_PROXY_URL above: read once at import
// time so a test harness can shrink the reconnect grace period instead of a
// test needing to actually wait 30 real seconds for room teardown.
const ROOM_TEARDOWN_GRACE_MS = parseInt(process.env.ROOM_TEARDOWN_GRACE_MS ?? '30000', 10);
// How long a playing table may sit with nobody connected before it auto-pauses
// (reason 'no-players'). Long enough that a page refresh — the last tab
// closing and reconnecting a moment later — never pauses the table. The room
// teardown pauses too, so the effective delay is never longer than that.
const EMPTY_TABLE_PAUSE_MS = parseInt(process.env.EMPTY_TABLE_PAUSE_MS ?? '15000', 10);

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

/** A character's last saved state, or null for a revoked or unknown character. */
function storedCharacterState(characterId: string): import('../shared/types.js').CharacterState | null {
  const row = getDb().prepare('SELECT state FROM characters WHERE id = ? AND revoked_at IS NULL').get(characterId) as { state: string } | undefined;
  return row ? JSON.parse(row.state) : null;
}

/**
 * Send to the one seat that plays `characterId` — the campaign_sessions row
 * bound at approval (makeCharacterLive), the same authority whisper routing
 * uses. A character nobody is seated at gets nothing: their private thinking
 * is not the host's to read unless the host is the one playing them.
 */
function sendToCharacterOwner(joinCode: string, campaignId: string, characterId: string, msg: ServerMessage): void {
  const token = getSessionTokenForCharacter(getDb(), campaignId, characterId);
  const ws = token ? socketFor(joinCode, token) : null;
  if (ws) send(ws, msg);
}

/** Tell one socket the table is paused (and why), if it is — so a tab that joins or refreshes mid-pause shows the banner. */
function sendPauseState(ws: WebSocket, campaignId: string, phase: string): void {
  if (phase !== 'playing') return;
  const pause = getCampaignPause(getDb(), campaignId);
  if (pause) send(ws, { type: 'game-paused', paused: true, reason: pause.reason });
}

/**
 * The host's Resume. With a live loop that is just loop.resume(). With no
 * loop — the server restarted under the game, or the room was torn down
 * while it sat paused — a fresh GameLoop is built and started: start()
 * restores scene, turn and transcript from the last checkpoint, so play
 * picks up at the turn after the last one that finished.
 */
function resumeGame(jc: string, campaign: import('../shared/types.js').Campaign, by: string, ws: WebSocket): void {
  const db = getDb();
  const loop = gameLoops.get(jc);
  if (loop && !loop.isStopped) {
    loop.resume(by);
    return;
  }
  if (countLiveCharacters(db, campaign.id) === 0) {
    send(ws, { type: 'error', message: 'There is no one left at the table to resume play with.' });
    return;
  }
  setCampaignPaused(db, campaign.id, null);
  const rebuilt = new GameLoop(
    db, campaign.id,
    (m) => broadcast(jc, m),
    (m) => { const host = hostSocket(jc); if (host) send(host, m); },
    { campaignId: campaign.id, joinCode: jc, phase: 'playing', currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null },
    (characterId, m) => sendToCharacterOwner(jc, campaign.id, characterId, m),
  );
  gameLoops.set(jc, rebuilt);
  broadcast(jc, { type: 'game-paused', paused: false, reason: null, by });
  console.log(`[server] Rebuilt the game loop for room ${jc} from its checkpoint on resume`);
  rebuilt.start().catch(e => console.error('Game loop error:', e));
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
  campaign: { id: string; dmPreset: string; hostTableRole: TableRole | null },
  joinCode: string,
  pending: PendingCharacterRow,
): void {
  if (negotiations.has(pending.id)) return;
  // NOT belt-and-braces on the submit-character call site: that handler
  // re-reads the campaign from the database right after its validateCharacter
  // await and passes THIS SAME fresh object both to its own approver check
  // and to this call, so this guard can never catch anything that check
  // missed there — it is redundant on that path, not independent.
  // It IS an independent, load-bearing guard on the reconnect replay loop
  // above: that loop fetches its own campaign at rejoin time, on a
  // completely separate code path from submission, with no await between
  // that fetch and this call. If the host's table role moved to 'player'
  // between submission and reconnect — and this task's own leak fix means a
  // stale negotiation entry no longer permanently blocks this from running
  // again — this check is the only thing standing between a player and a
  // negotiation panel with dead Approve/Reject buttons and no way to end it.
  if (!hasDmAuthority({ isOwner: true }, campaign.hostTableRole)) return;
  const negotiation = new NegotiationRoom(
    pending.id, pending.definition, pending.aiFeedback, pending.playerName,
    () => socketFor(joinCode, pending.sessionToken),
    () => hostSocket(joinCode),
    campaign.id, campaign.dmPreset, joinCode,
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
  // Optional, but client-reachable and injected into every party member's
  // prompt and the DM's — bounded like everything else, never coerced.
  if (d.age !== undefined && d.age !== null
    && !(typeof d.age === 'number' && Number.isFinite(d.age) && d.age >= 0 && d.age <= 100000)
    && !isValidShortField(d.age)) {
    return `Age must be a number or at most ${MAX_SHORT_FIELD} characters.`;
  }
  if (d.pronouns !== undefined && d.pronouns !== null && !isValidShortField(d.pronouns)) {
    return `Pronouns must be at most ${MAX_SHORT_FIELD} characters.`;
  }
  if (d.relationships !== undefined && d.relationships !== null) {
    const rels = d.relationships;
    const ok = Array.isArray(rels) && rels.length <= MAX_LIST_ITEMS && rels.every(r =>
      r && typeof r === 'object'
      && isValidShortField((r as any).to)
      && isValidShortField((r as any).relation)
      && ((r as any).address === undefined || (r as any).address === null || isValidShortField((r as any).address)));
    if (!ok) return `Relationships must be at most ${MAX_LIST_ITEMS} entries, each naming who (to) and what they are to this character (relation), with an optional form of address, ${MAX_SHORT_FIELD} characters each.`;
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
 *
 * Turn 0 is only genuinely the world introduction when it is an assistant
 * turn — sendWorldIntroduction can fail (LLM timeout/outage) and send
 * nothing, in which case position 0 is the player's own first real message.
 * Pinning a user turn as if it were the intro would duplicate it into the
 * window under a false pretense. character-creator.ts already guards this
 * client-side (see the interview-replay handler); mirror it here.
 */
function windowInterviewHistory(transcript: InterviewTurn[]): InterviewTurn[] {
  if (transcript.length <= INTERVIEW_HISTORY_WINDOW) return transcript;
  const intro = transcript[0]!;
  const recent = transcript.slice(-(INTERVIEW_HISTORY_WINDOW - 1));
  if (intro.role !== 'assistant') return recent;
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
    if (npc.pronouns != null && !isValidNullableBoundedString(npc.pronouns, MAX_SHORT_FIELD)) return `NPC pronouns must be at most ${MAX_SHORT_FIELD} characters.`;
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

function sendDmSettings(ws: WebSocket, campaign: import('../shared/types.js').Campaign, setupChat: Array<{ role: string; content: string }> = []): void {
  const uploadToken = randomBytes(32).toString('hex');
  uploadTokens.set(uploadToken, { campaignId: campaign.id, expires: Date.now() + 4 * 60 * 60 * 1000 });
  // The DM's drafted direction holds the story's secrets; a host who plays
  // or asked for no spoilers is not sent it (the page never shows it).
  const secretsHidden = spoilerFreeHost(campaign, setupChat);
  send(ws, {
    type: 'dm-settings',
    presetName: campaign.dmPreset,
    presetPrompt: loadPresetPrompt(campaign.dmPreset),
    dmCustomPrompt: secretsHidden ? null : campaign.dmCustomPrompt,
    dmInstructions: secretsHidden ? null : campaign.dmInstructions,
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

/**
 * A host who plays in this game, or asked in the setup chat not to be
 * spoiled. Such a host is sent the world without its secrets (seedForHost):
 * hiding them on the card alone left them in the frame for devtools.
 */
function spoilerFreeHost(campaign: import('../shared/types.js').Campaign, setupChat: Array<{ role: string; content: string }>): boolean {
  return campaign.hostTableRole === 'player' || wantsNoSpoilers(setupChat);
}

/** The world-seed-draft frame for this host: the full seed, or the spoiler-free one. */
function seedDraftFor(campaign: import('../shared/types.js').Campaign, setupChat: Array<{ role: string; content: string }>, seed: import('../shared/types.js').WorldSeed, accepted: boolean): ServerMessage {
  return { type: 'world-seed-draft', seed: seedForHost(seed, spoilerFreeHost(campaign, setupChat)), accepted };
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
      // Turn 0 is only genuinely the world introduction when it is an
      // assistant turn. If introduceWorld previously failed (see the empty-
      // text branch below) the player's own first message can occupy turn 0
      // instead — sending that back labeled as the world introduction would
      // show the player their own words framed as the DM's opening. Pin
      // nothing and show nothing in that case; the interview has already
      // moved on without an introduction, and generating one now (after the
      // player has spoken) would no longer be their "first sight" of it.
      if (stored.role === 'assistant') {
        send(ws, { type: 'world-introduction', text: stored.content });
      }
      return;
    }
    const seed = getWorldSeed(db, campaign.id);
    if (!seed) {
      console.warn(`[world-introduction] no world seed yet for campaign ${campaign.id}`);
      return;
    }
    const dm = new DmAgent(db);
    let gentlePeril = false;
    try { gentlePeril = campaignWantsGentlePeril(db, campaign.id); } catch (e) { console.error('[world-introduction] could not read the table tone:', e); }
    const introduce = (toneFeedback?: string) => dm.introduceWorld({
      preset: campaign.dmPreset,
      influences: getInfluences(db, campaign.id),
      seed,
      gentlePeril,
      toneFeedback,
    });
    let raw = await introduce();
    // A gentle table: the judge reads the first sight of the world (live
    // 7RAAQ7: "You and your companion stand bare-chested"); see tone-gate.ts.
    if (gentlePeril && raw.trim()) {
      raw = (await gateGentleTone({
        kind: 'world-intro',
        first: raw,
        textOf: r => worldIntroductionAsShown(r, seed, true),
        regenerate: feedback => introduce(feedback),
        soften: r => r, // worldIntroductionAsShown softens whatever is kept
      })).value;
    }
    const text = worldIntroductionAsShown(raw, seed, gentlePeril);
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
        characterId: null,
      });

      if (campaign) sendDmSettings(ws, campaign);

      const dm = new DmAgent(db);
      // Every rules lookup for a system with no ingested chunks returns the
      // sentinel '(No rules found for this query)' — that string gets
      // interpolated into prompts as if it were the rulebook, so the model
      // narrates and validates with no actual rules and no way to tell the
      // host it is doing so. `dnd5e` is selectable but data/systems/dnd5e
      // does not exist, so choosing it hits exactly this. Check once, at
      // creation, and — rather than have the LLM greeting maybe mention it —
      // say so plainly ourselves and point at the upload control that
      // already exists in the DM lobby sidebar. This does NOT remove the
      // option: dnd5e stays selectable, this only stops it from silently
      // pretending to have rules it doesn't.
      const rulebookCount = db.prepare('SELECT COUNT(*) as c FROM rule_chunks WHERE system_id = ?').get(msg.systemId) as { c: number };
      if (rulebookCount.c === 0) {
        const notice = `Heads up — I don't have a rulebook loaded for "${msg.systemId}" yet, so I have no rules to look up for it. You can upload one (or any reference material) from the sidebar and I'll use it from then on. In the meantime, let's talk about the game you want to run.`;
        if (currentPlayer) {
          currentPlayer.setupChat.push({ role: 'assistant', content: notice });
          saveSetupChat(db, campaignId, currentPlayer.setupChat);
        }
        send(ws, { type: 'dm-chat-reply', text: notice, done: false });
      } else {
        dm.setupChat({ preset: msg.dmPreset, systemId: msg.systemId, history: [], unmet: [] }).then(reply => {
          if (currentPlayer) {
            currentPlayer.setupChat.push({ role: 'assistant', content: reply.reply });
            saveSetupChat(db, campaignId, currentPlayer.setupChat);
          }
          send(ws, { type: 'dm-chat-reply', text: reply.reply, done: false });
        }).catch(e => console.error('[dm-setup] greeting failed:', e));
      }
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
        characterId: null,
      });
      broadcast(msg.joinCode, { type: 'player-joined', playerName: msg.playerName, characterId: null });
      sendPauseState(ws, campaign.id, campaign.phase);
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
        characterId: currentPlayer.characterId,
      });

      // Read once, reused by both the interview-replay check below and the
      // sendWorldIntroduction gate further down — computing it twice, 20-odd
      // lines apart, left nothing keeping the two reads in agreement.
      let nonOwnerInterview: ReturnType<typeof getInterviewBySession> = null;
      let nonOwnerHasChatted = false;

      if (currentPlayer.isOwner) {
        currentPlayer.setupChat = loadSetupChat(db, campaign.id);
        sendDmSettings(ws, campaign, currentPlayer.setupChat);
        const seed = getWorldSeed(db, campaign.id);
        if (seed) send(ws, seedDraftFor(campaign, currentPlayer.setupChat, seed, isSeedAccepted(db, campaign.id)));
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
          nonOwnerInterview = getInterviewBySession(db, campaign.id, currentPlayer.sessionToken);
          nonOwnerHasChatted = nonOwnerInterview?.transcript.some(t => t.role === 'user') ?? false;
          if (nonOwnerHasChatted && nonOwnerInterview) {
            send(ws, { type: 'interview-replay', transcript: nonOwnerInterview.transcript, definition: nonOwnerInterview.definition });
            // No finished sheet to show: bring back the checklist for the
            // draft so far, so a refresh does not blank what was registered.
            const draftSheet = interviewSheet(nonOwnerInterview);
            if (!nonOwnerInterview.definition && draftSheet) {
              send(ws, { type: 'character-readiness', readiness: checkInterviewReadiness(draftSheet) });
            }
          }
        }
      }

      // The playing-phase analog of interview-replay above: a refresh
      // mid-game must not erase the story so far. Every display line the
      // game loop broadcast (and this viewer's own whispers) is replayed so
      // #narration-log refills instead of starting empty. Sent BEFORE the
      // phase-change below on purpose: game-view renders the 'ended' recap
      // panel on that message from counters the replayed scene-end entries
      // accumulate, so the recap must arrive second. Read from the DB, not
      // the live loop, so a rejoin after a server restart (loop gone) or
      // after end-game (loop deleted from gameLoops) still gets the
      // transcript. Whisper echoes carry their sender's session token and
      // loadReplayLog scopes them to exactly that viewer.
      if (campaign.phase === 'playing' || campaign.phase === 'ended') {
        const replay = loadReplayLog(db, campaign.id, currentPlayer.sessionToken);
        if (replay.entries.length > 0 || replay.omitted > 0) {
          send(ws, { type: 'transcript-replay', entries: replay.entries, omitted: replay.omitted });
        }
      }

      send(ws, { type: 'phase-change', phase: campaign.phase });
      // After the phase-change, so the game view it mounts is there to paint
      // the banner — a refresh mid-pause must not look like a hung table.
      sendPauseState(ws, campaign.id, campaign.phase);
      // A refresh mid-window gets the open whisper prompt back, with the
      // time the server's countdown really has left — not a fresh 30s that
      // outlives the window, and not nothing (the prompt is not in the
      // replay log).
      if (campaign.phase === 'playing') {
        const openLoop = gameLoops.get(msg.joinCode);
        // This seat's own status line (trust, stress, FP) — and only its own:
        // character-state-update is owner-only, and it is not in the replay
        // log, so a refreshed tab would otherwise show no status until its
        // character's next turn. The DB session row is the authority on
        // which character this seat plays (see the whisper handler).
        const ownId = getSession(db, currentPlayer.sessionToken)?.characterId ?? null;
        const ownState = ownId ? (openLoop?.characterState(ownId) ?? storedCharacterState(ownId)) : null;
        if (ownId && ownState) send(ws, { type: 'character-state-update', characterId: ownId, state: ownState });
        const openWindow = openLoop?.openWhisperWindow();
        if (openWindow) {
          send(ws, openWindow);
          // Its chips and mood line only if this seat plays that character.
          const guidance = openLoop?.openWhisperWindowGuidance();
          if (guidance && getSessionTokenForCharacter(db, campaign.id, guidance.characterId) === currentPlayer.sessionToken) {
            send(ws, guidance);
          }
        }
      }

      // Sent last and deliberately not awaited: sendWorldIntroduction makes an
      // LLM call with its own multi-second/retry timeout, and a slow or
      // failing proxy must not withhold room-joined/lobby-state/phase-change
      // — already sent above — from a reconnecting player. The helper owns
      // its own try/catch, so a failure here just logs, and it replays a
      // stored introduction rather than regenerating one.
      if (!currentPlayer.isOwner && campaign.phase === 'character-creation' && !nonOwnerHasChatted) {
        void sendWorldIntroduction(ws, campaign, currentPlayer.sessionToken);
      }

      // Anyone who reconnects mid-game (or after it ended) lands on a
      // freshly mounted game-view with no memory of the party — resend the
      // roster so it isn't empty until the next in-flight turn happens to
      // mention a character. Originally owner-only, for the host's revoke
      // controls specifically, but game-view.ts tracks this roster for
      // every client (owner or not) purely to put a name on its own
      // character-revoked notice — a non-owner who refreshes mid-game was
      // left with an empty roster and, on their OWN character's later
      // removal, saw the name-less fallback "A character has been removed
      // from the table" instead of their own character's name.
      if (campaign.phase === 'playing' || campaign.phase === 'ended') {
        const loop = gameLoops.get(msg.joinCode);
        if (loop) send(ws, { type: 'character-roster', characters: loop.rosterSnapshot });
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
      let campaign = submitCampaign;
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

      // dm.validateCharacter is a multi-second LLM call — hostTableRole can
      // change while it is in flight, because choose-table-role's guard only
      // sees characters written via savePendingCharacter/makeCharacterLive,
      // and this submission has written neither yet. Re-read the campaign
      // from the database now, before any decision keyed on hostTableRole:
      // the approver check below and openNegotiation's guard both used to
      // read the pre-await snapshot, which is exactly how a pending row got
      // written under a hostTableRole nobody could act on any more. Same
      // fix host-approve-character already applies with its own fresh
      // joinRoom() call.
      const freshCampaign = joinRoom(db, currentJoinCode);
      if (!freshCampaign) return;
      campaign = freshCampaign;

      // The phase can advance past character-creation while the await above
      // was in flight — the host pressing Start Game during the 2-5 second
      // validation window. The stale pre-await `submitCampaign` phase check
      // at the top of this handler can no longer catch that; re-check it on
      // the campaign we just re-read, or this submission lands in a table
      // that has already opened: on the host-as-player path,
      // makeCharacterLive below would write a live character the already-
      // running GameLoop's one-time loadCharacters() will never load — the
      // player is told "Your character is in the game" and then never gets
      // a turn. On the host-as-DM path it would open a negotiation against a
      // DM lobby the client has already unmounted.
      if (campaign.phase !== 'character-creation') {
        send(ws, { type: 'error', message: 'The game has already started — this character could not be seated.' });
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
      if (msg.role !== 'dm' && msg.role !== 'player') {
        send(ws, { type: 'error', message: "Table role must be 'dm' or 'player'." });
        return;
      }
      const campaign = joinRoom(db, currentJoinCode);
      if (!campaign) return;
      // Switching lanes is harmless right up until a character's fate
      // depends on who holds authority. DM review of a submitted character
      // happens once, at submit-character time — nothing retroactively
      // approves a pending row — so a host swapping away from 'dm' while one
      // is queued strands it: hasDmAuthority then refuses both the AI's
      // queue and the human's, with no one left who could ever act on it.
      // A live (non-revoked) character means the table is already running,
      // where a divided-attention host is the same problem the spec exists
      // to prevent. No characters at all means nothing to strand and no
      // table yet running, so the choice stays open right up to that point
      // — not keyed to phase, which can move (lobby -> character-creation)
      // with zero characters still at the table.
      const hasPendingCharacter = listPendingCharacters(db, campaign.id).length > 0;
      const hasLiveCharacter = countLiveCharacters(db, campaign.id) > 0;
      if (hasPendingCharacter || hasLiveCharacter) {
        send(ws, { type: 'error', message: 'The table role is fixed once a character exists at the table.' });
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
        characterId: currentPlayer!.characterId,
      });
      // The seat is one of the readiness requirements, so the host's
      // Readiness panel must hear about the choice — otherwise it keeps
      // asking them to pick one until an unrelated update refreshes it.
      // Re-read so the readiness check sees the role just saved.
      const updated = joinRoom(db, currentJoinCode);
      if (updated) sendReadiness(ws, updated);
    }

    if (msg.type === 'host-approve-character' && currentJoinCode) {
      const hostCampaign = joinRoom(db, currentJoinCode);
      if (!hostCampaign) return;
      if (!hasDmAuthority(currentPlayer, hostCampaign.hostTableRole)) {
        send(ws, { type: 'error', message: 'Only the host running the table can approve characters.' });
        return;
      }
      const pending = listPendingCharacters(db, hostCampaign.id).find(p => p.id === msg.characterId);
      if (!pending) {
        send(ws, { type: 'error', message: 'That character is not pending review — it may already have been decided.' });
        return;
      }

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
      if (!hostCampaign) return;
      if (!hasDmAuthority(currentPlayer, hostCampaign.hostTableRole)) {
        send(ws, { type: 'error', message: 'Only the host running the table can reject characters.' });
        return;
      }
      const pending = listPendingCharacters(db, hostCampaign.id).find(p => p.id === msg.characterId);
      if (!pending) {
        send(ws, { type: 'error', message: 'That character is not pending review — it may already have been decided.' });
        return;
      }
      if (!isValidLongField(msg.reason)) {
        send(ws, { type: 'error', message: `Rejection reason must be at most ${MAX_LONG_FIELD} characters.` });
        return;
      }
      const playerWs = socketFor(currentJoinCode, pending.sessionToken);
      if (playerWs) send(playerWs, { type: 'character-validated', characterId: pending.id, approved: false, feedback: `Host feedback: ${msg.reason}` });
      deletePendingCharacter(db, msg.characterId);

      // The host's own socket gets nothing today unless told explicitly —
      // acknowledge the reject actually landed, the same way
      // character-submitted acknowledges an approve. Sent last, only once
      // the pending row is actually gone, so a client painting "Rejected"
      // off this event is never ahead of the database.
      send(ws, { type: 'character-rejected', characterId: pending.id, reason: msg.reason });

      // close() (which broadcasts the generic negotiation-closed) runs LAST,
      // after both sides already have their specific outcome message
      // (character-validated for the player, character-rejected for the
      // host) — same ordering host-approve-character uses. The client
      // treats whichever specific message it saw first as authoritative and
      // no-ops on negotiation-closed once already closed (see
      // negotiation-chat.ts), so this ordering is what keeps the generic
      // notice from ever winning the race and displaying instead of the
      // specific one.
      const neg = negotiations.get(msg.characterId);
      if (neg) { neg.close(); negotiations.delete(msg.characterId); }
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
      // Unlike host-approve/host-reject/negotiation-message — where an
      // unvalidated characterId just fails a Map/array .find() and falls
      // into an existing "not found" branch — this characterId goes
      // straight into a raw SQL bind below. A non-string (undefined from a
      // malformed payload, an object, etc.) throws inside better-sqlite3
      // rather than failing that kind of lookup, and on a branch whose
      // theme is "refusals speak", the host deserves an error message
      // instead of a silently-logged unhandled rejection.
      if (!isValidShortField(msg.characterId)) {
        send(ws, { type: 'error', message: 'A valid character id is required to revoke a character.' });
        return;
      }
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
        // Reopening the interview is only honest during character-creation —
        // that's the only phase submit-character and char-chat still accept
        // it in. A revoke mid-game (playing/ended) must not leave the
        // interview 'open' promising a rebuild path that leads nowhere: both
        // of those handlers would refuse the very player this reopened for.
        // Not reopening here, rather than reopening and telling them they
        // can't use it yet, is the smaller lie to leave standing — it needs
        // no new client-facing copy and no new state for anything else to
        // contradict.
        if (revokeCampaign.phase === 'character-creation') {
          const interview = getInterviewBySession(db, revokeCampaign.id, ownerToken);
          if (interview) setInterviewStatus(db, interview.id, 'open');
        }
      }

      const playerInRoom = rooms.get(currentJoinCode)?.find(p => p.sessionToken === ownerToken);
      if (playerInRoom) playerInRoom.characterId = null;

      // A veto mid-session must stop the LIVE game loop from taking this
      // character's turns, not just update rows a new loop would read on
      // its next start() — loadCharacters() only runs once, so nothing
      // re-reads revoked_at afterwards. gameLoops is keyed by join code
      // (see start-game above), not campaign id.
      //
      // revokeCharacter's own deletion from its characters map is
      // synchronous (done before it returns its promise), so the party-size
      // guard below and the loop's own internal bookkeeping never race —
      // only its "did this empty the party and end the game" outcome is
      // async, because ending the game means awaiting an epilogue. Captured
      // into `jc` rather than read from `currentJoinCode` inside the
      // callback: this socket can process another rejoin before the promise
      // settles, which would repoint `currentJoinCode` at a different room.
      const jc = currentJoinCode;
      const loop = gameLoops.get(jc);
      if (loop) {
        // Mirrors end-game's own ordering exactly: the DB phase write
        // happens via onEmptied, synchronously the instant the party is
        // detected empty — BEFORE the epilogue-generating await inside
        // revokeCharacter's own endGame() call — the same order end-game's
        // handler above uses (setCampaignPhase, then loop.endGame()). This
        // used to run the DB write only after the whole promise settled,
        // which put it AFTER the 'ended' broadcast the epilogue precedes:
        // for as long as epilogue generation took, the DB said 'playing'
        // while every connected client had already been told 'ended'.
        //
        // gameLoops.delete(jc) is unconditional — in both .then and .catch
        // — so a rejected endGame() (a failed epilogue call, say) can never
        // leave a stopped loop parked in the map with the DB phase stuck at
        // 'playing' forever; the DB write above already landed regardless
        // of how the rest of endGame() went.
        loop.revokeCharacter(msg.characterId, () => setCampaignPhase(db, revokeCampaign.id, 'ended'))
          .then((gameEnded) => {
            if (gameEnded) gameLoops.delete(jc);
          })
          .catch(e => {
            console.error('[revoke-character] failed while ending an emptied game loop:', e);
            gameLoops.delete(jc);
          });
      }

      // Defensive, not currently reachable through this handler's own
      // control flow: revokeCharacter above only ever succeeds against a
      // row already in the `characters` table, and the only two paths that
      // put a row there — the AI-auto-approve branch of submit-character,
      // and host-approve-character — either never open a negotiation for
      // that id at all, or write the row and call neg.close() in the same
      // synchronous handler with no await between them, so today there is
      // no tick in which a revocable character's negotiation can still be
      // open. Kept anyway because that is an invariant of today's call
      // graph, not a guarantee revoke-character's own contract makes — a
      // live character with a dangling negotiation entry must not leave the
      // player staring at a phantom input box, however that entry came to
      // still exist.
      const neg = negotiations.get(msg.characterId);
      if (neg && !neg.isClosed()) { neg.close(); negotiations.delete(msg.characterId); }

      // The live line this broadcast paints in game-view ("Name has been
      // removed from the table…") is resolved from the roster at render
      // time, and the replayed roster only ever holds LIVE characters — so
      // record the resolved text instead, or a refreshed player's log shows
      // an anonymous removal. Scoped to playing/ended: a revoke during
      // character-creation never painted a play-log line and must not
      // fabricate one when the table later starts.
      if (revokeCampaign.phase === 'playing' || revokeCampaign.phase === 'ended') {
        let revokedName = 'A character';
        try {
          const revokedRow = db.prepare('SELECT definition FROM characters WHERE id = ?').get(msg.characterId) as { definition: string } | undefined;
          revokedName = (revokedRow ? JSON.parse(revokedRow.definition).name : null) ?? revokedName;
        } catch {
          // Fall back to the anonymous name the pre-fix client showed.
        }
        appendReplayEntry(db, revokeCampaign.id, {
          type: 'revoked-note',
          text: reason ? `${revokedName} has been removed from the table: ${reason}` : `${revokedName} has been removed from the table.`,
        });
      }

      broadcast(currentJoinCode, { type: 'character-revoked', characterId: msg.characterId, reason });
    }

    if (msg.type === 'negotiation-message' && currentJoinCode && currentPlayer) {
      // Unbounded otherwise: this reaches every other client's screen via
      // broadcast AND the DM/character agent prompts on the next round.
      // Mirrors revoke-character's reason bound above.
      if (!isValidLongField(msg.text)) {
        send(ws, { type: 'error', message: `Message must be at most ${MAX_LONG_FIELD} characters.` });
        return;
      }
      const negotiation = negotiations.get(msg.characterId);
      // host-approve-character/host-reject-character/room-teardown all
      // close() AND remove their entry from `negotiations`, so a genuinely
      // closed negotiation is indistinguishable here from one that was
      // never opened — both mean "there is nothing live to send this to."
      // There is no AI-participation cap (see negotiation.ts): a negotiation
      // keeps its agents talking for as long as the humans keep it going, so
      // the only way to reach a dead entry here is a genuine close. Only a
      // truly absent/closed negotiation refuses, and it refuses with a
      // message — a silent drop leaves a host or player typing into a box
      // that eats everything with no sign anything went wrong.
      if (!negotiation || negotiation.isClosed()) {
        send(ws, { type: 'error', message: 'This negotiation is closed — the character has already been decided.' });
        return;
      }
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
        // The interviewer is told what is still missing from the sheet so
        // far — the running draft, not just a finished sheet — or it asks
        // again for a name the player already gave.
        const before = checkInterviewReadiness(interviewSheet(interview));
        const fullHistory = getInterviewBySession(db, campaign.id, currentPlayer.sessionToken)?.transcript ?? [];
        const history = windowInterviewHistory(fullHistory);
        const tableCharacters = listTableCharacters(db, campaign.id, currentPlayer.sessionToken);
        const interviewOpts = {
          systemId: campaign.systemId,
          preset: campaign.dmPreset,
          playerName: currentPlayer.playerName,
          influences: getInfluences(db, campaign.id),
          seed: getWorldSeed(db, campaign.id),
          history,
          unmet: before.detail,
          tableCharacters,
        };
        let reply = await dm.interviewForCharacter(interviewOpts);
        // Live (WXKC2C): Liz's second reply was her first, word for word,
        // after she had answered it. Asked once more; if that repeats too,
        // a plain line built from the checklist goes instead (below).
        let repeated = repeatsEarlierReply(reply.reply, fullHistory);
        if (repeated) {
          console.warn('[char-chat] interview reply repeats an earlier one word for word; asking once more');
          try {
            const again = await dm.interviewForCharacter({
              ...interviewOpts,
              history: [...history, { role: 'assistant', content: reply.reply }, { role: 'user', content: '(That reply repeats one you already gave, word for word. Answer what I said last, and ask about something that is still missing.)' }],
            });
            if (!repeatsEarlierReply(again.reply, fullHistory)) { reply = again; repeated = false; }
          } catch (e) {
            console.error('[char-chat] retry after a repeated reply failed:', e);
          }
        }
        // Names, not "Mom Liz"; and no he/she for a character whose
        // pronouns are not on the sheet yet (as of this reply).
        // An address term the player stated outright ("Please keep 'calls Liz
        // Mom' in the sheet") goes on the sheet whether or not the model
        // wrote it down — live, it was dropped.
        const playerLines = fullHistory.filter(t => t.role === 'user').map(t => t.content);
        const tableMembers: PronounMember[] = tableCharacters.map(c => ({ name: c.name, pronouns: c.pronouns, relationships: c.relationships }));
        const withStated = <T extends import('../shared/types.js').CharacterDefinition | null>(sheet: T): T => {
          if (!sheet) return sheet;
          const terms = playerLines.flatMap(line => statedAddressTerms(line, {
            characterName: sheet.name ?? '',
            playerName: currentPlayer!.playerName,
            tableNames: tableCharacters.map(c => c.name),
            relationships: sheet.relationships ?? [],
          }));
          // "She and her ten-year-old son Biz" (copied from the world seed)
          // while Biz's pronouns are unknown or they/them: "kid".
          const self: PronounMember = { name: sheet.name ?? '', pronouns: sheet.pronouns ?? null, relationships: sheet.relationships ?? [] };
          return sheetWithNeutralNouns(withStatedStuntDescriptions(withStatedAddressTerms(sheet, terms), playerLines), [...(self.name ? [self] : []), ...tableMembers]);
        };
        const sheetAsOfReply = withStated(reply.definition ? mergeCharacterDraft(interviewSheet(interview), reply.definition) : interviewSheet(interview));
        reply.reply = repeated
          ? interviewFallbackReply(checkInterviewReadiness(sheetAsOfReply))
          : guardInterviewReply(reply.reply, sheetAsOfReply, tableMembers);
        appendInterviewTurn(db, interview.id, { role: 'assistant', content: reply.reply });

        // interview was fetched BEFORE the await above — a stale snapshot
        // from before dm.interviewForCharacter's round trip. This same
        // socket's confirm-character handler (or, in principle, a second
        // char-chat this one raced against) reads and writes this row from
        // the database on every call, never from an in-memory copy, so
        // gating on or sending back the pre-await object here could
        // contradict what's actually stored by the time this reply lands.
        // Re-read fresh before computing readiness or sending anything.
        const current = getInterviewBySession(db, campaign.id, currentPlayer.sessionToken) ?? interview;

        // Every reply reports the sheet as the model understands it so far;
        // it is folded into the stored draft, so a field stated once stays
        // stated (a clarifying question comes back with `definition: null`
        // and changes nothing). The checklist is computed from that draft.
        const merged = reply.definition ? mergeCharacterDraft(interviewSheet(current), reply.definition) : interviewSheet(current);
        const draft = withStated(merged);
        if ((reply.definition || draft !== merged) && draft) setInterviewDraft(db, interview.id, draft);
        const draftReadiness = checkInterviewReadiness(draft);
        const storedReadiness = checkInterviewReadiness(current.definition);
        // A ready draft that differs from the stored sheet is a new proposal
        // (setInterviewDefinition resets it to unconfirmed). One identical to
        // a ready stored sheet — a thin reply that changed nothing — is not:
        // the stored sheet is re-shown without touching its confirmation.
        const changed = JSON.stringify(draft) !== JSON.stringify(current.definition);
        if (reply.definition && draft && draftReadiness.ready && changed) {
          setInterviewDefinition(db, interview.id, draft);
          send(ws, { type: 'char-chat-reply', text: reply.reply, definition: draft });
          send(ws, { type: 'character-preview', definition: draft, readiness: draftReadiness });
        } else if (current.definition && storedReadiness.ready) {
          // Nothing new and finished was proposed this turn, but the stored
          // sheet is ready: re-send IT as the preview rather than a false
          // "still shaping this character" checklist. Does NOT touch
          // interview status: if it was already confirmed, the confirm
          // button reappearing and requiring one more click is a minor
          // inconvenience, not a lie about the character's state.
          send(ws, { type: 'char-chat-reply', text: reply.reply, definition: null });
          send(ws, { type: 'character-preview', definition: current.definition, readiness: storedReadiness });
        } else {
          // An unfinished draft is NOT shown as a definition — the model
          // does not get to decide the interview is finished.
          send(ws, { type: 'char-chat-reply', text: reply.reply, definition: null });
          send(ws, { type: 'character-readiness', readiness: draftReadiness });
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
      const readiness = checkInterviewReadiness(interview.definition);
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
          unmet: setupUnmetForModel(before),
          hostTableRole: campaign.hostTableRole,
        });
        // The chat reply is conversation only. Live (E9W9YT) the model wrote
        // its own draft into it — a "Plot Hook:" block, then raw
        // "dmInstructions:" / "dmCustomPrompt:" dumps — so labelled draft
        // blocks come out for every host (a DM host sees the world on its
        // card). A host who plays, or asked for no spoilers, also never reads
        // the drafted world's plot hooks or NPC motives back, nor a secret of
        // the direction still being drafted (this reply's own dmCustomPrompt).
        const noSpoilers = spoilerFreeHost(campaign, currentPlayer.setupChat);
        const movingOn = `I have the shape of it — the rest you will discover in play. ${nextSetupQuestion(before.detail).replace(/^Noted\.\s*/, '')}`;
        reply.reply = withoutSetupFieldDumps(reply.reply, { noSpoilers, fallback: movingOn });
        // Live (WXKC2C): "I am setting this to 'done' so the world card can be generated for you to see."
        reply.reply = withoutSetupMechanics(reply.reply, movingOn);
        if (noSpoilers) {
          reply.reply = withoutSeedSpoilers(reply.reply, getWorldSeed(db, campaign.id), movingOn, [reply.dmCustomPrompt, campaign.dmCustomPrompt]);
        }
        // "her son Biz" when the host said "her kid Biz".
        const hostLines = currentPlayer.setupChat.filter(m => m.role === 'user').map(m => m.content);
        reply.reply = neutralSetupNouns(reply.reply, hostLines);
        if (reply.dmInstructions) reply.dmInstructions = neutralSetupNouns(reply.dmInstructions, hostLines);
        if (reply.dmCustomPrompt) reply.dmCustomPrompt = neutralSetupNouns(reply.dmCustomPrompt, hostLines);
        // "I've drafted a starting world… review the world card" when no
        // draft will follow this reply (the same test the draft step below
        // uses): the claim comes out and the next question goes in.
        {
          const named = normalizeInfluences(reply.influences);
          const influenceCount = named.length > 0 ? named.length : getInfluences(db, campaign.id).length;
          const direction = (reply.done && reply.dmInstructions) || campaign.dmInstructions;
          const draftComing = Boolean(getWorldSeed(db, campaign.id)) || (influenceCount >= MIN_INFLUENCES && Boolean(direction));
          reply.reply = withoutFalseDraftClaim(reply.reply, { draftComing, fallback: nextSetupQuestion(before.detail) });
        }
        currentPlayer.setupChat.push({ role: 'assistant', content: reply.reply });

        const influences = normalizeInfluences(reply.influences);
        if (influences.length > 0) setInfluences(db, campaign.id, influences);

        // The schema allows done: true with dmInstructions: null (it's a nullable
        // field, and the model can set the flag without filling it in). Persisting
        // is gated on BOTH, so `persisted` is the only thing we're allowed to tell
        // the host "done" happened — reporting reply.done on its own would advance
        // the UI (Start Game enables) while the readiness checklist, sourced from
        // this same DB row below via sendReadiness, keeps saying the summary is
        // missing. That silent contradiction is the bug this guards against.
        //
        // Chosen fix: report the failure honestly rather than asking the model
        // again. We do NOT fabricate dmInstructions from reply.reply's prose — that
        // would be inventing data to paper over missing data. A second LLM call
        // from inside this handler to demand the summary again is unnecessary: the
        // setup chat loop already re-prompts on every done: false turn (the
        // `unmet` block above tells the model exactly what's still missing), so
        // the host's next message naturally gives the model another chance to
        // produce dmInstructions instead of retrying against the same failure mode.
        const persisted = reply.done && Boolean(reply.dmInstructions);
        if (persisted) {
          db.prepare("UPDATE campaigns SET dm_instructions = ?, dm_custom_prompt = ?, updated_at = datetime('now') WHERE id = ?")
            .run(reply.dmInstructions, reply.dmCustomPrompt, campaign.id);
        } else if (reply.done) {
          console.warn(`[dm-chat] campaign ${campaign.id}: DM set done=true with no dmInstructions — not persisting, reporting not-done to host`);
        }
        saveSetupChat(db, campaign.id, currentPlayer.setupChat);

        after = joinRoom(db, currentJoinCode);
        if (!after) return;

        send(ws, { type: 'dm-chat-reply', text: reply.reply, done: persisted });
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
          const seed = seedWithHostNouns(await dm.draftWorldSeed({
            preset: after.dmPreset,
            systemId: after.systemId,
            influences: getInfluences(db, after.id),
            dmInstructions: after.dmInstructions ?? '',
            history: currentPlayer.setupChat,
            existing: getWorldSeed(db, after.id) ?? stock?.seed ?? null,
          }), currentPlayer.setupChat.filter(m => m.role === 'user').map(m => m.content));

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

          send(ws, seedDraftFor(latest, currentPlayer.setupChat, seed, false));
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
      // A spoiler-free host was never sent the plot hooks or NPC motives
      // (seedForHost), so what they accept comes back without them: the
      // stored draft's are put back before anything is checked or written.
      if (spoilerFreeHost(campaign, currentPlayer!.setupChat)) parsed.data = withHiddenSeedFields(parsed.data, getWorldSeed(db, campaign.id));

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
        send(ws, seedDraftFor(campaign, currentPlayer!.setupChat, parsed.data, true));
        // The world bible is seeded here, at accept — not at game start. The
        // live playtests read this line to confirm the world loaded.
        console.log(`[server] Seeded scenario for room ${currentJoinCode}: ${parsed.data.locations.length} locations, ${parsed.data.npcs.length} NPCs, ${parsed.data.items.length} items`);
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
          // A host who chose to play is seated at their own table with no
          // one else to hand them this — they meet the world here too, not
          // only non-owners.
          if (effectiveTableRole(campaign.hostTableRole) === 'player') {
            void sendWorldIntroduction(ws, campaign, currentPlayer!.sessionToken);
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
        const seed = seedWithHostNouns(await dm.draftWorldSeed({
          preset: campaign.dmPreset,
          systemId: campaign.systemId,
          influences: getInfluences(db, campaign.id),
          dmInstructions: campaign.dmInstructions ?? '',
          history,
          existing: getWorldSeed(db, campaign.id),
        }), history.filter(m => m.role === 'user').map(m => m.content));
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
        send(ws, seedDraftFor(campaign, currentPlayer!.setupChat, seed, false));
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
        (characterId, m) => sendToCharacterOwner(jc, campaign.id, characterId, m),
      );
      gameLoops.set(jc, gameLoop);
      gameLoop.start().catch(e => console.error('Game loop error:', e));
    }

    if (msg.type === 'whisper' && currentJoinCode && currentPlayer) {
      const raw = msg.text;
      if (typeof raw !== 'string' || raw.trim().length === 0) return;
      const whisperText = raw.trim().slice(0, 200);
      const loop = gameLoops.get(currentJoinCode);
      if (!loop) {
        const idleCampaign = joinRoom(db, currentJoinCode);
        const paused = idleCampaign && idleCampaign.phase === 'playing' && getCampaignPause(db, idleCampaign.id);
        send(ws, {
          type: 'whisper-ack', status: 'rejected', characterId: null, characterName: null,
          message: paused
            ? 'The game is paused — your whisper can be heard once the host resumes it.'
            : 'There is no game running at this table right now.',
        });
        return;
      }
      // Whose voice is this? campaign_sessions.character_id — written at
      // approval, cleared at revoke — is the binding this process and a
      // restarted one agree on; the seat object's in-memory characterId
      // goes stale on some rejoin paths, so the DB row is the authority and
      // the whisper is routed by it, never by whose window happens to be
      // open (MUL-73: the silent drop AND the cross-player reach were both
      // artifacts of that routing).
      const seatRow = db.prepare('SELECT character_id FROM campaign_sessions WHERE token = ?').get(currentPlayer.sessionToken) as { character_id: string | null } | undefined;
      const senderCharacterId = seatRow?.character_id ?? null;
      const ack = loop.handleWhisper(whisperText, { characterId: senderCharacterId, isOwner: currentPlayer.isOwner });
      // The live "You whisper: ..." line is a local render game-view does
      // when the server ACCEPTS the whisper (on 'whisper-ack', MUL-73) —
      // no broadcast ever carries it, so a refresh would lose it even
      // though everyone else never saw it. Record it here, scoped to this
      // session's own replay view (loadReplayLog filters on session_token).
      // Only accepted whispers echo: a rejected one was never shown live
      // either, and replaying it would resurrect words the table refused.
      if (ack.status !== 'rejected') {
        const whisperCampaign = joinRoom(db, currentJoinCode);
        if (whisperCampaign) {
          appendReplayEntry(db, whisperCampaign.id, { type: 'whisper-echo', text: whisperText }, currentPlayer.sessionToken);
        }
      }
      send(ws, { type: 'whisper-ack', ...ack });
    }

    if ((msg.type === 'pause-game' || msg.type === 'resume-game') && currentJoinCode && currentPlayer) {
      if (!isWorldAuthor(currentPlayer)) {
        send(ws, { type: 'error', message: 'Only the host can pause or resume the game.' });
        return;
      }
      const jc = currentJoinCode;
      const campaign = joinRoom(db, jc);
      if (!campaign || campaign.phase !== 'playing') {
        send(ws, { type: 'error', message: 'There is no game in play to pause or resume.' });
        return;
      }
      if (msg.type === 'pause-game') {
        const loop = gameLoops.get(jc);
        if (loop && !loop.isStopped) {
          loop.pause('host', currentPlayer.playerName);
        } else {
          setCampaignPaused(db, campaign.id, 'host');
          broadcast(jc, { type: 'game-paused', paused: true, reason: 'host', by: currentPlayer.playerName });
        }
      } else {
        resumeGame(jc, campaign, currentPlayer.playerName, ws);
      }
    }

    if (msg.type === 'end-game' && currentJoinCode && isWorldAuthor(currentPlayer)) {
      const jc = currentJoinCode;
      const endedCampaign = joinRoom(db, jc);
      if (endedCampaign) {
        setCampaignPhase(db, endedCampaign.id, 'ended');
        setCampaignPaused(db, endedCampaign.id, null);
      }
      const loop = gameLoops.get(jc);
      if (!loop && endedCampaign?.phase === 'playing') {
        // The loop is gone (server restart, or torn down while paused) but
        // the story isn't: rebuild just enough of it to write the epilogue,
        // which endGame broadcasts along with the 'ended' phase-change.
        const epilogueLoop = new GameLoop(
          db, endedCampaign.id,
          (m) => broadcast(jc, m),
          (m) => { const host = hostSocket(jc); if (host) send(host, m); },
          { campaignId: endedCampaign.id, joinCode: jc, phase: 'playing', currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null },
          (characterId, m) => sendToCharacterOwner(jc, endedCampaign.id, characterId, m),
        );
        epilogueLoop.restoreForEpilogue();
        epilogueLoop.endGame().catch(e => {
          console.error('[server] endGame (no live loop) failed:', e);
          broadcast(jc, { type: 'phase-change', phase: 'ended' });
        });
      } else if (loop) {
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
        // Nobody is at the table: stop spending on it once it has stayed
        // empty for EMPTY_TABLE_PAUSE_MS (so a refresh doesn't pause it), and
        // in any case before the teardown below drops the loop. Paused (not
        // stopped) so it is persisted and the host can resume it — resume
        // rebuilds a dropped loop from the checkpoint. A deliberate host
        // pause keeps its reason; a quiet pause does not, because once the
        // loop is torn down a whisper can no longer lift it — only the host can.
        const pauseIfStillEmpty = () => {
          const now = rooms.get(jc);
          if (now && now.length > 0) return;
          const idleLoop = gameLoops.get(jc);
          if (idleLoop && idleLoop.pausedReason !== 'host') idleLoop.pause('no-players');
        };
        setTimeout(pauseIfStillEmpty, EMPTY_TABLE_PAUSE_MS);
        setTimeout(() => {
          const stillEmpty = rooms.get(jc);
          if (!stillEmpty || stillEmpty.length === 0) {
            pauseIfStillEmpty();
            rooms.delete(jc);
            const loop = gameLoops.get(jc);
            if (loop) { loop.stop(); gameLoops.delete(jc); }
            // Cleared in the same place as rooms/gameLoops so the three
            // cannot drift apart. Without this, a negotiation for this room
            // sits in the map forever: openNegotiation's has() guard then
            // permanently blocks a fresh negotiation from ever being opened
            // for that character again, even after everyone reconnects —
            // not just a memory leak, a dead feature for anyone who does.
            for (const [charId, neg] of negotiations) {
              if (neg.joinCode === jc) { neg.close(); negotiations.delete(charId); }
            }
            console.log(`[server] Room ${jc} cleaned up after reconnect grace period`);
          }
        }, ROOM_TEARDOWN_GRACE_MS);
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
{
  // No GameLoop survives a restart, so every game still 'playing' in the
  // database was interrupted. Mark it paused (reason 'restart') instead of
  // leaving it stranded; the host's Resume rebuilds it from its checkpoint.
  const interrupted = pauseInterruptedGames(getDb());
  if (interrupted > 0) console.log(`[server] Paused ${interrupted} game(s) interrupted by the restart`);
}
server.listen(PORT, () => {
  console.log(`Whispers server listening on port ${PORT}`);
});

export { app, server, wss, gameLoops, negotiations, windowInterviewHistory };
