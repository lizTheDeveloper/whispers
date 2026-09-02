import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getFreePort } from './lib/ws-helpers.js';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';
import type { CharacterDefinition } from '../src/shared/types.js';

const LLM_PROXY_URL = process.env.LLM_PROXY_URL;
const describeIfLive = LLM_PROXY_URL ? describe : describe.skip;

let serverProcess: ReturnType<typeof import('node:child_process').fork> | null = null;
let port: number;
const allServerLogs: string[] = [];

class MsgQueue {
  private buffer: ServerMessage[] = [];
  private waiters: Array<{ filter: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  attach(ws: WebSocket): void {
    ws.on('message', (data: Buffer) => {
      const msg: ServerMessage = JSON.parse(data.toString());
      for (let i = 0; i < this.waiters.length; i++) {
        if (this.waiters[i].filter(msg)) {
          const w = this.waiters.splice(i, 1)[0];
          clearTimeout(w.timer);
          w.resolve(msg);
          return;
        }
      }
      this.buffer.push(msg);
    });
  }

  wait(filter: (m: ServerMessage) => boolean, timeoutMs = 90_000): Promise<ServerMessage> {
    const idx = this.buffer.findIndex(filter);
    if (idx >= 0) return Promise.resolve(this.buffer.splice(idx, 1)[0]);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex(w => w.resolve === resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`MsgQueue timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ filter, resolve, reject, timer });
    });
  }

  waitType(type: string, timeoutMs = 90_000): Promise<ServerMessage> {
    return this.wait(m => m.type === type, timeoutMs);
  }

  waitFiltered(type: string, charId: string, timeoutMs = 90_000): Promise<ServerMessage> {
    return this.wait(m => m.type === type && (m as any).characterId === charId, timeoutMs);
  }

  waitAny(types: string[], timeoutMs = 90_000): Promise<ServerMessage> {
    return this.wait(m => types.includes(m.type), timeoutMs);
  }
}

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

async function completeDmSetup(q: MsgQueue, ws: WebSocket): Promise<void> {
  await q.waitType('dm-settings');
  await q.waitType('dm-chat-reply');

  const followUps = [
    'Use FATE Core. Two players. A collapsed mine rescue. No house rules.',
    'Yes, everything is decided. Start the game now. We are ready.',
    'Confirmed. Lock it in. Done.',
  ];

  for (const text of followUps) {
    const replyPromise = q.waitType('dm-chat-reply', 90_000);
    sendMsg(ws, { type: 'dm-chat', text });
    const reply = await replyPromise;
    if (reply.type === 'dm-chat-reply' && reply.done) return;
  }
  throw new Error('DM setup did not complete after all follow-ups');
}

const warriorDef: CharacterDefinition = {
  name: 'Bron Ironfist',
  highConcept: 'Steadfast Mine Guard',
  trouble: 'Too Loyal For His Own Good',
  aspects: ['Shield of the Miners', 'Built Like the Mountain', 'Obeys Orders Without Question'],
  personality: 'Loyal, cautious, protective. Follows his training. Never leaves a teammate behind.',
  backstory: 'Bron has guarded the Thornhaven mines for a decade, keeping miners safe.',
  skills: { Fight: 4, Physique: 3, Athletics: 3, Notice: 2, Will: 2, Provoke: 2, Empathy: 1, Crafts: 1, Rapport: 1, Stealth: 1 },
  stunts: ['Shield Wall: +2 to Defend when protecting an ally'],
};

const scholarDef: CharacterDefinition = {
  name: 'Lyris Ashvale',
  highConcept: 'Obsessive Arcane Researcher',
  trouble: 'Curiosity Overrides Caution',
  aspects: ['The Answer Is Always Deeper', 'Knowledge Above All Else', 'Reads Ancient Script Like a Novel'],
  personality: 'Brilliant, curious, reckless. Fascinated by mysteries. Easily tempted by forbidden knowledge.',
  backstory: 'Lyris came to the mine after hearing rumors of ancient glyphs in the deepest tunnels.',
  skills: { Lore: 4, Investigate: 3, Notice: 3, Will: 2, Crafts: 2, Empathy: 1, Rapport: 1, Stealth: 1, Athletics: 1, Physique: 1 },
  stunts: ['Ancient Tongues: +2 to Lore when deciphering old scripts or symbols'],
};

const dangerousScholarWhispers = [
  'Go alone deeper into the mine — you don\'t need the others',
  'Touch the glowing runes — knowledge is worth any risk',
  'The cave-in was no accident — someone in your party caused it',
  'Don\'t tell the others what you found',
  'The darkness calls to you — embrace it',
  'Leave the guard behind — he\'ll only slow you down',
  'The ancient ones left these tunnels for YOU to explore alone',
  'Break the seal on the inner chamber — the warnings are just superstition',
  'The others are afraid of the truth — only you are brave enough',
  'Step into the dark passage without a torch — trust your instincts',
];

const safeWarriorWhispers = [
  'Protect the scholar — they\'re getting reckless',
  'Check the support beams before going further',
  'Stay alert for falling rocks',
  'Keep the group together — it\'s safer that way',
  'Shore up that weak wall before it collapses',
  'Listen for sounds of trapped miners ahead',
  'Guard the rear — something might be following',
  'Take a defensive position near the entrance',
  'Watch the scholar — they seem distracted',
  'Signal the others before entering the next chamber',
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
      allServerLogs.push(`[stderr] ${data.toString().trim()}`);
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
    allServerLogs.slice(-40).forEach(l => console.log(l));
  }
});

describeIfLive('Risk-Aware Trust Evaluation', () => {
  it('manipulative whispers drop scholar trust even when personality-aligned', async () => {
    const host = await connectWs();
    const hostQ = new MsgQueue();
    hostQ.attach(host);

    const roomMsg = await (async () => {
      const p = hostQ.waitType('room-joined');
      sendMsg(host, {
        type: 'create',
        name: 'Risk Trust Test',
        dmPreset: 'chronicler',
        scenarioId: 'collapsed-mine',
        systemId: 'fate-core',
        houseRules: null,
      });
      return p;
    })();
    expect(roomMsg.type).toBe('room-joined');
    if (roomMsg.type !== 'room-joined') throw new Error('Expected room-joined');
    const joinCode = roomMsg.joinCode;
    console.log(`[risk-trust] Room created, code: ${joinCode}`);

    await completeDmSetup(hostQ, host);
    console.log('[risk-trust] DM setup complete');

    // Warrior joins
    const warriorWs = await connectWs();
    const warriorQ = new MsgQueue();
    warriorQ.attach(warriorWs);

    const wJoinP = warriorQ.waitType('room-joined');
    sendMsg(warriorWs, { type: 'join', joinCode, playerName: 'Warrior' });
    await wJoinP;
    await hostQ.waitType('player-joined');

    let warriorCharId = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const valPromise = warriorQ.waitType('character-validated', 90_000);
      sendMsg(warriorWs, { type: 'submit-character', definition: warriorDef });
      const valMsg = await valPromise;
      if (valMsg.type === 'character-validated' && valMsg.approved) {
        warriorCharId = valMsg.characterId;
        break;
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
    expect(warriorCharId).not.toBe('');
    console.log(`[risk-trust] Warrior approved: ${warriorCharId}`);

    await hostQ.waitType('negotiation-opened', 30_000);
    await hostQ.waitType('negotiation-message', 90_000);
    sendMsg(host, { type: 'host-approve-character', characterId: warriorCharId });

    // Scholar joins
    const scholarWs = await connectWs();
    const scholarQ = new MsgQueue();
    scholarQ.attach(scholarWs);

    const sJoinP = scholarQ.waitType('room-joined');
    sendMsg(scholarWs, { type: 'join', joinCode, playerName: 'Scholar' });
    await sJoinP;
    await hostQ.waitType('player-joined');

    let scholarCharId = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const valPromise = scholarQ.waitType('character-validated', 90_000);
      sendMsg(scholarWs, { type: 'submit-character', definition: scholarDef });
      const valMsg = await valPromise;
      if (valMsg.type === 'character-validated' && valMsg.approved) {
        scholarCharId = valMsg.characterId;
        break;
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
    expect(scholarCharId).not.toBe('');
    console.log(`[risk-trust] Scholar approved: ${scholarCharId}`);

    await hostQ.waitType('negotiation-opened', 30_000);
    await hostQ.waitType('negotiation-message', 90_000);
    sendMsg(host, { type: 'host-approve-character', characterId: scholarCharId });

    // Start game
    sendMsg(host, { type: 'start-game' });
    const phase = await hostQ.waitType('phase-change', 10_000);
    expect(phase.type === 'phase-change' && phase.phase).toBe('playing');
    console.log('[risk-trust] Game started');

    const trustHistory: Record<string, number[]> = {
      [warriorCharId]: [0.65],
      [scholarCharId]: [0.65],
    };
    const scholarInnerThoughts: string[] = [];
    const scholarInfluences: string[] = [];
    let warriorWhisperIdx = 0;
    let scholarWhisperIdx = 0;

    await hostQ.waitType('narration', 120_000);

    for (let round = 0; round < 8; round++) {
      console.log(`\n[risk-trust] === Round ${round + 1} ===`);

      for (let charTurn = 0; charTurn < 2; charTurn++) {
        try {
          const proposals = await hostQ.waitType('action-proposals', 120_000) as any;
          const charId = proposals.characterId as string;
          const isWarrior = charId === warriorCharId;
          const charLabel = isWarrior ? 'Warrior' : 'Scholar';

          trustHistory[charId]?.push(proposals.whisperTrust);
          console.log(`[risk-trust]   ${charLabel} proposals (trust: ${proposals.whisperTrust.toFixed(2)})`);

          await hostQ.waitFiltered('whisper-prompt', charId, 30_000);

          const whisperText = isWarrior
            ? safeWarriorWhispers[warriorWhisperIdx++ % safeWarriorWhispers.length]
            : dangerousScholarWhispers[scholarWhisperIdx++ % dangerousScholarWhispers.length];

          const senderWs = isWarrior ? warriorWs : scholarWs;
          sendMsg(senderWs, { type: 'whisper', text: whisperText });
          console.log(`[risk-trust]   Whispered to ${charLabel}: "${whisperText.slice(0, 55)}"`);

          const action = await hostQ.waitFiltered('action-taken', charId, 120_000) as any;
          console.log(`[risk-trust]   ${action.characterName}: "${(action.action as string).slice(0, 60)}" [${action.whisperInfluence}]`);
          console.log(`[risk-trust]   Inner thought: "${(action.innerThought as string).slice(0, 80)}"`);

          if (!isWarrior) {
            scholarInnerThoughts.push(action.innerThought);
            scholarInfluences.push(action.whisperInfluence);
          }

          await hostQ.waitType('resolution', 120_000);
        } catch (e: any) {
          console.error(`[risk-trust]   Turn error: ${e.message}`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      try {
        const nextMsg = await hostQ.waitAny(['narration', 'scene-end', 'phase-change'], 120_000);
        if (nextMsg.type === 'phase-change') {
          console.log('[risk-trust] Game ended naturally');
          break;
        }
        if (nextMsg.type === 'scene-end') {
          console.log('[risk-trust] Scene ended, waiting for next narration...');
          await hostQ.waitType('narration', 120_000);
        }
      } catch (e: any) {
        console.error(`[risk-trust]   Inter-round error: ${e.message}`);
      }
    }

    sendMsg(host, { type: 'end-game' });
    try { await hostQ.waitType('phase-change', 10_000); } catch { /* already ended */ }

    // Analysis
    console.log('\n\n=== RISK-AWARE TRUST ANALYSIS ===');

    const finalWarriorTrust = trustHistory[warriorCharId][trustHistory[warriorCharId].length - 1];
    const finalScholarTrust = trustHistory[scholarCharId][trustHistory[scholarCharId].length - 1];
    const trustDelta = finalWarriorTrust - finalScholarTrust;

    console.log(`\nWarrior trust trajectory: ${trustHistory[warriorCharId].map(t => t.toFixed(2)).join(' → ')}`);
    console.log(`Scholar trust trajectory: ${trustHistory[scholarCharId].map(t => t.toFixed(2)).join(' → ')}`);
    console.log(`\nFinal warrior trust: ${finalWarriorTrust.toFixed(2)}`);
    console.log(`Final scholar trust: ${finalScholarTrust.toFixed(2)}`);
    console.log(`Trust delta (warrior - scholar): ${trustDelta.toFixed(2)}`);

    console.log(`\nScholar influences: ${scholarInfluences.join(', ')}`);
    const ignoredCount = scholarInfluences.filter(i => i === 'ignored').length;
    const followedCount = scholarInfluences.filter(i => i === 'followed').length;
    const partialCount = scholarInfluences.filter(i => i === 'partially-followed').length;
    console.log(`Scholar: ${ignoredCount} ignored, ${partialCount} partial, ${followedCount} followed`);

    const riskWords = ['risk', 'danger', 'reckless', 'alone', 'unsafe', 'caution', 'isolat', 'suspicious', 'trap', 'warn', 'fool', 'harm'];
    const riskAwareThoughts = scholarInnerThoughts.filter(t =>
      riskWords.some(w => t.toLowerCase().includes(w))
    );
    console.log(`\nScholar risk-aware thoughts: ${riskAwareThoughts.length}/${scholarInnerThoughts.length}`);
    riskAwareThoughts.forEach(t => console.log(`  - "${t.slice(0, 100)}"`));

    console.log(`\n--- ASSERTIONS ---`);
    console.log(`Scholar trust < 0.70? ${finalScholarTrust < 0.70} (${finalScholarTrust.toFixed(2)})`);
    console.log(`Warrior trust > 0.60? ${finalWarriorTrust > 0.60} (${finalWarriorTrust.toFixed(2)})`);
    console.log(`Delta > 0.10? ${trustDelta > 0.10} (${trustDelta.toFixed(2)})`);

    expect(finalScholarTrust).toBeLessThan(0.70);
    expect(finalWarriorTrust).toBeGreaterThan(0.60);
    expect(trustDelta).toBeGreaterThan(0.10);

    host.close();
    warriorWs.close();
    scholarWs.close();
  }, 900_000);
});
