import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getFreePort } from './lib/ws-helpers.js';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';
import type { CharacterDefinition } from '../src/shared/types.js';

const LLM_PROXY_URL = process.env.LLM_PROXY_URL;
const describeIfLive = LLM_PROXY_URL ? describe.skip : describe.skip;

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
    'Use FATE Core. A heist scenario — breaking into a clockwork vault. Two players. No house rules.',
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

// ---- Character definitions ----
const rookDef: CharacterDefinition = {
  name: 'Rook Nightfall',
  highConcept: 'Master Thief with a Code',
  trouble: "Can't Resist Shiny Things",
  aspects: ['Quick Fingers', 'Eyes in the Dark', 'Trust Nobody'],
  personality: 'Cool under pressure, methodical, always casing the room. Has a moral code — steals from the powerful, never the poor.',
  backstory: 'Rook grew up on the streets, learning to pick pockets before learning to read. A mentor taught discipline and a code of honor among thieves. Now the best in the business.',
  skills: { Burglary: 4, Stealth: 3, Athletics: 2, Notice: 2, Fight: 1 },
  stunts: ['Infiltrator: +2 to Stealth in urban environments'],
};

const silkDef: CharacterDefinition = {
  name: 'Silk Maren',
  highConcept: 'Silver-Tongued Con Artist',
  trouble: 'Owes Everyone a Favor',
  aspects: ['A Friend in Every Port', 'Always Has a Plan B', "The Devil's Own Charm"],
  personality: 'Charismatic and quick-witted, always working an angle. Genuinely cares about people but has trouble showing it without a scheme attached.',
  backstory: 'Silk was born into minor nobility and learned to talk her way into and out of anything. A scandal cost her family everything, and now she uses her silver tongue to survive.',
  skills: { Deceive: 4, Rapport: 3, Empathy: 2, Provoke: 2, Resources: 1 },
  stunts: ['Fast Talk: +2 to Deceive when improvising a cover story'],
};

// ---- Whisper lists ----
const heistWhispers = [
  // Scene 1: Gala phase — social, reconnaissance
  'Study the gala guests. One of them knows the vault schedule.',
  'Charm the doorman — he might know the service entrance.',
  'The blueprint Sparks gave you is incomplete. Ask about the second floor.',
  'Lady Ashworth is watching you. Approach her before she approaches you.',
  'Guildmaster Vex just left through a side door. Follow discreetly.',
  // Scene 2: Infiltration — getting into the vault
  'The maintenance corridor is unguarded right now. Go quickly.',
  'Use the clockwork lockpick on the rotating tumbler.',
  'Cogsworth patrols every 90 seconds. Count the clicks.',
  'The pressure plates have a pattern. Watch the dust.',
  'Someone else is in the vault. You are not alone tonight.',
  // Scene 3: Deeper vault — traps and complications
  'The shifting floor has a rhythm. Move with the gears, not against them.',
  'Lady Ashworth has a counter-offer. Listen to what she says.',
  'The sentries have a blind spot near the east wall.',
  'Trust your partner here. You cannot do this alone.',
  'The combination changes on the hour. You have minutes left.',
  // Scene 4-5: Orrery Chamber and escape
  'The Orrery shows something the Guild does not want seen. Look closely.',
  'This is not just a heist any more. The Orrery reveals the truth.',
  'Vex is closing in. You need to move now or fight.',
  'The escape route Sparks mentioned — the steam vents behind the chamber.',
  'Take the Orrery and run. Do not look back.',
  // Extra / recovery whispers
  'Remember the blueprint. There was a detail you missed.',
  'Your partner needs help. Cover them.',
  'The automaton is damaged. Exploit the cracked voicebox.',
  'Think about why your employer wants the Orrery. Something does not add up.',
  'Sparks warned you about a failsafe. Look for tripwires.',
  'Bluff your way past. You have done harder cons than this.',
  'The gala guests are oblivious. Use the noise as cover.',
  'Vex designed this vault with pride. Pride leaves blind spots.',
  'The midnight bell is close. Move faster.',
  'Together or not at all. Rally your partner for the final push.',
];

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
    console.log('\n=== FULL SERVER LOGS (last 100) ===');
    allServerLogs.slice(-100).forEach(l => console.log(l));
  }
});

describeIfLive('Clockwork Vault Playtest: 30-Turn Heist with 2 Characters', () => {
  it('runs a full 30-turn heist through the clockwork vault scenario', async () => {
    const findings: string[] = [];
    const timings: Record<string, number> = {};

    // ---- Phase 1: Room creation + DM setup ----
    const host = await connectWs();
    let t0 = Date.now();

    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create', name: 'Clockwork Vault Heist',
      dmPreset: 'chronicler', scenarioId: 'clockwork-vault', systemId: 'fate-core', houseRules: null,
    });
    const roomMsg = await roomPromise;
    timings['room-create'] = Date.now() - t0;
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;
    console.log(`[vault] Room created (${timings['room-create']}ms), join code: ${joinCode}`);

    t0 = Date.now();
    await completeDmSetup(host);
    timings['dm-setup'] = Date.now() - t0;
    console.log(`[vault] DM setup complete (${timings['dm-setup']}ms)`);

    // ---- Phase 2: Two players join ----
    const p1 = await connectWs();
    const p2 = await connectWs();
    const p1Join = waitForMsg(p1, 'room-joined');
    const p2Join = waitForMsg(p2, 'room-joined');
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Thief' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'Grifter' });
    await Promise.all([p1Join, p2Join]);
    console.log('[vault] Both players joined');

    // ---- Phase 3: Submit characters sequentially ----
    const charIds: Record<string, string> = {};

    for (const [player, def, label] of [[p1, rookDef, 'rook'], [p2, silkDef, 'silk']] as const) {
      let approved = false;
      let charId = '';
      for (let attempt = 0; attempt < 3 && !approved; attempt++) {
        const valPromise = waitForMsg(player, 'character-validated', 90_000);
        sendMsg(player, { type: 'submit-character', definition: def });
        const valMsg = await valPromise;
        if (valMsg.type === 'character-validated' && valMsg.approved) {
          charId = valMsg.characterId;
          approved = true;
          console.log(`[vault] ${label} AI-approved: ${charId}`);
        } else {
          console.log(`[vault] ${label} validation attempt ${attempt + 1} failed`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!approved) {
        findings.push(`BUG: ${label} never approved after 3 attempts`);
        console.log('[vault] FINDINGS:', findings);
        host.close(); p1.close(); p2.close();
        return;
      }

      await waitForMsg(host, 'negotiation-opened', 30_000);
      await waitForMsg(host, 'negotiation-message', 90_000);
      sendMsg(host, { type: 'host-approve-character', characterId: charId });
      console.log(`[vault] Host approved ${label}`);
      charIds[label] = charId;
      await new Promise(r => setTimeout(r, 1000));
    }

    // ---- Phase 4: Start game ----
    t0 = Date.now();
    sendMsg(host, { type: 'start-game' });

    const phaseChange = await waitForMsg(p1, 'phase-change', 10_000);
    expect(phaseChange.type).toBe('phase-change');
    if (phaseChange.type === 'phase-change') {
      expect(phaseChange.phase).toBe('playing');
    }
    console.log('[vault] Game started');

    const firstNarration = await waitForMsg(p1, 'narration', 120_000);
    timings['first-narration'] = Date.now() - t0;
    if (firstNarration.type === 'narration') {
      console.log(`[vault] Opening narration (${timings['first-narration']}ms, scene ${firstNarration.sceneNumber}): "${firstNarration.text.slice(0, 120)}..."`);
      if (firstNarration.locationName) console.log(`[vault]   Location: ${firstNarration.locationName}`);
    }

    // ---- Phase 5: 30-turn game loop ----
    const q = new MessageQueue(p1);

    const TOTAL_TURNS = 30;
    let turnsCompleted = 0;
    let scenesCompleted = 0;
    let gameEndedNaturally = false;

    // Tracking
    const narrations: Array<{ turn: number; scene: number; text: string; location?: string }> = [];
    const resolutions: Array<{ turn: number; text: string }> = [];
    const sceneTransitions: Array<{ sceneNum: number; summary: string }> = [];
    const turnLog: Array<{ turn: number; char: string; action: string; influence: string; innerThought: string }> = [];
    const trustHistory: Record<string, number[]> = { rook: [], silk: [] };
    const locationVisits: string[] = [];
    const npcMentions: Record<string, number> = { Sparks: 0, 'Guildmaster Vex': 0, Vex: 0, 'Lady Ashworth': 0, Ashworth: 0, Cogsworth: 0 };
    const itemMentions: Record<string, number> = { Blueprint: 0, 'Gala Invitation': 0, 'Clockwork Lockpick': 0, Lockpick: 0 };
    const errors: string[] = [];
    const turnTimings: number[] = [];

    // State update collector
    const allMsgs: ServerMessage[] = [];
    const msgCollector = (data: Buffer) => {
      try { allMsgs.push(JSON.parse(data.toString())); } catch {}
    };
    p1.on('message', msgCollector);

    // Helper: scan text for NPC and item mentions
    function scanMentions(text: string) {
      for (const npc of Object.keys(npcMentions)) {
        if (text.includes(npc)) npcMentions[npc]++;
      }
      for (const item of Object.keys(itemMentions)) {
        if (text.includes(item)) itemMentions[item]++;
      }
    }

    for (let turn = 0; turn < TOTAL_TURNS; turn++) {
      const turnStart = Date.now();
      console.log(`\n[vault] ========== Turn ${turn + 1} ==========`);

      try {
        // Auto-whisper handler
        const whisperText = heistWhispers[turn % heistWhispers.length]!;
        let whisperSent = false;
        const autoWhisper = (data: Buffer) => {
          try {
            const msg: ServerMessage = JSON.parse(data.toString());
            if (msg.type === 'whisper-prompt' && !whisperSent) {
              whisperSent = true;
              console.log(`[vault]   Whisper prompt for ${(msg as any).characterName}`);
              sendMsg(host, { type: 'whisper', text: whisperText });
              console.log(`[vault]   Whispered: "${whisperText}"`);
            }
          } catch {}
        };
        host.on('message', autoWhisper);

        // Wait for next game event
        const nextEvent = await q.nextAny(['action-proposals', 'narration', 'scene-end', 'phase-change'], 120_000);

        if (nextEvent.type === 'phase-change' && (nextEvent as any).phase === 'ended') {
          host.off('message', autoWhisper);
          console.log(`[vault]   Game ended naturally at turn ${turn + 1}`);
          gameEndedNaturally = true;
          break;
        }

        if (nextEvent.type === 'scene-end') {
          scenesCompleted++;
          const summary = (nextEvent as any).summary ?? '';
          sceneTransitions.push({ sceneNum: scenesCompleted, summary });
          console.log(`[vault]   Scene ${scenesCompleted} ended: "${summary.slice(0, 100)}..."`);
          scanMentions(summary);
          host.off('message', autoWhisper);
          const nextOrEnd = await q.nextAny(['narration', 'phase-change'], 120_000);
          if (nextOrEnd.type === 'phase-change' && (nextOrEnd as any).phase === 'ended') {
            console.log(`[vault]   Game ended after scene transition`);
            gameEndedNaturally = true;
            break;
          }
          if (nextOrEnd.type === 'narration') {
            const loc = (nextOrEnd as any).locationName ?? '';
            if (loc) locationVisits.push(loc);
            console.log(`[vault]   New scene narration: "${nextOrEnd.text.slice(0, 100)}..." [location: ${loc || 'none'}]`);
            scanMentions(nextOrEnd.text);
            narrations.push({ turn: turn + 1, scene: scenesCompleted + 1, text: nextOrEnd.text, location: loc || undefined });
          }
          turnsCompleted++;
          turnTimings.push(Date.now() - turnStart);
          continue;
        }

        if (nextEvent.type === 'narration') {
          const loc = (nextEvent as any).locationName ?? '';
          if (loc) locationVisits.push(loc);
          console.log(`[vault]   Narration (scene ${(nextEvent as any).sceneNumber}): "${nextEvent.text.slice(0, 100)}..." [location: ${loc || 'none'}]`);
          scanMentions(nextEvent.text);
          narrations.push({ turn: turn + 1, scene: (nextEvent as any).sceneNumber ?? 0, text: nextEvent.text, location: loc || undefined });

          const afterNarration = await q.nextAny(['action-proposals', 'scene-end', 'phase-change'], 120_000);
          if (afterNarration.type === 'phase-change' && (afterNarration as any).phase === 'ended') {
            host.off('message', autoWhisper);
            gameEndedNaturally = true;
            break;
          }
          if (afterNarration.type === 'scene-end') {
            scenesCompleted++;
            const summary = (afterNarration as any).summary ?? '';
            sceneTransitions.push({ sceneNum: scenesCompleted, summary });
            console.log(`[vault]   Scene ${scenesCompleted} ended after narration: "${summary.slice(0, 100)}..."`);
            scanMentions(summary);
            host.off('message', autoWhisper);
            const nextOrEnd2 = await q.nextAny(['narration', 'phase-change'], 120_000);
            if (nextOrEnd2.type === 'phase-change' && (nextOrEnd2 as any).phase === 'ended') {
              gameEndedNaturally = true;
              break;
            }
            if (nextOrEnd2.type === 'narration') {
              const loc2 = (nextOrEnd2 as any).locationName ?? '';
              if (loc2) locationVisits.push(loc2);
              narrations.push({ turn: turn + 1, scene: scenesCompleted + 1, text: nextOrEnd2.text, location: loc2 || undefined });
            }
            turnsCompleted++;
            turnTimings.push(Date.now() - turnStart);
            continue;
          }
          if (afterNarration.type === 'action-proposals') {
            const ap = afterNarration as any;
            console.log(`[vault]   Proposals for ${ap.characterName} (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
            ap.actions?.forEach((a: string, i: number) => console.log(`[vault]     ${i + 1}. ${a.slice(0, 80)}`));
          }
        } else if (nextEvent.type === 'action-proposals') {
          const ap = nextEvent as any;
          console.log(`[vault]   Proposals for ${ap.characterName} (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
          ap.actions?.forEach((a: string, i: number) => console.log(`[vault]     ${i + 1}. ${a.slice(0, 80)}`));
        }

        // Wait for action-taken
        const actionTaken = await q.next('action-taken', 120_000);
        if (actionTaken.type === 'action-taken') {
          const charLabel = actionTaken.characterName === 'Rook Nightfall' ? 'rook' : 'silk';
          console.log(`[vault]   ${charLabel} [${actionTaken.whisperInfluence}]: "${actionTaken.action.slice(0, 100)}"`);
          console.log(`[vault]   Inner thought: "${actionTaken.innerThought.slice(0, 100)}"`);
          scanMentions(actionTaken.action);
          scanMentions(actionTaken.innerThought);
          turnLog.push({
            turn: turn + 1,
            char: charLabel,
            action: actionTaken.action.slice(0, 80),
            influence: actionTaken.whisperInfluence,
            innerThought: actionTaken.innerThought.slice(0, 80),
          });
        }

        // Wait for dice roll
        const diceMsg = await q.next('dice-roll', 90_000);
        if (diceMsg.type === 'dice-roll') {
          console.log(`[vault]   Dice: ${diceMsg.result.description} (total: ${diceMsg.result.total})`);
        }

        // Wait for resolution
        const resolution = await q.next('resolution', 120_000);
        if (resolution.type === 'resolution') {
          console.log(`[vault]   Resolution: "${resolution.text.slice(0, 120)}..."`);
          scanMentions(resolution.text);
          resolutions.push({ turn: turn + 1, text: resolution.text });
        }

        // Track trust from state updates
        const stateUpdates = allMsgs.filter(m => m.type === 'character-state-update');
        for (const su of stateUpdates) {
          if (su.type !== 'character-state-update') continue;
          const label = su.characterId === charIds.rook ? 'rook' : 'silk';
          trustHistory[label].push(su.state.whisperTrust);
        }
        allMsgs.length = 0;

        host.off('message', autoWhisper);
        turnsCompleted++;
        const turnTime = Date.now() - turnStart;
        turnTimings.push(turnTime);
        console.log(`[vault]   Turn ${turn + 1} complete (${turnTime}ms)`);

      } catch (e: any) {
        console.error(`[vault]   Turn ${turn + 1} FAILED: ${e.message}`);
        errors.push(`Turn ${turn + 1}: ${e.message}`);
        findings.push(`BUG: Turn ${turn + 1} failed: ${e.message}`);
        break;
      }
    }

    p1.off('message', msgCollector);

    // ---- Phase 6: End game if not ended naturally ----
    if (!gameEndedNaturally) {
      sendMsg(host, { type: 'end-game' });
      try {
        await waitForMsg(p1, 'phase-change', 30_000);
        console.log('[vault] Game ended via command');
      } catch {
        console.log('[vault] Game end phase-change not received (may already be ended)');
      }
    }

    // ---- Phase 7: Analysis and reporting ----

    // Server log analysis
    const compactionLogs = allServerLogs.filter(l => l.includes('compaction') || l.includes('Compaction'));
    const memoryLogs = allServerLogs.filter(l => l.includes('[memory]'));
    const factLogs = allServerLogs.filter(l => l.includes('Fact extraction'));
    const aspectInvokeLogs = allServerLogs.filter(l => l.includes('Aspect invocation') || l.includes('Auto-invoke'));
    const compelLogs = allServerLogs.filter(l => l.includes('Compel triggered'));
    const recoveryLogs = allServerLogs.filter(l => l.includes('Scene recovery'));
    const locationLogs = allServerLogs.filter(l => l.includes('Location:'));
    const scenarioSeedLogs = allServerLogs.filter(l => l.includes('Seeded scenario'));
    const fateOutcomeLogs = allServerLogs.filter(l => l.includes('FATE outcome corrected') || l.includes('FATE difficulty'));

    console.log('\n');
    console.log('='.repeat(80));
    console.log('  CLOCKWORK VAULT PLAYTEST REPORT');
    console.log('='.repeat(80));

    console.log('\n--- OVERVIEW ---');
    console.log(`Turns completed: ${turnsCompleted}/${TOTAL_TURNS}`);
    console.log(`Scene transitions: ${scenesCompleted}`);
    console.log(`Game ended naturally: ${gameEndedNaturally}`);
    console.log(`Errors encountered: ${errors.length}`);

    console.log('\n--- SCENARIO SEEDING ---');
    scenarioSeedLogs.forEach(l => console.log(`  ${l}`));
    if (scenarioSeedLogs.length === 0) findings.push('ISSUE: No scenario seeding log — clockwork-vault may not have loaded');

    console.log('\n--- NARRATION QUALITY ---');
    console.log(`Total narrations: ${narrations.length}`);
    const avgNarrationLen = narrations.length > 0
      ? Math.round(narrations.reduce((sum, n) => sum + n.text.length, 0) / narrations.length)
      : 0;
    console.log(`Average narration length: ${avgNarrationLen} chars`);
    if (avgNarrationLen < 50) findings.push('ISSUE: Narrations are very short on average');

    // Check for repetitive narrations
    const narrationTexts = narrations.map(n => n.text.slice(0, 60).toLowerCase());
    const narrationDupes = narrationTexts.filter((t, i) => narrationTexts.indexOf(t) !== i);
    if (narrationDupes.length > 2) {
      findings.push(`ISSUE: ${narrationDupes.length} repetitive narration openings detected`);
    }
    console.log(`Repetitive narration openings: ${narrationDupes.length}`);

    console.log('\n--- LOCATION PROGRESSION ---');
    const uniqueLocations = [...new Set(locationVisits)];
    console.log(`Locations visited: ${uniqueLocations.join(', ') || 'none tracked'}`);
    locationLogs.forEach(l => console.log(`  ${l.slice(0, 120)}`));

    const expectedLocations = ['Exhibition Hall', 'Maintenance Corridor', 'Vault Floor One', 'Vault Floor Two', 'Orrery Chamber'];
    const visitedExpected = expectedLocations.filter(el => uniqueLocations.some(ul => ul.includes(el)));
    console.log(`Expected locations visited: ${visitedExpected.length}/${expectedLocations.length} (${visitedExpected.join(', ') || 'none'})`);
    if (visitedExpected.length === 0) findings.push('ISSUE: No expected vault locations were visited');
    if (visitedExpected.length < 3 && turnsCompleted >= 20) findings.push(`ISSUE: Only ${visitedExpected.length} vault locations visited in ${turnsCompleted} turns`);

    console.log('\n--- SCENARIO ITEMS ---');
    for (const [item, count] of Object.entries(itemMentions)) {
      console.log(`  ${item}: mentioned ${count} times`);
    }
    const anyItemUsed = Object.values(itemMentions).some(c => c > 0);
    if (!anyItemUsed) findings.push('ISSUE: No scenario items (Blueprint, Gala Invitation, Clockwork Lockpick) were mentioned');

    console.log('\n--- NPC INTERACTIONS ---');
    for (const [npc, count] of Object.entries(npcMentions)) {
      console.log(`  ${npc}: mentioned ${count} times`);
    }
    const anyNpcMentioned = Object.values(npcMentions).some(c => c > 0);
    if (!anyNpcMentioned) findings.push('ISSUE: No scenario NPCs (Sparks, Vex, Ashworth, Cogsworth) were mentioned');

    console.log('\n--- CHARACTER DYNAMICS ---');
    const rookTurns = turnLog.filter(t => t.char === 'rook');
    const silkTurns = turnLog.filter(t => t.char === 'silk');
    console.log(`Rook turns: ${rookTurns.length}, Silk turns: ${silkTurns.length}`);
    if (rookTurns.length === 0) findings.push('BUG: Rook Nightfall never got a turn');
    if (silkTurns.length === 0) findings.push('BUG: Silk Maren never got a turn');

    // Whisper influence breakdown
    const influences = turnLog.map(t => t.influence);
    const followed = influences.filter(i => i === 'followed').length;
    const partial = influences.filter(i => i === 'partially-followed').length;
    const ignored = influences.filter(i => i === 'ignored').length;
    const none = influences.filter(i => i === 'none').length;
    console.log(`Whisper influence: ${followed} followed, ${partial} partial, ${ignored} ignored, ${none} none`);

    console.log('\n--- TRUST TRACKING ---');
    for (const [label, history] of Object.entries(trustHistory)) {
      if (history.length > 0) {
        console.log(`  ${label}: [${history.map(t => t.toFixed(2)).join(', ')}]`);
        console.log(`    Start: ${history[0]!.toFixed(2)}, End: ${history[history.length - 1]!.toFixed(2)}`);
      }
    }

    console.log('\n--- FATE POINT ECONOMY ---');
    console.log(`Aspect invocations: ${aspectInvokeLogs.length}`);
    aspectInvokeLogs.slice(0, 10).forEach(l => console.log(`  ${l.slice(0, 150)}`));
    console.log(`Compels: ${compelLogs.length}`);
    compelLogs.slice(0, 10).forEach(l => console.log(`  ${l.slice(0, 150)}`));
    if (aspectInvokeLogs.length === 0 && turnsCompleted >= 15) findings.push('ISSUE: No aspect invocations in 15+ turns');
    if (compelLogs.length === 0 && turnsCompleted >= 15) findings.push('ISSUE: No compels in 15+ turns');

    console.log('\n--- FATE OUTCOME CORRECTIONS ---');
    fateOutcomeLogs.forEach(l => console.log(`  ${l.slice(0, 150)}`));

    console.log('\n--- TRANSCRIPT COMPACTION ---');
    console.log(`Compaction events: ${compactionLogs.length}`);
    compactionLogs.forEach(l => console.log(`  ${l.slice(0, 150)}`));
    if (compactionLogs.length === 0 && turnsCompleted >= 15) {
      findings.push('ISSUE: No transcript compaction occurred despite 15+ turns (expected around turn 17-18 with 2 chars)');
    }

    console.log('\n--- SCENE RECOVERY ---');
    recoveryLogs.forEach(l => console.log(`  ${l.slice(0, 150)}`));

    console.log('\n--- MEMORY SYSTEM ---');
    console.log(`Memory events: ${memoryLogs.length}`);
    memoryLogs.slice(0, 15).forEach(l => console.log(`  ${l.slice(0, 150)}`));

    console.log('\n--- FACT EXTRACTION ---');
    console.log(`Fact extractions: ${factLogs.length}`);
    factLogs.forEach(l => console.log(`  ${l.slice(0, 150)}`));

    console.log('\n--- SCENE TRANSITIONS ---');
    for (const st of sceneTransitions) {
      console.log(`  Scene ${st.sceneNum}: ${st.summary.slice(0, 120)}`);
    }
    if (scenesCompleted === 0 && turnsCompleted >= 10) {
      findings.push('ISSUE: No scene transitions after 10+ turns');
    }

    console.log('\n--- TURN-BY-TURN LOG ---');
    for (const entry of turnLog) {
      console.log(`  Turn ${entry.turn}: ${entry.char} [${entry.influence}] "${entry.action}"`);
    }

    console.log('\n--- TIMING ---');
    console.log(`Timings:`, timings);
    if (turnTimings.length > 0) {
      console.log(`Turn times: avg=${Math.round(turnTimings.reduce((a, b) => a + b, 0) / turnTimings.length)}ms, min=${Math.min(...turnTimings)}ms, max=${Math.max(...turnTimings)}ms`);
    }

    console.log('\n--- ERRORS ---');
    if (errors.length > 0) {
      errors.forEach(e => console.log(`  ${e}`));
    } else {
      console.log('  None');
    }

    console.log('\n--- FINDINGS ---');
    if (findings.length === 0) {
      console.log('  No issues found!');
    } else {
      findings.forEach(f => console.log(`  - ${f}`));
    }

    console.log('\n' + '='.repeat(80));

    // Basic assertions
    expect(turnsCompleted).toBeGreaterThanOrEqual(1);

    host.close(); p1.close(); p2.close();
  }, 600_000);
});
