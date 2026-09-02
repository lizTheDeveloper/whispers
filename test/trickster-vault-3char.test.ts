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
  it('runs a 3-character heist with phased whispers and companion dynamics', async () => {
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

    const charDefs: Array<[WebSocket, CharacterDefinition, string]> = [
      [p1, thief, 'thief'], [p2, tinker, 'tinker'], [p3, face, 'face'],
    ];
    for (const [player, def, label] of charDefs) {
      let approved = false;
      let charId = '';
      for (let attempt = 0; attempt < 3 && !approved; attempt++) {
        const valPromise = waitForMsg(player, 'character-validated', 90_000);
        sendMsg(player, { type: 'submit-character', definition: def });
        const valMsg = await valPromise;
        if (valMsg.type === 'character-validated' && valMsg.approved) {
          charId = valMsg.characterId;
          approved = true;
          console.log(`[vault] ${label} AI-approved: ${charId}`);
        } else {
          console.log(`[vault] ${label} validation attempt ${attempt + 1} failed`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!approved) throw new Error(`${label} never approved after 3 attempts`);
      await waitForMsg(host, 'negotiation-opened', 30_000);
      await waitForMsg(host, 'negotiation-message', 90_000);
      sendMsg(host, { type: 'host-approve-character', characterId: charId });
      console.log(`[vault] Host approved ${label}`);
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('[vault] All characters confirmed');

    sendMsg(host, { type: 'start-game' });
    const startMsg = await waitForMsg(p1, 'phase-change', 10_000);
    expect(startMsg.type === 'phase-change' && startMsg.phase).toBe('playing');
    console.log('[vault] Game started');

    // ---- Game loop: event-driven whispers, flow tracked on p1 ----
    // Whisper plan keyed by sequential character-turn number.
    // With 3 chars, turns 1-3 = round 1, turns 4-6 = round 2, etc.
    // Each entry maps character name → whisper text.
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

    const narrations: string[] = [];
    const actionsTaken: Array<{ char: string; action: string; turn: number; influence: string }> = [];
    const locations = new Set<string>();
    let sceneCount = 0;
    let turnsCompleted = 0;
    let stressEvents = 0;
    let compelCount = 0;
    let invokeCount = 0;
    let sessionEnded = false;

    const TARGET_TURNS = 30;

    const allMsgs: ServerMessage[] = [];
    const msgCollector = (data: Buffer) => {
      try { allMsgs.push(JSON.parse(data.toString())); } catch {}
    };
    p1.on('message', msgCollector);

    const endedPromise = new Promise<void>((resolve) => {
      const handler = (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'phase-change' && msg.phase === 'ended') {
            sessionEnded = true;
            p1.off('message', handler);
            resolve();
          }
        } catch {}
      };
      p1.on('message', handler);
    });

    for (let turn = 0; turn < TARGET_TURNS; turn++) {
      if (sessionEnded) {
        console.log(`[vault] Session ended naturally at turn ${turn + 1}`);
        break;
      }

      const turnNum = turn + 1;
      const roundNum = Math.floor(turn / 3) + 1;
      const charInRound = (turn % 3) + 1;
      console.log(`\n[vault] === Turn ${turnNum} (Round ${roundNum}, char ${charInRound}/3) ===`);

      try {
        let whisperSentForTurn = false;
        const whisperHandler = (data: Buffer) => {
          try {
            const msg: ServerMessage = JSON.parse(data.toString());
            if (msg.type === 'whisper-prompt' && !whisperSentForTurn) {
              whisperSentForTurn = true;
              const charName = msg.characterName;
              const whisperText = whisperPlan[turnNum]?.[charName];
              if (whisperText) {
                console.log(`[vault]   Whisper → ${charName.split(' ')[0]}: "${whisperText.slice(0, 60)}"`);
                sendMsg(host, { type: 'whisper', text: whisperText });
              } else {
                console.log(`[vault]   No whisper for ${charName}`);
              }
            }
          } catch {}
        };
        host.on('message', whisperHandler);

        const nextEvent = await waitForAnyMsg(p1, ['action-proposals', 'narration', 'scene-end'], 120_000);

        if (nextEvent.type === 'scene-end') {
          sceneCount++;
          console.log(`[vault]   Scene ${sceneCount} ended: "${(nextEvent as any).summary?.slice(0, 80)}..."`);
          host.off('message', whisperHandler);
          await waitForMsg(p1, 'narration', 120_000);
          turnsCompleted++;
          continue;
        }

        if (nextEvent.type === 'narration') {
          narrations.push(nextEvent.text);
          if ((nextEvent as any).locationName) locations.add((nextEvent as any).locationName);
          if (/old habits|rears its head|epitaph|glimmer of fate|the wrong moment/i.test(nextEvent.text)) compelCount++;
          console.log(`[vault]   Narration: "${nextEvent.text.slice(0, 100)}..."`);

          const afterNarration = await waitForAnyMsg(p1, ['action-proposals', 'scene-end'], 120_000);
          if (afterNarration.type === 'scene-end') {
            sceneCount++;
            console.log(`[vault]   Scene ${sceneCount} ended after narration`);
            host.off('message', whisperHandler);
            await waitForMsg(p1, 'narration', 120_000);
            turnsCompleted++;
            continue;
          }
          if (afterNarration.type === 'action-proposals') {
            const ap = afterNarration as any;
            console.log(`[vault]   Proposals for ${ap.characterName} (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
          }
        } else if (nextEvent.type === 'action-proposals') {
          const ap = nextEvent as any;
          console.log(`[vault]   Proposals for ${ap.characterName} (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
        }

        const actionTaken = await waitForMsg(p1, 'action-taken', 120_000);
        if (actionTaken.type === 'action-taken') {
          const inf = actionTaken.whisperInfluence;
          actionsTaken.push({ char: actionTaken.characterName, action: actionTaken.action, turn: turnNum, influence: inf });
          console.log(`[vault]   ${actionTaken.characterName.split(' ')[0]} [${inf}]: "${actionTaken.action.slice(0, 80)}"`);
          console.log(`[vault]   Inner thought: "${actionTaken.innerThought.slice(0, 100)}"`);
        }

        await waitForMsg(p1, 'dice-roll', 120_000);
        const resolution = await waitForMsg(p1, 'resolution', 120_000);
        if (resolution.type === 'resolution') {
          narrations.push(resolution.text);
          if (resolution.text.includes('stress') || resolution.text.includes('Stress')) stressEvents++;
          if (/draws on|channels|Something shifts|tide turns/i.test(resolution.text)) invokeCount++;
          if (/old habits|rears its head|epitaph|glimmer of fate|the wrong moment/i.test(resolution.text)) compelCount++;
        }

        host.off('message', whisperHandler);
        turnsCompleted++;

      } catch (e: any) {
        console.error(`[vault] Turn ${turnNum} error:`, e.message);
        findings.push(`Turn ${turnNum} error: ${e.message}`);
        if (turnNum <= 5) throw e;
        break;
      }
    }

    // ---- Results ----
    console.log(`\n[vault] === PLAYTEST RESULTS ===`);
    console.log(`[vault] Turns: ${turnsCompleted}/${TARGET_TURNS}`);
    console.log(`[vault] Scenes: ${sceneCount}`);
    console.log(`[vault] Locations: ${[...locations].join(', ')}`);
    console.log(`[vault] Actions: ${actionsTaken.length}`);
    console.log(`[vault] Compels: ${compelCount}`);
    console.log(`[vault] Invokes: ${invokeCount}`);
    console.log(`[vault] Stress events: ${stressEvents}`);

    const npcMentions: Record<string, number> = {
      sparks: 0, vex: 0, ashworth: 0, cogsworth: 0, guildmaster: 0, orrery: 0,
    };
    const allText = narrations.join(' ').toLowerCase();
    for (const key of Object.keys(npcMentions)) {
      npcMentions[key] = (allText.match(new RegExp(key, 'gi')) ?? []).length;
    }
    console.log(`[vault] NPC mentions: ${JSON.stringify(npcMentions)}`);

    const charActions: Record<string, number> = {};
    for (const a of actionsTaken) {
      const first = a.char.split(' ')[0]!;
      charActions[first] = (charActions[first] ?? 0) + 1;
    }
    console.log(`[vault] Actions per character: ${JSON.stringify(charActions)}`);

    const whisperResults = actionsTaken.filter(a => a.influence !== 'none');
    const followed = whisperResults.filter(a => a.influence === 'followed').length;
    const partial = whisperResults.filter(a => a.influence === 'partially-followed').length;
    const ignored = whisperResults.filter(a => a.influence === 'ignored').length;
    console.log(`[vault] Whisper influence: ${followed} followed, ${partial} partial, ${ignored} ignored (${whisperResults.length} total)`);

    const conflictTurns = [10, 15, 28];
    const conflictActions = actionsTaken.filter(a => conflictTurns.includes(a.turn));
    if (conflictActions.length > 0) {
      console.log(`[vault] Conflict turns:`);
      for (const a of conflictActions) {
        console.log(`[vault]   T${a.turn} ${a.char.split(' ')[0]} [${a.influence}]: "${a.action.slice(0, 60)}"`);
      }
    }

    if (findings.length > 0) {
      console.log(`[vault] Findings: ${findings.join('; ')}`);
    }

    expect(turnsCompleted).toBeGreaterThanOrEqual(10);
    expect(sceneCount).toBeGreaterThanOrEqual(2);

    const scenarioNpcs = ['sparks', 'vex', 'guildmaster', 'ashworth', 'cogsworth', 'orrery'];
    const referencedNpcs = scenarioNpcs.filter(n => (npcMentions[n] ?? 0) > 0);
    console.log(`[vault] NPCs referenced: ${referencedNpcs.join(', ')} (${referencedNpcs.length}/${scenarioNpcs.length})`);
    expect(referencedNpcs.length).toBeGreaterThanOrEqual(2);

    expect(locations.size).toBeGreaterThanOrEqual(2);
    expect(actionsTaken.length).toBeGreaterThanOrEqual(8);

    const chars = Object.keys(charActions);
    expect(chars.length).toBeGreaterThanOrEqual(3);

  }, 1_200_000);
});
