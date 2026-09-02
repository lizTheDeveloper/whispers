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
    'Use FATE Core. Frontier outpost mystery scenario. Two players with very different personalities — one fighter, one diplomat. No house rules.',
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
    console.log('\n=== SERVER LOGS (last 120) ===');
    allServerLogs.slice(-120).forEach(l => console.log(l));
  }
});

describeIfLive('Stress Test: Trickster DM + Frontier Outpost (40 turns, conflicting characters)', () => {
  it('tests trust divergence, taken-out handling, trust split hints, and epilogue', async () => {
    const findings: string[] = [];

    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Stress Frontier 40',
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
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Fighter' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'Diplomat' });
    await Promise.all([waitForMsg(p1, 'room-joined'), waitForMsg(p2, 'room-joined')]);

    const fighter: CharacterDefinition = {
      name: 'Kira Sunblade',
      highConcept: 'Righteous Blade Who Judges Before She Thinks',
      trouble: 'My Sword Arm Answers Before My Mind Does',
      aspects: ['The Innocent Must Be Protected', 'There Is No Gray — Only Right And Wrong'],
      personality: 'Zealous, aggressive, charges into danger. Distrusts diplomacy. Protects the weak with violence.',
      backstory: 'A former temple guard who saw corruption in the clergy and now trusts only her own blade. Left her order after striking a superior who was shaking down villagers.',
      skills: { Fight: 4, Athletics: 3, Provoke: 3, Will: 2, Physique: 2, Notice: 1, Rapport: 0, Deceive: 0 },
      stunts: ['Killing Strike: +2 to Fight when defending an innocent', 'Intimidating Presence: +2 to Provoke when confronting someone caught lying'],
    };

    const diplomat: CharacterDefinition = {
      name: 'Venn Silkweave',
      highConcept: 'Silver-Tongued Emissary Who Sees All Sides',
      trouble: 'I Will Compromise Anything To Avoid Conflict',
      aspects: ['Words Are Cheaper Than Blood', 'Every Enemy Is A Future Ally'],
      personality: 'Cautious, empathetic, avoids all conflict. Sees every enemy as a potential friend. Will talk endlessly rather than fight.',
      backstory: 'An emissary who brokered a fragile peace between two warring baronies. That peace crumbled when both sides realized Venn had promised each of them different things.',
      skills: { Rapport: 4, Deceive: 3, Empathy: 3, Investigate: 2, Lore: 2, Notice: 1, Fight: 0, Athletics: 0 },
      stunts: ['Silver Tongue: +2 to Rapport when mediating between hostile parties', 'Read Between Lines: +2 to Empathy when detecting lies'],
    };

    for (const [player, def, label] of [[p1, fighter, 'fighter'], [p2, diplomat, 'diplomat']] as const) {
      let approved = false;
      let charId = '';
      for (let attempt = 0; attempt < 3 && !approved; attempt++) {
        const valPromise = waitForMsg(player, 'character-validated', 90_000);
        sendMsg(player, { type: 'submit-character', definition: def });
        const valMsg = await valPromise;
        if (valMsg.type === 'character-validated' && (valMsg as any).approved) {
          charId = (valMsg as any).characterId;
          approved = true;
          console.log(`[stress] ${label} AI-approved: ${charId}`);
        } else {
          console.log(`[stress] ${label} validation attempt ${attempt + 1} failed`);
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
      console.log(`[stress] Host approved ${label}`);
      await new Promise(r => setTimeout(r, 1000));
    }

    sendMsg(host, { type: 'start-game' });
    const startMsg = await waitForMsg(p1, 'phase-change', 10_000);
    expect(startMsg.type === 'phase-change' && (startMsg as any).phase).toBe('playing');
    console.log('[stress] Game started');

    const narrations: string[] = [];
    const actionsTaken: Array<{ char: string; action: string; turn: number }> = [];
    const whispersSent: Array<{ char: string; whisper: string; style: PlayerStyle; turn: number }> = [];
    const trustTrajectory: Array<{ char: string; trust: number; turn: number }> = [];
    const locations: string[] = [];
    let sceneCount = 0;
    let turnCount = 0;
    let followedCount = 0;
    let ignoredCount = 0;
    let compelCount = 0;
    let takenOutDetected = false;
    let takenOutSkipDetected = false;
    let epilogueReceived = false;

    const TARGET_TURNS = 40;

    const charStyles: Record<string, PlayerStyle> = {
      'Kira Sunblade': 'antagonist',
      'Venn Silkweave': 'mentor',
    };

    const gameState: GameState = {
      round: 0,
      sceneCount: 0,
      narrations: [],
      actions: [],
      locations: [],
      characterNames: ['Kira Sunblade', 'Venn Silkweave'],
    };

    let gameEnded = false;
    for (let round = 1; round <= TARGET_TURNS && !gameEnded; round++) {
      gameState.round = round;

      try {
        const narMsg = await waitForAnyMsg(host, ['narration', 'phase-change'], 180_000);
        if (narMsg.type === 'phase-change') {
          if ((narMsg as any).phase === 'ended') {
            console.log(`[stress] Game ended at round ${round}`);
            gameEnded = true;
            break;
          }
          continue;
        }
        const narText = narMsg.text ?? '';
        narrations.push(narText);
        gameState.narrations.push(narText);

        if ((narMsg as any).isEpilogue) {
          epilogueReceived = true;
          console.log(`[stress] Epilogue received at round ${round}: "${narText.slice(0, 80)}..."`);
        }

        if ((narMsg as any).locationName) {
          locations.push((narMsg as any).locationName);
          gameState.locations.push((narMsg as any).locationName);
        }

        if (/compel|old habits|trouble.*rears|fate.*generous|shadow of/i.test(narText)) {
          compelCount++;
        }

        turnCount = round;

        const next = await waitForAnyMsg(host, ['action-proposals', 'scene-end', 'phase-change'], 120_000);
        if (next.type === 'scene-end') {
          sceneCount++;
          gameState.sceneCount = sceneCount;
          console.log(`[stress] Scene ${sceneCount} ended at round ${round}`);
          continue;
        }
        if (next.type === 'phase-change') {
          if ((next as any).phase === 'ended') { gameEnded = true; break; }
          continue;
        }
        if (next.type !== 'action-proposals') continue;

        let currentProposals: ServerMessage | null = next;
        for (let charIdx = 0; charIdx < 2 && currentProposals; charIdx++) {
          const charName = (currentProposals as any).characterName as string;
          const trust = (currentProposals as any).whisperTrust as number;
          if (trust !== undefined) trustTrajectory.push({ char: charName, trust, turn: round });

          await waitForMsg(host, 'whisper-prompt', 30_000);

          const style = charStyles[charName] ?? 'mentor';
          const lastAction = actionsTaken.filter(a => a.char === charName).slice(-1)[0]?.action;
          const whisper = generateWhisper(style, charName, gameState, narText, lastAction);

          sendMsg(host, { type: 'whisper', text: whisper });
          whispersSent.push({ char: charName, whisper, style, turn: round });
          console.log(`[stress] R${round} [${style}] → ${charName.split(' ')[0]}: "${whisper.slice(0, 60)}"`);

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
            const resText = resMsg.text ?? '';
            narrations.push(resText);
            gameState.narrations.push(resText);
            if (/compel|old habits|trouble.*rears|fate.*generous|shadow of/i.test(resText)) {
              compelCount++;
            }
            if (/TAKEN OUT/i.test(resText)) {
              takenOutDetected = true;
              console.log(`[stress] TAKEN OUT detected at round ${round}: "${resText.slice(0, 80)}"`);
            }
            if ((resMsg as any).isEpilogue) {
              epilogueReceived = true;
              console.log(`[stress] Epilogue (in resolution): "${resText.slice(0, 80)}..."`);
            }
          }
          if (resMsg.type === 'scene-end') {
            sceneCount++;
            gameState.sceneCount = sceneCount;
            console.log(`[stress] Scene ${sceneCount} ended at round ${round}`);
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
            for (let drain = 0; drain < 10 && !found; drain++) {
              const peek = await waitForAnyMsg(host, ['action-proposals', 'narration', 'scene-end', 'phase-change', 'character-state-update', 'dice-roll'], 60_000).catch(() => null);
              if (!peek) { currentProposals = null; break; }
              if (peek.type === 'action-proposals') { currentProposals = peek; found = true; }
              else if (peek.type === 'narration') {
                const peekText = peek.text ?? '';
                narrations.push(peekText);
                if (/TAKEN OUT/i.test(peekText)) { takenOutDetected = true; }
                if ((peek as any).isEpilogue) { epilogueReceived = true; }
              }
              else if (peek.type === 'character-state-update' || peek.type === 'dice-roll') { continue; }
              else if (peek.type === 'scene-end') {
                sceneCount++; gameState.sceneCount = sceneCount;
                currentProposals = null; break;
              }
              else if (peek.type === 'phase-change') {
                if ((peek as any).phase === 'ended') gameEnded = true;
                currentProposals = null; break;
              }
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
            `${c.split(' ')[0]}: ${vals[vals.length - 1]?.toFixed(2) ?? '?'}`
          ).join(', ');
          console.log(`[stress] Round ${round} — ${sceneCount} scenes, ${new Set(locations).size} locs, ${actionsTaken.length} actions, trust=[${trustSummary}], compels=${compelCount}, follow/ignore=${followedCount}/${ignoredCount}`);
        }
      } catch (e) {
        findings.push(`Round ${round}: ${(e as Error).message}`);
        console.error(`[stress] Round ${round} error:`, (e as Error).message);
        if (round < 3) throw e;
      }
    }

    // Check for taken-out skip in server logs
    takenOutSkipDetected = allServerLogs.some(l => /Skipping.*taken out/i.test(l));

    // Check for trust split hint in server logs
    const trustSplitDetected = allServerLogs.some(l => /TRUST SPLIT/i.test(l));

    // Check for NPC names in narrations
    const outpostNpcs = ['Marshal Thorne', 'Chieftain Asha', 'Kef', 'Old Berrin', 'Dara', 'Brother Moss'];
    const allNarrationText = narrations.join(' ');
    const npcsReferenced = outpostNpcs.filter(npc => {
      const searchTerm = npc.split(' ').pop()!;
      return allNarrationText.toLowerCase().includes(searchTerm.toLowerCase());
    });

    // Check for character interaction
    const kiraActions = actionsTaken.filter(a => a.char === 'Kira Sunblade').map(a => a.action.toLowerCase());
    const vennActions = actionsTaken.filter(a => a.char === 'Venn Silkweave').map(a => a.action.toLowerCase());
    const kiraRefsVenn = kiraActions.filter(a => a.includes('venn') || a.includes('silkweave')).length;
    const vennRefsKira = vennActions.filter(a => a.includes('kira') || a.includes('sunblade')).length;

    // Trust analysis
    const trustByChar: Record<string, number[]> = {};
    for (const t of trustTrajectory) {
      if (!trustByChar[t.char]) trustByChar[t.char] = [];
      trustByChar[t.char]!.push(t.trust);
    }

    console.log(`\n[stress] ========== RESULTS ==========`);
    console.log(`[stress] Rounds: ${turnCount}/${TARGET_TURNS}`);
    console.log(`[stress] Actions: ${actionsTaken.length} (by ${new Set(actionsTaken.map(a => a.char)).size} chars)`);
    console.log(`[stress] Scenes: ${sceneCount}`);
    console.log(`[stress] Unique locations: ${new Set(locations).size} — ${[...new Set(locations)].join(', ')}`);
    console.log(`[stress] NPCs referenced: ${npcsReferenced.length}/6 — ${npcsReferenced.join(', ')}`);
    console.log(`[stress] Whispers sent: ${whispersSent.length}`);
    console.log(`[stress] Followed: ${followedCount}, Ignored: ${ignoredCount}, Partial: ${whispersSent.length - followedCount - ignoredCount}`);
    console.log(`[stress] Compels detected: ${compelCount}`);
    console.log(`[stress] Taken out detected: ${takenOutDetected}`);
    console.log(`[stress] Taken out SKIP detected: ${takenOutSkipDetected}`);
    console.log(`[stress] Trust split hint: ${trustSplitDetected}`);
    console.log(`[stress] Epilogue received (isEpilogue): ${epilogueReceived}`);
    console.log(`[stress] Character interaction: Kira refs Venn ${kiraRefsVenn}x, Venn refs Kira ${vennRefsKira}x`);

    for (const [char, vals] of Object.entries(trustByChar)) {
      const first = vals[0]!;
      const last = vals[vals.length - 1]!;
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      console.log(`[stress] Trust ${char}: ${first.toFixed(2)} → ${last.toFixed(2)} (range ${min.toFixed(2)}-${max.toFixed(2)})`);
    }

    console.log(`\n[stress] === METRIC VERDICTS ===`);

    // 1. Trust divergence
    const kTrust = trustByChar['Kira Sunblade'] ?? [];
    const vTrust = trustByChar['Venn Silkweave'] ?? [];
    const kLast = kTrust[kTrust.length - 1] ?? 0.5;
    const vLast = vTrust[vTrust.length - 1] ?? 0.5;
    const trustDiverged = kLast < 0.40 && vLast > 0.50;
    console.log(`[stress] 1. Trust divergence: ${trustDiverged ? 'PASS' : 'PARTIAL'} (Kira=${kLast.toFixed(2)}, Venn=${vLast.toFixed(2)})`);

    // 2. Taken-out handling
    console.log(`[stress] 2. Taken-out: detected=${takenOutDetected}, skipped=${takenOutSkipDetected}`);

    // 3. Scene count
    const scenePass = sceneCount >= 3;
    console.log(`[stress] 3. Scene count: ${scenePass ? 'PASS' : 'FAIL'} (${sceneCount} scenes)`);

    // 4. NPC engagement
    const npcPass = npcsReferenced.length >= 4;
    console.log(`[stress] 4. NPC engagement: ${npcPass ? 'PASS' : 'FAIL'} (${npcsReferenced.length}/6)`);

    // 5. Location variety
    const uniqueLocs = new Set(locations).size;
    const locPass = uniqueLocs >= 4;
    console.log(`[stress] 5. Location variety: ${locPass ? 'PASS' : 'FAIL'} (${uniqueLocs}/7)`);

    // 6. Compels
    const compelPass = compelCount >= 3;
    console.log(`[stress] 6. Compel count: ${compelPass ? 'PASS' : 'FAIL'} (${compelCount})`);

    // 7. Trust split hint
    console.log(`[stress] 7. Trust split hint: ${trustSplitDetected ? 'PASS' : 'NOT TRIGGERED'}`);

    // 8. Character interaction
    const interactionPass = (kiraRefsVenn + vennRefsKira) >= 2;
    console.log(`[stress] 8. Character interaction: ${interactionPass ? 'PASS' : 'FAIL'} (${kiraRefsVenn + vennRefsKira} cross-references)`);

    // 9. Epilogue
    console.log(`[stress] 9. Epilogue (isEpilogue flag): ${epilogueReceived ? 'PASS' : gameEnded ? 'FAIL — game ended but no epilogue flag' : 'NOT REACHED — game still running'}`);

    if (findings.length > 0) console.log(`[stress] Runtime findings: ${findings.join('; ')}`);

    // Assertions (soft — log everything, fail on critical issues)
    expect(turnCount).toBeGreaterThanOrEqual(5);
    expect(sceneCount).toBeGreaterThanOrEqual(2);
    const uniqueChars = new Set(actionsTaken.map(a => a.char));
    expect(uniqueChars.size).toBe(2);

  }, 2_400_000);
});
