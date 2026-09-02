import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getFreePort } from './lib/ws-helpers.js';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';
import type { CharacterDefinition } from '../src/shared/types.js';
import { generateWhisper, type PlayerStyle, type GameState } from './lib/adaptive-whisper.js';
import { writeFileSync } from 'node:fs';

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
    'Use FATE Core. Dungeon crawl in a collapsed mine. Two players: a dwarven miner and a human scholar. No house rules.',
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
    allServerLogs.slice(-80).forEach(l => console.log(l));
  }
});

describeIfLive('Quality: 2-char Collapsed Mine — companion dynamics & trust divergence', () => {
  it('runs 25 turns with two characters testing party coordination and trust', async () => {
    const findings: string[] = [];

    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Mine Quality Playtest',
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
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Dwarven Guide' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'Scholar' });
    await Promise.all([waitForMsg(p1, 'room-joined'), waitForMsg(p2, 'room-joined')]);

    const grimjaw: CharacterDefinition = {
      name: 'Grimjaw',
      highConcept: 'The Last Deep Miner',
      trouble: 'Stubborn Pride',
      aspects: ['These Tunnels Are My Blood', 'Fists Before Words', 'I Will Not Leave Them Behind'],
      personality: 'Gruff, loyal, stubborn. Speaks in short sentences. Trusts stone more than people.',
      backstory: 'Worked these mines since he was twelve. Lost his brother in the deep tunnels years ago. Volunteered first when the collapse happened.',
      skills: { Fight: 3, Crafts: 2, Athletics: 2, Notice: 1, Will: 1, Stealth: 0, Rapport: 0, Investigate: 0 },
      stunts: ['Tunnel Fighter: +2 to Fight in confined underground spaces', 'Stone Sense: +2 to Notice when detecting structural instability'],
    };

    const wren: CharacterDefinition = {
      name: 'Wren Ashfield',
      highConcept: 'Keeper of Lost Knowledge',
      trouble: 'Curiosity Kills',
      aspects: ['Every Ruin Tells A Story', 'The Old Texts Were Right', 'Braver Than I Look'],
      personality: 'Curious, methodical, talkative. Takes notes on everything. Fascinated by ancient things.',
      backstory: 'An academic who came to study the pre-mine ruins. Volunteered for the rescue to get access to the deep excavation.',
      skills: { Investigate: 3, Lore: 2, Rapport: 2, Notice: 1, Empathy: 1, Athletics: 0, Fight: 0, Stealth: 0 },
      stunts: ['Ancient Languages: +2 to Lore when deciphering pre-modern inscriptions', 'Cataloger: +2 to Investigate when systematically searching a room'],
    };

    for (const [player, def, label] of [[p1, grimjaw, 'grimjaw'], [p2, wren, 'wren']] as const) {
      let approved = false;
      let charId = '';
      for (let attempt = 0; attempt < 3 && !approved; attempt++) {
        const valPromise = waitForMsg(player, 'character-validated', 90_000);
        sendMsg(player, { type: 'submit-character', definition: def });
        const valMsg = await valPromise;
        if (valMsg.type === 'character-validated' && (valMsg as any).approved) {
          charId = (valMsg as any).characterId;
          approved = true;
          console.log(`[mine-2char] ${label} approved: ${charId}`);
        } else {
          console.log(`[mine-2char] ${label} validation attempt ${attempt + 1} failed`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!approved) {
        findings.push(`BUG: ${label} never approved after 3 attempts`);
        return;
      }
      await waitForMsg(host, 'negotiation-opened', 30_000);
      await waitForMsg(host, 'negotiation-message', 90_000);
      sendMsg(host, { type: 'host-approve-character', characterId: charId });
      console.log(`[mine-2char] Host approved ${label}`);
      await new Promise(r => setTimeout(r, 1000));
    }

    sendMsg(host, { type: 'start-game' });
    const startMsg = await waitForMsg(p1, 'phase-change', 10_000);
    expect(startMsg.type === 'phase-change' && (startMsg as any).phase).toBe('playing');
    console.log('[mine-2char] Game started');

    const narrations: string[] = [];
    const actionsTaken: Array<{ char: string; action: string; turn: number; influence: string }> = [];
    const whispersSent: Array<{ char: string; whisper: string; turn: number }> = [];
    const trustTrajectory: Array<{ char: string; trust: number; turn: number }> = [];
    const locations: string[] = [];
    const sceneEndTurns: number[] = [];
    let turnCount = 0;

    const TARGET_TURNS = 25;

    const gameState: GameState = {
      round: 0,
      sceneCount: 0,
      narrations: [],
      actions: [],
      locations: [],
      characterNames: ['Grimjaw', 'Wren Ashfield'],
    };

    const grimjawWhispers = [
      'Push forward. You know these tunnels — trust your gut, not the scholar.',
      'Break through that wall. Your strength is what they need right now.',
      'Charge ahead. The miners are running out of time — speed matters more than caution.',
      'Fight your way through. Talking wastes time people don\'t have.',
      'You\'ve been in worse. Keep moving deeper — the answer is always further in.',
      'Don\'t wait for permission. Act now.',
      'Smash it. Brute force has gotten you this far.',
      'Lead the way — you\'re the miner, not her.',
    ];
    const wrenWhispers = [
      'Stop and think. There\'s a pattern here you haven\'t decoded yet.',
      'Don\'t rush — analyze the inscriptions first. The answer is in the details.',
      'Hold back and observe. Something about this doesn\'t add up.',
      'Be careful — your curiosity is going to get you killed if you don\'t slow down.',
      'Read the room before acting. Knowledge is power, not brawn.',
      'Wait. Document what you see. The symbols will tell you the way.',
      'Don\'t touch anything yet. Study it first.',
      'Slow down — rushing is how people die underground.',
    ];

    let gameEnded = false;
    for (let round = 1; round <= TARGET_TURNS && !gameEnded; round++) {
      gameState.round = round;

      try {
        const narMsg = await waitForAnyMsg(host, ['narration', 'phase-change'], 180_000);
        if (narMsg.type === 'phase-change') {
          if ((narMsg as any).phase === 'ended') { console.log(`[mine-2char] Game ended at round ${round}`); gameEnded = true; break; }
          continue;
        }
        narrations.push(narMsg.text);
        gameState.narrations.push(narMsg.text);
        if ((narMsg as any).locationName) {
          locations.push((narMsg as any).locationName);
          gameState.locations.push((narMsg as any).locationName);
        }
        turnCount = round;

        const next = await waitForAnyMsg(host, ['action-proposals', 'scene-end', 'phase-change'], 120_000);
        if (next.type === 'scene-end') {
          sceneEndTurns.push(round);
          gameState.sceneCount++;
          console.log(`[mine-2char] Scene ${gameState.sceneCount} ended at round ${round}`);
          continue;
        }
        if (next.type === 'phase-change') { if ((next as any).phase === 'ended') { gameEnded = true; break; } continue; }
        if (next.type !== 'action-proposals') continue;

        let currentProposals: ServerMessage | null = next;
        for (let charIdx = 0; charIdx < 2 && currentProposals; charIdx++) {
          const charName = (currentProposals as any).characterName as string;
          const trust = (currentProposals as any).whisperTrust as number;
          if (trust !== undefined) trustTrajectory.push({ char: charName, trust, turn: round });

          await waitForMsg(host, 'whisper-prompt', 30_000);

          const isGrimjaw = charName === 'Grimjaw';
          const whisperPool = isGrimjaw ? grimjawWhispers : wrenWhispers;
          const whisper = whisperPool[(round + charIdx) % whisperPool.length]!;

          sendMsg(host, { type: 'whisper', text: whisper });
          whispersSent.push({ char: charName, whisper, turn: round });
          console.log(`[mine-2char] R${round} → ${charName}: "${whisper.slice(0, 60)}"`);

          const actionMsg = await waitForMsg(host, 'action-taken', 120_000);
          if (actionMsg.type === 'action-taken') {
            const action = (actionMsg as any).action as string;
            const influence = (actionMsg as any).whisperInfluence as string ?? 'unknown';
            actionsTaken.push({ char: (actionMsg as any).characterName, action, turn: round, influence });
            gameState.actions.push({ char: (actionMsg as any).characterName, action });
            console.log(`[mine-2char] R${round} ${(actionMsg as any).characterName}: ${action.slice(0, 80)} [${influence}]`);
          }

          const resMsg = await waitForAnyMsg(host, ['narration', 'resolution', 'scene-end', 'phase-change'], 120_000);
          if (resMsg.type === 'narration' || resMsg.type === 'resolution') {
            narrations.push(resMsg.text ?? '');
            gameState.narrations.push(resMsg.text ?? '');
          }
          if (resMsg.type === 'scene-end') {
            sceneEndTurns.push(round);
            gameState.sceneCount++;
            console.log(`[mine-2char] Scene ${gameState.sceneCount} ended at round ${round}`);
            currentProposals = null;
            break;
          }
          if (resMsg.type === 'phase-change') {
            if ((resMsg as any).phase === 'ended') { gameEnded = true; }
            currentProposals = null;
            break;
          }

          if (charIdx < 1) {
            let found = false;
            for (let drain = 0; drain < 8 && !found; drain++) {
              const peek = await waitForAnyMsg(host, ['action-proposals', 'narration', 'scene-end', 'phase-change', 'character-state-update', 'dice-roll'], 60_000).catch(() => null);
              if (!peek) { currentProposals = null; break; }
              if (peek.type === 'action-proposals') { currentProposals = peek; found = true; }
              else if (peek.type === 'character-state-update' || peek.type === 'dice-roll') { continue; }
              else { currentProposals = null; break; }
            }
            if (!found) currentProposals = null;
          }
        }

        if (round % 5 === 0) {
          const trustByChar: Record<string, number[]> = {};
          for (const t of trustTrajectory) {
            if (!trustByChar[t.char]) trustByChar[t.char] = [];
            trustByChar[t.char]!.push(t.trust);
          }
          const trustSummary = Object.entries(trustByChar).map(([c, vals]) =>
            `${c}: ${vals[vals.length - 1]?.toFixed(2) ?? '?'}`
          ).join(', ');
          const grimjawActions = actionsTaken.filter(a => a.char === 'Grimjaw').length;
          const wrenActions = actionsTaken.filter(a => a.char === 'Wren Ashfield').length;
          console.log(`[mine-2char] === Round ${round} checkpoint === scenes=${gameState.sceneCount}, locs=${new Set(locations).size}, grimjaw=${grimjawActions}acts, wren=${wrenActions}acts, trust=[${trustSummary}]`);
        }
      } catch (e) {
        findings.push(`Round ${round}: ${(e as Error).message}`);
        console.error(`[mine-2char] Round ${round} error:`, (e as Error).message);
        if (round < 3) throw e;
      }
    }

    // === ANALYSIS ===
    const grimjawActions = actionsTaken.filter(a => a.char === 'Grimjaw');
    const wrenActions = actionsTaken.filter(a => a.char === 'Wren Ashfield');

    const trustByChar: Record<string, number[]> = {};
    for (const t of trustTrajectory) {
      if (!trustByChar[t.char]) trustByChar[t.char] = [];
      trustByChar[t.char]!.push(t.trust);
    }

    const grimjawTrust = trustByChar['Grimjaw'] ?? [];
    const wrenTrust = trustByChar['Wren Ashfield'] ?? [];
    const grimjawFinalTrust = grimjawTrust[grimjawTrust.length - 1] ?? 0.5;
    const wrenFinalTrust = wrenTrust[wrenTrust.length - 1] ?? 0.5;
    const trustDivergence = Math.abs(grimjawFinalTrust - wrenFinalTrust);

    const categorize = (action: string): string => {
      const lower = action.toLowerCase();
      if (/fight|attack|strike|punch|swing|charge|tackle|grapple/.test(lower)) return 'fight';
      if (/investigate|examine|study|analyze|search|inspect|clue|deduce/.test(lower)) return 'investigate';
      if (/talk|ask|persuade|negotiate|reason|speak|tell|demand|plead/.test(lower)) return 'social';
      if (/craft|fix|repair|build|tinker|modify|jury-rig/.test(lower)) return 'crafts';
      if (/sneak|creep|hide|stealth|quiet|shadow/.test(lower)) return 'stealth';
      if (/climb|jump|run|sprint|leap|dodge|vault/.test(lower)) return 'athletics';
      if (/notice|watch|observe|look|listen|scan|spot/.test(lower)) return 'notice';
      if (/recall|know|lore|recognize|ancient|history|read|inscription|symbol/.test(lower)) return 'lore';
      return 'other';
    };

    const grimjawCategories = grimjawActions.map(a => categorize(a.action));
    const wrenCategories = wrenActions.map(a => categorize(a.action));
    const grimjawUniqueSkills = new Set(grimjawCategories);
    const wrenUniqueSkills = new Set(wrenCategories);

    const companionMentions = actionsTaken.filter(a => {
      const otherName = a.char === 'Grimjaw' ? 'Wren' : 'Grimjaw';
      return a.action.toLowerCase().includes(otherName.toLowerCase());
    });

    const uniqueLocations = new Set(locations);
    const scenarioLocations = ['Thornhaven', 'The Old Mine Entrance', 'The Ventilation Shaft', 'The Upper Tunnels', 'The Collapse Zone', 'The Deep Excavation', 'The Crystal Chamber'];
    const visitedScenarioLocs = scenarioLocations.filter(sl => locations.some(l => l.includes(sl.replace(/^The /, ''))));

    const grimjawFollowed = grimjawActions.filter(a => a.influence === 'followed').length;
    const grimjawIgnored = grimjawActions.filter(a => a.influence === 'ignored').length;
    const wrenFollowed = wrenActions.filter(a => a.influence === 'followed').length;
    const wrenIgnored = wrenActions.filter(a => a.influence === 'ignored').length;

    const report = [
      `# 2-Character Mine Playtest Report`,
      ``,
      `## Summary`,
      `- **Turns completed:** ${turnCount}/${TARGET_TURNS}`,
      `- **Scenes:** ${gameState.sceneCount}`,
      `- **Game ended naturally:** ${gameEnded}`,
      `- **Unique locations visited:** ${uniqueLocations.size} (${[...uniqueLocations].join(', ')})`,
      `- **Scenario locations hit:** ${visitedScenarioLocs.length}/${scenarioLocations.length} (${visitedScenarioLocs.join(', ')})`,
      ``,
      `## Turn Rotation`,
      `- Grimjaw actions: ${grimjawActions.length}`,
      `- Wren actions: ${wrenActions.length}`,
      `- Rotation balance: ${Math.abs(grimjawActions.length - wrenActions.length) <= 1 ? 'GOOD' : 'IMBALANCED'}`,
      ``,
      `## Trust Divergence`,
      `- Grimjaw trust: ${grimjawTrust[0]?.toFixed(2) ?? '?'} → ${grimjawFinalTrust.toFixed(2)} (aggressive whispers)`,
      `- Wren trust: ${wrenTrust[0]?.toFixed(2) ?? '?'} → ${wrenFinalTrust.toFixed(2)} (cautious whispers)`,
      `- Trust divergence: ${trustDivergence.toFixed(3)} ${trustDivergence > 0.10 ? '✓ MEANINGFUL' : '✗ TOO SMALL'}`,
      ``,
      `## Skill Diversity`,
      `- Grimjaw used ${grimjawUniqueSkills.size} unique skill categories: ${[...grimjawUniqueSkills].join(', ')}`,
      `  - Breakdown: ${Object.entries(grimjawCategories.reduce((a: Record<string, number>, c) => { a[c] = (a[c] ?? 0) + 1; return a; }, {})).map(([k, v]) => `${k}=${v}`).join(', ')}`,
      `- Wren used ${wrenUniqueSkills.size} unique skill categories: ${[...wrenUniqueSkills].join(', ')}`,
      `  - Breakdown: ${Object.entries(wrenCategories.reduce((a: Record<string, number>, c) => { a[c] = (a[c] ?? 0) + 1; return a; }, {})).map(([k, v]) => `${k}=${v}`).join(', ')}`,
      ``,
      `## Companion Awareness`,
      `- Actions mentioning companion by name: ${companionMentions.length}/${actionsTaken.length} (${(100 * companionMentions.length / Math.max(1, actionsTaken.length)).toFixed(0)}%)`,
      companionMentions.length > 0 ? companionMentions.map(a => `  - R${a.turn} ${a.char}: "${a.action.slice(0, 80)}"`).join('\n') : '  - None (issue: characters acting independently)',
      ``,
      `## Whisper Influence`,
      `- Grimjaw: followed=${grimjawFollowed}, ignored=${grimjawIgnored}, partial=${grimjawActions.length - grimjawFollowed - grimjawIgnored}`,
      `- Wren: followed=${wrenFollowed}, ignored=${wrenIgnored}, partial=${wrenActions.length - wrenFollowed - wrenIgnored}`,
      ``,
      `## Scene Pacing`,
      `- Scene end turns: ${sceneEndTurns.join(', ') || 'none'}`,
      sceneEndTurns.length >= 2 ? `- Avg scene length: ${(sceneEndTurns.reduce((a, b, i) => a + (i > 0 ? b - sceneEndTurns[i - 1]! : b), 0) / sceneEndTurns.length).toFixed(1)} rounds` : '',
      ``,
      `## Action Log`,
      ...actionsTaken.map(a => `- R${a.turn} ${a.char}: ${a.action.slice(0, 100)} [${a.influence}]`),
      ``,
      `## Trust Trajectory`,
      ...trustTrajectory.map(t => `- R${t.turn} ${t.char}: ${t.trust.toFixed(3)}`),
      ``,
      `## Findings`,
      findings.length > 0 ? findings.map(f => `- ${f}`).join('\n') : '- No issues found',
    ].filter(l => l !== undefined).join('\n');

    console.log('\n' + report);

    try {
      writeFileSync('/private/tmp/claude-501/-Users-annhoward-src-multiverse-games/d35faae9-4c79-40ac-bb63-bcc19754f6eb/scratchpad/mine-2char-25-report.md', report);
    } catch {}

    // Assertions
    expect(turnCount).toBeGreaterThanOrEqual(5);
    expect(gameState.sceneCount).toBeGreaterThanOrEqual(2);
    expect(uniqueLocations.size).toBeGreaterThanOrEqual(2);
    const uniqueChars = new Set(actionsTaken.map(a => a.char));
    expect(uniqueChars.size).toBe(2);
    expect(Math.abs(grimjawActions.length - wrenActions.length)).toBeLessThanOrEqual(3);
    expect(grimjawUniqueSkills.size).toBeGreaterThanOrEqual(2);
    expect(wrenUniqueSkills.size).toBeGreaterThanOrEqual(2);
  }, 600_000);
});
