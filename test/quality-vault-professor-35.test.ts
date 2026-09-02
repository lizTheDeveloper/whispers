import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getFreePort, connectWs as rawConnectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import type { WebSocket } from 'ws';
import type { ServerMessage } from '../src/shared/protocol.js';
import type { CharacterDefinition } from '../src/shared/types.js';
import { generateWhisper, type PlayerStyle, type GameState } from './lib/adaptive-whisper.js';

const LLM_PROXY_URL = process.env.LLM_PROXY_URL;
const describeIfLive = LLM_PROXY_URL ? describe : describe.skip;

let serverProcess: ReturnType<typeof import('node:child_process').fork> | null = null;
let port: number;
const allServerLogs: string[] = [];

async function connectWsQ(): Promise<{ ws: WebSocket; q: MessageQueue }> {
  const ws = await rawConnectWs(port);
  return { ws, q: new MessageQueue(ws) };
}

async function completeDmSetup(ws: WebSocket, q: MessageQueue): Promise<void> {
  await q.waitFor('dm-settings');
  await q.waitFor('dm-chat-reply');
  const followUps = [
    'Use FATE Core. Heist scenario inside a clockwork vault. Two players. No house rules.',
    'Yes, everything is decided. Start the game now. We are ready.',
    'Confirmed. Lock it in. Done.',
  ];
  for (const text of followUps) {
    sendMsg(ws, { type: 'dm-chat', text });
    const reply = await q.waitFor('dm-chat-reply', 90_000);
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
    allServerLogs.slice(-150).forEach(l => console.log(l));
  }
});

const VAULT_LOCATIONS = [
  'The Exhibition Hall',
  'The Maintenance Corridor',
  'Vault Floor One',
  'Vault Floor Two',
  'The Orrery Chamber',
];

const VAULT_NPCS = ['Sparks', 'Guildmaster Vex', 'Lady Ashworth', 'Cogsworth'];

describeIfLive('Quality: Professor DM + Clockwork Vault 35-turn heist', () => {
  it('runs 35 rounds evaluating heist pacing, trust divergence, skill variety, and compel engagement', async () => {
    const findings: string[] = [];

    const { ws: hostWs, q: host } = await connectWsQ();
    sendMsg(hostWs, {
      type: 'create',
      name: 'Quality Vault Professor 35',
      dmPreset: 'professor',
      scenarioId: 'clockwork-vault',
      systemId: 'fate-core',
      houseRules: null,
    });
    const roomMsg = await host.waitFor('room-joined');
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;

    await completeDmSetup(hostWs, host);

    const { ws: p1Ws, q: p1 } = await connectWsQ();
    const { ws: p2Ws, q: p2 } = await connectWsQ();
    sendMsg(p1Ws, { type: 'join', joinCode, playerName: 'Strategist' });
    sendMsg(p2Ws, { type: 'join', joinCode, playerName: 'Mentor' });
    await Promise.all([p1.waitFor('room-joined'), p2.waitFor('room-joined')]);

    const thief: CharacterDefinition = {
      name: 'Lira Shade',
      highConcept: 'Shadow Thief Who Dances Through Clockwork',
      trouble: 'I Can Never Resist One More Score',
      aspects: ['Every Lock Is Just A Puzzle', 'Trust Comes After The Job', 'Sparks Owes Me — And I Collect'],
      personality: 'Cool, methodical, with dry humor. Plans three steps ahead but gets cocky on the final step.',
      backstory: 'Former Guild apprentice who left on bad terms. Knows the vault better than anyone outside — but Vex remembers her face.',
      skills: { Stealth: 4, Burglary: 3, Notice: 3, Athletics: 2, Deceive: 2, Investigate: 1, Fight: 1, Will: 0 },
      stunts: ['Ghost Walk: +2 to Stealth when moving through guarded areas', 'Trap Sense: +2 to Notice when detecting mechanical traps'],
    };

    const face: CharacterDefinition = {
      name: 'Dorian Ashmore',
      highConcept: 'Silver-Tongued Aristocrat With A Secret Gambling Debt',
      trouble: 'My Charm Is A Crutch — I Panic When It Fails',
      aspects: ['I Know Everyone Worth Knowing', 'The Gala Is My Natural Habitat', 'Lady Ashworth Suspects Me'],
      personality: 'Effortlessly charismatic, quick wit, hides genuine anxiety behind a perfect smile. Needs to be liked.',
      backstory: 'Born into wealth, gambled most of it away. Took this job to clear a debt that would ruin his family name. The gala guests know him — some trust him, some want him arrested.',
      skills: { Rapport: 4, Deceive: 3, Contacts: 3, Empathy: 2, Notice: 2, Will: 1, Athletics: 1, Stealth: 0 },
      stunts: ['Life of the Party: +2 to Rapport when socializing at formal events', 'Read the Room: +2 to Empathy when assessing group mood'],
    };

    for (const [playerWs, playerQ, def, label] of [[p1Ws, p1, thief, 'thief'], [p2Ws, p2, face, 'face']] as const) {
      let approved = false;
      let charId = '';
      for (let attempt = 0; attempt < 3 && !approved; attempt++) {
        sendMsg(playerWs, { type: 'submit-character', definition: def });
        const valMsg = await playerQ.waitFor('character-validated', 90_000);
        if (valMsg.type === 'character-validated' && (valMsg as any).approved) {
          charId = (valMsg as any).characterId;
          approved = true;
          console.log(`[vault] ${label} AI-approved: ${charId}`);
        } else {
          console.log(`[vault] ${label} validation attempt ${attempt + 1} failed`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!approved) {
        findings.push(`BUG: ${label} never approved after 3 attempts`);
        return;
      }
      await host.waitFor('negotiation-opened', 30_000);
      await host.waitFor('negotiation-message', 90_000);
      sendMsg(hostWs, { type: 'host-approve-character', characterId: charId });
      console.log(`[vault] Host approved ${label}`);
      await new Promise(r => setTimeout(r, 1000));
    }

    sendMsg(hostWs, { type: 'start-game' });
    const startMsg = await p1.waitFor('phase-change', 10_000);
    expect(startMsg.type === 'phase-change' && (startMsg as any).phase).toBe('playing');
    console.log('[vault] Game started');

    const narrations: string[] = [];
    const actionsTaken: Array<{ char: string; action: string; turn: number; skill?: string }> = [];
    const whispersSent: Array<{ char: string; whisper: string; style: PlayerStyle; turn: number }> = [];
    const trustTrajectory: Array<{ char: string; trust: number; turn: number }> = [];
    const locations: string[] = [];
    const inventedLocations: string[] = [];
    const innerThoughts: Array<{ char: string; thought: string; turn: number }> = [];
    const sceneTransitions: Array<{ scene: number; round: number }> = [];
    const compelMoments: Array<{ turn: number; text: string }> = [];
    const charInteractions: Array<{ turn: number; actor: string; target: string; action: string }> = [];
    let sceneCount = 0;
    let turnCount = 0;
    let followedCount = 0;
    let ignoredCount = 0;
    let partialCount = 0;
    const npcMentions: Record<string, number> = {};

    const TARGET_TURNS = 35;

    const charStyles: Record<string, PlayerStyle> = {
      'Lira Shade': 'strategist',
      'Dorian Ashmore': 'mentor',
    };

    const gameState: GameState = {
      round: 0,
      sceneCount: 0,
      narrations: [],
      actions: [],
      locations: [],
      characterNames: ['Lira Shade', 'Dorian Ashmore'],
    };

    const SKILL_KEYWORDS: Record<string, string[]> = {
      Stealth: ['sneak', 'creep', 'slip', 'shadow', 'hide', 'crouch', 'silent', 'quietly', 'stealthily'],
      Burglary: ['pick', 'lock', 'disarm', 'trap', 'crack', 'bypass', 'unlock', 'mechanism', 'safe'],
      Fight: ['attack', 'strike', 'punch', 'kick', 'swing', 'slash', 'fight', 'charge', 'tackle', 'block'],
      Athletics: ['climb', 'jump', 'run', 'sprint', 'leap', 'dodge', 'vault', 'dash', 'swing', 'balance'],
      Notice: ['scan', 'watch', 'observe', 'look', 'listen', 'search', 'inspect', 'examine', 'spot', 'peer'],
      Investigate: ['investigate', 'clue', 'deduce', 'analyze', 'study', 'research', 'blueprint', 'pattern'],
      Rapport: ['talk', 'ask', 'persuade', 'charm', 'befriend', 'negotiate', 'convince', 'compliment', 'smile'],
      Deceive: ['lie', 'bluff', 'trick', 'disguise', 'pretend', 'feign', 'mislead', 'misdirect', 'cover story'],
      Empathy: ['read', 'sense', 'feel', 'intuit', 'understand', 'gauge', 'assess mood'],
      Contacts: ['contact', 'know someone', 'favor', 'connection', 'introduce', 'network', 'arrange'],
      Provoke: ['taunt', 'intimidate', 'threaten', 'provoke', 'challenge', 'confront', 'demand'],
      Will: ['resist', 'endure', 'concentrate', 'focus', 'steel', 'brace'],
    };

    function detectSkill(action: string): string | null {
      const lower = action.toLowerCase();
      for (const [skill, keywords] of Object.entries(SKILL_KEYWORDS)) {
        if (keywords.some(kw => lower.includes(kw))) return skill;
      }
      return null;
    }

    function countNpcMentions(text: string): void {
      for (const npc of VAULT_NPCS) {
        const searchName = npc.split(' ').pop()!;
        if (text.toLowerCase().includes(searchName.toLowerCase())) {
          npcMentions[npc] = (npcMentions[npc] ?? 0) + 1;
        }
      }
    }

    function detectCharInteraction(actor: string, action: string, turn: number): void {
      const otherChars = gameState.characterNames.filter(n => n !== actor);
      for (const other of otherChars) {
        const firstName = other.split(' ')[0]!;
        const lastName = other.split(' ').pop()!;
        if (action.toLowerCase().includes(firstName.toLowerCase()) || action.toLowerCase().includes(lastName.toLowerCase())) {
          charInteractions.push({ turn, actor, target: other, action: action.slice(0, 80) });
        }
      }
    }

    const COMPEL_PATTERNS = [
      /old habits/i, /can't resist/i, /tempt/i, /drawn to/i, /weakness/i,
      /trouble/i, /compel/i, /fate point/i, /one more score/i,
      /charm.*fail/i, /panic/i, /gambling/i, /debt/i, /cocky/i,
    ];

    function detectCompel(text: string, turn: number): void {
      if (COMPEL_PATTERNS.some(p => p.test(text))) {
        compelMoments.push({ turn, text: text.slice(0, 100) });
      }
    }

    let gameEnded = false;
    for (let round = 1; round <= TARGET_TURNS && !gameEnded; round++) {
      gameState.round = round;

      try {
        const narMsg = await host.waitForAny(['narration', 'phase-change'], 180_000);
        if (narMsg.type === 'phase-change') {
          if ((narMsg as any).phase === 'ended') { console.log(`[vault] Game ended at round ${round}`); gameEnded = true; break; }
          continue;
        }
        narrations.push(narMsg.text);
        gameState.narrations.push(narMsg.text);
        countNpcMentions(narMsg.text);
        detectCompel(narMsg.text, round);

        if ((narMsg as any).locationName) {
          const loc = (narMsg as any).locationName;
          locations.push(loc);
          gameState.locations.push(loc);
          if (!VAULT_LOCATIONS.some(vl => vl.toLowerCase() === loc.toLowerCase())) {
            inventedLocations.push(loc);
            console.log(`[vault] INVENTED LOCATION: "${loc}"`);
          }
        }
        turnCount = round;

        const next = await host.waitForAny(['action-proposals', 'scene-end', 'phase-change'], 120_000);
        if (next.type === 'scene-end') {
          sceneCount++;
          gameState.sceneCount = sceneCount;
          sceneTransitions.push({ scene: sceneCount, round });
          console.log(`[vault] Scene ${sceneCount} ended at round ${round}`);
          continue;
        }
        if (next.type === 'phase-change') { if ((next as any).phase === 'ended') { gameEnded = true; break; } continue; }
        if (next.type !== 'action-proposals') continue;

        let currentProposals: ServerMessage | null = next;
        for (let charIdx = 0; charIdx < 2 && currentProposals; charIdx++) {
          const charName = (currentProposals as any).characterName as string;
          const trust = (currentProposals as any).whisperTrust as number;
          if (trust !== undefined) trustTrajectory.push({ char: charName, trust, turn: round });

          await host.waitFor('whisper-prompt', 60_000);

          const style = charStyles[charName] ?? 'mentor';
          const lastAction = actionsTaken.filter(a => a.char === charName).slice(-1)[0]?.action;
          const whisper = generateWhisper(style, charName, gameState, narMsg.text, lastAction);

          sendMsg(hostWs, { type: 'whisper', text: whisper });
          whispersSent.push({ char: charName, whisper, style, turn: round });
          console.log(`[vault] R${round} [${style}] -> ${charName.split(' ')[0]}: "${whisper.slice(0, 60)}"`);

          const actionMsg = await host.waitFor('action-taken', 120_000);
          if (actionMsg.type === 'action-taken') {
            const action = (actionMsg as any).action as string;
            const skill = detectSkill(action);
            actionsTaken.push({ char: (actionMsg as any).characterName, action, turn: round, skill: skill ?? undefined });
            gameState.actions.push({ char: (actionMsg as any).characterName, action });
            countNpcMentions(action);
            detectCharInteraction((actionMsg as any).characterName, action, round);
            detectCompel(action, round);

            const influence = (actionMsg as any).whisperInfluence as string;
            if (influence === 'followed') followedCount++;
            else if (influence === 'ignored') ignoredCount++;
            else partialCount++;

            const thought = (actionMsg as any).innerThought as string | undefined;
            if (thought) {
              innerThoughts.push({ char: (actionMsg as any).characterName, thought, turn: round });
            }
          }

          const resMsg = await host.waitForAny(['narration', 'resolution', 'scene-end', 'phase-change'], 120_000);
          if (resMsg.type === 'narration' || resMsg.type === 'resolution') {
            narrations.push(resMsg.text ?? '');
            gameState.narrations.push(resMsg.text ?? '');
            countNpcMentions(resMsg.text ?? '');
            detectCompel(resMsg.text ?? '', round);
          }
          if (resMsg.type === 'scene-end') {
            sceneCount++;
            gameState.sceneCount = sceneCount;
            sceneTransitions.push({ scene: sceneCount, round });
            console.log(`[vault] Scene ${sceneCount} ended at round ${round}`);
            currentProposals = null;
            break;
          }
          if (resMsg.type === 'phase-change') {
            if ((resMsg as any).phase === 'ended') { gameEnded = true; }
            currentProposals = null;
            break;
          }

          if (charIdx < 1) {
            const peek = await host.waitForAny(['action-proposals', 'narration', 'scene-end', 'phase-change'], 90_000).catch(() => null);
            if (peek?.type === 'action-proposals') {
              currentProposals = peek;
            } else {
              currentProposals = null;
            }
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
          const skillsUsed = new Set(actionsTaken.filter(a => a.skill).map(a => a.skill));
          console.log(`[vault] === CHECKPOINT R${round} === scenes=${sceneCount}, locs=${new Set(locations).size}, skills=${skillsUsed.size}, npcs=${Object.keys(npcMentions).length}, trust=[${trustSummary}], follow/ignore/partial=${followedCount}/${ignoredCount}/${partialCount}`);
        }
      } catch (e) {
        findings.push(`Round ${round}: ${(e as Error).message}`);
        console.error(`[vault] Round ${round} error:`, (e as Error).message);
        if (round < 3) throw e;
      }
    }

    // === ANALYSIS ===
    console.log(`\n[vault] ==========================================`);
    console.log(`[vault] QUALITY PLAYTEST REPORT: Clockwork Vault`);
    console.log(`[vault] ==========================================`);

    // 1. Skill variety
    const skillsByChar: Record<string, Set<string>> = {};
    for (const a of actionsTaken) {
      if (!a.skill) continue;
      if (!skillsByChar[a.char]) skillsByChar[a.char] = new Set();
      skillsByChar[a.char]!.add(a.skill);
    }
    console.log(`\n[vault] SKILL VARIETY:`);
    for (const [char, skills] of Object.entries(skillsByChar)) {
      const label = skills.size >= 3 ? 'PASS' : 'FAIL';
      console.log(`[vault]   ${char}: ${skills.size} unique [${label}] — ${[...skills].join(', ')}`);
    }

    // 2. Trust divergence
    const trustByChar: Record<string, Array<{ trust: number; turn: number }>> = {};
    for (const t of trustTrajectory) {
      if (!trustByChar[t.char]) trustByChar[t.char] = [];
      trustByChar[t.char]!.push({ trust: t.trust, turn: t.turn });
    }
    console.log(`\n[vault] TRUST TRAJECTORY:`);
    const finalTrusts: number[] = [];
    for (const [char, points] of Object.entries(trustByChar)) {
      const first = points[0]?.trust ?? 0;
      const last = points[points.length - 1]?.trust ?? 0;
      finalTrusts.push(last);
      const range = points.map(p => p.trust);
      console.log(`[vault]   ${char}: ${first.toFixed(2)} -> ${last.toFixed(2)} (delta ${(last - first).toFixed(3)}, range ${Math.min(...range).toFixed(2)}-${Math.max(...range).toFixed(2)})`);
    }
    const trustDivergence = finalTrusts.length >= 2 ? Math.abs(finalTrusts[0]! - finalTrusts[1]!) : 0;
    console.log(`[vault]   Trust divergence between chars: ${trustDivergence.toFixed(3)} ${trustDivergence >= 0.05 ? '[PASS]' : '[WEAK]'}`);

    // 3. Location coverage
    const uniqueLocs = [...new Set(locations)];
    const vaultLocsVisited = uniqueLocs.filter(l => VAULT_LOCATIONS.some(vl => vl.toLowerCase() === l.toLowerCase()));
    console.log(`\n[vault] LOCATIONS: ${vaultLocsVisited.length}/${VAULT_LOCATIONS.length} scenario locations visited [${vaultLocsVisited.length >= 3 ? 'PASS' : 'FAIL'}]`);
    console.log(`[vault]   Visited: ${uniqueLocs.join(', ')}`);
    if (inventedLocations.length > 0) console.log(`[vault]   INVENTED: ${inventedLocations.join(', ')}`);
    const unvisited = VAULT_LOCATIONS.filter(vl => !uniqueLocs.some(ul => ul.toLowerCase() === vl.toLowerCase()));
    if (unvisited.length > 0) console.log(`[vault]   Unvisited: ${unvisited.join(', ')}`);

    // 4. NPC engagement
    console.log(`\n[vault] NPC ENGAGEMENT [${Object.keys(npcMentions).length >= 3 ? 'PASS' : 'FAIL'}]:`);
    for (const [npc, count] of Object.entries(npcMentions).sort((a, b) => b[1] - a[1])) {
      console.log(`[vault]   ${npc}: ${count} mentions`);
    }
    const unmentionedNpcs = VAULT_NPCS.filter(n => !npcMentions[n]);
    if (unmentionedNpcs.length > 0) console.log(`[vault]   Never mentioned: ${unmentionedNpcs.join(', ')}`);

    // 5. Scene pacing
    console.log(`\n[vault] SCENE PACING: ${sceneCount} scenes in ${turnCount} turns [${sceneCount >= 3 ? 'PASS' : 'FAIL'}]`);
    for (const s of sceneTransitions) {
      console.log(`[vault]   Scene ${s.scene} ended at round ${s.round}`);
    }
    if (turnCount > 0) {
      console.log(`[vault]   Avg rounds per scene: ${(turnCount / Math.max(sceneCount, 1)).toFixed(1)}`);
    }

    // 6. Compel detection
    console.log(`\n[vault] COMPEL/TROUBLE MOMENTS: ${compelMoments.length} detected`);
    compelMoments.slice(0, 5).forEach(c => console.log(`[vault]   R${c.turn}: "${c.text}"`));

    // 7. Character interaction
    console.log(`\n[vault] CHARACTER INTERACTIONS: ${charInteractions.length} [${charInteractions.length >= 2 ? 'PASS' : 'FAIL'}]`);
    charInteractions.slice(0, 5).forEach(ci => console.log(`[vault]   R${ci.turn} ${ci.actor.split(' ')[0]} -> ${ci.target.split(' ')[0]}: "${ci.action}"`));

    // 8. Whisper influence
    console.log(`\n[vault] WHISPER INFLUENCE:`);
    console.log(`[vault]   Followed: ${followedCount}, Ignored: ${ignoredCount}, Partial: ${partialCount}`);
    const strategistWhispers = whispersSent.filter(w => w.style === 'strategist').length;
    const mentorWhispers = whispersSent.filter(w => w.style === 'mentor').length;
    console.log(`[vault]   Strategist whispers: ${strategistWhispers}, Mentor whispers: ${mentorWhispers}`);

    // 9. Issues
    if (findings.length > 0) {
      console.log(`\n[vault] ISSUES (${findings.length}):`);
      findings.forEach(f => console.log(`[vault]   - ${f}`));
    }

    console.log(`\n[vault] ==========================================\n`);

    // Assertions
    expect(turnCount).toBeGreaterThanOrEqual(5);
    expect(sceneCount).toBeGreaterThanOrEqual(1);
    expect(new Set(locations).size).toBeGreaterThanOrEqual(2);
    expect(new Set(actionsTaken.map(a => a.char)).size).toBe(2);

  }, 2_400_000);
});
