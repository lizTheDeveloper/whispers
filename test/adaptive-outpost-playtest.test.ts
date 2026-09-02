import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';
import type { CharacterDefinition } from '../src/shared/types.js';
import { generateWhisper, type PlayerStyle, type GameState } from './lib/adaptive-whisper.js';
import { connectWs as _connectWs, sendMsg, MessageQueue, getFreePort } from './lib/ws-helpers.js';


const LLM_PROXY_URL = process.env.LLM_PROXY_URL;
const describeIfLive = LLM_PROXY_URL ? describe : describe.skip;

let serverProcess: ReturnType<typeof import('node:child_process').fork> | null = null;
let port: number;
const allServerLogs: string[] = [];

function connectWs(): Promise<WebSocket> { return _connectWs(port); }

const queues = new Map<WebSocket, MessageQueue>();
function q(ws: WebSocket): MessageQueue {
  let mq = queues.get(ws);
  if (!mq) { mq = new MessageQueue(ws); queues.set(ws, mq); }
  return mq;
}
function waitForMsg(ws: WebSocket, type: string, timeoutMs = 90_000): Promise<ServerMessage> {
  return q(ws).waitFor(type, timeoutMs);
}
function waitForAnyMsg(ws: WebSocket, types: string[], timeoutMs = 90_000): Promise<ServerMessage> {
  return q(ws).waitForAny(types, timeoutMs);
}

async function completeDmSetup(ws: WebSocket): Promise<void> {
  await waitForMsg(ws, 'dm-settings');
  await waitForMsg(ws, 'dm-chat-reply');
  const followUps = [
    'Use FATE Core. Mystery investigation at a frontier trading post. Two players. No house rules.',
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

describeIfLive('Adaptive Whispers: Strategist vs Antagonist at Frontier Outpost', () => {
  it('runs 25 rounds with adaptive context-driven whispers testing trust dynamics', async () => {
    const findings: string[] = [];

    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Adaptive Outpost Playtest',
      dmPreset: 'trickster',
      scenarioId: 'frontier-outpost',
      systemId: 'fate-core',
      houseRules: null,
    });
    const roomMsg = await roomPromise;
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;

    await completeDmSetup(host);

    const p1 = await connectWs();
    const p2 = await connectWs();
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Strategist' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'Antagonist' });
    await Promise.all([waitForMsg(p1, 'room-joined'), waitForMsg(p2, 'room-joined')]);

    const diplomat: CharacterDefinition = {
      name: 'Mira Voss',
      highConcept: 'Border Diplomat Who Speaks Every Language But Her Own Heart',
      trouble: 'I Make Promises I Cannot Keep',
      aspects: ['Words Are My Weapons', 'The Treaty Must Hold', 'Everyone Has A Price — Even Me'],
      personality: 'Charismatic and calculating. Finds leverage in every conversation.',
      backstory: 'Sent by the governor to broker peace. Failed once before — twelve people died.',
      skills: { Rapport: 4, Deceive: 3, Empathy: 3, Investigate: 2, Will: 2, Lore: 1, Notice: 1, Athletics: 0 },
      stunts: ['Silver Tongue: +2 to Rapport when negotiating between hostile parties', 'Read The Room: +2 to Empathy when assessing group mood'],
    };

    const tracker: CharacterDefinition = {
      name: 'Renn Blackwood',
      highConcept: 'Frontier Scout Who Trusts Tracks More Than Words',
      trouble: 'The Wilderness Has My Loyalty — Not Any Flag',
      aspects: ['The Land Remembers Everything', 'No Trail Goes Cold On My Watch', 'I Owe Debts I Cannot Name'],
      personality: 'Laconic and intense. Reads terrain like a language. Uncomfortable with politics.',
      backstory: 'A former nomad scout who crossed to the settler side. Neither side trusts him.',
      skills: { Notice: 4, Investigate: 3, Athletics: 3, Stealth: 2, Survival: 2, Fight: 1, Will: 1, Rapport: 0 },
      stunts: ['Read The Land: +2 to Investigate when examining outdoor tracks', 'Quick Reflexes: +2 to Athletics when reacting to sudden danger'],
    };

    for (const [player, def, label] of [[p1, diplomat, 'diplomat'], [p2, tracker, 'tracker']] as const) {
      let approved = false;
      let charId = '';
      for (let attempt = 0; attempt < 3 && !approved; attempt++) {
        const valPromise = waitForMsg(player, 'character-validated', 90_000);
        sendMsg(player, { type: 'submit-character', definition: def });
        const valMsg = await valPromise;
        if (valMsg.type === 'character-validated' && (valMsg as any).approved) {
          charId = (valMsg as any).characterId;
          approved = true;
          console.log(`[adaptive] ${label} AI-approved: ${charId}`);
        } else {
          console.log(`[adaptive] ${label} validation attempt ${attempt + 1} failed`);
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
      console.log(`[adaptive] Host approved ${label}`);
      await new Promise(r => setTimeout(r, 1000));
    }

    sendMsg(host, { type: 'start-game' });
    const startMsg = await waitForMsg(p1, 'phase-change', 10_000);
    expect(startMsg.type === 'phase-change' && (startMsg as any).phase).toBe('playing');
    console.log('[adaptive] Game started');

    const narrations: string[] = [];
    const actionsTaken: Array<{ char: string; action: string; turn: number }> = [];
    const whispersSent: Array<{ char: string; whisper: string; style: PlayerStyle; turn: number }> = [];
    const trustTrajectory: Array<{ char: string; trust: number; turn: number }> = [];
    const locations: string[] = [];
    let sceneCount = 0;
    let turnCount = 0;
    let followedCount = 0;
    let ignoredCount = 0;

    const TARGET_TURNS = 25;

    const charStyles: Record<string, PlayerStyle> = {
      'Mira Voss': 'strategist',
      'Renn Blackwood': 'antagonist',
    };

    const gameState: GameState = {
      round: 0,
      sceneCount: 0,
      narrations: [],
      actions: [],
      locations: [],
      characterNames: ['Mira Voss', 'Renn Blackwood'],
    };

    let gameEnded = false;
    for (let round = 1; round <= TARGET_TURNS && !gameEnded; round++) {
      gameState.round = round;

      try {
        const narMsg = await waitForAnyMsg(host, ['narration', 'phase-change'], 180_000);
        if (narMsg.type === 'phase-change') {
          if ((narMsg as any).phase === 'ended') { console.log(`[adaptive] Game ended at round ${round}`); gameEnded = true; break; }
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
          sceneCount++;
          gameState.sceneCount = sceneCount;
          console.log(`[adaptive] Scene ${sceneCount} ended at round ${round}`);
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

          const style = charStyles[charName] ?? 'mentor';
          const lastAction = actionsTaken.filter(a => a.char === charName).slice(-1)[0]?.action;
          const whisper = generateWhisper(style, charName, gameState, narMsg.text, lastAction);

          sendMsg(host, { type: 'whisper', text: whisper });
          whispersSent.push({ char: charName, whisper, style, turn: round });
          console.log(`[adaptive] R${round} [${style}] → ${charName.split(' ')[0]}: "${whisper.slice(0, 60)}"`);

          const actionMsg = await waitForMsg(host, 'action-taken', 120_000);
          if (actionMsg.type === 'action-taken') {
            const action = (actionMsg as any).action as string;
            actionsTaken.push({ char: (actionMsg as any).characterName, action, turn: round });
            gameState.actions.push({ char: (actionMsg as any).characterName, action });

            const influence = (actionMsg as any).whisperInfluence as string;
            if (influence === 'followed') followedCount++;
            else if (influence === 'ignored') ignoredCount++;
          }

          const resMsg = await waitForAnyMsg(host, ['narration', 'resolution', 'scene-end', 'phase-change'], 120_000);
          if (resMsg.type === 'narration' || resMsg.type === 'resolution') {
            narrations.push(resMsg.text ?? '');
            gameState.narrations.push(resMsg.text ?? '');
          }
          if (resMsg.type === 'scene-end') {
            sceneCount++;
            gameState.sceneCount = sceneCount;
            console.log(`[adaptive] Scene ${sceneCount} ended at round ${round}`);
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

        if (round % 3 === 0) {
          const trustByChar: Record<string, number[]> = {};
          for (const t of trustTrajectory) {
            if (!trustByChar[t.char]) trustByChar[t.char] = [];
            trustByChar[t.char]!.push(t.trust);
          }
          const trustSummary = Object.entries(trustByChar).map(([c, vals]) =>
            `${c.split(' ')[0]}: ${vals[vals.length - 1]?.toFixed(2) ?? '?'}`
          ).join(', ');
          console.log(`[adaptive] Round ${round} — ${sceneCount} scenes, ${new Set(locations).size} locs, ${actionsTaken.length} actions, trust=[${trustSummary}], follow/ignore=${followedCount}/${ignoredCount}`);
        }
      } catch (e) {
        findings.push(`Round ${round}: ${(e as Error).message}`);
        console.error(`[adaptive] Round ${round} error:`, (e as Error).message);
        if (round < 3) throw e;
      }
    }

    console.log(`\n[adaptive] === RESULTS ===`);
    console.log(`[adaptive] Rounds: ${turnCount}/${TARGET_TURNS}`);
    console.log(`[adaptive] Actions: ${actionsTaken.length} (by ${new Set(actionsTaken.map(a => a.char)).size} chars)`);
    console.log(`[adaptive] Scenes: ${sceneCount}`);
    console.log(`[adaptive] Unique locations: ${new Set(locations).size}`);
    console.log(`[adaptive] Whispers sent: ${whispersSent.length}`);
    console.log(`[adaptive] Followed: ${followedCount}, Ignored: ${ignoredCount}, Partial: ${whispersSent.length - followedCount - ignoredCount}`);

    const trustByChar: Record<string, number[]> = {};
    for (const t of trustTrajectory) {
      if (!trustByChar[t.char]) trustByChar[t.char] = [];
      trustByChar[t.char]!.push(t.trust);
    }
    for (const [char, vals] of Object.entries(trustByChar)) {
      const first = vals[0]!;
      const last = vals[vals.length - 1]!;
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      console.log(`[adaptive] Trust ${char}: ${first.toFixed(2)} → ${last.toFixed(2)} (range ${min.toFixed(2)}-${max.toFixed(2)})`);
    }

    console.log(`\n[adaptive] Whisper log:`);
    for (const w of whispersSent) {
      console.log(`  R${w.turn} [${w.style}] → ${w.char.split(' ')[0]}: "${w.whisper.slice(0, 70)}"`);
    }

    if (findings.length > 0) console.log(`[adaptive] Findings: ${findings.join('; ')}`);

    expect(turnCount).toBeGreaterThanOrEqual(5);
    expect(sceneCount).toBeGreaterThanOrEqual(2);
    expect(new Set(locations).size).toBeGreaterThanOrEqual(2);
    const uniqueChars = new Set(actionsTaken.map(a => a.char));
    expect(uniqueChars.size).toBe(2);

    const strategistWhispers = whispersSent.filter(w => w.style === 'strategist');
    const antagonistWhispers = whispersSent.filter(w => w.style === 'antagonist');
    expect(strategistWhispers.length).toBeGreaterThan(0);
    expect(antagonistWhispers.length).toBeGreaterThan(0);

  }, 1_800_000);
});
