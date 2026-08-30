import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';
import type { CharacterDefinition } from '../src/shared/types.js';

const LLM_PROXY_URL = process.env.LLM_PROXY_URL || 'https://proxy.multiversegames.ai';
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

class MessageQueue {
  private buffer: ServerMessage[] = [];
  private waiters: Array<{ types: string[]; resolve: (msg: ServerMessage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(private ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      const msg: ServerMessage = JSON.parse(data.toString());
      const idx = this.waiters.findIndex(w => w.types.includes(msg.type));
      if (idx >= 0) {
        const waiter = this.waiters.splice(idx, 1)[0]!;
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      } else {
        this.buffer.push(msg);
      }
    });
  }

  next(type: string, timeoutMs = 90_000): Promise<ServerMessage> {
    return this.nextAny([type], timeoutMs);
  }

  nextAny(types: string[], timeoutMs = 90_000): Promise<ServerMessage> {
    const idx = this.buffer.findIndex(m => types.includes(m.type));
    if (idx >= 0) return Promise.resolve(this.buffer.splice(idx, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const wi = this.waiters.findIndex(w => w.resolve === resolve);
        if (wi >= 0) this.waiters.splice(wi, 1);
        reject(new Error(`Timeout waiting for ${types.join(',')} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ types, resolve, reject, timer });
    });
  }

  drain() { this.buffer.length = 0; }
}

function waitForMsg(ws: WebSocket, type: string, timeoutMs = 90_000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const handler = (data: Buffer) => {
      const msg: ServerMessage = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for ${type} after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.on('message', handler);
  });
}

async function completeDmSetup(ws: WebSocket): Promise<void> {
  await waitForMsg(ws, 'dm-settings');
  await waitForMsg(ws, 'dm-chat-reply');

  const followUps = [
    'Use FATE Core. A collapsed mine rescue scenario with two characters — a dwarven miner and a surface medic. No house rules.',
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

// ---- Character definitions ----
const grimjawDef: CharacterDefinition = {
  name: 'Grimjaw',
  highConcept: 'Last of the Deepdelvers',
  trouble: "Can't Leave Anyone Behind",
  aspects: ['Stone Speaks to Me', 'Scarred Hands Tell Stories'],
  personality: 'Gruff, protective, speaks in short sentences',
  backstory: 'The last survivor of the Deepdelver clan mining guild',
  skills: { Athletics: 4, Fight: 3, Crafts: 3, Notice: 2, Will: 2, Physique: 1 },
  stunts: ['Tunnel Sense: +2 to Notice when underground'],
};

const lumenDef: CharacterDefinition = {
  name: 'Lumen',
  highConcept: 'Field Surgeon from the Bright Lands',
  trouble: "Haunted by the Ones I Couldn't Save",
  aspects: ['Healing Hands Never Rest', 'Eyes That See Too Much'],
  personality: 'Compassionate but clinical, always analyzing',
  backstory: 'A field surgeon who came underground seeking rare medicinal fungi',
  skills: { Empathy: 4, Will: 3, Investigate: 3, Lore: 2, Notice: 2, Rapport: 1 },
  stunts: ['Triage Expert: +2 to Empathy when assessing injuries'],
};

// ---- Whisper lists ----
const mineWhispers = [
  // Scene 1: Approach and entry
  'Ask Tobias what he saw in the dark before the tremor.',
  'Check the old mine entrance for signs of what caused the collapse.',
  'The ventilation shaft may still be passable. Look for it in the treeline.',
  'Elder Maren is holding something back. Press her gently.',
  'Foreman Greaves has burns on his hands. That is not from mining.',
  // Scene 2: Upper tunnels
  'The cart tracks lead deeper. Follow them but watch for unstable ground.',
  'Listen at the collapse zone wall. Can you hear the trapped miners?',
  'Use Tobias\'s map to find the side passage around the collapse.',
  'The water dripping from the ceiling tastes metallic. Something is wrong down here.',
  'Shore up the tunnel supports before going deeper. Crafts would help.',
  // Scene 3: Deep excavation
  'The carved symbols on the walls predate the mine by centuries. Study them.',
  'Something is glowing deeper in the tunnel. Approach carefully.',
  'The freshly dug tunnel slopes down sharply. Greaves was looking for something specific.',
  'You can feel vibrations in the stone. The crystals are reacting to your presence.',
  'One of the trapped miners is injured. Time is running out.',
  // Scene 4-5: Crystal chamber and rescue
  'The crystals hum louder when you speak. Keep your voice low.',
  'The Pale Woman is watching. Do not run. She is a guardian, not a threat.',
  'The crystal shard vibrates near the cavern walls. It could guide you to the miners.',
  'Greaves\'s journal has a sketch of this chamber. He knew what was down here.',
  'The miners are behind a thin wall of crystal. Break through carefully — the vibrations could cause another collapse.',
  // Extra / recovery whispers
  'Trust your instincts. The stone speaks to those who listen.',
  'Your partner needs medical attention. Check on them.',
  'The air is getting thinner. Find the ventilation passage quickly.',
  'Remember what Elder Maren said about the old tunnels. There was a warning.',
  'The lantern is flickering. Conserve the oil.',
  'Those carvings match something from an old legend. Think.',
  'The tremor was not natural. Something woke up down here.',
  'Work together to move the rubble. Neither of you can do this alone.',
  'The crystal chamber has another exit. Look for air currents.',
  'Get the miners out first. The mystery of the deep tunnels can wait.',
];

beforeAll(async () => {
  const { fork } = await import('node:child_process');
  const { resolve } = await import('node:path');

  port = 4200 + Math.floor(Math.random() * 100);

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
    console.log('\n=== FULL SERVER LOGS (last 150) ===');
    allServerLogs.slice(-150).forEach(l => console.log(l));
  }
});

describeIfLive('Collapsed Mine Playtest: 30-Turn Rescue with 2 Characters', () => {
  it('runs a full 30-turn rescue through the collapsed-mine scenario', async () => {
    const findings: string[] = [];
    const timings: Record<string, number> = {};

    // ---- Phase 1: Room creation + DM setup ----
    const host = await connectWs();
    let t0 = Date.now();

    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create', name: 'Collapsed Mine Rescue',
      dmPreset: 'chronicler', scenarioId: 'collapsed-mine', systemId: 'fate-core', houseRules: null,
    });
    const roomMsg = await roomPromise;
    timings['room-create'] = Date.now() - t0;
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;
    console.log(`[mine] Room created (${timings['room-create']}ms), join code: ${joinCode}`);

    t0 = Date.now();
    await completeDmSetup(host);
    timings['dm-setup'] = Date.now() - t0;
    console.log(`[mine] DM setup complete (${timings['dm-setup']}ms)`);

    // ---- Phase 2: Two players join ----
    const p1 = await connectWs();
    const p2 = await connectWs();
    const p1Join = waitForMsg(p1, 'room-joined');
    const p2Join = waitForMsg(p2, 'room-joined');
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Miner' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'Medic' });
    await Promise.all([p1Join, p2Join]);
    console.log('[mine] Both players joined');

    // ---- Phase 3: Submit characters sequentially ----
    const charIds: Record<string, string> = {};

    for (const [player, def, label] of [[p1, grimjawDef, 'grimjaw'], [p2, lumenDef, 'lumen']] as const) {
      let approved = false;
      let charId = '';
      for (let attempt = 0; attempt < 3 && !approved; attempt++) {
        const valPromise = waitForMsg(player, 'character-validated', 90_000);
        sendMsg(player, { type: 'submit-character', definition: def });
        const valMsg = await valPromise;
        if (valMsg.type === 'character-validated' && valMsg.approved) {
          charId = valMsg.characterId;
          approved = true;
          console.log(`[mine] ${label} AI-approved: ${charId}`);
        } else {
          console.log(`[mine] ${label} validation attempt ${attempt + 1} failed`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!approved) {
        findings.push(`BUG: ${label} never approved after 3 attempts`);
        console.log('[mine] FINDINGS:', findings);
        host.close(); p1.close(); p2.close();
        return;
      }

      await waitForMsg(host, 'negotiation-opened', 30_000);
      await waitForMsg(host, 'negotiation-message', 90_000);
      sendMsg(host, { type: 'host-approve-character', characterId: charId });
      console.log(`[mine] Host approved ${label}`);
      charIds[label] = charId;
      await new Promise(r => setTimeout(r, 1000));
    }

    // ---- Phase 4: Start game ----
    t0 = Date.now();
    sendMsg(host, { type: 'start-game' });

    const phaseChange = await waitForMsg(p1, 'phase-change', 10_000);
    expect(phaseChange.type).toBe('phase-change');
    if (phaseChange.type === 'phase-change') {
      expect(phaseChange.phase).toBe('playing');
    }
    console.log('[mine] Game started');

    const firstNarration = await waitForMsg(p1, 'narration', 120_000);
    timings['first-narration'] = Date.now() - t0;
    if (firstNarration.type === 'narration') {
      console.log(`[mine] Opening narration (${timings['first-narration']}ms, scene ${firstNarration.sceneNumber}): "${firstNarration.text.slice(0, 120)}..."`);
      if (firstNarration.locationName) console.log(`[mine]   Location: ${firstNarration.locationName}`);
    }

    // ---- Phase 5: 30-turn game loop ----
    const q = new MessageQueue(p1);

    const TOTAL_TURNS = 30;
    let turnsCompleted = 0;
    let scenesCompleted = 0;
    let maxSceneNumber = 1;
    let gameEndedNaturally = false;

    // Tracking
    const narrations: Array<{ turn: number; scene: number; text: string; location?: string }> = [];
    const resolutions: Array<{ turn: number; text: string }> = [];
    const sceneTransitions: Array<{ sceneNum: number; summary: string }> = [];
    const turnLog: Array<{ turn: number; char: string; action: string; influence: string; innerThought: string }> = [];
    const trustHistory: Record<string, number[]> = { grimjaw: [], lumen: [] };
    const locationVisits: string[] = [];
    const npcMentions: Record<string, number> = { 'Elder Maren': 0, Maren: 0, Tobias: 0, 'Foreman Greaves': 0, Greaves: 0, 'Pale Woman': 0 };
    const itemMentions: Record<string, number> = { 'Miner\'s Lantern': 0, Lantern: 0, 'Tobias\'s Map': 0, 'Crystal Shard': 0, 'Greaves\'s Journal': 0 };
    const errors: string[] = [];
    const turnTimings: number[] = [];

    // Compel tracking
    const compelNarrations: Array<{ turn: number; text: string; isNarrative: boolean; hasBracketFormat: boolean }> = [];
    // FP economy tracking
    const fpSnapshots: Array<{ turn: number; char: string; fp: number }> = [];

    // State update collector
    const allMsgs: ServerMessage[] = [];
    const msgCollector = (data: Buffer) => {
      try { allMsgs.push(JSON.parse(data.toString())); } catch {}
    };
    p1.on('message', msgCollector);

    // Helper: scan text for NPC and item mentions
    function scanMentions(text: string) {
      for (const npc of Object.keys(npcMentions)) {
        if (text.includes(npc)) npcMentions[npc]++;
      }
      for (const item of Object.keys(itemMentions)) {
        if (text.includes(item)) itemMentions[item]++;
      }
    }

    // Helper: check if text contains a compel and whether it's narrative
    function checkForCompel(text: string, turn: number) {
      const lowerText = text.toLowerCase();
      if (lowerText.includes('compel') || lowerText.includes('fate point') || lowerText.includes('catches up')) {
        const isNarrative = text.includes('*') || text.includes('catches up');
        const hasBracketFormat = /\[Compel[:\s]/i.test(text);
        compelNarrations.push({ turn, text: text.slice(0, 200), isNarrative, hasBracketFormat });
        if (hasBracketFormat) {
          findings.push(`BUG: Turn ${turn} has bracket-format compel "[Compel: ...]" instead of narrative prose`);
        }
      }
    }

    for (let turn = 0; turn < TOTAL_TURNS; turn++) {
      const turnStart = Date.now();
      console.log(`\n[mine] ========== Turn ${turn + 1} ==========`);

      try {
        // Auto-whisper handler
        const whisperText = mineWhispers[turn % mineWhispers.length]!;
        let whisperSent = false;
        const autoWhisper = (data: Buffer) => {
          try {
            const msg: ServerMessage = JSON.parse(data.toString());
            if (msg.type === 'whisper-prompt' && !whisperSent) {
              whisperSent = true;
              console.log(`[mine]   Whisper prompt for ${(msg as any).characterName}`);
              sendMsg(host, { type: 'whisper', text: whisperText });
              console.log(`[mine]   Whispered: "${whisperText}"`);
            }
          } catch {}
        };
        host.on('message', autoWhisper);

        // Wait for next game event
        const nextEvent = await q.nextAny(['action-proposals', 'narration', 'scene-end', 'phase-change'], 120_000);

        if (nextEvent.type === 'phase-change' && (nextEvent as any).phase === 'ended') {
          host.off('message', autoWhisper);
          console.log(`[mine]   Game ended naturally at turn ${turn + 1}`);
          gameEndedNaturally = true;
          break;
        }

        if (nextEvent.type === 'scene-end') {
          scenesCompleted++;
          const summary = (nextEvent as any).summary ?? '';
          const sceneNum = (nextEvent as any).sceneNumber ?? scenesCompleted;
          sceneTransitions.push({ sceneNum, summary });
          console.log(`[mine]   Scene ${sceneNum} ended: "${summary.slice(0, 100)}..."`);
          scanMentions(summary);
          checkForCompel(summary, turn + 1);
          host.off('message', autoWhisper);
          const nextOrEnd = await q.nextAny(['narration', 'phase-change'], 120_000);
          if (nextOrEnd.type === 'phase-change' && (nextOrEnd as any).phase === 'ended') {
            console.log(`[mine]   Game ended after scene transition`);
            gameEndedNaturally = true;
            break;
          }
          if (nextOrEnd.type === 'narration') {
            const loc = (nextOrEnd as any).locationName ?? '';
            const sn = (nextOrEnd as any).sceneNumber ?? 0;
            if (sn > maxSceneNumber) maxSceneNumber = sn;
            if (loc) locationVisits.push(loc);
            console.log(`[mine]   New scene ${sn} narration: "${nextOrEnd.text.slice(0, 100)}..." [location: ${loc || 'none'}]`);
            scanMentions(nextOrEnd.text);
            checkForCompel(nextOrEnd.text, turn + 1);
            narrations.push({ turn: turn + 1, scene: sn, text: nextOrEnd.text, location: loc || undefined });
          }
          turnsCompleted++;
          turnTimings.push(Date.now() - turnStart);
          continue;
        }

        if (nextEvent.type === 'narration') {
          const loc = (nextEvent as any).locationName ?? '';
          const sn = (nextEvent as any).sceneNumber ?? 0;
          if (sn > maxSceneNumber) maxSceneNumber = sn;
          if (loc) locationVisits.push(loc);
          console.log(`[mine]   Narration (scene ${sn}): "${nextEvent.text.slice(0, 100)}..." [location: ${loc || 'none'}]`);
          scanMentions(nextEvent.text);
          checkForCompel(nextEvent.text, turn + 1);
          narrations.push({ turn: turn + 1, scene: sn, text: nextEvent.text, location: loc || undefined });

          const afterNarration = await q.nextAny(['action-proposals', 'scene-end', 'phase-change'], 120_000);
          if (afterNarration.type === 'phase-change' && (afterNarration as any).phase === 'ended') {
            host.off('message', autoWhisper);
            gameEndedNaturally = true;
            break;
          }
          if (afterNarration.type === 'scene-end') {
            scenesCompleted++;
            const summary = (afterNarration as any).summary ?? '';
            const sceneNumEnd = (afterNarration as any).sceneNumber ?? scenesCompleted;
            sceneTransitions.push({ sceneNum: sceneNumEnd, summary });
            console.log(`[mine]   Scene ${sceneNumEnd} ended after narration: "${summary.slice(0, 100)}..."`);
            scanMentions(summary);
            checkForCompel(summary, turn + 1);
            host.off('message', autoWhisper);
            const nextOrEnd2 = await q.nextAny(['narration', 'phase-change'], 120_000);
            if (nextOrEnd2.type === 'phase-change' && (nextOrEnd2 as any).phase === 'ended') {
              gameEndedNaturally = true;
              break;
            }
            if (nextOrEnd2.type === 'narration') {
              const loc2 = (nextOrEnd2 as any).locationName ?? '';
              const sn2 = (nextOrEnd2 as any).sceneNumber ?? 0;
              if (sn2 > maxSceneNumber) maxSceneNumber = sn2;
              if (loc2) locationVisits.push(loc2);
              narrations.push({ turn: turn + 1, scene: sn2, text: nextOrEnd2.text, location: loc2 || undefined });
              checkForCompel(nextOrEnd2.text, turn + 1);
            }
            turnsCompleted++;
            turnTimings.push(Date.now() - turnStart);
            continue;
          }
          if (afterNarration.type === 'action-proposals') {
            const ap = afterNarration as any;
            console.log(`[mine]   Proposals for ${ap.characterName} (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
            ap.actions?.forEach((a: string, i: number) => console.log(`[mine]     ${i + 1}. ${a.slice(0, 80)}`));
          }
        } else if (nextEvent.type === 'action-proposals') {
          const ap = nextEvent as any;
          console.log(`[mine]   Proposals for ${ap.characterName} (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
          ap.actions?.forEach((a: string, i: number) => console.log(`[mine]     ${i + 1}. ${a.slice(0, 80)}`));
        }

        // Wait for action-taken
        const actionTaken = await q.next('action-taken', 120_000);
        if (actionTaken.type === 'action-taken') {
          const charLabel = actionTaken.characterName === 'Grimjaw' ? 'grimjaw' : 'lumen';
          console.log(`[mine]   ${charLabel} [${actionTaken.whisperInfluence}]: "${actionTaken.action.slice(0, 100)}"`);
          console.log(`[mine]   Inner thought: "${actionTaken.innerThought.slice(0, 100)}"`);
          scanMentions(actionTaken.action);
          scanMentions(actionTaken.innerThought);
          checkForCompel(actionTaken.action, turn + 1);
          checkForCompel(actionTaken.innerThought, turn + 1);
          turnLog.push({
            turn: turn + 1,
            char: charLabel,
            action: actionTaken.action.slice(0, 80),
            influence: actionTaken.whisperInfluence,
            innerThought: actionTaken.innerThought.slice(0, 80),
          });
        }

        // Wait for dice roll
        const diceMsg = await q.next('dice-roll', 90_000);
        if (diceMsg.type === 'dice-roll') {
          console.log(`[mine]   Dice: ${diceMsg.result.description} (total: ${diceMsg.result.total})`);
        }

        // Wait for resolution
        const resolution = await q.next('resolution', 120_000);
        if (resolution.type === 'resolution') {
          console.log(`[mine]   Resolution: "${resolution.text.slice(0, 120)}..."`);
          scanMentions(resolution.text);
          checkForCompel(resolution.text, turn + 1);
          resolutions.push({ turn: turn + 1, text: resolution.text });
        }

        // Track trust and FP from state updates
        const stateUpdates = allMsgs.filter(m => m.type === 'character-state-update');
        for (const su of stateUpdates) {
          if (su.type !== 'character-state-update') continue;
          const label = su.characterId === charIds.grimjaw ? 'grimjaw' : 'lumen';
          trustHistory[label].push(su.state.whisperTrust);
          fpSnapshots.push({ turn: turn + 1, char: label, fp: su.state.fatePoints });
        }
        allMsgs.length = 0;

        host.off('message', autoWhisper);
        turnsCompleted++;
        const turnTime = Date.now() - turnStart;
        turnTimings.push(turnTime);
        console.log(`[mine]   Turn ${turn + 1} complete (${turnTime}ms)`);

      } catch (e: any) {
        console.error(`[mine]   Turn ${turn + 1} FAILED: ${e.message}`);
        errors.push(`Turn ${turn + 1}: ${e.message}`);
        findings.push(`BUG: Turn ${turn + 1} failed: ${e.message}`);
        break;
      }
    }

    p1.off('message', msgCollector);

    // ---- Phase 6: End game if not ended naturally ----
    if (!gameEndedNaturally) {
      sendMsg(host, { type: 'end-game' });
      try {
        await waitForMsg(p1, 'phase-change', 30_000);
        console.log('[mine] Game ended via command');
      } catch {
        console.log('[mine] Game end phase-change not received (may already be ended)');
      }
    }

    // ---- Phase 7: Analysis and reporting ----

    // Server log analysis
    const compactionLogs = allServerLogs.filter(l => l.includes('compaction') || l.includes('Compaction'));
    const memoryLogs = allServerLogs.filter(l => l.includes('[memory]'));
    const factLogs = allServerLogs.filter(l => l.includes('Fact extraction'));
    const aspectInvokeLogs = allServerLogs.filter(l => l.includes('Aspect invocation') || l.includes('Auto-invoke'));
    const compelLogs = allServerLogs.filter(l => l.includes('Compel triggered') || l.includes('compel'));
    const recoveryLogs = allServerLogs.filter(l => l.includes('Scene recovery'));
    const locationLogs = allServerLogs.filter(l => l.includes('Location:'));
    const scenarioSeedLogs = allServerLogs.filter(l => l.includes('Seeded scenario'));
    const fateOutcomeLogs = allServerLogs.filter(l => l.includes('FATE outcome corrected') || l.includes('FATE difficulty'));

    console.log('\n');
    console.log('='.repeat(80));
    console.log('  COLLAPSED MINE PLAYTEST REPORT');
    console.log('='.repeat(80));

    console.log('\n--- OVERVIEW ---');
    console.log(`Turns completed: ${turnsCompleted}/${TOTAL_TURNS}`);
    console.log(`Scene transitions: ${scenesCompleted}`);
    console.log(`Max scene number reached: ${maxSceneNumber}`);
    console.log(`Game ended naturally: ${gameEndedNaturally}`);
    console.log(`Errors encountered: ${errors.length}`);

    console.log('\n--- SCENE PACING (TARGET: 5+ SCENES) ---');
    if (maxSceneNumber >= 5) {
      console.log(`  PASS: Reached scene ${maxSceneNumber} (target was 5+)`);
    } else {
      findings.push(`PACING: Only reached scene ${maxSceneNumber}, needed 5+ to confirm pacing fix`);
      console.log(`  FAIL: Only reached scene ${maxSceneNumber} (target was 5+)`);
    }

    console.log('\n--- SCENARIO SEEDING ---');
    scenarioSeedLogs.forEach(l => console.log(`  ${l}`));
    if (scenarioSeedLogs.length === 0) findings.push('ISSUE: No scenario seeding log — collapsed-mine may not have loaded');

    console.log('\n--- COMPEL NARRATION QUALITY ---');
    console.log(`Total compel-related narrations detected: ${compelNarrations.length}`);
    const narrativeCompels = compelNarrations.filter(c => c.isNarrative);
    const bracketCompels = compelNarrations.filter(c => c.hasBracketFormat);
    console.log(`  Narrative prose compels (with * or "catches up"): ${narrativeCompels.length}`);
    console.log(`  Bracket-format compels [Compel: ...] (BAD): ${bracketCompels.length}`);
    for (const c of compelNarrations) {
      console.log(`  Turn ${c.turn}: narrative=${c.isNarrative}, bracket=${c.hasBracketFormat} — "${c.text.slice(0, 120)}..."`);
    }
    if (bracketCompels.length > 0) {
      findings.push(`BUG: ${bracketCompels.length} compel(s) used bracket format instead of narrative prose`);
    }
    console.log(`Server-side compel triggers: ${compelLogs.length}`);
    compelLogs.slice(0, 10).forEach(l => console.log(`  ${l.slice(0, 150)}`));

    console.log('\n--- NARRATION QUALITY ---');
    console.log(`Total narrations: ${narrations.length}`);
    const avgNarrationLen = narrations.length > 0
      ? Math.round(narrations.reduce((sum, n) => sum + n.text.length, 0) / narrations.length)
      : 0;
    console.log(`Average narration length: ${avgNarrationLen} chars`);
    if (avgNarrationLen < 50) findings.push('ISSUE: Narrations are very short on average');

    // Check for repetitive narrations
    const narrationTexts = narrations.map(n => n.text.slice(0, 60).toLowerCase());
    const narrationDupes = narrationTexts.filter((t, i) => narrationTexts.indexOf(t) !== i);
    if (narrationDupes.length > 2) {
      findings.push(`ISSUE: ${narrationDupes.length} repetitive narration openings detected`);
    }
    console.log(`Repetitive narration openings: ${narrationDupes.length}`);

    console.log('\n--- LOCATION PROGRESSION ---');
    const uniqueLocations = [...new Set(locationVisits)];
    console.log(`Locations visited: ${uniqueLocations.join(', ') || 'none tracked'}`);
    locationLogs.forEach(l => console.log(`  ${l.slice(0, 120)}`));

    const expectedLocations = ['Thornhaven', 'Ventilation Shaft', 'Upper Tunnels', 'Collapse Zone', 'Deep Excavation', 'Crystal Chamber'];
    const visitedExpected = expectedLocations.filter(el => uniqueLocations.some(ul => ul.toLowerCase().includes(el.toLowerCase())));
    console.log(`Expected locations visited: ${visitedExpected.length}/${expectedLocations.length} (${visitedExpected.join(', ') || 'none'})`);
    if (visitedExpected.length === 0) findings.push('ISSUE: No expected mine locations were visited');
    if (visitedExpected.length < 3 && turnsCompleted >= 20) findings.push(`ISSUE: Only ${visitedExpected.length} mine locations visited in ${turnsCompleted} turns`);

    console.log('\n--- SCENARIO ITEMS ---');
    for (const [item, count] of Object.entries(itemMentions)) {
      console.log(`  ${item}: mentioned ${count} times`);
    }
    const anyItemUsed = Object.values(itemMentions).some(c => c > 0);
    if (!anyItemUsed) findings.push('ISSUE: No scenario items (Lantern, Map, Crystal Shard, Journal) were mentioned');

    console.log('\n--- NPC INTERACTIONS ---');
    for (const [npc, count] of Object.entries(npcMentions)) {
      console.log(`  ${npc}: mentioned ${count} times`);
    }
    const anyNpcMentioned = Object.values(npcMentions).some(c => c > 0);
    if (!anyNpcMentioned) findings.push('ISSUE: No scenario NPCs (Elder Maren, Tobias, Greaves, Pale Woman) were mentioned');

    console.log('\n--- CHARACTER DYNAMICS ---');
    const grimjawTurns = turnLog.filter(t => t.char === 'grimjaw');
    const lumenTurns = turnLog.filter(t => t.char === 'lumen');
    console.log(`Grimjaw turns: ${grimjawTurns.length}, Lumen turns: ${lumenTurns.length}`);
    if (grimjawTurns.length === 0) findings.push('BUG: Grimjaw never got a turn');
    if (lumenTurns.length === 0) findings.push('BUG: Lumen never got a turn');

    // Whisper influence breakdown
    const influences = turnLog.map(t => t.influence);
    const followed = influences.filter(i => i === 'followed').length;
    const partial = influences.filter(i => i === 'partially-followed').length;
    const ignored = influences.filter(i => i === 'ignored').length;
    const none = influences.filter(i => i === 'none').length;
    console.log(`Whisper influence: ${followed} followed, ${partial} partial, ${ignored} ignored, ${none} none`);

    console.log('\n--- TRUST TRACKING ---');
    for (const [label, history] of Object.entries(trustHistory)) {
      if (history.length > 0) {
        console.log(`  ${label}: [${history.map(t => t.toFixed(2)).join(', ')}]`);
        console.log(`    Start: ${history[0]!.toFixed(2)}, End: ${history[history.length - 1]!.toFixed(2)}`);
      }
    }

    console.log('\n--- FATE POINT ECONOMY ---');
    console.log(`Aspect invocations (server logs): ${aspectInvokeLogs.length}`);
    aspectInvokeLogs.slice(0, 10).forEach(l => console.log(`  ${l.slice(0, 150)}`));
    console.log(`Compels (server logs): ${compelLogs.length}`);
    compelLogs.slice(0, 10).forEach(l => console.log(`  ${l.slice(0, 150)}`));
    if (aspectInvokeLogs.length === 0 && turnsCompleted >= 15) findings.push('ISSUE: No aspect invocations in 15+ turns');
    if (compelLogs.length === 0 && turnsCompleted >= 15) findings.push('ISSUE: No compels in 15+ turns');

    // FP snapshot timeline
    console.log(`FP snapshots collected: ${fpSnapshots.length}`);
    for (const snap of fpSnapshots) {
      console.log(`  Turn ${snap.turn}: ${snap.char} FP=${snap.fp}`);
    }
    const grimjawFP = fpSnapshots.filter(s => s.char === 'grimjaw');
    const lumenFP = fpSnapshots.filter(s => s.char === 'lumen');
    if (grimjawFP.length > 0) {
      const fpStart = grimjawFP[0]!.fp;
      const fpEnd = grimjawFP[grimjawFP.length - 1]!.fp;
      console.log(`  Grimjaw FP: start=${fpStart}, end=${fpEnd}, delta=${fpEnd - fpStart}`);
    }
    if (lumenFP.length > 0) {
      const fpStart = lumenFP[0]!.fp;
      const fpEnd = lumenFP[lumenFP.length - 1]!.fp;
      console.log(`  Lumen FP: start=${fpStart}, end=${fpEnd}, delta=${fpEnd - fpStart}`);
    }

    console.log('\n--- FATE OUTCOME CORRECTIONS ---');
    fateOutcomeLogs.forEach(l => console.log(`  ${l.slice(0, 150)}`));

    console.log('\n--- TRANSCRIPT COMPACTION ---');
    console.log(`Compaction events: ${compactionLogs.length}`);
    compactionLogs.forEach(l => console.log(`  ${l.slice(0, 150)}`));
    if (compactionLogs.length === 0 && turnsCompleted >= 15) {
      findings.push('ISSUE: No transcript compaction occurred despite 15+ turns');
    }

    console.log('\n--- SCENE RECOVERY ---');
    recoveryLogs.forEach(l => console.log(`  ${l.slice(0, 150)}`));

    console.log('\n--- MEMORY SYSTEM ---');
    console.log(`Memory events: ${memoryLogs.length}`);
    memoryLogs.slice(0, 15).forEach(l => console.log(`  ${l.slice(0, 150)}`));

    console.log('\n--- FACT EXTRACTION ---');
    console.log(`Fact extractions: ${factLogs.length}`);
    factLogs.forEach(l => console.log(`  ${l.slice(0, 150)}`));

    console.log('\n--- SCENE TRANSITIONS ---');
    for (const st of sceneTransitions) {
      console.log(`  Scene ${st.sceneNum}: ${st.summary.slice(0, 120)}`);
    }
    if (scenesCompleted === 0 && turnsCompleted >= 10) {
      findings.push('ISSUE: No scene transitions after 10+ turns');
    }

    console.log('\n--- TURN-BY-TURN LOG ---');
    for (const entry of turnLog) {
      console.log(`  Turn ${entry.turn}: ${entry.char} [${entry.influence}] "${entry.action}"`);
    }

    console.log('\n--- TIMING ---');
    console.log(`Timings:`, timings);
    if (turnTimings.length > 0) {
      console.log(`Turn times: avg=${Math.round(turnTimings.reduce((a, b) => a + b, 0) / turnTimings.length)}ms, min=${Math.min(...turnTimings)}ms, max=${Math.max(...turnTimings)}ms`);
    }

    console.log('\n--- ERRORS ---');
    if (errors.length > 0) {
      errors.forEach(e => console.log(`  ${e}`));
    } else {
      console.log('  None');
    }

    console.log('\n--- FINDINGS ---');
    if (findings.length === 0) {
      console.log('  No issues found!');
    } else {
      findings.forEach(f => console.log(`  - ${f}`));
    }

    console.log('\n' + '='.repeat(80));

    // Basic assertions
    expect(turnsCompleted).toBeGreaterThanOrEqual(1);

    host.close(); p1.close(); p2.close();
  }, 600_000);
});
