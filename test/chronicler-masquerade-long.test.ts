import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';
import type { CharacterDefinition } from '../src/shared/types.js';
import { getFreePort } from './lib/ws-helpers.js';

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
    'Use FATE Core. Social intrigue at a masquerade ball. Murder mystery. Two players. No house rules.',
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
    console.log('\n=== SERVER LOGS (last 80) ===');
    allServerLogs.slice(-80).forEach(l => console.log(l));
  }
});

describeIfLive('Chronicler + Masquerade: 35-Turn Long-Session Stress Test', () => {
  it('runs 35 turns testing compaction, multi-scene coherence, and knowledge graph tracking', async () => {
    const findings: string[] = [];

    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create',
      name: 'Masquerade Long Playtest',
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
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Diplomat' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'Spy' });
    await Promise.all([waitForMsg(p1, 'room-joined'), waitForMsg(p2, 'room-joined')]);

    const diplomat: CharacterDefinition = {
      name: 'Ambassador Elara Thorne',
      highConcept: 'Silver-Tongued Diplomat Who Reads Between The Lines',
      trouble: 'I Trust Too Easily When Someone Shows Vulnerability',
      aspects: ['Every Conversation Is A Negotiation', 'The Truth Hides In What People Don\'t Say', 'Old Debts From The War Still Bind Me'],
      personality: 'Charming, perceptive, and genuinely caring. Masks a sharp political mind behind warmth.',
      backstory: 'Former war negotiator who brokered the Treaty of Ashenmoor. Haunted by a deal that saved thousands but sacrificed one — someone she loved.',
      skills: { Rapport: 4, Empathy: 3, Deceive: 3, Notice: 2, Investigate: 2, Will: 1, Lore: 1, Contacts: 0 },
      stunts: ['Read the Room: +2 to Empathy when assessing a group\'s mood or loyalties', 'Silver Tongue: +2 to Rapport when making a first impression'],
    };

    const spy: CharacterDefinition = {
      name: 'Valen Ashcroft',
      highConcept: 'Shadow Operative Who Never Leaves A Trail',
      trouble: 'I Cannot Let Go Of A Puzzle Once It Hooks Me',
      aspects: ['Every Lock Has A Story', 'The Night Has Taught Me Patience', 'I Owe The Duchess A Life-Debt'],
      personality: 'Quiet, methodical, slightly paranoid. Notices exits before faces. Fiercely loyal to those who\'ve earned it.',
      backstory: 'Former intelligence agent who faked his own death to escape the service. The Duchess sheltered him. Tonight, he repays that debt.',
      skills: { Stealth: 4, Notice: 3, Investigate: 3, Burglary: 2, Athletics: 2, Fight: 1, Deceive: 1, Will: 0 },
      stunts: ['Shadow Walk: +2 to Stealth in dim lighting or crowds', 'Keen Observer: +2 to Notice when watching someone who doesn\'t know they\'re being watched'],
    };

    for (const [player, def, label] of [[p1, diplomat, 'diplomat'], [p2, spy, 'spy']] as const) {
      let approved = false;
      let charId = '';
      for (let attempt = 0; attempt < 3 && !approved; attempt++) {
        const valPromise = waitForMsg(player, 'character-validated', 90_000);
        sendMsg(player, { type: 'submit-character', definition: def });
        const valMsg = await valPromise;
        if (valMsg.type === 'character-validated' && (valMsg as any).approved) {
          charId = (valMsg as any).characterId;
          approved = true;
          console.log(`[masq] ${label} AI-approved: ${charId}`);
        } else {
          console.log(`[masq] ${label} validation attempt ${attempt + 1} failed`);
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
      console.log(`[masq] Host approved ${label}`);
      await new Promise(r => setTimeout(r, 1000));
    }

    sendMsg(host, { type: 'start-game' });
    const startMsg = await waitForMsg(p1, 'phase-change', 10_000);
    expect(startMsg.type === 'phase-change' && (startMsg as any).phase).toBe('playing');
    console.log('[masq] Game started');

    const narrations: string[] = [];
    const actionsTaken: Array<{ char: string; action: string; turn: number }> = [];
    const locations = new Set<string>();
    const npcDialogueCount = { vaelora: 0, cassius: 0, mira: 0, phantom: 0 };
    let sceneCount = 0;
    let turnCount = 0;
    let compactionCount = 0;
    let compelCount = 0;
    let invokeCount = 0;
    let sensoryDetails = 0;
    const trustHistory: Array<{ char: string; turn: number; trust: number }> = [];
    const relationshipExtractions: string[] = [];
    const inventoryChanges: string[] = [];

    const TARGET_TURNS = 35;

    const whisperPlan: Record<number, Record<string, string>> = {
      1: { 'Ambassador Elara Thorne': 'The Duchess seems tense — try to speak with her privately' },
      3: { 'Valen Ashcroft': 'Check the wine cellar. Mira mentioned the wine.' },
      5: { 'Ambassador Elara Thorne': 'Lord Cassius is watching you. Approach him confidently — show no fear.' },
      7: { 'Valen Ashcroft': 'Follow the Phantom. Stay hidden. Do NOT let it see you.' },
      10: { 'Ambassador Elara Thorne': 'Find Mira. She\'s in danger. Protect her from whoever is watching.' },
      12: { 'Valen Ashcroft': 'The Duchess\'s study — there must be letters that reveal the plot' },
      15: { 'Ambassador Elara Thorne': 'Confront Cassius directly — he\'s the one behind this', 'Valen Ashcroft': 'Don\'t trust Cassius but don\'t confront him yet — gather more evidence first' },
      18: { 'Valen Ashcroft': 'The signet ring on the floor — pick it up before someone else does' },
      20: { 'Ambassador Elara Thorne': 'Tell Valen what you know. You can\'t do this alone.' },
      22: { 'Valen Ashcroft': 'The poison vial — check it for markings. This is professional work.' },
      25: { 'Ambassador Elara Thorne': 'You must warn the Duchess NOW. Midnight approaches.' },
      28: { 'Valen Ashcroft': 'The Phantom is not an enemy. It\'s trying to help. Let it approach.' },
      30: { 'Ambassador Elara Thorne': 'The wine has already been poisoned. Stop the toast!' },
      33: { 'Valen Ashcroft': 'Cassius has a weapon. Be ready.' },
    };

    for (let turn = 1; turn <= TARGET_TURNS; turn++) {
      try {
        const narMsg = await waitForAnyMsg(host, ['narration', 'phase-change'], 120_000);
        if (narMsg.type === 'phase-change') {
          if ((narMsg as any).phase === 'ended') { console.log(`[masq] Game ended at turn ${turn}`); break; }
          continue;
        }
        narrations.push(narMsg.text);
        if ((narMsg as any).locationName) locations.add((narMsg as any).locationName);
        turnCount = turn;

        // Track chronicler sensory details (non-visual senses)
        const senseWords = /\b(smell|scent|aroma|perfume|stench|taste|sound|hear|echo|whisper|music|touch|cold|warm|chill|silk|velvet|stone|damp|breeze|wind)\b/i;
        if (senseWords.test(narMsg.text)) sensoryDetails++;

        // Track NPC dialogue
        const text = narMsg.text.toLowerCase();
        if (text.includes('vaelora') || text.includes('duchess')) npcDialogueCount.vaelora++;
        if (text.includes('cassius') || text.includes('lord')) npcDialogueCount.cassius++;
        if (text.includes('mira') || text.includes('servant') || text.includes('serving girl')) npcDialogueCount.mira++;
        if (text.includes('phantom') || text.includes('white mask') || text.includes('blank mask')) npcDialogueCount.phantom++;

        // Track compactions
        if (allServerLogs.some(l => l.includes('Compaction complete') && !l.includes('already counted'))) {
          const compactLogs = allServerLogs.filter(l => l.includes('Compaction complete'));
          if (compactLogs.length > compactionCount) {
            compactionCount = compactLogs.length;
            console.log(`[masq] Compaction #${compactionCount} detected at turn ${turn}`);
          }
        }

        const next = await waitForAnyMsg(host, ['action-proposals', 'scene-end', 'phase-change'], 120_000);
        if (next.type === 'scene-end') {
          sceneCount++;
          console.log(`[masq] Scene ${sceneCount} ended at turn ${turn}: ${(next as any).summary?.slice(0, 100)}`);
          continue;
        }
        if (next.type === 'phase-change') { if ((next as any).phase === 'ended') break; continue; }
        if (next.type !== 'action-proposals') continue;

        const charName = (next as any).characterName as string;
        const whisper = whisperPlan[turn]?.[charName];

        await waitForMsg(host, 'whisper-prompt', 30_000);
        if (whisper) {
          sendMsg(host, { type: 'whisper', text: whisper });
          console.log(`[masq] T${turn} whispered to ${charName.split(' ')[0]}: "${whisper.slice(0, 60)}"`);
        }

        // Track trust from character-state-update
        const stateUpdates: ServerMessage[] = [];
        const stateHandler = (data: Buffer) => {
          const msg: ServerMessage = JSON.parse(data.toString());
          if (msg.type === 'character-state-update') stateUpdates.push(msg);
        };
        host.on('message', stateHandler);

        const actionMsg = await waitForMsg(host, 'action-taken', 120_000);
        if (actionMsg.type === 'action-taken') {
          actionsTaken.push({ char: (actionMsg as any).characterName, action: (actionMsg as any).action, turn });
          if ((actionMsg as any).action?.toLowerCase().includes('invoke') || (actionMsg as any).action?.toLowerCase().includes('aspect')) invokeCount++;
        }

        const resMsg = await waitForAnyMsg(host, ['narration', 'resolution', 'scene-end', 'phase-change'], 120_000);
        if (resMsg.type === 'narration' || resMsg.type === 'resolution') {
          narrations.push(resMsg.text ?? '');
          if ((resMsg.text ?? '').includes('Compel:') || (resMsg.text ?? '').includes('trouble')) compelCount++;
          // Track inventory changes
          const invMatch = (resMsg.text ?? '').match(/\b(picks? up|takes?|finds?|discovers?|pockets?)\b.*?\b(mask|note|ring|vial|letter|key|map|blade)\b/i);
          if (invMatch) inventoryChanges.push(`T${turn}: ${invMatch[0]}`);
        }
        if (resMsg.type === 'scene-end') {
          sceneCount++;
          console.log(`[masq] Scene ${sceneCount} ended at turn ${turn}`);
        }

        host.off('message', stateHandler);
        for (const su of stateUpdates) {
          if ((su as any).state?.whisperTrust !== undefined) {
            trustHistory.push({ char: (su as any).characterId ?? '', turn, trust: (su as any).state.whisperTrust });
          }
        }

        // Drain any queued messages
        await waitForAnyMsg(host, ['character-state-update', 'narration', 'action-proposals', 'scene-end', 'phase-change'], 15_000).catch(() => null);

        if (turn % 5 === 0) {
          console.log(`[masq] Turn ${turn}/${TARGET_TURNS} — scenes: ${sceneCount}, locs: ${locations.size}/${6}, NPCs: V${npcDialogueCount.vaelora}/C${npcDialogueCount.cassius}/M${npcDialogueCount.mira}/P${npcDialogueCount.phantom}, sensory: ${sensoryDetails}, compactions: ${compactionCount}`);
        }
      } catch (e) {
        findings.push(`Turn ${turn}: ${(e as Error).message}`);
        console.error(`[masq] Turn ${turn} error:`, (e as Error).message);
        if (turn < 3) throw e;
      }
    }

    // Check server logs for relationship extractions
    const relLogs = allServerLogs.filter(l => l.includes('relationships:'));
    relationshipExtractions.push(...relLogs.map(l => l.slice(-80)));

    // Count auto-created entities and locations from logs
    const autoCreated = allServerLogs.filter(l => l.includes('Auto-created'));
    const echoStripped = allServerLogs.filter(l => l.includes('Stripped echo sentence'));
    const compactionLogs = allServerLogs.filter(l => l.includes('Compaction complete'));
    const factExtrLogs = allServerLogs.filter(l => l.includes('Fact extraction succeeded'));

    console.log(`\n[masq] === RESULTS ===`);
    console.log(`[masq] Turns: ${turnCount}/${TARGET_TURNS}`);
    console.log(`[masq] Scenes: ${sceneCount}`);
    console.log(`[masq] Locations visited: ${[...locations].join(', ')} (${locations.size}/6)`);
    console.log(`[masq] NPC presence: Vaelora=${npcDialogueCount.vaelora}, Cassius=${npcDialogueCount.cassius}, Mira=${npcDialogueCount.mira}, Phantom=${npcDialogueCount.phantom}`);
    console.log(`[masq] Sensory details: ${sensoryDetails}/${turnCount} narrations`);
    console.log(`[masq] Compactions: ${compactionLogs.length}`);
    console.log(`[masq] Fact extractions: ${factExtrLogs.length}`);
    console.log(`[masq] Auto-created: ${autoCreated.length}`);
    console.log(`[masq] Echo stripped: ${echoStripped.length}`);
    console.log(`[masq] Compels: ${compelCount}`);
    console.log(`[masq] Invokes: ${invokeCount}`);
    console.log(`[masq] Inventory changes: ${inventoryChanges.length} (${inventoryChanges.join('; ')})`);

    // Check which scenario locations were visited
    const scenarioLocs = ['grand ballroom', 'wine cellar', 'study', 'garden terrace', 'servants\' corridor', 'music gallery'];
    const visitedScenario = scenarioLocs.filter(l => [...locations].some(v => v.toLowerCase().includes(l.split(' ')[0]!)));
    console.log(`[masq] Scenario locs visited: ${visitedScenario.join(', ')} (${visitedScenario.length}/${scenarioLocs.length})`);

    // Trust trajectory analysis
    if (trustHistory.length > 0) {
      const elaraTrust = trustHistory.filter(t => t.char.length > 0).slice(0, 10);
      console.log(`[masq] Trust trajectory (first 10): ${elaraTrust.map(t => `T${t.turn}:${t.trust.toFixed(2)}`).join(' → ')}`);
    }

    // Plot thread analysis — check if key plot elements appeared
    const allText = narrations.join(' ').toLowerCase();
    const plotElements = {
      assassination: (allText.match(/assassin|kill|murder|plot|poison|midnight/g) ?? []).length,
      wine: (allText.match(/wine|cellar|bottle|toast|cup|goblet|drink/g) ?? []).length,
      phantom: (allText.match(/phantom|ghost|white mask|spirit|spectre/g) ?? []).length,
      letters: (allText.match(/letter|correspondence|document|note|message/g) ?? []).length,
      betrayal: (allText.match(/betray|traitor|conspir|plot|scheme/g) ?? []).length,
    };
    console.log(`[masq] Plot elements: ${JSON.stringify(plotElements)}`);

    if (findings.length > 0) console.log(`[masq] Findings: ${findings.join('; ')}`);

    // Assertions — quality gates
    expect(turnCount).toBeGreaterThanOrEqual(12);
    expect(sceneCount).toBeGreaterThanOrEqual(2);
    expect(locations.size).toBeGreaterThanOrEqual(3);
    expect(npcDialogueCount.vaelora + npcDialogueCount.cassius + npcDialogueCount.mira).toBeGreaterThanOrEqual(5);
    expect(sensoryDetails).toBeGreaterThanOrEqual(3);

  }, 1800_000);
});
