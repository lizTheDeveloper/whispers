import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getFreePort } from './lib/ws-helpers.js';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';
import type { CharacterDefinition } from '../src/shared/types.js';

const LLM_PROXY_URL = process.env.LLM_PROXY_URL;
const describeIfLive = LLM_PROXY_URL ? describe : describe.skip;

let serverProcess: ReturnType<typeof import('node:child_process').fork> | null = null;
let port: number;
const allServerLogs: string[] = [];

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 10_000);
  });
}

function sendMsg(ws: WebSocket, msg: ClientMessage): void {
  ws.send(JSON.stringify(msg));
}

function waitForMsg(ws: WebSocket, type: string, timeoutMs = 90_000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type} after ${timeoutMs}ms`)), timeoutMs);
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

function waitForAnyMsg(ws: WebSocket, types: string[], timeoutMs = 90_000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for any of [${types.join(',')}] after ${timeoutMs}ms`)), timeoutMs);
    const handler = (data: Buffer) => {
      const msg: ServerMessage = JSON.parse(data.toString());
      if (types.includes(msg.type)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

async function completeDmSetup(ws: WebSocket): Promise<void> {
  await waitForMsg(ws, 'dm-settings');
  await waitForMsg(ws, 'dm-chat-reply');

  const followUps = [
    'Use FATE Core. A rescue mission in a collapsed mine. One player. No house rules.',
    'Yes, everything is decided. Start the game now. We are ready.',
    'Confirmed. Lock it in. Done.',
  ];

  for (const text of followUps) {
    const replyPromise = waitForMsg(ws, 'dm-chat-reply', 90_000);
    sendMsg(ws, { type: 'dm-chat', text });
    const reply = await replyPromise;
    if (reply.type === 'dm-chat-reply' && reply.done) return;
  }
  throw new Error('DM setup did not complete after all follow-ups');
}

const rescuerDef: CharacterDefinition = {
  name: 'Garrick Stoneheart',
  highConcept: 'Veteran Mine Foreman',
  trouble: 'Lost a Crew Before',
  aspects: ['I Know These Tunnels', 'Stubborn as Granite', 'Owes Elder Maren a Debt'],
  personality: 'Practical, gruff, deeply protective of miners. Blames himself for past failures.',
  backstory: 'Garrick has worked the mines around Thornhaven for twenty years.',
  skills: { Notice: 4, Physique: 3, Athletics: 3, Crafts: 2, Will: 2, Fight: 2, Empathy: 1, Investigate: 1, Rapport: 1, Stealth: 1 },
  stunts: ['Underground Sense: +2 to Notice when navigating or detecting danger underground'],
};

beforeAll(async () => {
  if (!LLM_PROXY_URL) return;
  const { fork } = await import('node:child_process');
  const { resolve } = await import('node:path');

  port = await getFreePort();

  serverProcess = fork(
    resolve(import.meta.dirname, '../node_modules/.bin/tsx'),
    [resolve(import.meta.dirname, '../src/server/index.ts')],
    {
      env: { ...process.env, PORT: String(port), LLM_PROXY_URL },
      stdio: 'pipe',
    },
  );

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start')), 15_000);
    serverProcess!.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      allServerLogs.push(line);
      if (line.includes('listening on port')) { clearTimeout(timeout); resolve(); }
    });
    serverProcess!.stderr?.on('data', (data: Buffer) => {
      allServerLogs.push(`[stderr] ${data.toString().trim()}`);
    });
    serverProcess!.on('error', reject);
  });
}, 20_000);

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      serverProcess!.on('exit', () => resolve());
      setTimeout(resolve, 3000);
    });
  }
  if (allServerLogs.length > 0) {
    console.log('\n=== SERVER LOGS ===');
    allServerLogs.slice(-30).forEach(l => console.log(l));
  }
});

describeIfLive('Scenario Seeding: Collapsed Mine', () => {
  it('seeds scenario NPCs/locations into world bible and DM references them', async () => {
    const findings: string[] = [];

    // ---- Create room WITH scenario ----
    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Scenario Seed Test',
      dmPreset: 'chronicler',
      scenarioId: 'collapsed-mine',
      systemId: 'fate-core',
      houseRules: null,
    });
    const roomMsg = await roomPromise;
    expect(roomMsg.type).toBe('room-joined');
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;
    console.log(`[scenario] Room created with collapsed-mine scenario, code: ${joinCode}`);

    // ---- DM setup ----
    await completeDmSetup(host);
    console.log('[scenario] DM setup complete');

    // ---- Player joins + character submit ----
    const player = await connectWs();
    const pJoin = waitForMsg(player, 'room-joined');
    sendMsg(player, { type: 'join', joinCode, playerName: 'Rescuer' });
    await pJoin;
    await waitForMsg(host, 'player-joined');

    let charId = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const valPromise = waitForMsg(player, 'character-validated', 90_000);
      sendMsg(player, { type: 'submit-character', definition: rescuerDef });
      const valMsg = await valPromise;
      if (valMsg.type === 'character-validated' && valMsg.approved) {
        charId = valMsg.characterId;
        break;
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
    expect(charId).not.toBe('');
    console.log(`[scenario] Character approved: ${charId}`);

    // Approve character
    await waitForMsg(host, 'negotiation-opened', 30_000);
    await waitForMsg(host, 'negotiation-message', 90_000);
    sendMsg(host, { type: 'host-approve-character', characterId: charId });
    console.log('[scenario] Character host-approved');

    // ---- Start game ----
    sendMsg(host, { type: 'start-game' });
    const phase = await waitForMsg(player, 'phase-change', 10_000);
    expect(phase.type === 'phase-change' && phase.phase).toBe('playing');
    console.log('[scenario] Game started');

    // ---- Collect narrations over 5 turns ----
    const allNarrations: string[] = [];
    const SCENARIO_KEYWORDS = ['thornhaven', 'mine', 'maren', 'tobias', 'ventilation', 'shaft', 'miner', 'collapse', 'silver', 'hill'];

    const firstNarration = await waitForMsg(player, 'narration', 120_000);
    if (firstNarration.type === 'narration') {
      console.log(`[scenario] Narration 1: "${firstNarration.text.slice(0, 120)}..."`);
      allNarrations.push(firstNarration.text.toLowerCase());
    }

    for (let turn = 0; turn < 5; turn++) {
      console.log(`\n[scenario] === Turn ${turn + 1} ===`);
      try {
        // Auto-whisper
        let whisperSent = false;
        const autoWhisper = (data: Buffer) => {
          try {
            const msg: ServerMessage = JSON.parse(data.toString());
            if (msg.type === 'whisper-prompt' && !whisperSent) {
              whisperSent = true;
              sendMsg(player, { type: 'whisper', text: 'Find the ventilation shaft and check on the trapped miners.' });
            }
          } catch {}
        };
        player.on('message', autoWhisper);

        const nextEvent = await waitForAnyMsg(player, ['action-proposals', 'narration', 'scene-end'], 120_000);

        if (nextEvent.type === 'narration') {
          console.log(`[scenario]   Narration: "${nextEvent.text.slice(0, 100)}..."`);
          allNarrations.push(nextEvent.text.toLowerCase());
          const afterNarration = await waitForAnyMsg(player, ['action-proposals', 'scene-end'], 120_000);
          if (afterNarration.type === 'scene-end') {
            console.log(`[scenario]   Scene ended`);
            player.off('message', autoWhisper);
            const nextNarr = await waitForMsg(player, 'narration', 120_000);
            if (nextNarr.type === 'narration') allNarrations.push(nextNarr.text.toLowerCase());
            continue;
          }
        } else if (nextEvent.type === 'action-proposals') {
          const ap = nextEvent as any;
          console.log(`[scenario]   Proposals: ${ap.actions?.length} actions`);
        } else if (nextEvent.type === 'scene-end') {
          console.log(`[scenario]   Scene ended`);
          player.off('message', autoWhisper);
          const nextNarr = await waitForMsg(player, 'narration', 120_000);
          if (nextNarr.type === 'narration') allNarrations.push(nextNarr.text.toLowerCase());
          continue;
        }

        // Wait for action + resolution
        const action = await waitForMsg(player, 'action-taken', 120_000);
        if (action.type === 'action-taken') {
          console.log(`[scenario]   Action: "${action.action.slice(0, 80)}"`);
        }

        await waitForMsg(player, 'dice-roll', 60_000);
        const resolution = await waitForMsg(player, 'resolution', 120_000);
        if (resolution.type === 'resolution') {
          console.log(`[scenario]   Resolution: "${resolution.text.slice(0, 80)}..."`);
          allNarrations.push(resolution.text.toLowerCase());
        }

        player.off('message', autoWhisper);
      } catch (e: any) {
        console.error(`[scenario]   Turn ${turn + 1} failed: ${e.message}`);
        findings.push(`BUG: Turn ${turn + 1} failed: ${e.message}`);
        break;
      }
    }

    // ---- End game ----
    sendMsg(host, { type: 'end-game' });
    await waitForMsg(player, 'phase-change', 10_000);

    // ---- Analysis ----
    console.log('\n=== SCENARIO SEEDING ANALYSIS ===');

    // Check server logs for seeding
    const seedLogs = allServerLogs.filter(l => l.includes('Seeded scenario'));
    console.log(`Seed logs: ${seedLogs.length}`);
    seedLogs.forEach(l => console.log(`  ${l}`));
    if (seedLogs.length === 0) {
      findings.push('BUG: No "Seeded scenario" log found — scenario was not loaded');
    }

    // Check narrations for scenario keywords
    const allText = allNarrations.join(' ');
    const foundKeywords: string[] = [];
    const missingKeywords: string[] = [];
    for (const kw of SCENARIO_KEYWORDS) {
      if (allText.includes(kw)) {
        foundKeywords.push(kw);
      } else {
        missingKeywords.push(kw);
      }
    }

    console.log(`\nScenario keywords found in narrations: [${foundKeywords.join(', ')}]`);
    console.log(`Scenario keywords missing: [${missingKeywords.join(', ')}]`);
    console.log(`Total narration text length: ${allText.length} chars`);

    if (foundKeywords.length < 3) {
      findings.push(`ISSUE: Only ${foundKeywords.length}/10 scenario keywords appeared in narrations — DM may not be using seeded world data`);
    } else {
      console.log(`Scenario integration confirmed: ${foundKeywords.length}/10 keywords present`);
    }

    console.log(`\nFindings: ${findings.length === 0 ? 'None!' : ''}`);
    findings.forEach(f => console.log(`  - ${f}`));

    expect(seedLogs.length).toBeGreaterThanOrEqual(1);
    expect(foundKeywords.length).toBeGreaterThanOrEqual(2);

    host.close();
    player.close();
  }, 600_000);
});
