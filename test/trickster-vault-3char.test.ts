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
    'Use FATE Core. Heist scenario in a clockwork vault. Three players. No house rules.',
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

  port = 4100 + Math.floor(Math.random() * 50);

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
      const line = data.toString().trim();
      allServerLogs.push(`[stderr] ${line}`);
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
    allServerLogs.slice(-80).forEach(l => console.log(l));
  }
});

describeIfLive('Trickster + Clockwork Vault: 3-Character Extended Heist', () => {
  it('runs a 30-turn 3-character heist with phased whispers, stress management, and location progression', async () => {
    const findings: string[] = [];

    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Trickster Vault 3-Char Playtest',
      dmPreset: 'trickster',
      scenarioId: 'clockwork-vault',
      systemId: 'fate-core',
      houseRules: null,
    });
    const roomMsg = await roomPromise;
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;
    console.log(`[vault] Room created, join code: ${joinCode}`);

    await completeDmSetup(host);
    console.log('[vault] DM setup complete');

    const p1 = await connectWs();
    const p2 = await connectWs();
    const p3 = await connectWs();
    const p1Join = waitForMsg(p1, 'room-joined');
    const p2Join = waitForMsg(p2, 'room-joined');
    const p3Join = waitForMsg(p3, 'room-joined');
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Thief' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'Tinker' });
    sendMsg(p3, { type: 'join', joinCode, playerName: 'Face' });
    await Promise.all([p1Join, p2Join, p3Join]);
    console.log('[vault] All 3 players joined');

    const thief: CharacterDefinition = {
      name: 'Rook Blackthorn',
      highConcept: 'Master Thief With A Code Of Honor',
      trouble: 'The Last Job Is Never The Last',
      aspects: ['Silent As A Shadow', 'I Never Leave A Partner Behind', 'Every Lock Has A Weakness'],
      personality: 'Cool, professional, protective of the team but haunted by a job gone wrong',
      backstory: 'Former Guild member exiled for refusing to steal from a hospital. Now freelance, taking jobs to fund a clinic.',
      skills: { Stealth: 4, Athletics: 3, Burglary: 3, Notice: 2, Fight: 2, Will: 1, Contacts: 1, Provoke: 0 },
      stunts: ['Shadow Step: +2 to Stealth when moving through dim lighting', 'Trapfinder: +2 to Notice for detecting mechanical traps'],
    };

    const tinker: CharacterDefinition = {
      name: 'Pip Gearsoul',
      highConcept: 'Clockwork Savant Who Talks To Machines',
      trouble: 'Curiosity Kills More Than Cats',
      aspects: ['If It Ticks I Can Fix It', 'The Blueprint Is In My Head', 'Grease Under My Fingernails'],
      personality: 'Enthusiastic, easily distracted by interesting mechanisms, talks too much when excited',
      backstory: 'Self-taught mechanic raised in a junkyard. Thinks machines are more trustworthy than people.',
      skills: { Crafts: 4, Lore: 3, Investigate: 3, Notice: 2, Athletics: 2, Will: 1, Stealth: 1, Rapport: 0 },
      stunts: ['Mechanical Empathy: +2 to Crafts when disabling clockwork devices', 'Quick Study: +2 to Lore when analyzing unfamiliar mechanisms'],
    };

    const face: CharacterDefinition = {
      name: 'Vivienne Lux',
      highConcept: 'Con Artist Who Became The Mask',
      trouble: 'Nobody Knows The Real Me',
      aspects: ['A Smile That Opens Doors', 'I Collect Secrets Like Others Collect Art', 'When In Doubt, Improvise'],
      personality: 'Charming, manipulative, secretly lonely, plays roles so well she forgets which one is real',
      backstory: 'Daughter of minor nobility, disowned after a scandal. Reinvented herself so many times she lost count.',
      skills: { Deceive: 4, Rapport: 3, Empathy: 3, Contacts: 2, Will: 2, Notice: 1, Stealth: 1, Athletics: 0 },
      stunts: ['Master of Disguise: +2 to Deceive when impersonating someone', 'Read The Room: +2 to Empathy when first entering a social situation'],
    };

    const charP1 = waitForMsg(host, 'characters-confirmed', 120_000);
    sendMsg(p1, { type: 'submit-character', definition: thief });
    sendMsg(p2, { type: 'submit-character', definition: tinker });
    sendMsg(p3, { type: 'submit-character', definition: face });
    await charP1;
    console.log('[vault] Characters confirmed');

    const startP = waitForMsg(host, 'phase-change');
    sendMsg(host, { type: 'start-game' });
    const startMsg = await startP;
    expect(startMsg.type).toBe('phase-change');
    console.log('[vault] Game started');

    const narrations: string[] = [];
    const actionsTaken: Array<{ char: string; action: string; turn: number }> = [];
    const trustHistory: Record<string, number[]> = { 'Rook Blackthorn': [], 'Pip Gearsoul': [], 'Vivienne Lux': [] };
    const locations = new Set<string>();
    let sceneCount = 0;
    let turnCount = 0;
    let stressEvents = 0;
    let compelCount = 0;
    let invokeCount = 0;

    const TARGET_TURNS = 30;

    const whisperPlan: Record<number, Record<string, string>> = {
      1: { 'Rook Blackthorn': 'Check the blueprint for trap locations before proceeding' },
      2: { 'Pip Gearsoul': 'That gear mechanism looks important — examine it closely' },
      3: { 'Vivienne Lux': 'Distract the Guildmaster while the others slip away' },
      5: { 'Rook Blackthorn': 'Something is wrong — trust your instincts and pull back' },
      6: { 'Pip Gearsoul': 'The automaton has a pattern — count the seconds between passes' },
      8: { 'Vivienne Lux': 'Lady Ashworth is offering a better deal — hear her out' },
      10: { 'Rook Blackthorn': 'Betray the tinker and take the Orrery for yourself', 'Pip Gearsoul': 'Rook is acting strange — watch your back' },
      12: { 'Vivienne Lux': 'Drop the disguise and tell the truth for once' },
      15: { 'Rook Blackthorn': 'The vault is about to shift — grab Pip and run', 'Pip Gearsoul': 'Ignore the danger and study the mechanism — this is your only chance' },
      18: { 'Vivienne Lux': 'The Guildmaster knows — you need to improvise NOW' },
      20: { 'Rook Blackthorn': 'Leave no one behind — go back for Vivienne' },
      22: { 'Pip Gearsoul': 'The Orrery is more than a device — it knows things. Listen to it.' },
      25: { 'Rook Blackthorn': 'This IS the last job. Make it count.', 'Vivienne Lux': 'Show them who you really are' },
      28: { 'Pip Gearsoul': 'Break the Orrery rather than let anyone have it', 'Rook Blackthorn': 'Protect the team — let the Orrery go' },
    };

    for (let turn = 1; turn <= TARGET_TURNS; turn++) {
      try {
        const narMsg = await waitForAnyMsg(host, ['narration', 'phase-change'], 120_000);
        if (narMsg.type === 'phase-change') {
          if ((narMsg as any).phase === 'ended') {
            console.log(`[vault] Game ended at turn ${turn}`);
            break;
          }
          continue;
        }
        if (narMsg.type !== 'narration') continue;
        narrations.push(narMsg.text);
        if ((narMsg as any).locationName) locations.add((narMsg as any).locationName);
        turnCount = turn;

        if (narMsg.text.includes('Compel:') || narMsg.text.includes('trouble')) compelCount++;

        const sceneEndMsg = await waitForAnyMsg(host, ['action-proposals', 'scene-end', 'phase-change'], 120_000);
        if (sceneEndMsg.type === 'scene-end') {
          sceneCount++;
          console.log(`[vault] Scene ${sceneCount} ended at turn ${turn}: ${(sceneEndMsg as any).summary?.slice(0, 80)}`);
          continue;
        }
        if (sceneEndMsg.type === 'phase-change') {
          if ((sceneEndMsg as any).phase === 'ended') break;
          continue;
        }
        if (sceneEndMsg.type !== 'action-proposals') continue;

        const charName = (sceneEndMsg as any).characterName as string;
        const whisperForChar = whisperPlan[turn]?.[charName];

        await waitForMsg(host, 'whisper-prompt', 30_000);

        if (whisperForChar) {
          sendMsg(host, { type: 'whisper', text: whisperForChar });
          console.log(`[vault] T${turn} whispered to ${charName.split(' ')[0]}: "${whisperForChar.slice(0, 50)}"`);
        }

        const actionMsg = await waitForMsg(host, 'action-taken', 120_000);
        if (actionMsg.type === 'action-taken') {
          actionsTaken.push({ char: (actionMsg as any).characterName, action: (actionMsg as any).action, turn });
          const inf = (actionMsg as any).whisperInfluence;
          if (whisperForChar && inf) {
            console.log(`[vault] T${turn} ${charName.split(' ')[0]}: ${inf} — "${(actionMsg as any).action.slice(0, 60)}"`);
          }
        }

        const resMsg = await waitForAnyMsg(host, ['narration', 'resolution', 'scene-end', 'phase-change'], 120_000);
        if (resMsg.type === 'narration' || resMsg.type === 'resolution') {
          const text = resMsg.text ?? '';
          narrations.push(text);
          if (text.includes('invoke') || text.includes('draws on') || text.includes('channels')) invokeCount++;
          if (text.includes('stress') || text.includes('Stress')) stressEvents++;
        }
        if (resMsg.type === 'scene-end') {
          sceneCount++;
          console.log(`[vault] Scene ${sceneCount} ended at turn ${turn}`);
        }

        const stateMsg = await waitForAnyMsg(host, ['character-state-update', 'narration', 'action-proposals', 'scene-end', 'phase-change'], 30_000).catch(() => null);
        if (stateMsg?.type === 'character-state-update') {
          const st = (stateMsg as any).state;
          if (st?.whisperTrust !== undefined && charName) {
            trustHistory[charName]?.push(st.whisperTrust);
          }
        }

        if (turn % 5 === 0) {
          console.log(`[vault] Turn ${turn} complete — ${sceneCount} scenes, ${locations.size} locations, ${compelCount} compels, ${invokeCount} invokes`);
        }
      } catch (e) {
        console.error(`[vault] Turn ${turn} error:`, (e as Error).message);
        findings.push(`Turn ${turn} error: ${(e as Error).message}`);
        if (turn < 5) throw e;
      }
    }

    console.log(`\n[vault] === PLAYTEST RESULTS ===`);
    console.log(`[vault] Turns: ${turnCount}/${TARGET_TURNS}`);
    console.log(`[vault] Scenes: ${sceneCount}`);
    console.log(`[vault] Locations: ${[...locations].join(', ')}`);
    console.log(`[vault] Actions: ${actionsTaken.length}`);
    console.log(`[vault] Compels: ${compelCount}`);
    console.log(`[vault] Invokes: ${invokeCount}`);
    console.log(`[vault] Stress events: ${stressEvents}`);

    const npcMentions = {
      sparks: 0, vex: 0, ashworth: 0, cogsworth: 0, guildmaster: 0, orrery: 0,
    };
    const allText = narrations.join(' ').toLowerCase();
    for (const key of Object.keys(npcMentions) as Array<keyof typeof npcMentions>) {
      npcMentions[key] = (allText.match(new RegExp(key, 'gi')) ?? []).length;
    }
    console.log(`[vault] NPC mentions: ${JSON.stringify(npcMentions)}`);

    for (const [name, hist] of Object.entries(trustHistory)) {
      if (hist.length > 0) {
        console.log(`[vault] Trust ${name.split(' ')[0]}: ${hist.map(t => t.toFixed(2)).join(' → ')}`);
      }
    }

    if (findings.length > 0) {
      console.log(`[vault] Findings: ${findings.join('; ')}`);
    }

    expect(turnCount).toBeGreaterThanOrEqual(10);
    expect(sceneCount).toBeGreaterThanOrEqual(2);

    const scenarioNpcs = ['sparks', 'vex', 'guildmaster', 'ashworth', 'cogsworth', 'orrery'];
    const referencedNpcs = scenarioNpcs.filter(n => npcMentions[n as keyof typeof npcMentions] > 0);
    console.log(`[vault] NPCs referenced: ${referencedNpcs.join(', ')} (${referencedNpcs.length}/${scenarioNpcs.length})`);
    expect(referencedNpcs.length).toBeGreaterThanOrEqual(2);

    expect(locations.size).toBeGreaterThanOrEqual(2);
    expect(actionsTaken.length).toBeGreaterThanOrEqual(8);

  }, 1_200_000);
});
