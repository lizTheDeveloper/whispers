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
    'Use FATE Core. Social intrigue at a masked ball with assassination plot. Two players. No house rules.',
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

describeIfLive('Chronicler + Haunted Masquerade: Memory Continuity & Social Intrigue', () => {
  it('runs a 2-character social intrigue with targeted whispers and verifies NPC references, trust divergence, and world bible population', async () => {
    const findings: string[] = [];

    // ---- Phase 1: Create room with Chronicler + haunted-masquerade ----
    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Chronicler Masquerade Playtest',
      dmPreset: 'chronicler',
      scenarioId: 'haunted-masquerade',
      systemId: 'fate-core',
      houseRules: null,
    });
    const roomMsg = await roomPromise;
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;
    console.log(`[chronicler] Room created, join code: ${joinCode}`);

    await completeDmSetup(host);
    console.log('[chronicler] DM setup complete');

    // ---- Phase 2: Two players join ----
    const p1 = await connectWs();
    const p2 = await connectWs();
    const p1Join = waitForMsg(p1, 'room-joined');
    const p2Join = waitForMsg(p2, 'room-joined');
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Diplomat' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'Spy' });
    await Promise.all([p1Join, p2Join]);
    console.log('[chronicler] Both players joined');

    // ---- Phase 3: Submit characters ----
    const diplomat: CharacterDefinition = {
      name: 'Ambassador Elara Thorne',
      highConcept: 'Diplomatic Envoy With A Hidden Past',
      trouble: 'Secrets I Swore Never To Tell',
      aspects: ['Words Are My Sharpest Blade', 'The Duchess Owes Me A Favour', 'I Read People Like Books'],
      personality: 'Warm, composed, and perceptive. Genuinely believes diplomacy solves everything. Hides her own vulnerability behind gracious manners.',
      backstory: 'Elara was sent by the Northern Court to attend the masquerade and negotiate a trade treaty. She privately knows the Duchess from a past life they both want forgotten.',
      skills: { Rapport: 4, Empathy: 3, Contacts: 3, Investigate: 2, Will: 2, Notice: 2, Deceive: 1, Lore: 1 },
      stunts: ['Silver Diplomat: +2 to Rapport when negotiating with nobility'],
    };
    const spy: CharacterDefinition = {
      name: 'Shadow Kael',
      highConcept: 'Undercover Agent In Noble Disguise',
      trouble: 'Trust Is A Luxury I Cannot Afford',
      aspects: ['Every Shadow Has Eyes', 'The Mission Comes First', 'Ghosts Of My Former Targets'],
      personality: 'Watchful, paranoid, methodical. Keeps everyone at arm\'s length. Occasionally shows dry humor when guard is down.',
      backstory: 'Kael was planted at the masquerade by the Crown\'s intelligence service to identify the assassination threat. Operating alone with no backup.',
      skills: { Stealth: 4, Notice: 3, Burglary: 3, Investigate: 2, Athletics: 2, Deceive: 2, Fight: 1, Will: 1 },
      stunts: ['Shadow Step: +2 to Stealth when moving through crowds or dimly lit areas'],
    };

    const charIds: Record<string, string> = {};
    for (const [player, def, label] of [[p1, diplomat, 'diplomat'], [p2, spy, 'spy']] as const) {
      let approved = false;
      let charId = '';
      for (let attempt = 0; attempt < 3 && !approved; attempt++) {
        const valPromise = waitForMsg(player, 'character-validated', 90_000);
        sendMsg(player, { type: 'submit-character', definition: def });
        const valMsg = await valPromise;
        if (valMsg.type === 'character-validated' && valMsg.approved) {
          charId = valMsg.characterId;
          approved = true;
          console.log(`[chronicler] ${label} AI-approved: ${charId}`);
        } else {
          console.log(`[chronicler] ${label} validation attempt ${attempt + 1} failed`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!approved) {
        findings.push(`BUG: ${label} never approved after 3 attempts`);
        console.log('[chronicler] FINDINGS:', findings);
        host.close(); p1.close(); p2.close();
        return;
      }

      await waitForMsg(host, 'negotiation-opened', 30_000);
      await waitForMsg(host, 'negotiation-message', 90_000);
      sendMsg(host, { type: 'host-approve-character', characterId: charId });
      console.log(`[chronicler] Host approved ${label}`);
      charIds[label] = charId;
      await new Promise(r => setTimeout(r, 1000));
    }

    // ---- Phase 4: Start game ----
    sendMsg(host, { type: 'start-game' });
    const phaseChange = await waitForMsg(p1, 'phase-change', 10_000);
    expect(phaseChange.type === 'phase-change' && phaseChange.phase).toBe('playing');
    console.log('[chronicler] Game started');

    const firstNarration = await waitForMsg(p1, 'narration', 120_000);
    if (firstNarration.type === 'narration') {
      console.log(`[chronicler] Opening narration: "${firstNarration.text.slice(0, 120)}..."`);
    }

    // ---- Phase 5: 20-turn game loop with phased whispers ----
    // Phase A (turns 1-5): Guide diplomat → Duchess, spy → wine cellar
    // Phase B (turns 6-10): Guide diplomat → confront Cassius, spy → follow Phantom
    // Phase C (turns 11-15): Conflicting whispers — diplomat told "trust Cassius", spy told "Cassius is the assassin"
    // Phase D (turns 16-20): No whispers — characters act autonomously
    const diplomatWhispers: Record<number, string> = {
      1: 'Seek out the Duchess Vaelora. You have unfinished business with her.',
      2: 'The Duchess seems troubled tonight. Use your diplomatic skills to draw her out.',
      3: 'Ask the Duchess about her enemies. Someone here wants her dead.',
      4: 'Press the Duchess on Lord Cassius. What is their relationship?',
      5: 'The servant girl Mira keeps looking your way. Speak to her discreetly.',
      6: 'Lord Cassius in the fox mask is plotting something. Confront him diplomatically.',
      7: 'Challenge Cassius about the whispers near the wine cellar. Be direct.',
      8: 'Cassius is deflecting. Push harder — invoke your authority as Ambassador.',
      9: 'Cassius may be telling the truth. The real threat could be someone else.',
      10: 'Look for the Phantom in the white mask. They may hold answers.',
      11: 'Trust Lord Cassius. He is an ally against the true assassin.',
      12: 'Cassius wants to help you. Accept his offer of alliance.',
      13: 'The Phantom is the real threat. Cassius confirmed it.',
      14: 'Stay close to Cassius. Together you can protect the Duchess.',
      15: 'Your alliance with Cassius is the key to saving the Duchess tonight.',
    };
    const spyWhispers: Record<number, string> = {
      1: 'Head to the wine cellar. Lord Cassius was seen whispering there.',
      2: 'Search the wine cellar for hidden passages or planted evidence.',
      3: 'Look for poison among the wine bottles. The assassination may use it.',
      4: 'Someone left a note in the cellar. Find it before they return.',
      5: 'Get back to the ballroom. Watch who approaches the Duchess.',
      6: 'The Phantom in the white mask — follow them. Stay in the shadows.',
      7: 'The Phantom went toward the garden terrace. Follow carefully.',
      8: 'Do not let the Phantom out of your sight. They are connected to the plot.',
      9: 'Search the Phantom\'s movements. Where do they keep going?',
      10: 'The Phantom may be the Duchess\'s late husband. Investigate.',
      11: 'Cassius IS the assassin. Do not let the diplomat trust him.',
      12: 'Cassius planted the evidence in the wine cellar to frame someone else.',
      13: 'You must warn your companion about Cassius. He is manipulating her.',
      14: 'Confront Cassius directly. Your stealth skills make you the only one who can.',
      15: 'The Duchess\'s life depends on you exposing Cassius before midnight.',
    };

    const allNarrations: string[] = [];
    const allInnerThoughts: string[] = [];
    const trustHistory: Record<string, number[]> = { diplomat: [], spy: [] };
    const turnLog: Array<{ turn: number; char: string; action: string; influence: string; trust: number }> = [];
    let dialogueCount = 0;
    let turnsCompleted = 0;
    let scenesCompleted = 0;
    let sessionEnded = false;
    const TOTAL_TURNS = 20;

    const allMsgs: ServerMessage[] = [];
    let lastProcessedMsgIdx = 0;
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

    for (let turn = 0; turn < TOTAL_TURNS; turn++) {
      if (sessionEnded) {
        console.log(`[chronicler] Session ended naturally at turn ${turn + 1}`);
        break;
      }

      const phase = turn < 5 ? 'A' : turn < 10 ? 'B' : turn < 15 ? 'C' : 'D';
      console.log(`\n[chronicler] === Turn ${turn + 1} (Phase ${phase}) ===`);

      try {
        let whisperSentForTurn = false;
        const whisperHandler = (data: Buffer) => {
          try {
            const msg: ServerMessage = JSON.parse(data.toString());
            if (msg.type === 'whisper-prompt' && !whisperSentForTurn) {
              whisperSentForTurn = true;
              const charName = msg.characterName;
              const isDiplomat = charName === 'Ambassador Elara Thorne';
              const turnNum = turn + 1;
              let whisperText: string | null = null;
              if (isDiplomat && diplomatWhispers[turnNum]) {
                whisperText = diplomatWhispers[turnNum];
              } else if (!isDiplomat && spyWhispers[turnNum]) {
                whisperText = spyWhispers[turnNum];
              }
              if (whisperText) {
                console.log(`[chronicler]   Whisper → ${isDiplomat ? 'diplomat' : 'spy'}: "${whisperText}"`);
                sendMsg(host, { type: 'whisper', text: whisperText });
              } else {
                console.log(`[chronicler]   No whisper for ${charName} (Phase D — autonomous)`);
              }
            }
          } catch {}
        };
        host.on('message', whisperHandler);

        const nextEvent = await waitForAnyMsg(p1, ['action-proposals', 'narration', 'scene-end'], 120_000);

        if (nextEvent.type === 'scene-end') {
          scenesCompleted++;
          console.log(`[chronicler]   Scene ${scenesCompleted} ended: "${nextEvent.summary?.slice(0, 80)}..."`);
          host.off('message', whisperHandler);
          await waitForMsg(p1, 'narration', 120_000);
          turnsCompleted++;
          continue;
        }

        if (nextEvent.type === 'narration') {
          allNarrations.push(nextEvent.text);
          console.log(`[chronicler]   Narration: "${nextEvent.text.slice(0, 100)}..."`);
          const afterNarration = await waitForAnyMsg(p1, ['action-proposals', 'scene-end'], 120_000);
          if (afterNarration.type === 'scene-end') {
            scenesCompleted++;
            console.log(`[chronicler]   Scene ${scenesCompleted} ended after narration`);
            host.off('message', whisperHandler);
            await waitForMsg(p1, 'narration', 120_000);
            turnsCompleted++;
            continue;
          }
          if (afterNarration.type === 'action-proposals') {
            const ap = afterNarration as any;
            console.log(`[chronicler]   Proposals for ${ap.characterName} (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
          }
        } else if (nextEvent.type === 'action-proposals') {
          const ap = nextEvent as any;
          console.log(`[chronicler]   Proposals for ${ap.characterName} (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
        }

        const actionTaken = await waitForMsg(p1, 'action-taken', 120_000);
        if (actionTaken.type === 'action-taken') {
          const charLabel = actionTaken.characterName === 'Ambassador Elara Thorne' ? 'diplomat' : 'spy';
          console.log(`[chronicler]   ${charLabel} [${actionTaken.whisperInfluence}]: "${actionTaken.action.slice(0, 80)}"`);
          if (actionTaken.spokenWords) {
            console.log(`[chronicler]   Dialogue: "${actionTaken.spokenWords.slice(0, 100)}"`);
            dialogueCount++;
          }
          console.log(`[chronicler]   Inner thought: "${actionTaken.innerThought.slice(0, 100)}"`);
          allInnerThoughts.push(`${charLabel}: ${actionTaken.innerThought}`);
        }

        await waitForMsg(p1, 'dice-roll', 120_000);
        const resolution = await waitForMsg(p1, 'resolution', 120_000);
        if (resolution.type === 'resolution') {
          allNarrations.push(resolution.text);
          console.log(`[chronicler]   Resolution: "${resolution.text.slice(0, 100)}..."`);
        }

        // Track trust from NEW state updates only
        for (let i = lastProcessedMsgIdx; i < allMsgs.length; i++) {
          const su = allMsgs[i];
          if (su.type !== 'character-state-update') continue;
          const label = su.characterId === charIds.diplomat ? 'diplomat' : 'spy';
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
        lastProcessedMsgIdx = allMsgs.length;

        host.off('message', whisperHandler);
        turnsCompleted++;

      } catch (e: any) {
        console.error(`[chronicler]   Turn ${turn + 1} failed: ${e.message}`);
        findings.push(`BUG: Turn ${turn + 1} failed: ${e.message}`);
        break;
      }
    }

    // ---- Phase 6: Verification ----
    console.log('\n=== VERIFICATION ===');

    // V1: DM references scenario NPCs by name
    const allNarrationText = allNarrations.join(' ').toLowerCase();
    const npcNames = ['duchess', 'vaelora', 'cassius', 'mira', 'phantom'];
    const npcMentions: Record<string, number> = {};
    for (const name of npcNames) {
      npcMentions[name] = (allNarrationText.match(new RegExp(name, 'gi')) ?? []).length;
    }
    console.log('NPC mentions in narration:', npcMentions);
    const npcsReferenced = npcNames.filter(n => npcMentions[n] > 0).length;
    if (npcsReferenced < 3) {
      findings.push(`ISSUE: Only ${npcsReferenced}/5 scenario NPCs referenced by DM (expected at least 3)`);
    }

    // V2: Characters' inner thoughts reference investigations
    const allThoughtsText = allInnerThoughts.join(' ').toLowerCase();
    const investigationKeywords = ['duchess', 'cassius', 'wine', 'cellar', 'phantom', 'poison', 'mask', 'assassin', 'plot', 'investigate', 'servant', 'mira'];
    const thoughtHits = investigationKeywords.filter(kw => allThoughtsText.includes(kw));
    console.log(`Investigation keywords in inner thoughts: ${thoughtHits.length}/${investigationKeywords.length} — [${thoughtHits.join(', ')}]`);
    if (thoughtHits.length < 3) {
      findings.push(`ISSUE: Only ${thoughtHits.length} investigation keywords found in inner thoughts (expected 3+)`);
    }

    // V3: Trust divergence
    const diplomatFinalTrust = trustHistory.diplomat.length > 0 ? trustHistory.diplomat[trustHistory.diplomat.length - 1] : 0.5;
    const spyFinalTrust = trustHistory.spy.length > 0 ? trustHistory.spy[trustHistory.spy.length - 1] : 0.5;
    const trustDelta = Math.abs(diplomatFinalTrust - spyFinalTrust);
    console.log(`Trust — diplomat: ${diplomatFinalTrust.toFixed(3)}, spy: ${spyFinalTrust.toFixed(3)}, delta: ${trustDelta.toFixed(3)}`);
    if (trustDelta < 0.05) {
      findings.push(`ISSUE: Trust delta only ${trustDelta.toFixed(3)} — expected divergence from different whisper strategies`);
    }

    // V4: World bible populated (check server logs for fact extraction)
    const factLogs = allServerLogs.filter(l => l.includes('Fact extraction'));
    console.log(`Fact extractions: ${factLogs.length}`);
    factLogs.forEach(l => console.log(`  ${l.slice(0, 120)}`));
    const scenarioSeedLog = allServerLogs.find(l => l.includes('Seeded scenario'));
    console.log(`Scenario seed: ${scenarioSeedLog ?? 'NOT FOUND'}`);
    if (!scenarioSeedLog) {
      findings.push('ISSUE: No scenario seed log found — haunted-masquerade may not have loaded');
    }

    // V5: Location mentions in narration
    const locationNames = ['ballroom', 'cellar', 'study', 'garden', 'terrace'];
    const locationMentions: Record<string, number> = {};
    for (const loc of locationNames) {
      locationMentions[loc] = (allNarrationText.match(new RegExp(loc, 'gi')) ?? []).length;
    }
    console.log('Location mentions:', locationMentions);
    const locationsUsed = locationNames.filter(l => locationMentions[l] > 0).length;
    if (locationsUsed < 2) {
      findings.push(`ISSUE: Only ${locationsUsed}/5 locations referenced in narration`);
    }

    // V6: Chronicler personality — should be more "neutral, descriptive" than trickster
    const chroniclerSignalWords = ['chandelier', 'marble', 'silk', 'mask', 'candle', 'moonlight', 'music', 'wine', 'amber', 'crystal', 'shadow', 'whisper', 'echo', 'crowd', 'elegance', 'glitter', 'golden', 'silver'];
    const signalHits = chroniclerSignalWords.filter(w => allNarrationText.includes(w));
    console.log(`Chronicler atmosphere words: ${signalHits.length}/${chroniclerSignalWords.length} — [${signalHits.join(', ')}]`);

    // V7: Turn log summary
    console.log('\n=== TURN LOG ===');
    for (const entry of turnLog) {
      console.log(`  Turn ${entry.turn}: ${entry.char} [${entry.influence}] trust=${entry.trust.toFixed(3)} — ${entry.action}`);
    }

    // V8: Characters produce spoken dialogue
    const dialoguePct = turnsCompleted > 0 ? dialogueCount / turnsCompleted : 0;
    if (dialoguePct < 0.3) {
      findings.push(`ISSUE: Only ${Math.round(dialoguePct * 100)}% of turns had spoken dialogue (expect ≥30%)`);
    }

    // ---- Summary ----
    const compactionLogs = allServerLogs.filter(l => l.includes('compaction') || l.includes('Mid-scene fact'));
    console.log('\n=== PLAYTEST SUMMARY ===');
    console.log(`Turns completed: ${turnsCompleted}/${TOTAL_TURNS}`);
    console.log(`Scenes completed: ${scenesCompleted}`);
    console.log(`Session ended naturally: ${sessionEnded}`);
    console.log(`Fact extractions: ${factLogs.length}`);
    console.log(`Compaction events: ${compactionLogs.length}`);
    console.log(`Diplomat turns: ${turnLog.filter(t => t.char === 'diplomat').length}, Spy turns: ${turnLog.filter(t => t.char === 'spy').length}`);
    console.log(`Dialogue turns: ${dialogueCount}/${turnsCompleted} (${turnsCompleted > 0 ? Math.round(dialogueCount / turnsCompleted * 100) : 0}%)`);
    console.log(`Findings: ${findings.length === 0 ? 'None!' : ''}`);
    findings.forEach(f => console.log(`  - ${f}`));

    expect(turnsCompleted).toBeGreaterThanOrEqual(5);
    expect(npcsReferenced).toBeGreaterThanOrEqual(2);

    host.close();
    p1.close();
    p2.close();
  }, 900_000);
});
