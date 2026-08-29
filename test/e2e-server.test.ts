import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { getDb, getDataDir } from '../src/server/db.js';
import { createRoom, joinRoom } from '../src/server/room.js';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';
import type { CharacterDefinition } from '../src/shared/types.js';
import type Database from 'better-sqlite3';

let server: Server;
let wss: WebSocketServer;
let db: Database.Database;
let port: number;

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function sendMsg(ws: WebSocket, msg: ClientMessage): void {
  ws.send(JSON.stringify(msg));
}

function waitForMsg(ws: WebSocket, type: string, timeoutMs = 5000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const handler = (data: Buffer) => {
      const msg: ServerMessage = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

function collectMsgs(ws: WebSocket, count: number, timeoutMs = 5000): Promise<ServerMessage[]> {
  return new Promise((resolve, reject) => {
    const msgs: ServerMessage[] = [];
    const timer = setTimeout(() => resolve(msgs), timeoutMs);
    const handler = (data: Buffer) => {
      msgs.push(JSON.parse(data.toString()));
      if (msgs.length >= count) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msgs);
      }
    };
    ws.on('message', handler);
  });
}

beforeAll(async () => {
  db = getDb();
  const app = express();
  app.use(express.json());
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });

  server = createServer(app);
  wss = new WebSocketServer({ server, path: '/ws' });

  const rooms = new Map<string, Array<{ ws: WebSocket; playerName: string; characterId: string | null; isHost: boolean }>>();

  wss.on('connection', (ws) => {
    let currentJoinCode: string | null = null;
    let currentPlayer: { ws: WebSocket; playerName: string; characterId: string | null; isHost: boolean } | null = null;

    ws.on('message', (raw) => {
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
        ws.send(JSON.stringify({ type: 'room-joined', campaignId, joinCode, isHost: true }));
      }

      if (msg.type === 'join') {
        const campaign = joinRoom(db, msg.joinCode);
        if (!campaign) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid join code' }));
          return;
        }
        currentJoinCode = msg.joinCode;
        currentPlayer = { ws, playerName: msg.playerName, characterId: null, isHost: false };
        const players = rooms.get(msg.joinCode) ?? [];
        players.push(currentPlayer);
        rooms.set(msg.joinCode, players);
        ws.send(JSON.stringify({ type: 'room-joined', campaignId: campaign.id, joinCode: msg.joinCode, isHost: false }));
        const data = JSON.stringify({ type: 'player-joined', playerName: msg.playerName, characterId: null });
        for (const p of players) {
          if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
        }
      }

      if (msg.type === 'submit-character' && currentJoinCode) {
        const campaign = joinRoom(db, currentJoinCode);
        if (!campaign) return;
        const charId = randomBytes(16).toString('hex');
        const def = (msg as any).definition as CharacterDefinition;
        const approved = !!def.name;
        const feedback = approved ? 'Looks good!' : 'Character needs a name.';
        if (approved) {
          const initialState = JSON.stringify({
            stress: 0, consequences: [], fatePoints: 3,
            inventory: [], xpMilestones: [], whisperTrust: 0.5,
          });
          db.prepare('INSERT INTO characters (id, campaign_id, player_user_id, definition, state) VALUES (?, ?, ?, ?, ?)')
            .run(charId, campaign.id, null, JSON.stringify(def), initialState);
          if (currentPlayer) currentPlayer.characterId = charId;
        }
        ws.send(JSON.stringify({ type: 'character-validated', characterId: charId, approved, feedback }));
        if (approved) {
          const players = rooms.get(currentJoinCode) ?? [];
          const bcData = JSON.stringify({ type: 'character-submitted', characterId: charId, definition: def });
          for (const p of players) {
            if (p.ws.readyState === WebSocket.OPEN) p.ws.send(bcData);
          }
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
        } else {
          const data = JSON.stringify({ type: 'player-left', playerName: currentPlayer.playerName });
          for (const p of players) {
            if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
          }
        }
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) port = addr.port;
      resolve();
    });
  });
});

afterAll(async () => {
  wss.close();
  server.close();
  db.close();
});

describe('E2E: Room lifecycle', () => {
  it('creates a room and returns join code', async () => {
    const ws = await connectWs();
    const promise = waitForMsg(ws, 'room-joined');
    sendMsg(ws, {
      type: 'create',
      name: 'Test Adventure',
      dmPreset: 'chronicler',
      scenarioId: null,
      systemId: 'fate-core',
      houseRules: null,
    });
    const msg = await promise;
    expect(msg.type).toBe('room-joined');
    if (msg.type === 'room-joined') {
      expect(msg.isHost).toBe(true);
      expect(msg.joinCode).toHaveLength(6);
      expect(msg.campaignId).toBeTruthy();
    }
    ws.close();
  });

  it('another player can join with the code', async () => {
    const host = await connectWs();
    const hostPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Joinable Game',
      dmPreset: 'chronicler',
      scenarioId: null,
      systemId: 'fate-core',
      houseRules: null,
    });
    const hostMsg = await hostPromise;
    if (hostMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = hostMsg.joinCode;

    const player = await connectWs();
    const playerPromise = waitForMsg(player, 'room-joined');
    sendMsg(player, { type: 'join', joinCode, playerName: 'TestPlayer' });
    const playerMsg = await playerPromise;
    expect(playerMsg.type).toBe('room-joined');
    if (playerMsg.type === 'room-joined') {
      expect(playerMsg.isHost).toBe(false);
      expect(playerMsg.joinCode).toBe(joinCode);
    }

    const hostNotification = await waitForMsg(host, 'player-joined');
    expect(hostNotification.type).toBe('player-joined');
    if (hostNotification.type === 'player-joined') {
      expect(hostNotification.playerName).toBe('TestPlayer');
    }

    host.close();
    player.close();
  });

  it('rejects invalid join code', async () => {
    const ws = await connectWs();
    const promise = waitForMsg(ws, 'error');
    sendMsg(ws, { type: 'join', joinCode: 'XXXXXX', playerName: 'Nobody' });
    const msg = await promise;
    expect(msg.type).toBe('error');
    if (msg.type === 'error') {
      expect(msg.message).toContain('Invalid');
    }
    ws.close();
  });

  it('notifies remaining players when someone disconnects', async () => {
    const host = await connectWs();
    const hostPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Disconnect Test',
      dmPreset: 'chronicler',
      scenarioId: null,
      systemId: 'fate-core',
      houseRules: null,
    });
    const hostMsg = await hostPromise;
    if (hostMsg.type !== 'room-joined') throw new Error('Expected room-joined');

    const player = await connectWs();
    const playerPromise = waitForMsg(player, 'room-joined');
    sendMsg(player, { type: 'join', joinCode: hostMsg.joinCode, playerName: 'Leaver' });
    await playerPromise;
    await waitForMsg(host, 'player-joined');

    const leavePromise = waitForMsg(host, 'player-left');
    player.close();
    const leaveMsg = await leavePromise;
    expect(leaveMsg.type).toBe('player-left');
    if (leaveMsg.type === 'player-left') {
      expect(leaveMsg.playerName).toBe('Leaver');
    }

    host.close();
  });
});

describe('E2E: Room creation in database', () => {
  it('persists campaign to database', async () => {
    const ws = await connectWs();
    const promise = waitForMsg(ws, 'room-joined');
    sendMsg(ws, {
      type: 'create',
      name: 'DB Test',
      dmPreset: 'trickster',
      scenarioId: null,
      systemId: 'fate-core',
      houseRules: 'No PvP',
    });
    const msg = await promise;
    if (msg.type !== 'room-joined') throw new Error('Expected room-joined');

    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(msg.campaignId) as any;
    expect(campaign).toBeTruthy();
    expect(campaign.name).toBe('DB Test');
    expect(campaign.dm_preset).toBe('trickster');
    expect(campaign.system_id).toBe('fate-core');
    expect(campaign.house_rules).toBe('No PvP');
    expect(campaign.join_code).toBe(msg.joinCode);

    ws.close();
  });
});

describe('E2E: Multiple concurrent rooms', () => {
  it('supports multiple independent rooms', async () => {
    const host1 = await connectWs();
    const host2 = await connectWs();

    const p1 = waitForMsg(host1, 'room-joined');
    sendMsg(host1, { type: 'create', name: 'Room 1', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
    const msg1 = await p1;

    const p2 = waitForMsg(host2, 'room-joined');
    sendMsg(host2, { type: 'create', name: 'Room 2', dmPreset: 'trickster', scenarioId: null, systemId: 'fate-core', houseRules: null });
    const msg2 = await p2;

    if (msg1.type !== 'room-joined' || msg2.type !== 'room-joined') throw new Error('Expected room-joined');
    expect(msg1.joinCode).not.toBe(msg2.joinCode);

    const player1 = await connectWs();
    const pp1 = waitForMsg(player1, 'room-joined');
    sendMsg(player1, { type: 'join', joinCode: msg1.joinCode, playerName: 'Player1' });
    await pp1;

    const notif1 = await waitForMsg(host1, 'player-joined');
    expect(notif1.type).toBe('player-joined');

    host1.close();
    host2.close();
    player1.close();
  });
});

describe('E2E: Character submission', () => {
  it('submits a single character and receives validation', async () => {
    const host = await connectWs();
    const hostPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, { type: 'create', name: 'Char Test', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
    const hostMsg = await hostPromise;
    if (hostMsg.type !== 'room-joined') throw new Error('Expected room-joined');

    const player = await connectWs();
    const playerJoin = waitForMsg(player, 'room-joined');
    sendMsg(player, { type: 'join', joinCode: hostMsg.joinCode, playerName: 'CharPlayer' });
    await playerJoin;
    await waitForMsg(host, 'player-joined');

    const charDef: CharacterDefinition = {
      name: 'Sigmund the Bold',
      highConcept: 'Reformed Thief',
      trouble: "Can't Resist a Locked Door",
      aspects: ['Quick Hands', 'Loyal to a Fault'],
      personality: 'Cautious but impulsive',
      backstory: 'Born in the slums of Veridian.',
      skills: { Notice: 2, Fight: 1, Stealth: 1 },
      stunts: ['Lockpicker Supreme'],
    };

    const validationPromise = waitForMsg(player, 'character-validated');
    sendMsg(player, { type: 'submit-character', definition: charDef });
    const validationMsg = await validationPromise;

    expect(validationMsg.type).toBe('character-validated');
    if (validationMsg.type === 'character-validated') {
      expect(validationMsg.approved).toBe(true);
      expect(validationMsg.characterId).toBeTruthy();
    }

    const submittedMsg = await waitForMsg(host, 'character-submitted');
    expect(submittedMsg.type).toBe('character-submitted');
    if (submittedMsg.type === 'character-submitted') {
      expect(submittedMsg.definition.name).toBe('Sigmund the Bold');
      expect(submittedMsg.definition.highConcept).toBe('Reformed Thief');
    }

    host.close();
    player.close();
  });

  it('submits multiple characters in sequence (batch paste flow)', async () => {
    const host = await connectWs();
    const hostPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, { type: 'create', name: 'Batch Test', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
    const hostMsg = await hostPromise;
    if (hostMsg.type !== 'room-joined') throw new Error('Expected room-joined');

    const player = await connectWs();
    const playerJoin = waitForMsg(player, 'room-joined');
    sendMsg(player, { type: 'join', joinCode: hostMsg.joinCode, playerName: 'BatchPlayer' });
    await playerJoin;
    await waitForMsg(host, 'player-joined');

    const chars: CharacterDefinition[] = [
      { name: 'Kael Stormbreaker', highConcept: 'Dwarven War Priest', trouble: 'Haunted by Fallen Comrades', aspects: ['Shield of the Mountain'], personality: 'Gruff but loyal', backstory: 'A veteran of the deep wars.', skills: { Fight: 4, Will: 3 }, stunts: [] },
      { name: 'Lyra Silvertongue', highConcept: 'Half-Elf Spy', trouble: 'Too Many Secrets', aspects: ['Silver Tongue'], personality: 'Charming and evasive', backstory: 'No one knows her real name.', skills: { Deceive: 4, Rapport: 3 }, stunts: [] },
      { name: 'Grunk', highConcept: 'Barbarian Berserker', trouble: 'Sees Red', aspects: ['Unstoppable'], personality: 'Simple and direct', backstory: 'Raised by wolves.', skills: { Fight: 3, Physique: 3 }, stunts: [] },
    ];

    const allMsgs = collectMsgs(player, 6, 10_000);
    for (const def of chars) {
      sendMsg(player, { type: 'submit-character', definition: def });
    }
    const results = await allMsgs;

    const validated = results.filter(m => m.type === 'character-validated');
    expect(validated).toHaveLength(3);
    for (const v of validated) {
      if (v.type === 'character-validated') {
        expect(v.approved).toBe(true);
      }
    }

    const submitted = results.filter(m => m.type === 'character-submitted');
    expect(submitted).toHaveLength(3);
    const names = submitted.map(m => m.type === 'character-submitted' ? m.definition.name : '');
    expect(names).toContain('Kael Stormbreaker');
    expect(names).toContain('Lyra Silvertongue');
    expect(names).toContain('Grunk');

    host.close();
    player.close();
  });

  it('persists character to database on approval', async () => {
    const host = await connectWs();
    const hostPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, { type: 'create', name: 'DB Char Test', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
    const hostMsg = await hostPromise;
    if (hostMsg.type !== 'room-joined') throw new Error('Expected room-joined');

    const player = await connectWs();
    const playerJoin = waitForMsg(player, 'room-joined');
    sendMsg(player, { type: 'join', joinCode: hostMsg.joinCode, playerName: 'DBPlayer' });
    await playerJoin;
    await waitForMsg(host, 'player-joined');

    const charDef: CharacterDefinition = {
      name: 'Test Char',
      highConcept: 'Test Concept',
      trouble: 'Test Trouble',
      aspects: [],
      personality: '',
      backstory: '',
      skills: { Notice: 2 },
      stunts: [],
    };

    const validationPromise = waitForMsg(player, 'character-validated');
    sendMsg(player, { type: 'submit-character', definition: charDef });
    const validationMsg = await validationPromise;

    if (validationMsg.type !== 'character-validated') throw new Error('Expected character-validated');
    expect(validationMsg.approved).toBe(true);

    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(validationMsg.characterId) as any;
    expect(row).toBeTruthy();
    const storedDef = JSON.parse(row.definition);
    expect(storedDef.name).toBe('Test Char');
    expect(storedDef.highConcept).toBe('Test Concept');
    const storedState = JSON.parse(row.state);
    expect(storedState.fatePoints).toBe(3);
    expect(storedState.whisperTrust).toBe(0.5);

    host.close();
    player.close();
  });
});
