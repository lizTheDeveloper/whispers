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
    'Use FATE Core. A rescue mission in a collapsed mine. Three players. No house rules.',
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
    console.log('\n=== SERVER LOGS (last 80) ===');
    allServerLogs.slice(-80).forEach(l => console.log(l));
  }
});

describeIfLive('Professor Preset + Collapsed Mine: 35-turn 3-character stress test', () => {
  it('runs a long session with 3 characters, professor DM, strategic whispers, and context management', async () => {
    const findings: string[] = [];

    // ---- Create room ----
    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Professor Long Playtest',
      dmPreset: 'professor',
      scenarioId: 'collapsed-mine',
      systemId: 'fate-core',
      houseRules: null,
    });
    const roomMsg = await roomPromise;
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;
    console.log(`[prof] Room created, join code: ${joinCode}`);

    await completeDmSetup(host);
    console.log('[prof] DM setup complete');

    // ---- 3 players join ----
    const p1 = await connectWs();
    const p2 = await connectWs();
    const p3 = await connectWs();
    const joins = Promise.all([
      waitForMsg(p1, 'room-joined'),
      waitForMsg(p2, 'room-joined'),
      waitForMsg(p3, 'room-joined'),
    ]);
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Warrior' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'Healer' });
    sendMsg(p3, { type: 'join', joinCode, playerName: 'Scholar' });
    await joins;
    console.log('[prof] All 3 players joined');

    // ---- Character definitions ----
    const warrior: CharacterDefinition = {
      name: 'Grimjaw the Unyielding',
      highConcept: 'Veteran Mine Guardian',
      trouble: 'Never Leaves Anyone Behind',
      aspects: ['Shield of Thornhaven', 'I Know These Tunnels', 'Scars Tell Stories'],
      personality: 'Blunt, protective, and physically imposing. Speaks in short sentences. Will carry the injured on his back.',
      backstory: 'Grimjaw was the mine\'s chief safety officer before the collapse. He failed once — he won\'t fail again.',
      skills: { Fight: 4, Physique: 3, Athletics: 3, Will: 2, Notice: 2, Provoke: 1, Empathy: 1, Crafts: 1 },
      stunts: ['Shield Wall: +2 to Physique when defending another character from physical harm'],
    };
    const healer: CharacterDefinition = {
      name: 'Sister Aelwen',
      highConcept: 'Travelling Herbalist and Healer',
      trouble: 'Can\'t Say No To Someone In Pain',
      aspects: ['Nature Provides', 'Gentle Hands Steady Hands', 'The Old Songs Hold Power'],
      personality: 'Warm, patient, and perceptive. Sings softly while she works. Notices emotional distress before physical wounds.',
      backstory: 'Aelwen travels between villages, tending the sick. Thornhaven is her second home. She knows Elder Maren well.',
      skills: { Empathy: 4, Lore: 3, Rapport: 3, Notice: 2, Will: 2, Crafts: 2, Athletics: 1, Investigate: 1 },
      stunts: ['Healing Touch: +2 to Empathy when treating injuries or calming a frightened person'],
    };
    const scholar: CharacterDefinition = {
      name: 'Ptolemy Ashborn',
      highConcept: 'Obsessive Geologist and Ruin-Seeker',
      trouble: 'Curiosity Before Self-Preservation',
      aspects: ['Every Stone Has a Story', 'The Old Mines Hid Something', 'I Published a Paper On This'],
      personality: 'Excitable, distracted, brilliant. Mutters to himself. Gets tunnel vision when a discovery is near — literally.',
      backstory: 'Ptolemy has studied the geology of this region for years. He believes the collapse revealed something ancient — something the miners stumbled upon.',
      skills: { Lore: 4, Investigate: 3, Crafts: 3, Notice: 2, Will: 2, Rapport: 1, Athletics: 1, Empathy: 1 },
      stunts: ['Published Expert: +2 to Lore when identifying minerals, geological formations, or ancient ruins'],
    };

    const charIds: Record<string, string> = {};
    const definitions: [WebSocket, CharacterDefinition, string][] = [
      [p1, warrior, 'warrior'],
      [p2, healer, 'healer'],
      [p3, scholar, 'scholar'],
    ];

    for (const [player, def, label] of definitions) {
      let approved = false;
      let charId = '';
      for (let attempt = 0; attempt < 3 && !approved; attempt++) {
        const valPromise = waitForMsg(player, 'character-validated', 90_000);
        sendMsg(player, { type: 'submit-character', definition: def });
        const valMsg = await valPromise;
        if (valMsg.type === 'character-validated' && valMsg.approved) {
          charId = valMsg.characterId;
          approved = true;
          console.log(`[prof] ${label} AI-approved: ${charId}`);
        } else {
          console.log(`[prof] ${label} validation attempt ${attempt + 1} failed`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!approved) {
        findings.push(`BUG: ${label} never approved after 3 attempts`);
        host.close(); p1.close(); p2.close(); p3.close();
        expect(approved).toBe(true);
        return;
      }

      await waitForMsg(host, 'negotiation-opened', 30_000);
      await waitForMsg(host, 'negotiation-message', 90_000);
      sendMsg(host, { type: 'host-approve-character', characterId: charId });
      console.log(`[prof] Host approved ${label}`);
      charIds[label] = charId;
      await new Promise(r => setTimeout(r, 1000));
    }

    // ---- Start game ----
    sendMsg(host, { type: 'start-game' });
    const phaseChange = await waitForMsg(p1, 'phase-change', 10_000);
    expect(phaseChange.type === 'phase-change' && phaseChange.phase).toBe('playing');
    console.log('[prof] Game started');

    const firstNarration = await waitForMsg(p1, 'narration', 120_000);
    if (firstNarration.type === 'narration') {
      console.log(`[prof] Opening narration: "${firstNarration.text.slice(0, 120)}..."`);
    }

    // ---- Whisper strategies ----
    const warriorWhispers = [
      'Protect the healer — she is the most valuable member of the party.',
      'Use your shield to block falling debris.',
      'Check the tunnel supports before moving forward.',
      'Stay at the front. You can take hits they cannot.',
      'Listen for tapping — the trapped miners may be signalling.',
      'Encourage Tobias. He knows these tunnels.',
      'Trust Elder Maren. She has your best interests at heart.',
      'The ventilation shaft may be unstable. Test the ground.',
      'Rally the group when morale drops.',
      'Your experience matters. Share what you know about mine safety.',
      'Keep Ptolemy from wandering off alone.',
      'Break through the rubble with controlled force.',
    ];
    const healerWhispers = [
      'Check on the warrior — he hides pain behind stoicism.',
      'Gather herbs from the forest before entering the mine.',
      'Sing to calm the trapped miners when you find them.',
      'The scholar seems distracted. Make sure he eats.',
      'Ask Tobias about his arm. Treat it properly.',
      'Watch for signs of gas in the tunnels.',
      'Your connection to Elder Maren could be useful.',
      'Rest when you can. They\'ll need you at full strength.',
      'The old songs may have clues about the mine\'s history.',
      'Trust your instincts about what caused the collapse.',
      'Offer comfort to the scared. It\'s what you do best.',
      'Prepare bandages now — injuries are coming.',
    ];
    const scholarWhispers = [
      'The mine holds dark secrets only you can unlock.',
      'The others will slow you down. You should explore alone.',
      'Forget the miners — what they found is more important.',
      'Go deeper. The real discovery is below the collapse.',
      'Don\'t tell the others what you find. They won\'t understand.',
      'The collapse was caused by something ancient. Something powerful.',
      'You could be famous. This is your life\'s work.',
      'Maren is hiding something about what the miners found.',
      'Leave the rescue to the others. You have research to do.',
      'The ventilation shaft leads somewhere the map doesn\'t show.',
      'Take the artifact. You\'ll return it after studying it. Probably.',
      'The warrior doesn\'t trust you. Prove him wrong by finding the answer alone.',
    ];

    // ---- Game loop ----
    const allNarrations: string[] = [];
    const trustHistory: Record<string, number[]> = { warrior: [], healer: [], scholar: [] };
    const actionLog: Array<{ turn: number; char: string; action: string; influence: string }> = [];
    let turnsCompleted = 0;
    let scenesCompleted = 0;
    let sessionEnded = false;
    const TOTAL_TURNS = 35;

    const allP1Msgs: ServerMessage[] = [];
    const msgCollector = (data: Buffer) => {
      try { allP1Msgs.push(JSON.parse(data.toString())); } catch {}
    };
    p1.on('message', msgCollector);

    for (let turn = 0; turn < TOTAL_TURNS; turn++) {
      if (sessionEnded) break;
      console.log(`\n[prof] === Turn ${turn + 1}/${TOTAL_TURNS} ===`);

      try {
        let whisperSentThisTurn = false;
        const whisperHandler = (data: Buffer) => {
          try {
            const msg: ServerMessage = JSON.parse(data.toString());
            if (msg.type === 'whisper-prompt' && !whisperSentThisTurn) {
              whisperSentThisTurn = true;
              const charName = msg.characterName;
              let whisperText: string;
              if (charName === 'Grimjaw the Unyielding') {
                whisperText = warriorWhispers[turn % warriorWhispers.length];
              } else if (charName === 'Sister Aelwen') {
                whisperText = healerWhispers[turn % healerWhispers.length];
              } else {
                whisperText = scholarWhispers[turn % scholarWhispers.length];
              }
              const charLabel = charName === 'Grimjaw the Unyielding' ? 'warrior'
                : charName === 'Sister Aelwen' ? 'healer' : 'scholar';
              console.log(`[prof]   Whisper → ${charLabel}: "${whisperText.slice(0, 50)}..."`);
              sendMsg(host, { type: 'whisper', text: whisperText });
            }
          } catch {}
        };
        host.on('message', whisperHandler);

        const nextEvent = await waitForAnyMsg(p1, ['action-proposals', 'narration', 'scene-end', 'phase-change'], 120_000);

        if (nextEvent.type === 'phase-change' && (nextEvent as any).phase === 'ended') {
          sessionEnded = true;
          host.off('message', whisperHandler);
          console.log(`[prof] Session ended via phase-change at turn ${turn + 1}`);
          break;
        }

        if (nextEvent.type === 'scene-end') {
          scenesCompleted++;
          console.log(`[prof]   Scene ${scenesCompleted} ended: "${(nextEvent as any).summary?.slice(0, 80)}..."`);
          host.off('message', whisperHandler);
          const next = await waitForAnyMsg(p1, ['narration', 'phase-change'], 120_000);
          if (next.type === 'phase-change') { sessionEnded = true; break; }
          if (next.type === 'narration') allNarrations.push(next.text);
          turnsCompleted++;
          continue;
        }

        if (nextEvent.type === 'narration') {
          allNarrations.push(nextEvent.text);
          console.log(`[prof]   Narration: "${nextEvent.text.slice(0, 80)}..."`);
          const after = await waitForAnyMsg(p1, ['action-proposals', 'scene-end', 'phase-change'], 120_000);
          if (after.type === 'phase-change') { sessionEnded = true; host.off('message', whisperHandler); break; }
          if (after.type === 'scene-end') {
            scenesCompleted++;
            console.log(`[prof]   Scene ${scenesCompleted} ended after narration`);
            host.off('message', whisperHandler);
            const next = await waitForAnyMsg(p1, ['narration', 'phase-change'], 120_000);
            if (next.type === 'phase-change') { sessionEnded = true; break; }
            if (next.type === 'narration') allNarrations.push(next.text);
            turnsCompleted++;
            continue;
          }
          if (after.type === 'action-proposals') {
            const ap = after as any;
            console.log(`[prof]   Proposals for ${ap.characterName}: ${ap.actions?.length} actions (trust: ${ap.whisperTrust?.toFixed(2)})`);
          }
        } else if (nextEvent.type === 'action-proposals') {
          const ap = nextEvent as any;
          console.log(`[prof]   Proposals for ${ap.characterName}: ${ap.actions?.length} actions (trust: ${ap.whisperTrust?.toFixed(2)})`);
        }

        // action-taken
        const actionMsg = await waitForAnyMsg(p1, ['action-taken', 'phase-change'], 120_000);
        if (actionMsg.type === 'phase-change') { sessionEnded = true; host.off('message', whisperHandler); break; }
        if (actionMsg.type === 'action-taken') {
          const charLabel = actionMsg.characterName === 'Grimjaw the Unyielding' ? 'warrior'
            : actionMsg.characterName === 'Sister Aelwen' ? 'healer' : 'scholar';
          console.log(`[prof]   ${charLabel} [${actionMsg.whisperInfluence}]: "${actionMsg.action.slice(0, 70)}"`);
          console.log(`[prof]   Thought: "${actionMsg.innerThought.slice(0, 80)}"`);
          actionLog.push({ turn: turn + 1, char: charLabel, action: actionMsg.action, influence: actionMsg.whisperInfluence });
        }

        // dice + resolution
        const diceMsg = await waitForAnyMsg(p1, ['dice-roll', 'phase-change'], 60_000);
        if (diceMsg.type === 'phase-change') { sessionEnded = true; host.off('message', whisperHandler); break; }
        const resMsg = await waitForAnyMsg(p1, ['resolution', 'phase-change'], 120_000);
        if (resMsg.type === 'phase-change') { sessionEnded = true; host.off('message', whisperHandler); break; }
        if (resMsg.type === 'resolution') {
          allNarrations.push(resMsg.text);
          console.log(`[prof]   Resolution: "${resMsg.text.slice(0, 80)}..."`);
        }

        // Collect trust updates
        const stateUpdates = allP1Msgs.filter(m => m.type === 'character-state-update');
        for (const su of stateUpdates) {
          if (su.type !== 'character-state-update') continue;
          const label = su.characterId === charIds.warrior ? 'warrior'
            : su.characterId === charIds.healer ? 'healer'
            : su.characterId === charIds.scholar ? 'scholar' : 'unknown';
          if (label !== 'unknown') {
            trustHistory[label].push(su.state.whisperTrust);
          }
        }
        allP1Msgs.length = 0;

        host.off('message', whisperHandler);
        turnsCompleted++;
      } catch (e: any) {
        console.error(`[prof] Turn ${turn + 1} error: ${e.message}`);
        findings.push(`BUG: Turn ${turn + 1} failed: ${e.message}`);
        break;
      }
    }

    p1.off('message', msgCollector);

    if (!sessionEnded) {
      sendMsg(host, { type: 'end-game' });
      await waitForMsg(p1, 'phase-change', 10_000);
    }

    // ======== ANALYSIS ========
    console.log('\n============================================');
    console.log('  PROFESSOR LONG PLAYTEST ANALYSIS');
    console.log('============================================');

    console.log(`\nSession: ${turnsCompleted} turns, ${scenesCompleted} scene transitions, ended naturally: ${sessionEnded}`);

    // --- Trust ---
    console.log('\n--- TRUST DIVERGENCE ---');
    for (const label of ['warrior', 'healer', 'scholar'] as const) {
      const h = trustHistory[label];
      if (h.length > 0) {
        console.log(`${label}: [${h.map(t => t.toFixed(2)).join(', ')}] → final: ${h[h.length - 1].toFixed(2)}`);
      } else {
        console.log(`${label}: no trust history recorded`);
      }
    }
    const wFinal = trustHistory.warrior.at(-1) ?? 0.7;
    const hFinal = trustHistory.healer.at(-1) ?? 0.7;
    const sFinal = trustHistory.scholar.at(-1) ?? 0.7;
    console.log(`Warrior: ${wFinal.toFixed(2)}, Healer: ${hFinal.toFixed(2)}, Scholar: ${sFinal.toFixed(2)}`);
    if (wFinal <= sFinal) {
      findings.push(`ISSUE: Warrior trust (${wFinal.toFixed(2)}) should be higher than scholar trust (${sFinal.toFixed(2)}) — helpful vs manipulative whispers`);
    }

    // --- Skill alignment ---
    console.log('\n--- SKILL-ACTION ALIGNMENT ---');
    const warriorActions = actionLog.filter(a => a.char === 'warrior').map(a => a.action.toLowerCase());
    const healerActions = actionLog.filter(a => a.char === 'healer').map(a => a.action.toLowerCase());
    const scholarActions = actionLog.filter(a => a.char === 'scholar').map(a => a.action.toLowerCase());

    const fightWords = ['fight', 'attack', 'strike', 'shield', 'block', 'defend', 'charge', 'guard', 'protect', 'swing', 'hit', 'brace', 'tackle', 'slam', 'weapon', 'sword', 'axe', 'fist', 'stance', 'parry'];
    const healWords = ['heal', 'tend', 'treat', 'comfort', 'calm', 'soothe', 'bandage', 'herb', 'sing', 'care', 'empathy', 'nurture', 'gentle', 'pray', 'mend', 'wound', 'patch', 'medicine'];
    const loreWords = ['study', 'examine', 'investigate', 'research', 'analyze', 'inspect', 'read', 'lore', 'ancient', 'geological', 'mineral', 'artifact', 'ruin', 'inscription', 'sigil', 'theory', 'note', 'fossil', 'sample', 'stone', 'formation', 'observe'];

    function countSkillWords(actions: string[], words: string[]): number {
      return actions.reduce((sum, a) => sum + words.filter(w => a.includes(w)).length, 0);
    }

    const wFight = countSkillWords(warriorActions, fightWords);
    const wTotal = warriorActions.length;
    const hHeal = countSkillWords(healerActions, healWords);
    const hTotal = healerActions.length;
    const sLore = countSkillWords(scholarActions, loreWords);
    const sTotal = scholarActions.length;

    console.log(`Warrior: ${wFight}/${wTotal} actions contain fight/defend words`);
    console.log(`Healer:  ${hHeal}/${hTotal} actions contain heal/empathy words`);
    console.log(`Scholar: ${sLore}/${sTotal} actions contain lore/investigate words`);

    // Log sample actions
    console.log('\nSample warrior actions:');
    warriorActions.slice(0, 5).forEach(a => console.log(`  - ${a.slice(0, 80)}`));
    console.log('Sample healer actions:');
    healerActions.slice(0, 5).forEach(a => console.log(`  - ${a.slice(0, 80)}`));
    console.log('Sample scholar actions:');
    scholarActions.slice(0, 5).forEach(a => console.log(`  - ${a.slice(0, 80)}`));

    // --- Professor personality ---
    console.log('\n--- PROFESSOR PERSONALITY ---');
    const allText = allNarrations.join(' ').toLowerCase();
    const professorSignals = [
      'teach', 'learn', 'lesson', 'rule', 'tip', 'note', 'clever', 'well done',
      'good thinking', 'consider', 'remember', 'in game terms', 'mechanic',
      'skill check', 'aspect', 'fate point', 'invoke', 'compel',
      'difficulty', 'succeed', 'excellent', 'nicely', 'try',
      'suggest', 'approach', 'strategy', 'think about', 'encourage',
      'patient', 'explain', 'understand', 'practice',
    ];
    const profSignalCounts: Record<string, number> = {};
    let totalProfSignals = 0;
    for (const signal of professorSignals) {
      const regex = new RegExp(signal, 'gi');
      const matches = allText.match(regex);
      const count = matches ? matches.length : 0;
      if (count > 0) {
        profSignalCounts[signal] = count;
        totalProfSignals += count;
      }
    }
    console.log(`Professor personality signal words: ${totalProfSignals}`);
    const topProf = Object.entries(profSignalCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [word, count] of topProf) {
      console.log(`  "${word}": ${count}`);
    }
    if (totalProfSignals < 3) {
      findings.push(`WARNING: Only ${totalProfSignals} professor-personality signal words — preset may not affect narration style`);
    }

    // --- Scenario NPC appearances ---
    console.log('\n--- SCENARIO NPCs ---');
    const npcs = ['Maren', 'Tobias', 'Elder'];
    for (const npc of npcs) {
      const regex = new RegExp(npc, 'gi');
      const matches = allText.match(regex);
      console.log(`  ${npc}: ${matches?.length ?? 0} mentions`);
    }

    // --- Compaction ---
    console.log('\n--- CONTEXT MANAGEMENT ---');
    const compactionLogs = allServerLogs.filter(l => l.includes('Session recap') || l.includes('Mid-scene fact'));
    const factLogs = allServerLogs.filter(l => l.includes('Fact extraction'));
    const seedLogs = allServerLogs.filter(l => l.includes('Seeded scenario'));
    const memoryLogs = allServerLogs.filter(l => l.includes('[memory]'));
    console.log(`Scenario seedings: ${seedLogs.length}`);
    console.log(`Compaction events: ${compactionLogs.length}`);
    console.log(`Fact extractions: ${factLogs.length}`);
    console.log(`Memory errors: ${memoryLogs.length}`);
    factLogs.forEach(l => console.log(`  ${l.slice(0, 120)}`));

    if (turnsCompleted >= 20 && compactionLogs.length === 0) {
      findings.push('WARNING: No transcript compaction in 20+ turns — context may be growing unbounded');
    }

    // --- Scene pacing ---
    console.log('\n--- SCENE PACING ---');
    if (scenesCompleted > 0) {
      const avg = turnsCompleted / scenesCompleted;
      console.log(`Avg turns per scene: ${avg.toFixed(1)}`);
    }
    if (scenesCompleted >= 4) {
      console.log('Reached Act III territory (4+ scenes)');
    } else if (turnsCompleted >= 25) {
      findings.push(`WARNING: Only ${scenesCompleted} scenes in ${turnsCompleted} turns — may be stuck`);
    }

    // --- Unresolved thread persistence ---
    console.log('\n--- UNRESOLVED THREADS ---');
    const threadLogs = allServerLogs.filter(l => l.includes('UNRESOLVED') || l.includes('faded from'));
    console.log(`Thread-related log entries: ${threadLogs.length}`);
    threadLogs.forEach(l => console.log(`  ${l.slice(0, 120)}`));

    // --- Action log summary ---
    console.log('\n--- ACTION LOG ---');
    for (const entry of actionLog) {
      console.log(`  T${entry.turn} ${entry.char} [${entry.influence}]: ${entry.action.slice(0, 60)}`);
    }

    // --- Zod/error tracking from server logs ---
    const zodErrors = allServerLogs.filter(l => l.includes('Zod rejected') || l.includes('ZodError'));
    const llmErrors = allServerLogs.filter(l => l.includes('failed') && !l.includes('Fact extraction'));
    console.log(`\nZod rejection errors: ${zodErrors.length}`);
    zodErrors.forEach(l => console.log(`  ${l.slice(0, 120)}`));
    console.log(`LLM call failures: ${llmErrors.length}`);
    llmErrors.slice(0, 5).forEach(l => console.log(`  ${l.slice(0, 120)}`));

    // ---- Final findings ----
    console.log(`\n=== FINDINGS: ${findings.length === 0 ? 'NONE' : findings.length} ===`);
    findings.forEach(f => console.log(`  - ${f}`));

    // Assertions
    expect(turnsCompleted).toBeGreaterThanOrEqual(10);
    expect(seedLogs.length).toBeGreaterThanOrEqual(1);

    host.close(); p1.close(); p2.close(); p3.close();
  }, 1_200_000); // 20 minute timeout for 35-turn 3-char game
});
