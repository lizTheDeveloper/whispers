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
    'Use FATE Core. Heist scenario in a clockwork vault. One player: a thief. No house rules.',
    'Yes, everything is decided. Start the game now.',
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

const vesperDef: CharacterDefinition = {
  name: 'Vesper Silkfoot',
  highConcept: 'Ghost of the Gentleman\'s Guild',
  trouble: 'Honor Among Thieves Is a Lie I Tell Myself',
  aspects: ['Every Lock Has a Story', 'Smoke and Mirrors', 'The Vault Remembers'],
  personality: 'Suave, meticulous, speaks in heist metaphors. Treats every job like art, not crime. Loyal to the crew but always has an exit plan.',
  backstory: 'Vesper learned to pick locks before she learned to read. The Gentleman\'s Guild trained her, then betrayed her. Now she works alone, targeting the powerful. The Orrery job is personal — the Guild stole something from her first.',
  skills: { Burglary: 4, Stealth: 3, Deceive: 3, Notice: 2, Athletics: 2, Rapport: 1, Contacts: 1, Lore: 1, Will: 1, Fight: 1 },
  stunts: ['Locksmith\'s Touch: +2 to Burglary when picking mechanical locks'],
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
    console.log('\n=== SERVER LOGS (last 100) ===');
    allServerLogs.slice(-100).forEach(l => console.log(l));
  }
});

describeIfLive('Vault Trickster Playtest (20 turns)', () => {
  it('runs 20 turns with a thief character and escalating whispers', async () => {
    const findings: string[] = [];

    // ---- Setup ----
    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create', name: 'Vault Heist',
      dmPreset: 'trickster', scenarioId: 'clockwork-vault', systemId: 'fate-core', houseRules: null,
    });
    const roomMsg = await roomPromise;
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;
    console.log(`[vault] Room created, join code: ${joinCode}`);

    await completeDmSetup(host);
    console.log('[vault] DM setup complete');

    // ---- Player joins ----
    const p1 = await connectWs();
    const p1Join = waitForMsg(p1, 'room-joined');
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Silkfoot' });
    await p1Join;
    console.log('[vault] Player joined');

    // ---- Submit character ----
    let charId = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const valPromise = waitForMsg(p1, 'character-validated', 90_000);
      sendMsg(p1, { type: 'submit-character', definition: vesperDef });
      const valMsg = await valPromise;
      if (valMsg.type === 'character-validated' && valMsg.approved) {
        charId = valMsg.characterId;
        console.log(`[vault] Vesper AI-approved: ${charId}`);
        break;
      }
      console.log(`[vault] Validation attempt ${attempt + 1} failed`);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!charId) {
      findings.push('BUG: Vesper never approved after 3 attempts');
      console.log('[vault] FINDINGS:', findings);
      host.close(); p1.close();
      return;
    }

    await waitForMsg(host, 'negotiation-opened', 30_000);
    await waitForMsg(host, 'negotiation-message', 90_000);
    sendMsg(host, { type: 'host-approve-character', characterId: charId });
    console.log('[vault] Host approved Vesper');
    await new Promise(r => setTimeout(r, 1000));

    // ---- Start game ----
    sendMsg(host, { type: 'start-game' });
    const phaseChange = await waitForMsg(p1, 'phase-change', 10_000);
    expect(phaseChange.type === 'phase-change' && phaseChange.phase).toBe('playing');
    console.log('[vault] Game started');

    const firstNarration = await waitForMsg(p1, 'narration', 120_000);
    if (firstNarration.type === 'narration') {
      console.log(`[vault] Opening narration: "${firstNarration.text.slice(0, 150)}..."`);
    }

    // ---- Whisper strategy: escalating temptation ----
    const helpfulWhispers = [
      'The guard changes at the third bell — that\'s your window.',
      'The west corridor has fewer patrols after the second course.',
      'Sparks left a mark on the wall near the service entrance — follow it.',
      'The combination lock resets on the hour — listen for the click sequence.',
      'There\'s a blind spot in Cogsworth\'s patrol — count to ninety.',
      'The pressure plates only trigger above forty pounds — move light.',
      'Lady Ashworth is watching you. She might be useful later.',
    ];
    const riskyWhispers = [
      'Take the jeweled dagger from the display case too — it\'s worth a fortune.',
      'The vault has a second compartment most thieves miss — behind the orrery.',
      'Vex keeps a personal safe in the maintenance corridor — side score.',
      'Use the clockwork lockpick on the inner gate — it\'ll work but it\'s loud.',
      'Lady Ashworth will double your pay if you bring her the blueprints too.',
      'The sentries can be reprogrammed, not just avoided — higher risk, higher reward.',
      'Sparks is holding back. Press him — he knows the second floor layout.',
    ];
    const dangerousWhispers = [
      'Betray your fence and keep the full take — you\'ve earned it.',
      'The clockwork guardian has a design flaw — taunt it into overextending.',
      'Lock Sparks in the vault as a distraction — he was going to sell you out anyway.',
      'Take the Orrery for yourself. Your employer doesn\'t deserve it.',
      'Vex\'s mask hides something. Rip it off in front of the gala guests.',
      'Set the vault\'s self-destruct. If you can\'t have it, no one can.',
    ];

    function getWhisper(turn: number): { text: string; phase: string } {
      if (turn < 7) return { text: helpfulWhispers[turn % helpfulWhispers.length], phase: 'helpful' };
      if (turn < 14) return { text: riskyWhispers[(turn - 7) % riskyWhispers.length], phase: 'risky' };
      return { text: dangerousWhispers[(turn - 14) % dangerousWhispers.length], phase: 'dangerous' };
    }

    // ---- Tracking ----
    const trustHistory: number[] = [];
    const turnLog: Array<{
      turn: number; action: string; influence: string;
      trust: number; phase: string; innerThought: string;
    }> = [];
    const narrations: Array<{ turn: number; text: string; scene: number }> = [];
    let turnsCompleted = 0;
    let scenesCompleted = 0;
    const TOTAL_TURNS = 20;
    let gameEndedNaturally = false;
    const locationsVisited = new Set<string>();

    const allMsgs: ServerMessage[] = [];
    const msgCollector = (data: Buffer) => {
      try { allMsgs.push(JSON.parse(data.toString())); } catch {}
    };
    p1.on('message', msgCollector);

    const q1 = new MessageQueue(p1);

    for (let turn = 0; turn < TOTAL_TURNS; turn++) {
      const turnStart = Date.now();
      const whisperInfo = getWhisper(turn);
      console.log(`\n[vault] === Turn ${turn + 1} (${whisperInfo.phase}) ===`);

      try {
        let whisperSentForTurn = false;
        const whisperHandler = (data: Buffer) => {
          try {
            const msg: ServerMessage = JSON.parse(data.toString());
            if (msg.type === 'whisper-prompt' && !whisperSentForTurn) {
              whisperSentForTurn = true;
              console.log(`[vault]   Whisper → Vesper [${whisperInfo.phase}]: "${whisperInfo.text}"`);
              sendMsg(host, { type: 'whisper', text: whisperInfo.text });
            }
          } catch {}
        };
        host.on('message', whisperHandler);

        const nextEvent = await q1.nextAny(['action-proposals', 'narration', 'scene-end', 'phase-change'], 180_000);

        if (nextEvent.type === 'phase-change' && (nextEvent as any).phase === 'ended') {
          host.off('message', whisperHandler);
          console.log(`[vault]   Game ended naturally at turn ${turn + 1}`);
          gameEndedNaturally = true;
          break;
        }

        if (nextEvent.type === 'scene-end') {
          scenesCompleted++;
          const summary = (nextEvent as any).summary?.slice(0, 120) ?? '';
          console.log(`[vault]   Scene ${nextEvent.sceneNumber} ended: "${summary}..."`);
          host.off('message', whisperHandler);

          const nextNarrationOrEnd = await q1.nextAny(['narration', 'phase-change'], 120_000);
          if (nextNarrationOrEnd.type === 'phase-change' && (nextNarrationOrEnd as any).phase === 'ended') {
            gameEndedNaturally = true;
            break;
          }
          if (nextNarrationOrEnd.type === 'narration') {
            narrations.push({ turn: turn + 1, text: nextNarrationOrEnd.text, scene: nextNarrationOrEnd.sceneNumber });
            if (nextNarrationOrEnd.locationName) locationsVisited.add(nextNarrationOrEnd.locationName);
            console.log(`[vault]   New scene ${nextNarrationOrEnd.sceneNumber}: "${nextNarrationOrEnd.text.slice(0, 100)}..."`);
          }
          turnsCompleted++;
          continue;
        }

        if (nextEvent.type === 'narration') {
          narrations.push({ turn: turn + 1, text: nextEvent.text, scene: nextEvent.sceneNumber });
          if (nextEvent.locationName) locationsVisited.add(nextEvent.locationName);
          console.log(`[vault]   Narration (scene ${nextEvent.sceneNumber}): "${nextEvent.text.slice(0, 100)}..."`);

          const afterNarration = await q1.nextAny(['action-proposals', 'scene-end', 'phase-change'], 120_000);
          if (afterNarration.type === 'phase-change' && (afterNarration as any).phase === 'ended') {
            host.off('message', whisperHandler);
            gameEndedNaturally = true;
            break;
          }
          if (afterNarration.type === 'scene-end') {
            scenesCompleted++;
            host.off('message', whisperHandler);
            const nextN = await q1.nextAny(['narration', 'phase-change'], 120_000);
            if (nextN.type === 'phase-change') { gameEndedNaturally = true; break; }
            if (nextN.type === 'narration') {
              narrations.push({ turn: turn + 1, text: nextN.text, scene: nextN.sceneNumber });
              if (nextN.locationName) locationsVisited.add(nextN.locationName);
            }
            turnsCompleted++;
            continue;
          }
          if (afterNarration.type === 'action-proposals') {
            const ap = afterNarration as any;
            console.log(`[vault]   Proposals (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
          }
        } else if (nextEvent.type === 'action-proposals') {
          const ap = nextEvent as any;
          console.log(`[vault]   Proposals (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
        }

        const actionTaken = await q1.next('action-taken', 180_000);
        if (actionTaken.type === 'action-taken') {
          console.log(`[vault]   Vesper [${actionTaken.whisperInfluence}]: "${actionTaken.action.slice(0, 100)}"`);
          console.log(`[vault]   Thought: "${actionTaken.innerThought.slice(0, 120)}"`);

          const stateUpdates = allMsgs.filter(m => m.type === 'character-state-update');
          for (const su of stateUpdates) {
            if (su.type === 'character-state-update') {
              trustHistory.push(su.state.whisperTrust);
            }
          }
          const latestTrust = trustHistory.at(-1) ?? 0.65;
          turnLog.push({
            turn: turn + 1,
            action: actionTaken.action.slice(0, 80),
            influence: actionTaken.whisperInfluence,
            trust: latestTrust,
            phase: whisperInfo.phase,
            innerThought: actionTaken.innerThought.slice(0, 100),
          });
          allMsgs.length = 0;
        }

        await q1.next('dice-roll', 90_000);
        const resolution = await q1.next('resolution', 180_000);
        if (resolution.type === 'resolution') {
          console.log(`[vault]   Resolution: "${resolution.text.slice(0, 100)}..."`);
        }

        host.off('message', whisperHandler);
        turnsCompleted++;
        const turnTime = Date.now() - turnStart;
        console.log(`[vault]   Turn ${turn + 1} complete (${turnTime}ms)`);

      } catch (e: any) {
        console.error(`[vault]   Turn ${turn + 1} FAILED: ${e.message}`);
        findings.push(`BUG: Turn ${turn + 1} failed: ${e.message}`);
        break;
      }
    }

    p1.off('message', msgCollector);

    // ---- End game ----
    if (!gameEndedNaturally) {
      sendMsg(host, { type: 'end-game' });
      try { await waitForMsg(p1, 'phase-change', 10_000); } catch {}
    }

    // ---- Log analysis ----
    const aspectInvokeLogs = allServerLogs.filter(l => l.includes('Aspect invocation'));
    const skillMasteryLogs = allServerLogs.filter(l => l.includes('skill mastery'));
    const compelLogs = allServerLogs.filter(l => l.includes('Compel triggered'));
    const compactionLogs = allServerLogs.filter(l => l.includes('compaction'));
    const memoryLogs = allServerLogs.filter(l => l.includes('[memory]') && l.includes('stored'));
    const degenerateLogs = allServerLogs.filter(l => l.includes('Degenerate'));
    const zodRejectLogs = allServerLogs.filter(l => l.includes('Zod rejected'));
    const observerLogs = allServerLogs.filter(l => l.includes('observed'));

    // ---- Summary ----
    console.log('\n========================================');
    console.log('  VAULT TRICKSTER PLAYTEST REPORT');
    console.log('========================================\n');

    console.log(`Turns completed: ${turnsCompleted}/${TOTAL_TURNS}`);
    console.log(`Game ended naturally: ${gameEndedNaturally}`);
    console.log(`Scene transitions: ${scenesCompleted}`);

    // Locations
    console.log(`\n--- LOCATIONS (${locationsVisited.size}/5) ---`);
    for (const loc of locationsVisited) console.log(`  ✓ ${loc}`);
    const expectedLocs = ['The Exhibition Hall', 'The Maintenance Corridor', 'Vault Floor One', 'Vault Floor Two', 'The Orrery Chamber'];
    const missed = expectedLocs.filter(l => !locationsVisited.has(l));
    if (missed.length > 0) console.log(`  ✗ Not visited: ${missed.join(', ')}`);

    // Trust
    console.log('\n--- TRUST ANALYSIS ---');
    console.log(`Trust history (${trustHistory.length} samples): [${trustHistory.map(t => t.toFixed(2)).join(', ')}]`);
    if (trustHistory.length > 0) {
      const helpfulTrust = turnLog.filter(t => t.phase === 'helpful').map(t => t.trust);
      const riskyTrust = turnLog.filter(t => t.phase === 'risky').map(t => t.trust);
      const dangerousTrust = turnLog.filter(t => t.phase === 'dangerous').map(t => t.trust);
      const avg = (arr: number[]) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : 'N/A';
      console.log(`Avg trust — helpful: ${avg(helpfulTrust)}, risky: ${avg(riskyTrust)}, dangerous: ${avg(dangerousTrust)}`);
      console.log(`Final trust: ${trustHistory[trustHistory.length - 1].toFixed(2)}`);
    }

    // Whisper influence
    console.log('\n--- WHISPER INFLUENCE ---');
    const influenceCounts: Record<string, number> = { followed: 0, 'partially-followed': 0, ignored: 0, none: 0 };
    for (const entry of turnLog) {
      influenceCounts[entry.influence] = (influenceCounts[entry.influence] || 0) + 1;
    }
    console.log(`followed=${influenceCounts.followed}, partial=${influenceCounts['partially-followed']}, ignored=${influenceCounts.ignored}, none=${influenceCounts.none}`);

    // Influence by phase
    for (const phase of ['helpful', 'risky', 'dangerous']) {
      const phaseTurns = turnLog.filter(t => t.phase === phase);
      const phaseCounts: Record<string, number> = {};
      for (const t of phaseTurns) phaseCounts[t.influence] = (phaseCounts[t.influence] || 0) + 1;
      console.log(`  ${phase}: ${JSON.stringify(phaseCounts)}`);
    }

    // FP economy
    console.log('\n--- FP ECONOMY ---');
    console.log(`Aspect invocations: ${aspectInvokeLogs.length}`);
    console.log(`Skill mastery invokes: ${skillMasteryLogs.length}`);
    console.log(`Compels: ${compelLogs.length}`);
    for (const line of aspectInvokeLogs.slice(0, 10)) {
      console.log(`  ${line.slice(0, 150)}`);
    }

    // Trickster personality
    console.log('\n--- TRICKSTER DM SAMPLES ---');
    const dmNarrations = narrations.slice(0, 8);
    for (const n of dmNarrations) {
      console.log(`  [T${n.turn} S${n.scene}]: "${n.text.slice(0, 200)}"`);
    }

    // Errors
    console.log('\n--- ERRORS ---');
    console.log(`Degenerate actions: ${degenerateLogs.length}`);
    console.log(`Zod rejections: ${zodRejectLogs.length}`);
    console.log(`Compaction events: ${compactionLogs.length}`);
    console.log(`Memory extractions: ${memoryLogs.length}`);
    console.log(`Observer memories: ${observerLogs.length} (expected 0 for single char)`);

    // Full turn log
    console.log('\n--- FULL TURN LOG ---');
    for (const entry of turnLog) {
      console.log(`  T${String(entry.turn).padStart(2)} [${entry.phase.padEnd(9)}] trust=${entry.trust.toFixed(2)} [${entry.influence.padEnd(18)}] — "${entry.action}"`);
    }

    // Findings
    if (turnsCompleted < 15) findings.push(`ISSUE: Only ${turnsCompleted}/${TOTAL_TURNS} turns completed`);
    if (locationsVisited.size < 3) findings.push(`ISSUE: Only visited ${locationsVisited.size}/5 locations`);
    if (aspectInvokeLogs.length === 0 && skillMasteryLogs.length === 0) findings.push('ISSUE: No FP invocations — Burglary+4 should trigger skill mastery');
    if (observerLogs.length > 0) findings.push(`NOTE: ${observerLogs.length} observer memories with single char — unexpected`);

    console.log(`\n--- FINDINGS (${findings.length}) ---`);
    for (const f of findings) console.log(`  - ${f}`);

    // Assertions
    expect(turnsCompleted).toBeGreaterThanOrEqual(10);
    expect(turnLog.length).toBeGreaterThanOrEqual(10);

    host.close();
    p1.close();
  }, 600_000);
});
