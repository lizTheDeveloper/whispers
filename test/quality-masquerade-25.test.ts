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
    'Use FATE Core. Mystery intrigue at a haunted masquerade ball. Two players. No house rules.',
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

const MASQUERADE_LOCATIONS = [
  'The Grand Ballroom',
  'The Wine Cellar',
  "The Duchess's Study",
  'The Garden Terrace',
  "The Servants' Corridor",
  'The Music Gallery',
];

describeIfLive('Quality Playtest: Haunted Masquerade 25-turn', () => {
  it('runs 25 rounds evaluating story quality, trust, skill variety, and location fidelity', async () => {
    const findings: string[] = [];

    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Quality Masquerade Playtest',
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
    const p2 = await connectWs();
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Mentor' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'Chaos' });
    await Promise.all([waitForMsg(p1, 'room-joined'), waitForMsg(p2, 'room-joined')]);

    const socialite: CharacterDefinition = {
      name: 'Isolde Ravenna',
      highConcept: 'Socialite Spy With A Mask For Every Occasion',
      trouble: 'My Loyalty Is For Sale To The Highest Bidder',
      aspects: ['The Court Remembers My Favors', 'Nobody Suspects The Pretty One', 'Secrets Are My Currency'],
      personality: 'Charming, razor-sharp observation behind a vapid smile. Collects secrets like jewelry.',
      backstory: 'Born into minor nobility, clawed her way up through intelligence work. Came tonight because someone is threatening the network she built.',
      skills: { Deceive: 4, Rapport: 3, Notice: 3, Empathy: 2, Stealth: 2, Investigate: 1, Athletics: 1, Will: 0 },
      stunts: ['Perfect Cover: +2 to Deceive when maintaining a false identity', 'Social Web: +2 to Rapport when leveraging existing connections'],
    };

    const duelist: CharacterDefinition = {
      name: 'Captain Aldric Thane',
      highConcept: 'Disgraced Military Captain Seeking Redemption',
      trouble: 'I Solve Every Problem With Violence First',
      aspects: ['My Honor Is All I Have Left', 'The Duchess Saved My Life Once', 'I Know A Traitor When I See One'],
      personality: 'Blunt, hot-tempered, fiercely loyal. Terrible at politics but reads body language well.',
      backstory: 'Stripped of command for refusing an unjust order. The Duchess intervened. He came tonight to repay that debt — and someone wants the Duchess dead.',
      skills: { Fight: 4, Athletics: 3, Notice: 3, Provoke: 2, Will: 2, Empathy: 1, Investigate: 1, Stealth: 0 },
      stunts: ['Battle Instincts: +2 to Notice when assessing physical threats', 'Intimidating Presence: +2 to Provoke in close quarters'],
    };

    for (const [player, def, label] of [[p1, socialite, 'socialite'], [p2, duelist, 'duelist']] as const) {
      let approved = false;
      let charId = '';
      for (let attempt = 0; attempt < 3 && !approved; attempt++) {
        const valPromise = waitForMsg(player, 'character-validated', 90_000);
        sendMsg(player, { type: 'submit-character', definition: def });
        const valMsg = await valPromise;
        if (valMsg.type === 'character-validated' && (valMsg as any).approved) {
          charId = (valMsg as any).characterId;
          approved = true;
          console.log(`[quality] ${label} AI-approved: ${charId}`);
        } else {
          console.log(`[quality] ${label} validation attempt ${attempt + 1} failed`);
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
      console.log(`[quality] Host approved ${label}`);
      await new Promise(r => setTimeout(r, 1000));
    }

    sendMsg(host, { type: 'start-game' });
    const startMsg = await waitForMsg(p1, 'phase-change', 10_000);
    expect(startMsg.type === 'phase-change' && (startMsg as any).phase).toBe('playing');
    console.log('[quality] Game started');

    // Tracking data
    const narrations: string[] = [];
    const actionsTaken: Array<{ char: string; action: string; turn: number; skill?: string }> = [];
    const whispersSent: Array<{ char: string; whisper: string; style: PlayerStyle; turn: number }> = [];
    const trustTrajectory: Array<{ char: string; trust: number; turn: number }> = [];
    const locations: string[] = [];
    const inventedLocations: string[] = [];
    const innerThoughts: Array<{ char: string; thought: string; turn: number }> = [];
    const sceneTransitions: Array<{ scene: number; round: number; description: string }> = [];
    let sceneCount = 0;
    let turnCount = 0;
    let followedCount = 0;
    let ignoredCount = 0;
    let partialCount = 0;
    const npcMentions: Record<string, number> = {};

    const TARGET_TURNS = 25;

    const charStyles: Record<string, PlayerStyle> = {
      'Isolde Ravenna': 'mentor',
      'Captain Aldric Thane': 'chaos',
    };

    const gameState: GameState = {
      round: 0,
      sceneCount: 0,
      narrations: [],
      actions: [],
      locations: [],
      characterNames: ['Isolde Ravenna', 'Captain Aldric Thane'],
    };

    const SKILL_KEYWORDS: Record<string, string[]> = {
      Stealth: ['sneak', 'creep', 'slip', 'shadow', 'hide', 'crouch', 'silent', 'quietly'],
      Fight: ['attack', 'strike', 'punch', 'kick', 'swing', 'slash', 'fight', 'charge', 'tackle', 'block'],
      Athletics: ['climb', 'jump', 'run', 'sprint', 'leap', 'dodge', 'vault', 'dash'],
      Notice: ['scan', 'watch', 'observe', 'look', 'listen', 'search', 'inspect', 'examine', 'spot'],
      Investigate: ['investigate', 'clue', 'deduce', 'analyze', 'study', 'research'],
      Rapport: ['talk', 'ask', 'persuade', 'charm', 'befriend', 'negotiate', 'convince'],
      Deceive: ['lie', 'bluff', 'trick', 'disguise', 'pretend', 'feign', 'mislead'],
      Empathy: ['read', 'sense', 'feel', 'intuit', 'understand', 'gauge'],
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

    const scenarioNpcNames = ['Duchess Vaelora', 'Lord Cassius', 'Mira', 'The Phantom'];
    function countNpcMentions(text: string): void {
      for (const npc of scenarioNpcNames) {
        const searchName = npc === 'Mira' ? 'Mira' : npc.split(' ').pop()!;
        if (text.toLowerCase().includes(searchName.toLowerCase())) {
          npcMentions[npc] = (npcMentions[npc] ?? 0) + 1;
        }
      }
    }

    const GENERIC_THOUGHT_PATTERNS = [
      /^something (feels|is|seems|isn't|doesn't feel) (off|wrong|right)/i,
      /^i (need|should|must|have) to be careful/i,
      /^i (should|must|need to) (proceed|be) cautious/i,
      /^i (sense|feel) (something|danger|that something)/i,
      /^(this|something) (doesn't feel|isn't|seems) (right|wrong|off)/i,
      /^i have a bad feeling/i,
      /^i need to act now\.?$/i,
      /^i must tread carefully/i,
      /^(caution|careful|cautious|vigilant|wary)/i,
    ];

    let gameEnded = false;
    for (let round = 1; round <= TARGET_TURNS && !gameEnded; round++) {
      gameState.round = round;

      try {
        const narMsg = await waitForAnyMsg(host, ['narration', 'phase-change'], 180_000);
        if (narMsg.type === 'phase-change') {
          if ((narMsg as any).phase === 'ended') { console.log(`[quality] Game ended at round ${round}`); gameEnded = true; break; }
          continue;
        }
        narrations.push(narMsg.text);
        gameState.narrations.push(narMsg.text);
        countNpcMentions(narMsg.text);

        if ((narMsg as any).locationName) {
          const loc = (narMsg as any).locationName;
          locations.push(loc);
          gameState.locations.push(loc);
          if (!MASQUERADE_LOCATIONS.some(ml => ml.toLowerCase() === loc.toLowerCase())) {
            inventedLocations.push(loc);
            console.log(`[quality] ⚠ INVENTED LOCATION: "${loc}"`);
          }
        }
        turnCount = round;

        const next = await waitForAnyMsg(host, ['action-proposals', 'scene-end', 'phase-change'], 120_000);
        if (next.type === 'scene-end') {
          sceneCount++;
          gameState.sceneCount = sceneCount;
          const lastNarr = narrations[narrations.length - 1] ?? '';
          sceneTransitions.push({ scene: sceneCount, round, description: lastNarr.slice(0, 100) });
          console.log(`[quality] Scene ${sceneCount} ended at round ${round}`);
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
          console.log(`[quality] R${round} [${style}] → ${charName.split(' ')[0]}: "${whisper.slice(0, 60)}"`);

          const actionMsg = await waitForMsg(host, 'action-taken', 120_000);
          if (actionMsg.type === 'action-taken') {
            const action = (actionMsg as any).action as string;
            const skill = detectSkill(action);
            actionsTaken.push({ char: (actionMsg as any).characterName, action, turn: round, skill: skill ?? undefined });
            gameState.actions.push({ char: (actionMsg as any).characterName, action });
            countNpcMentions(action);

            const influence = (actionMsg as any).whisperInfluence as string;
            if (influence === 'followed') followedCount++;
            else if (influence === 'ignored') ignoredCount++;
            else partialCount++;

            const thought = (actionMsg as any).innerThought as string | undefined;
            if (thought) {
              innerThoughts.push({ char: (actionMsg as any).characterName, thought, turn: round });
              if (GENERIC_THOUGHT_PATTERNS.some(p => p.test(thought))) {
                findings.push(`R${round} ${charName.split(' ')[0]}: generic inner thought — "${thought.slice(0, 60)}"`);
              }
            }
          }

          const resMsg = await waitForAnyMsg(host, ['narration', 'resolution', 'scene-end', 'phase-change'], 120_000);
          if (resMsg.type === 'narration' || resMsg.type === 'resolution') {
            narrations.push(resMsg.text ?? '');
            gameState.narrations.push(resMsg.text ?? '');
            countNpcMentions(resMsg.text ?? '');
          }
          if (resMsg.type === 'scene-end') {
            sceneCount++;
            gameState.sceneCount = sceneCount;
            const lastNarr = narrations[narrations.length - 1] ?? '';
            sceneTransitions.push({ scene: sceneCount, round, description: lastNarr.slice(0, 100) });
            console.log(`[quality] Scene ${sceneCount} ended at round ${round}`);
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
          const skillsUsed = new Set(actionsTaken.filter(a => a.skill).map(a => a.skill));
          console.log(`[quality] === CHECKPOINT R${round} === scenes=${sceneCount}, locs=${new Set(locations).size}, skills=${skillsUsed.size}, trust=[${trustSummary}], follow/ignore/partial=${followedCount}/${ignoredCount}/${partialCount}`);
        }
      } catch (e) {
        findings.push(`Round ${round}: ${(e as Error).message}`);
        console.error(`[quality] Round ${round} error:`, (e as Error).message);
        if (round < 3) throw e;
      }
    }

    // === ANALYSIS ===
    console.log(`\n[quality] ==========================================`);
    console.log(`[quality] QUALITY PLAYTEST REPORT`);
    console.log(`[quality] ==========================================`);

    // 1. Location fidelity
    const uniqueLocs = [...new Set(locations)];
    console.log(`\n[quality] LOCATIONS: ${uniqueLocs.length} unique out of 6 scenario locations`);
    console.log(`[quality]   Visited: ${uniqueLocs.join(', ')}`);
    if (inventedLocations.length > 0) {
      console.log(`[quality]   ⚠ INVENTED: ${inventedLocations.join(', ')}`);
    } else {
      console.log(`[quality]   ✓ No invented locations`);
    }
    const unvisited = MASQUERADE_LOCATIONS.filter(ml => !uniqueLocs.some(ul => ul.toLowerCase() === ml.toLowerCase()));
    if (unvisited.length > 0) console.log(`[quality]   Unvisited: ${unvisited.join(', ')}`);

    // 2. Skill variety
    const skillsByChar: Record<string, Set<string>> = {};
    for (const a of actionsTaken) {
      if (!a.skill) continue;
      if (!skillsByChar[a.char]) skillsByChar[a.char] = new Set();
      skillsByChar[a.char]!.add(a.skill);
    }
    console.log(`\n[quality] SKILL VARIETY:`);
    for (const [char, skills] of Object.entries(skillsByChar)) {
      console.log(`[quality]   ${char}: ${skills.size} unique — ${[...skills].join(', ')}`);
    }

    // 3. Trust trajectory
    const trustByChar: Record<string, Array<{ trust: number; turn: number }>> = {};
    for (const t of trustTrajectory) {
      if (!trustByChar[t.char]) trustByChar[t.char] = [];
      trustByChar[t.char]!.push({ trust: t.trust, turn: t.turn });
    }
    console.log(`\n[quality] TRUST TRAJECTORY:`);
    for (const [char, points] of Object.entries(trustByChar)) {
      const at5 = points.find(p => p.turn >= 5)?.trust ?? 'n/a';
      const at10 = points.find(p => p.turn >= 10)?.trust ?? 'n/a';
      const at15 = points.find(p => p.turn >= 15)?.trust ?? 'n/a';
      const at20 = points.find(p => p.turn >= 20)?.trust ?? 'n/a';
      const at25 = points.find(p => p.turn >= 25)?.trust ?? 'n/a';
      const first = points[0]?.trust ?? 0;
      const last = points[points.length - 1]?.trust ?? 0;
      const range = points.map(p => p.trust);
      console.log(`[quality]   ${char}:`);
      console.log(`[quality]     Start=${first.toFixed(2)} End=${last.toFixed(2)} Delta=${(last - first).toFixed(3)}`);
      console.log(`[quality]     Min=${Math.min(...range).toFixed(2)} Max=${Math.max(...range).toFixed(2)} Range=${(Math.max(...range) - Math.min(...range)).toFixed(3)}`);
      console.log(`[quality]     At turns: 5=${typeof at5 === 'number' ? at5.toFixed(2) : at5} 10=${typeof at10 === 'number' ? at10.toFixed(2) : at10} 15=${typeof at15 === 'number' ? at15.toFixed(2) : at15} 20=${typeof at20 === 'number' ? at20.toFixed(2) : at20} 25=${typeof at25 === 'number' ? at25.toFixed(2) : at25}`);
    }

    // 4. Scene pacing
    console.log(`\n[quality] SCENE PACING: ${sceneCount} scenes in ${turnCount} turns`);
    for (const s of sceneTransitions) {
      console.log(`[quality]   Scene ${s.scene} ended at round ${s.round}: "${s.description.slice(0, 80)}..."`);
    }
    if (turnCount > 0) {
      console.log(`[quality]   Avg rounds per scene: ${(turnCount / Math.max(sceneCount, 1)).toFixed(1)}`);
    }

    // 5. NPC engagement
    console.log(`\n[quality] NPC MENTIONS (in narrations + actions):`);
    for (const [npc, count] of Object.entries(npcMentions).sort((a, b) => b[1] - a[1])) {
      console.log(`[quality]   ${npc}: ${count} mentions`);
    }
    const unmentionedNpcs = scenarioNpcNames.filter(n => !npcMentions[n]);
    if (unmentionedNpcs.length > 0) {
      console.log(`[quality]   ⚠ Never mentioned: ${unmentionedNpcs.join(', ')}`);
    }

    // 6. Inner thought quality
    const genericCount = innerThoughts.filter(t =>
      GENERIC_THOUGHT_PATTERNS.some(p => p.test(t.thought))
    ).length;
    const specificCount = innerThoughts.length - genericCount;
    console.log(`\n[quality] INNER THOUGHTS: ${innerThoughts.length} total, ${specificCount} specific (${genericCount} generic)`);
    if (genericCount > 0) {
      console.log(`[quality]   Generic examples:`);
      innerThoughts
        .filter(t => GENERIC_THOUGHT_PATTERNS.some(p => p.test(t.thought)))
        .slice(0, 3)
        .forEach(t => console.log(`[quality]     R${t.turn} ${t.char.split(' ')[0]}: "${t.thought.slice(0, 80)}"`));
    }

    // 7. Whisper influence
    console.log(`\n[quality] WHISPER INFLUENCE:`);
    console.log(`[quality]   Followed: ${followedCount}, Ignored: ${ignoredCount}, Partial: ${partialCount}`);
    const mentorWhispers = whispersSent.filter(w => w.style === 'mentor').length;
    const chaosWhispers = whispersSent.filter(w => w.style === 'chaos').length;
    console.log(`[quality]   Mentor whispers: ${mentorWhispers}, Chaos whispers: ${chaosWhispers}`);

    // 8. Issues
    if (findings.length > 0) {
      console.log(`\n[quality] ISSUES (${findings.length}):`);
      findings.forEach(f => console.log(`[quality]   - ${f}`));
    }

    console.log(`[quality] ==========================================\n`);

    // Write report
    const report = [
      `# Quality Playtest: Haunted Masquerade (25-turn)`,
      ``,
      `## Summary`,
      `- Turns completed: ${turnCount}/${TARGET_TURNS}`,
      `- Scenes completed: ${sceneCount}`,
      `- Game ended naturally: ${gameEnded}`,
      `- Unique locations visited: ${uniqueLocs.length}/6`,
      ``,
      `## Location Fidelity`,
      `Visited: ${uniqueLocs.join(', ')}`,
      inventedLocations.length > 0 ? `**INVENTED**: ${inventedLocations.join(', ')}` : 'No invented locations ✓',
      unvisited.length > 0 ? `Unvisited: ${unvisited.join(', ')}` : 'All locations visited ✓',
      ``,
      `## Skill Variety`,
      ...Object.entries(skillsByChar).map(([char, skills]) =>
        `- ${char}: ${skills.size} unique — ${[...skills].join(', ')}`
      ),
      ``,
      `## Trust Trajectory`,
      ...Object.entries(trustByChar).map(([char, points]) => {
        const first = points[0]?.trust ?? 0;
        const last = points[points.length - 1]?.trust ?? 0;
        const range = points.map(p => p.trust);
        return `- ${char}: ${first.toFixed(2)} → ${last.toFixed(2)} (delta ${(last - first).toFixed(3)}, range ${Math.min(...range).toFixed(2)}-${Math.max(...range).toFixed(2)})`;
      }),
      ``,
      `## Scene Pacing`,
      `- ${sceneCount} scenes in ${turnCount} turns (avg ${(turnCount / Math.max(sceneCount, 1)).toFixed(1)} rounds/scene)`,
      ...sceneTransitions.map(s => `- Scene ${s.scene} ended at round ${s.round}`),
      ``,
      `## NPC Engagement`,
      ...Object.entries(npcMentions).sort((a, b) => b[1] - a[1]).map(([npc, count]) => `- ${npc}: ${count} mentions`),
      unmentionedNpcs.length > 0 ? `**Never mentioned**: ${unmentionedNpcs.join(', ')}` : '',
      ``,
      `## Inner Thought Quality`,
      `- ${specificCount}/${innerThoughts.length} specific (${genericCount} generic)`,
      ``,
      `## Whisper Influence`,
      `- Followed: ${followedCount}, Ignored: ${ignoredCount}, Partial: ${partialCount}`,
      ``,
      `## Issues Found`,
      ...findings.map(f => `- ${f}`),
      findings.length === 0 ? 'No issues found ✓' : '',
      ``,
      `## Notable Story Moments`,
      ...narrations.slice(0, 3).map((n, i) => `- Scene ${i + 1}: "${n.slice(0, 120)}..."`),
      ``,
      `## Full Action Log`,
      ...actionsTaken.map(a => `- R${a.turn} ${a.char}: "${a.action.slice(0, 80)}" [${a.skill ?? 'unknown'}]`),
    ].join('\n');

    writeFileSync(
      '/private/tmp/claude-501/-Users-annhoward-src-multiverse-games/d35faae9-4c79-40ac-bb63-bcc19754f6eb/scratchpad/masquerade-25-report.md',
      report,
    );

    // Assertions
    expect(turnCount).toBeGreaterThanOrEqual(5);
    expect(sceneCount).toBeGreaterThanOrEqual(1);
    expect(new Set(locations).size).toBeGreaterThanOrEqual(2);
    expect(new Set(actionsTaken.map(a => a.char)).size).toBe(2);

  }, 600_000);
});
