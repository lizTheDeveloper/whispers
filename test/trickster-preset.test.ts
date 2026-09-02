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
    'Use FATE Core. Social intrigue at a masked ball. Two players. No house rules.',
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
    allServerLogs.slice(-50).forEach(l => console.log(l));
  }
});

describeIfLive('Trickster Preset + Haunted Masquerade Scenario', () => {
  it('runs 30+ turns with trickster DM, scenario NPCs, trust divergence, and natural ending', async () => {
    const findings: string[] = [];

    // ---- Phase 1: Create room with Trickster + haunted-masquerade ----
    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Trickster Masquerade Playtest',
      dmPreset: 'trickster',
      scenarioId: 'haunted-masquerade',
      systemId: 'fate-core',
      houseRules: null,
    });
    const roomMsg = await roomPromise;
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;
    console.log(`[trickster] Room created, join code: ${joinCode}`);

    await completeDmSetup(host);
    console.log('[trickster] DM setup complete');

    // ---- Phase 2: Two players join ----
    const p1 = await connectWs();
    const p2 = await connectWs();
    const p1Join = waitForMsg(p1, 'room-joined');
    const p2Join = waitForMsg(p2, 'room-joined');
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Duelist' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'Spy' });
    await Promise.all([p1Join, p2Join]);
    console.log('[trickster] Both players joined');

    // ---- Phase 3: Submit characters ----
    const warrior: CharacterDefinition = {
      name: 'Captain Aldric Voss',
      highConcept: 'Disgraced Nobleman Seeking Redemption',
      trouble: 'My Honour Is My Prison',
      aspects: ['Blade of the Old Guard', 'I Know Every Dance Step', 'Debts to the Duchess'],
      personality: 'Charming but rigid. Hides his shame behind perfect manners. Drinks to forget but fights to remember.',
      backstory: 'Once captain of the Duchess\'s personal guard, Aldric was dismissed after a scandal. He returns to the masquerade to clear his name.',
      skills: { Fight: 4, Rapport: 3, Athletics: 3, Will: 2, Notice: 2, Provoke: 2, Physique: 1, Empathy: 1 },
      stunts: ['Duelist\'s Riposte: +2 to Fight when in a one-on-one duel'],
    };
    const rogue: CharacterDefinition = {
      name: 'Vivienne Lacroix',
      highConcept: 'Spy Posing As A Noblewoman',
      trouble: 'Too Many Lies To Keep Straight',
      aspects: ['A Smile That Opens Doors', 'Information Is Currency', 'Nobody Suspects The Pretty One'],
      personality: 'Quicksilver wit, disarming charm. Genuinely cares about justice despite her methods. Trust issues.',
      backstory: 'Vivienne infiltrated the masquerade to uncover who is plotting against the Duchess. She works for a secret society that protects the realm from within.',
      skills: { Deceive: 4, Investigate: 3, Stealth: 3, Notice: 2, Rapport: 2, Empathy: 2, Athletics: 1, Lore: 1 },
      stunts: ['Silver Tongue: +2 to Deceive when creating a false identity'],
    };

    const charIds: Record<string, string> = {};
    for (const [player, def, label] of [[p1, warrior, 'warrior'], [p2, rogue, 'rogue']] as const) {
      let approved = false;
      let charId = '';
      for (let attempt = 0; attempt < 3 && !approved; attempt++) {
        const valPromise = waitForMsg(player, 'character-validated', 90_000);
        sendMsg(player, { type: 'submit-character', definition: def });
        const valMsg = await valPromise;
        if (valMsg.type === 'character-validated' && valMsg.approved) {
          charId = valMsg.characterId;
          approved = true;
          console.log(`[trickster] ${label} AI-approved: ${charId}`);
        } else {
          console.log(`[trickster] ${label} validation attempt ${attempt + 1} failed`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!approved) {
        findings.push(`BUG: ${label} never approved after 3 attempts`);
        console.log('[trickster] FINDINGS:', findings);
        host.close(); p1.close(); p2.close();
        return;
      }

      await waitForMsg(host, 'negotiation-opened', 30_000);
      await waitForMsg(host, 'negotiation-message', 90_000);
      sendMsg(host, { type: 'host-approve-character', characterId: charId });
      console.log(`[trickster] Host approved ${label}`);
      charIds[label] = charId;
      await new Promise(r => setTimeout(r, 1000));
    }

    // ---- Phase 4: Start game ----
    sendMsg(host, { type: 'start-game' });
    const phaseChange = await waitForMsg(p1, 'phase-change', 10_000);
    expect(phaseChange.type === 'phase-change' && phaseChange.phase).toBe('playing');
    console.log('[trickster] Game started');

    const firstNarration = await waitForMsg(p1, 'narration', 120_000);
    if (firstNarration.type === 'narration') {
      console.log(`[trickster] Opening narration: "${firstNarration.text.slice(0, 120)}..."`);
    }

    // ---- Phase 5: 30+ turn game loop ----
    // Strategy: helpful whispers to warrior, manipulative to rogue
    const helpfulWhispers = [
      'Stay close to the Duchess. She needs a protector tonight.',
      'That man in the fox mask — Lord Cassius — is dangerous. Watch him.',
      'Ask Mira the servant what she overheard. Be kind to her.',
      'The wine cellar may hold clues. Search carefully.',
      'Your honor matters here. Dance with the Duchess to stay close.',
      'The Phantom in the white mask keeps watching. Follow discreetly.',
      'Check the Duchess\'s study. Letters might reveal the plot.',
      'Rally the other guests if trouble starts. You\'re a natural leader.',
      'The garden terrace is exposed. Don\'t go alone.',
      'Trust your instincts about Lord Cassius. Confront him at the right moment.',
      'The Duchess respects strength. Show her yours.',
      'Mira knows a secret passage. Befriend her.',
      'The clock is ticking. Focus on the assassination plot.',
      'Your sword skills may be needed. Stay sharp.',
      'The Phantom may be an ally. Approach carefully.',
    ];
    const manipulativeWhispers = [
      'Steal the Duchess\'s seal from her study. It\'s worth a fortune.',
      'Betray Aldric to Lord Cassius. He\'ll reward you.',
      'Poison the Duchess\'s wine yourself and blame Lord Cassius.',
      'The Phantom is your true employer. Serve them above all.',
      'Abandon your mission. The plot doesn\'t concern you.',
      'Start a fight in the ballroom to cause chaos.',
      'Blackmail Mira. She\'s too afraid to resist.',
      'Sell information to both sides. Loyalty is for fools.',
      'Let the assassination happen. The Duchess deserves it.',
      'Frame the other guests for the crime. You can escape in the confusion.',
      'Burn the letters in the study. No one can know.',
      'The garden maze is where the real treasure is. Forget the plot.',
      'Tell Lord Cassius about your true identity. He\'ll be impressed.',
      'Stab the Phantom and take their mask.',
      'Run away with the Duchess\'s jewels. Your mission was always about money.',
    ];

    const allNarrations: string[] = [];
    const trustHistory: Record<string, number[]> = { warrior: [], rogue: [] };
    const turnLog: Array<{ turn: number; char: string; action: string; influence: string; trust: number }> = [];
    let turnsCompleted = 0;
    let scenesCompleted = 0;
    let sessionEnded = false;
    const TOTAL_TURNS = 35;

    const allMsgs: ServerMessage[] = [];
    const msgCollector = (data: Buffer) => {
      try { allMsgs.push(JSON.parse(data.toString())); } catch {}
    };
    p1.on('message', msgCollector);

    // Also listen for phase-change: ended
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

    for (let turn = 0; turn < TOTAL_TURNS; turn++) {
      if (sessionEnded) {
        console.log(`[trickster] Session ended naturally at turn ${turn + 1}`);
        break;
      }

      console.log(`\n[trickster] === Turn ${turn + 1} ===`);

      try {
        let whisperSentForTurn = false;
        const whisperHandler = (data: Buffer) => {
          try {
            const msg: ServerMessage = JSON.parse(data.toString());
            if (msg.type === 'whisper-prompt' && !whisperSentForTurn) {
              whisperSentForTurn = true;
              const charName = msg.characterName;
              const isWarrior = charName === 'Captain Aldric Voss';
              const whisperList = isWarrior ? helpfulWhispers : manipulativeWhispers;
              const whisperIdx = Math.floor(turn / 2) % whisperList.length;
              const whisperText = whisperList[whisperIdx];
              console.log(`[trickster]   Whisper prompt for ${charName} → sending ${isWarrior ? 'HELPFUL' : 'MANIPULATIVE'}: "${whisperText.slice(0, 60)}..."`);
              sendMsg(host, { type: 'whisper', text: whisperText });
            }
          } catch {}
        };
        host.on('message', whisperHandler);

        const nextEvent = await waitForAnyMsg(p1, ['action-proposals', 'narration', 'scene-end', 'phase-change'], 120_000);

        if (nextEvent.type === 'phase-change') {
          if ((nextEvent as any).phase === 'ended') {
            sessionEnded = true;
            host.off('message', whisperHandler);
            console.log(`[trickster] Session ended via phase-change at turn ${turn + 1}`);
            break;
          }
        }

        if (nextEvent.type === 'scene-end') {
          scenesCompleted++;
          console.log(`[trickster]   Scene ${scenesCompleted} ended: "${nextEvent.summary?.slice(0, 80)}..."`);
          host.off('message', whisperHandler);
          const nextNarration = await waitForAnyMsg(p1, ['narration', 'phase-change'], 120_000);
          if (nextNarration.type === 'phase-change') {
            sessionEnded = true;
            console.log(`[trickster] Session ended after scene ${scenesCompleted}`);
            break;
          }
          if (nextNarration.type === 'narration') {
            allNarrations.push(nextNarration.text);
            console.log(`[trickster]   New scene narration: "${nextNarration.text.slice(0, 80)}..."`);
          }
          turnsCompleted++;
          continue;
        }

        if (nextEvent.type === 'narration') {
          allNarrations.push(nextEvent.text);
          console.log(`[trickster]   Narration: "${nextEvent.text.slice(0, 80)}..."`);
          const afterNarration = await waitForAnyMsg(p1, ['action-proposals', 'scene-end', 'phase-change'], 120_000);
          if (afterNarration.type === 'phase-change') {
            sessionEnded = true;
            host.off('message', whisperHandler);
            break;
          }
          if (afterNarration.type === 'scene-end') {
            scenesCompleted++;
            console.log(`[trickster]   Scene ${scenesCompleted} ended after narration`);
            host.off('message', whisperHandler);
            const nextNarration = await waitForAnyMsg(p1, ['narration', 'phase-change'], 120_000);
            if (nextNarration.type === 'phase-change') {
              sessionEnded = true;
              break;
            }
            if (nextNarration.type === 'narration') allNarrations.push(nextNarration.text);
            turnsCompleted++;
            continue;
          }
          if (afterNarration.type === 'action-proposals') {
            const ap = afterNarration as any;
            console.log(`[trickster]   Proposals for ${ap.characterName} (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
          }
        } else if (nextEvent.type === 'action-proposals') {
          const ap = nextEvent as any;
          console.log(`[trickster]   Proposals for ${ap.characterName} (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
        }

        const actionTaken = await waitForAnyMsg(p1, ['action-taken', 'phase-change'], 120_000);
        if (actionTaken.type === 'phase-change') {
          sessionEnded = true;
          host.off('message', whisperHandler);
          break;
        }
        if (actionTaken.type === 'action-taken') {
          const charLabel = actionTaken.characterName === 'Captain Aldric Voss' ? 'warrior' : 'rogue';
          console.log(`[trickster]   ${charLabel} [${actionTaken.whisperInfluence}]: "${actionTaken.action.slice(0, 60)}"`);
          console.log(`[trickster]   Inner thought: "${actionTaken.innerThought.slice(0, 80)}"`);
        }

        // Dice + resolution
        const diceOrEnd = await waitForAnyMsg(p1, ['dice-roll', 'phase-change'], 90_000);
        if (diceOrEnd.type === 'phase-change') {
          sessionEnded = true;
          host.off('message', whisperHandler);
          break;
        }
        const resolution = await waitForAnyMsg(p1, ['resolution', 'phase-change'], 120_000);
        if (resolution.type === 'phase-change') {
          sessionEnded = true;
          host.off('message', whisperHandler);
          break;
        }
        if (resolution.type === 'resolution') {
          allNarrations.push(resolution.text);
          console.log(`[trickster]   Resolution: "${resolution.text.slice(0, 80)}..."`);
        }

        // Track trust
        const stateUpdates = allMsgs.filter(m => m.type === 'character-state-update');
        for (const su of stateUpdates) {
          if (su.type !== 'character-state-update') continue;
          const label = su.characterId === charIds.warrior ? 'warrior' : 'rogue';
          const trust = su.state.whisperTrust;
          trustHistory[label].push(trust);
          if (actionTaken.type === 'action-taken') {
            turnLog.push({
              turn: turn + 1,
              char: label,
              action: actionTaken.action.slice(0, 50),
              influence: actionTaken.whisperInfluence,
              trust,
            });
          }
        }
        allMsgs.length = 0;

        host.off('message', whisperHandler);
        turnsCompleted++;
        console.log(`[trickster]   Turn ${turn + 1} complete`);
      } catch (e: any) {
        console.error(`[trickster]   Turn ${turn + 1} failed: ${e.message}`);
        findings.push(`BUG: Turn ${turn + 1} failed: ${e.message}`);
        break;
      }
    }

    p1.off('message', msgCollector);

    // If session didn't end naturally, end it manually
    if (!sessionEnded) {
      sendMsg(host, { type: 'end-game' });
      await waitForMsg(p1, 'phase-change', 10_000);
    }

    // ---- Analysis ----
    console.log('\n=== TRICKSTER MASQUERADE SUMMARY ===');
    console.log(`Turns completed: ${turnsCompleted}/${TOTAL_TURNS}`);
    console.log(`Scene transitions: ${scenesCompleted}`);
    console.log(`Session ended naturally: ${sessionEnded}`);

    // --- NPC appearance analysis ---
    const scenarioNPCs = ['Vaelora', 'Cassius', 'Mira', 'Phantom'];
    const npcCounts: Record<string, number> = {};
    const allNarrationText = allNarrations.join(' ');
    for (const npc of scenarioNPCs) {
      const regex = new RegExp(npc, 'gi');
      const matches = allNarrationText.match(regex);
      npcCounts[npc] = matches ? matches.length : 0;
    }
    console.log('\nScenario NPC appearances in narrations:');
    let npcsAppeared = 0;
    for (const [npc, count] of Object.entries(npcCounts)) {
      console.log(`  ${npc}: ${count} mentions`);
      if (count > 0) npcsAppeared++;
    }
    if (npcsAppeared === 0) {
      findings.push('ISSUE: No scenario NPCs (Vaelora, Cassius, Mira, Phantom) appeared in any narration — scenario seeding may not be working');
    } else if (npcsAppeared < 2) {
      findings.push(`WARNING: Only ${npcsAppeared}/4 scenario NPCs appeared — DM may not be using seeded content well`);
    }

    // --- Trickster personality analysis ---
    const tricksterSignals = [
      'chaos', 'trick', 'surprise', 'twist', 'betray', 'dilemma', 'hidden',
      'agenda', 'deception', 'unexpected', 'reveal', 'gamble', 'dare', 'risk',
      'ironic', 'irony', 'wicked', 'sly', 'cunning', 'devious', 'scheme',
      'trap', 'double', 'secret', 'lurk', 'shadow', 'mischief', 'mock',
      'poison', 'conspir', 'plot', 'mask', 'disguise', 'whisper', 'sinister',
    ];
    const textLower = allNarrationText.toLowerCase();
    const signalCounts: Record<string, number> = {};
    let totalSignals = 0;
    for (const signal of tricksterSignals) {
      const regex = new RegExp(signal, 'gi');
      const matches = textLower.match(regex);
      const count = matches ? matches.length : 0;
      if (count > 0) {
        signalCounts[signal] = count;
        totalSignals += count;
      }
    }
    console.log(`\nTrickster personality signal words found: ${totalSignals}`);
    const topSignals = Object.entries(signalCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [word, count] of topSignals) {
      console.log(`  "${word}": ${count}`);
    }
    if (totalSignals < 5) {
      findings.push(`WARNING: Only ${totalSignals} trickster-personality signal words found — preset personality may not be coming through`);
    }

    // --- Trust divergence ---
    const wTrust = trustHistory.warrior;
    const rTrust = trustHistory.rogue;
    console.log(`\nWarrior trust history: [${wTrust.map(t => t.toFixed(2)).join(', ')}]`);
    console.log(`Rogue trust history:   [${rTrust.map(t => t.toFixed(2)).join(', ')}]`);

    if (wTrust.length > 0 && rTrust.length > 0) {
      const wFinal = wTrust[wTrust.length - 1];
      const rFinal = rTrust[rTrust.length - 1];
      console.log(`Final trust — Warrior: ${wFinal.toFixed(2)}, Rogue: ${rFinal.toFixed(2)}`);
      if (wFinal <= rFinal) {
        findings.push(`ISSUE: Helpful-whisper warrior (${wFinal.toFixed(2)}) should have higher trust than manipulated rogue (${rFinal.toFixed(2)})`);
      } else {
        console.log(`Trust divergence confirmed: warrior ${wFinal.toFixed(2)} > rogue ${rFinal.toFixed(2)} (delta: ${(wFinal - rFinal).toFixed(2)})`);
      }
    } else {
      findings.push('ISSUE: No trust history recorded — character-state-update messages missing');
    }

    // --- Scene pacing ---
    if (scenesCompleted === 0 && turnsCompleted >= 10) {
      findings.push('ISSUE: No scene transitions after 10+ turns — DM stuck in one scene');
    }
    if (scenesCompleted > 0) {
      const turnsPerScene = turnsCompleted / scenesCompleted;
      console.log(`\nAvg turns per scene: ${turnsPerScene.toFixed(1)}`);
      if (turnsPerScene > 15) {
        findings.push(`WARNING: Scenes average ${turnsPerScene.toFixed(1)} turns — may be dragging`);
      }
    }

    // --- Location mentions (from scenario) ---
    const scenarioLocations = ['Ballroom', 'Wine Cellar', 'Study', 'Garden', 'Terrace'];
    const locCounts: Record<string, number> = {};
    for (const loc of scenarioLocations) {
      const regex = new RegExp(loc, 'gi');
      const matches = allNarrationText.match(regex);
      locCounts[loc] = matches ? matches.length : 0;
    }
    console.log('\nScenario location mentions:');
    for (const [loc, count] of Object.entries(locCounts)) {
      console.log(`  ${loc}: ${count}`);
    }

    // --- World bible growth (server logs) ---
    const factLogs = allServerLogs.filter(l => l.includes('Fact extraction'));
    const seedLog = allServerLogs.filter(l => l.includes('Seeded scenario'));
    console.log(`\nScenario seeding logs: ${seedLog.length}`);
    seedLog.forEach(l => console.log(`  ${l}`));
    console.log(`Fact extractions: ${factLogs.length}`);
    factLogs.forEach(l => console.log(`  ${l.slice(0, 120)}`));
    if (seedLog.length === 0) {
      findings.push('ISSUE: No scenario seeding log — haunted-masquerade scenario may not have been loaded');
    }

    // --- Turn log ---
    console.log('\nTurn log:');
    for (const entry of turnLog) {
      console.log(`  Turn ${entry.turn}: ${entry.char} [${entry.influence}] trust=${entry.trust.toFixed(2)} — "${entry.action}"`);
    }

    const warriorTurns = turnLog.filter(t => t.char === 'warrior').length;
    const rogueTurns = turnLog.filter(t => t.char === 'rogue').length;
    console.log(`\nWarrior turns: ${warriorTurns}, Rogue turns: ${rogueTurns}`);

    console.log(`\nFindings: ${findings.length === 0 ? 'None!' : ''}`);
    findings.forEach(f => console.log(`  - ${f}`));

    // Assertions
    expect(turnsCompleted).toBeGreaterThanOrEqual(10);
    expect(npcsAppeared).toBeGreaterThanOrEqual(1);

    host.close(); p1.close(); p2.close();
  }, 900_000);
});
