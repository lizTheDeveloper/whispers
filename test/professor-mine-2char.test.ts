import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
    'Use FATE Core. Dungeon crawl in an abandoned mine with rescue mission. Two players. No house rules.',
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

beforeAll(async () => {
  if (!LLM_PROXY_URL) return;
  const { fork } = await import('node:child_process');
  const { resolve } = await import('node:path');
  port = 4200 + Math.floor(Math.random() * 50);
  serverProcess = fork(
    resolve(import.meta.dirname, '../node_modules/.bin/tsx'),
    [resolve(import.meta.dirname, '../src/server/index.ts')],
    { env: { ...process.env, PORT: String(port), LLM_PROXY_URL }, stdio: 'pipe' },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start')), 15_000);
    serverProcess!.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      allServerLogs.push(line);
      if (line.includes('listening on port')) { clearTimeout(timeout); resolve(); }
    });
    serverProcess!.stderr?.on('data', (data: Buffer) => { allServerLogs.push(`[stderr] ${data.toString().trim()}`); });
    serverProcess!.on('error', reject);
  });
}, 20_000);

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    await new Promise<void>((resolve) => { serverProcess!.on('exit', () => resolve()); setTimeout(resolve, 3000); });
  }
  if (allServerLogs.length > 0) {
    console.log('\n=== SERVER LOGS ===');
    allServerLogs.slice(-60).forEach(l => console.log(l));
  }
});

describeIfLive('Professor + Collapsed Mine: 2-Character Rescue Mission', () => {
  it('runs 25 turns with exploration, NPC encounters, item usage, and professor teaching asides', async () => {
    const findings: string[] = [];

    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Professor Mine Playtest',
      dmPreset: 'professor',
      scenarioId: 'collapsed-mine',
      systemId: 'fate-core',
      houseRules: null,
    });
    const roomMsg = await roomPromise;
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;

    await completeDmSetup(host);

    const p1 = await connectWs();
    const p2 = await connectWs();
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Scout' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'Healer' });
    await Promise.all([waitForMsg(p1, 'room-joined'), waitForMsg(p2, 'room-joined')]);

    const scout: CharacterDefinition = {
      name: 'Kael Ashwood',
      highConcept: 'Wilderness Tracker Who Reads The Land Like A Book',
      trouble: 'I Trust The Forest More Than People',
      aspects: ['Sharp Eyes Miss Nothing', 'Every Trail Tells A Story', 'The Wild Keeps Its Own Counsel'],
      personality: 'Quiet, observant, distrustful of authority. Speaks through actions more than words.',
      backstory: 'Raised by a trapper after being abandoned as a child. Found by the village but never fully joined it.',
      skills: { Notice: 4, Athletics: 3, Stealth: 3, Survival: 2, Fight: 2, Will: 1, Investigate: 1, Rapport: 0 },
      stunts: ['Keen Eyes: +2 to Notice in natural environments', 'Sure-Footed: +2 to Athletics when climbing or traversing rough terrain'],
    };

    const healer: CharacterDefinition = {
      name: 'Sister Wren Holloway',
      highConcept: 'Field Medic With An Unbreakable Oath',
      trouble: 'I Cannot Turn Away From Suffering',
      aspects: ['Steady Hands In A Crisis', 'The Oath Binds Me To All Who Bleed', 'I Have Seen What Fear Does To Good People'],
      personality: 'Compassionate but pragmatic. Unflinching in the face of injury, but haunted by those she could not save.',
      backstory: 'Former military medic who left the army after a massacre she could not prevent. Now serves the village.',
      skills: { Empathy: 4, Lore: 3, Will: 3, Rapport: 2, Notice: 2, Investigate: 1, Athletics: 1, Fight: 0 },
      stunts: ['Combat Medic: +2 to Empathy when stabilizing a wounded person', 'Iron Nerve: +2 to Will when facing disturbing or terrifying sights'],
    };

    const charP = waitForMsg(host, 'characters-confirmed', 120_000);
    sendMsg(p1, { type: 'submit-character', definition: scout });
    sendMsg(p2, { type: 'submit-character', definition: healer });
    await charP;

    const startP = waitForMsg(host, 'phase-change');
    sendMsg(host, { type: 'start-game' });
    await startP;
    console.log('[mine] Game started');

    const narrations: string[] = [];
    const actionsTaken: Array<{ char: string; action: string; turn: number }> = [];
    const locations = new Set<string>();
    let sceneCount = 0;
    let turnCount = 0;
    let teachingAsides = 0;
    let compelCount = 0;
    let itemMentions = 0;

    const TARGET_TURNS = 25;

    const whisperPlan: Record<number, Record<string, string>> = {
      1: { 'Kael Ashwood': 'Look for the ventilation shaft — the map Tobias drew might help' },
      3: { 'Sister Wren Holloway': 'Talk to Tobias — he saw something in the dark. Be gentle.' },
      5: { 'Kael Ashwood': 'Something is off about Foreman Greaves — press him about his burns' },
      7: { 'Sister Wren Holloway': 'The crystals are dangerous — do NOT touch them, just observe' },
      9: { 'Kael Ashwood': 'Go deeper. The miners might still be alive past the collapse.' },
      11: { 'Sister Wren Holloway': 'Use the crystal shard — it might react to the cavern walls' },
      13: { 'Kael Ashwood': 'The Pale Woman is not your enemy. Approach carefully.' },
      15: { 'Sister Wren Holloway': 'Save the miners first. The mystery can wait.', 'Kael Ashwood': 'Forget the miners — this discovery is bigger than a rescue' },
      18: { 'Kael Ashwood': 'Trust Wren. She sees things you miss about people.' },
      20: { 'Sister Wren Holloway': 'Greaves caused this collapse. Confront him before he runs.' },
      23: { 'Kael Ashwood': 'The forest has always protected you. Let it guide you out.' },
    };

    for (let turn = 1; turn <= TARGET_TURNS; turn++) {
      try {
        const narMsg = await waitForAnyMsg(host, ['narration', 'phase-change'], 120_000);
        if (narMsg.type === 'phase-change') {
          if ((narMsg as any).phase === 'ended') { console.log(`[mine] Game ended at turn ${turn}`); break; }
          continue;
        }
        narrations.push(narMsg.text);
        if ((narMsg as any).locationName) locations.add((narMsg as any).locationName);
        turnCount = turn;

        if (narMsg.text.includes('Compel:') || narMsg.text.includes('trouble')) compelCount++;

        const next = await waitForAnyMsg(host, ['action-proposals', 'scene-end', 'phase-change'], 120_000);
        if (next.type === 'scene-end') {
          sceneCount++;
          console.log(`[mine] Scene ${sceneCount} ended at turn ${turn}`);
          continue;
        }
        if (next.type === 'phase-change') { if ((next as any).phase === 'ended') break; continue; }
        if (next.type !== 'action-proposals') continue;

        const charName = (next as any).characterName as string;
        const whisper = whisperPlan[turn]?.[charName];

        await waitForMsg(host, 'whisper-prompt', 30_000);
        if (whisper) {
          sendMsg(host, { type: 'whisper', text: whisper });
          console.log(`[mine] T${turn} whispered to ${charName.split(' ')[0]}: "${whisper.slice(0, 50)}"`);
        }

        const actionMsg = await waitForMsg(host, 'action-taken', 120_000);
        if (actionMsg.type === 'action-taken') {
          actionsTaken.push({ char: (actionMsg as any).characterName, action: (actionMsg as any).action, turn });
        }

        const resMsg = await waitForAnyMsg(host, ['narration', 'resolution', 'scene-end', 'phase-change'], 120_000);
        if (resMsg.type === 'narration' || resMsg.type === 'resolution') {
          const text = resMsg.text ?? '';
          narrations.push(text);
          if (/\([^)]*\+\d+[^)]*vs[^)]*\+\d+[^)]*\)/.test(text)) teachingAsides++;
          const itemNames = ['lantern', 'map', 'crystal', 'shard', 'journal', 'blueprint'];
          if (itemNames.some(n => text.toLowerCase().includes(n))) itemMentions++;
        }
        if (resMsg.type === 'scene-end') {
          sceneCount++;
          console.log(`[mine] Scene ${sceneCount} ended at turn ${turn}`);
        }

        await waitForAnyMsg(host, ['character-state-update', 'narration', 'action-proposals', 'scene-end', 'phase-change'], 30_000).catch(() => null);

        if (turn % 5 === 0) {
          console.log(`[mine] Turn ${turn} — ${sceneCount} scenes, ${locations.size} locs, ${teachingAsides} asides, ${itemMentions} items`);
        }
      } catch (e) {
        findings.push(`Turn ${turn}: ${(e as Error).message}`);
        console.error(`[mine] Turn ${turn} error:`, (e as Error).message);
        if (turn < 3) throw e;
      }
    }

    console.log(`\n[mine] === RESULTS ===`);
    console.log(`[mine] Turns: ${turnCount}/${TARGET_TURNS}`);
    console.log(`[mine] Scenes: ${sceneCount}`);
    console.log(`[mine] Locations: ${[...locations].join(', ')}`);
    console.log(`[mine] Teaching asides: ${teachingAsides}`);
    console.log(`[mine] Item mentions: ${itemMentions}`);
    console.log(`[mine] Compels: ${compelCount}`);

    const npcMentions: Record<string, number> = { maren: 0, tobias: 0, greaves: 0, 'pale woman': 0, foreman: 0, elder: 0 };
    const allText = narrations.join(' ').toLowerCase();
    for (const key of Object.keys(npcMentions)) {
      npcMentions[key] = (allText.match(new RegExp(key, 'gi')) ?? []).length;
    }
    console.log(`[mine] NPCs: ${JSON.stringify(npcMentions)}`);

    const mineLocations = ['thornhaven', 'mine entrance', 'ventilation shaft', 'upper tunnels', 'collapse zone', 'deep excavation', 'crystal chamber'];
    const visitedMine = mineLocations.filter(l => [...locations].some(v => v.toLowerCase().includes(l.split(' ')[0]!)));
    console.log(`[mine] Mine locations visited: ${visitedMine.join(', ')} (${visitedMine.length}/${mineLocations.length})`);

    if (findings.length > 0) console.log(`[mine] Findings: ${findings.join('; ')}`);

    expect(turnCount).toBeGreaterThanOrEqual(8);
    expect(sceneCount).toBeGreaterThanOrEqual(2);
    expect(locations.size).toBeGreaterThanOrEqual(2);

  }, 900_000);
});
