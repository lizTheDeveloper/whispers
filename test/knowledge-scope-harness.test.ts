// test/knowledge-scope-harness.test.ts
//
// End-to-end over the real GameLoop and the canned LLM stub: what actually
// reaches a character's prompt on turn 1 of a stock scenario, and whether a
// whisper to one character leaks into another's. The stub records every
// request body, so these assertions are on the literal prompts sent.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, type Harness } from './lib/server-harness.js';
import type { CharacterDefinition, RoomState } from '../src/shared/types.js';
import type { ServerMessage } from '../src/shared/protocol.js';

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
  // The harness points DATA_DIR at a throwaway dir; stock scenarios are read
  // from it on demand, so give it the one this file plays.
  mkdirSync(join(harness.dataDir, 'scenarios'), { recursive: true });
  copyFileSync(join(__dirname, '..', 'data', 'scenarios', 'haunted-masquerade.json'), join(harness.dataDir, 'scenarios', 'haunted-masquerade.json'));
}, 30_000);
afterAll(async () => { await harness.stop(); });

const masquerade = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'scenarios', 'haunted-masquerade.json'), 'utf-8')) as {
  npcs: Array<{ name: string; motivation: string }>;
  plotHooks: string[];
};

const STATE = { stress: 0, consequences: [], fatePoints: 3, inventory: [], xpMilestones: [], whisperTrust: 0.5 };
function def(name: string): CharacterDefinition {
  return {
    name, backstory: 'Came for the music.', personality: 'Watchful.', highConcept: 'Masked Guest', trouble: 'Too Curious',
    aspects: ['Sharp Eyes'], skills: { Notice: 3, Rapport: 2 }, stunts: [],
  };
}

let seq = 0;
async function makeMasqueradeLoop(names: string[]) {
  const { getDb } = await import('../src/server/db.js');
  const { createRoom } = await import('../src/server/room.js');
  const { GameLoop } = await import('../src/server/game-loop.js');
  const db = getDb();
  const { campaignId, joinCode } = createRoom(db, { name: `Knowledge ${++seq}`, dmPreset: 'chronicler', systemId: 'fate-core', scenarioId: 'haunted-masquerade' });
  const ids = names.map((n, i) => {
    const id = `ks-${seq}-${i}`;
    db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)')
      .run(id, campaignId, JSON.stringify(def(n)), JSON.stringify(STATE));
    return id;
  });
  const broadcasts: ServerMessage[] = [];
  const state: RoomState = {
    campaignId, joinCode, phase: 'playing', currentScene: 1, currentTurn: 0,
    initiativeOrder: ids, activeCharacterId: null,
    awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null,
  };
  const loop = new GameLoop(db, campaignId, (m) => broadcasts.push(m), () => {}, state);
  return { loop, broadcasts, ids };
}

async function until(cond: () => boolean, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 25));
  }
}

/** The prompt text of a request body, with JSON string escaping undone. */
function promptText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
    return parsed.messages.map(m => m.content).join('\n');
  } catch { return body; }
}

describe('character prompts only carry what the party knows', () => {
  it('turn 1 of the haunted masquerade: no plot hooks, no unmet NPCs, no motivations', async () => {
    const name = 'Solene Ashby';
    const before = harness.receivedBodies.length;
    const { loop, broadcasts } = await makeMasqueradeLoop([name]);
    const running = loop.start().catch(() => {});
    await until(() => broadcasts.some(m => m.type === 'whisper-prompt'));
    loop.stop();
    await running;

    const prompts = harness.receivedBodies.slice(before).map(promptText);
    // Not vacuous: the scenario really was seeded, and the DM still sees all of it.
    const dmPrompts = prompts.filter(t => !t.includes('You ARE ') && t.includes('Lord Cassius'));
    expect(dmPrompts.length).toBeGreaterThan(0);
    expect(dmPrompts.some(t => t.includes(masquerade.plotHooks[0]!))).toBe(true);

    const charPrompts = prompts.filter(t => t.includes(`You ARE ${name}`));
    expect(charPrompts.length).toBeGreaterThan(0);
    // The opening narration names the Duchess, so the party knows her.
    expect(charPrompts.some(t => t.includes('Duchess Vaelora'))).toBe(true);
    for (const prompt of charPrompts) {
      for (const hook of masquerade.plotHooks) expect(prompt, `plot hook leaked: ${hook}`).not.toContain(hook);
      for (const npc of masquerade.npcs) expect(prompt, `motivation leaked: ${npc.name}`).not.toContain(npc.motivation);
      // The opening narration names the Duchess, so she is fair game. Nobody
      // has mentioned these three yet.
      for (const unmet of ['Lord Cassius', 'Mira the Servant', 'The Phantom']) {
        expect(prompt, `unmet NPC leaked: ${unmet}`).not.toContain(unmet);
      }
      expect(prompt).not.toContain('Poison Vial');
      expect(prompt).not.toContain('Open threads');
    }
  }, 60_000);

  it('a whisper reaches only the character it was whispered to', async () => {
    const [nameA, nameB] = ['Ana Quill', 'Bo Tennant'];
    const whisper = 'WHISPER_MARKER check behind the curtains';
    const before = harness.receivedBodies.length;
    const { loop, broadcasts, ids } = await makeMasqueradeLoop([nameA, nameB]);
    const running = loop.start().catch(() => {});

    await until(() => broadcasts.some(m => m.type === 'whisper-prompt' && (m as any).characterId === ids[0]));
    const ack = loop.handleWhisper(whisper, { characterId: ids[0]!, isOwner: false });
    expect(ack.status).toBe('delivered');
    // B's turn opens only after A's whole turn — whisper, verdict, resolution.
    await until(() => broadcasts.some(m => m.type === 'whisper-prompt' && (m as any).characterId === ids[1]));
    loop.stop();
    await running;

    const prompts = harness.receivedBodies.slice(before).map(promptText);
    const bPrompts = prompts.filter(t => t.includes(`You ARE ${nameB}`));
    expect(bPrompts.length).toBeGreaterThan(0);
    for (const p of bPrompts) {
      expect(p).not.toContain('WHISPER_MARKER');
      expect(p).not.toMatch(/(heeded|resisted) the whisper/);
    }

    // A's own decision sees its whisper in the scene events, as before.
    const aDecisions = prompts.filter(t => t.includes(`You ARE ${nameA}`) && t.includes('Choose your action now'));
    expect(aDecisions.length).toBeGreaterThan(0);
    expect(aDecisions[0]).toContain(`[whisper] ${whisper}`);
  }, 90_000);
});
