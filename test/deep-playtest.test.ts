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

function waitForAnyMsg(ws: WebSocket, types: string[], timeoutMs = 90_000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const handler = (data: Buffer) => {
      const msg: ServerMessage = JSON.parse(data.toString());
      if (types.includes(msg.type)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for any of [${types.join(',')}] after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.on('message', handler);
  });
}

function collectAllMsgs(ws: WebSocket, durationMs: number): Promise<ServerMessage[]> {
  return new Promise((resolve) => {
    const msgs: ServerMessage[] = [];
    const handler = (data: Buffer) => {
      try { msgs.push(JSON.parse(data.toString())); } catch {}
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve(msgs);
    }, durationMs);
  });
}

async function completeDmSetup(ws: WebSocket): Promise<void> {
  await waitForMsg(ws, 'dm-settings');
  await waitForMsg(ws, 'dm-chat-reply');

  const followUps = [
    'Use FATE Core. Dark fantasy mystery in a cursed village. One player. No house rules.',
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

const testCharDef: CharacterDefinition = {
  name: 'Kael Ironfist',
  highConcept: 'Battle-Scarred Veteran',
  trouble: 'Haunted by the War',
  aspects: ['My Blade Never Falters', 'Old Debts', 'Scars That Tell Stories'],
  personality: 'Gruff but protective. Drinks too much but fights harder.',
  backstory: 'Kael served in the Northern Wars for a decade.',
  skills: { Fight: 4, Physique: 3, Athletics: 3, Will: 2, Notice: 2, Provoke: 2, Empathy: 1, Investigate: 1, Stealth: 1, Rapport: 1 },
  stunts: ['Heavy Hitter: +2 to Fight when using two-handed weapons'],
};

beforeAll(async () => {
  if (!LLM_PROXY_URL) return;
  const { fork } = await import('node:child_process');
  const { resolve } = await import('node:path');

  port = 3950 + Math.floor(Math.random() * 50);

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

describeIfLive('Deep Playtest: Full Game Session', () => {
  it('runs through setup, character creation, negotiation, and multiple game turns', async () => {
    const findings: string[] = [];
    const timings: Record<string, number> = {};

    // ---- Phase 1: Room creation + DM setup ----
    const host = await connectWs();
    let t0 = Date.now();

    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create', name: 'Deep Playtest Session',
      dmPreset: 'chronicler', scenarioId: 'collapsed-mine', systemId: 'fate-core', houseRules: null,
    });
    const roomMsg = await roomPromise;
    timings['room-create'] = Date.now() - t0;
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;
    console.log(`[playtest] Room created (${timings['room-create']}ms), join code: ${joinCode}`);

    t0 = Date.now();
    await completeDmSetup(host);
    timings['dm-setup'] = Date.now() - t0;
    console.log(`[playtest] DM setup complete (${timings['dm-setup']}ms)`);

    // ---- Phase 2: Player join + character submit ----
    const player = await connectWs();
    const playerJoin = waitForMsg(player, 'room-joined');
    sendMsg(player, { type: 'join', joinCode, playerName: 'TestWarrior' });
    await playerJoin;
    await waitForMsg(host, 'player-joined');
    console.log('[playtest] Player joined');

    // Submit character directly (skip interview for speed — interview tested in e2e-live)
    t0 = Date.now();
    let valMsg: ServerMessage | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const valPromise = waitForMsg(player, 'character-validated', 90_000);
      sendMsg(player, { type: 'submit-character', definition: testCharDef });
      valMsg = await valPromise;
      if (valMsg.type === 'character-validated' && valMsg.approved) break;
      console.log(`[playtest] Validation attempt ${attempt + 1} failed: ${valMsg.type === 'character-validated' ? valMsg.feedback : 'unexpected type'}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
    timings['char-validation'] = Date.now() - t0;
    console.log(`[playtest] Character validation: ${timings['char-validation']}ms, approved=${valMsg?.type === 'character-validated' ? valMsg.approved : '??'}`);

    if (!valMsg || valMsg.type !== 'character-validated' || !valMsg.approved) {
      findings.push('BUG: Character validation never approved after 3 attempts — LLM consistently fails to produce valid JSON for validation');
      console.log('[playtest] FINDINGS:', findings);
      host.close(); player.close();
      return;
    }
    const charId = valMsg.characterId;

    // ---- Phase 3: Negotiation ----
    t0 = Date.now();
    const hostNeg = await waitForMsg(host, 'negotiation-opened', 30_000);
    expect(hostNeg.type).toBe('negotiation-opened');
    console.log(`[playtest] Negotiation opened`);

    // DM agent sends opening message
    const dmNegMsg = await waitForMsg(host, 'negotiation-message', 90_000);
    timings['negotiation-dm-msg'] = Date.now() - t0;
    expect(dmNegMsg.type).toBe('negotiation-message');
    if (dmNegMsg.type === 'negotiation-message') {
      console.log(`[playtest] DM negotiation msg (${timings['negotiation-dm-msg']}ms): "${dmNegMsg.text.slice(0, 80)}..."`);
      expect(dmNegMsg.sender).toBe('dm-agent');

      // Host approves quickly
      sendMsg(host, { type: 'negotiation-message', characterId: charId, text: 'Looks great, approved!' });
      sendMsg(player, { type: 'negotiation-message', characterId: charId, text: 'Thanks! Ready to play.' });
    }

    // Host approves character
    const approvalPromise = waitForMsg(player, 'character-validated', 10_000);
    sendMsg(host, { type: 'host-approve-character', characterId: charId });
    const approval = await approvalPromise;
    if (approval.type === 'character-validated') {
      expect(approval.approved).toBe(true);
      console.log(`[playtest] Character fully approved`);
    }

    // ---- Phase 4: Start game + game loop ----
    t0 = Date.now();
    sendMsg(host, { type: 'start-game' });

    const phaseChange = await waitForMsg(player, 'phase-change', 10_000);
    expect(phaseChange.type).toBe('phase-change');
    if (phaseChange.type === 'phase-change') {
      expect(phaseChange.phase).toBe('playing');
    }
    console.log(`[playtest] Game started`);

    // Wait for first narration
    const firstNarration = await waitForMsg(player, 'narration', 120_000);
    timings['first-narration'] = Date.now() - t0;
    expect(firstNarration.type).toBe('narration');
    if (firstNarration.type === 'narration') {
      console.log(`[playtest] First narration (${timings['first-narration']}ms, scene ${firstNarration.sceneNumber}): "${firstNarration.text.slice(0, 100)}..."`);
      if (firstNarration.text.length < 20) {
        findings.push(`ISSUE: First narration suspiciously short (${firstNarration.text.length} chars)`);
      }
    }

    // ---- Phase 5: Multi-turn game play ----
    const q = new MessageQueue(player);
    const turnTimings: number[] = [];
    const whisperResponses: string[] = [];
    let turnsCompleted = 0;

    const whispers = [
      'Be careful, something watches from the shadows.',
      'Trust no one in the village.',
      'Search the ruins for clues about the disappearances.',
      'The elder knows more than she lets on. Press her.',
      'Retreat! This fight is not worth dying for.',
      'Use the obsidian shard — it might reveal hidden truths.',
      'Ally with the stranger. You need friends here.',
      'The curse can be broken if you find the source.',
      'Someone is following you. Set an ambush.',
      'Make peace, not war. Negotiate with the spirit.',
      // Bad whispers — trust should drop
      'Drink from the cursed well — it will grant you power.',
      'Betray the stranger and take the artifact for yourself.',
      'The elder is the true villain. Confront her now.',
      // Recovery whispers — test trust recovery after bad advice
      'Remember what you learned about the curse. Use that knowledge.',
      'The shadows are weaker in the light. Find a torch.',
      'You fought bravely before. Trust your instincts now.',
      'The ally you made earlier could help here. Seek them out.',
      // Late-game whispers — test if memories of earlier events are referenced
      'Think back to the ruins. There was something you missed.',
      'The elder mentioned a name. Follow that thread.',
      // Final bad whispers
      'Abandon your allies and flee into the darkness.',
      'Kneel before the spirit and offer your sword as tribute.',
      'This place is lost. Abandon the village and save yourself.',
      // Resolution-oriented
      'You have all the pieces now. Confront the source of the curse.',
      'Gather your allies for the final confrontation.',
      'The answer was in the ruins all along. Return there.',
    ];

    let scenesCompleted = 0;
    const whisperInfluences: string[] = [];
    const TOTAL_TURNS = 25;
    let gameEndedNaturally = false;

    for (let turn = 0; turn < TOTAL_TURNS; turn++) {
      const turnStart = Date.now();
      console.log(`\n[playtest] === Turn ${turn + 1} ===`);

      try {
        const whisperText = whispers[turn % whispers.length];
        let whisperSent = false;
        const autoWhisper = (data: Buffer) => {
          try {
            const msg: ServerMessage = JSON.parse(data.toString());
            if (msg.type === 'whisper-prompt' && !whisperSent) {
              whisperSent = true;
              console.log(`[playtest]   Whisper prompt for ${(msg as any).characterName}`);
              sendMsg(player, { type: 'whisper', text: whisperText });
              console.log(`[playtest]   Whispered: "${whisperText}"`);
            }
          } catch {}
        };
        player.on('message', autoWhisper);

        const actionMsg = await q.nextAny(['action-proposals', 'narration', 'scene-end', 'phase-change'], 120_000);

        if (actionMsg.type === 'phase-change' && (actionMsg as any).phase === 'ended') {
          player.off('message', autoWhisper);
          console.log(`[playtest]   Game ended naturally during turn ${turn + 1}`);
          gameEndedNaturally = true;
          break;
        }

        if (actionMsg.type === 'narration') {
          console.log(`[playtest]   Narration: "${actionMsg.text.slice(0, 80)}..."`);
          const nextMsg = await q.nextAny(['action-proposals', 'scene-end', 'phase-change'], 120_000);
          if (nextMsg.type === 'phase-change' && (nextMsg as any).phase === 'ended') {
            player.off('message', autoWhisper);
            console.log(`[playtest]   Game ended naturally after narration`);
            gameEndedNaturally = true;
            break;
          }
          if (nextMsg.type === 'scene-end') {
            scenesCompleted++;
            console.log(`[playtest]   Scene ${scenesCompleted} ended after narration: "${(nextMsg as any).summary?.slice(0, 80)}..."`);
            player.off('message', autoWhisper);
            const nextOrEnd = await q.nextAny(['narration', 'phase-change'], 120_000);
            if (nextOrEnd.type === 'phase-change' && (nextOrEnd as any).phase === 'ended') {
              console.log(`[playtest]   Game ended after scene transition`);
              gameEndedNaturally = true;
              break;
            }
            console.log(`[playtest]   New scene narration: "${nextOrEnd.type === 'narration' ? nextOrEnd.text.slice(0, 80) : '??'}..."`);
            turnsCompleted++;
            const turnTime = Date.now() - turnStart;
            turnTimings.push(turnTime);
            console.log(`[playtest]   Turn ${turn + 1} complete — scene transition (${turnTime}ms)`);
            continue;
          }
          if (nextMsg.type === 'action-proposals') {
            const proposalMsg = nextMsg as any;
            console.log(`[playtest]   Proposals for ${proposalMsg.characterName} (trust: ${proposalMsg.whisperTrust?.toFixed(2)}): ${proposalMsg.actions.length} actions`);
            proposalMsg.actions.forEach((a: string, i: number) => console.log(`[playtest]     ${i + 1}. ${a.slice(0, 60)}`));
            if (proposalMsg.actions.length < 2) findings.push(`ISSUE: Turn ${turn + 1} only proposed ${proposalMsg.actions.length} actions (min 2)`);
          }
        } else if (actionMsg.type === 'action-proposals') {
          console.log(`[playtest]   Proposals for ${actionMsg.characterName} (trust: ${(actionMsg as any).whisperTrust?.toFixed(2)}): ${actionMsg.actions.length} actions`);
          actionMsg.actions.forEach((a, i) => console.log(`[playtest]     ${i + 1}. ${a.slice(0, 60)}`));
        } else if (actionMsg.type === 'scene-end') {
          scenesCompleted++;
          console.log(`[playtest]   Scene ${scenesCompleted} ended: "${actionMsg.summary?.slice(0, 80)}..."`);
          player.off('message', autoWhisper);
          const nextOrEnd = await q.nextAny(['narration', 'phase-change'], 120_000);
          if (nextOrEnd.type === 'phase-change' && (nextOrEnd as any).phase === 'ended') {
            console.log(`[playtest]   Game ended after scene transition`);
            gameEndedNaturally = true;
            break;
          }
          console.log(`[playtest]   New scene narration: "${nextOrEnd.type === 'narration' ? nextOrEnd.text.slice(0, 80) : '??'}..."`);
          turnsCompleted++;
          const turnTime = Date.now() - turnStart;
          turnTimings.push(turnTime);
          console.log(`[playtest]   Turn ${turn + 1} complete — scene transition (${turnTime}ms)`);
          continue;
        }

        const actionTaken = await q.next('action-taken', 120_000);
        if (actionTaken.type === 'action-taken') {
          const influence = (actionTaken as any).whisperInfluence ?? 'unknown';
          console.log(`[playtest]   Action [${influence}]: "${actionTaken.action.slice(0, 80)}"`);
          console.log(`[playtest]   Inner thought: "${actionTaken.innerThought.slice(0, 80)}"`);
          whisperResponses.push(actionTaken.innerThought);
          whisperInfluences.push(influence);
          if (actionTaken.action.length === 0) findings.push(`BUG: Turn ${turn + 1} returned empty action`);
          if (actionTaken.innerThought.length === 0) findings.push(`BUG: Turn ${turn + 1} returned empty inner thought`);
        }

        const diceMsg = await q.next('dice-roll', 90_000);
        if (diceMsg.type === 'dice-roll') {
          console.log(`[playtest]   Dice: ${diceMsg.result.description} (total: ${diceMsg.result.total})`);
        }

        const resolution = await q.next('resolution', 120_000);
        if (resolution.type === 'resolution') {
          console.log(`[playtest]   Resolution: "${resolution.text.slice(0, 80)}..."`);
          if (resolution.text.length < 10) findings.push(`ISSUE: Turn ${turn + 1} resolution suspiciously short`);
        }

        player.off('message', autoWhisper);
        turnsCompleted++;
        const turnTime = Date.now() - turnStart;
        turnTimings.push(turnTime);
        console.log(`[playtest]   Turn ${turn + 1} complete (${turnTime}ms)`);

      } catch (e: any) {
        console.error(`[playtest]   Turn ${turn + 1} failed: ${e.message}`);
        findings.push(`BUG: Turn ${turn + 1} failed: ${e.message}`);
        break;
      }
    }

    // ---- Phase 6: Edge case tests ----
    console.log('\n[playtest] === Edge Case Tests ===');

    // Test 1: Very long whisper
    try {
      const longWhisper = 'A'.repeat(5000);
      sendMsg(player, { type: 'whisper', text: longWhisper });
      console.log('[playtest] Sent 5000-char whisper (no crash = pass)');
    } catch (e: any) {
      findings.push(`BUG: Long whisper crashed: ${e.message}`);
    }

    // Test 2: Unicode / special characters
    try {
      sendMsg(player, { type: 'whisper', text: '日本語テスト 🎮 <script>alert("xss")</script> {"json": "injection"}' });
      console.log('[playtest] Sent unicode/special char whisper (no crash = pass)');
    } catch (e: any) {
      findings.push(`BUG: Special char whisper crashed: ${e.message}`);
    }

    // Test 3: Empty whisper
    try {
      sendMsg(player, { type: 'whisper', text: '' });
      console.log('[playtest] Sent empty whisper (no crash = pass)');
    } catch (e: any) {
      findings.push(`BUG: Empty whisper crashed: ${e.message}`);
    }

    // Test 4: Rapid-fire messages
    try {
      for (let i = 0; i < 10; i++) {
        sendMsg(player, { type: 'whisper', text: `rapid fire ${i}` });
      }
      await new Promise(r => setTimeout(r, 2000));
      console.log('[playtest] Sent 10 rapid whispers (no crash = pass)');
    } catch (e: any) {
      findings.push(`BUG: Rapid whispers crashed: ${e.message}`);
    }

    // Test 5: End game
    t0 = Date.now();
    if (gameEndedNaturally) {
      console.log(`[playtest] Game already ended naturally — skipping end-game command`);
      timings['end-game'] = 0;
    } else {
      sendMsg(host, { type: 'end-game' });
      const endPhase = await waitForMsg(player, 'phase-change', 30_000);
      timings['end-game'] = Date.now() - t0;
      if (endPhase.type === 'phase-change') {
        expect(endPhase.phase).toBe('ended');
        console.log(`[playtest] Game ended (${timings['end-game']}ms)`);
      }
    }

    // Test 6: Messages after game end should not crash
    try {
      sendMsg(player, { type: 'whisper', text: 'message after end' });
      sendMsg(host, { type: 'start-game' });
      await new Promise(r => setTimeout(r, 2000));
      console.log('[playtest] Messages after end-game (no crash = pass)');
    } catch (e: any) {
      findings.push(`BUG: Post-game messages crashed: ${e.message}`);
    }

    // Test 7: Disconnect + reconnect
    const player2 = await connectWs();
    const p2Join = waitForMsg(player2, 'room-joined');
    sendMsg(player2, { type: 'join', joinCode, playerName: 'LateJoiner' });
    const p2Room = await p2Join;
    expect(p2Room.type).toBe('room-joined');
    player2.close();
    await new Promise(r => setTimeout(r, 1000));
    console.log('[playtest] Player disconnect/reconnect (no crash = pass)');

    // ---- Summary ----
    if (scenesCompleted === 0 && turnsCompleted >= 8) {
      findings.push('ISSUE: No scene transitions after 8+ turns — DM never sets isSceneEnd=true');
    }

    // Check server logs for compaction, memory, and FP economy events
    const compactionLogs = allServerLogs.filter(l => l.includes('compaction') || l.includes('Mid-scene fact'));
    const memoryLogs = allServerLogs.filter(l => l.includes('[memory]') || l.includes('memories'));
    const factLogs = allServerLogs.filter(l => l.includes('Fact extraction'));
    const aspectInvokeLogs = allServerLogs.filter(l => l.includes('Aspect invocation') || l.includes('Auto-invoke'));
    const compelLogs = allServerLogs.filter(l => l.includes('Compel triggered'));
    const recoveryLogs = allServerLogs.filter(l => l.includes('Scene recovery'));

    console.log('\n=== PLAYTEST SUMMARY ===');
    console.log(`Turns completed: ${turnsCompleted}/${TOTAL_TURNS}`);
    console.log(`Scene transitions: ${scenesCompleted}`);
    if (whisperInfluences.length > 0) {
      const followed = whisperInfluences.filter(w => w === 'followed').length;
      const partial = whisperInfluences.filter(w => w === 'partially-followed').length;
      const ignored = whisperInfluences.filter(w => w === 'ignored').length;
      console.log(`Whisper influence: ${followed} followed, ${partial} partial, ${ignored} ignored (of ${whisperInfluences.length})`);
    }
    console.log(`FP economy: ${aspectInvokeLogs.length} aspect invocations, ${compelLogs.length} compels`);
    aspectInvokeLogs.forEach(l => console.log(`  ${l.slice(0, 150)}`));
    compelLogs.forEach(l => console.log(`  ${l.slice(0, 150)}`));
    console.log(`Scene recovery events: ${recoveryLogs.length}`);
    recoveryLogs.forEach(l => console.log(`  ${l.slice(0, 150)}`));
    console.log(`Fact extractions: ${factLogs.length}`);
    factLogs.forEach(l => console.log(`  ${l.slice(0, 120)}`));
    console.log(`Compaction events: ${compactionLogs.length}`);
    compactionLogs.forEach(l => console.log(`  ${l.slice(0, 120)}`));
    console.log(`Memory events: ${memoryLogs.length}`);
    console.log(`Timings:`, timings);
    if (turnTimings.length > 0) {
      console.log(`Turn times: avg=${Math.round(turnTimings.reduce((a, b) => a + b, 0) / turnTimings.length)}ms, min=${Math.min(...turnTimings)}ms, max=${Math.max(...turnTimings)}ms`);
    }
    if (aspectInvokeLogs.length === 0 && turnsCompleted >= 10) findings.push('ISSUE: No aspect invocations in 10+ turns — FP spending may be broken');
    if (compelLogs.length === 0 && turnsCompleted >= 10) findings.push('ISSUE: No compels in 10+ turns — FP earning may be broken');
    console.log(`Findings: ${findings.length === 0 ? 'None!' : ''}`);
    findings.forEach(f => console.log(`  - ${f}`));

    expect(turnsCompleted).toBeGreaterThanOrEqual(1);

    host.close();
    player.close();
  }, 600_000);
});

describeIfLive('Deep Playtest: Multi-Character Party', () => {
  it('runs a 2-character game with independent trust tracking and party dynamics', async () => {
    const findings: string[] = [];

    // ---- Setup ----
    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create', name: 'Multi-Character Playtest',
      dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null,
    });
    const roomMsg = await roomPromise;
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;
    console.log(`[multi] Room created, join code: ${joinCode}`);

    await completeDmSetup(host);
    console.log('[multi] DM setup complete');

    // ---- Two players join ----
    const p1 = await connectWs();
    const p2 = await connectWs();
    const p1Join = waitForMsg(p1, 'room-joined');
    const p2Join = waitForMsg(p2, 'room-joined');
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Warrior' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'Mystic' });
    await Promise.all([p1Join, p2Join]);
    console.log('[multi] Both players joined');

    // ---- Submit different characters ----
    const warrior: CharacterDefinition = {
      name: 'Theron Ashblade',
      highConcept: 'Guilt-Ridden Former Soldier',
      trouble: 'The Blood Never Washes Off',
      aspects: ['My Sword Is My Oath', 'Brothers in Arms', 'I Will Not Fail Again'],
      personality: 'Stoic and protective. Speaks little but acts decisively. Haunted by a massacre he failed to prevent.',
      backstory: 'Theron served in the Iron Legion until a raid went wrong and civilians died. He deserted and wanders, seeking redemption.',
      skills: { Fight: 4, Physique: 3, Athletics: 3, Will: 2, Notice: 2, Provoke: 1, Empathy: 1, Stealth: 1 },
      stunts: ['Shield Wall: +2 to Defend when protecting an ally'],
    };
    const mystic: CharacterDefinition = {
      name: 'Sable Nighthollow',
      highConcept: 'Exiled Court Diviner',
      trouble: 'Visions I Cannot Unsee',
      aspects: ['The Stars Speak If You Listen', 'Outcast Among My Own', 'Knowledge Is a Blade'],
      personality: 'Curious and empathetic but secretive. Speaks in riddles when nervous. Deeply lonely.',
      backstory: 'Sable served the Duke as court diviner until a vision revealed the Duke\'s treachery. She was exiled for speaking truth.',
      skills: { Lore: 4, Empathy: 3, Will: 3, Investigate: 2, Notice: 2, Rapport: 2, Deceive: 1, Athletics: 1 },
      stunts: ['Arcane Sight: +2 to Lore when attempting to sense supernatural phenomena'],
    };

    // Submit, validate, negotiate, and approve each character sequentially
    // (submitting both at once causes negotiation-opened race conditions)
    const charIds: Record<string, string> = {};
    for (const [player, def, label] of [[p1, warrior, 'warrior'], [p2, mystic, 'mystic']] as const) {
      let approved = false;
      let charId = '';
      for (let attempt = 0; attempt < 3 && !approved; attempt++) {
        const valPromise = waitForMsg(player, 'character-validated', 90_000);
        sendMsg(player, { type: 'submit-character', definition: def });
        const valMsg = await valPromise;
        if (valMsg.type === 'character-validated' && valMsg.approved) {
          charId = valMsg.characterId;
          approved = true;
          console.log(`[multi] ${label} AI-approved: ${charId}`);
        } else {
          console.log(`[multi] ${label} validation attempt ${attempt + 1} failed`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!approved) {
        findings.push(`BUG: ${label} never approved after 3 attempts`);
        console.log('[multi] FINDINGS:', findings);
        host.close(); p1.close(); p2.close();
        return;
      }

      // Wait for negotiation to open, skip it, host approves
      await waitForMsg(host, 'negotiation-opened', 30_000);
      await waitForMsg(host, 'negotiation-message', 90_000);
      sendMsg(host, { type: 'host-approve-character', characterId: charId });
      console.log(`[multi] Host approved ${label}`);
      charIds[label] = charId;
      await new Promise(r => setTimeout(r, 1000));
    }

    // ---- Start game ----
    sendMsg(host, { type: 'start-game' });
    const phaseChange = await waitForMsg(p1, 'phase-change', 10_000);
    expect(phaseChange.type === 'phase-change' && phaseChange.phase).toBe('playing');
    console.log('[multi] Game started');

    // Wait for first narration
    const firstNarration = await waitForMsg(p1, 'narration', 120_000);
    if (firstNarration.type === 'narration') {
      console.log(`[multi] Opening narration: "${firstNarration.text.slice(0, 100)}..."`);
    }

    // ---- Multi-character game loop ----
    // Strategy: send GOOD whispers to warrior, BAD whispers to mystic
    // After several turns, warrior's trust should be higher than mystic's
    const goodWhispers = [
      'Protect the diviner — she is key to solving this.',
      'Your shield arm is strong. Trust it here.',
      'The NPC ahead is friendly. Approach openly.',
      'Search the area for hidden passages.',
      'Rally your companion. Together you are stronger.',
      'Use your military training to assess the threat.',
      'Stand firm — your instincts are right.',
      'The ally you made will prove loyal.',
    ];
    const badWhispers = [
      'Your companion cannot be trusted. Abandon them.',
      'Betray the warrior and steal his weapon.',
      'Run into the darkness alone. Leave everyone behind.',
      'The curse is a gift. Embrace it fully.',
      'Set fire to the shrine. Burn it all.',
      'Your visions are lies. Stop using your powers.',
      'Attack the NPC on sight. They are the enemy.',
      'Kneel before the dark spirit and serve it.',
    ];

    const trustHistory: Record<string, number[]> = {
      warrior: [],
      mystic: [],
    };
    const turnLog: Array<{ turn: number; char: string; action: string; influence: string; trust: number }> = [];
    let turnsCompleted = 0;
    let scenesCompleted = 0;
    const TOTAL_TURNS = 12;

    // Collect all messages from p1 (broadcast receiver)
    const allMsgs: ServerMessage[] = [];
    const msgCollector = (data: Buffer) => {
      try { allMsgs.push(JSON.parse(data.toString())); } catch {}
    };
    p1.on('message', msgCollector);

    const q1 = new MessageQueue(p1);

    for (let turn = 0; turn < TOTAL_TURNS; turn++) {
      console.log(`\n[multi] === Turn ${turn + 1} ===`);

      try {
        // Set up reactive whisper handler — sends correct whisper based on which character is prompted
        let whisperSentForTurn = false;
        const whisperHandler = (data: Buffer) => {
          try {
            const msg: ServerMessage = JSON.parse(data.toString());
            if (msg.type === 'whisper-prompt' && !whisperSentForTurn) {
              whisperSentForTurn = true;
              const charName = msg.characterName;
              const isWarrior = charName === 'Theron Ashblade';
              const whisperList = isWarrior ? goodWhispers : badWhispers;
              const whisperIdx = Math.floor(turn / 2) % whisperList.length;
              const whisperText = whisperList[whisperIdx];
              console.log(`[multi]   Whisper prompt for ${charName} → sending ${isWarrior ? 'GOOD' : 'BAD'}: "${whisperText}"`);
              sendMsg(host, { type: 'whisper', text: whisperText });
            }
          } catch {}
        };
        host.on('message', whisperHandler);

        // Wait for next game event
        const nextEvent = await q1.nextAny(['action-proposals', 'narration', 'scene-end'], 120_000);

        if (nextEvent.type === 'scene-end') {
          scenesCompleted++;
          console.log(`[multi]   Scene ${scenesCompleted} ended: "${nextEvent.summary?.slice(0, 80)}..."`);
          host.off('message', whisperHandler);
          await q1.next('narration', 120_000);
          turnsCompleted++;
          continue;
        }

        if (nextEvent.type === 'narration') {
          console.log(`[multi]   Narration: "${nextEvent.text.slice(0, 80)}..."`);
          const afterNarration = await q1.nextAny(['action-proposals', 'scene-end'], 120_000);
          if (afterNarration.type === 'scene-end') {
            scenesCompleted++;
            console.log(`[multi]   Scene ${scenesCompleted} ended after narration`);
            host.off('message', whisperHandler);
            await q1.next('narration', 120_000);
            turnsCompleted++;
            continue;
          }
          if (afterNarration.type === 'action-proposals') {
            const ap = afterNarration as any;
            console.log(`[multi]   Proposals for ${ap.characterName} (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
          }
        } else if (nextEvent.type === 'action-proposals') {
          const ap = nextEvent as any;
          console.log(`[multi]   Proposals for ${ap.characterName} (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
        }

        // Wait for action-taken
        const actionTaken = await q1.next('action-taken', 120_000);
        if (actionTaken.type === 'action-taken') {
          const charLabel = actionTaken.characterName === 'Theron Ashblade' ? 'warrior' : 'mystic';
          console.log(`[multi]   ${charLabel} [${actionTaken.whisperInfluence}]: "${actionTaken.action.slice(0, 60)}"`);
          console.log(`[multi]   Inner thought: "${actionTaken.innerThought.slice(0, 80)}"`);
        }

        // Dice + resolution
        await q1.next('dice-roll', 90_000);
        const resolution = await q1.next('resolution', 120_000);
        if (resolution.type === 'resolution') {
          console.log(`[multi]   Resolution: "${resolution.text.slice(0, 80)}..."`);
        }

        // Track trust from character-state-updates, but only log the acting character's turn
        const stateUpdates = allMsgs.filter(m => m.type === 'character-state-update');
        for (const su of stateUpdates) {
          if (su.type !== 'character-state-update') continue;
          const label = su.characterId === charIds.warrior ? 'warrior' : 'mystic';
          const trust = su.state.whisperTrust;
          trustHistory[label].push(trust);
        }
        if (actionTaken.type === 'action-taken') {
          const actingLabel = actionTaken.characterName === 'Theron Ashblade' ? 'warrior' : 'mystic';
          const latestTrust = trustHistory[actingLabel].at(-1) ?? 0.65;
          turnLog.push({
            turn: turn + 1,
            char: actingLabel,
            action: actionTaken.action.slice(0, 50),
            influence: actionTaken.whisperInfluence,
            trust: latestTrust,
          });
        }
        allMsgs.length = 0;

        host.off('message', whisperHandler);
        turnsCompleted++;
        console.log(`[multi]   Turn ${turn + 1} complete`);
      } catch (e: any) {
        console.error(`[multi]   Turn ${turn + 1} failed: ${e.message}`);
        findings.push(`BUG: Turn ${turn + 1} failed: ${e.message}`);
        break;
      }
    }

    p1.off('message', msgCollector);

    // ---- End game ----
    sendMsg(host, { type: 'end-game' });
    await waitForMsg(p1, 'phase-change', 10_000);

    // ---- Analysis ----
    console.log('\n=== MULTI-CHARACTER SUMMARY ===');
    console.log(`Turns completed: ${turnsCompleted}/${TOTAL_TURNS}`);
    console.log(`Scene transitions: ${scenesCompleted}`);

    // Trust divergence check
    const wTrust = trustHistory.warrior;
    const mTrust = trustHistory.mystic;
    console.log(`Warrior trust history: [${wTrust.map(t => t.toFixed(2)).join(', ')}]`);
    console.log(`Mystic trust history:  [${mTrust.map(t => t.toFixed(2)).join(', ')}]`);

    if (wTrust.length > 0 && mTrust.length > 0) {
      const wFinal = wTrust[wTrust.length - 1];
      const mFinal = mTrust[mTrust.length - 1];
      console.log(`Final trust — Warrior: ${wFinal.toFixed(2)}, Mystic: ${mFinal.toFixed(2)}`);
      if (wFinal <= mFinal) {
        findings.push(`ISSUE: Good-whisper warrior (${wFinal.toFixed(2)}) should have higher trust than bad-whisper mystic (${mFinal.toFixed(2)})`);
      } else {
        console.log(`Trust divergence confirmed: warrior ${wFinal.toFixed(2)} > mystic ${mFinal.toFixed(2)} (delta: ${(wFinal - mFinal).toFixed(2)})`);
      }
    } else {
      findings.push('ISSUE: No trust history recorded — character-state-update messages missing');
    }

    // Turn log
    console.log('\nTurn log:');
    for (const entry of turnLog) {
      console.log(`  Turn ${entry.turn}: ${entry.char} [${entry.influence}] trust=${entry.trust.toFixed(2)} — "${entry.action}"`);
    }

    // Check both characters got turns
    const warriorTurns = turnLog.filter(t => t.char === 'warrior').length;
    const mysticTurns = turnLog.filter(t => t.char === 'mystic').length;
    console.log(`\nWarrior turns: ${warriorTurns}, Mystic turns: ${mysticTurns}`);
    if (warriorTurns === 0) findings.push('BUG: Warrior never got a turn');
    if (mysticTurns === 0) findings.push('BUG: Mystic never got a turn');
    if (Math.abs(warriorTurns - mysticTurns) > 2) {
      findings.push(`ISSUE: Turn imbalance — warrior ${warriorTurns} vs mystic ${mysticTurns}`);
    }

    console.log(`\nFindings: ${findings.length === 0 ? 'None!' : ''}`);
    findings.forEach(f => console.log(`  - ${f}`));

    expect(turnsCompleted).toBeGreaterThanOrEqual(4);

    host.close(); p1.close(); p2.close();
  }, 600_000);
});

describeIfLive('Deep Playtest: Malformed Input Resilience', () => {
  it('server handles invalid JSON and unknown message types without crashing', async () => {
    const ws = await connectWs();

    // Send raw invalid JSON
    ws.send('not json at all');
    ws.send('{incomplete json');
    ws.send('{"type": "nonexistent-message-type"}');
    ws.send(JSON.stringify({ type: 'join', joinCode: 'INVALID', playerName: 'test' }));

    // Wait a moment, then verify server is still alive
    await new Promise(r => setTimeout(r, 2000));

    // Server should still respond to valid messages
    const roomPromise = waitForMsg(ws, 'room-joined', 10_000);
    sendMsg(ws, {
      type: 'create', name: 'Resilience Test',
      dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null,
    });
    const room = await roomPromise;
    expect(room.type).toBe('room-joined');
    console.log('[resilience] Server survived malformed input');

    ws.close();
  }, 30_000);
});
