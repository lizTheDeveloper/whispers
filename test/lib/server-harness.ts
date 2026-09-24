import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { getFreePort } from './ws-helpers.js';

/**
 * Put `slowLlmToken()` in a whisper and the FIRST LLM request that carries it
 * — the character's decideAction call, the next call a delivered whisper
 * feeds — is held open for SLOW_LLM_DELAY_MS and then answered with a valid
 * decision. That gives a test a reliable window to land a pause-game or
 * end-game while the call is in flight and prove the turn is halted rather
 * than applied. One-shot per token: the whisper also lands in the transcript
 * every later prompt quotes, and those must stay fast. Nothing else in the
 * offline suite uses the marker.
 */
export const SLOW_LLM_TRIGGER = 'SLOW_LLM_TRIGGER';
let slowTokenSeq = 0;
export function slowLlmToken(): string {
  return `${SLOW_LLM_TRIGGER}-${++slowTokenSeq}`;
}
const SLOW_LLM_DELAY_MS = 2500;

export const LLM_STUB_REPLIES = {
  // decideAction's answer to a SLOW_LLM_TRIGGER whisper (see above).
  slowDecision: {
    chosenAction: 'She works the crowbar into the lamp room door and heaves until the lock gives.',
    spokenWords: null,
    innerThought: 'The voice says the door first. Fine — the door first.',
    whisperedInfluence: 'followed',
    trustDelta: 0.05,
  },
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
  // Reproduces the live bug: the model narrates full instructions in `reply`
  // (prose), sets done: true, but leaves dmInstructions/dmCustomPrompt null —
  // a shape DmSetupReplySchema permits since both fields are nullable. Used
  // to prove the server does not advance state or tell the client done: true
  // for this reply, and does not fabricate dmInstructions from the prose.
  setupDoneNoInstructions: {
    reply: 'Great, I have everything I need — a haunted lighthouse, spooky but hopeful, with a missing relief keeper.',
    done: true,
    influences: ['Le Guin', 'Annihilation', 'Disco Elysium'],
    dmInstructions: null,
    dmCustomPrompt: null,
  },
  // Round 15 (RZBU7G), a gentle-peril host: the danger the setup chat offered.
  setupDrawerForever: {
    reply: 'Let’s talk about the "gentle peril" you mentioned. In this bureaucratic city, what does danger look like? Is it the risk of being filed away in a drawer forever? Getting lost in a maze of filing cabinets?',
    done: false,
    influences: [],
    dmInstructions: null,
    dmCustomPrompt: null,
  },
  setupGentleDanger: {
    reply: 'Let’s talk about the "gentle peril" you mentioned. What does trouble look like here — a form that keeps wandering off, a queue with opinions, a stamp nobody can find?',
    done: false,
    influences: [],
    dmInstructions: null,
    dmCustomPrompt: null,
  },
  // Reproduces the live bug behind "[llm-client] JSON parsed but Zod
  // rejected: done: Required" — the model omits `done` from the JSON
  // entirely rather than sending `done: false`. `done` is intentionally
  // absent from this object (not set to undefined) so JSON.stringify below
  // actually drops the key, matching the real wire shape.
  setupOpenNoDoneField: {
    reply: 'Tell me more about the mood you want for this world.',
    influences: [],
    dmInstructions: null,
    dmCustomPrompt: null,
  },
  // Round 17 (live 5YHBZS): a draft whose fields break the accept-time
  // limits — Mistress Prune's disposition ran to ~330 characters, and accept
  // refused it twice. Selected by LONG_SEED_TRIGGER in the host's chat.
  longWorldSeed: {
    premise: 'Liz and Biz have landed in the Department of Inter-Planar Transit, where a smudged stamp has misfiled them as a batch of overdue tax returns.',
    locations: [
      { name: 'The Antechamber of Forms', description: 'A vast, circular room of slowly rotating wooden desks.', terrain: 'indoor ' + 'and humming '.repeat(30) },
      { name: 'The Stairwell of Echoes', description: 'Every step repeats what you said on the last one.', terrain: 'indoor' },
      { name: 'The Opaline Desk', description: 'A desk with opinions.', terrain: 'indoor' },
    ],
    npcs: [
      { name: 'Mistress Prune', description: 'A spectacled bureaucrat with a dry voice.', disposition: "Irritated by the chaos of the misfiled, but deeply committed to the rules of the Department. She speaks in clipped, precise sentences and expects every form to be filled in triplicate. Underneath the starch she softens for children and anyone who apologises properly. She will not bend a rule, though she may lend you a pen.", motivation: 'She wants every form filed before the cycle resets.', pronouns: 'she/her' },
      { name: 'Clerk Bumble', description: 'A nervous clerk who fears hardware.', disposition: 'nervous', motivation: 'Keep his desk tidy.', pronouns: 'he/him' },
      { name: 'Mr. Whisk', description: 'A teapot who feels underappreciated.', disposition: 'huffy', motivation: 'Be called by his name.', pronouns: 'he/him' },
    ],
    plotHooks: ['The daily filing cycle resets at dusk.', 'A form keeps wandering off.', 'The stamp that misfiled them is missing.'],
    items: [{ name: 'Correction Form 7-B', description: 'Floating paper with a blue smudge.' }],
  },
  // A setup reply claiming a change to the world it cannot make (live
  // 5YHBZS). Selected by EDIT_CLAIM_TRIGGER in the host's latest message.
  setupClaimsEdit: {
    reply: 'Good catch!\n\nEverything else remains exactly as it was. Please try accepting the world again—let me know if that smooths out the error!',
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
      // The interview asks for pronouns; a finished interview sheet has them.
      pronouns: 'she/her',
    },
  },
  // A sheet that is finished in every other way, proposed before anyone said
  // how the character is referred to — and it guesses: "Fast on his feet"
  // (the live Biz bug). Selected by UNSTATED_PRONOUNS_TRIGGER.
  charInterviewGuessedGender: {
    reply: 'Here is Biz as I understand them.',
    definition: {
      name: 'Biz',
      highConcept: 'Ten-Year-Old Who Asks Why',
      trouble: 'Wanders off when something glows',
      aspects: ['Fast on his feet', 'Pocket full of bottle caps'],
      personality: 'Curious and restless.',
      backstory: 'Ten years old; collects bottle caps and questions.',
      skills: { Notice: 3, Athletics: 2 },
      stunts: ['Small and Quick: +2 to Stealth in tight spaces.'],
      pronouns: null,
    },
  },
  // The live interview bug: the message that asks for Liz's pronouns already
  // says "her". Selected by GENDERED_REPLY_TRIGGER; pronouns are still null.
  charInterviewGenderedReply: {
    reply: 'Liz sounds like someone who reads the fine print. How should I refer to Liz — she/her, he/him, they/them? And what would catch her attention first in the Lamp Room?',
    definition: { name: 'Liz', highConcept: 'Mom With a Clipboard Heart', trouble: '', aspects: [], personality: '', backstory: '', skills: {}, stunts: [], pronouns: null },
  },
  // Round 17 (live 5YHBZS): Biz's first message said "I use they/them"; the
  // reply asked for pronouns anyway, with no sheet. Selected by
  // PRONOUNS_ASKED_TRIGGER.
  charInterviewAsksPronouns: {
    reply: "Got it, Biz. You're a curious 10-year-old collector with a pocket full of bottle caps, and your trouble is wandering off after anything shiny. How should I refer to you in the sheet — she/her, he/him, they/them, or something else?",
    definition: null,
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
  // What a model answering "My name is Liz..." reports mid-interview: the
  // fields the player stated outright, nulls for what nobody has said yet
  // (a model's natural way to write "unknown"), and nothing that makes the
  // sheet finished — no aspects, no skills. Selected by
  // PARTIAL_SHEET_TRIGGER in the player's text.
  charInterviewPartial: {
    reply: 'Liz, then — a courier who never learned to say no. When the tide bell rings, where are you standing?',
    definition: {
      name: 'Liz',
      highConcept: 'Tidewater courier who knows every back stair',
      trouble: 'Cannot refuse a desperate request',
      aspects: [],
      personality: null,
      backstory: null,
      skills: {},
      stunts: ['Shortcut: +2 to Athletics when racing through the town'],
      age: null,
      pronouns: null,
      relationships: [],
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
  // negotiation.ts's history-compaction summary (summarizeHistory). Its own
  // dispatch substring, 'summarizing a character-negotiation discussion', is
  // unique against every other system prompt this server sends — see the
  // comment on that branch below and on summarizeHistory itself.
  negotiationCompactionSummary:
    'Recap: the host raised a balance question about the stunt, the player and character pushed back defending it as core to the concept, and no final call has been made yet.',
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
  /**
   * Simulates a server process dying and booting again on the same data dir
   * (a deploy, a crash): every live GameLoop is stopped without an epilogue,
   * every socket is dropped, the listener closes, and a FRESH copy of the
   * server module graph is imported — so boot-time code runs again against
   * the database the old process left behind. The LLM stub and its
   * receivedBodies survive, so a test can assert on traffic across the
   * restart. `port` changes; re-read it afterwards.
   */
  restart(): Promise<void>;
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
  // Reading-time pacing between beats (src/server/pacing.ts) off unless a
  // test asks for it — it would otherwise add 2-12s per beat to every test.
  process.env.PACE_MIN_MS ??= '0';
  process.env.PACE_MAX_MS ??= '0';

  let mod = await import('../../src/server/index.js');
  if (!mod.server.listening) {
    await new Promise<void>((r) => mod.server.once('listening', () => r()));
  }

  const harness: Harness = {
    port,
    dataDir,
    receivedBodies,
    async stop() {
      await new Promise<void>((r) => mod.server.close(() => r()));
      await new Promise<void>((r) => llm.server.close(() => r()));
      rmSync(dataDir, { recursive: true, force: true });
    },
    async restart() {
      for (const loop of mod.gameLoops.values()) loop.stop();
      mod.gameLoops.clear();
      for (const client of mod.wss.clients) client.terminate();
      await new Promise<void>((r) => mod.server.close(() => r()));
      const newPort = await getFreePort();
      process.env.PORT = String(newPort);
      vi.resetModules();
      mod = await import('../../src/server/index.js');
      if (!mod.server.listening) {
        await new Promise<void>((r) => mod.server.once('listening', () => r()));
      }
      harness.port = newPort;
    },
  };
  return harness;
}

/**
 * The host says "done" only after at least one message, so a test can drive a
 * campaign to "world set up" deterministically by sending exactly one dm-chat.
 */
/**
 * What the model's chat template would reject in a request body, or null.
 * Qwen's template needs at least one user turn and a system message only at
 * the start.
 */
export function chatTemplateViolation(body: string): string | null {
  let messages: Array<{ role?: unknown }>;
  try { messages = JSON.parse(body).messages; } catch { return 'unparseable body'; }
  if (!Array.isArray(messages) || messages.length === 0) return 'No messages';
  if (!messages.some(m => m?.role === 'user')) return 'No user query found in messages.';
  if (messages.some((m, i) => i > 0 && m?.role === 'system')) return 'System message must be at the beginning.';
  return null;
}

/** Every request the stub refused as the live chat template would, across every harness in this process. */
export const templateViolations: Array<{ body: string; violation: string }> = [];

function startLlmStub(): Promise<{ server: Server; url: string; receivedBodies: string[] }> {
  return new Promise((resolve) => {
    const receivedBodies: string[] = [];
    const consumedSlowTokens = new Set<string>();
    const server = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        receivedBodies.push(body);
        // The live model (qwen via the shared proxy) renders its chat
        // template before generating, and the template raises on a request
        // with no user turn ("No user query found in messages") or a system
        // message anywhere but first. The stub refuses the same requests
        // with the same 400, so a call site that sends one fails here the
        // way it fails live, instead of getting a canned reply.
        const violation = chatTemplateViolation(body);
        if (violation) {
          templateViolations.push({ body, violation });
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `raise_exception: ${violation}` }));
          return;
        }
        let text: string;
        const slowToken = body.match(new RegExp(`${SLOW_LLM_TRIGGER}-\\d+`))?.[0];
        const slow = !!slowToken && !consumedSlowTokens.has(slowToken);
        if (slowToken) consumedSlowTokens.add(slowToken);
        if (slow) {
          text = JSON.stringify(LLM_STUB_REPLIES.slowDecision);
        } else if (body.includes('TONE JUDGE for a family tabletop game')) {
          // The gentle-table tone judge (tone-gate.ts): the one live line the
          // round-15 setup-chat test offers is flagged; anything else is ok.
          text = body.includes('filed away in a drawer forever')
            ? JSON.stringify({ verdict: 'flag', phrases: ['being filed away in a drawer forever'] })
            : JSON.stringify({ verdict: 'ok', phrases: [] });
        } else if (body.includes('helping set up a new game') && body.includes('GENTLE_DRAWER_TRIGGER')) {
          // Round 15 (RZBU7G): at a gentle-peril table the setup chat offered
          // "the risk of being filed away in a drawer forever". Asked again
          // with the judge's feedback, it offers something gentle.
          text = JSON.stringify(body.includes('<tone_feedback>') ? LLM_STUB_REPLIES.setupGentleDanger : LLM_STUB_REPLIES.setupDrawerForever);
        } else if (body.includes('You are a world builder for a TTRPG')) {
          text = JSON.stringify(body.includes('LONG_SEED_TRIGGER') ? LLM_STUB_REPLIES.longWorldSeed : LLM_STUB_REPLIES.worldSeed);
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
          // TRUNCATED_INTRO_TRIGGER as the dmPreset answers like a reasoning
          // model starved of tokens: cut off mid-sentence at any budget up to
          // 3072, the finished introduction above that.
          const truncatedIntro = body.includes('TRUNCATED_INTRO_TRIGGER') && JSON.parse(body).max_tokens <= 3072;
          text = body.includes('EMPTY_INTRO_TRIGGER') ? '   \n\t  '
            : truncatedIntro ? `${LLM_STUB_REPLIES.worldIntroduction} Jolly de Sombra twirls a feathered hat that blushes`
            : LLM_STUB_REPLIES.worldIntroduction;
        } else if (body.includes('character creation API')) {
          // A special marker in the player's own text picks the thin-sheet
          // fixture regardless of turn count, so a test can trigger it
          // deterministically without disturbing the two-turn "done" flow
          // every other interview test relies on.
          if (body.includes('PRONOUNS_ASKED_TRIGGER')) {
            text = JSON.stringify(LLM_STUB_REPLIES.charInterviewAsksPronouns);
          } else if (body.includes('GENDERED_REPLY_TRIGGER')) {
            text = JSON.stringify(LLM_STUB_REPLIES.charInterviewGenderedReply);
          } else if (body.includes('UNSTATED_PRONOUNS_TRIGGER')) {
            text = JSON.stringify(LLM_STUB_REPLIES.charInterviewGuessedGender);
          } else if (body.includes('THIN_SHEET_TRIGGER')) {
            text = JSON.stringify(LLM_STUB_REPLIES.charInterviewThin);
          } else if (body.includes('NULL_DEFINITION_TRIGGER')) {
            // Forces definition: null regardless of turn count. The ordinary
            // two-turn "done" logic below always returns a definition once
            // playerTurns >= 2, so nothing exercised the char-chat handler's
            // "the model proposed nothing new this turn" fallback past turn
            // one — a marker on a LATER turn reuses the same null-definition
            // reply turn one gives, e.g. a plain clarifying question.
            text = JSON.stringify(LLM_STUB_REPLIES.charInterviewOpen);
          } else if (body.includes('PARTIAL_SHEET_TRIGGER')) {
            text = JSON.stringify(LLM_STUB_REPLIES.charInterviewPartial);
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
        } else if (body.includes('summarizing a character-negotiation discussion')) {
          // negotiation.ts's maybeCompactHistory -> summarizeHistory branch,
          // added alongside this task's removal of the negotiation round
          // cap. Checked before the substring dispatch below could matter —
          // this is a system prompt negotiation.ts writes nowhere near the
          // DM/character-agent prompts above, so grepped and confirmed
          // unique across every system prompt in src/server.
          text = LLM_STUB_REPLIES.negotiationCompactionSummary;
        } else if (body.includes('helping set up a new game')) {
          // The greeting carries a user turn of its own now (the chat
          // template needs one); it is a cue, not the host speaking.
          const hostSpoke = (JSON.parse(body).messages as Array<{ role: string; content: string }>)
            .some(m => m.role === 'user' && !m.content.includes('The host has just opened the setup chat'));
          // A marker in the host's own message text (same pattern as
          // THIN_SHEET_TRIGGER/MODIFICATIONS_TRIGGER above) selects the
          // done-but-no-instructions fixture deterministically, without
          // disturbing the ordinary hostSpoke -> setupDone flow every other
          // setup test relies on.
          const msgs = JSON.parse(body).messages as Array<{ role: string; content: string }>;
          const latestHost = [...msgs].reverse().find(m => m.role === 'user')?.content ?? '';
          if (hostSpoke && latestHost.includes('EDIT_CLAIM_TRIGGER')) {
            text = JSON.stringify(LLM_STUB_REPLIES.setupClaimsEdit);
          } else if (hostSpoke && body.includes('NO_INSTRUCTIONS_TRIGGER')) {
            text = JSON.stringify(LLM_STUB_REPLIES.setupDoneNoInstructions);
          } else if (body.includes('MISSING_DONE_TRIGGER')) {
            text = JSON.stringify(LLM_STUB_REPLIES.setupOpenNoDoneField);
          } else {
            text = JSON.stringify(hostSpoke ? LLM_STUB_REPLIES.setupDone : LLM_STUB_REPLIES.setupOpen);
          }
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
        } else if (slow) {
          setTimeout(respond, SLOW_LLM_DELAY_MS);
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
