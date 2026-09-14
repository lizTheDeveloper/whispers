import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFreePort } from './ws-helpers.js';

export const LLM_STUB_REPLIES = {
  validation: { approved: true, feedback: 'Solid sheet.', modifications: null },
  setupOpen: {
    reply: 'What kind of game are we running?',
    done: false,
    influences: [],
    dmInstructions: null,
    dmCustomPrompt: null,
  },
  setupDone: {
    reply: 'Got it — I have what I need.',
    done: true,
    influences: ['Le Guin', 'Annihilation', 'Disco Elysium'],
    dmInstructions: 'A haunted lighthouse, spooky but hopeful.',
    dmCustomPrompt: 'You are running a haunted lighthouse game.',
  },
  worldSeed: {
    premise: 'A lighthouse keeps something out, not in.',
    locations: [
      { name: 'The Lamp Room', description: 'Glass, salt, and a light that must not go out.', terrain: 'interior' },
      { name: 'The Tidal Stair', description: 'Steps cut into wet rock, passable twice a day.', terrain: 'coast' },
      { name: 'Cormorant Town', description: 'Nine houses and a chapel with no bell.', terrain: 'village' },
    ],
    npcs: [
      { name: 'Maren', description: 'The keeper, thirty years at the lamp.', disposition: 'wary', motivation: 'Keep the light lit.' },
      { name: 'The Cartwright', description: 'Brings supplies, never stays for dark.', disposition: 'friendly', motivation: 'Get paid and get home.' },
      { name: 'Iselin', description: 'The relief keeper who never arrived.', disposition: 'unknown', motivation: 'Unknown.' },
    ],
    plotHooks: ['The relief keeper never arrived.', 'The chapel bell was removed, not lost.', 'Something answers the light.'],
    items: [{ name: 'Brass Key', description: 'Warm to the touch, always.' }],
  },
  charInterviewOpen: {
    reply: 'You are standing at the edge of the tailing field watching the dust come in. What are you thinking about?',
    definition: null,
  },
  charInterviewDone: {
    reply: 'Here is who I think you are.',
    definition: {
      name: 'Vesper Ash',
      highConcept: 'Lighthouse Keeper Who Stopped Believing',
      trouble: 'Owes the Ledger Cult a debt she cannot name',
      aspects: ['Maps are promises', 'Never looks back'],
      personality: 'Quiet, stubborn, allergic to comfort.',
      backstory: 'Thirty years at the lamp and one night she did not climb the stair.',
      skills: { Will: 3, Notice: 2, Lore: 1 },
      stunts: ['Steady Hand: +2 to Will against fear.'],
    },
  },
  // A thin-but-non-null definition — the model believes it is done (it is
  // not refusing, it filled in the field it has), but only `name` clears the
  // bar. Used to prove the server coerces this to definition: null on the
  // wire rather than trusting the model's own "here it is" framing.
  charInterviewThin: {
    reply: 'I think I have a name for them, at least.',
    definition: {
      name: 'Vesper Ash',
      highConcept: '',
      trouble: '',
      aspects: [],
      personality: '',
      backstory: '',
      skills: {},
      stunts: [],
    },
  },
  worldIntroduction:
    'The lamp has been lit every night for thirty years. Tonight the relief keeper did not arrive, and the chapel below has no bell to ring.',
};

export interface Harness {
  port: number;
  stop(): Promise<void>;
}

/**
 * Boots the real server (src/server/index.ts) against a throwaway data dir and
 * a canned LLM proxy. The server reads PORT/DATA_DIR/LLM_PROXY_URL at import
 * time, so they must be set before the dynamic import below.
 */
export async function startHarness(): Promise<Harness> {
  const llm = await startLlmStub();
  process.env.LLM_PROXY_URL = llm.url;

  const dataDir = mkdtempSync(join(tmpdir(), 'whispers-test-'));
  process.env.DATA_DIR = dataDir;

  const port = await getFreePort();
  process.env.PORT = String(port);

  const mod = await import('../../src/server/index.js');
  if (!mod.server.listening) {
    await new Promise<void>((r) => mod.server.once('listening', () => r()));
  }

  return {
    port,
    async stop() {
      await new Promise<void>((r) => mod.server.close(() => r()));
      await new Promise<void>((r) => llm.server.close(() => r()));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * The host says "done" only after at least one message, so a test can drive a
 * campaign to "world set up" deterministically by sending exactly one dm-chat.
 */
function startLlmStub(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let text: string;
        if (body.includes('You are a world builder for a TTRPG')) {
          text = JSON.stringify(LLM_STUB_REPLIES.worldSeed);
        } else if (body.includes('introducing a player to a world')) {
          text = LLM_STUB_REPLIES.worldIntroduction;
        } else if (body.includes('character creation API')) {
          // A special marker in the player's own text picks the thin-sheet
          // fixture regardless of turn count, so a test can trigger it
          // deterministically without disturbing the two-turn "done" flow
          // every other interview test relies on.
          if (body.includes('THIN_SHEET_TRIGGER')) {
            text = JSON.stringify(LLM_STUB_REPLIES.charInterviewThin);
          } else {
            // The interview turns "done" once the player has answered twice, so a
            // test can drive it deterministically instead of guessing turn counts.
            const playerTurns = (body.match(/"role":"user"/g) ?? []).length;
            text = JSON.stringify(playerTurns >= 2 ? LLM_STUB_REPLIES.charInterviewDone : LLM_STUB_REPLIES.charInterviewOpen);
          }
        } else if (body.includes('character sheet validation API')) {
          text = JSON.stringify(LLM_STUB_REPLIES.validation);
        } else if (body.includes('helping set up a new game')) {
          const hostSpoke = body.includes('"role":"user"');
          text = JSON.stringify(hostSpoke ? LLM_STUB_REPLIES.setupDone : LLM_STUB_REPLIES.setupOpen);
        } else {
          text = 'Understood. Lets keep moving.';
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));
      });
    });
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}
