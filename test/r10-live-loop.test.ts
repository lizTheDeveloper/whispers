// Round 10 in play: the live N7RQZ7 lines run through the game loop (the LLM
// mocked with them), so the wiring is tested, not only the pure guards.
//  1. Liz's own "My son is a minor" reaches the table as "My kid is a minor",
//     and the character prompt names Biz as Liz's "kid".
//  3. The envelope slipped into Biz's hand in Liz's ruling makes Biz's own
//     ruling's add of "The Letter of Truth" stand.
//  4. "'The Alphabet has swallowed the key'" takes the key out of Liz's
//     inventory.
//  5. A ten-year-old at the table: the gentle-peril rule rides in every
//     turn's prompt, and Biz's "before the crowd eats us" is softened.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../src/shared/types.js';

type Msg = { role: string; content: string };
const calls: Array<{ messages: Msg[] }> = [];

const KEY_SWALLOWED = "A sharp, wet click echoes from the lock, followed by the sudden, unnerving silence of the chewing stopping. The Lost Postman lunges forward, his blue coat snapping like a sail in a gale, and slams his long, ink-stained palm over Biz’s small one on the brass. 'The Alphabet has swallowed the key,' he hisses, his voice trembling with a fear that tastes of ozone and old paper, 'and now it is waiting for you to be hungry.'";
const POSTMAN_SLIPS = "The Postman’s rasping breath catches, a sound like paper tearing, as he studies the damp smear on Biz’s palm and the crumpled Form 9-B clinging to Liz’s hand like a shed skin. He does not answer her question directly; instead, he tilts his head, his blue coat rippling in the sudden chill of the market, and slips the glowing envelope into Biz’s sticky, ink-stained hand.";
const BIZ_OPENS = 'Biz’s fingers fumble with the wax seal, the hot wax cracking under the pressure of their small, impatient nails, while the envelope hums against their chest like a trapped bee. The paper inside is warm and smells of cinnamon and old libraries, and as Biz pulls it free, the glowing script begins to fade into plain ink before their eyes.';
const LIZ_SAYS = 'Excuse me. My son is a minor, but if you’re looking for a signature on a misfiled arrival, I’m the one who needs to know who signs off on the correction.';
const BIZ_SAYS = 'Mom, catch! Bixby, you made this mess, so you explain why the queue is shifting and where the stamp is before the crowd eats us.';

const ids = { liz: '', biz: '' };

vi.mock('../src/server/agents/llm-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/agents/llm-client.js')>()),
  callLlm: vi.fn(async (opts: { messages: Msg[] }) => {
    calls.push(opts);
    const all = opts.messages.map(m => m.content).join('\n');
    if (all.includes('OPENING OF THE ADVENTURE')) return { narration: 'The market hums.', introductions: [], currentLocationName: '' };
    if (all.includes('Choose your action now')) {
      return all.includes('You ARE Liz')
        ? { chosenAction: 'I step forward, shielding Biz from the Postman’s gaze, and ask about correcting the arrival record.', spokenWords: LIZ_SAYS, innerThought: 'The Postman wants Biz.', whisperedInfluence: 'ignored', trustDelta: 0 }
        : { chosenAction: 'Squeeze past Mom to the Postman, pressing my ink-stained palm against the glowing envelope.', spokenWords: BIZ_SAYS, innerThought: 'The envelope glows.', whisperedInfluence: 'ignored', trustDelta: 0 };
    }
    if (all.includes('Propose 2-4 actions')) return { actions: [{ description: 'I read the fine print on the nearest form', reasoning: 'r' }, { description: 'I ask Clerk Bixby for a number', reasoning: 'r' }] };
    if (all.includes('FATE resolution steps')) {
      return all.includes('ACTING CHARACTER (narrate THEIR action, not another party member\'s): Liz')
        ? { diceExpression: '4dF', difficulty: 1, skill: 'Notice', outcome: 'success', narration: POSTMAN_SLIPS, stateChanges: [] }
        : { diceExpression: '4dF', difficulty: 1, skill: 'Notice', outcome: 'success', narration: BIZ_OPENS, stateChanges: [{ characterId: ids.biz, field: 'inventory', action: 'add', value: 'The Letter of Truth' }] };
    }
    if (all.includes('Pacing:')) return { narration: KEY_SWALLOWED, currentLocationName: '', activeNpcs: [], isSceneEnd: false };
    if (all.includes('Summarize')) return { summary: 'The market moved.' };
    return 'ok';
  }),
}));

process.env.WHISPER_WINDOW_MS = '30';
process.env.PACE_MAX_MS = '0';

let dataDir: string;
let db: Database.Database;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'whispers-r10-'));
  process.env.DATA_DIR = join(__dirname, '..', 'data');
  process.env.STATE_DIR = dataDir;
  db = (await import('../src/server/db.js')).getDb();
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

async function playOneRound(): Promise<{ seen: any[]; prompts: string[]; campaignId: string }> {
  const { createRoom } = await import('../src/server/room.js');
  const { setWorldSeed, markSeedAccepted, seedWorld } = await import('../src/server/world-seed.js');
  const { GameLoop } = await import('../src/server/game-loop.js');
  const seed = {
    premise: 'A mother and her child arrive in Ombrovia.',
    locations: [{ name: 'The Ink & Orange Market', description: 'Stalls.', terrain: 'bazaar' }, { name: 'The Steam-Bell Tower', description: 'Brass.', terrain: 'tower' }],
    npcs: [{ name: 'The Lost Postman', description: 'Blue coat.', disposition: 'frantic', motivation: 'Deliver.' }, { name: 'Clerk Bixby', description: 'Paper suit.', disposition: 'polite', motivation: 'Order.' }],
    plotHooks: ['A letter glows.'],
    items: [{ name: 'The Orange Key', description: 'Brass, citrus-shaped.' }],
  };
  const { campaignId, joinCode } = createRoom(db, { name: 'R10 play', dmPreset: 'chronicler', systemId: 'fate-core' });
  setWorldSeed(db, campaignId, seed);
  markSeedAccepted(db, campaignId);
  seedWorld(db, campaignId, seed);
  const sheet = (name: string, pronouns: string, rel: { to: string; relation: string; address?: string }, age?: number): CharacterDefinition => ({
    name, pronouns, highConcept: `${name} the Traveller`, trouble: 'Too Curious', aspects: ['Quick'], personality: 'curious', backstory: '', skills: { Notice: 2 }, stunts: ['Keen: +2 Notice.'], relationships: [rel], ...(age ? { age } : {}),
  });
  const state = (inventory: string[]) => JSON.stringify({ stress: 0, consequences: [], fatePoints: 3, inventory, xpMilestones: [], whisperTrust: 0.6 });
  ids.liz = `liz-r10-${campaignId}`;
  ids.biz = `biz-r10-${campaignId}`;
  db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)').run(ids.liz, campaignId, JSON.stringify(sheet('Liz', 'she/her', { to: 'Biz', relation: 'kid' })), state(['Orange Key', 'Form 9-B: Return to Source (Crumpled)']));
  db.prepare('INSERT INTO characters (id, campaign_id, definition, state) VALUES (?, ?, ?, ?)').run(ids.biz, campaignId, JSON.stringify(sheet('Biz', 'they/them', { to: 'Liz', relation: 'mother', address: 'Mom' }, 10)), state([]));
  const gameState = { campaignId, joinCode, phase: 'playing' as const, currentScene: 0, currentTurn: 0, initiativeOrder: [], activeCharacterId: null, awaitingWhisper: false, awaitingDmAnswer: false, currentLocationId: null };
  const seen: any[] = [];
  const before = calls.length;
  let loop!: InstanceType<typeof GameLoop>;
  let resolutions = 0;
  const done = new Promise<void>((resolve) => {
    const on = (m: any) => { seen.push(m); if (m.type === 'resolution' && ++resolutions === 2) setImmediate(() => { loop.stop(); resolve(); }); };
    loop = new GameLoop(db, campaignId, on, () => {}, gameState as any, (_id: string, m: any) => on(m));
  });
  const running = loop.start().catch(e => console.error('LOOP FAILED', e));
  await Promise.race([done, new Promise(r => setTimeout(r, 20_000))]);
  loop.stop();
  await Promise.race([running, new Promise(r => setTimeout(r, 5_000))]);
  return { seen, prompts: calls.slice(before).map(c => c.messages.map(m => m.content).join('\n')), campaignId };
}

describe('round 10 in play', () => {
  let seen: any[] = [];
  let prompts: string[] = [];
  beforeAll(async () => { ({ seen, prompts } = await playOneRound()); }, 40_000);

  const inventoryOf = (id: string) => (JSON.parse((db.prepare('SELECT state FROM characters WHERE id = ?').get(id) as { state: string }).state).inventory as string[]);

  it('1. Liz says "My kid is a minor"; her prompt names Biz her kid', () => {
    const liz = seen.find(m => m.type === 'action-taken' && m.characterName === 'Liz');
    expect(liz.spokenWords).toBe('Excuse me. My kid is a minor, but if you’re looking for a signature on a misfiled arrival, I’m the one who needs to know who signs off on the correction.');
    expect(prompts.find(p => p.includes('You ARE Liz') && p.includes('Choose your action now'))).toContain('Biz is your kid — say "my kid"');
  });

  it('3. Biz keeps the Letter of Truth handed over a ruling earlier', () => {
    expect(inventoryOf(ids.biz)).toContain('The Letter of Truth');
  });

  it('4. the swallowed key leaves Liz\'s inventory; her form stays', () => {
    const inv = inventoryOf(ids.liz);
    expect(inv).not.toContain('Orange Key');
    expect(inv).toContain('Form 9-B: Return to Source (Crumpled)');
  });

  it('5. gentle peril in every turn\'s prompt, and Biz\'s words softened', () => {
    const rulings = prompts.filter(p => p.includes('FATE resolution steps'));
    expect(rulings.length).toBeGreaterThanOrEqual(2);
    for (const p of rulings) expect(p).toMatch(/<tone>\s*FAMILY TABLE: Biz is a child[\s\S]*GENTLE PERIL register/);
    expect(prompts.filter(p => p.includes('Pacing:')).every(p => /<tone>/.test(p))).toBe(true);
    const biz = seen.find(m => m.type === 'action-taken' && m.characterName === 'Biz');
    expect(biz.spokenWords).toContain('before the crowd sweeps us away');
  });
});
