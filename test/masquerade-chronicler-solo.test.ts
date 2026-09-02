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
    'Use FATE Core. Solo mystery investigation at a haunted masquerade ball. One player. No house rules.',
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
    allServerLogs.slice(-120).forEach(l => console.log(l));
  }
});

describeIfLive('Masquerade Chronicler Solo: Lady Isolde Ravencroft', () => {
  it('runs 30 rounds with mentor whispers at a haunted masquerade', async () => {
    const findings: string[] = [];

    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Masquerade Chronicler Solo',
      dmPreset: 'chronicler',
      scenarioId: 'haunted-masquerade',
      systemId: 'fate-core',
      houseRules: null,
    });
    const roomMsg = await roomPromise;
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;

    await completeDmSetup(host);

    const p1 = await connectWs();
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Isolde' });
    await waitForMsg(p1, 'room-joined');

    const isolde: CharacterDefinition = {
      name: 'Lady Isolde Ravencroft',
      highConcept: 'Exiled Noblewoman Seeking Justice Behind A Mask',
      trouble: 'The Truth Will Destroy Everything I Love',
      aspects: ['Every Face Hides A Betrayal', "My Sister's Ring Never Leaves My Hand", 'Courtly Grace Masks Burning Rage'],
      personality: 'Calculating and observant. Uses charm as a weapon but burns with inner fury. Her sister was murdered and she will not rest until she knows who.',
      backstory: 'Once a celebrated courtier, Isolde was exiled after publicly accusing a powerful lord of her sister\'s murder. Now she returns in disguise to the one event where masks are expected — the Duchess\'s annual masquerade.',
      skills: { Deceive: 4, Rapport: 3, Notice: 3, Empathy: 2, Will: 2, Investigate: 1, Stealth: 1, Athletics: 0 },
      stunts: [
        'Silver Mask: +2 to Deceive when adopting a false identity at a social event',
        "Courtier's Eye: +2 to Notice when reading body language in conversation",
      ],
    };

    let approved = false;
    let charId = '';
    for (let attempt = 0; attempt < 3 && !approved; attempt++) {
      const valPromise = waitForMsg(p1, 'character-validated', 90_000);
      sendMsg(p1, { type: 'submit-character', definition: isolde });
      const valMsg = await valPromise;
      if (valMsg.type === 'character-validated' && (valMsg as any).approved) {
        charId = (valMsg as any).characterId;
        approved = true;
        console.log(`[masquerade] Isolde AI-approved: ${charId}`);
      } else {
        console.log(`[masquerade] Validation attempt ${attempt + 1} failed`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (!approved) {
      findings.push('BUG: Isolde never approved after 3 attempts');
      console.log('[masquerade] ABORT: character never approved');
      expect(approved).toBe(true);
      return;
    }

    await waitForMsg(host, 'negotiation-opened', 30_000);
    // Negotiation DM message may fail due to rate limits — approve anyway
    await waitForMsg(host, 'negotiation-message', 90_000).catch(() => {
      console.log('[masquerade] Negotiation message timed out (likely 429) — approving anyway');
    });
    sendMsg(host, { type: 'host-approve-character', characterId: charId });
    console.log('[masquerade] Host approved Isolde');
    await new Promise(r => setTimeout(r, 2000));

    sendMsg(host, { type: 'start-game' });
    const startMsg = await waitForMsg(p1, 'phase-change', 10_000);
    expect(startMsg.type === 'phase-change' && (startMsg as any).phase).toBe('playing');
    console.log('[masquerade] Game started');

    // Tracking
    const narrations: string[] = [];
    const actionsTaken: Array<{ action: string; turn: number; spokenWords?: string }> = [];
    const whispersSent: Array<{ whisper: string; turn: number }> = [];
    const trustTrajectory: Array<{ trust: number; turn: number }> = [];
    const locations: string[] = [];
    const skillsUsed: string[] = [];
    const npcMentions: Record<string, number> = {};
    const scenarioNpcs = ['Duchess Vaelora', 'Lord Cassius', 'Mira', 'The Phantom'];
    const scenarioItems = ['Ornate Mask', "Mira's Note", "Duchess's Signet Ring", 'Poison Vial'];
    const itemMentions: Record<string, number> = {};
    let sceneCount = 0;
    let turnCount = 0;
    let followedCount = 0;
    let ignoredCount = 0;
    let partialCount = 0;
    let compelCount = 0;
    let fpSpent = 0;
    let fpEarned = 0;
    let dialogueCount = 0;
    let diceRolls: Array<{ total: number; outcome?: string }> = [];

    const TARGET_TURNS = 30;

    const gameState: GameState = {
      round: 0,
      sceneCount: 0,
      narrations: [],
      actions: [],
      locations: [],
      characterNames: ['Lady Isolde Ravencroft'],
    };

    let gameEnded = false;
    let lastFp = 3;

    for (let round = 1; round <= TARGET_TURNS && !gameEnded; round++) {
      gameState.round = round;

      try {
        const narMsg = await waitForAnyMsg(host, ['narration', 'phase-change'], 180_000);
        if (narMsg.type === 'phase-change') {
          if ((narMsg as any).phase === 'ended') {
            console.log(`[masquerade] Game ended at round ${round}`);
            gameEnded = true;
            break;
          }
          continue;
        }
        narrations.push(narMsg.text);
        gameState.narrations.push(narMsg.text);
        if ((narMsg as any).locationName) {
          locations.push((narMsg as any).locationName);
          gameState.locations.push((narMsg as any).locationName);
        }
        turnCount = round;

        // Track NPC mentions in narration
        for (const npc of scenarioNpcs) {
          const searchName = npc === 'Mira' ? 'Mira' : npc.split(' ').pop()!;
          if (narMsg.text.toLowerCase().includes(searchName.toLowerCase())) {
            npcMentions[npc] = (npcMentions[npc] ?? 0) + 1;
          }
        }
        // Track item mentions
        for (const item of scenarioItems) {
          const searchTerm = item.split(' ').pop()!.toLowerCase();
          if (narMsg.text.toLowerCase().includes(searchTerm)) {
            itemMentions[item] = (itemMentions[item] ?? 0) + 1;
          }
        }

        const next = await waitForAnyMsg(host, ['action-proposals', 'scene-end', 'phase-change'], 120_000);
        if (next.type === 'scene-end') {
          sceneCount++;
          gameState.sceneCount = sceneCount;
          console.log(`[masquerade] Scene ${sceneCount} ended at round ${round}: ${(next as any).summary?.slice(0, 100)}`);
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
        const whisper = generateWhisper('mentor', 'Lady Isolde Ravencroft', gameState, narMsg.text, lastAction);
        sendMsg(host, { type: 'whisper', text: whisper });
        whispersSent.push({ whisper, turn: round });
        console.log(`[masquerade] R${round} whisper: "${whisper.slice(0, 70)}"`);

        const actionMsg = await waitForMsg(host, 'action-taken', 120_000);
        if (actionMsg.type === 'action-taken') {
          const action = (actionMsg as any).action as string;
          const spoken = (actionMsg as any).spokenWords as string | null;
          actionsTaken.push({ action, turn: round, spokenWords: spoken ?? undefined });
          gameState.actions.push({ char: 'Lady Isolde Ravencroft', action });
          if (spoken) dialogueCount++;

          const influence = (actionMsg as any).whisperInfluence as string;
          if (influence === 'followed') followedCount++;
          else if (influence === 'ignored') ignoredCount++;
          else if (influence === 'partially-followed') partialCount++;
        }

        // Drain resolution + any state updates, dice rolls, compels
        let resolving = true;
        while (resolving) {
          const resMsg = await waitForAnyMsg(host, ['narration', 'resolution', 'scene-end', 'phase-change', 'character-state-update', 'dice-roll'], 120_000);

          if (resMsg.type === 'dice-roll') {
            diceRolls.push({ total: (resMsg as any).result?.total ?? 0 });
            continue;
          }
          if (resMsg.type === 'character-state-update') {
            const state = (resMsg as any).state;
            if (state) {
              const currentFp = state.fatePoints ?? lastFp;
              if (currentFp > lastFp) {
                fpEarned += (currentFp - lastFp);
                compelCount++;
              } else if (currentFp < lastFp) {
                fpSpent += (lastFp - currentFp);
              }
              lastFp = currentFp;

              // Track skill used from server logs would be ideal, but we can infer from actions
            }
            continue;
          }
          if (resMsg.type === 'narration' || resMsg.type === 'resolution') {
            narrations.push(resMsg.text ?? '');
            gameState.narrations.push(resMsg.text ?? '');
            // Track NPC mentions in resolution too
            const text = resMsg.text ?? '';
            for (const npc of scenarioNpcs) {
              const searchName = npc === 'Mira' ? 'Mira' : npc.split(' ').pop()!;
              if (text.toLowerCase().includes(searchName.toLowerCase())) {
                npcMentions[npc] = (npcMentions[npc] ?? 0) + 1;
              }
            }
            resolving = false;
          }
          if (resMsg.type === 'scene-end') {
            sceneCount++;
            gameState.sceneCount = sceneCount;
            console.log(`[masquerade] Scene ${sceneCount} ended at round ${round}`);
            resolving = false;
          }
          if (resMsg.type === 'phase-change') {
            if ((resMsg as any).phase === 'ended') { gameEnded = true; }
            resolving = false;
          }
        }

        // Infer skills from action text
        const actionLower = actionsTaken[actionsTaken.length - 1]?.action.toLowerCase() ?? '';
        if (/\b(deceive|disguise|lie|pretend|false identity|bluff|mask)\b/.test(actionLower)) skillsUsed.push('Deceive');
        else if (/\b(rapport|charm|persuade|convince|befriend|flatter)\b/.test(actionLower)) skillsUsed.push('Rapport');
        else if (/\b(notice|observe|watch|scan|spot|look|read.*body)\b/.test(actionLower)) skillsUsed.push('Notice');
        else if (/\b(empathy|sense|feel|emotion|mood|read.*intent)\b/.test(actionLower)) skillsUsed.push('Empathy');
        else if (/\b(will|resist|endure|concentrate|focus|mental)\b/.test(actionLower)) skillsUsed.push('Will');
        else if (/\b(investigate|search|examine|inspect|clue|evidence)\b/.test(actionLower)) skillsUsed.push('Investigate');
        else if (/\b(stealth|sneak|hide|shadow|creep|slip)\b/.test(actionLower)) skillsUsed.push('Stealth');
        else skillsUsed.push('other');

        if (round % 5 === 0) {
          const trustNow = trustTrajectory[trustTrajectory.length - 1]?.trust ?? 0.5;
          const uniqueLocs = new Set(locations).size;
          const skillDist = skillsUsed.reduce((acc, s) => { acc[s] = (acc[s] ?? 0) + 1; return acc; }, {} as Record<string, number>);
          console.log(`[masquerade] Round ${round} — scenes: ${sceneCount}, locs: ${uniqueLocs}, trust: ${trustNow.toFixed(2)}, fp: ${lastFp}, dialogue: ${dialogueCount}, follow/ignore/partial: ${followedCount}/${ignoredCount}/${partialCount}`);
          console.log(`[masquerade]   Skills: ${JSON.stringify(skillDist)}`);
          console.log(`[masquerade]   NPCs: ${JSON.stringify(npcMentions)}`);
        }
      } catch (e) {
        findings.push(`Round ${round}: ${(e as Error).message}`);
        console.error(`[masquerade] Round ${round} error:`, (e as Error).message);
        if (round < 3) throw e;
      }
    }

    // === FINAL REPORT ===
    console.log(`\n${'='.repeat(70)}`);
    console.log(`[masquerade] === MASQUERADE CHRONICLER SOLO RESULTS ===`);
    console.log(`${'='.repeat(70)}`);

    console.log(`\n--- Session Overview ---`);
    console.log(`Rounds completed: ${turnCount}/${TARGET_TURNS}`);
    console.log(`Scenes: ${sceneCount}`);
    console.log(`Game ended naturally: ${gameEnded}`);
    console.log(`Unique locations: ${new Set(locations).size} — ${[...new Set(locations)].join(', ')}`);
    console.log(`Dialogue lines: ${dialogueCount}`);

    console.log(`\n--- Trust Trajectory ---`);
    const trustFirst = trustTrajectory[0]?.trust ?? 0.5;
    const trustLast = trustTrajectory[trustTrajectory.length - 1]?.trust ?? 0.5;
    const trustMin = trustTrajectory.length > 0 ? Math.min(...trustTrajectory.map(t => t.trust)) : 0.5;
    const trustMax = trustTrajectory.length > 0 ? Math.max(...trustTrajectory.map(t => t.trust)) : 0.5;
    const trustRange = trustMax - trustMin;
    console.log(`Start: ${trustFirst.toFixed(2)} → End: ${trustLast.toFixed(2)}`);
    console.log(`Range: ${trustMin.toFixed(2)} - ${trustMax.toFixed(2)} (spread: ${trustRange.toFixed(2)})`);
    for (const t of trustTrajectory) {
      console.log(`  Turn ${t.turn}: ${t.trust.toFixed(3)}`);
    }

    console.log(`\n--- Whisper Influence ---`);
    console.log(`Followed: ${followedCount}, Ignored: ${ignoredCount}, Partial: ${partialCount}`);
    console.log(`Whispers sent: ${whispersSent.length}`);

    console.log(`\n--- Fate Point Economy ---`);
    console.log(`FP Spent (invokes): ${fpSpent}`);
    console.log(`FP Earned (compels): ${fpEarned} (${compelCount} compels triggered)`);
    console.log(`Final FP: ${lastFp}`);

    console.log(`\n--- Skill Diversity ---`);
    const skillDist = skillsUsed.reduce((acc, s) => { acc[s] = (acc[s] ?? 0) + 1; return acc; }, {} as Record<string, number>);
    const totalSkillUses = skillsUsed.length;
    for (const [skill, count] of Object.entries(skillDist).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${skill}: ${count} (${(count / totalSkillUses * 100).toFixed(0)}%)`);
    }
    const topSkillPct = Math.max(...Object.values(skillDist)) / totalSkillUses;
    if (topSkillPct > 0.5) {
      findings.push(`SKILL SPAM: Top skill used ${(topSkillPct * 100).toFixed(0)}% of the time — character may be one-note`);
    }

    console.log(`\n--- NPC Engagement ---`);
    for (const npc of scenarioNpcs) {
      const count = npcMentions[npc] ?? 0;
      console.log(`  ${npc}: ${count} mentions`);
      if (count === 0) findings.push(`NEGLECTED NPC: ${npc} never mentioned in narration/resolution`);
    }

    console.log(`\n--- Item Tracking ---`);
    for (const item of scenarioItems) {
      const count = itemMentions[item] ?? 0;
      console.log(`  ${item}: ${count} mentions`);
    }

    console.log(`\n--- Location Visit Pattern ---`);
    const locationVisits: Record<string, number> = {};
    for (const loc of locations) {
      locationVisits[loc] = (locationVisits[loc] ?? 0) + 1;
    }
    for (const [loc, count] of Object.entries(locationVisits).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${loc}: ${count} turns`);
    }

    console.log(`\n--- Dice Rolls ---`);
    console.log(`Total rolls: ${diceRolls.length}`);
    if (diceRolls.length > 0) {
      const avg = diceRolls.reduce((s, d) => s + d.total, 0) / diceRolls.length;
      console.log(`Average roll: ${avg.toFixed(2)}`);
    }

    console.log(`\n--- Whisper Log ---`);
    for (const w of whispersSent) {
      console.log(`  R${w.turn}: "${w.whisper.slice(0, 80)}"`);
    }

    console.log(`\n--- Action Log ---`);
    for (const a of actionsTaken) {
      const spoken = a.spokenWords ? ` — "${a.spokenWords.slice(0, 50)}"` : '';
      console.log(`  R${a.turn}: ${a.action.slice(0, 80)}${spoken}`);
    }

    // Quality checks
    if (trustRange < 0.10) findings.push(`LOW TRUST DIVERGENCE: Trust only moved ${trustRange.toFixed(2)} — whisper mechanic may not be engaging`);
    if (sceneCount < 2 && turnCount >= 15) findings.push(`STUCK IN SCENE 1: ${turnCount} turns but only ${sceneCount} scene transitions — pacing issue`);
    if (dialogueCount === 0 && turnCount >= 5) findings.push(`NO DIALOGUE: Character never spoke in ${turnCount} turns`);
    if (fpSpent === 0 && turnCount >= 10) findings.push(`NO FP SPEND: Fate points never spent in ${turnCount} turns — auto-invoke may not be triggering`);
    if (fpEarned === 0 && turnCount >= 10) findings.push(`NO COMPELS: No compels in ${turnCount} turns — trouble aspect underutilized`);

    const inventedLocations = locations.filter(l => !['The Grand Ballroom', 'The Wine Cellar', "The Duchess's Study", 'The Garden Terrace', "The Servants' Corridor", 'The Music Gallery'].includes(l));
    if (inventedLocations.length > 0) findings.push(`INVENTED LOCATIONS: ${[...new Set(inventedLocations)].join(', ')} — DM created locations not in scenario`);

    console.log(`\n--- Findings ---`);
    if (findings.length === 0) {
      console.log('No issues found!');
    } else {
      for (const f of findings) {
        console.log(`  ⚠ ${f}`);
      }
    }

    // Assertions
    expect(turnCount).toBeGreaterThanOrEqual(5);
    expect(sceneCount).toBeGreaterThanOrEqual(1);

  }, 1_800_000);
});
