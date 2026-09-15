import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFreePort } from './ws-helpers.js';

export const LLM_STUB_REPLIES = {
  validation: { approved: true, feedback: 'Solid sheet.', modifications: null },
  // A validation reply proposing a modification that would break readiness
  // (an emptied-out skills object) if merged in unchecked. Selected by a
  // MODIFICATIONS_TRIGGER marker in the submitted character's name, the
  // same pattern THIN_SHEET_TRIGGER uses below for the interview stub.
  validationBadModifications: { approved: true, feedback: 'Tightened up the sheet.', modifications: { skills: {} } },
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
  // Two short, plain-prose replies for the negotiation agents (negotiation.ts
  // calls callLlm with no schema, so these are returned as-is, not parsed as
  // JSON). Without a dedicated branch, every negotiation turn falls through
  // to the generic 'Understood. Lets keep moving.' fallback below — it still
  // works, but it is indistinguishable from every other unmatched prompt, so
  // any test asserting on negotiation dialogue content would be trivially
  // fooled by the wrong branch matching. See the dispatcher below for why
  // these use unique substrings instead of the dangerously generic 'You ARE '.
  negotiationDmReply:
    'This sheet looks solid to me — good hooks in the trouble, and the skills are balanced for the table. My one note is whether the stunt is a touch strong for this power level, but I would like to hear from both of you first.',
  negotiationCharReply:
    'That stunt is core to who I am, so I would like to keep it — but I am glad to trim a skill point if that is what gets us to a yes.',
};

export interface Harness {
  port: number;
  dataDir: string;
  // Every raw request body the LLM stub received, in order — lets a test
  // assert on prompt CONTENT across an entire flow (e.g. "the
  // '(No rules found for this query)' sentinel must never appear in any
  // prompt this server sends"), not just on the stub's canned replies.
  receivedBodies: string[];
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
  const receivedBodies = llm.receivedBodies;

  const dataDir = mkdtempSync(join(tmpdir(), 'whispers-test-'));
  process.env.DATA_DIR = dataDir;

  const port = await getFreePort();
  process.env.PORT = String(port);

  // Same read-at-import-time rule as PORT/DATA_DIR/LLM_PROXY_URL above.
  // Shrunk from the 30s production default so a test can actually exercise
  // the room-teardown path (which now also clears `negotiations` — see
  // src/server/index.ts) without a real 30-second wait per test. No test
  // asserts on the literal 30s production value, so this is safe to set
  // unconditionally for every harness-backed test.
  process.env.ROOM_TEARDOWN_GRACE_MS ??= '300';

  const mod = await import('../../src/server/index.js');
  if (!mod.server.listening) {
    await new Promise<void>((r) => mod.server.once('listening', () => r()));
  }

  return {
    port,
    dataDir,
    receivedBodies,
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
function startLlmStub(): Promise<{ server: Server; url: string; receivedBodies: string[] }> {
  return new Promise((resolve) => {
    const receivedBodies: string[] = [];
    const server = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        receivedBodies.push(body);
        let text: string;
        if (body.includes('You are a world builder for a TTRPG')) {
          text = JSON.stringify(LLM_STUB_REPLIES.worldSeed);
        } else if (body.includes('introducing a player to a world')) {
          // introduceWorld's system prompt is the only prompt in the server
          // that interpolates the campaign's dmPreset verbatim next to
          // "introducing a player to a world" (setupChat also interpolates
          // dmPreset, but its own branch further down is keyed on a
          // different, earlier-matched substring — see 'helping set up a
          // new game' below — so a test choosing this marker as its
          // dmPreset cannot accidentally land there instead). A test can
          // therefore pick EMPTY_INTRO_TRIGGER as a campaign's dmPreset to
          // deterministically exercise sendWorldIntroduction's
          // empty-introduction guard (src/server/index.ts) — real LLM
          // outages/hiccups return '' or whitespace-only text the same way.
          text = body.includes('EMPTY_INTRO_TRIGGER') ? '   \n\t  ' : LLM_STUB_REPLIES.worldIntroduction;
        } else if (body.includes('character creation API')) {
          // A special marker in the player's own text picks the thin-sheet
          // fixture regardless of turn count, so a test can trigger it
          // deterministically without disturbing the two-turn "done" flow
          // every other interview test relies on.
          if (body.includes('THIN_SHEET_TRIGGER')) {
            text = JSON.stringify(LLM_STUB_REPLIES.charInterviewThin);
          } else if (body.includes('NULL_DEFINITION_TRIGGER')) {
            // Forces definition: null regardless of turn count. The ordinary
            // two-turn "done" logic below always returns a definition once
            // playerTurns >= 2, so nothing exercised the char-chat handler's
            // "the model proposed nothing new this turn" fallback past turn
            // one — a marker on a LATER turn reuses the same null-definition
            // reply turn one gives, e.g. a plain clarifying question.
            text = JSON.stringify(LLM_STUB_REPLIES.charInterviewOpen);
          } else {
            // The interview turns "done" once the player has answered twice, so a
            // test can drive it deterministically instead of guessing turn counts.
            const playerTurns = (body.match(/"role":"user"/g) ?? []).length;
            text = JSON.stringify(playerTurns >= 2 ? LLM_STUB_REPLIES.charInterviewDone : LLM_STUB_REPLIES.charInterviewOpen);
          }
        } else if (body.includes('character sheet validation API')) {
          text = JSON.stringify(
            body.includes('MODIFICATIONS_TRIGGER')
              ? LLM_STUB_REPLIES.validationBadModifications
              : LLM_STUB_REPLIES.validation
          );
        } else if (body.includes('facilitating character creation negotiation')) {
          // negotiation.ts's DM-agent turn (both the opening summary and
          // every later round). Unique against every other system prompt in
          // the server — verified by grep before adding this branch.
          text = LLM_STUB_REPLIES.negotiationDmReply;
        } else if (body.includes('character creation discussion')) {
          // negotiation.ts's character-agent turn. The brief's suggested
          // dispatch substring for this branch was the prompt's literal
          // opening, 'You ARE '. Grepping every system prompt in the server
          // found that exact substring also opens the in-game action
          // agent's prompt (src/server/agents/character.ts: 'You ARE
          // ${d.name}. Stay completely in character.') — an earlier branch
          // wins in this dispatcher, so matching on it here would have
          // silently rerouted every live gameplay turn in every other test
          // into negotiation dialogue instead of action-agent output.
          // 'character creation discussion' is unique to this prompt only.
          text = LLM_STUB_REPLIES.negotiationCharReply;
        } else if (body.includes('helping set up a new game')) {
          const hostSpoke = body.includes('"role":"user"');
          text = JSON.stringify(hostSpoke ? LLM_STUB_REPLIES.setupDone : LLM_STUB_REPLIES.setupOpen);
        } else {
          text = 'Understood. Lets keep moving.';
        }
        // A marker in the negotiation transcript (carried in via a
        // negotiation-message's own text, same pattern as
        // MODIFICATIONS_TRIGGER/THIN_SHEET_TRIGGER above) holds this
        // response open briefly. Exists solely so a test can reliably land a
        // close() call — from host-approve-character, host-reject-character,
        // or room teardown — while a runAgentTurns()/open() await is still
        // outstanding, to prove the post-await `closed` re-check actually
        // stops the late reply from being appended/broadcast. Nothing else
        // in the offline suite includes this marker, so it costs no other
        // test any time.
        const respond = () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text }));
        };
        if (body.includes('RACE_DELAY_TRIGGER')) {
          setTimeout(respond, 600);
        } else {
          respond();
        }
      });
    });
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://localhost:${port}`, receivedBodies });
    });
  });
}
