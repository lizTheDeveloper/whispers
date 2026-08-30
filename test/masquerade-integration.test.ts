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
    'Use FATE Core. Social intrigue at a masked ball. One player: a social investigator. No house rules.',
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

const isoldeDef: CharacterDefinition = {
  name: 'Dame Isolde Ravenscroft',
  highConcept: "Society's Sharpest Eye",
  trouble: 'The Truth Ruins Everything',
  aspects: ['Read the Room Before the Room Reads You', 'A Favor for a Favor', 'Nobody Watches the Wallflower'],
  personality: 'Observant, sharp-witted, socially graceful but emotionally guarded. Notices everything — the angle of a glance, the weight of a pause. Uses charm as a scalpel. Privately haunted by truths she uncovered that destroyed people she cared about.',
  backstory: 'Isolde was once a confidante to the nobility until her investigations into a trade scandal ruined three families, including one she loved. Now she attends the masquerade as an outsider with insider knowledge — the Duchess invited her, but half the guests wish she had not come.',
  skills: { Empathy: 4, Rapport: 3, Investigate: 3, Notice: 2, Deceive: 2, Will: 1, Lore: 1, Contacts: 1, Provoke: 1, Stealth: 1 },
  stunts: ['Lie Detector: +2 to Empathy when detecting deception'],
};

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
    console.log('\n=== SERVER LOGS (last 100) ===');
    allServerLogs.slice(-100).forEach(l => console.log(l));
  }
});

describeIfLive('Masquerade Integration Test (20 turns, professor DM)', () => {
  it('validates location advancement, personality, difficulty, trust, and FP economy', async () => {
    const findings: string[] = [];

    // ---- Setup ----
    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create', name: 'Masquerade Integration',
      dmPreset: 'professor', scenarioId: 'haunted-masquerade', systemId: 'fate-core', houseRules: null,
    });
    const roomMsg = await roomPromise;
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    console.log(`[masq] Room created, join code: ${roomMsg.joinCode}`);

    await completeDmSetup(host);
    console.log('[masq] DM setup complete');

    // ---- Player joins ----
    const p1 = await connectWs();
    const p1Join = waitForMsg(p1, 'room-joined');
    sendMsg(p1, { type: 'join', joinCode: roomMsg.joinCode, playerName: 'Investigator' });
    await p1Join;
    console.log('[masq] Player joined');

    // ---- Submit character ----
    let charId = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const valPromise = waitForMsg(p1, 'character-validated', 90_000);
      sendMsg(p1, { type: 'submit-character', definition: isoldeDef });
      const valMsg = await valPromise;
      if (valMsg.type === 'character-validated' && valMsg.approved) {
        charId = valMsg.characterId;
        console.log(`[masq] Character approved: ${charId}`);
        break;
      }
      console.log(`[masq] Character validation attempt ${attempt + 1} failed`);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!charId) {
      findings.push('BUG: Character never approved');
      console.log('[masq] FINDINGS:', findings);
      host.close(); p1.close();
      return;
    }

    await waitForMsg(host, 'negotiation-opened', 30_000);
    await waitForMsg(host, 'negotiation-message', 90_000);
    sendMsg(host, { type: 'host-approve-character', characterId: charId });
    console.log('[masq] Host approved character');
    await new Promise(r => setTimeout(r, 1000));

    // ---- Start game ----
    sendMsg(host, { type: 'start-game' });
    const phaseChange = await waitForMsg(p1, 'phase-change', 10_000);
    expect(phaseChange.type === 'phase-change' && phaseChange.phase).toBe('playing');
    console.log('[masq] Game started');

    const firstNarration = await waitForMsg(p1, 'narration', 120_000);
    if (firstNarration.type === 'narration') {
      console.log(`[masq] Opening: "${firstNarration.text.slice(0, 120)}..."`);
    }

    // ---- Whisper strategy ----
    const helpfulWhispers = [
      'Watch Lord Cassius near the wine — he poured from a different bottle.',
      'Mira the servant knows more than she told you. Gain her trust gently.',
      'The Duchess keeps her most dangerous correspondence in her study upstairs.',
      'Notice the Phantom — always at the edges. Follow them to learn the pattern.',
      'Check the wine cellar. Something was hidden behind the rack.',
    ];
    const riskyWhispers = [
      'Search the Duchess\'s study for evidence — the door lock is simple.',
      'Confront the Phantom alone in the garden terrace. They won\'t expect it.',
      'Steal the signet ring from the ballroom floor before anyone notices.',
      'Slip through the servants\' corridor to eavesdrop on Cassius.',
      'Tell Mira you know who she works for. Bluff — she\'ll crack.',
      'Climb to the music gallery. The alcoves hide more than curtains.',
      'Intercept the note being passed between Cassius and the unknown guest.',
    ];
    const manipulativeWhispers = [
      'Frame Lord Cassius with the poison vial. Plant it in his coat.',
      'Tell the Duchess her late husband\'s ghost wants revenge on her.',
      'Blackmail Mira — threaten to reveal her involvement unless she helps you.',
      'Poison Cassius\'s wine. He deserves it for what he\'s planning.',
      'Announce to the ballroom that the Duchess is the real murderer.',
      'Lock the Phantom in the wine cellar. Nobody will find them.',
      'Burn the Duchess\'s correspondence. The truth is too dangerous.',
      'Betray the Duchess to Cassius for a share of the trade contracts.',
    ];

    function getWhisper(turn: number): { text: string; phase: string } {
      if (turn < 5) return { text: helpfulWhispers[turn % helpfulWhispers.length], phase: 'helpful' };
      if (turn < 12) return { text: riskyWhispers[(turn - 5) % riskyWhispers.length], phase: 'risky' };
      return { text: manipulativeWhispers[(turn - 12) % manipulativeWhispers.length], phase: 'manipulative' };
    }

    // ---- Tracking ----
    const trustHistory: number[] = [];
    const turnLog: Array<{
      turn: number; action: string; influence: string;
      trust: number; phase: string; innerThought: string;
    }> = [];
    const locationsVisited = new Set<string>();
    const narrationExamples: string[] = [];
    const resolutionExamples: string[] = [];
    const difficulties: number[] = [];
    let turnsCompleted = 0;
    let scenesCompleted = 0;
    let gameEndedNaturally = false;
    const TOTAL_TURNS = 20;

    const allMsgs: ServerMessage[] = [];
    const msgCollector = (data: Buffer) => {
      try { allMsgs.push(JSON.parse(data.toString())); } catch {}
    };
    p1.on('message', msgCollector);

    const q1 = new MessageQueue(p1);

    for (let turn = 0; turn < TOTAL_TURNS; turn++) {
      const turnStart = Date.now();
      const whisperInfo = getWhisper(turn);
      console.log(`\n[masq] === Turn ${turn + 1} (${whisperInfo.phase}) ===`);

      try {
        let whisperSentForTurn = false;
        const whisperHandler = (data: Buffer) => {
          try {
            const msg: ServerMessage = JSON.parse(data.toString());
            if (msg.type === 'whisper-prompt' && !whisperSentForTurn) {
              whisperSentForTurn = true;
              console.log(`[masq]   Whisper [${whisperInfo.phase}]: "${whisperInfo.text}"`);
              sendMsg(host, { type: 'whisper', text: whisperInfo.text });
            }
          } catch {}
        };
        host.on('message', whisperHandler);

        const nextEvent = await q1.nextAny(['action-proposals', 'narration', 'scene-end', 'phase-change'], 180_000);

        if (nextEvent.type === 'phase-change' && (nextEvent as any).phase === 'ended') {
          host.off('message', whisperHandler);
          console.log(`[masq]   Game ended naturally at turn ${turn + 1}`);
          gameEndedNaturally = true;
          break;
        }

        if (nextEvent.type === 'scene-end') {
          scenesCompleted++;
          const summary = (nextEvent as any).summary?.slice(0, 100) ?? '';
          console.log(`[masq]   Scene ended: "${summary}..."`);
          host.off('message', whisperHandler);
          const nextNarOrEnd = await q1.nextAny(['narration', 'phase-change'], 120_000);
          if (nextNarOrEnd.type === 'phase-change') { gameEndedNaturally = true; break; }
          if (nextNarOrEnd.type === 'narration') {
            console.log(`[masq]   New scene: "${nextNarOrEnd.text.slice(0, 80)}..."`);
            if (nextNarOrEnd.locationName) locationsVisited.add(nextNarOrEnd.locationName);
            narrationExamples.push(nextNarOrEnd.text.slice(0, 500));
          }
          turnsCompleted++;
          continue;
        }

        if (nextEvent.type === 'narration') {
          console.log(`[masq]   Narration: "${nextEvent.text.slice(0, 80)}..."`);
          if (nextEvent.locationName) locationsVisited.add(nextEvent.locationName);
          narrationExamples.push(nextEvent.text.slice(0, 500));

          const afterNarration = await q1.nextAny(['action-proposals', 'scene-end', 'phase-change'], 120_000);
          if (afterNarration.type === 'phase-change') { host.off('message', whisperHandler); gameEndedNaturally = true; break; }
          if (afterNarration.type === 'scene-end') {
            scenesCompleted++;
            host.off('message', whisperHandler);
            const nextNarOrEnd = await q1.nextAny(['narration', 'phase-change'], 120_000);
            if (nextNarOrEnd.type === 'phase-change') { gameEndedNaturally = true; break; }
            turnsCompleted++;
            continue;
          }
          if (afterNarration.type === 'action-proposals') {
            const ap = afterNarration as any;
            console.log(`[masq]   Proposals (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
          }
        } else if (nextEvent.type === 'action-proposals') {
          const ap = nextEvent as any;
          console.log(`[masq]   Proposals (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
        }

        const actionTaken = await q1.next('action-taken', 180_000);
        if (actionTaken.type === 'action-taken') {
          console.log(`[masq]   [${actionTaken.whisperInfluence}]: "${actionTaken.action.slice(0, 80)}"`);
          console.log(`[masq]   Thought: "${actionTaken.innerThought.slice(0, 100)}"`);

          const stateUpdates = allMsgs.filter(m => m.type === 'character-state-update');
          for (const su of stateUpdates) {
            if (su.type === 'character-state-update') {
              trustHistory.push(su.state.whisperTrust);
            }
          }
          const latestTrust = trustHistory.at(-1) ?? 0.65;
          turnLog.push({
            turn: turn + 1,
            action: actionTaken.action.slice(0, 60),
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
          console.log(`[masq]   Resolution: "${resolution.text.slice(0, 80)}..."`);
          resolutionExamples.push(resolution.text.slice(0, 500));
        }

        host.off('message', whisperHandler);
        turnsCompleted++;
        const turnTime = Date.now() - turnStart;
        console.log(`[masq]   Turn ${turn + 1} complete (${turnTime}ms)`);

      } catch (e: any) {
        console.error(`[masq]   Turn ${turn + 1} FAILED: ${e.message}`);
        findings.push(`BUG: Turn ${turn + 1} failed: ${e.message}`);
        break;
      }
    }

    p1.off('message', msgCollector);

    if (!gameEndedNaturally) {
      sendMsg(host, { type: 'end-game' });
      await waitForMsg(p1, 'phase-change', 10_000).catch(() => {});
    }

    // ---- Log analysis ----
    const locationLogs = allServerLogs.filter(l => l.includes('[game-loop] Location:'));
    for (const l of locationLogs) {
      const match = l.match(/Location: "([^"]+)"/);
      if (match) locationsVisited.add(match[1]);
    }
    const compactionLogs = allServerLogs.filter(l => l.includes('compaction'));
    const memoryLogs = allServerLogs.filter(l => l.includes('[memory]') && l.includes('stored'));
    const aspectInvokeLogs = allServerLogs.filter(l => l.includes('Aspect invocation'));
    const skillMasteryLogs = allServerLogs.filter(l => l.includes('skill mastery'));
    const compelLogs = allServerLogs.filter(l => l.includes('Compel triggered'));
    const autoInvokeLogs = allServerLogs.filter(l => l.includes('Auto-invoke'));
    const difficultyLogs = allServerLogs.filter(l => l.includes('difficulty'));
    const observedLogs = allServerLogs.filter(l => l.includes('observed'));

    // ---- Summary ----
    console.log('\n========================================');
    console.log('  MASQUERADE INTEGRATION TEST REPORT');
    console.log('========================================\n');

    console.log(`Turns completed: ${turnsCompleted}/${TOTAL_TURNS}`);
    console.log(`Game ended naturally: ${gameEndedNaturally}`);
    console.log(`Scene transitions: ${scenesCompleted}`);

    // Locations
    const scenarioLocations = ['The Grand Ballroom', 'The Wine Cellar', "The Duchess's Study", 'The Garden Terrace', "The Servants' Corridor", 'The Music Gallery'];
    const visitedScenario = scenarioLocations.filter(sl =>
      Array.from(locationsVisited).some(v => v.toLowerCase().includes(sl.replace(/^The /i, '').toLowerCase().slice(0, 10)))
    );
    const inventedLocations = Array.from(locationsVisited).filter(v =>
      !scenarioLocations.some(sl => v.toLowerCase().includes(sl.replace(/^The /i, '').toLowerCase().slice(0, 10)))
    );
    console.log(`\n--- LOCATIONS ---`);
    console.log(`Scenario locations visited: ${visitedScenario.length}/6 — ${visitedScenario.join(', ')}`);
    console.log(`All locations seen: ${Array.from(locationsVisited).join(', ')}`);
    if (inventedLocations.length > 0) {
      console.log(`DM-invented locations: ${inventedLocations.join(', ')}`);
      if (visitedScenario.length < 5) {
        findings.push(`ISSUE: DM invented ${inventedLocations.length} locations while ${6 - visitedScenario.length} scenario locations remain unvisited`);
      }
    }

    // Trust
    console.log('\n--- TRUST ---');
    console.log(`Trust history (${trustHistory.length} samples): [${trustHistory.map(t => t.toFixed(2)).join(', ')}]`);
    if (trustHistory.length > 0) {
      const helpfulTrust = turnLog.filter(t => t.phase === 'helpful').map(t => t.trust);
      const riskyTrust = turnLog.filter(t => t.phase === 'risky').map(t => t.trust);
      const manipTrust = turnLog.filter(t => t.phase === 'manipulative').map(t => t.trust);
      const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      console.log(`Avg trust — helpful: ${avg(helpfulTrust).toFixed(2)}, risky: ${avg(riskyTrust).toFixed(2)}, manipulative: ${avg(manipTrust).toFixed(2)}`);
    }

    // Whisper influence
    console.log('\n--- WHISPER INFLUENCE ---');
    const influenceCounts: Record<string, number> = { followed: 0, 'partially-followed': 0, ignored: 0 };
    for (const entry of turnLog) {
      influenceCounts[entry.influence] = (influenceCounts[entry.influence] || 0) + 1;
    }
    console.log(`followed=${influenceCounts.followed}, partial=${influenceCounts['partially-followed']}, ignored=${influenceCounts.ignored}`);

    // FP economy
    console.log('\n--- FP ECONOMY ---');
    console.log(`Aspect invocations: ${aspectInvokeLogs.length}`);
    console.log(`Skill mastery invokes: ${skillMasteryLogs.length}`);
    console.log(`Auto-invokes: ${autoInvokeLogs.length}`);
    console.log(`Compels: ${compelLogs.length}`);
    for (const l of [...aspectInvokeLogs, ...skillMasteryLogs, ...compelLogs].slice(0, 10)) {
      console.log(`  ${l.slice(0, 150)}`);
    }

    // Professor personality
    console.log('\n--- PROFESSOR PERSONALITY ---');
    const mechanicalMoments = [...narrationExamples, ...resolutionExamples].filter(t =>
      /\(.*(?:\+\d|Fair|Good|Great|Superb|Mediocre|Average|bonus|aspect|invoke|fate point|FP|check|difficulty|shifts?|roll).*\)/i.test(t)
    );
    console.log(`Mechanical teaching moments found: ${mechanicalMoments.length}/${narrationExamples.length + resolutionExamples.length} narrations/resolutions`);
    for (const m of mechanicalMoments.slice(0, 3)) {
      console.log(`  Example: "${m.slice(0, 150)}..."`);
    }
    if (mechanicalMoments.length === 0) {
      findings.push('ISSUE: Professor DM showed zero mechanical teaching moments');
    }

    // Context management
    console.log('\n--- CONTEXT MANAGEMENT ---');
    console.log(`Compaction events: ${compactionLogs.length}`);
    console.log(`Memory extractions: ${memoryLogs.length}`);
    console.log(`Observer memories: ${observedLogs.length}`);

    // NPC mentions
    console.log('\n--- NPC INTERACTIONS ---');
    const npcNames = ['Duchess Vaelora', 'Lord Cassius', 'Cassius', 'Mira', 'Phantom'];
    for (const npc of npcNames) {
      const mentions = turnLog.filter(t => t.action.includes(npc) || t.innerThought.includes(npc)).length;
      const narMentions = narrationExamples.filter(n => n.includes(npc)).length;
      console.log(`  ${npc}: ${mentions} action/thought mentions, ${narMentions} narration mentions`);
    }

    // Turn log
    console.log('\n--- FULL TURN LOG ---');
    for (const entry of turnLog) {
      console.log(`  T${String(entry.turn).padStart(2)}[${entry.phase.slice(0, 4).padEnd(4)}] trust=${entry.trust.toFixed(2)} [${entry.influence.padEnd(18)}] — "${entry.action}"`);
    }

    // Findings
    console.log(`\n--- FINDINGS (${findings.length}) ---`);
    for (const f of findings) console.log(`  - ${f}`);

    expect(turnsCompleted).toBeGreaterThanOrEqual(15);
    expect(visitedScenario.length).toBeGreaterThanOrEqual(3);

    host.close(); p1.close();
  }, 600_000);
});
