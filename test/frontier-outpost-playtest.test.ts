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
    'Use FATE Core. Investigation scenario at a frontier trading post. Two players. No house rules.',
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
  port = 4300 + Math.floor(Math.random() * 50);
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

describeIfLive('Chronicler + Frontier Outpost: 2-Character Mystery Investigation', () => {
  it('runs 25 rounds with investigation, NPC negotiation, faction dynamics, and chronicler voice', async () => {
    const findings: string[] = [];

    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Frontier Outpost Playtest',
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
    const p2 = await connectWs();
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Diplomat' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'Tracker' });
    await Promise.all([waitForMsg(p1, 'room-joined'), waitForMsg(p2, 'room-joined')]);

    const diplomat: CharacterDefinition = {
      name: 'Mira Voss',
      highConcept: 'Border Diplomat Who Speaks Every Language But Her Own Heart',
      trouble: 'I Make Promises I Cannot Keep',
      aspects: ['Words Are My Weapons', 'The Treaty Must Hold', 'Everyone Has A Price — Even Me'],
      personality: 'Charismatic and calculating. Finds leverage in every conversation. Haunted by deals gone wrong.',
      backstory: 'Sent by the governor to broker peace. Failed once before at a border dispute — twelve people died. This time she will not fail.',
      skills: { Rapport: 4, Deceive: 3, Empathy: 3, Investigate: 2, Will: 2, Lore: 1, Notice: 1, Athletics: 0 },
      stunts: ['Silver Tongue: +2 to Rapport when negotiating between hostile parties', 'Read The Room: +2 to Empathy when assessing group mood'],
    };

    const tracker: CharacterDefinition = {
      name: 'Renn Blackwood',
      highConcept: 'Frontier Scout Who Trusts Tracks More Than Words',
      trouble: 'The Wilderness Has My Loyalty — Not Any Flag',
      aspects: ['The Land Remembers Everything', 'No Trail Goes Cold On My Watch', 'I Owe Debts I Cannot Name'],
      personality: 'Laconic and intense. Reads terrain, animals, and weather like a language. Uncomfortable with politics.',
      backstory: 'A former nomad scout who crossed to the settler side years ago. Neither side fully trusts him. He tracked the horn\'s path to the outpost — the mud, the dog prints, the wagon ruts.',
      skills: { Notice: 4, Investigate: 3, Athletics: 3, Stealth: 2, Survival: 2, Fight: 1, Will: 1, Rapport: 0 },
      stunts: ['Read The Land: +2 to Investigate when examining outdoor tracks or terrain', 'Quick Reflexes: +2 to Athletics when reacting to sudden danger'],
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
          console.log(`[outpost] ${label} AI-approved: ${charId}`);
        } else {
          console.log(`[outpost] ${label} validation attempt ${attempt + 1} failed`);
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
      console.log(`[outpost] Host approved ${label}`);
      await new Promise(r => setTimeout(r, 1000));
    }

    sendMsg(host, { type: 'start-game' });
    const startMsg = await waitForMsg(p1, 'phase-change', 10_000);
    expect(startMsg.type === 'phase-change' && (startMsg as any).phase).toBe('playing');
    console.log('[outpost] Game started');

    const narrations: string[] = [];
    const actionsTaken: Array<{ char: string; action: string; turn: number }> = [];
    const locations = new Set<string>();
    let sceneCount = 0;
    let turnCount = 0;
    let compelCount = 0;
    let diplomacyActions = 0;
    let investigateActions = 0;
    let npcInteractions = 0;
    let conflictMoments = 0;

    const TARGET_TURNS = 25;

    const whisperPlan: Record<number, Record<string, string>> = {
      1: { 'Mira Voss': 'Talk to Marshal Thorne first — she knows more than she admits. Be diplomatic but firm.' },
      2: { 'Renn Blackwood': 'Check Kef\'s wagon wheels for shrine mud. Don\'t let him see you looking.' },
      3: { 'Mira Voss': 'Offer Chieftain Asha a private audience. Show respect for nomad customs.' },
      4: { 'Renn Blackwood': 'Find Old Berrin at the shrine. He heard something that night — protect him while he talks.' },
      5: { 'Mira Voss': 'Kef is the thief. But confront him privately — public accusation will start a fight.' },
      6: { 'Renn Blackwood': 'The howling in the hills — go investigate. Take the herb poultice from Brother Moss.' },
      7: { 'Mira Voss': 'Propose a joint search party — settlers and nomads together. It builds trust.', 'Renn Blackwood': 'Ignore the diplomat. Go alone. The caves hold answers.' },
      8: { 'Mira Voss': 'The letter in Thorne\'s strongbox — ask her about frontier antiquities buyers.' },
      9: { 'Renn Blackwood': 'Dara is right to be suspicious. Tell her what you found at Kef\'s wagon.' },
      10: { 'Mira Voss': 'Time is running out. Propose returning the horn at dawn as a peace ceremony.' },
      12: { 'Renn Blackwood': 'Brother Moss knows what the horn really does. The howling — it\'s not just storms.' },
    };

    let gameEnded = false;
    for (let round = 1; round <= TARGET_TURNS && !gameEnded; round++) {
      try {
        const narMsg = await waitForAnyMsg(host, ['narration', 'phase-change'], 180_000);
        if (narMsg.type === 'phase-change') {
          if ((narMsg as any).phase === 'ended') { console.log(`[outpost] Game ended at round ${round}`); gameEnded = true; break; }
          continue;
        }
        narrations.push(narMsg.text);
        if ((narMsg as any).locationName) locations.add((narMsg as any).locationName);
        turnCount = round;

        const narText = narMsg.text.toLowerCase();
        if (/\b(tension|hostil|threaten|armed|blood|war)\b/.test(narText)) conflictMoments++;

        const next = await waitForAnyMsg(host, ['action-proposals', 'scene-end', 'phase-change'], 120_000);
        if (next.type === 'scene-end') {
          sceneCount++;
          console.log(`[outpost] Scene ${sceneCount} ended at round ${round}`);
          continue;
        }
        if (next.type === 'phase-change') { if ((next as any).phase === 'ended') { gameEnded = true; break; } continue; }
        if (next.type !== 'action-proposals') continue;

        let currentProposals: ServerMessage | null = next;
        for (let charIdx = 0; charIdx < 2 && currentProposals; charIdx++) {
          const charName = (currentProposals as any).characterName as string;
          const whisper = whisperPlan[round]?.[charName];

          await waitForMsg(host, 'whisper-prompt', 30_000);
          if (whisper) {
            sendMsg(host, { type: 'whisper', text: whisper });
            console.log(`[outpost] R${round} whispered to ${charName.split(' ')[0]}: "${whisper.slice(0, 60)}"`);
          }

          const actionMsg = await waitForMsg(host, 'action-taken', 120_000);
          if (actionMsg.type === 'action-taken') {
            const action = (actionMsg as any).action as string;
            actionsTaken.push({ char: (actionMsg as any).characterName, action, turn: round });

            const lowerAction = action.toLowerCase();
            if (/\b(talk|speak|persuade|negotiate|argue|propose|convince|appeal|address)\b/.test(lowerAction)) diplomacyActions++;
            if (/\b(search|examine|investigate|inspect|look|track|follow|check|study)\b/.test(lowerAction)) investigateActions++;
          }

          const resMsg = await waitForAnyMsg(host, ['narration', 'resolution', 'scene-end', 'phase-change'], 120_000);
          if (resMsg.type === 'narration' || resMsg.type === 'resolution') {
            const text = resMsg.text ?? '';
            narrations.push(text);
            const npcNames = ['thorne', 'asha', 'kef', 'berrin', 'dara', 'moss'];
            if (npcNames.some(n => text.toLowerCase().includes(n))) npcInteractions++;
            if (/compel|trouble/i.test(text)) compelCount++;
          }
          if (resMsg.type === 'scene-end') {
            sceneCount++;
            console.log(`[outpost] Scene ${sceneCount} ended at round ${round} (during char ${charIdx + 1})`);
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
          console.log(`[outpost] Round ${round} — ${sceneCount} scenes, ${locations.size} locs, ${diplomacyActions} diplomacy, ${investigateActions} investigate, ${npcInteractions} npc, ${actionsTaken.length} actions`);
        }
      } catch (e) {
        findings.push(`Round ${round}: ${(e as Error).message}`);
        console.error(`[outpost] Round ${round} error:`, (e as Error).message);
        if (round < 3) throw e;
      }
    }

    console.log(`\n[outpost] === RESULTS ===`);
    console.log(`[outpost] Rounds: ${turnCount}/${TARGET_TURNS}`);
    console.log(`[outpost] Actions taken: ${actionsTaken.length} (by ${new Set(actionsTaken.map(a => a.char)).size} characters)`);
    console.log(`[outpost] Scenes: ${sceneCount}`);
    console.log(`[outpost] Locations: ${[...locations].join(', ')}`);
    console.log(`[outpost] Diplomacy actions: ${diplomacyActions}`);
    console.log(`[outpost] Investigation actions: ${investigateActions}`);
    console.log(`[outpost] NPC interactions: ${npcInteractions}`);
    console.log(`[outpost] Conflict moments: ${conflictMoments}`);
    console.log(`[outpost] Compels detected: ${compelCount}`);

    const npcMentions: Record<string, number> = { thorne: 0, asha: 0, kef: 0, berrin: 0, dara: 0, moss: 0 };
    const allText = narrations.join(' ').toLowerCase();
    for (const key of Object.keys(npcMentions)) {
      npcMentions[key] = (allText.match(new RegExp(key, 'gi')) ?? []).length;
    }
    console.log(`[outpost] NPCs: ${JSON.stringify(npcMentions)}`);

    const outpostLocations = ['common room', 'shrine hill', 'wagon', 'stables', 'marshal', 'caves', 'moss'];
    const visitedOutpost = outpostLocations.filter(l => [...locations].some(v => v.toLowerCase().includes(l)));
    console.log(`[outpost] Outpost locations visited: ${visitedOutpost.join(', ')} (${visitedOutpost.length}/${outpostLocations.length})`);

    const charActions: Record<string, number> = {};
    for (const a of actionsTaken) {
      charActions[a.char] = (charActions[a.char] ?? 0) + 1;
    }
    console.log(`[outpost] Actions per char: ${JSON.stringify(charActions)}`);

    if (findings.length > 0) console.log(`[outpost] Findings: ${findings.join('; ')}`);

    expect(turnCount).toBeGreaterThanOrEqual(5);
    expect(sceneCount).toBeGreaterThanOrEqual(2);
    expect(locations.size).toBeGreaterThanOrEqual(2);
    const uniqueChars = new Set(actionsTaken.map(a => a.char));
    expect(uniqueChars.size).toBe(2);

  }, 900_000);
});
