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
    'Use FATE Core. Dungeon crawl in a collapsed mine. Two players. No house rules.',
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

describeIfLive('Mine Trickster 2-Char: Chaos + Strategist in Collapsed Mine', () => {
  it('runs 30 rounds with two contrasting whisper styles testing party dynamics', async () => {
    const findings: string[] = [];

    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Mine Trickster Playtest',
      dmPreset: 'trickster',
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
    sendMsg(p1, { type: 'join', joinCode, playerName: 'ChaosPlayer' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'StrategistPlayer' });
    await Promise.all([waitForMsg(p1, 'room-joined'), waitForMsg(p2, 'room-joined')]);

    const forgeIronhand: CharacterDefinition = {
      name: 'Forge Ironhand',
      highConcept: 'Stubborn Mine Foreman Who Won\'t Leave Anyone Behind',
      trouble: 'My Pride Won\'t Let Me Ask For Help',
      aspects: ['These Tunnels Are My Veins', 'Every Cave-In Has A Weak Point', 'I\'ve Buried Too Many Friends'],
      personality: 'Gruff, bull-headed, and protective. Knows every tunnel by instinct. Would rather die than abandon a miner.',
      backstory: 'Forge has run the Thornhaven mine for twenty years. He was above ground when the tremor hit, checking supplies. Five of his crew are trapped below. He blames himself.',
      skills: { Athletics: 4, Fight: 3, Will: 3, Notice: 2, Crafts: 2, Physique: 1, Investigate: 1, Rapport: 0 },
      stunts: ['Tunnel Sense: +2 to Notice when detecting structural instability', 'Iron Will: +2 to Will when resisting fear or intimidation underground'],
    };

    const sisterCalla: CharacterDefinition = {
      name: 'Sister Calla',
      highConcept: 'Battlefield Healer Who Prays With One Hand And Sutures With The Other',
      trouble: 'I Cannot Save Everyone And It\'s Killing Me',
      aspects: ['The Light Follows My Hands', 'Every Life Is Worth The Risk', 'I Know What Death Looks Like'],
      personality: 'Calm under pressure, fiercely compassionate. Covers her fear with prayer and pragmatism. The miners trust her more than any doctor.',
      backstory: 'Calla came to Thornhaven to tend the miners after the last accident. When the mine collapsed, she was the first to volunteer for the rescue. She has seen too many people die to hesitate.',
      skills: { Empathy: 4, Lore: 3, Will: 3, Rapport: 2, Notice: 2, Athletics: 1, Investigate: 1, Crafts: 0 },
      stunts: ['Field Medicine: +2 to Lore when treating wounds or illness', 'Calming Presence: +2 to Empathy when de-escalating a panicked group'],
    };

    for (const [player, def, label] of [[p1, forgeIronhand, 'forge'], [p2, sisterCalla, 'calla']] as const) {
      let approved = false;
      let charId = '';
      for (let attempt = 0; attempt < 3 && !approved; attempt++) {
        const valPromise = waitForMsg(player, 'character-validated', 90_000);
        sendMsg(player, { type: 'submit-character', definition: def });
        const valMsg = await valPromise;
        if (valMsg.type === 'character-validated' && (valMsg as any).approved) {
          charId = (valMsg as any).characterId;
          approved = true;
          console.log(`[mine] ${label} AI-approved: ${charId}`);
        } else {
          console.log(`[mine] ${label} validation attempt ${attempt + 1} failed`);
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
      console.log(`[mine] Host approved ${label}`);
      await new Promise(r => setTimeout(r, 1000));
    }

    sendMsg(host, { type: 'start-game' });
    const startMsg = await waitForMsg(p1, 'phase-change', 10_000);
    expect(startMsg.type === 'phase-change' && (startMsg as any).phase).toBe('playing');
    console.log('[mine] Game started');

    // Tracking state
    const narrations: string[] = [];
    const actionsTaken: Array<{ char: string; action: string; turn: number; spokenWords?: string }> = [];
    const whispersSent: Array<{ char: string; whisper: string; style: PlayerStyle; turn: number }> = [];
    const trustTrajectory: Array<{ char: string; trust: number; turn: number }> = [];
    const locations: string[] = [];
    const npcMentions: Record<string, number> = { 'Elder Maren': 0, 'Tobias': 0, 'Foreman Greaves': 0, 'The Pale Woman': 0 };
    const skillUsage: Record<string, Record<string, number>> = { 'Forge Ironhand': {}, 'Sister Calla': {} };
    const cooperativeActions: Array<{ char: string; mentionedOther: string; turn: number }> = [];
    const compels: Array<{ char: string; turn: number }> = [];
    const fatePointHistory: Array<{ char: string; fp: number; turn: number }> = [];
    const dialogueTurns: Array<{ char: string; turn: number }> = [];
    const whisperInfluencePerChar: Record<string, { followed: number; partial: number; ignored: number }> = {
      'Forge Ironhand': { followed: 0, partial: 0, ignored: 0 },
      'Sister Calla': { followed: 0, partial: 0, ignored: 0 },
    };
    let sceneCount = 0;
    let turnCount = 0;

    const TARGET_TURNS = 30;

    const charStyles: Record<string, PlayerStyle> = {
      'Forge Ironhand': 'chaos',
      'Sister Calla': 'strategist',
    };

    const gameState: GameState = {
      round: 0,
      sceneCount: 0,
      narrations: [],
      actions: [],
      locations: [],
      characterNames: ['Forge Ironhand', 'Sister Calla'],
    };

    let gameEnded = false;
    for (let round = 1; round <= TARGET_TURNS && !gameEnded; round++) {
      gameState.round = round;

      try {
        const narMsg = await waitForAnyMsg(host, ['narration', 'phase-change'], 180_000);
        if (narMsg.type === 'phase-change') {
          if ((narMsg as any).phase === 'ended') { console.log(`[mine] Game ended at round ${round}`); gameEnded = true; break; }
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
        const narLower = narMsg.text.toLowerCase();
        for (const npc of Object.keys(npcMentions)) {
          const npcFirst = npc.split(' ').pop()!.toLowerCase();
          if (narLower.includes(npcFirst)) npcMentions[npc]!++;
        }

        // Track compels
        if (narLower.includes('compel') || narLower.includes('fate point')) {
          for (const cn of ['Forge Ironhand', 'Sister Calla']) {
            if (narLower.includes(cn.split(' ')[0]!.toLowerCase())) {
              compels.push({ char: cn, turn: round });
            }
          }
        }

        const next = await waitForAnyMsg(host, ['action-proposals', 'scene-end', 'phase-change'], 120_000);
        if (next.type === 'scene-end') {
          sceneCount++;
          gameState.sceneCount = sceneCount;
          console.log(`[mine] Scene ${sceneCount} ended at round ${round}`);
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
          console.log(`[mine] R${round} [${style}] → ${charName.split(' ')[0]}: "${whisper.slice(0, 60)}"`);

          const actionMsg = await waitForMsg(host, 'action-taken', 120_000);
          if (actionMsg.type === 'action-taken') {
            const action = (actionMsg as any).action as string;
            const spokenWords = (actionMsg as any).spokenWords as string | undefined;
            actionsTaken.push({ char: (actionMsg as any).characterName, action, turn: round, spokenWords });
            gameState.actions.push({ char: (actionMsg as any).characterName, action });

            // Track spoken dialogue
            if (spokenWords) {
              dialogueTurns.push({ char: (actionMsg as any).characterName, turn: round });
            }

            // Track cooperative actions (mentions of the other character)
            const otherChar = charName === 'Forge Ironhand' ? 'Sister Calla' : 'Forge Ironhand';
            const otherFirst = otherChar.split(' ')[0]!.toLowerCase();
            if (action.toLowerCase().includes(otherFirst) || (spokenWords ?? '').toLowerCase().includes(otherFirst)) {
              cooperativeActions.push({ char: charName, mentionedOther: otherChar, turn: round });
            }

            // Track skill usage (rough keyword matching)
            const actionLower = action.toLowerCase();
            const charSkills = charName === 'Forge Ironhand'
              ? ['Athletics', 'Fight', 'Will', 'Notice', 'Crafts', 'Physique', 'Investigate', 'Rapport']
              : ['Empathy', 'Lore', 'Will', 'Rapport', 'Notice', 'Athletics', 'Investigate', 'Crafts'];
            const skillKeywords: Record<string, string[]> = {
              Athletics: ['climb', 'run', 'jump', 'dodge', 'sprint', 'lift', 'carry', 'push', 'pull', 'haul'],
              Fight: ['attack', 'strike', 'punch', 'kick', 'defend', 'block', 'fight', 'swing', 'wrestle'],
              Will: ['resist', 'endure', 'focus', 'concentrate', 'steel', 'resolve', 'refuse', 'determination'],
              Notice: ['look', 'spot', 'notice', 'observe', 'scan', 'check', 'listen', 'watch', 'peer'],
              Crafts: ['craft', 'build', 'repair', 'fix', 'construct', 'forge', 'improvise', 'rig'],
              Physique: ['brace', 'endure', 'withstand', 'muscle', 'strength', 'hold', 'force'],
              Investigate: ['investigate', 'examine', 'search', 'inspect', 'study', 'analyze', 'track', 'read'],
              Rapport: ['talk', 'speak', 'persuade', 'negotiate', 'convince', 'charm', 'reassure', 'comfort'],
              Empathy: ['empathize', 'sense', 'feel', 'comfort', 'calm', 'soothe', 'understand', 'care', 'heal'],
              Lore: ['know', 'recall', 'identify', 'recognize', 'history', 'medicine', 'treat', 'diagnose', 'pray'],
              Deceive: ['lie', 'deceive', 'bluff', 'trick', 'mislead', 'feint'],
              Stealth: ['sneak', 'hide', 'stealth', 'creep', 'shadow', 'lurk'],
            };
            for (const skill of charSkills) {
              const keywords = skillKeywords[skill] ?? [];
              if (keywords.some(kw => actionLower.includes(kw))) {
                if (!skillUsage[charName]) skillUsage[charName] = {};
                skillUsage[charName]![skill] = (skillUsage[charName]![skill] ?? 0) + 1;
              }
            }

            // Track whisper influence per character
            const influence = (actionMsg as any).whisperInfluence as string;
            if (influence === 'followed') whisperInfluencePerChar[charName]!.followed++;
            else if (influence === 'partially-followed') whisperInfluencePerChar[charName]!.partial++;
            else if (influence === 'ignored') whisperInfluencePerChar[charName]!.ignored++;
          }

          const resMsg = await waitForAnyMsg(host, ['narration', 'resolution', 'scene-end', 'phase-change'], 120_000);
          if (resMsg.type === 'narration' || resMsg.type === 'resolution') {
            narrations.push(resMsg.text ?? '');
            gameState.narrations.push(resMsg.text ?? '');

            // Track NPC mentions in resolution
            const resLower = (resMsg.text ?? '').toLowerCase();
            for (const npc of Object.keys(npcMentions)) {
              const npcFirst = npc.split(' ').pop()!.toLowerCase();
              if (resLower.includes(npcFirst)) npcMentions[npc]!++;
            }
          }
          if (resMsg.type === 'scene-end') {
            sceneCount++;
            gameState.sceneCount = sceneCount;
            console.log(`[mine] Scene ${sceneCount} ended at round ${round}`);
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
            `${c.split(' ')[0]}: ${vals[vals.length - 1]?.toFixed(2) ?? '?'}`
          ).join(', ');
          const locsSeen = new Set(locations).size;
          const npcSummary = Object.entries(npcMentions).filter(([, c]) => c > 0).map(([n, c]) => `${n.split(' ').pop()}(${c})`).join(', ');
          console.log(`[mine] Round ${round} — ${sceneCount} scenes, ${locsSeen} locs, ${actionsTaken.length} actions, trust=[${trustSummary}], npcs=[${npcSummary}], coop=${cooperativeActions.length}`);
        }
      } catch (e) {
        findings.push(`Round ${round}: ${(e as Error).message}`);
        console.error(`[mine] Round ${round} error:`, (e as Error).message);
        if (round < 3) throw e;
      }
    }

    // === COMPREHENSIVE RESULTS ===
    console.log(`\n[mine] ========== RESULTS ==========`);
    console.log(`[mine] Rounds completed: ${turnCount}/${TARGET_TURNS}`);
    console.log(`[mine] Total actions: ${actionsTaken.length} (by ${new Set(actionsTaken.map(a => a.char)).size} chars)`);
    console.log(`[mine] Scenes: ${sceneCount}`);
    console.log(`[mine] Unique locations visited: ${new Set(locations).size}`);
    console.log(`[mine] Location sequence: ${locations.join(' → ')}`);

    // Character action balance
    const forgeActions = actionsTaken.filter(a => a.char === 'Forge Ironhand').length;
    const callaActions = actionsTaken.filter(a => a.char === 'Sister Calla').length;
    console.log(`\n[mine] --- Character Balance ---`);
    console.log(`[mine] Forge Ironhand actions: ${forgeActions}`);
    console.log(`[mine] Sister Calla actions: ${callaActions}`);
    const balance = Math.abs(forgeActions - callaActions) / Math.max(forgeActions, callaActions, 1);
    console.log(`[mine] Balance ratio: ${(1 - balance).toFixed(2)} (1.0 = perfectly even)`);

    // Trust trajectories
    console.log(`\n[mine] --- Trust Trajectories ---`);
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
      const divergence = Math.abs(last - first);
      console.log(`[mine] ${char}: ${first.toFixed(2)} → ${last.toFixed(2)} (range ${min.toFixed(2)}-${max.toFixed(2)}, divergence ${divergence.toFixed(2)})`);
    }

    // Trust divergence between characters
    const forgeVals = trustByChar['Forge Ironhand'] ?? [];
    const callaVals = trustByChar['Sister Calla'] ?? [];
    if (forgeVals.length > 0 && callaVals.length > 0) {
      const lastForge = forgeVals[forgeVals.length - 1]!;
      const lastCalla = callaVals[callaVals.length - 1]!;
      console.log(`[mine] Inter-character trust gap: ${Math.abs(lastForge - lastCalla).toFixed(2)}`);
    }

    // Whisper influence per character
    console.log(`\n[mine] --- Whisper Influence ---`);
    for (const [char, inf] of Object.entries(whisperInfluencePerChar)) {
      const total = inf.followed + inf.partial + inf.ignored;
      console.log(`[mine] ${char}: followed=${inf.followed}, partial=${inf.partial}, ignored=${inf.ignored} (total ${total})`);
    }

    // Skill usage diversity
    console.log(`\n[mine] --- Skill Usage ---`);
    for (const [char, skills] of Object.entries(skillUsage)) {
      const entries = Object.entries(skills).sort((a, b) => b[1] - a[1]);
      const total = entries.reduce((s, [, v]) => s + v, 0);
      console.log(`[mine] ${char}: ${entries.map(([s, c]) => `${s}(${c})`).join(', ') || 'none detected'} — ${entries.length} unique skills, ${total} total`);
    }

    // NPC engagement
    console.log(`\n[mine] --- NPC Engagement ---`);
    for (const [npc, count] of Object.entries(npcMentions)) {
      console.log(`[mine] ${npc}: ${count} mentions`);
    }
    const unengagedNpcs = Object.entries(npcMentions).filter(([, c]) => c === 0).map(([n]) => n);
    if (unengagedNpcs.length > 0) {
      findings.push(`NPCs never engaged: ${unengagedNpcs.join(', ')}`);
    }

    // Cooperative actions
    console.log(`\n[mine] --- Cooperation ---`);
    console.log(`[mine] Cooperative actions (mentioning other character): ${cooperativeActions.length}`);
    for (const ca of cooperativeActions.slice(0, 10)) {
      console.log(`[mine]   R${ca.turn}: ${ca.char} mentioned ${ca.mentionedOther}`);
    }

    // Dialogue frequency
    console.log(`\n[mine] --- Dialogue ---`);
    const forgeDialogue = dialogueTurns.filter(d => d.char === 'Forge Ironhand').length;
    const callaDialogue = dialogueTurns.filter(d => d.char === 'Sister Calla').length;
    console.log(`[mine] Forge Ironhand spoke: ${forgeDialogue}/${forgeActions} turns (${forgeActions > 0 ? ((forgeDialogue / forgeActions) * 100).toFixed(0) : 0}%)`);
    console.log(`[mine] Sister Calla spoke: ${callaDialogue}/${callaActions} turns (${callaActions > 0 ? ((callaDialogue / callaActions) * 100).toFixed(0) : 0}%)`);

    // Compels
    console.log(`\n[mine] --- Compels ---`);
    console.log(`[mine] Total compels detected: ${compels.length}`);
    for (const c of compels) {
      console.log(`[mine]   R${c.turn}: ${c.char}`);
    }

    // Whisper log
    console.log(`\n[mine] --- Whisper Log ---`);
    for (const w of whispersSent) {
      console.log(`[mine]   R${w.turn} [${w.style}] → ${w.char.split(' ')[0]}: "${w.whisper.slice(0, 70)}"`);
    }

    if (findings.length > 0) {
      console.log(`\n[mine] === FINDINGS ===`);
      for (const f of findings) console.log(`[mine] ⚠ ${f}`);
    }

    // Assertions
    expect(turnCount).toBeGreaterThanOrEqual(5);
    expect(sceneCount).toBeGreaterThanOrEqual(2);
    expect(new Set(locations).size).toBeGreaterThanOrEqual(2);
    const uniqueChars = new Set(actionsTaken.map(a => a.char));
    expect(uniqueChars.size).toBe(2);

    const chaosWhispers = whispersSent.filter(w => w.style === 'chaos');
    const strategistWhispers = whispersSent.filter(w => w.style === 'strategist');
    expect(chaosWhispers.length).toBeGreaterThan(0);
    expect(strategistWhispers.length).toBeGreaterThan(0);

  }, 2_400_000);
});
