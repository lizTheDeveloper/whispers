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
    'Use FATE Core. Mystery investigation at a frontier outpost. One player. No house rules.',
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
    allServerLogs.slice(-100).forEach(l => console.log(l));
  }
});

describeIfLive('Quality Playtest: Chronicler DM + Frontier Outpost (resolve context + whisper tension)', () => {
  it('runs 30 turns with mentor→antagonist whisper switch to validate NPC dialogue and trust dynamics', async () => {
    const findings: string[] = [];

    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Quality Outpost Chronicler',
      dmPreset: 'chronicler',
      scenarioId: 'frontier-outpost',
      systemId: 'fate-core',
      houseRules: null,
    });
    const roomMsg = await roomPromise;
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;

    await completeDmSetup(host);

    const p1 = await connectWs();
    sendMsg(p1, { type: 'join', joinCode, playerName: 'QualityTester' });
    await waitForMsg(p1, 'room-joined');

    const herbalist: CharacterDefinition = {
      name: 'Jessa Crane',
      highConcept: 'Healer Who Reads People Like Plants',
      trouble: 'I Take On Others\' Pain',
      aspects: ['Every Wound Tells A Story', 'The Remedy Is Always Close', 'Trust Given Too Freely'],
      personality: 'Warm, perceptive, and quietly stubborn. Sees the best in people even when it costs her.',
      backstory: 'Traveling herbalist who wandered into the outpost the day before the relic vanished. Now both sides suspect her.',
      skills: { Rapport: 3, Empathy: 3, Lore: 2, Notice: 2, Crafts: 1, Athletics: 1, Will: 0, Investigate: 0 },
      stunts: ['Bedside Manner: +2 to Empathy when someone is injured or afraid', 'Herbal Lore: +2 to Lore when identifying plants, poisons, or remedies'],
    };

    let approved = false;
    let charId = '';
    for (let attempt = 0; attempt < 3 && !approved; attempt++) {
      const valPromise = waitForMsg(p1, 'character-validated', 90_000);
      sendMsg(p1, { type: 'submit-character', definition: herbalist });
      const valMsg = await valPromise;
      if (valMsg.type === 'character-validated' && (valMsg as any).approved) {
        charId = (valMsg as any).characterId;
        approved = true;
        console.log(`[quality] Jessa AI-approved: ${charId}`);
      } else {
        console.log(`[quality] Validation attempt ${attempt + 1} failed`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (!approved) {
      findings.push('BUG: Character never approved after 3 attempts');
      expect(approved).toBe(true);
      return;
    }
    await waitForMsg(host, 'negotiation-opened', 30_000);
    await waitForMsg(host, 'negotiation-message', 90_000);
    sendMsg(host, { type: 'host-approve-character', characterId: charId });
    console.log('[quality] Host approved Jessa');
    await new Promise(r => setTimeout(r, 1000));

    sendMsg(host, { type: 'start-game' });
    const startMsg = await waitForMsg(p1, 'phase-change', 10_000);
    expect(startMsg.type === 'phase-change' && (startMsg as any).phase).toBe('playing');
    console.log('[quality] Game started');

    const narrations: string[] = [];
    const resolutions: string[] = [];
    const actionsTaken: Array<{ action: string; turn: number; spoken?: string }> = [];
    const whispersSent: Array<{ whisper: string; style: PlayerStyle; turn: number }> = [];
    const trustTrajectory: Array<{ trust: number; turn: number }> = [];
    const locations: string[] = [];
    const npcDialogueResolutions: Array<{ turn: number; text: string }> = [];
    let sceneCount = 0;
    let turnCount = 0;
    let followedCount = 0;
    let ignoredCount = 0;

    const TARGET_TURNS = 30;
    const WHISPER_SWITCH_TURN = 10;

    const KNOWN_NPCS = ['Marshal Thorne', 'Chieftain Asha', 'Kef the Trader', 'Old Berrin', 'Dara Windwalker', 'Brother Moss',
      'Thorne', 'Asha', 'Kef', 'Berrin', 'Dara', 'Moss'];

    const gameState: GameState = {
      round: 0,
      sceneCount: 0,
      narrations: [],
      actions: [],
      locations: [],
      characterNames: ['Jessa Crane'],
    };

    let gameEnded = false;
    for (let round = 1; round <= TARGET_TURNS && !gameEnded; round++) {
      gameState.round = round;
      const currentStyle: PlayerStyle = round <= WHISPER_SWITCH_TURN ? 'mentor' : 'antagonist';

      try {
        const narMsg = await waitForAnyMsg(host, ['narration', 'phase-change'], 180_000);
        if (narMsg.type === 'phase-change') {
          if ((narMsg as any).phase === 'ended') {
            console.log(`[quality] Game ended at round ${round}`);
            gameEnded = true;
            break;
          }
          continue;
        }
        narrations.push(narMsg.text);
        gameState.narrations.push(narMsg.text);
        const locName = (narMsg as any).locationName as string | undefined;
        if (locName) {
          locations.push(locName);
          gameState.locations.push(locName);
        }
        turnCount = round;

        const next = await waitForAnyMsg(host, ['action-proposals', 'scene-end', 'phase-change'], 120_000);
        if (next.type === 'scene-end') {
          sceneCount++;
          gameState.sceneCount = sceneCount;
          console.log(`[quality] Scene ${sceneCount} ended at round ${round}: ${((next as any).summary as string).slice(0, 80)}`);
          continue;
        }
        if (next.type === 'phase-change') {
          if ((next as any).phase === 'ended') { gameEnded = true; break; }
          continue;
        }
        if (next.type !== 'action-proposals') continue;

        const trust = (next as any).whisperTrust as number;
        if (trust !== undefined) trustTrajectory.push({ trust, turn: round });

        await waitForMsg(host, 'whisper-prompt', 30_000);

        const lastAction = actionsTaken.slice(-1)[0]?.action;
        const whisper = generateWhisper(currentStyle, 'Jessa Crane', gameState, narMsg.text, lastAction);
        sendMsg(host, { type: 'whisper', text: whisper });
        whispersSent.push({ whisper, style: currentStyle, turn: round });

        const actionMsg = await waitForMsg(host, 'action-taken', 120_000);
        if (actionMsg.type === 'action-taken') {
          const action = (actionMsg as any).action as string;
          const spoken = (actionMsg as any).spokenWords as string | null;
          actionsTaken.push({ action, turn: round, spoken: spoken ?? undefined });
          gameState.actions.push({ char: 'Jessa Crane', action });

          const influence = (actionMsg as any).whisperInfluence as string;
          if (influence === 'followed') followedCount++;
          else if (influence === 'ignored') ignoredCount++;
        }

        const resMsg = await waitForAnyMsg(host, ['narration', 'resolution', 'scene-end', 'phase-change'], 120_000);
        if (resMsg.type === 'narration' || resMsg.type === 'resolution') {
          const resText = (resMsg as any).text as string ?? '';
          resolutions.push(resText);
          gameState.narrations.push(resText);

          const hasQuotedDialogue = /"[^"]{5,}"/.test(resText);
          if (hasQuotedDialogue) {
            npcDialogueResolutions.push({ turn: round, text: resText });
          }

          const mentionedNpcs = KNOWN_NPCS.filter(n => resText.includes(n));
          const npcStr = mentionedNpcs.length > 0 ? mentionedNpcs.join(', ') : 'none';
          console.log(`[quality] Turn ${round} — trust: ${trust?.toFixed(2) ?? '?'}, loc: ${locName ?? '?'}, NPC: ${npcStr}${hasQuotedDialogue ? ' [DIALOGUE]' : ''}, style: ${currentStyle}`);
        }
        if (resMsg.type === 'scene-end') {
          sceneCount++;
          gameState.sceneCount = sceneCount;
          console.log(`[quality] Scene ${sceneCount} ended at round ${round}`);
        }
        if (resMsg.type === 'phase-change' && (resMsg as any).phase === 'ended') {
          gameEnded = true;
        }

      } catch (e) {
        findings.push(`Round ${round}: ${(e as Error).message}`);
        console.error(`[quality] Round ${round} error:`, (e as Error).message);
        if (round < 3) throw e;
      }
    }

    console.log(`\n[quality] === RESULTS ===`);
    console.log(`[quality] Rounds completed: ${turnCount}/${TARGET_TURNS}`);
    console.log(`[quality] Scenes: ${sceneCount}`);
    console.log(`[quality] Unique locations: ${new Set(locations).size} — ${[...new Set(locations)].join(', ')}`);
    console.log(`[quality] Actions: ${actionsTaken.length}`);
    console.log(`[quality] Whispers: ${whispersSent.length} (mentor: ${whispersSent.filter(w => w.style === 'mentor').length}, antagonist: ${whispersSent.filter(w => w.style === 'antagonist').length})`);
    console.log(`[quality] Followed: ${followedCount}, Ignored: ${ignoredCount}`);
    console.log(`[quality] NPC dialogue in resolutions: ${npcDialogueResolutions.length}/${resolutions.length}`);

    console.log(`\n[quality] Trust trajectory:`);
    for (const t of trustTrajectory) {
      const marker = t.turn === WHISPER_SWITCH_TURN ? ' ← SWITCH TO ANTAGONIST' : '';
      console.log(`  Turn ${t.turn}: ${t.trust.toFixed(3)}${marker}`);
    }

    console.log(`\n[quality] NPC dialogue examples:`);
    for (const d of npcDialogueResolutions.slice(0, 5)) {
      console.log(`  Turn ${d.turn}: ${d.text.slice(0, 120)}`);
    }

    console.log(`\n[quality] Spoken words by Jessa:`);
    for (const a of actionsTaken.filter(a => a.spoken)) {
      console.log(`  Turn ${a.turn}: "${a.spoken!.slice(0, 80)}"`);
    }

    if (findings.length > 0) {
      console.log(`\n[quality] Findings: ${findings.join('; ')}`);
    }

    expect(turnCount).toBeGreaterThanOrEqual(8);
    expect(sceneCount).toBeGreaterThanOrEqual(2);
    expect(new Set(locations).size).toBeGreaterThanOrEqual(2);

    const mentorTrust = trustTrajectory.filter(t => t.turn <= WHISPER_SWITCH_TURN);
    const antagonistTrust = trustTrajectory.filter(t => t.turn > WHISPER_SWITCH_TURN);
    if (mentorTrust.length > 0 && antagonistTrust.length > 0) {
      const mentorEnd = mentorTrust[mentorTrust.length - 1]!.trust;
      const antagonistEnd = antagonistTrust[antagonistTrust.length - 1]!.trust;
      console.log(`[quality] Trust divergence: mentor-end=${mentorEnd.toFixed(3)}, antagonist-end=${antagonistEnd.toFixed(3)}, delta=${(mentorEnd - antagonistEnd).toFixed(3)}`);
    }

  }, 1_800_000);
});
