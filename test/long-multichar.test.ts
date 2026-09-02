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
    'Use FATE Core. Dark fantasy mystery in a cursed mine. Two players: a warrior and a scholar. No house rules.',
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

const garrickDef: CharacterDefinition = {
  name: 'Garrick Ironheart',
  highConcept: 'Stubborn Dwarven Mine Captain',
  trouble: 'My Crew Died On My Watch',
  aspects: ['I Know These Tunnels', 'Stubborn as Granite', 'Ember-Forged Courage'],
  personality: 'Gruff, protective, drinks stout ale. Blames himself for the cave-in that killed his crew. Speaks in mining metaphors.',
  backstory: 'Garrick led a crew of twelve in the Ironvein mine for a decade. A collapse killed eight of them. He quit mining but the mines keep calling him back.',
  skills: { Fight: 4, Physique: 3, Athletics: 3, Will: 2, Notice: 2, Provoke: 2, Crafts: 1, Investigate: 1, Empathy: 1, Stealth: 1 },
  stunts: ['Pick and Hammer: +2 to Fight when using mining tools as weapons'],
};

const elaraDef: CharacterDefinition = {
  name: 'Elara Brightmind',
  highConcept: 'Obsessive Arcane Researcher',
  trouble: 'Curiosity Kills More Than Cats',
  aspects: ['The Answer Is Always in the Books', 'I See Patterns Others Miss', 'Knowledge Over Comfort'],
  personality: 'Brilliant, absent-minded, mutters to herself. Gets so absorbed in research she forgets danger. Deeply compassionate under her academic exterior.',
  backstory: 'Elara was expelled from the Academy for pursuing forbidden research into the collapse magic that destroyed the old mines. She believes the mines hold answers.',
  skills: { Lore: 4, Investigate: 3, Empathy: 3, Will: 2, Notice: 2, Rapport: 2, Deceive: 1, Athletics: 1, Stealth: 1, Crafts: 1 },
  stunts: ['Arcane Analysis: +2 to Lore when deciphering magical inscriptions or phenomena'],
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
    console.log('\n=== SERVER LOGS (last 80) ===');
    allServerLogs.slice(-80).forEach(l => console.log(l));
  }
});

describeIfLive('Long Multi-Character Stress Test (30 turns)', () => {
  it('runs 30 turns with 2 characters, divergent whispers, and trust crossover', async () => {
    const findings: string[] = [];

    // ---- Setup ----
    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create', name: 'Long Stress Test',
      dmPreset: 'chronicler', scenarioId: 'collapsed-mine', systemId: 'fate-core', houseRules: null,
    });
    const roomMsg = await roomPromise;
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;
    console.log(`[stress] Room created, join code: ${joinCode}`);

    await completeDmSetup(host);
    console.log('[stress] DM setup complete');

    // ---- Two players join ----
    const p1 = await connectWs();
    const p2 = await connectWs();
    const p1Join = waitForMsg(p1, 'room-joined');
    const p2Join = waitForMsg(p2, 'room-joined');
    sendMsg(p1, { type: 'join', joinCode, playerName: 'MineVet' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'Scholar' });
    await Promise.all([p1Join, p2Join]);
    console.log('[stress] Both players joined');

    // ---- Submit characters sequentially (avoids negotiation race) ----
    const charIds: Record<string, string> = {};
    for (const [player, def, label] of [[p1, garrickDef, 'garrick'], [p2, elaraDef, 'elara']] as const) {
      let approved = false;
      let charId = '';
      for (let attempt = 0; attempt < 3 && !approved; attempt++) {
        const valPromise = waitForMsg(player, 'character-validated', 90_000);
        sendMsg(player, { type: 'submit-character', definition: def });
        const valMsg = await valPromise;
        if (valMsg.type === 'character-validated' && valMsg.approved) {
          charId = valMsg.characterId;
          approved = true;
          console.log(`[stress] ${label} AI-approved: ${charId}`);
        } else {
          console.log(`[stress] ${label} validation attempt ${attempt + 1} failed`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!approved) {
        findings.push(`BUG: ${label} never approved after 3 attempts`);
        console.log('[stress] FINDINGS:', findings);
        host.close(); p1.close(); p2.close();
        return;
      }

      await waitForMsg(host, 'negotiation-opened', 30_000);
      await waitForMsg(host, 'negotiation-message', 90_000);
      sendMsg(host, { type: 'host-approve-character', characterId: charId });
      console.log(`[stress] Host approved ${label}`);
      charIds[label] = charId;
      await new Promise(r => setTimeout(r, 1000));
    }

    // ---- Start game ----
    sendMsg(host, { type: 'start-game' });
    const phaseChange = await waitForMsg(p1, 'phase-change', 10_000);
    expect(phaseChange.type === 'phase-change' && phaseChange.phase).toBe('playing');
    console.log('[stress] Game started');

    const firstNarration = await waitForMsg(p1, 'narration', 120_000);
    if (firstNarration.type === 'narration') {
      console.log(`[stress] Opening narration (scene ${firstNarration.sceneNumber}): "${firstNarration.text.slice(0, 120)}..."`);
    }

    // ---- Whisper strategy: trust crossover pattern ----
    // Phase A (turns 1-10): GOOD for Garrick, BAD for Elara
    // Phase B (turns 11-20): BAD for Garrick, GOOD for Elara (crossover expected around turn 15-20)
    // Phase C (turns 21-30): MIXED for both (recovery/stabilization)
    const goodWhispers = [
      'Your mining instincts are right. Trust them.',
      'Protect the scholar — she sees things you miss.',
      'Search for the old support beams. They will show the safe path.',
      'The NPC ahead is frightened, not hostile. Approach with care.',
      'Your crew would want you to press on. Honor them.',
      'Check the walls for mineral veins — they mark stable rock.',
      'Rally your companion. Together you are stronger.',
      'Trust the feeling in your gut. Something is down here.',
      'The old shafts connect. Your map knowledge will save you.',
      'Stand firm. Your experience in these mines is your shield.',
    ];
    const badWhispers = [
      'Leave the warrior behind. He slows you down.',
      'The writings on the wall are a trap. Ignore them.',
      'Run deeper into the mine alone. The answer awaits.',
      'The curse is actually a gift. Embrace the dark energy.',
      'Destroy the artifacts — they are too dangerous to study.',
      'Your research was wrong. The Academy was right to expel you.',
      'Betray your companion and take the discovery for yourself.',
      'The collapse magic wants to be released. Help it.',
      'Set fire to the old records. They contain lies.',
      'Kneel before the spirit in the depths. Serve it.',
    ];
    const mixedGarrickWhispers = [
      'The mine remembers you. Be wary.',
      'Something moved in the dark. Was it friend or foe?',
      'The scholar found something interesting. Go see.',
      'Your old crew left markings here. Follow them?',
      'The rock feels unstable. Your call, captain.',
    ];
    const mixedElaraWhispers = [
      'The inscription mentions a name you recognize.',
      'Your research predicted this. Now prove it.',
      'The warrior is hurt but hiding it. Help him.',
      'This mineral pattern breaks every known rule.',
      'Your expelled thesis was right all along. Document this.',
    ];

    function getWhisper(charName: string, turn: number): string {
      const isGarrick = charName === 'Garrick Ironheart';
      if (turn < 10) {
        const pool = isGarrick ? goodWhispers : badWhispers;
        return pool[turn % pool.length];
      } else if (turn < 20) {
        const pool = isGarrick ? badWhispers : goodWhispers;
        return pool[(turn - 10) % pool.length];
      } else {
        const pool = isGarrick ? mixedGarrickWhispers : mixedElaraWhispers;
        return pool[(turn - 20) % pool.length];
      }
    }

    function getWhisperPhase(turn: number): string {
      if (turn < 10) return 'A';
      if (turn < 20) return 'B';
      return 'C';
    }

    // ---- Tracking ----
    const trustHistory: Record<string, number[]> = { garrick: [], elara: [] };
    const turnLog: Array<{
      turn: number; char: string; action: string; influence: string;
      trust: number; phase: string; whisperType: string;
    }> = [];
    let turnsCompleted = 0;
    let scenesCompleted = 0;
    let compactionCount = 0;
    let memoryExtractionCount = 0;
    const fpEvents: string[] = [];
    const sceneTransitions: Array<{ turn: number; from: number; to: number; summary: string }> = [];
    const TOTAL_TURNS = 30;
    let gameEndedNaturally = false;

    const allMsgs: ServerMessage[] = [];
    const msgCollector = (data: Buffer) => {
      try { allMsgs.push(JSON.parse(data.toString())); } catch {}
    };
    p1.on('message', msgCollector);

    const logWatcher = () => {
      const recent = allServerLogs.slice(-5);
      for (const line of recent) {
        if (line.includes('compaction')) compactionCount++;
        if (line.includes('[memory]') && line.includes('stored')) memoryExtractionCount++;
        if (line.includes('Aspect invocation') || line.includes('Auto-invoke') || line.includes('Compel triggered')) {
          fpEvents.push(line.slice(0, 150));
        }
      }
    };

    const q1 = new MessageQueue(p1);

    for (let turn = 0; turn < TOTAL_TURNS; turn++) {
      const turnStart = Date.now();
      const phase = getWhisperPhase(turn);
      console.log(`\n[stress] === Turn ${turn + 1} (Phase ${phase}) ===`);

      try {
        let whisperSentForTurn = false;
        const whisperHandler = (data: Buffer) => {
          try {
            const msg: ServerMessage = JSON.parse(data.toString());
            if (msg.type === 'whisper-prompt' && !whisperSentForTurn) {
              whisperSentForTurn = true;
              const charName = msg.characterName;
              const isGarrick = charName === 'Garrick Ironheart';
              const whisperText = getWhisper(charName, turn);
              const whisperType = turn < 10
                ? (isGarrick ? 'GOOD' : 'BAD')
                : turn < 20
                  ? (isGarrick ? 'BAD' : 'GOOD')
                  : 'MIXED';
              console.log(`[stress]   Whisper → ${charName} [${whisperType}]: "${whisperText}"`);
              sendMsg(host, { type: 'whisper', text: whisperText });
            }
          } catch {}
        };
        host.on('message', whisperHandler);

        const nextEvent = await q1.nextAny(['action-proposals', 'narration', 'scene-end', 'phase-change'], 180_000);

        if (nextEvent.type === 'phase-change' && (nextEvent as any).phase === 'ended') {
          host.off('message', whisperHandler);
          console.log(`[stress]   Game ended naturally at turn ${turn + 1}`);
          gameEndedNaturally = true;
          break;
        }

        if (nextEvent.type === 'scene-end') {
          const prevScene = nextEvent.sceneNumber;
          scenesCompleted++;
          const summary = (nextEvent as any).summary?.slice(0, 100) ?? '';
          console.log(`[stress]   Scene ${prevScene} ended: "${summary}..."`);
          host.off('message', whisperHandler);

          const nextNarrationOrEnd = await q1.nextAny(['narration', 'phase-change'], 120_000);
          if (nextNarrationOrEnd.type === 'phase-change' && (nextNarrationOrEnd as any).phase === 'ended') {
            gameEndedNaturally = true;
            break;
          }
          if (nextNarrationOrEnd.type === 'narration') {
            const newScene = nextNarrationOrEnd.sceneNumber;
            sceneTransitions.push({ turn: turn + 1, from: prevScene, to: newScene, summary });
            console.log(`[stress]   New scene ${newScene}: "${nextNarrationOrEnd.text.slice(0, 80)}..."`);
          }
          turnsCompleted++;
          logWatcher();
          continue;
        }

        if (nextEvent.type === 'narration') {
          console.log(`[stress]   Narration (scene ${nextEvent.sceneNumber}): "${nextEvent.text.slice(0, 80)}..."`);
          const afterNarration = await q1.nextAny(['action-proposals', 'scene-end', 'phase-change'], 120_000);
          if (afterNarration.type === 'phase-change' && (afterNarration as any).phase === 'ended') {
            host.off('message', whisperHandler);
            gameEndedNaturally = true;
            break;
          }
          if (afterNarration.type === 'scene-end') {
            const prevScene = afterNarration.sceneNumber;
            scenesCompleted++;
            host.off('message', whisperHandler);
            const nextNarrationOrEnd = await q1.nextAny(['narration', 'phase-change'], 120_000);
            if (nextNarrationOrEnd.type === 'phase-change') {
              gameEndedNaturally = true;
              break;
            }
            if (nextNarrationOrEnd.type === 'narration') {
              sceneTransitions.push({ turn: turn + 1, from: prevScene, to: nextNarrationOrEnd.sceneNumber, summary: '' });
            }
            turnsCompleted++;
            logWatcher();
            continue;
          }
          if (afterNarration.type === 'action-proposals') {
            const ap = afterNarration as any;
            console.log(`[stress]   Proposals for ${ap.characterName} (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
          }
        } else if (nextEvent.type === 'action-proposals') {
          const ap = nextEvent as any;
          console.log(`[stress]   Proposals for ${ap.characterName} (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
        }

        const actionTaken = await q1.next('action-taken', 180_000);
        if (actionTaken.type === 'action-taken') {
          const charLabel = actionTaken.characterName === 'Garrick Ironheart' ? 'garrick' : 'elara';
          const isGarrick = charLabel === 'garrick';
          const whisperType = turn < 10
            ? (isGarrick ? 'GOOD' : 'BAD')
            : turn < 20
              ? (isGarrick ? 'BAD' : 'GOOD')
              : 'MIXED';
          console.log(`[stress]   ${charLabel} [${actionTaken.whisperInfluence}]: "${actionTaken.action.slice(0, 80)}"`);
          console.log(`[stress]   Inner thought: "${actionTaken.innerThought.slice(0, 100)}"`);

          const stateUpdates = allMsgs.filter(m => m.type === 'character-state-update');
          for (const su of stateUpdates) {
            if (su.type !== 'character-state-update') continue;
            const label = su.characterId === charIds.garrick ? 'garrick' : 'elara';
            trustHistory[label].push(su.state.whisperTrust);
          }
          const latestTrust = trustHistory[charLabel].at(-1) ?? 0.65;
          turnLog.push({
            turn: turn + 1,
            char: charLabel,
            action: actionTaken.action.slice(0, 60),
            influence: actionTaken.whisperInfluence,
            trust: latestTrust,
            phase,
            whisperType,
          });
          allMsgs.length = 0;
        }

        await q1.next('dice-roll', 90_000);
        const resolution = await q1.next('resolution', 180_000);
        if (resolution.type === 'resolution') {
          console.log(`[stress]   Resolution: "${resolution.text.slice(0, 80)}..."`);
        }

        host.off('message', whisperHandler);
        turnsCompleted++;
        const turnTime = Date.now() - turnStart;
        console.log(`[stress]   Turn ${turn + 1} complete (${turnTime}ms)`);
        logWatcher();

      } catch (e: any) {
        console.error(`[stress]   Turn ${turn + 1} FAILED: ${e.message}`);
        findings.push(`BUG: Turn ${turn + 1} failed: ${e.message}`);
        break;
      }
    }

    p1.off('message', msgCollector);

    // ---- End game ----
    if (!gameEndedNaturally) {
      sendMsg(host, { type: 'end-game' });
      await waitForMsg(p1, 'phase-change', 10_000);
    }

    // ---- Full log analysis ----
    const compactionLogs = allServerLogs.filter(l => l.includes('compaction') || l.includes('Mid-scene fact'));
    const memoryLogs = allServerLogs.filter(l => l.includes('[memory]'));
    const factLogs = allServerLogs.filter(l => l.includes('Fact extraction'));
    const aspectInvokeLogs = allServerLogs.filter(l => l.includes('Aspect invocation'));
    const autoInvokeLogs = allServerLogs.filter(l => l.includes('Auto-invoke'));
    const compelLogs = allServerLogs.filter(l => l.includes('Compel triggered'));
    const recoveryLogs = allServerLogs.filter(l => l.includes('Scene recovery'));
    const skillMasteryLogs = allServerLogs.filter(l => l.includes('skill mastery'));
    const worldBibleLogs = allServerLogs.filter(l => l.includes('[world-bible]') || l.includes('world bible'));
    const observerMemoryLogs = allServerLogs.filter(l => l.includes('storeObservation') || l.includes('observed') || l.includes('cross-character'));
    const takenOutLogs = allServerLogs.filter(l => l.includes('taken out') || l.includes('Taken out'));
    const recoveryBoostLogs = allServerLogs.filter(l => l.includes('Low-trust recovery boost'));

    // ---- Summary ----
    console.log('\n========================================');
    console.log('  LONG MULTI-CHARACTER STRESS TEST REPORT');
    console.log('========================================\n');

    console.log(`Turns completed: ${turnsCompleted}/${TOTAL_TURNS}`);
    console.log(`Game ended naturally: ${gameEndedNaturally}`);
    console.log(`Scene transitions: ${scenesCompleted}`);
    for (const st of sceneTransitions) {
      console.log(`  Turn ${st.turn}: scene ${st.from} → ${st.to} — "${st.summary.slice(0, 80)}"`);
    }

    // Trust analysis
    console.log('\n--- TRUST ANALYSIS ---');
    const gTrust = trustHistory.garrick;
    const eTrust = trustHistory.elara;
    console.log(`Garrick trust history (${gTrust.length} samples): [${gTrust.map(t => t.toFixed(2)).join(', ')}]`);
    console.log(`Elara trust history (${eTrust.length} samples):   [${eTrust.map(t => t.toFixed(2)).join(', ')}]`);

    if (gTrust.length > 0 && eTrust.length > 0) {
      const gFinal = gTrust[gTrust.length - 1];
      const eFinal = eTrust[eTrust.length - 1];
      console.log(`Final trust — Garrick: ${gFinal.toFixed(2)}, Elara: ${eFinal.toFixed(2)}`);

      // Phase A check: Garrick should have higher trust (good whispers)
      const gPhaseA = gTrust.filter((_, i) => i < 5);
      const ePhaseA = eTrust.filter((_, i) => i < 5);
      if (gPhaseA.length > 0 && ePhaseA.length > 0) {
        const gAvgA = gPhaseA.reduce((a, b) => a + b, 0) / gPhaseA.length;
        const eAvgA = ePhaseA.reduce((a, b) => a + b, 0) / ePhaseA.length;
        console.log(`Phase A avg trust — Garrick: ${gAvgA.toFixed(2)}, Elara: ${eAvgA.toFixed(2)}`);
        if (gAvgA < eAvgA) {
          findings.push(`ISSUE: Phase A (good→Garrick, bad→Elara) but Garrick avg trust (${gAvgA.toFixed(2)}) < Elara (${eAvgA.toFixed(2)})`);
        }
      }

      // Crossover check: track most recent trust for each character
      let crossoverTurn = -1;
      let latestG = gTrust[0], latestE = eTrust[0];
      let prevGarrickHigher: boolean | null = null;
      for (const entry of turnLog) {
        if (entry.char === 'garrick') latestG = entry.trust;
        else latestE = entry.trust;
        if (latestG !== undefined && latestE !== undefined) {
          const garrickHigher = latestG > latestE;
          if (prevGarrickHigher !== null && garrickHigher !== prevGarrickHigher) {
            crossoverTurn = entry.turn;
          }
          prevGarrickHigher = garrickHigher;
        }
      }
      if (crossoverTurn > 0) {
        console.log(`Trust crossover detected at turn ${crossoverTurn}`);
      } else {
        console.log('No trust crossover detected');
        if (turnsCompleted >= 20) {
          findings.push('ISSUE: No trust crossover after 20+ turns — expected crossover during Phase B reversal');
        }
      }
    } else {
      findings.push('ISSUE: No trust history recorded — character-state-update messages missing');
    }

    // Turn balance
    const garrickTurns = turnLog.filter(t => t.char === 'garrick').length;
    const elaraTurns = turnLog.filter(t => t.char === 'elara').length;
    console.log(`\n--- TURN BALANCE ---`);
    console.log(`Garrick turns: ${garrickTurns}, Elara turns: ${elaraTurns}`);
    if (garrickTurns === 0) findings.push('BUG: Garrick never got a turn');
    if (elaraTurns === 0) findings.push('BUG: Elara never got a turn');
    if (Math.abs(garrickTurns - elaraTurns) > 3) {
      findings.push(`ISSUE: Turn imbalance — garrick ${garrickTurns} vs elara ${elaraTurns}`);
    }

    // Whisper influence
    console.log('\n--- WHISPER INFLUENCE ---');
    const influenceCounts: Record<string, Record<string, number>> = {
      garrick: { followed: 0, 'partially-followed': 0, ignored: 0, none: 0 },
      elara: { followed: 0, 'partially-followed': 0, ignored: 0, none: 0 },
    };
    for (const entry of turnLog) {
      influenceCounts[entry.char][entry.influence] = (influenceCounts[entry.char][entry.influence] || 0) + 1;
    }
    for (const char of ['garrick', 'elara']) {
      const c = influenceCounts[char];
      console.log(`${char}: followed=${c.followed}, partial=${c['partially-followed']}, ignored=${c.ignored}, none=${c.none}`);
    }

    // FP economy
    console.log('\n--- FP ECONOMY ---');
    console.log(`Aspect invocations: ${aspectInvokeLogs.length}`);
    console.log(`Auto-invokes: ${autoInvokeLogs.length}`);
    console.log(`Skill mastery invokes: ${skillMasteryLogs.length}`);
    console.log(`Compels: ${compelLogs.length}`);
    aspectInvokeLogs.slice(0, 10).forEach(l => console.log(`  ${l.slice(0, 150)}`));
    skillMasteryLogs.forEach(l => console.log(`  SKILL MASTERY: ${l.slice(0, 150)}`));
    compelLogs.slice(0, 10).forEach(l => console.log(`  ${l.slice(0, 150)}`));
    if (aspectInvokeLogs.length + autoInvokeLogs.length + skillMasteryLogs.length === 0 && turnsCompleted >= 15) {
      findings.push('ISSUE: No FP spending events in 15+ turns');
    }
    if (compelLogs.length === 0 && turnsCompleted >= 15) {
      findings.push('ISSUE: No compels in 15+ turns — FP earning may be broken');
    }
    if (skillMasteryLogs.length === 0 && turnsCompleted >= 15) {
      findings.push('ISSUE: No skill mastery invokes — Elara Lore+4 should trigger against Good+ difficulty');
    }

    // Compaction + memory
    console.log('\n--- CONTEXT MANAGEMENT ---');
    console.log(`Compaction events: ${compactionLogs.length}`);
    compactionLogs.forEach(l => console.log(`  ${l.slice(0, 120)}`));
    console.log(`Fact extractions: ${factLogs.length}`);
    console.log(`Memory extractions: ${memoryLogs.length}`);
    console.log(`Observer/cross-character memories: ${observerMemoryLogs.length}`);
    if (compactionLogs.length === 0 && turnsCompleted >= 15) {
      findings.push('ISSUE: No compaction events with 2 chars in 15+ turns — should hit 35-msg threshold');
    }

    // Trust recovery boost
    console.log('\n--- TRUST RECOVERY BOOST ---');
    console.log(`Low-trust recovery boosts: ${recoveryBoostLogs.length}`);
    recoveryBoostLogs.forEach(l => console.log(`  ${l.slice(0, 150)}`));

    // Recovery + taken out
    console.log('\n--- STRESS / RECOVERY ---');
    console.log(`Scene recoveries: ${recoveryLogs.length}`);
    console.log(`Taken out events: ${takenOutLogs.length}`);

    // World bible
    console.log('\n--- WORLD BIBLE ---');
    console.log(`World bible log entries: ${worldBibleLogs.length}`);
    worldBibleLogs.slice(0, 10).forEach(l => console.log(`  ${l.slice(0, 120)}`));

    // Turn-by-turn log
    console.log('\n--- FULL TURN LOG ---');
    for (const entry of turnLog) {
      console.log(`  T${String(entry.turn).padStart(2)}[${entry.phase}] ${entry.char.padEnd(7)} trust=${entry.trust.toFixed(2)} [${entry.influence.padEnd(18)}] ${entry.whisperType.padEnd(5)} — "${entry.action}"`);
    }

    // Final findings
    console.log(`\n--- FINDINGS (${findings.length}) ---`);
    if (findings.length === 0) {
      console.log('  None! All systems nominal.');
    } else {
      findings.forEach(f => console.log(`  - ${f}`));
    }

    // Assertions
    expect(turnsCompleted).toBeGreaterThanOrEqual(10);
    if (garrickTurns > 0 && elaraTurns > 0) {
      expect(Math.abs(garrickTurns - elaraTurns)).toBeLessThanOrEqual(5);
    }

    host.close(); p1.close(); p2.close();
  }, 1_200_000); // 20 minutes for 30 turns at ~20-30s each
});
