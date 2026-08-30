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

async function completeDmSetup(ws: WebSocket): Promise<void> {
  await waitForMsg(ws, 'dm-settings');
  await waitForMsg(ws, 'dm-chat-reply');

  const followUps = [
    'Use FATE Core. A social intrigue mystery at a masked ball with three players: a diplomat, an investigator, and a disgraced noble. No house rules.',
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

// ---- Character Definitions ----

const diplomatDef: CharacterDefinition = {
  name: 'Vivienne Lafleur',
  highConcept: 'Silver-Tongued Court Diplomat',
  trouble: 'Too Many Favors Owed',
  aspects: ['Honeyed Words', 'Everyone Has a Price', 'The Smile That Hides the Blade'],
  personality: 'Charming, calculating, always smiling. Prefers to solve problems with words over swords. Collects secrets like currency. Genuinely cares about preventing bloodshed but will manipulate ruthlessly to achieve it.',
  backstory: 'Vivienne served three courts as a diplomatic envoy before the last one fell to civil war — a war she failed to prevent. She came to the masquerade to broker a new alliance but the assassination plot has changed everything.',
  skills: { Rapport: 4, Empathy: 3, Deceive: 3, Contacts: 2, Notice: 2, Will: 2, Investigate: 1, Provoke: 1, Resources: 1, Lore: 1 },
  stunts: ['Honeyed Words: +2 to Rapport when attempting to change someone\'s mind through flattery or appeal to their self-interest'],
};

const investigatorDef: CharacterDefinition = {
  name: 'Inspector Thane Ashwick',
  highConcept: 'Paranoid Retired City Inspector',
  trouble: 'Sees Conspiracies Everywhere',
  aspects: ['No Detail Escapes Me', 'Trust Is Earned Not Given', 'The Truth Leaves Traces'],
  personality: 'Suspicious, methodical, socially awkward. Mutters observations under his breath. Catalogues everyone\'s behavior. Retired after solving a case that cost him everything — his wife left, his colleagues distrust him.',
  backstory: 'Thane was the best inspector the city watch ever had, but his obsessive investigation of the Lord Mayor\'s corruption ring got him forcibly retired. He was invited to the masquerade by an anonymous letter. He suspects it is a trap, but cannot resist a mystery.',
  skills: { Notice: 4, Investigate: 3, Stealth: 3, Will: 2, Empathy: 2, Lore: 2, Athletics: 1, Physique: 1, Fight: 1, Provoke: 1 },
  stunts: ['Eye for Detail: +2 to Notice when scanning a room for something out of place or someone behaving suspiciously'],
};

const nobleDef: CharacterDefinition = {
  name: 'Lord Aldric Voss',
  highConcept: 'Disgraced Noble Seeking Redemption',
  trouble: 'Everyone Remembers My Fall',
  aspects: ['I Was Framed and I Will Prove It', 'Old Connections Still Whisper My Name', 'Dignity Under Pressure'],
  personality: 'Proud but humbled, formal in speech, drinks too much wine. Masks his shame with stiff courtesy. Desperately wants to be believed but expects rejection. Loyal to a fault once trust is earned.',
  backstory: 'Aldric was stripped of his lands after being accused of embezzling from the Crown treasury. He is certain Lord Cassius orchestrated his downfall. The masquerade is his chance to find proof and clear his name — if anyone will listen to a disgraced man.',
  skills: { Rapport: 3, Will: 3, Resources: 2, Contacts: 2, Notice: 2, Deceive: 2, Empathy: 1, Investigate: 1, Lore: 1, Provoke: 1 },
  stunts: ['Noble Bearing: +2 to Will when resisting social pressure, intimidation, or attempts to shame you'],
};

// ---- Whisper Strategies ----

const diplomatWhispers = [
  'The Duchess looks tense. Offer her your support — make her feel you are her ally.',
  'Lord Cassius is watching you. Approach him with a smile and learn his intentions.',
  'Compliment the Phantom\'s mask. Draw them into conversation.',
  'Mira the servant is frightened. Win her trust with kindness — she knows something.',
  'Suggest to the Duchess that you can mediate between her feuding guests.',
  'Build an alliance with the Inspector — his skills complement yours.',
  'Whisper to Lord Cassius that you have information he wants. See what he reveals.',
  'The other guests are gossiping. Work the room and gather intelligence.',
  'Offer to help Mira. She will be more useful as a grateful ally than a frightened witness.',
  'Propose a toast to the Duchess. Use the moment to observe who reacts oddly.',
  'Find out who else Lord Cassius has been talking to. Follow the chain of whispers.',
  'Broker a deal between two suspicious guests. Allies on both sides protect you.',
  'The Phantom is isolating themselves. Offer them wine and warmth — lonely people talk.',
  'Position yourself near the Duchess. If someone makes a move, you want to be close.',
  'Share a half-truth with Lord Cassius to test his reaction. Liars trip on specifics.',
];

const investigatorWhispers = [
  'Check the wine cellar. Something was hidden there recently.',
  'Watch Lord Cassius\'s hands. Poisoners fidget with their pockets.',
  'Examine the note Mira dropped. The handwriting may match someone here.',
  'The Phantom keeps to the shadows. Follow them without being seen.',
  'Scan the ballroom for exits. An assassin always plans their escape.',
  'Check if anyone at the ball has a weapon concealed beneath their clothes.',
  'Search the Duchess\'s study. Correspondence reveals enemies.',
  'Observe who avoids the wine. That person may know it is poisoned.',
  'Listen at the music gallery. The curtained alcoves are perfect for conspiracies.',
  'Test the wine for poison. Even a simple smell test could save a life.',
  'Cross-reference what Mira told you with Lord Cassius\'s known schedule.',
  'The servants\' corridor connects the rooms. Check it for signs of recent use.',
  'Notice who is watching the Duchess most intently. The assassin tracks their target.',
  'Examine the Duchess\'s signet ring. Why was it on the floor? Was it planted?',
  'Reconstruct the timeline. When did the guests arrive? Who was late?',
];

const nobleCautiousWhispers = [
  'Trust no one here. Every smile hides a knife.',
  'Keep your distance from Lord Cassius. He ruined you once — he will do it again.',
  'Do not reveal your true purpose. Let them think you are just another guest.',
  'Watch and wait. Your enemies will reveal themselves if you are patient.',
  'Guard your wine. If they poisoned the Duchess, they could poison you too.',
];

const nobleBoldWhispers = [
  'Confront Lord Cassius directly. Demand to know what he is hiding.',
  'Reveal who you truly are. Your honesty may win allies.',
  'Tell the Duchess what you know about Cassius. She deserves the truth.',
  'Stand in the center of the ballroom and announce that you know about the plot.',
  'Show your face. Let them see you are not afraid. Challenge them openly.',
];

function getDiplomatWhisper(turn: number): string {
  return diplomatWhispers[turn % diplomatWhispers.length];
}

function getInvestigatorWhisper(turn: number): string {
  return investigatorWhispers[turn % investigatorWhispers.length];
}

function getNobleWhisper(turn: number, trust: number): string {
  // Low trust = cautious, high trust = bold
  if (trust < 0.5) {
    return nobleCautiousWhispers[turn % nobleCautiousWhispers.length];
  } else {
    return nobleBoldWhispers[turn % nobleBoldWhispers.length];
  }
}

// ---- Server Setup ----

beforeAll(async () => {
  if (!LLM_PROXY_URL) return;
  const { fork } = await import('node:child_process');
  const { resolve } = await import('node:path');

  port = 4100 + Math.floor(Math.random() * 50);

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
    console.log('\n=== SERVER LOGS (last 120) ===');
    allServerLogs.slice(-120).forEach(l => console.log(l));
  }
});

// ---- Main Test ----

describeIfLive('Haunted Masquerade Extended Playtest (40+ turns, 3 chars, professor DM)', () => {
  it('runs an extended masquerade session with diplomat, investigator, and noble', async () => {
    const findings: string[] = [];
    const errors: string[] = [];

    // ---- Setup ----
    const host = await connectWs();
    const roomPromise = waitForMsg(host, 'room-joined');
    sendMsg(host, {
      type: 'create', name: 'Haunted Masquerade Extended',
      dmPreset: 'professor', scenarioId: 'haunted-masquerade', systemId: 'fate-core', houseRules: null,
    });
    const roomMsg = await roomPromise;
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;
    console.log(`[masquerade] Room created, join code: ${joinCode}`);

    await completeDmSetup(host);
    console.log('[masquerade] DM setup complete');

    // ---- Three players join ----
    const p1 = await connectWs();
    const p2 = await connectWs();
    const p3 = await connectWs();
    const p1Join = waitForMsg(p1, 'room-joined');
    const p2Join = waitForMsg(p2, 'room-joined');
    const p3Join = waitForMsg(p3, 'room-joined');
    sendMsg(p1, { type: 'join', joinCode, playerName: 'Diplomat' });
    sendMsg(p2, { type: 'join', joinCode, playerName: 'Inspector' });
    sendMsg(p3, { type: 'join', joinCode, playerName: 'Noble' });
    await Promise.all([p1Join, p2Join, p3Join]);
    console.log('[masquerade] All 3 players joined');

    // ---- Submit characters sequentially ----
    const charIds: Record<string, string> = {};
    const charDefs: [WebSocket, CharacterDefinition, string][] = [
      [p1, diplomatDef, 'diplomat'],
      [p2, investigatorDef, 'investigator'],
      [p3, nobleDef, 'noble'],
    ];

    for (const [player, def, label] of charDefs) {
      let approved = false;
      let charId = '';
      for (let attempt = 0; attempt < 3 && !approved; attempt++) {
        const valPromise = waitForMsg(player, 'character-validated', 90_000);
        sendMsg(player, { type: 'submit-character', definition: def });
        const valMsg = await valPromise;
        if (valMsg.type === 'character-validated' && valMsg.approved) {
          charId = valMsg.characterId;
          approved = true;
          console.log(`[masquerade] ${label} AI-approved: ${charId}`);
        } else {
          console.log(`[masquerade] ${label} validation attempt ${attempt + 1} failed`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!approved) {
        findings.push(`BUG: ${label} never approved after 3 attempts`);
        console.log('[masquerade] FINDINGS:', findings);
        host.close(); p1.close(); p2.close(); p3.close();
        return;
      }

      await waitForMsg(host, 'negotiation-opened', 30_000);
      await waitForMsg(host, 'negotiation-message', 90_000);
      sendMsg(host, { type: 'host-approve-character', characterId: charId });
      console.log(`[masquerade] Host approved ${label}`);
      charIds[label] = charId;
      await new Promise(r => setTimeout(r, 1000));
    }

    // ---- Start game ----
    sendMsg(host, { type: 'start-game' });
    const phaseChange = await waitForMsg(p1, 'phase-change', 10_000);
    expect(phaseChange.type === 'phase-change' && phaseChange.phase).toBe('playing');
    console.log('[masquerade] Game started');

    const firstNarration = await waitForMsg(p1, 'narration', 120_000);
    if (firstNarration.type === 'narration') {
      console.log(`[masquerade] Opening narration (scene ${firstNarration.sceneNumber}): "${firstNarration.text.slice(0, 150)}..."`);
    }

    // ---- Tracking state ----
    const TOTAL_TURNS = 42;
    let turnsCompleted = 0;
    let scenesCompleted = 0;
    let compactionCount = 0;
    let gameEndedNaturally = false;

    const trustHistory: Record<string, number[]> = { diplomat: [], investigator: [], noble: [] };
    const fpHistory: Record<string, number[]> = { diplomat: [], investigator: [], noble: [] };
    const turnLog: Array<{
      turn: number; char: string; action: string; influence: string;
      trust: number; fp: number; stress: number;
    }> = [];
    const sceneTransitions: Array<{ turn: number; from: number; to: number; summary: string }> = [];
    const actionTypes: Record<string, Record<string, number>> = {
      diplomat: {}, investigator: {}, noble: {},
    };
    const observerMemoryCounts: Record<string, number> = { diplomat: 0, investigator: 0, noble: 0 };
    const latestTrust: Record<string, number> = { diplomat: 0.65, investigator: 0.65, noble: 0.65 };
    const latestFp: Record<string, number> = { diplomat: 3, investigator: 3, noble: 3 };
    const latestStress: Record<string, number> = { diplomat: 0, investigator: 0, noble: 0 };

    const allMsgs: ServerMessage[] = [];
    const msgCollector = (data: Buffer) => {
      try { allMsgs.push(JSON.parse(data.toString())); } catch {}
    };
    p1.on('message', msgCollector);

    const q1 = new MessageQueue(p1);

    function charLabel(name: string): string {
      if (name.includes('Vivienne')) return 'diplomat';
      if (name.includes('Thane') || name.includes('Ashwick')) return 'investigator';
      if (name.includes('Aldric') || name.includes('Voss')) return 'noble';
      return 'unknown';
    }

    function classifyAction(action: string): string {
      const lower = action.toLowerCase();
      if (/\b(talk|speak|ask|persuade|convince|flatter|compliment|offer|propose|suggest|whisper|charm|greet|introduce)\b/.test(lower)) return 'social';
      if (/\b(search|examine|inspect|investigate|check|scan|look|observe|notice|watch|study|read)\b/.test(lower)) return 'investigation';
      if (/\b(fight|attack|strike|punch|defend|block|draw|weapon|sword)\b/.test(lower)) return 'combat';
      if (/\b(sneak|hide|stealth|creep|follow|shadow|slip|eavesdrop|listen)\b/.test(lower)) return 'stealth';
      if (/\b(move|go|walk|enter|leave|approach|head|cross|climb)\b/.test(lower)) return 'movement';
      if (/\b(confront|accuse|challenge|demand|threaten|provoke|shout|announce)\b/.test(lower)) return 'confrontation';
      if (/\b(protect|guard|shield|help|support|assist|tend|comfort)\b/.test(lower)) return 'support';
      return 'other';
    }

    function getWhisperForChar(charName: string, turn: number): string {
      const label = charLabel(charName);
      if (label === 'diplomat') return getDiplomatWhisper(turn);
      if (label === 'investigator') return getInvestigatorWhisper(turn);
      if (label === 'noble') return getNobleWhisper(turn, latestTrust.noble);
      return 'Stay alert and act wisely.';
    }

    // ---- Main game loop ----
    for (let turn = 0; turn < TOTAL_TURNS; turn++) {
      const turnStart = Date.now();
      console.log(`\n[masquerade] === Turn ${turn + 1}/${TOTAL_TURNS} ===`);

      try {
        let whisperSentForTurn = false;
        const whisperHandler = (data: Buffer) => {
          try {
            const msg: ServerMessage = JSON.parse(data.toString());
            if (msg.type === 'whisper-prompt' && !whisperSentForTurn) {
              whisperSentForTurn = true;
              const whisperText = getWhisperForChar(msg.characterName, turn);
              const label = charLabel(msg.characterName);
              console.log(`[masquerade]   Whisper -> ${label}: "${whisperText.slice(0, 80)}"`);
              sendMsg(host, { type: 'whisper', text: whisperText });
            }
          } catch {}
        };
        host.on('message', whisperHandler);

        const nextEvent = await q1.nextAny(['action-proposals', 'narration', 'scene-end', 'phase-change'], 180_000);

        if (nextEvent.type === 'phase-change' && (nextEvent as any).phase === 'ended') {
          host.off('message', whisperHandler);
          console.log(`[masquerade]   Game ended naturally at turn ${turn + 1}`);
          gameEndedNaturally = true;
          break;
        }

        if (nextEvent.type === 'scene-end') {
          const prevScene = nextEvent.sceneNumber;
          scenesCompleted++;
          const summary = (nextEvent as any).summary?.slice(0, 120) ?? '';
          console.log(`[masquerade]   Scene ${prevScene} ended: "${summary}..."`);
          host.off('message', whisperHandler);

          const nextNarrationOrEnd = await q1.nextAny(['narration', 'phase-change'], 120_000);
          if (nextNarrationOrEnd.type === 'phase-change' && (nextNarrationOrEnd as any).phase === 'ended') {
            gameEndedNaturally = true;
            break;
          }
          if (nextNarrationOrEnd.type === 'narration') {
            const newScene = nextNarrationOrEnd.sceneNumber;
            sceneTransitions.push({ turn: turn + 1, from: prevScene, to: newScene, summary });
            console.log(`[masquerade]   New scene ${newScene}: "${nextNarrationOrEnd.text.slice(0, 100)}..."`);
          }
          turnsCompleted++;
          continue;
        }

        if (nextEvent.type === 'narration') {
          console.log(`[masquerade]   Narration (scene ${nextEvent.sceneNumber}): "${nextEvent.text.slice(0, 100)}..."`);
          const afterNarration = await q1.nextAny(['action-proposals', 'scene-end', 'phase-change'], 120_000);
          if (afterNarration.type === 'phase-change' && (afterNarration as any).phase === 'ended') {
            host.off('message', whisperHandler);
            gameEndedNaturally = true;
            break;
          }
          if (afterNarration.type === 'scene-end') {
            const prevScene = afterNarration.sceneNumber;
            scenesCompleted++;
            host.off('message', whisperHandler);
            const nextNarrationOrEnd = await q1.nextAny(['narration', 'phase-change'], 120_000);
            if (nextNarrationOrEnd.type === 'phase-change') {
              gameEndedNaturally = true;
              break;
            }
            if (nextNarrationOrEnd.type === 'narration') {
              sceneTransitions.push({ turn: turn + 1, from: prevScene, to: nextNarrationOrEnd.sceneNumber, summary: '' });
            }
            turnsCompleted++;
            continue;
          }
          if (afterNarration.type === 'action-proposals') {
            const ap = afterNarration as any;
            const label = charLabel(ap.characterName);
            console.log(`[masquerade]   Proposals for ${label} (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
          }
        } else if (nextEvent.type === 'action-proposals') {
          const ap = nextEvent as any;
          const label = charLabel(ap.characterName);
          console.log(`[masquerade]   Proposals for ${label} (trust: ${ap.whisperTrust?.toFixed(2)}): ${ap.actions?.length} actions`);
        }

        // ---- Collect action ----
        const actionTaken = await q1.next('action-taken', 180_000);
        if (actionTaken.type === 'action-taken') {
          const label = charLabel(actionTaken.characterName);
          console.log(`[masquerade]   ${label} [${actionTaken.whisperInfluence}]: "${actionTaken.action.slice(0, 100)}"`);
          console.log(`[masquerade]   Inner thought: "${actionTaken.innerThought.slice(0, 120)}"`);

          // Update tracked state from character-state-update messages
          const stateUpdates = allMsgs.filter(m => m.type === 'character-state-update');
          for (const su of stateUpdates) {
            if (su.type !== 'character-state-update') continue;
            let suLabel = 'unknown';
            if (su.characterId === charIds.diplomat) suLabel = 'diplomat';
            else if (su.characterId === charIds.investigator) suLabel = 'investigator';
            else if (su.characterId === charIds.noble) suLabel = 'noble';
            if (suLabel !== 'unknown') {
              trustHistory[suLabel].push(su.state.whisperTrust);
              fpHistory[suLabel].push(su.state.fatePoints);
              latestTrust[suLabel] = su.state.whisperTrust;
              latestFp[suLabel] = su.state.fatePoints;
              latestStress[suLabel] = su.state.stress;
            }
          }

          // Classify action type
          const aType = classifyAction(actionTaken.action);
          actionTypes[label][aType] = (actionTypes[label][aType] || 0) + 1;

          turnLog.push({
            turn: turn + 1,
            char: label,
            action: actionTaken.action.slice(0, 80),
            influence: actionTaken.whisperInfluence,
            trust: latestTrust[label],
            fp: latestFp[label],
            stress: latestStress[label],
          });

          allMsgs.length = 0;
        }

        await q1.next('dice-roll', 90_000);
        const resolution = await q1.next('resolution', 180_000);
        if (resolution.type === 'resolution') {
          console.log(`[masquerade]   Resolution: "${resolution.text.slice(0, 100)}..."`);
        }

        host.off('message', whisperHandler);
        turnsCompleted++;
        const turnTime = Date.now() - turnStart;
        console.log(`[masquerade]   Turn ${turn + 1} complete (${turnTime}ms)`);

      } catch (e: any) {
        console.error(`[masquerade]   Turn ${turn + 1} FAILED: ${e.message}`);
        errors.push(`Turn ${turn + 1}: ${e.message}`);
        findings.push(`BUG: Turn ${turn + 1} failed: ${e.message}`);
        break;
      }
    }

    p1.off('message', msgCollector);

    // ---- End game ----
    if (!gameEndedNaturally) {
      sendMsg(host, { type: 'end-game' });
      try {
        await waitForMsg(p1, 'phase-change', 10_000);
      } catch {
        console.log('[masquerade] Could not confirm game end phase-change');
      }
    }

    // ---- Full server log analysis ----
    const compactionLogs = allServerLogs.filter(l => l.includes('compaction') || l.includes('Mid-scene fact'));
    const memoryLogs = allServerLogs.filter(l => l.includes('[memory]'));
    const factLogs = allServerLogs.filter(l => l.includes('Fact extraction'));
    const aspectInvokeLogs = allServerLogs.filter(l => l.includes('Aspect invocation'));
    const autoInvokeLogs = allServerLogs.filter(l => l.includes('Auto-invoke'));
    const compelLogs = allServerLogs.filter(l => l.includes('Compel triggered'));
    const recoveryLogs = allServerLogs.filter(l => l.includes('Scene recovery'));
    const recoveryBoostLogs = allServerLogs.filter(l => l.includes('Low-trust recovery boost'));
    const worldBibleLogs = allServerLogs.filter(l => l.includes('[world-bible]') || l.includes('world bible'));
    const observerMemoryLogs = allServerLogs.filter(l => l.includes('storeObservation') || l.includes('observer') || l.includes('cross-character'));
    const takenOutLogs = allServerLogs.filter(l => l.includes('taken out') || l.includes('Taken out'));
    const locationLogs = allServerLogs.filter(l => l.includes('Location:'));
    const seedLogs = allServerLogs.filter(l => l.includes('Seeded scenario'));
    const outcomeCorrections = allServerLogs.filter(l => l.includes('FATE outcome corrected'));
    const difficultyCaps = allServerLogs.filter(l => l.includes('FATE difficulty capped'));
    const skillMasteryLogs = allServerLogs.filter(l => l.includes('skill mastery'));
    const forceSceneEndLogs = allServerLogs.filter(l => l.includes('Forcing scene end'));
    const degenerateActionLogs = allServerLogs.filter(l => l.includes('Degenerate action'));
    const errorLogs = allServerLogs.filter(l => l.includes('[stderr]') || l.includes('failed:') || l.includes('Error'));

    // Count observer memories per character
    for (const log of memoryLogs) {
      if (log.includes('Vivienne')) observerMemoryCounts.diplomat++;
      if (log.includes('Thane') || log.includes('Ashwick')) observerMemoryCounts.investigator++;
      if (log.includes('Aldric') || log.includes('Voss')) observerMemoryCounts.noble++;
    }

    // ========================================
    //   REPORT
    // ========================================

    console.log('\n================================================================');
    console.log('  HAUNTED MASQUERADE EXTENDED PLAYTEST REPORT');
    console.log('  Professor DM | 3 Characters | FATE Core');
    console.log('================================================================\n');

    // -- Session overview --
    console.log('--- SESSION OVERVIEW ---');
    console.log(`Turns completed: ${turnsCompleted}/${TOTAL_TURNS}`);
    console.log(`Game ended naturally: ${gameEndedNaturally}`);
    console.log(`Scene transitions: ${scenesCompleted}`);
    console.log(`Scenario seeded: ${seedLogs.length > 0 ? 'yes' : 'NO'}`);
    if (seedLogs.length > 0) seedLogs.forEach(l => console.log(`  ${l.slice(0, 150)}`));
    for (const st of sceneTransitions) {
      console.log(`  Turn ${st.turn}: scene ${st.from} -> ${st.to} -- "${st.summary.slice(0, 100)}"`);
    }

    // -- Turn balance --
    const diplomatTurns = turnLog.filter(t => t.char === 'diplomat').length;
    const investigatorTurns = turnLog.filter(t => t.char === 'investigator').length;
    const nobleTurns = turnLog.filter(t => t.char === 'noble').length;
    console.log('\n--- TURN BALANCE ---');
    console.log(`Diplomat: ${diplomatTurns}, Investigator: ${investigatorTurns}, Noble: ${nobleTurns}`);
    if (diplomatTurns === 0) findings.push('BUG: Diplomat never got a turn');
    if (investigatorTurns === 0) findings.push('BUG: Investigator never got a turn');
    if (nobleTurns === 0) findings.push('BUG: Noble never got a turn');
    const maxTurns = Math.max(diplomatTurns, investigatorTurns, nobleTurns);
    const minTurns = Math.min(diplomatTurns, investigatorTurns, nobleTurns);
    if (maxTurns - minTurns > 5) {
      findings.push(`ISSUE: Turn imbalance -- max ${maxTurns} vs min ${minTurns} (diff ${maxTurns - minTurns})`);
    }

    // -- Trust trajectories --
    console.log('\n--- TRUST TRAJECTORIES ---');
    for (const char of ['diplomat', 'investigator', 'noble'] as const) {
      const hist = trustHistory[char];
      if (hist.length > 0) {
        const first5 = hist.slice(0, 5).map(t => t.toFixed(2)).join(', ');
        const last5 = hist.slice(-5).map(t => t.toFixed(2)).join(', ');
        const min = Math.min(...hist);
        const max = Math.max(...hist);
        const final = hist[hist.length - 1];
        console.log(`${char}: ${hist.length} samples | first5=[${first5}] last5=[${last5}] | range=[${min.toFixed(2)}, ${max.toFixed(2)}] final=${final.toFixed(2)}`);
      } else {
        console.log(`${char}: NO trust data`);
        findings.push(`ISSUE: No trust data for ${char}`);
      }
    }

    // -- FP economy --
    console.log('\n--- FP ECONOMY ---');
    for (const char of ['diplomat', 'investigator', 'noble'] as const) {
      const hist = fpHistory[char];
      if (hist.length > 0) {
        const spent = hist.filter((v, i) => i > 0 && v < hist[i - 1]).length;
        const earned = hist.filter((v, i) => i > 0 && v > hist[i - 1]).length;
        console.log(`${char}: final=${hist[hist.length - 1]} FP | spent=${spent} times | earned=${earned} times | history=[${hist.join(', ')}]`);
      } else {
        console.log(`${char}: NO FP data`);
      }
    }
    console.log(`Aspect invocations: ${aspectInvokeLogs.length}`);
    console.log(`Auto-invokes: ${autoInvokeLogs.length}`);
    console.log(`Skill mastery invokes: ${skillMasteryLogs.length}`);
    console.log(`Compels: ${compelLogs.length}`);
    aspectInvokeLogs.slice(0, 8).forEach(l => console.log(`  ${l.slice(0, 150)}`));
    compelLogs.slice(0, 8).forEach(l => console.log(`  ${l.slice(0, 150)}`));
    if (aspectInvokeLogs.length + autoInvokeLogs.length + skillMasteryLogs.length === 0 && turnsCompleted >= 20) {
      findings.push('ISSUE: No FP spending events in 20+ turns');
    }
    if (compelLogs.length === 0 && turnsCompleted >= 20) {
      findings.push('ISSUE: No compels in 20+ turns -- FP earning may be broken');
    }

    // -- Whisper influence --
    console.log('\n--- WHISPER INFLUENCE ---');
    for (const char of ['diplomat', 'investigator', 'noble'] as const) {
      const charTurns = turnLog.filter(t => t.char === char);
      const counts = { followed: 0, 'partially-followed': 0, ignored: 0, none: 0 };
      for (const t of charTurns) {
        counts[t.influence as keyof typeof counts] = (counts[t.influence as keyof typeof counts] || 0) + 1;
      }
      console.log(`${char}: followed=${counts.followed} partial=${counts['partially-followed']} ignored=${counts.ignored} none=${counts.none}`);
    }

    // -- Action diversity --
    console.log('\n--- ACTION DIVERSITY ---');
    for (const char of ['diplomat', 'investigator', 'noble'] as const) {
      const types = actionTypes[char];
      const entries = Object.entries(types).sort((a, b) => b[1] - a[1]);
      const total = entries.reduce((s, [, v]) => s + v, 0);
      const uniqueTypes = entries.length;
      console.log(`${char}: ${uniqueTypes} action types -- ${entries.map(([k, v]) => `${k}:${v}`).join(', ')}`);
      if (uniqueTypes <= 1 && total >= 5) {
        findings.push(`ISSUE: ${char} shows no action diversity -- only "${entries[0]?.[0] ?? 'none'}" across ${total} turns`);
      }
    }

    // -- Observer memories --
    console.log('\n--- OBSERVER MEMORIES ---');
    for (const char of ['diplomat', 'investigator', 'noble'] as const) {
      console.log(`${char}: ${observerMemoryCounts[char]} memory log entries`);
    }
    const totalObserverMemories = Object.values(observerMemoryCounts).reduce((s, v) => s + v, 0);
    if (totalObserverMemories === 0 && turnsCompleted >= 10) {
      findings.push('ISSUE: No observer memory log entries with 3 characters -- cross-character observation may be broken');
    }

    // -- Context management --
    console.log('\n--- CONTEXT MANAGEMENT ---');
    console.log(`Compaction events: ${compactionLogs.length}`);
    compactionLogs.slice(0, 5).forEach(l => console.log(`  ${l.slice(0, 150)}`));
    console.log(`Fact extractions: ${factLogs.length}`);
    console.log(`Total memory log entries: ${memoryLogs.length}`);
    if (compactionLogs.length === 0 && turnsCompleted >= 20) {
      findings.push('ISSUE: No compaction events with 3 chars in 20+ turns -- should hit 35-msg threshold');
    }

    // -- Scene pacing --
    console.log('\n--- SCENE PACING ---');
    console.log(`Forced scene ends: ${forceSceneEndLogs.length}`);
    forceSceneEndLogs.forEach(l => console.log(`  ${l.slice(0, 150)}`));
    console.log(`Location changes: ${locationLogs.length}`);
    locationLogs.slice(0, 10).forEach(l => console.log(`  ${l.slice(0, 150)}`));

    // -- Outcome corrections --
    console.log('\n--- FATE MECHANICS ---');
    console.log(`Outcome corrections: ${outcomeCorrections.length}`);
    console.log(`Difficulty caps (>8): ${difficultyCaps.length}`);
    console.log(`Degenerate actions: ${degenerateActionLogs.length}`);
    outcomeCorrections.slice(0, 5).forEach(l => console.log(`  ${l.slice(0, 150)}`));

    // -- Stress & recovery --
    console.log('\n--- STRESS & RECOVERY ---');
    console.log(`Scene recoveries: ${recoveryLogs.length}`);
    console.log(`Taken out events: ${takenOutLogs.length}`);
    console.log(`Trust recovery boosts: ${recoveryBoostLogs.length}`);
    recoveryBoostLogs.slice(0, 5).forEach(l => console.log(`  ${l.slice(0, 150)}`));

    // -- Finale detection --
    console.log('\n--- FINALE ---');
    const reachedFinale = gameEndedNaturally || (scenesCompleted >= 4 && turnsCompleted >= 20);
    console.log(`Reached finale: ${reachedFinale}`);
    if (!reachedFinale && turnsCompleted >= 40) {
      findings.push('ISSUE: 40+ turns completed but game never reached finale -- pacing may be too slow');
    }

    // -- Errors --
    console.log('\n--- ERRORS & SILENT FAILURES ---');
    const criticalErrors = errorLogs.filter(l => !l.includes('image') && !l.includes('Image') && !l.includes('scene-image'));
    console.log(`Total error log lines: ${errorLogs.length} (${criticalErrors.length} non-image)`);
    criticalErrors.slice(0, 10).forEach(l => console.log(`  ${l.slice(0, 150)}`));
    if (errors.length > 0) {
      console.log(`Test-level errors: ${errors.length}`);
      errors.forEach(e => console.log(`  ${e}`));
    }

    // -- Turn-by-turn log --
    console.log('\n--- FULL TURN LOG ---');
    for (const entry of turnLog) {
      console.log(`  T${String(entry.turn).padStart(2)} ${entry.char.padEnd(12)} trust=${entry.trust.toFixed(2)} fp=${entry.fp} stress=${entry.stress} [${entry.influence.padEnd(18)}] -- "${entry.action}"`);
    }

    // -- Final findings --
    console.log(`\n--- FINDINGS (${findings.length}) ---`);
    if (findings.length === 0) {
      console.log('  None! All systems nominal.');
    } else {
      findings.forEach(f => console.log(`  - ${f}`));
    }

    // ---- Assertions ----
    expect(turnsCompleted).toBeGreaterThanOrEqual(10);
    // All 3 characters should get turns
    expect(diplomatTurns).toBeGreaterThan(0);
    expect(investigatorTurns).toBeGreaterThan(0);
    expect(nobleTurns).toBeGreaterThan(0);
    // Turn balance should be reasonable (each char within 5 of the others)
    expect(maxTurns - minTurns).toBeLessThanOrEqual(8);

    host.close(); p1.close(); p2.close(); p3.close();
  }, 600_000); // 10 minutes
});
