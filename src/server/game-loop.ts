import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { DmAgent, describeRelationships, introduceCharacter, pronounsFor, type PartyMember } from './agents/dm.js';
import { CharacterAgent, type PartyMemberView } from './agents/character.js';
import type { DmOpening } from './agents/schemas.js';
import { ExtractorAgent } from './agents/extractor.js';
import { WorldBible } from './world-bible.js';
import { getInfluences, setCampaignPaused, setCampaignPhase } from './room.js';
import { loadStockScenario, getWorldSeed, seedWorld } from './world-seed.js';
import { CharacterMemoryStore } from './character-memory.js';
import { callProse, runWithLlmSignal } from './agents/llm-client.js';
import { rollDice } from './dice.js';
import { saveCheckpoint, loadCheckpoint, type CheckpointData } from './checkpoint.js';
import { appendReplayEntry, recordReplayBroadcast } from './replay-log.js';
import { getSessionTokenForCharacter } from './room.js';
import { trustHint as trustHintLine } from './trust-hint.js';
import { pacingFromEnv, ReadingClock } from './pacing.js';
import { shortenSuggestion, lowerFirst, endSentence } from './whisper-suggestions.js';
import { PLAIN_PROSE_STYLE } from './agents/style.js';
import { generateSceneImage, clearCampaignImageCache } from './image-gen.js';
import { transcriptVisibleTo, storyLines } from './transcript-visibility.js';
import type { Character, CharacterDefinition, CharacterState, TranscriptMessage, RoomState } from '../shared/types.js';
import type { PauseReason, ServerMessage } from '../shared/protocol.js';
import {
  premiseImpliesArrival, hasArrivalBeat, fallbackArrival, narratesTransport,
  repairAddress, namesInNarration, withoutPartyEntities, type AddressTerm,
  TAKEN_OUT, isTakenOut, recoverAtSceneBreak, declaredTakenOut, aidsCharacter,
} from './narrative-guards.js';

/**
 * Consecutive turns with no whisper from any human before the table pauses
 * itself (reason 'quiet'). One idle open tab used to keep a game spending
 * ~5 LLM calls a turn all the way to the session cap.
 */
export const QUIET_TURNS_BEFORE_PAUSE = 6;
// How long a character waits for a whisper before deciding alone. Read once
// at import (like index.ts's ROOM_TEARDOWN_GRACE_MS) so tests can shrink it.
const WHISPER_WINDOW_MS = parseInt(process.env.WHISPER_WINDOW_MS ?? '30000', 10);
// The first window of a session opens right after the arrival, the
// introductions and the first scene's narration land at once — a wall of
// text. Seen live: a player reading it (or on another tab) first saw the
// window at 3s left and lost the turn. It gets a second window's worth of
// reading time on top.
const FIRST_WHISPER_WINDOW_MS = parseInt(process.env.FIRST_WHISPER_WINDOW_MS ?? String(WHISPER_WINDOW_MS * 2), 10);

const BASE_COMPACTION_THRESHOLD = 35;
const BASE_COMPACTION_KEEP_RECENT = 12;

/** Result of routing one whisper through GameLoop.handleWhisper. */
export interface WhisperAck {
  status: 'delivered' | 'queued' | 'rejected';
  characterId: string | null;
  characterName: string | null;
  message: string;
}

const TITLES = new Set(['dame', 'sir', 'lord', 'lady', 'prince', 'princess', 'king', 'queen', 'duke', 'duchess', 'count', 'countess', 'baron', 'baroness', 'master', 'captain', 'elder', 'chief', 'sister', 'brother', 'father', 'mother', 'doctor', 'professor']);
function getFirstName(fullName: string): string {
  const parts = fullName.split(/\s+/);
  return parts.find(p => !TITLES.has(p.toLowerCase())) ?? parts[0]!;
}

/** A character's condition as it stands now: only consequences they still carry (a recovered one is gone from state). */
export function currentCondition(state: Pick<CharacterState, 'consequences'>): string {
  const now = state.consequences.map(c => (c === TAKEN_OUT ? 'taken out' : c));
  return now.length > 0 ? `current injuries: ${now.join(', ')}` : 'no current injuries';
}

/** "she/her" → "her", "he/him" → "him", "they/them" → "them", "xe/xem" → "xem"; null when not stated. */
function objectPronoun(pronouns: string | undefined | null): string | null {
  const parts = pronouns?.trim().toLowerCase().split(/[\/,\s]+/).filter(Boolean) ?? [];
  if (parts.length === 0) return null;
  if (parts[1]) return parts[1];
  return parts[0] === 'she' ? 'her' : parts[0] === 'he' ? 'him' : parts[0] === 'they' ? 'them' : null;
}

/**
 * The status line shown with a whisper prompt: "Liz is under heavy stress."
 * A pull from the trouble is its own sentence, in the character's own
 * pronouns — or their name when nobody has stated any.
 */
export function characterStatusLine(opts: {
  name: string;
  pronouns?: string | null;
  trouble: string;
  states: string[];
  troublePull: boolean;
}): string {
  const sentences: string[] = [];
  if (opts.states.length > 0) sentences.push(`${opts.name} is ${opts.states.join(', ')}.`);
  if (opts.troublePull) {
    const obj = objectPronoun(opts.pronouns);
    sentences.push(obj
      ? `${opts.name}'s trouble, "${opts.trouble}", is weighing on ${obj}.`
      : `The trouble "${opts.trouble}" is weighing on ${opts.name}.`);
  }
  if (sentences.length === 0) sentences.push(`${opts.name} is focused and alert.`);
  return sentences.join(' ');
}

export class GameLoop {
  private dm: DmAgent;
  private characterAgent = new CharacterAgent();
  private extractor = new ExtractorAgent();
  private worldBible: WorldBible;
  private memoryStore: CharacterMemoryStore;
  private transcript: TranscriptMessage[] = [];
  private state: RoomState;
  private characters = new Map<string, Character>();
  private pendingWhisperResolve: ((text: string | null) => void) | null = null;
  private pendingWhisperCharacterId: string | null = null;
  // Out-of-window whispers wait here for their character's next decision
  // window instead of evaporating (MUL-73). Volatile by design: a whisper
  // is a live attempt to speak, not durable state — after a server restart
  // the player is no longer at the table waiting.
  private whisperQueue = new Map<string, string[]>();
  private static readonly WHISPER_QUEUE_LIMIT = 3;
  private stopped = false;
  // Pause/stop plumbing. While paused, the loop parks on resumeGate at its
  // next checkpoint (awaitRunnable) and every in-flight LLM call is aborted
  // through llmAbort, which runScene's whole async tree reads ambiently (see
  // runWithLlmSignal). A resume swaps in a fresh controller.
  private pauseReason: PauseReason | null = null;
  private resumeGate: { promise: Promise<void>; release: () => void } | null = null;
  private llmAbort = new AbortController();
  private quietTurns = 0;
  private pendingWhisperTimer: ReturnType<typeof setTimeout> | null = null;
  private openWhisperPrompt: Extract<ServerMessage, { type: 'whisper-prompt' }> | null = null;
  // The owner-only half of the open prompt (mood, goals, suggestion chips).
  private openWhisperGuidance: Extract<ServerMessage, { type: 'whisper-guidance' }> | null = null;
  // Reading-time pacing (see pacing.ts). The clock knows when the table has
  // read every PUBLIC beat shown so far; pace() holds the next beat until
  // then. A pause freezes what is left of the wait (hold/release).
  private readingClock = new ReadingClock(pacingFromEnv());
  private paceWake: (() => void) | null = null;
  // Wall-clock close of the open whisper window while its countdown runs;
  // null while none is open or while a pause holds it.
  private whisperDeadline: number | null = null;
  private firstWhisperWindow = true;
  private sceneTurnCount = 0;
  private locationTurnCount = 0;
  private lastLocationName = '';
  // True between the narration-only opening and the first DM narration of
  // play, so that narration picks up from the arrival instead of re-setting
  // the stage the table just heard.
  private openingJustDelivered = false;
  private sceneWhisperStats = new Map<string, { name: string; followed: number; partial: number; ignored: number; trustStart: number; trustEnd: number }>();
  private broadcastFn: (msg: ServerMessage) => void;

  constructor(
    private db: Database.Database,
    private campaignId: string,
    broadcastFn: (msg: ServerMessage) => void,
    private sendToHostFn: (msg: ServerMessage) => void,
    initialState: RoomState,
    // Delivers to the one seat that plays `characterId` (and to no one when
    // nobody does). A character's private thinking travels only this way.
    private sendToOwnerFn: (characterId: string, msg: ServerMessage) => void = () => {},
  ) {
    this.dm = new DmAgent(db);
    this.worldBible = new WorldBible(db);
    this.memoryStore = new CharacterMemoryStore(db);
    this.state = initialState;
    // Everything the game view paints into #narration-log is broadcast
    // through this one funnel, so the playing-phase replay log — the thing
    // that refills a refreshed player's transcript (the playing-phase
    // analog of interview-replay) — is captured here rather than at a
    // dozen call sites. recordReplayBroadcast ignores message kinds that
    // never reach the log. A replay-write failure must never cost a live
    // table its broadcast, hence the try/catch: the log is recovery, play
    // is the product.
    this.broadcastFn = (raw: ServerMessage) => {
      // The narrative guards run here, on the way out, so nothing reaches a
      // player or the replay log unrepaired (see guardMessage).
      const msg = this.guardMessage(raw);
      try {
        recordReplayBroadcast(this.db, this.campaignId, msg);
      } catch (e) {
        console.error('[game-loop] replay-log append failed:', e);
      }
      this.readingClock.mark(msg);
      broadcastFn(msg);
    };
  }

  /**
   * A character's private thinking — their options, the whisper panel's
   * chips, their inner thought — to the seat that plays them and no one
   * else. The host sees it only when the host is that seat. A thought is a
   * log line, so it is also written to the replay log scoped to that seat's
   * session (the whisper-echo pattern), and a refresh restores it for them
   * alone.
   */
  private sendToOwner(characterId: string, raw: ServerMessage): void {
    const msg = this.guardMessage(raw);
    if (msg.type === 'character-thought') {
      try {
        const token = getSessionTokenForCharacter(this.db, this.campaignId, characterId);
        if (token) appendReplayEntry(this.db, this.campaignId, msg, token);
      } catch (e) {
        console.error('[game-loop] replay-log append (private) failed:', e);
      }
    }
    // No readingClock.mark here: a private beat must not hold the table.
    this.sendToOwnerFn(characterId, msg);
  }

  /**
   * A character's trust in the voice, stress, fate points, wounds and items —
   * the status line — go to the seat that plays them and no one else. Live, a
   * room broadcast put Liz's trust and FP on Biz's tab during Liz's turn.
   */
  private sendStateUpdate(characterId: string, state: CharacterState): void {
    this.sendToOwner(characterId, { type: 'character-state-update', characterId, state });
  }

  /** A live character's current state, for a (re)joining owner's status line. Null when this loop does not run them. */
  characterState(characterId: string): CharacterState | null {
    return this.characters.get(characterId)?.state ?? null;
  }

  /**
   * Hold the next beat until the table has read the last one. Pause parks
   * here (what is left of the wait resumes with the table); stop wakes it at
   * once. Resolves true to carry on, false once stopped. Every player waits
   * together, because the loop itself waits — the client just shows.
   */
  private async pace(): Promise<boolean> {
    for (;;) {
      if (!(await this.awaitRunnable())) return false;
      const wait = this.readingClock.remainingMs();
      if (wait <= 0) return true;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.paceWake = null; resolve(); }, wait);
        this.paceWake = () => { clearTimeout(timer); this.paceWake = null; resolve(); };
      });
    }
  }

  loadCharacters(): void {
    // A revoked character must not take turns — that is the exact scenario
    // revocation exists to prevent, so this feeds initiativeOrder only rows
    // that are still live.
    const rows = this.db.prepare('SELECT * FROM characters WHERE campaign_id = ? AND revoked_at IS NULL').all(this.campaignId) as any[];
    for (const row of rows) {
      this.characters.set(row.id, {
        id: row.id,
        campaignId: row.campaign_id,
        playerUserId: row.player_user_id,
        definition: JSON.parse(row.definition),
        state: JSON.parse(row.state),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
  }

  /**
   * The host's veto during play. Deleting from `this.characters` is what
   * actually does the work — every derived value reads from that map:
   * partySize is `this.characters.size`, partyMembers and the observer
   * loop iterate it, and processTurn already opens with
   * `const character = this.characters.get(characterId); if (!character)
   * return;`, so once this runs the revoked character's turn is a no-op
   * even if a round already in flight still has their id queued.
   *
   * `initiativeOrder` is reassigned via `filter`, never spliced in place.
   * runScene's round loop — `for (const charId of this.state.initiativeOrder)`
   * — has an `await` inside it, making it a live iterator over whatever
   * array `this.state.initiativeOrder` currently points at. Splicing would
   * mutate that same array out from under the in-flight iterator and shift
   * a later character's turn, silently skipping them. Reassigning binds a
   * new array instead, so the in-flight iterator keeps walking the old one
   * safely to completion, and every round built after this call reads the
   * new, revoked-character-free one.
   *
   * Deletion above is synchronous and unconditional — callers can read
   * `partySize` immediately after this returns and see the drop, same as
   * before. What's new is the check after it: revoking the last character
   * used to leave `initiativeOrder` empty with nothing else keyed to that
   * fact. `processTurn` is never called, so `currentTurn`/`sceneTurnCount`
   * (only incremented inside it) freeze — which is exactly the counters
   * `sessionHardLimit` and every round-count guard in `runScene` are keyed
   * off of — while `runScene`'s tail recursion has no idea any of that
   * happened and keeps calling the DM for narration every pass, unbounded,
   * stoppable only by the host hitting end-game. That is the same "nothing
   * left to stop it" failure start-game's own `countLiveCharacters === 0`
   * guard exists to prevent — this is just the same hole reached mid-game
   * instead of before it starts.
   *
   * Emptying the party ends the session rather than merely halting it,
   * because 'ended' is the only terminal phase the client already renders
   * (there is no separate "halted" phase in GamePhase to build a UI for),
   * and reusing `endGame()` — the exact path the host's own end-game
   * button drives — means an empty-party revoke gets the same epilogue and
   * phase-change broadcast as any other session end, not a bespoke dead
   * end. `endGame()` itself calls `stop()` first, so `this.stopped` flips
   * before the `await` below, which is what actually breaks `runScene`'s
   * recursion (every recursive call checks it) rather than the empty
   * `initiativeOrder` doing that job.
   *
   * Returns whether this call ended the game, so the caller (which owns
   * the `gameLoops` map this class has no reference to) knows to remove
   * this now-stopped loop from it — never leave a stopped loop parked in
   * that map as a zombie entry.
   *
   * `onEmptied`, if given, runs synchronously the instant emptying is
   * detected — BEFORE the `endGame()` await below, which includes a
   * multi-second epilogue generation call. This class has no reference to
   * the campaigns table (that's the caller's job, same as start-game's DB
   * write happening in index.ts, not here), but the caller needs to make
   * its own DB phase write at exactly this point, not after `endGame()`
   * resolves: end-game's own handler writes 'ended' to the DB BEFORE
   * calling `endGame()`, so the DB and the broadcast it eventually sends
   * agree on order. Awaiting this method fully before writing the DB phase
   * would reverse that — the DB would still say 'playing' for as long as
   * epilogue generation takes, after every connected client was already
   * told 'ended'.
   */
  async revokeCharacter(characterId: string, onEmptied?: () => void): Promise<boolean> {
    this.characters.delete(characterId);
    this.state.initiativeOrder = this.state.initiativeOrder.filter(id => id !== characterId);
    this.drainWhisperQueue(characterId);
    if (this.characters.size === 0 && !this.stopped) {
      onEmptied?.();
      await this.endGame();
      return true;
    }
    return false;
  }

  /** How many characters this loop is actually running turns for right now — the same count `runScene`'s own pacing math already reads off `this.characters.size` in half a dozen places. Exposed read-only for tests to confirm a revoke actually shrinks it. */
  get partySize(): number {
    return this.characters.size;
  }

  /**
   * The live party, id+name only — enough for the host's revoke UI to list
   * who is still at the table and for a rejoining client to resolve a
   * character-revoked broadcast to a name. Read fresh off `this.characters`
   * on every call rather than cached, so it never drifts from what
   * `revokeCharacter` above has actually deleted.
   */
  get rosterSnapshot(): Array<{ id: string; name: string }> {
    return Array.from(this.characters.values()).map(c => ({ id: c.id, name: c.definition.name }));
  }

  async start(): Promise<void> {
    this.loadCharacters();

    const checkpoint = loadCheckpoint(this.db, this.campaignId);
    const resuming = Boolean(checkpoint && checkpoint.state.currentTurn > 0);
    if (checkpoint && resuming) {
      this.state = { ...this.state, ...checkpoint.state, phase: 'playing' };
      this.state.initiativeOrder = Array.from(this.characters.keys());
      this.sceneTurnCount = checkpoint.state.sceneTurnCount ?? 0;

      if (checkpoint.transcript && checkpoint.transcript.length > 0) {
        this.transcript = checkpoint.transcript;
        console.log(`[game-loop] Restored ${this.transcript.length} transcript messages from checkpoint`);
      } else {
        const lastScene = this.db.prepare('SELECT summary FROM scenes WHERE campaign_id = ? ORDER BY scene_number DESC LIMIT 1').get(this.campaignId) as any;
        if (lastScene?.summary) {
          this.transcript = [{ role: 'system' as const, content: `[Resumed] ${lastScene.summary}`, timestamp: new Date().toISOString() }];
        }
      }
      console.log(`[game-loop] Resuming from checkpoint: scene ${this.state.currentScene}, turn ${this.state.currentTurn}`);
    } else {
      this.state.phase = 'playing';
      this.state.currentScene = 1;
      this.state.currentTurn = 0;
      this.state.initiativeOrder = Array.from(this.characters.keys());
    }

    this.broadcastFn({ type: 'phase-change', phase: 'playing' });
    // The only source the host's revoke UI (and the room's own
    // character-revoked notices, which need a name to show) has for who is
    // actually at the table — there is no other message that lists the live
    // party once play has started.
    this.broadcastFn({ type: 'character-roster', characters: this.rosterSnapshot });
    const campaign = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(this.campaignId) as any;

    // The world bible is seeded when the host accepts the world
    // (accept-world-seed), before anyone makes a character — so there is no
    // seeding left to do here. What start() owes a FRESH table is the
    // opening: the arrival and the introductions, narration only, before any
    // agent acts. A resumed table already had its opening.
    if (!resuming) {
      this.seedPartyRelationships();
      // Under the loop's signal like every other step, so pause and End Game
      // reach the opening's LLM call too.
      await runWithLlmSignal(() => this.llmAbort.signal, () => this.runOpening(campaign));
      if (this.stopped) return;
    }

    await runWithLlmSignal(() => this.llmAbort.signal, () => this.runScene(campaign));
  }

  /** Two names refer to the same person: exact (case-insensitive) or same first name ("Liz" ~ "Liz Harper"). */
  private namesMatch(a: string, b: string): boolean {
    const x = a.trim().toLowerCase();
    const y = b.trim().toLowerCase();
    if (!x || !y) return false;
    return x === y || getFirstName(a).toLowerCase() === getFirstName(b).toLowerCase();
  }

  /** The live party as the DM needs to know it — the real players, never setup placeholders. */
  private partyForDm(opts: { withBackstory?: boolean } = {}): PartyMember[] {
    return Array.from(this.characters.values()).map(c => ({
      ...(opts.withBackstory ? { backstory: c.definition.backstory } : {}),
      name: c.definition.name,
      highConcept: c.definition.highConcept,
      age: c.definition.age,
      pronouns: c.definition.pronouns,
      relationships: c.definition.relationships,
      ...(isTakenOut(c.state) ? { takenOut: true } : {}),
    }));
  }

  /**
   * DM-authored prose — narration, resolutions, summaries, the epilogue —
   * calls party members by name: "Biz steadies Mom" becomes "Biz steadies
   * Liz". Quoted speech is never touched. See namesInNarration.
   */
  private guardText(text: string): string {
    if (!text || this.characters.size === 0) return text;
    try {
      const terms = Array.from(this.characters.keys()).flatMap(id => this.addressTermsOf(id));
      const fixed = namesInNarration(text, terms);
      if (fixed !== text) console.log(`[guard] address term in narration replaced by a name: "${text.slice(0, 80)}" → "${fixed.slice(0, 80)}"`);
      return fixed;
    } catch (e) {
      console.error('[guard] narration name guard failed, text left as written:', e);
      return text;
    }
  }

  /** Extracted world facts without the party recorded as NPCs (see withoutPartyEntities). */
  private worldFacts<T extends { newEntities: Array<{ name: string }> }>(facts: T): T {
    const names = Array.from(this.characters.values()).map(c => c.definition.name);
    const terms = Array.from(this.characters.keys()).flatMap(id => this.addressTermsOf(id).map(t => t.address));
    return withoutPartyEntities(facts, names, terms);
  }

  /** What `speakerId` calls each companion, when that is not simply their name ("Mom" for Liz). */
  private addressTermsOf(speakerId: string): AddressTerm[] {
    const speaker = this.characters.get(speakerId);
    if (!speaker) return [];
    return (speaker.definition.relationships ?? []).flatMap(r => {
      const target = Array.from(this.characters.values()).find(o => o.id !== speakerId && this.namesMatch(r.to, o.definition.name));
      return target && r.address?.trim() ? [{ name: target.definition.name, address: r.address.trim() }] : [];
    });
  }

  /**
   * The single funnel every outgoing message passes through (the broadcast
   * wrapper calls it; addTranscript runs the same text guard). DM prose —
   * narration (the epilogue included), resolutions, scene summaries — gets
   * the narration name guard. A character's own action, thought and words
   * are theirs: "keeping Mom's hand" is right in Biz's mouth, so they get
   * only the address guard ("Mom Liz" → "Mom", and "Liz," → "Mom," in
   * Biz's speech).
   */
  private guardMessage(msg: ServerMessage): ServerMessage {
    switch (msg.type) {
      case 'narration': return { ...msg, text: this.guardText(msg.text) };
      case 'resolution': return { ...msg, text: this.guardText(msg.text) };
      case 'scene-end': return { ...msg, summary: this.guardText(msg.summary) };
      case 'action-taken': {
        const terms = this.addressTermsOf(msg.characterId);
        return {
          ...msg,
          action: repairAddress(msg.action, terms, { vocative: false }),
          innerThought: msg.innerThought === undefined ? undefined : repairAddress(msg.innerThought, terms, { vocative: false }),
          spokenWords: msg.spokenWords ? repairAddress(msg.spokenWords, terms, { vocative: true }) : msg.spokenWords,
        };
      }
      default: return msg;
    }
  }

  /** How `viewer` sees `other`: the relation and address term from viewer's sheet, or the reverse tie from other's. */
  private companionView(viewer: Character, other: Character): Pick<PartyMemberView, 'relation' | 'address' | 'viewerIsTheir' | 'age' | 'pronouns' | 'callsYou' | 'takenOut'> {
    const mine = (viewer.definition.relationships ?? []).find(r => this.namesMatch(r.to, other.definition.name));
    const theirTie = (other.definition.relationships ?? []).find(r => this.namesMatch(r.to, viewer.definition.name));
    const theirs = mine ? undefined : theirTie;
    const party = this.partyForDm();
    const member = party.find(p => p.name === other.definition.name);
    const pronouns = member ? pronounsFor(member, party) : null;
    const callsYou = theirTie?.address?.trim() && !this.namesMatch(theirTie.address, viewer.definition.name) ? theirTie.address.trim() : undefined;
    return {
      relation: mine?.relation,
      address: mine?.address,
      viewerIsTheir: theirs?.relation,
      age: other.definition.age,
      ...(pronouns ? { pronouns } : {}),
      ...(callsYou ? { callsYou } : {}),
      ...(isTakenOut(other.state) ? { takenOut: true } : {}),
    };
  }

  /** This character's own pronouns as the sheets state them, or undefined. */
  private ownPronouns(c: Character): string | undefined {
    const party = this.partyForDm();
    const member = party.find(p => p.name === c.definition.name);
    return (member && pronounsFor(member, party)) ?? undefined;
  }

  /** Mark a character taken out: out of action until the next scene, or until a companion helps them up. */
  private markTakenOut(c: Character): void {
    if (isTakenOut(c.state)) return;
    c.state.consequences.push(TAKEN_OUT);
    this.persistCharacterState(c);
  }

  /** Bring a taken-out character back into the action and tell the table. */
  private recoverFromTakenOut(c: Character, why: string): void {
    if (!isTakenOut(c.state)) return;
    c.state.consequences = c.state.consequences.filter(x => x !== TAKEN_OUT);
    console.log(`[game-loop] ${c.definition.name} recovers from being taken out — ${why}`);
    const text = `[${c.definition.name} comes round and is back in the action — ${why}]`;
    this.addTranscript('system', text);
    this.broadcastFn({ type: 'narration', text, sceneNumber: this.state.currentScene });
    this.persistCharacterState(c);
  }

  private persistCharacterState(c: Character): void {
    this.sendStateUpdate(c.id, c.state);
    this.db.prepare("UPDATE characters SET state = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(c.state), c.id);
  }

  /** DM prose that says a party member is taken out makes it so — the mechanics follow the story. */
  private applyDeclaredTakenOut(prose: string): void {
    for (const c of this.characters.values()) {
      if (isTakenOut(c.state)) continue;
      if (declaredTakenOut(prose, [c.definition.name]).length > 0) {
        console.log(`[game-loop] DM narration declared ${c.definition.name} taken out — marking them out of action`);
        this.markTakenOut(c);
      }
    }
  }

  /**
   * Stated relationships between party members go into the world bible's
   * relationships table, so the DM's world state carries them alongside
   * everything learned in play. Idempotent: the table is keyed on the pair.
   */
  private seedPartyRelationships(): void {
    for (const c of this.characters.values()) {
      for (const rel of c.definition.relationships ?? []) {
        const target = Array.from(this.characters.values()).find(o => o.id !== c.id && this.namesMatch(rel.to, o.definition.name));
        if (!target) continue;
        const [sentence] = describeRelationships({ name: c.definition.name, highConcept: c.definition.highConcept, relationships: [{ ...rel, to: target.definition.name }] });
        try {
          this.worldBible.addRelationship({ campaignId: this.campaignId, entityAId: c.id, entityBId: target.id, type: rel.relation, description: sentence ?? null });
        } catch (e) {
          console.error('[game-loop] could not record party relationship:', e);
        }
      }
    }
  }

  /**
   * The narration-only opening of a fresh game. First the scene is set — a
   * stock scenario's own openingNarration verbatim, otherwise the DM's
   * arrival built from the accepted premise — then each character is
   * introduced as the others would see them, stated relationships included.
   * No agent acts until this returns: start() awaits it before runScene.
   */
  private async runOpening(campaign: any): Promise<void> {
    const seed = getWorldSeed(this.db, this.campaignId);
    const stock = campaign.scenario_id ? loadStockScenario(campaign.scenario_id) : null;
    const scenarioOpening = stock?.openingNarration?.trim() || null;
    const premise = (seed?.premise ?? stock?.seed.premise ?? '').trim();
    // An isekai/portal/summoned premise (or backstory) is an arrival, and the
    // opening must show it happening to them — enforced below, not just asked.
    const arrivalExpected = !scenarioOpening && premiseImpliesArrival(premise, ...Array.from(this.characters.values()).map(c => c.definition.backstory));
    const places = this.worldBible.getAllLocationNames(this.campaignId).map(name => ({
      name,
      description: this.worldBible.getLocationByName(this.campaignId, name)?.description ?? null,
    }));

    // haltable: a pause mid-generation parks here and redoes the call on
    // resume, so the opening is neither delivered while paused nor doubled.
    const opening: DmOpening | null = await this.haltable<DmOpening | null>(() => this.dm.openScene({
        preset: campaign.dm_preset,
        houseRules: campaign.house_rules,
        dmInstructions: campaign.dm_instructions ?? null,
        dmCustomPrompt: campaign.dm_custom_prompt ?? null,
        campaignId: this.campaignId,
        worldSummary: '',
        transcript: this.transcript,
        systemId: campaign.system_id,
        influences: getInfluences(this.db, this.campaignId),
        // The opening alone also reads backstories: where they come from decides how they arrive.
        party: this.partyForDm({ withBackstory: true }),
      }, { premise, scenarioOpening, places, arrivalExpected }), (e) => {
      console.error('[game-loop] opening generation failed — opening from the premise and the character sheets instead:', e);
      return null;
    });
    if (this.stopped) return;

    let locationName: string | undefined;
    const proposed = opening?.currentLocationName?.trim();
    if (proposed) {
      const snapped = this.worldBible.getLocationByName(this.campaignId, proposed) ? proposed : this.worldBible.snapToKnownLocation(this.campaignId, proposed);
      const loc = snapped ? this.worldBible.getLocationByName(this.campaignId, snapped) : null;
      if (loc) {
        this.state.currentLocationId = loc.id;
        this.worldBible.markLocationVisited(this.campaignId, loc.id);
        locationName = loc.name;
      }
    }

    let sceneText = scenarioOpening ?? (opening?.narration.trim() || premise);
    if (arrivalExpected) sceneText = this.withArrival(sceneText, opening, premise);
    if (sceneText) {
      this.addTranscript('dm', sceneText);
      this.broadcastFn({ type: 'narration', text: sceneText, sceneNumber: this.state.currentScene, locationName });
    } else {
      console.warn(`[game-loop] campaign ${this.campaignId} has no premise or scenario opening — opening with introductions only`);
    }

    for (const id of this.state.initiativeOrder) {
      const c = this.characters.get(id);
      if (!c) continue;
      const text = this.introductionFor(c, opening);
      this.addTranscript('dm', text);
      this.broadcastFn({ type: 'narration', text, sceneNumber: this.state.currentScene });
    }
    this.openingJustDelivered = true;
    console.log(`[game-loop] Opening delivered (${scenarioOpening ? 'scenario' : opening?.narration.trim() ? 'DM' : 'premise'} scene-setting, ${this.characters.size} introductions)`);
  }

  /**
   * The opening of a transported party always carries exactly ONE arrival.
   * The DM is asked for the arrival and the scene as separate fields, the
   * scene starting after they have landed. In order:
   *  - the scene prose itself narrates the transport (the flash, being
   *    hurled out of the kitchen): that IS the arrival, and nothing is put
   *    in front of it — a second transport before it read as the party
   *    being moved twice ("…land hard. They blink…" then "A blinding flash
   *    … Liz and Biz are hurled from their waiting room…");
   *  - the DM's own `arrival` field, when it wrote a real one;
   *  - the scene prose alone, when it already lands the party (arrival
   *    language plus a party member or "they");
   *  - otherwise a deterministic line built from the premise, before the
   *    DM's scenery. A DM `arrival` that is only scenery is kept, after it.
   */
  private withArrival(sceneText: string, opening: DmOpening | null, premise: string): string {
    const names = Array.from(this.characters.values()).map(c => getFirstName(c.definition.name));
    const dmArrival = opening?.arrival?.trim() ?? '';
    const narration = opening?.narration.trim() ?? '';
    const partyWord = new RegExp(`\\b(${[...names, 'they', 'them', 'their', 'you'].map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
    let lead: string[];
    if (narration && narratesTransport(narration) && partyWord.test(narration)) {
      if (dmArrival) console.log('[game-loop] Opening scene narrates the transport itself — using it as the arrival, not the separate arrival field');
      return sceneText;
    } else if (dmArrival && hasArrivalBeat(dmArrival)) {
      lead = [dmArrival];
    } else if (!dmArrival && narration && hasArrivalBeat(narration) && partyWord.test(narration)) {
      return sceneText;
    } else {
      console.log('[game-loop] Opening had no arrival beat — adding one built from the premise');
      lead = [fallbackArrival(premise, names), dmArrival].filter(Boolean);
    }
    return [...lead, sceneText].filter(Boolean).join('\n\n');
  }

  /**
   * A character as the others see them: the DM's prose, with a natural
   * sentence added for any stated tie it really left out (the relation word
   * or its inverse plus the other name counts as stated), otherwise a plain
   * line from the sheet. See introduceCharacter.
   */
  private introductionFor(c: Character, opening: DmOpening | null): string {
    const fromDm = opening?.introductions.find(i => this.namesMatch(i.name, c.definition.name))?.text;
    const party = this.partyForDm();
    const member = party.find(p => p.name === c.definition.name)!;
    return introduceCharacter(member, fromDm, party);
  }

  stop(): void {
    this.stopped = true;
    // Cancel whatever the current turn is waiting on — its result would be
    // discarded anyway — and wake a parked loop so it can see it is done.
    this.llmAbort.abort();
    this.resumeGate?.release();
    this.resumeGate = null;
    this.clearWhisperTimer();
    this.openWhisperPrompt = null;
    this.openWhisperGuidance = null;
    this.paceWake?.();
    if (this.pendingWhisperResolve) {
      this.pendingWhisperResolve(null);
      this.pendingWhisperResolve = null;
    }
    this.pendingWhisperCharacterId = null;
    // Saved whispers die with the table, but loudly: the player who is
    // still carrying words learns they will never be adjudicated rather
    // than wondering why no verdict ever lands (MUL-73).
    this.drainWhisperQueue();
  }

  async endGame(): Promise<void> {
    // stop() has closed any open whisper window with no whisper, and the
    // turn waiting on it bails on isStopped — no silence verdict, no trust
    // change. Tell every client now, not after the epilogue and closing
    // reflections, so no countdown keeps running under the ending.
    this.stop();
    this.broadcastFn({ type: 'game-ending' });
    await this.generateEpilogue();
    this.broadcastFn({ type: 'phase-change', phase: 'ended' });
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get pausedReason(): PauseReason | null {
    return this.pauseReason;
  }

  /**
   * Pause the table. Persists first, then aborts every in-flight LLM call and
   * parks the loop at its next checkpoint: an aborted step is redone on
   * resume, never replaced by a fallback, and nothing half-finished is
   * applied. An open whisper window is held (its countdown stops) rather than
   * closed. Pausing an already-paused table only updates the reason — the
   * host pressing Pause on a quiet-paused table turns it into a host pause,
   * which a stray whisper no longer lifts. Returns whether anything changed.
   */
  pause(reason: PauseReason, by?: string): boolean {
    if (this.stopped || this.pauseReason === reason) return false;
    setCampaignPaused(this.db, this.campaignId, reason);
    const wasRunning = this.pauseReason === null;
    this.pauseReason = reason;
    if (wasRunning) {
      let release!: () => void;
      const promise = new Promise<void>(r => { release = r; });
      this.resumeGate = { promise, release };
      this.llmAbort.abort();
      this.clearWhisperTimer();
      // Freeze the reading wait: what is left of it resumes with the table.
      this.readingClock.hold();
      this.paceWake?.();
    }
    this.broadcastFn({ type: 'game-paused', paused: true, reason, by });
    return true;
  }

  /** Lift a pause: persist, re-arm a held whisper window, wake the loop. */
  resume(by?: string): boolean {
    if (this.stopped || this.pauseReason === null) return false;
    setCampaignPaused(this.db, this.campaignId, null);
    this.pauseReason = null;
    this.quietTurns = 0;
    this.llmAbort = new AbortController();
    this.readingClock.release();
    this.broadcastFn({ type: 'game-paused', paused: false, reason: null, by });
    if (this.pendingWhisperResolve) {
      // The window was held; give the table a fresh countdown for it, and
      // re-send its prompt so every client restarts theirs.
      this.armWhisperTimer(WHISPER_WINDOW_MS);
      if (this.openWhisperPrompt) {
        this.openWhisperPrompt = { ...this.openWhisperPrompt, windowMs: WHISPER_WINDOW_MS, remainingMs: WHISPER_WINDOW_MS };
        this.broadcastFn(this.openWhisperPrompt);
        // The re-sent prompt resets the owner's panel; refill it.
        if (this.openWhisperGuidance) this.sendToOwner(this.openWhisperGuidance.characterId, this.openWhisperGuidance);
      }
    }
    const gate = this.resumeGate;
    this.resumeGate = null;
    gate?.release();
    return true;
  }

  /**
   * Rebuild just enough state from the database to write an epilogue for a
   * table whose loop is gone (the server restarted under it) — End Game on a
   * restart-paused table still gets its closing narration.
   */
  restoreForEpilogue(): void {
    this.loadCharacters();
    const checkpoint = loadCheckpoint(this.db, this.campaignId);
    if (checkpoint) {
      this.state = { ...this.state, ...checkpoint.state };
      // The unfinished scene's story, so the epilogue can tell it.
      this.sceneTurnCount = checkpoint.state.sceneTurnCount ?? 0;
      if (checkpoint.transcript) this.transcript = checkpoint.transcript;
    }
  }

  /** Park while paused. Resolves true to carry on, false once stopped. */
  private async awaitRunnable(): Promise<boolean> {
    while (!this.stopped && this.resumeGate) await this.resumeGate.promise;
    return !this.stopped;
  }

  /**
   * One LLM-backed step of the turn flow, made pause-safe. A real failure
   * still takes the step's own fallback, exactly as before; a failure caused
   * by a pause (the call was aborted) never does — the loop parks and redoes
   * the call once resumed. Returns null only when the game was stopped, in
   * which case the caller must apply nothing and return.
   */
  private async haltable<T>(call: () => Promise<T>, fallback: (e: unknown) => T): Promise<T | null> {
    for (;;) {
      let result: { value: T } | null;
      try {
        result = { value: await call() };
      } catch (e) {
        result = this.stopped || this.pauseReason ? null : { value: fallback(e) };
      }
      if (!(await this.awaitRunnable())) return null;
      if (result) return result.value;
    }
  }

  /** The loop's own natural end (finale, session cap): same close-out as End Game, plus the DB write end-game's handler would have made. */
  private async finishSession(): Promise<void> {
    this.broadcastFn({ type: 'game-ending' });
    await this.generateEpilogue();
    setCampaignPhase(this.db, this.campaignId, 'ended');
    setCampaignPaused(this.db, this.campaignId, null);
    this.broadcastFn({ type: 'phase-change', phase: 'ended' });
    this.stopped = true;
  }

  private async runScene(campaign: any): Promise<void> {
    if (!(await this.awaitRunnable())) return;
    const partySize = this.characters.size || 1;
    const sessionHardLimit = 50 + (partySize - 1) * 10;
    if ((this.state.currentTurn ?? 0) >= sessionHardLimit) {
      console.log(`[game-loop] Session hard limit (${sessionHardLimit} turns, party ${partySize}) — ending session`);
      await this.endScene();
      if (this.stopped) return;
      await this.finishSession();
      return;
    }

    let worldSummary = this.worldBible.getSummary(this.campaignId, this.state.currentLocationId ?? undefined);
    const npcHint = this.getNpcEngagementHint();
    if (npcHint) worldSummary += '\n' + npcHint;
    const whisperHint = this.getWhisperTensionHint();
    if (whisperHint) worldSummary += '\n' + whisperHint;
    const narrateArgs = {
      ctx: {
        preset: campaign.dm_preset,
        houseRules: campaign.house_rules,
        dmInstructions: campaign.dm_instructions ?? null,
        dmCustomPrompt: campaign.dm_custom_prompt ?? null,
        campaignId: this.campaignId,
        worldSummary,
        transcript: this.transcript,
        systemId: campaign.system_id,
        influences: getInfluences(this.db, this.campaignId),
        party: this.partyForDm(),
      },
      pacing: {
        sceneNumber: this.state.currentScene,
        sceneTurnCount: this.sceneTurnCount,
        characterSummaries: this.getCharacterSummaries(),
        partySize: this.characters.size || 1,
        sessionTurnCount: this.state.currentTurn,
        locationTurnCount: this.locationTurnCount,
        currentLocationName: this.lastLocationName || undefined,
        knownLocationNames: this.worldBible.getAllLocationNames(this.campaignId),
        unvisitedLocationNames: this.worldBible.getUnvisitedLocationNames(this.campaignId),
        isFinale: this.state.currentScene >= 4 && (this.state.currentTurn ?? 0) >= 18,
        afterOpening: this.openingJustDelivered && this.sceneTurnCount === 0,
      },
    };
    this.openingJustDelivered = false;
    const narration = await this.haltable(async () => {
      let narration = await this.dm.narrate(narrateArgs.ctx, narrateArgs.pacing);
      if (this.isDegenerateNarration(narration.narration)) {
        console.log(`[game-loop] Degenerate narration detected ("${narration.narration.slice(0, 40)}..."), retrying`);
        narration = await this.dm.narrate(narrateArgs.ctx, narrateArgs.pacing);
      }
      return narration;
    }, (e) => {
      console.error('[game-loop] narration failed:', e);
      return { narration: 'The scene continues...', currentLocationName: '', activeNpcs: [] as string[], isSceneEnd: false };
    });
    if (!narration) return;

    this.addTranscript('dm', narration.narration);
    this.applyDeclaredTakenOut(narration.narration);

    if (narration.currentLocationName) {
      if (narration.currentLocationName === this.lastLocationName) {
        this.locationTurnCount++;
      } else {
        this.locationTurnCount = 1;
        this.lastLocationName = narration.currentLocationName;
      }
      let loc = this.worldBible.getLocationByName(this.campaignId, narration.currentLocationName);
      if (!loc) {
        const snapped = this.worldBible.snapToKnownLocation(this.campaignId, narration.currentLocationName);
        if (snapped) {
          console.log(`[game-loop] Location snapped: "${narration.currentLocationName}" → "${snapped}"`);
          narration.currentLocationName = snapped;
          loc = this.worldBible.getLocationByName(this.campaignId, snapped);
        }
      }
      if (!loc) {
        const knownNames = this.worldBible.getAllLocationNames(this.campaignId);
        if (knownNames.length > 0) {
          const unvisitedNames = knownNames.filter(n => {
            const l = this.worldBible.getLocationByName(this.campaignId, n);
            return l && !this.worldBible.isLocationVisited(this.campaignId, l.id);
          });
          const fallbackName = unvisitedNames.length > 0
            ? unvisitedNames[Math.floor(Math.random() * unvisitedNames.length)]!
            : knownNames[Math.floor(Math.random() * knownNames.length)]!;
          console.log(`[game-loop] DM invented "${narration.currentLocationName}" — force-redirecting to "${fallbackName}" (${unvisitedNames.length} unvisited available)`);
          narration.currentLocationName = fallbackName;
          loc = this.worldBible.getLocationByName(this.campaignId, fallbackName)!;
        } else {
          const newId = randomBytes(16).toString('hex');
          this.worldBible.addLocation({ id: newId, campaignId: this.campaignId, name: narration.currentLocationName, description: null, terrain: null, connections: [], coords: null });
          loc = { id: newId, campaignId: this.campaignId, name: narration.currentLocationName, description: null, terrain: null, connections: [], coords: null };
          console.log(`[game-loop] Auto-created location "${narration.currentLocationName}" (no known locations exist)`);
        }
      }
      this.state.currentLocationId = loc.id;
      this.worldBible.markLocationVisited(this.campaignId, loc.id);
      if (narration.activeNpcs.length > 0) {
        console.log(`[game-loop] Location: "${loc.name}" (${this.locationTurnCount} turns) — NPCs present: ${narration.activeNpcs.join(', ')}`);
      }
      for (const npcName of narration.activeNpcs) {
        this.worldBible.updateEntityLocation(this.campaignId, npcName, loc.id);
        this.worldBible.ensureEntity(this.campaignId, npcName, loc.id);
        this.worldBible.markEntityKnown(this.campaignId, npcName);
      }

      generateSceneImage(this.campaignId, narration.currentLocationName, narration.narration)
        .then(result => {
          if (result.imageUrl) {
            this.broadcastFn({ type: 'scene-image', imageUrl: result.imageUrl, locationName: narration.currentLocationName });
          }
        })
        .catch(() => {});
    }

    if (!(await this.pace())) return;
    this.broadcastFn({ type: 'narration', text: narration.narration, sceneNumber: this.state.currentScene, locationName: narration.currentLocationName || undefined });

    const roundCount = Math.floor(this.sceneTurnCount / partySize);
    const isFinale = this.state.currentScene >= 4 && (this.state.currentTurn ?? 0) >= 18;
    const baseHardCap = partySize >= 3 ? Math.max(6, 10 - partySize) : partySize === 2 ? 8 : 10;
    const hardCap = isFinale ? Math.min(baseHardCap, 6) : baseHardCap;
    const forceSceneEnd = roundCount >= hardCap;
    if (forceSceneEnd) {
      console.log(`[game-loop] Forcing scene end at round ${roundCount} (${isFinale ? 'finale' : 'hard'} cap)`);
    }

    const escalateThreshold = partySize <= 1 ? 6 : Math.max(4, 7 - partySize);
    const minRounds = this.state.currentScene <= 1
      ? (partySize >= 3 ? 4 : partySize === 2 ? 4 : 5)
      : this.state.currentScene >= 4 ? 3
      : escalateThreshold;
    const allowSceneEnd = roundCount >= minRounds || forceSceneEnd;
    if (narration.isSceneEnd && !allowSceneEnd) {
      console.log(`[game-loop] DM requested scene end at round ${roundCount} but min is ${minRounds} — suppressed`);
    }
    if ((narration.isSceneEnd && allowSceneEnd) || forceSceneEnd) {
      await this.endScene();
      if (this.stopped) return;
      if (isFinale) {
        console.log(`[game-loop] Finale scene concluded — session complete`);
        await this.finishSession();
        return;
      }
      if (!this.stopped) await this.runScene(campaign);
      return;
    }

    const charNames = this.state.initiativeOrder.map(id => this.characters.get(id)?.definition.name ?? `UNKNOWN(${id})`);
    console.log(`[game-loop] Round start: ${charNames.length} characters: ${charNames.join(', ')}`);
    for (const charId of this.state.initiativeOrder) {
      if (!(await this.awaitRunnable())) return;
      if (this.quietTurns >= QUIET_TURNS_BEFORE_PAUSE) {
        console.log(`[game-loop] ${this.quietTurns} turns without a whisper — pausing until someone speaks or the host resumes`);
        this.pause('quiet');
        if (!(await this.awaitRunnable())) return;
      }
      await this.processTurn(charId, campaign);
    }

    if (!this.stopped) await this.runScene(campaign);
  }

  private async processTurn(characterId: string, campaign: any): Promise<void> {
    const character = this.characters.get(characterId);
    if (!character) return;
    // Who was already down before this turn: only they can be helped up by it.
    const downBeforeTurn = new Set(Array.from(this.characters.values()).filter(c => isTakenOut(c.state)).map(c => c.id));

    if (isTakenOut(character.state)) {
      // Down and out of action: no proposals, no whisper window, no action.
      // They come back at the next scene, or when a companion helps them up.
      console.log(`[game-loop] Skipping ${character.definition.name} — taken out and recovering`);
      const first = getFirstName(character.definition.name);
      if (!(await this.pace())) return;
      this.broadcastFn({ type: 'narration', text: `[${first} is still down — out of action until someone helps ${first} up, or the scene ends]`, sceneNumber: this.state.currentScene });
      this.state.currentTurn++;
      this.sceneTurnCount++;
      return;
    }

    this.state.currentTurn++;
    this.sceneTurnCount++;
    this.state.activeCharacterId = characterId;

    const TRUST_BASELINE = 0.50;
    const TRUST_DRIFT_RATE = 0.06;
    const preDrift = character.state.whisperTrust;
    const drift = (TRUST_BASELINE - preDrift) * TRUST_DRIFT_RATE;
    if (Math.abs(drift) > 0.001) {
      character.state.whisperTrust = Math.max(0.10, Math.min(0.95, preDrift + drift));
      console.log(`[game-loop] Trust drift: ${character.definition.name} ${preDrift.toFixed(3)} → ${character.state.whisperTrust.toFixed(3)} (${drift > 0 ? '+' : ''}${drift.toFixed(3)})`);
    }

    const worldSummary = this.worldBible.getSummary(this.campaignId, this.state.currentLocationId ?? undefined);
    // Whatever the story has named so far — narration, resolutions, spoken
    // actions, the scenario opening, a restored checkpoint — is now known to
    // the party. Whispers are private and excluded.
    this.worldBible.revealMentioned(this.campaignId, storyLines(this.transcript).map(m => m.content).join('\n'));
    // Characters get only what the party knows; the DM keeps worldSummary.
    const charWorldContext = this.worldBible.getPlayerKnowledge(this.campaignId, this.state.currentLocationId ?? undefined);
    const charRelationships = this.worldBible.getCharacterRelationships(this.campaignId, characterId, character.definition.name);
    const fullCharContext = [charWorldContext, charRelationships].filter(Boolean).join('\n');
    const sessionRecap = this.transcript.find(m => m.role === 'system' && m.content.startsWith('[Session recap]'))?.content ?? '';
    const recentDm = this.transcript.filter(m => m.role === 'dm').slice(-3).map(m => m.content).join('\n');
    const sceneNarration = sessionRecap ? `${sessionRecap}\n${recentDm}` : recentDm;

    const recallContext = [sceneNarration, fullCharContext].filter(Boolean).join('\n');
    const memories = this.memoryStore.recall(characterId, 8, recallContext);
    if (memories.length > 0) console.log(`[memory] ${character.definition.name}: recalled ${memories.length} memories for context`);

    const partyMembers = Array.from(this.characters.entries())
      .filter(([id]) => id !== characterId)
      .map(([id, c]): PartyMemberView => {
        const lastAction = this.transcript.filter(m => m.role === 'character' && m.characterId === id).slice(-1)[0]?.content;
        return { name: c.definition.name, highConcept: c.definition.highConcept, trouble: c.definition.trouble, stress: c.state.stress, lastAction: lastAction || undefined, ...this.companionView(character, c) };
      });
    const ownPronouns = this.ownPronouns(character);

    const proposals = await this.haltable(() => this.characterAgent.proposeActions({
        definition: character.definition,
        state: character.state,
        sceneNarration,
        transcript: transcriptVisibleTo(this.transcript, characterId),
        memories,
        worldContext: fullCharContext,
        partyMembers,
        ownPronouns,
      }), (e) => {
      console.error('[game-loop] action proposal failed:', e);
      return { actions: [{ description: 'Look around cautiously', reasoning: 'Default action' }, { description: 'Press forward despite the uncertainty', reasoning: 'Fallback bold option' }] };
    });
    if (!proposals) return;

    for (const a of proposals.actions) {
      a.description = a.description.replace(/\*+/g, '').replace(/_+/g, '').replace(/^#+\s*/, '').trim();
    }

    if (!(await this.pace())) return;
    this.sendToOwner(characterId, {
      type: 'action-proposals',
      characterId,
      characterName: character.definition.name,
      actions: proposals.actions.map(a => a.description),
      actionReasons: proposals.actions.map(a => a.reasoning),
      whisperTrust: character.state.whisperTrust,
    });

    this.sendStateUpdate(characterId, character.state);
    this.state.awaitingWhisper = true;
    const mood = this.buildCharacterMood(character, memories);
    const trustHint = this.buildTrustHint(character);
    const companionLastAction = this.getCompanionLastAction(characterId);
    const suggestions = this.buildWhisperSuggestions(character, proposals.actions.map(a => a.description), sceneNarration, companionLastAction);
    const goals = this.characterAgent.deriveGoals(memories);
    // Drain this character's saved whispers BEFORE the window opens: a
    // player who spoke between windows is heard now (MUL-73), and a
    // whisper that lands after this drain simply queues for the next
    // window rather than racing a half-open slot. carryingQueued tells
    // the client not to render a countdown it cannot win — the wait below
    // is skipped when saved words are already in hand.
    const carrying = this.whisperQueue.get(characterId);
    if (carrying) this.whisperQueue.delete(characterId);
    const carryingSaved = !!carrying && carrying.length > 0;
    // The window's length travels with the prompt so the client counts down
    // from what the server will actually wait, not a number of its own.
    const windowMs = carryingSaved ? 0 : (this.firstWhisperWindow ? FIRST_WHISPER_WINDOW_MS : WHISPER_WINDOW_MS);
    // The table sees who is deciding and the countdown; the mood, goals and
    // suggestion chips are built from this character's private options, so
    // they go to the seat that plays them, right behind the prompt.
    const whisperPrompt: Extract<ServerMessage, { type: 'whisper-prompt' }> = {
      type: 'whisper-prompt', characterId, characterName: character.definition.name,
      carryingQueued: carrying?.length,
      ...(carryingSaved ? {} : { windowMs, remainingMs: windowMs }),
    };
    const guidance: Extract<ServerMessage, { type: 'whisper-guidance' }> = {
      type: 'whisper-guidance', characterId, mood, trustHint, suggestions,
      goals: goals.length > 0 ? goals : undefined,
    };
    if (!(await this.pace())) return;
    this.broadcastFn(whisperPrompt);
    if (!carryingSaved) this.sendToOwner(characterId, guidance);

    let whisper: string | null;
    if (carryingSaved) {
      whisper = carrying!.join('\n');
    } else {
      this.firstWhisperWindow = false;
      this.openWhisperPrompt = whisperPrompt;
      this.openWhisperGuidance = guidance;
      whisper = await this.waitForWhisper(characterId, windowMs);
      this.openWhisperPrompt = null;
      this.openWhisperGuidance = null;
    }
    // A whisper that landed in a window the pause was holding is kept: the
    // turn picks up here with it once the host resumes.
    if (!(await this.awaitRunnable())) return;
    this.state.awaitingWhisper = false;
    this.quietTurns = whisper ? 0 : this.quietTurns + 1;

    if (whisper) {
      this.addTranscript('whisper', whisper, characterId);
    }

    const decision = await this.haltable(() => this.characterAgent.decideAction(
        { definition: character.definition, state: character.state, sceneNarration, transcript: transcriptVisibleTo(this.transcript, characterId), memories, worldContext: fullCharContext, partyMembers, ownPronouns },
        whisper,
      ), (e) => {
      console.error('[game-loop] action decision failed:', e);
      const fallbackAction = proposals.actions[0]?.description ?? 'Waits and observes';
      return {
        chosenAction: fallbackAction,
        spokenWords: null as string | null,
        innerThought: `I should ${fallbackAction.toLowerCase()} — the situation demands action, even if I'm uncertain.`,
        whisperedInfluence: 'ignored' as const,
        trustDelta: 0,
      };
    });
    if (!decision) return;

    decision.chosenAction = decision.chosenAction.replace(/\*+/g, '').replace(/_+/g, '').replace(/^#+\s*/, '').trim();
    if ('spokenWords' in decision && decision.spokenWords) {
      decision.spokenWords = decision.spokenWords.replace(/\*+/g, '').replace(/_+/g, '').trim();
    }
    // The address guard, here at the source so the transcript line, the
    // DM's ruling and every screen carry the same text: Biz calls Liz
    // "Mom", in speech and in thought.
    const addressTerms = this.addressTermsOf(characterId);
    if (addressTerms.length > 0) {
      if (decision.spokenWords) decision.spokenWords = repairAddress(decision.spokenWords, addressTerms, { vocative: true });
      decision.innerThought = repairAddress(decision.innerThought, addressTerms, { vocative: false });
      decision.chosenAction = repairAddress(decision.chosenAction, addressTerms, { vocative: false });
    }

    if (decision.chosenAction.trim().length < 20) {
      console.log(`[game-loop] Degenerate action detected (${decision.chosenAction.trim().length} chars: "${decision.chosenAction.trim()}"), using proposal fallback`);
      decision.chosenAction = proposals.actions[0]?.description ?? 'Surveys the surroundings, weighing the options carefully';
    }

    const genericPatterns = [
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
    if (genericPatterns.some(p => p.test(decision.innerThought))) {
      const truncAtWord = (s: string, max: number) => {
        if (s.length <= max) return s;
        const cut = s.lastIndexOf(' ', max);
        let result = cut > max * 0.4 ? s.slice(0, cut) : s.slice(0, max);
        result = result.replace(/\s+(a|an|the|and|or|but|in|on|at|to|of|for|with|my|their|its|this|that)\s*$/i, '');
        return result;
      };
      const actionSnippet = truncAtWord(decision.chosenAction
        .replace(/^I\s+/i, '')
        .replace(/^(try|attempt|decide|choose|want|drawing on|invoking|using) (to\s+)?/i, '')
        .split(/[.!]/)[0]?.trim() ?? 'act', 50);
      const rawMemory = memories.length > 0
        ? truncAtWord(memories[0]!.content.split(/[.!]/)[0]?.trim() ?? '', 60) || null
        : null;
      const fixPronouns = (s: string) => s.replace(/\bi\b/g, 'I').replace(/\bi'/g, "I'");
      let memoryPhrase: string | null = null;
      if (rawMemory) {
        const memIdx = Math.floor(character.state.stress + character.state.fatePoints + (this.state.currentTurn ?? 0)) % 4;
        if (/^I\s/i.test(rawMemory)) {
          const verb = fixPronouns(rawMemory.replace(/^I\s+/i, ''));
          const starters = [`The memory of when I ${verb} steadies me`, `I remember — I ${verb}`, `Having ${verb} before, I know what to do`, `Drawing on when I ${verb}`];
          memoryPhrase = starters[memIdx]!;
        } else {
          const starters = [`I recall ${fixPronouns(rawMemory)}`, `The thought of ${fixPronouns(rawMemory)} lingers`, `Remembering ${fixPronouns(rawMemory)}`, `${fixPronouns(rawMemory)} echoes in my mind`];
          memoryPhrase = starters[memIdx]!;
        }
      }
      const contextDetail = memoryPhrase
        ? `${memoryPhrase} — now I need to ${actionSnippet.toLowerCase()}`
        : `I'm going to ${actionSnippet.toLowerCase()} — ${character.state.stress >= 2 ? 'the pressure is mounting and I cannot afford another mistake' : 'this is my best move given what I know'}`;
      decision.innerThought = `${contextDetail}.`;
    }

    decision.innerThought = decision.innerThought.replace(/\bi\b/g, 'I').replace(/\bi'/g, "I'");

    let actionTranscript = `${character.definition.name}: ${decision.chosenAction}`;
    if (decision.spokenWords) {
      actionTranscript += ` — "${decision.spokenWords}"`;
    }
    this.addTranscript('character', actionTranscript, characterId);
    if (whisper) {
      const influenceNote = decision.whisperedInfluence === 'followed'
        ? `${character.definition.name} heeded the whisper`
        : decision.whisperedInfluence === 'partially-followed'
        ? `${character.definition.name} partially heeded the whisper`
        : `${character.definition.name} resisted the whisper`;
      this.addTranscript('system', `[${influenceNote}, trust: ${character.state.whisperTrust.toFixed(2)}]`, characterId);
    }
    // The table sees what they did and said; what they thought, and how they
    // took the whisper, is for the seat that plays them.
    if (!(await this.pace())) return;
    this.broadcastFn({
      type: 'action-taken',
      characterId,
      characterName: character.definition.name,
      action: decision.chosenAction,
      spokenWords: decision.spokenWords ?? null,
    });
    this.sendToOwner(characterId, {
      type: 'character-thought',
      characterId,
      characterName: character.definition.name,
      innerThought: decision.innerThought,
      whisperInfluence: whisper ? decision.whisperedInfluence : 'none',
    });

    let effectiveDelta = decision.trustDelta;
    if (whisper && effectiveDelta === 0) {
      if (decision.whisperedInfluence === 'ignored') {
        effectiveDelta = -0.08;
      } else if (decision.whisperedInfluence === 'partially-followed') {
        effectiveDelta = character.state.whisperTrust < 0.40 ? 0.06
          : character.state.whisperTrust < 0.60 ? 0.04
          : character.state.whisperTrust < 0.75 ? 0.02
          : 0;
      } else {
        effectiveDelta = character.state.whisperTrust < 0.50 ? 0.08
          : character.state.whisperTrust < 0.70 ? 0.05
          : character.state.whisperTrust < 0.85 ? 0.03
          : 0.015;
      }
    }
    const currentTrust = character.state.whisperTrust;
    if (currentTrust >= 0.80 && effectiveDelta > 0) {
      effectiveDelta *= currentTrust >= 0.90 ? 0.25 : 0.5;
    }
    const recoveryCap = currentTrust < 0.40 && effectiveDelta > 0 ? 0.12 : 0.08;
    if (effectiveDelta > recoveryCap) effectiveDelta = recoveryCap;
    character.state.whisperTrust = Math.max(0.10, Math.min(0.95, currentTrust + effectiveDelta));
    if (recoveryCap === 0.12 && effectiveDelta > 0) {
      console.log(`[game-loop] Low-trust recovery boost: ${character.definition.name} trust ${currentTrust.toFixed(2)} → ${character.state.whisperTrust.toFixed(2)} (+${effectiveDelta.toFixed(2)}, cap raised to 0.12)`);
    }

    if (whisper) {
      if (!this.sceneWhisperStats.has(characterId)) {
        this.sceneWhisperStats.set(characterId, { name: character.definition.name, followed: 0, partial: 0, ignored: 0, trustStart: currentTrust, trustEnd: character.state.whisperTrust });
      }
      const stats = this.sceneWhisperStats.get(characterId)!;
      stats.trustEnd = character.state.whisperTrust;
      if (decision.whisperedInfluence === 'followed') stats.followed++;
      else if (decision.whisperedInfluence === 'partially-followed') stats.partial++;
      else stats.ignored++;
    }

    const diceResult = rollDice(this.getSystemDefaultDice(campaign.system_id));
    this.addTranscript('dice', diceResult.description);

    // The DM starts writing the ruling now, while the table reads the action;
    // the dice appear once the action has been read, and the ruling once the
    // dice have had their glance AND it is written — whichever is later, so
    // the reading time runs under the LLM call instead of on top of it. The
    // roll is fixed here, so a pause redoes only the ruling on resume — same
    // action, same roll. On a stop the call is aborted and resolves null.
    const ruling = this.haltable(() => this.dm.resolve(
        {
          preset: campaign.dm_preset, houseRules: campaign.house_rules,
          dmInstructions: campaign.dm_instructions ?? null, dmCustomPrompt: campaign.dm_custom_prompt ?? null,
          campaignId: this.campaignId, worldSummary, transcript: this.transcript, systemId: campaign.system_id,
          influences: getInfluences(this.db, this.campaignId),
          party: this.partyForDm(),
        },
        decision.spokenWords
          ? `${decision.chosenAction} — says: "${decision.spokenWords}"`
          : decision.chosenAction,
        diceResult,
        this.state.currentScene,
        {
          id: characterId, name: character.definition.name, skills: character.definition.skills,
          stress: character.state.stress, consequences: character.state.consequences, fatePoints: character.state.fatePoints,
          aspects: character.definition.aspects, highConcept: character.definition.highConcept, trouble: character.definition.trouble,
          inventory: character.state.inventory,
          partyMembers: Array.from(this.characters.entries())
            .filter(([id]) => id !== characterId)
            .map(([id, c]) => ({ id, name: c.definition.name, ...(isTakenOut(c.state) ? { takenOut: true } : {}) })),
        },
      ), (e) => {
      console.error('[game-loop] resolution failed, narrating without mechanics:', e);
      const actionSummary = (decision.chosenAction
        .replace(/^I\s+/i, '')
        .replace(/^(try|attempt|decide|choose|want) to\s+/i, '')
        .split(/[.!]/)[0] ?? '')
        .trim()
        .slice(0, 80);
      return {
        diceExpression: null, difficulty: null, skill: null,
        outcome: 'tie' as const,
        narration: `${getFirstName(character.definition.name)} pushes through, but the cost is felt immediately.`,
        stateChanges: [{ characterId, field: 'stress' as const, action: 'set' as const, value: Math.min(character.state.stress + 1, 3) }],
      };
    });
    ruling.catch(() => {}); // awaited below; never an unhandled rejection if we bail first
    if (!(await this.pace())) return;
    this.broadcastFn({ type: 'dice-roll', result: diceResult, context: decision.chosenAction });
    const resolution = await ruling;
    if (!resolution) return;

    if (resolution.narration === '__FALLBACK__') {
      const fallbackAction = (decision.chosenAction
        .replace(/^I\s+/i, '')
        .replace(/^(try|attempt|decide|choose|want|drawing on|invoking|using) (to\s+)?/i, '')
        .replace(/\bmy\b/gi, 'the')
        .replace(/\bmyself\b/gi, getFirstName(character.definition.name).toLowerCase())
        .replace(/\bI('m|'ll|'ve|'d)?\b/g, getFirstName(character.definition.name))
        .split(/[.!]/)[0] ?? '')
        .trim()
        .slice(0, 80);
      const firstName = getFirstName(character.definition.name);
      const outcomeNarration = resolution.outcome === 'failure'
        ? `${firstName}'s effort falls short — the situation worsens despite the attempt.`
        : resolution.outcome === 'tie'
        ? `${firstName} pushes through, but the cost is felt immediately.`
        : resolution.outcome === 'success-with-cost'
        ? `${firstName} succeeds, but not without a price.`
        : `${firstName} acts decisively, and the moment shifts in their favor.`;
      resolution.narration = outcomeNarration;
    }

    if (diceResult && resolution.difficulty != null && resolution.skill && campaign.system_id === 'fate-core') {
      if (resolution.difficulty > 8) {
        console.log(`[game-loop] FATE difficulty capped: DM set ${resolution.difficulty}, max is 8 (Legendary)`);
        resolution.difficulty = 8;
      }
      if (resolution.difficulty < 0) resolution.difficulty = 0;
      const skillKey = Object.keys(character.definition.skills).find(k => k.toLowerCase() === resolution.skill!.toLowerCase());
      const skillRank = skillKey ? (character.definition.skills[skillKey] ?? 0) : 0;
      const diffFloor = Math.max(0, skillRank - 1);
      if (resolution.difficulty < diffFloor) {
        console.log(`[game-loop] FATE difficulty floored: DM set ${resolution.difficulty}, skill ${resolution.skill} +${skillRank} → min difficulty ${diffFloor}`);
        resolution.difficulty = diffFloor;
      }
      const effort = diceResult.total + skillRank;
      const shifts = effort - resolution.difficulty;
      const correctOutcome: 'success' | 'failure' | 'tie' | 'success-with-cost' =
        shifts >= 1 ? 'success'
        : shifts === 0 ? 'tie'
        : shifts >= -2 ? 'success-with-cost'
        : 'failure';
      if (resolution.outcome !== correctOutcome) {
        console.log(`[game-loop] FATE outcome corrected: DM said ${resolution.outcome}, math says ${correctOutcome} (effort ${effort} vs diff ${resolution.difficulty}, shifts ${shifts})`);
        const dmSaid = resolution.outcome;
        resolution.outcome = correctOutcome;
        if (dmSaid === 'success' && (correctOutcome === 'tie' || correctOutcome === 'success-with-cost' || correctOutcome === 'failure')) {
          const correctionBeats: Record<string, string[]> = {
            tie: [
              `But the victory isn't clean — something slips, cracks, or shifts in the process.`,
              `Yet something catches — a snag, a cost, a complication they didn't foresee.`,
              `The moment teeters between triumph and consequence.`,
            ],
            'success-with-cost': [
              `But the price is steep — the effort leaves its mark.`,
              `Success, yes — but the kind that leaves bruises.`,
              `They push through, but the strain shows.`,
            ],
            failure: [
              `But the numbers don't lie — the attempt falls short, and the situation shifts against them.`,
              `Yet despite the effort, circumstances conspire — and the moment slips away.`,
              `But fate has other plans — the attempt crumbles under scrutiny.`,
            ],
          };
          const beats = correctionBeats[correctOutcome] ?? [];
          if (beats.length > 0) {
            resolution.narration = resolution.narration.trimEnd().replace(/\.?$/, '. ') + beats[(this.state.currentTurn ?? 0) % beats.length];
          }
        }
      }

      if (campaign.dm_preset === 'professor') {
        const ladderNames = ['Mediocre', 'Average', 'Fair', 'Good', 'Great', 'Superb', 'Fantastic', 'Epic', 'Legendary'];
        const diffName = ladderNames[resolution.difficulty] ?? `+${resolution.difficulty}`;
        const effortName = ladderNames[Math.max(0, Math.min(effort, 8))] ?? `+${effort}`;
        const dSign = diceResult.total >= 0 ? '+' : '';
        const aside = shifts >= 1
          ? `(${resolution.skill} +${skillRank} with dice ${dSign}${diceResult.total} = ${effortName} (+${effort}) vs ${diffName} (+${resolution.difficulty}) — ${shifts} shift${shifts !== 1 ? 's' : ''} of success!)`
          : shifts === 0
          ? `(${resolution.skill} +${skillRank} ties the ${diffName} (+${resolution.difficulty}) difficulty — a tie means you succeed, but at a minor cost.)`
          : `(${resolution.skill} +${skillRank} with dice ${dSign}${diceResult.total} = +${effort} vs ${diffName} (+${resolution.difficulty}) — ${Math.abs(shifts)} shift${Math.abs(shifts) !== 1 ? 's' : ''} short.${character.state.fatePoints > 0 ? ' An aspect invoke for +2 could have changed this!' : ''})`;
        resolution.narration = resolution.narration.trimEnd().replace(/\.?$/, '. ') + aside;
      }
    }

    const fpSpentByDm = resolution.stateChanges.some(c => c.field === 'fatePoints' && c.action === 'set' && typeof c.value === 'number' && c.value < character.state.fatePoints);
    if (!fpSpentByDm && character.state.fatePoints > 0) {
      const searchText = `${decision.chosenAction} ${decision.innerThought}`.toLowerCase();
      const allAspects = [character.definition.highConcept, ...character.definition.aspects].filter(Boolean);

      const intentPhrases = /\b(drawing on|invoking|calling upon|channeling|relying on|using)\s+(my|the|their)\b/i;
      const hasInvokeIntent = intentPhrases.test(decision.chosenAction) || intentPhrases.test(decision.innerThought);

      const stopWords = new Set(['never', 'that', 'tell', 'have', 'been', 'from', 'with', 'into', 'over', 'even', 'just', 'only', 'also', 'very', 'when', 'then', 'than', 'them', 'they', 'this', 'what', 'will', 'more', 'some', 'know', 'take', 'come', 'make']);
      const invoked = allAspects.some(aspect => {
        const words = aspect.toLowerCase().split(/[\s-]+/).filter(w => w.length > 3 && !stopWords.has(w));
        if (words.length === 0) return false;
        const matches = words.filter(w => searchText.includes(w));
        return matches.length >= 1;
      });
      const peakSkillRank = Math.max(...Object.values(character.definition.skills), 0);
      const usedSkillIsTop = resolution.skill && peakSkillRank >= 3 &&
        Object.entries(character.definition.skills).some(([k, v]) =>
          k.toLowerCase() === resolution.skill!.toLowerCase() && v >= peakSkillRank);
      const skillMasteryInvoke = usedSkillIsTop && (resolution.difficulty ?? 0) >= 3;

      if (invoked || hasInvokeIntent || skillMasteryInvoke) {
        const newFp = character.state.fatePoints - 1;
        resolution.stateChanges.push({ characterId, field: 'fatePoints' as const, action: 'set' as const, value: newFp });
        const reason = invoked ? 'aspect keyword match' : hasInvokeIntent ? 'invoke-intent phrase' : `skill mastery (${resolution.skill} +${peakSkillRank} vs diff ${resolution.difficulty})`;
        console.log(`[game-loop] Aspect invocation (${reason}) in "${decision.chosenAction.slice(0, 60)}" — ${character.definition.name} spends 1 FP (${character.state.fatePoints} → ${newFp})`);
      }
    }

    const fpAlreadySpentThisTurn = resolution.stateChanges.some(c => c.field === 'fatePoints' && c.action === 'set' && typeof c.value === 'number' && c.value < character.state.fatePoints);
    if (campaign.system_id === 'fate-core' && character.state.fatePoints >= 2 && !fpSpentByDm && !fpAlreadySpentThisTurn) {
      if (resolution.outcome === 'tie' || resolution.outcome === 'success-with-cost') {
        const currentFp = character.state.fatePoints;
        const newFp = currentFp - 1;
        resolution.stateChanges.push({ characterId, field: 'fatePoints' as const, action: 'set' as const, value: newFp });
        const upgradedOutcome = resolution.outcome === 'tie' ? 'success' : 'success';
        const bestAspect = character.definition.highConcept;
        console.log(`[game-loop] Auto-invoke: ${character.definition.name} spends 1 FP (${currentFp} → ${newFp}) on "${bestAspect}" — ${resolution.outcome} → ${upgradedOutcome}`);
        resolution.outcome = upgradedOutcome;
        const invokeFirst = getFirstName(character.definition.name);
        const invokeBeats = [
          `${invokeFirst} draws on "${bestAspect}" — and the tide turns.`,
          `Something shifts — "${bestAspect}" — and ${invokeFirst} finds a way through.`,
          `${invokeFirst} channels "${bestAspect}," turning a near-miss into a decisive moment.`,
        ];
        resolution.narration += ' ' + invokeBeats[(this.state.currentTurn ?? 0) % invokeBeats.length];
        this.addTranscript('system', `[${character.definition.name} invokes "${bestAspect}" for +2 — outcome upgraded to ${upgradedOutcome}! (${newFp} FP remaining)]`);
      }
    }

    const preResolutionStress = character.state.stress;
    const preConsequences = [...character.state.consequences];
    const preInventory = [...(character.state.inventory ?? [])];
    const affectedCharIds = new Set<string>();
    for (const change of resolution.stateChanges) {
      if (change.characterId && change.field && change.action) {
        this.applyStateChange(change.characterId, change.field, change.action, change.value);
        affectedCharIds.add(change.characterId);
      }
    }

    const narrationLower = resolution.narration.toLowerCase();
    const firstName = getFirstName(character.definition.name);
    const newConsequences = character.state.consequences.filter(c => !preConsequences.includes(c) && c !== TAKEN_OUT);
    for (const cons of newConsequences) {
      if (!narrationLower.includes(cons.toLowerCase().split(/\s+/)[0]!)) {
        resolution.narration += ` ${firstName} winces — ${cons.toLowerCase()}.`;
        console.log(`[game-loop] Added un-narrated consequence: "${cons}"`);
      }
    }
    const gainedItems = (character.state.inventory ?? []).filter(i => !preInventory.includes(i));
    for (const item of gainedItems) {
      if (!narrationLower.includes(item.toLowerCase().split(/\s+/)[0]!)) {
        resolution.narration += ` ${firstName} pockets the ${item.toLowerCase()}.`;
        console.log(`[game-loop] Added un-narrated item gain: "${item}"`);
      }
    }
    const lostItems = preInventory.filter(i => !(character.state.inventory ?? []).includes(i));
    for (const item of lostItems) {
      if (!narrationLower.includes(item.toLowerCase().split(/\s+/)[0]!)) {
        resolution.narration += ` The ${item.toLowerCase()} is gone.`;
        console.log(`[game-loop] Added un-narrated item loss: "${item}"`);
      }
    }

    for (const cid of affectedCharIds) {
      const c = this.characters.get(cid);
      if (c && c.state.stress >= 3 && c.state.consequences.length >= 2) {
        const takenOutMsg = `${c.definition.name} is TAKEN OUT — overwhelmed by stress and injuries, they collapse or are forced to retreat. The opposition decides what happens next.`;
        this.addTranscript('system', takenOutMsg);
        this.broadcastFn({ type: 'narration', text: takenOutMsg, sceneNumber: this.state.currentScene });
        c.state.stress = 1;
        if (!isTakenOut(c.state)) c.state.consequences.push(TAKEN_OUT);
      }
    }
    // …and when the DM's prose says someone is taken out, so do the mechanics.
    this.applyDeclaredTakenOut(resolution.narration);
    for (const c of this.characters.values()) if (isTakenOut(c.state)) affectedCharIds.add(c.id);

    // A companion who is down gets back up when this character helps them
    // and it does not fail outright.
    if (resolution.outcome !== 'failure') {
      const aidText = `${decision.chosenAction} ${decision.spokenWords ?? ''}`;
      for (const other of this.characters.values()) {
        if (other.id === characterId || !isTakenOut(other.state) || !downBeforeTurn.has(other.id)) continue;
        const namesForThem = [getFirstName(other.definition.name), other.definition.name, ...this.addressTermsOf(characterId).filter(t => t.name === other.definition.name).map(t => t.address)];
        if (aidsCharacter(aidText, namesForThem)) {
          this.recoverFromTakenOut(other, `${getFirstName(character.definition.name)} helps ${getFirstName(other.definition.name)} up`);
        }
      }
    }

    const lastCompelTurn = (character as any)._lastCompelTurn ?? -Infinity;
    if (this.state.currentTurn - lastCompelTurn >= 3) {
      let shouldCompel = false;
      if (resolution.outcome === 'failure') {
        shouldCompel = true;
      } else if (resolution.outcome === 'success-with-cost') {
        shouldCompel = true;
      } else if (resolution.outcome === 'tie' && character.state.fatePoints <= 1) {
        shouldCompel = true;
      } else if (character.state.fatePoints === 0 && this.state.currentTurn - lastCompelTurn >= 4) {
        shouldCompel = true;
        console.log(`[game-loop] Proactive compel: ${character.definition.name} at 0 FP for ${this.state.currentTurn - lastCompelTurn} turns — GM keeps the economy flowing`);
      }
      if (shouldCompel) {
        character.state.fatePoints = Math.min(character.state.fatePoints + 1, 5);
        (character as any)._lastCompelTurn = this.state.currentTurn;
        console.log(`[game-loop] Compel triggered: "${character.definition.trouble}" on ${resolution.outcome} — ${character.definition.name} now at ${character.state.fatePoints} FP`);
        this.addTranscript('system', `[Compel: "${character.definition.trouble}" — ${character.definition.name} earns a fate point (${character.state.fatePoints} FP)]`);
        const compelFirst = getFirstName(character.definition.name);
        const compelTrouble = character.definition.trouble;
        const compelVariants = [
          `${compelFirst} feels the pull of old habits — "${compelTrouble}" — and the universe grants a small mercy in return.`,
          `But "${compelTrouble}" rears its head, complicating everything — though fate offers ${compelFirst} a consolation.`,
          `"${compelTrouble}" — the words could be ${compelFirst}'s epitaph. But fate is generous to those it torments.`,
          `The shadow of "${compelTrouble}" falls across ${compelFirst}'s path once more, and with it comes a glimmer of fate's favor.`,
          `${compelFirst}'s "${compelTrouble}" makes itself known at precisely the wrong moment — as it always does.`,
        ];
        resolution.narration += `\n\n${compelVariants[(this.state.currentTurn ?? 0) % compelVariants.length]}`;
        affectedCharIds.add(characterId);
      }
    }

    if (whisper && decision.whisperedInfluence !== 'ignored') {
      const preTrust = character.state.whisperTrust;
      let outcomeDelta = 0;
      if (resolution.outcome === 'failure') {
        outcomeDelta = -0.06;
      } else if (resolution.outcome === 'success-with-cost') {
        outcomeDelta = -0.03;
      }
      const gainedStress = character.state.stress > preResolutionStress;
      if (gainedStress && outcomeDelta === 0) {
        outcomeDelta = -0.02;
      }
      if (outcomeDelta !== 0) {
        if (preTrust < 0.25 && outcomeDelta < 0) {
          outcomeDelta *= 0.5;
        }
        character.state.whisperTrust = Math.max(0.10, Math.min(0.95, preTrust + outcomeDelta));
        console.log(`[game-loop] Post-resolution trust: ${character.definition.name} ${resolution.outcome}${gainedStress ? '+stress' : ''} after following whisper — trust ${preTrust.toFixed(2)} → ${character.state.whisperTrust.toFixed(2)} (${outcomeDelta > 0 ? '+' : ''}${outcomeDelta.toFixed(2)})`);
      }
    }

    const actionWords = new Set(decision.chosenAction.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 3));
    if (actionWords.size > 0) {
      const sentences = resolution.narration.split(/(?<=[.!?])\s+/);
      if (sentences.length > 1) {
        const firstWords = sentences[0]!.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 3);
        const overlap = firstWords.filter(w => actionWords.has(w)).length;
        if (overlap >= Math.min(4, actionWords.size * 0.6)) {
          resolution.narration = sentences.slice(1).join(' ');
          console.log(`[game-loop] Stripped echo sentence (${overlap} overlapping words)`);
        }
      }
    }

    this.addTranscript('dm', resolution.narration);
    if (!(await this.pace())) return;
    this.broadcastFn({ type: 'resolution', text: resolution.narration });

    affectedCharIds.add(characterId);
    for (const cid of affectedCharIds) {
      const c = this.characters.get(cid);
      if (c) {
        this.sendStateUpdate(cid, c.state);
        this.db.prepare("UPDATE characters SET state = ?, updated_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(c.state), cid);
      }
    }

    this.memoryStore.extractAndStore(
      characterId, this.campaignId, character.definition.name,
      decision.chosenAction, resolution.narration, whisper,
      this.state.currentScene, this.state.currentTurn,
    ).then(stored => {
      if (stored.length > 0) console.log(`[memory] ${character.definition.name}: stored ${stored.length} memories (${stored.map(m => m.type).join(', ')})`);
    }).catch(e => console.error('[memory] extraction failed:', e));

    for (const [observerId, observer] of this.characters) {
      if (observerId === characterId) continue;
      this.memoryStore.storeObservation(
        observerId, this.campaignId, observer.definition.name,
        character.definition.name, decision.chosenAction, resolution.narration,
        this.state.currentScene, this.state.currentTurn,
      ).catch(e => console.error(`[memory] observer extraction failed for ${observer.definition.name}:`, e));
    }

    this.state.sceneTurnCount = this.sceneTurnCount;
    saveCheckpoint(this.db, this.campaignId, this.state.currentScene, this.state.currentTurn, this.state, this.transcript);

    if ((this.state.currentTurn ?? 0) % 4 === 0) {
      const recentForExtraction = this.transcript.slice(-8);
      this.extractor.extractFacts(recentForExtraction, this.state.currentScene)
        .then(facts => {
          const total = facts.newLocations.length + facts.newEntities.length + facts.newItems.length + facts.newEvents.length + facts.newRelationships.length;
          if (total > 0) {
            this.worldBible.applyDiff(this.campaignId, this.worldFacts(facts), { markKnown: true });
            console.log(`[game-loop] Periodic extraction (turn ${this.state.currentTurn}): ${total} facts (${facts.newEvents.length} events, ${facts.newRelationships.length} rels, ${facts.newEntities.length} entities)`);
          }
        })
        .catch(e => console.error('[game-loop] Periodic extraction failed:', (e as Error).message?.slice(0, 100)));
    }

    await this.maybeCompactTranscript();
  }

  private async maybeCompactTranscript(): Promise<void> {
    const partySize = this.characters.size || 1;
    const compactionThreshold = BASE_COMPACTION_THRESHOLD + (partySize - 1) * 12;
    const compactionKeepRecent = BASE_COMPACTION_KEEP_RECENT + (partySize - 1) * 4;
    if (this.transcript.length < compactionThreshold) return;

    console.log(`[game-loop] Transcript compaction triggered at ${this.transcript.length} messages (threshold: ${compactionThreshold}, party: ${partySize})`);
    const extractCount = this.transcript.length - compactionKeepRecent;
    const toExtract = this.transcript.slice(0, extractCount);
    const toKeep = this.transcript.slice(extractCount);

    try {
      const facts = await this.extractor.extractFacts(toExtract, this.state.currentScene);
      this.worldBible.applyDiff(this.campaignId, this.worldFacts(facts), { markKnown: true });
    } catch (e) {
      console.error('Mid-scene fact extraction failed:', e);
    }
    // Paused or stopped mid-compaction: leave the transcript whole. The
    // threshold still holds, so the next completed turn compacts it.
    if (this.stopped || this.pauseReason) return;

    const charNames = Array.from(this.characters.values()).map(c => c.definition.name);
    // The recap replaces these lines in every character's view, so it is
    // written from the story alone: no whisper text, no DM-only world facts.
    const worldState = this.worldBible.getPlayerKnowledge(this.campaignId, this.state.currentLocationId ?? undefined);
    let summary: string;
    try {
      summary = await this.dm.summarizeScene(storyLines(toExtract), charNames, worldState);
    } catch (e) {
      if (this.stopped || this.pauseReason) return;
      console.error('[game-loop] Compaction summary failed, using last DM narration as recap:', e);
      const lastDm = toExtract.filter(m => m.role === 'dm').slice(-1)[0]?.content;
      summary = lastDm ?? 'The adventure continues...';
    }
    if (this.stopped || this.pauseReason) return;

    summary = this.guardText(summary);
    this.transcript = [
      { role: 'system' as const, content: `[Session recap] ${summary}`, timestamp: new Date().toISOString() },
      ...toKeep,
    ];
    console.log(`[game-loop] Compaction complete: ${extractCount} messages → 1 summary + ${toKeep.length} kept = ${this.transcript.length} total`);
  }

  private async endScene(): Promise<void> {
    const charNames = Array.from(this.characters.values()).map(c => c.definition.name);
    // Becomes the next scene's "[Previous scene]" line that every character
    // reads — so, like compaction, story only: no whispers, no DM secrets.
    const worldState = this.worldBible.getPlayerKnowledge(this.campaignId, this.state.currentLocationId ?? undefined);
    const rawSummary = await this.haltable(() => this.dm.summarizeScene(storyLines(this.transcript), charNames, worldState), (e) => {
      console.error('[game-loop] Scene summary failed:', e);
      return 'The scene draws to a close.';
    });
    if (rawSummary === null) return;
    // Guarded once here, so the broadcast, the stored scene and the next
    // scene's "[Previous scene]" line all carry the same repaired text.
    const summary = this.guardText(rawSummary);
    const whisperStats = Array.from(this.sceneWhisperStats.values()).map(s => ({
      name: s.name,
      followed: s.followed,
      partial: s.partial,
      ignored: s.ignored,
      trustDelta: Math.round((s.trustEnd - s.trustStart) * 100) / 100,
    }));
    if (!(await this.pace())) return;
    this.broadcastFn({ type: 'scene-end', summary, sceneNumber: this.state.currentScene, whisperStats: whisperStats.length > 0 ? whisperStats : undefined });

    this.db.prepare('INSERT INTO scenes (id, campaign_id, scene_number, transcript, summary) VALUES (?, ?, ?, ?, ?)')
      .run(randomBytes(16).toString('hex'), this.campaignId, this.state.currentScene, JSON.stringify(this.transcript), summary);

    try {
      const facts = await this.extractor.extractFacts(this.transcript, this.state.currentScene);
      console.log('[game-loop] Fact extraction succeeded:', JSON.stringify({
        locations: facts.newLocations.length,
        entities: facts.newEntities.length,
        items: facts.newItems.length,
        events: facts.newEvents.length,
        relationships: facts.newRelationships.length,
      }));
      this.worldBible.applyDiff(this.campaignId, this.worldFacts(facts), { markKnown: true });
    } catch (e: any) {
      console.error('[game-loop] Fact extraction failed:', e.message?.slice(0, 200));
    }
    // Ended mid-extraction: the scene-end above already went out, but the
    // table is closing — no recovery beats after the epilogue.
    if (this.stopped) return;

    for (const charId of this.characters.keys()) {
      this.memoryStore.decayMemories(charId);
    }

    for (const [charId, char] of this.characters) {
      const oldStress = char.state.stress;
      char.state.stress = 0;

      // Taken out lasts until the next scene; see recoverAtSceneBreak.
      const { kept, recovered: recoverable } = recoverAtSceneBreak(char.state.consequences);
      char.state.consequences = kept;

      if (oldStress > 0 || recoverable.length > 0) {
        const parts: string[] = [];
        if (oldStress > 0) parts.push('stress clears');
        if (recoverable.length > 0) parts.push(`recovers from: ${recoverable.join(', ')}`);
        console.log(`[game-loop] Scene recovery: ${char.definition.name} — ${parts.join(', ')}`);
        this.broadcastFn({ type: 'narration', text: `[${char.definition.name} takes a moment to recover — ${parts.join(', ')}]`, sceneNumber: this.state.currentScene });
        this.sendStateUpdate(charId, char.state);
        this.db.prepare("UPDATE characters SET state = ?, updated_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(char.state), charId);
      }
    }

    this.transcript = [
      { role: 'system' as const, content: `[Previous scene] ${summary}`, timestamp: new Date().toISOString() },
    ];
    this.sceneTurnCount = 0;
    this.locationTurnCount = 0;
    this.lastLocationName = '';
    this.sceneWhisperStats.clear();
    this.state.currentScene++;
    clearCampaignImageCache(this.campaignId);
  }

  private async generateEpilogue(): Promise<void> {
    // stop() has already aborted the loop's signal by the time End Game gets
    // here; the epilogue is the one set of calls that must still go out.
    return runWithLlmSignal(null, () => this.writeEpilogue());
  }

  private async writeEpilogue(): Promise<void> {
    const campaign = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(this.campaignId) as any;
    const scenes = this.db.prepare(
      'SELECT scene_number, summary FROM scenes WHERE campaign_id = ? ORDER BY scene_number ASC'
    ).all(this.campaignId) as Array<{ scene_number: number; summary: string }>;
    // Scenes are only stored when endScene closes them, so a scene End Game
    // interrupted is played-but-unstored: count it, and give the DM its
    // story, whenever any turn happened in it.
    const inProgress = this.sceneTurnCount > 0 && !scenes.some(s => s.scene_number === this.state.currentScene);
    const scenesPlayed = scenes.length + (inProgress ? 1 : 0);
    const currentScene = inProgress ? this.currentSceneStory(8000) : '';

    const charLines = Array.from(this.characters.values()).map(c => {
      const memories = this.memoryStore.recall(c.id, 3);
      const memText = memories.map(m => m.content).join('. ');
      const trustArc = c.state.whisperTrust >= 0.7 ? 'deeply trusts the guiding voice'
        : c.state.whisperTrust >= 0.4 ? 'remains uncertain about the whispers'
        : 'has grown wary of the voice in their mind';
      return `${c.definition.name} (${c.definition.highConcept}): ${currentCondition(c.state)}, stress ${c.state.stress}/3, ${c.state.fatePoints} FP, ${trustArc}. Key memories: ${memText || 'none'}`;
    }).join('\n');

    const relationships = this.worldBible.getRelationships(this.campaignId);
    const relBlock = relationships.length > 0
      ? `\nKey relationships: ${relationships.slice(0, 6).map(r => `${r.entityAName} ${r.type} ${r.entityBName}`).join('; ')}`
      : '';

    const sceneSummaries = scenes.map(s => `Scene ${s.scene_number}: ${s.summary}`).join('\n\n');
    // DM-level world context stays (names, tone, what was still open), but it
    // is labelled as background: the events come from the record above it.
    const worldState = this.worldBible.getCompactSummary(this.campaignId);
    const record = [
      `Finished scenes:\n${sceneSummaries || '(none — the session ended before any scene closed)'}`,
      currentScene ? `Scene ${this.state.currentScene}, unfinished when the session ended — what happened, in order:\n${currentScene}` : '',
    ].filter(Boolean).join('\n\n');

    const presetVoices: Record<string, string> = {
      professor: 'You are an academic storyteller. End with a teaching moment — what did the characters (and the players) learn? Reference a specific rule or mechanic that shaped the story. Warm, slightly pedantic, like a favorite teacher closing a lesson.',
      trickster: 'You are a mischievous narrator. End with an ironic twist or unanswered question — something that makes the players realize the story was never quite what they thought. Playful, knowing, with a wink.',
      chronicler: 'You are a poetic historian. End with sensory imagery and the weight of what was witnessed. Name specific places and people. Your epilogue should read like the closing passage of a chronicle — beautiful, precise, haunted by what might have been.',
    };
    const voiceHint = presetVoices[campaign?.dm_preset] ?? 'Write in the DM\'s voice — warm, reflective, slightly bittersweet.';

    try {
      const epilogue = await callProse({
        messages: [
          { role: 'system', content: `You write brief TTRPG session epilogues. Plain text only, no JSON, no asterisks. ${voiceHint} 3-5 sentences. Describe only events that actually occurred in the session record you are given — never invent discoveries, losses, victories, escapes or resolutions it does not show. A character's CURRENT injuries are the ones listed under Characters; an injury the record mentions that is not listed there has healed — never describe it as still hurting. Call every character by their name; a word one character calls another ("Mom", a nickname) belongs only inside quoted speech. A thread left unresolved stays open: say so ("the question of who misfiled the form remains unanswered") rather than resolving it. You may reflect on how the voices the characters heard shaped them.` },
          { role: 'user', content: `Session complete: ${scenesPlayed} scene${scenesPlayed === 1 ? '' : 's'}, ${this.state.currentTurn} turns.\n\nSession record:\n${record}\n\nCharacters:\n${charLines}${relBlock}\n\nWorld background (for names and tone only — not a record of what happened):\n${worldState}\n\nWrite a brief closing narration of this session. What did the characters actually do? What was left unresolved? End with one evocative image drawn from something that happened.` },
        ],
        // Seen live at 248 characters, stopped mid-sentence ("...and the
        // distant toll of the great clock"): the reasoning model spent most
        // of 512 tokens thinking over the session record before writing.
        // 3-5 sentences is ~250 tokens; 3072 leaves ~2.5k for reasoning over
        // a record that can run to several thousand tokens, and callProse
        // retries a cut-off reply at double that, then trims to a sentence.
        maxTokens: 3072,
      });
      const text = epilogue.trim();
      if (text && text.length > 20) {
        this.broadcastFn({ type: 'narration', text, sceneNumber: this.state.currentScene, isEpilogue: true });
        console.log(`[game-loop] Epilogue generated (${text.length} chars)`);
      }
    } catch (e) {
      console.error('[game-loop] Epilogue generation failed:', e);
    }

    await this.generateCharacterClosingReflections(scenes, currentScene);
  }

  /**
   * The unfinished scene as the table saw it: story lines only (no whisper
   * text, no whisper verdicts), dice left out, newest kept when it runs long.
   */
  private currentSceneStory(maxChars: number): string {
    const lines = storyLines(this.transcript).filter(m => m.role !== 'dice').map(m => `- ${m.content}`);
    let text = lines.join('\n');
    if (text.length > maxChars) text = `…${text.slice(text.length - maxChars)}`;
    return text;
  }

  private async generateCharacterClosingReflections(scenes: Array<{ scene_number: number; summary: string }>, currentScene: string): Promise<void> {
    const finished = scenes.map(s => s.summary).join(' ').slice(0, 500);
    const sceneSummaries = [finished, currentScene.slice(-1000)].filter(Boolean).join('\n');
    for (const [charId, char] of this.characters) {
      const memories = this.memoryStore.recall(charId, 6);
      if (memories.length === 0) continue;
      const memText = memories.map(m => `- ${m.content}`).join('\n');
      const trustPct = Math.round(char.state.whisperTrust * 100);
      const trustArc = trustPct >= 70 ? 'You trusted the voice. It guided you well — or perhaps you simply chose to believe it did.'
        : trustPct >= 40 ? 'The voice was there, always. You never fully trusted it, never fully ignored it. An uneasy partnership.'
        : 'You learned to distrust the whisper. Whatever it wanted, it wasn\'t always what you needed.';

      try {
        const reflection = await callProse({
          messages: [
            { role: 'system', content: `You are ${char.definition.name}, a ${char.definition.highConcept}. The adventure is over. Write a brief closing reflection — one spoken line (what you say aloud to your companions or to yourself) and one inner thought (what you carry with you). Plain text, no JSON, no asterisks. ${PLAIN_PROSE_STYLE} Format exactly:\nSPOKEN: "your words"\nTHOUGHT: your private reflection` },
            { role: 'user', content: `Your journey is over. Here is what you remember:\n${memText}\n\nYour relationship with the whisper: ${trustArc} (trust: ${trustPct}%)\n\nHow you are right now: ${currentCondition(char.state)}. Any injury you remember that is not listed here has healed.\n\nWhat happened: ${sceneSummaries}\n\nWrite your final words and thought. Be specific — name a person, place, or moment that actually appears in what happened; do not invent outcomes. One line each.` },
          ],
          // Two short lines (~80 tokens), but reasoning comes out of the same
          // budget: 200 was enough to come back empty or cut off.
          maxTokens: 1536,
          temperature: 0.7,
        });

        const text = reflection.trim();
        const spokenMatch = text.match(/SPOKEN:\s*"?([^"]+)"?/i);
        const thoughtMatch = text.match(/THOUGHT:\s*(.+)/i);
        const spoken = spokenMatch?.[1]?.trim();
        const thought = thoughtMatch?.[1]?.trim();

        if (spoken || thought) {
          this.broadcastFn({
            type: 'action-taken',
            characterId: charId,
            characterName: char.definition.name,
            action: thought ? `[Final reflection] ${thought}` : '[Reflects quietly]',
            spokenWords: spoken ?? null,
            whisperInfluence: 'none',
          });
          console.log(`[game-loop] ${char.definition.name} closing reflection generated`);
        }
      } catch (e) {
        console.error(`[game-loop] ${char.definition.name} closing reflection failed:`, e);
      }
    }
  }

  /**
   * What happens when a player presses Whisper. The server is authoritative
   * about WHOSE voice a whisper is: the target is derived from the sender's
   * own seat binding, never from whose window happens to be open (that
   * cross-wiring let any player steer any character and silently swallowed
   * out-of-window input). Outcomes:
   *  - delivered: the sender's character is deciding right now, this very
   *    instant — the open window's promise.
   *  - queued:    no open moment for this character, so the words wait in
   *    their inbox and are heard at that character's NEXT decision window.
   *  - rejected:  nowhere for the words to go (game over, no seat at a live
   *    character, inbox full) — with a client-visible reason, because
   *    dropping input without a trace is the bug this replaces.
   * The world author (DM seat) keeps a driver's reach: whisper into whoever
   * is deciding right now — the escape hatch every playtest harness and the
   * solo-driver table lean on. The DM never accumulates an inbox: with no
   * character of their own, out-of-window is simply the wrong moment.
   */
  handleWhisper(text: string, sender: { characterId: string | null; isOwner: boolean }): WhisperAck {
    const nameOf = (id: string | null) => (id ? this.characters.get(id)?.definition.name ?? null : null);
    if (this.stopped) {
      return { status: 'rejected', characterId: null, characterName: null, message: 'The game has ended — your whisper had nowhere to go.' };
    }
    let targetId = sender.characterId;
    if (!targetId && sender.isOwner) targetId = this.pendingWhisperCharacterId;
    if (!targetId) {
      return {
        status: 'rejected', characterId: null, characterName: null,
        message: sender.isOwner
          ? 'No one is deciding right now — there is no moment to whisper into.'
          : 'You are not the voice of anyone at this table.',
      };
    }
    const target = this.characters.get(targetId);
    if (!target) {
      return { status: 'rejected', characterId: targetId, characterName: null, message: 'That character is no longer at this table.' };
    }
    if (this.pendingWhisperResolve && this.pendingWhisperCharacterId === targetId) {
      const resolve = this.pendingWhisperResolve;
      this.pendingWhisperResolve = null;
      this.pendingWhisperCharacterId = null;
      this.clearWhisperTimer();
      this.heardWhisper();
      resolve(text);
      return { status: 'delivered', characterId: targetId, characterName: target.definition.name, message: '' };
    }
    if (sender.isOwner && !sender.characterId) {
      return { status: 'rejected', characterId: targetId, characterName: target.definition.name, message: 'No one is deciding right now — there is no moment to whisper into.' };
    }
    const queue = this.whisperQueue.get(targetId) ?? [];
    if (queue.length >= GameLoop.WHISPER_QUEUE_LIMIT) {
      return {
        status: 'rejected', characterId: targetId, characterName: target.definition.name,
        message: `${target.definition.name} is still carrying your last whispers — wait for their next choice.`,
      };
    }
    queue.push(text);
    this.whisperQueue.set(targetId, queue);
    this.heardWhisper();
    return {
      status: 'queued', characterId: targetId, characterName: target.definition.name,
      message: `${target.definition.name} will carry your whisper into their next choice.`,
    };
  }

  /**
   * A human spoke: the quiet-turn count starts over, and a table that paused
   * itself for quiet picks back up — the banner there says "whisper or resume
   * to continue". Any other pause (host, no-players, restart) stays put; the
   * whisper is held or queued for when the host resumes.
   */
  private heardWhisper(): void {
    this.quietTurns = 0;
    if (this.pauseReason === 'quiet') this.resume();
  }

  private waitForWhisper(characterId: string, timeoutMs: number): Promise<string | null> {
    return new Promise(resolve => {
      this.pendingWhisperResolve = resolve;
      this.pendingWhisperCharacterId = characterId;
      // A window opened while paused is held from the start (resume arms it).
      if (!this.pauseReason) this.armWhisperTimer(timeoutMs);
    });
  }

  /**
   * The open whisper window as a (re)joining tab should see it: the prompt,
   * with the time actually left on the server's countdown. Null when no
   * window is counting down (none open, or a pause is holding it — resume
   * re-broadcasts the prompt with a fresh countdown).
   */
  openWhisperWindow(): Extract<ServerMessage, { type: 'whisper-prompt' }> | null {
    if (!this.openWhisperPrompt || this.whisperDeadline === null) return null;
    return { ...this.openWhisperPrompt, remainingMs: Math.max(0, this.whisperDeadline - Date.now()) };
  }

  /** The owner-only half of the open whisper window, for a (re)joining owner's tab. Null whenever openWhisperWindow() is. */
  openWhisperWindowGuidance(): Extract<ServerMessage, { type: 'whisper-guidance' }> | null {
    return this.openWhisperWindow() ? this.openWhisperGuidance : null;
  }

  /** (Re)start the countdown on the open whisper window; it closes with no whisper when it runs out. */
  private armWhisperTimer(timeoutMs: number): void {
    const resolve = this.pendingWhisperResolve;
    if (!resolve) return;
    this.clearWhisperTimer();
    this.whisperDeadline = Date.now() + timeoutMs;
    this.pendingWhisperTimer = setTimeout(() => {
      this.pendingWhisperTimer = null;
      this.whisperDeadline = null;
      if (this.pendingWhisperResolve === resolve) {
        this.pendingWhisperResolve = null;
        this.pendingWhisperCharacterId = null;
        resolve(null);
      }
    }, timeoutMs);
  }

  private clearWhisperTimer(): void {
    this.whisperDeadline = null;
    if (this.pendingWhisperTimer) {
      clearTimeout(this.pendingWhisperTimer);
      this.pendingWhisperTimer = null;
    }
  }

  /**
   * Empty the saved-whisper inbox — for one character (revoked: their
   * next window will never open) or for everyone (stop/endGame: the table
   * is done deciding). Broadcasts whisper-dropped so the owning player sees
   * their saved words end unheard, instead of the MUL-73 silence wearing a
   * different costume.
   */
  private drainWhisperQueue(characterId?: string): void {
    const ids = characterId ? [characterId] : Array.from(this.whisperQueue.keys());
    for (const id of ids) {
      const queued = this.whisperQueue.get(id);
      if (!queued || queued.length === 0) {
        this.whisperQueue.delete(id);
        continue;
      }
      this.whisperQueue.delete(id);
      try {
        this.broadcastFn({ type: 'whisper-dropped', characterId: id, count: queued.length });
      } catch (e) {
        console.error('[game-loop] whisper-dropped broadcast failed:', e);
      }
    }
  }

  private applyStateChange(characterId: string, field: string, action: string, value: unknown): void {
    const char = this.characters.get(characterId);
    if (!char) return;
    const state = char.state as unknown as Record<string, unknown>;
    if (action === 'set') {
      if (Array.isArray(state[field]) && !Array.isArray(value)) {
        (state[field] as unknown[]).push(value);
      } else {
        state[field] = value;
      }
      if (field === 'stress' && typeof value === 'number') {
        state.stress = Math.max(0, Math.min(value, 3));
      }
      if (field === 'fatePoints' && typeof value === 'number') {
        state.fatePoints = Math.max(0, Math.min(value, 5));
      }
    } else if (action === 'add' && Array.isArray(state[field])) {
      (state[field] as unknown[]).push(value);
    } else if (action === 'remove' && Array.isArray(state[field])) {
      const arr = state[field] as unknown[];
      const idx = arr.indexOf(value);
      if (idx >= 0) arr.splice(idx, 1);
    }
    if (field === 'inventory' && typeof value === 'string') {
      if (action === 'remove') {
        this.worldBible.updateItemHolder(this.campaignId, value, null);
      } else {
        this.worldBible.updateItemHolder(this.campaignId, value, characterId);
      }
    }
  }

  private getSystemDefaultDice(systemId: string): string {
    switch (systemId) {
      case 'fate-core': return '4dF';
      case 'dnd-5e': return '1d20';
      default: return '4dF';
    }
  }

  private isDegenerateNarration(text: string): boolean {
    const stripped = text.replace(/[.\s]+/g, ' ').trim();
    if (stripped.length < 40) return true;
    if (/^the scene (continues|goes on|proceeds)/i.test(stripped)) return true;
    if (/^(nothing happens|time passes|the story moves)/i.test(stripped)) return true;
    return false;
  }

  private buildCharacterMood(character: { definition: CharacterDefinition; state: CharacterState; id: string }, memories: Array<{ content: string; type: string; emotionalValence: number }>): string {
    const name = getFirstName(character.definition.name);
    const parts: string[] = [];

    const recentMem = memories.slice(0, 3);
    const avgValence = recentMem.length > 0
      ? recentMem.reduce((sum, m) => sum + m.emotionalValence, 0) / recentMem.length
      : 0;
    if (avgValence < -0.3) parts.push('troubled by recent events');
    else if (avgValence > 0.3) parts.push('buoyed by recent success');

    if (character.state.stress >= 2) parts.push('under heavy stress');
    if (character.state.consequences.length > 0) parts.push(`carrying wounds: ${character.state.consequences[0]}`);
    if (character.state.fatePoints === 0) parts.push('out of fate points — vulnerable');

    const troublePull = recentMem.some(m => m.content.toLowerCase().includes(character.definition.trouble.toLowerCase().split(' ')[0]!));
    const full = this.characters.get(character.id);
    return characterStatusLine({
      name,
      pronouns: full ? this.ownPronouns(full) : character.definition.pronouns,
      trouble: character.definition.trouble,
      states: parts,
      troublePull,
    });
  }

  private getCompanionLastAction(excludeCharId: string): { name: string; action: string; spokenWords?: string } | null {
    for (const [id, c] of this.characters) {
      if (id === excludeCharId) continue;
      const prefix = `${c.definition.name}: `;
      const last = this.transcript.filter(m => m.role === 'character' && m.content.startsWith(prefix)).slice(-1)[0];
      if (last) {
        const action = last.content.slice(prefix.length);
        const quoteMatch = action.match(/— "(.+?)"/);
        return { name: getFirstName(c.definition.name), action, spokenWords: quoteMatch?.[1] };
      }
    }
    return null;
  }

  private buildWhisperSuggestions(character: { definition: CharacterDefinition; state: CharacterState }, actions: string[], narration: string, companionAction?: { name: string; action: string; spokenWords?: string } | null): string[] {
    const suggestions: string[] = [];

    if (actions.length >= 2) {
      // Whole words and clauses only, and names keep their capitals (see
      // whisper-suggestions.ts): chips were cut mid-word and lower-cased whole.
      const names = [
        ...Array.from(this.characters.values()).map(c => c.definition.name),
        ...this.knownNpcNames(),
      ];
      const shorten = (a: string) => shortenSuggestion(a);
      const lower = (a: string) => lowerFirst(a, names);
      const isBold = (a: string) => /\b(confront|charge|demand|fight|challenge|steal|break|threaten|accuse|attack|grab|rush)\b/i.test(a);
      const isCautious = (a: string) => /\b(observe|watch|wait|hide|sneak|listen|study|examine|scout|retreat)\b/i.test(a);
      const isSocial = (a: string) => /\b(talk|ask|persuade|approach|greet|question|negotiate|whisper to|speak|confide)\b/i.test(a);

      const boldIdx = actions.findIndex(a => isBold(a));
      const cautiousIdx = actions.findIndex(a => isCautious(a));
      const socialIdx = actions.findIndex(a => isSocial(a));

      if (boldIdx >= 0) {
        suggestions.push(endSentence(`Do it — ${lower(shorten(actions[boldIdx]!))}`));
      }
      if (cautiousIdx >= 0 && cautiousIdx !== boldIdx) {
        const careful = shorten(actions[cautiousIdx]!);
        suggestions.push(endSentence(`Be careful. ${careful.charAt(0).toUpperCase()}${careful.slice(1)}`));
      }
      if (socialIdx >= 0 && socialIdx !== boldIdx && socialIdx !== cautiousIdx) {
        suggestions.push(endSentence(`Talk first — ${lower(shorten(actions[socialIdx]!))}`));
      }
    }

    if (suggestions.length < 3) {
      const npcNames = this.extractNpcNamesFromNarration(narration);
      const firstNpc = npcNames[0];
      const narLower = narration.toLowerCase();
      const hasDanger = /\b(danger|threat|attack|wound|dark|scream|blood|hostile|ambush|trap|collapse)\b/.test(narLower);
      const itemMatch = narLower.match(/\b(key|map|note|letter|vial|scroll|ring|pendant|blade|lantern|coin|book|journal|dagger|pouch|flask|seal|badge|mask)\b/);

      if (firstNpc && suggestions.length < 3) {
        suggestions.push(character.state.whisperTrust >= 0.6
          ? `Ask ${firstNpc} what they're hiding.`
          : `${firstNpc} might be an ally. Hear them out.`);
      }
      if (hasDanger && suggestions.length < 3) {
        suggestions.push(character.state.whisperTrust >= 0.6
          ? "Fall back. Find cover before it's too late."
          : "You've survived worse. Trust your gut.");
      }
      if (itemMatch && suggestions.length < 3) {
        suggestions.push(`The ${itemMatch[0]} — grab it.`);
      }
      if (character.state.stress >= 2 && suggestions.length < 3) {
        suggestions.push("You're hurt. Don't be a hero — survive first.");
      }
    }

    if (companionAction && suggestions.length < 3) {
      if (companionAction.spokenWords) {
        suggestions.push(`${companionAction.name} just spoke to you — respond.`);
      } else if (/\b(protect|cover|help|defend|save|guard)\b/i.test(companionAction.action)) {
        suggestions.push(`${companionAction.name} has your back. Push forward.`);
      } else if (/\b(alone|split|separate|leave)\b/i.test(companionAction.action)) {
        suggestions.push(`Don't let ${companionAction.name} go alone.`);
      }
    }

    return suggestions.slice(0, 3);
  }

  private knownNpcNames(): string[] {
    try {
      return (this.db.prepare('SELECT name FROM entities WHERE campaign_id = ? AND type = ?').all(this.campaignId, 'npc') as Array<{ name: string }>).map(r => r.name);
    } catch {
      return [];
    }
  }

  private extractNpcNamesFromNarration(narration: string): string[] {
    const npcs = this.db.prepare(
      'SELECT name FROM entities WHERE campaign_id = ? AND type = ? AND alive = 1'
    ).all(this.campaignId, 'npc') as Array<{ name: string }>;
    const narLower = narration.toLowerCase();
    return npcs
      .filter(n => narLower.includes(getFirstName(n.name).toLowerCase()))
      .map(n => getFirstName(n.name));
  }

  private buildTrustHint(character: Character): string {
    return trustHintLine(character.state.whisperTrust, getFirstName(character.definition.name), this.ownPronouns(character));
  }

  private getCharacterSummaries(): string {
    const charIds = Array.from(this.characters.keys());
    return Array.from(this.characters.values())
      .map(c => {
        const d = c.definition;
        const s = c.state;
        const namePrefix = `${d.name}: `;
        const recentActions = this.transcript
          .filter(m => m.role === 'character' && m.characterId === c.id)
          .slice(-5)
          .map(m => m.content.replace(namePrefix, ''));
        const lastAction = recentActions.slice(-1)[0] ?? '';
        const recentMemories = this.memoryStore.recall(c.id, 2);
        const mood = recentMemories.length > 0
          ? recentMemories.map(m => m.content).join('; ')
          : '';
        const whisperAttitude = s.whisperTrust > 0.7
          ? 'trusts the voice'
          : s.whisperTrust > 0.4
          ? 'uncertain about the voice'
          : 'deeply distrusts the voice — create situations where GOOD advice would help them, forcing the player to earn back trust';

        const behaviorHints: string[] = [];
        if (recentActions.length >= 3) {
          const cautious = /\b(look|observe|wait|cautious|careful|hide|watch|listen|stay)\b/i;
          const social = /\b(talk|speak|ask|persuade|convince|argue|negotiate|confront|shout)\b/i;
          // A companion counts as engaged whether they are named or addressed
          // the way this character actually speaks to them ("Mom").
          const others = charIds.filter(id => id !== c.id).map(id => this.characters.get(id)!);
          const otherNames = [...new Set(others.flatMap(o => {
            const terms = [getFirstName(o.definition.name).toLowerCase()];
            const address = this.companionView(c, o).address?.trim().toLowerCase();
            if (address) terms.push(address);
            return terms;
          }))];
          const cautiousCount = recentActions.filter(a => cautious.test(a)).length;
          const socialCount = recentActions.filter(a => social.test(a)).length;
          const mentionPatterns = otherNames.map(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
          const companionMentions = otherNames.length > 0 ? recentActions.filter(a => mentionPatterns.some(re => re.test(a))).length : 0;
          if (cautiousCount >= 3) behaviorHints.push('PLAYING TOO SAFE — force a confrontation they cannot avoid');
          if (socialCount === 0 && recentActions.length >= 4) behaviorHints.push('NEVER TALKS TO ANYONE — introduce an NPC who blocks their path and demands conversation');
          if (otherNames.length > 0 && companionMentions === 0 && recentActions.length >= 3) behaviorHints.push('IGNORING COMPANIONS — create a crisis that requires teamwork');
        }

        let line = `${d.name}: ${d.highConcept} (trouble: "${d.trouble}") | Stress: ${s.stress}/3 | Consequences: ${s.consequences.join(', ') || 'none'} | FP: ${s.fatePoints} | Trust: ${s.whisperTrust.toFixed(2)} (${whisperAttitude})`;
        if (lastAction) line += ` | Last: ${lastAction.slice(0, 60)}`;
        if (mood) line += ` | Mindset: ${mood.slice(0, 80)}`;
        if (s.inventory && s.inventory.length > 0) line += ` | Carrying: ${s.inventory.join(', ')}`;
        if (behaviorHints.length > 0) line += ` | DM NOTE: ${behaviorHints.join('; ')}`;
        return line;
      })
      .join('\n');
  }

  private getNpcEngagementHint(): string | null {
    const npcs = this.db.prepare(
      'SELECT name FROM entities WHERE campaign_id = ? AND type = ? AND alive = 1'
    ).all(this.campaignId, 'npc') as Array<{ name: string }>;
    if (npcs.length < 2) return null;

    const allText = this.transcript.map(m => m.content).join(' ').toLowerCase();
    const charNames = new Set(Array.from(this.characters.values()).map(c => c.definition.name.toLowerCase()));

    const skipWords = new Set([...TITLES, 'the', 'a', 'an', 'old', 'young', 'great', 'dark', 'tall']);
    const npcSearchTerm = (name: string): string => {
      const words = name.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !skipWords.has(w));
      return words[0] ?? name.toLowerCase().split(/\s+/).pop()!;
    };
    const counts: Array<{ name: string; count: number }> = npcs
      .filter(n => !charNames.has(n.name.toLowerCase()))
      .map(n => ({
        name: n.name,
        count: (allText.match(new RegExp(npcSearchTerm(n.name), 'g')) ?? []).length,
      }));

    const maxCount = Math.max(...counts.map(c => c.count), 0);
    const neglected = counts.filter(c => c.count === 0 || (maxCount >= 5 && c.count <= 1));
    if (neglected.length === 0) return null;

    const names = neglected.slice(0, 3).map(n => n.name).join(', ');
    const top = neglected[0]!;
    const topEntity = this.db.prepare('SELECT description FROM entities WHERE campaign_id = ? AND name = ?').get(this.campaignId, top.name) as { description: string } | undefined;
    const detail = topEntity?.description ? ` (${topEntity.description.split('[')[0]!.trim()})` : '';
    return `MANDATORY NPC APPEARANCE: ${top.name}${detail} has NOT appeared in the story yet while other NPCs have ${maxCount}+ mentions. You MUST include ${top.name} in this narration — have them speak, act, or visibly interact with the scene.${neglected.length > 1 ? ` Also neglected: ${neglected.slice(1).map(n => n.name).join(', ')}.` : ''}`;
  }

  private getWhisperTensionHint(): string | null {
    const hints: string[] = [];
    for (const [, char] of this.characters) {
      const trust = char.state.whisperTrust;
      const name = getFirstName(char.definition.name);
      if (trust >= 0.85) {
        hints.push(`WHISPER COMPLACENCY — ${name} trusts the voice almost completely (${trust.toFixed(2)}). This is DANGEROUS — create a situation where following the voice's likely advice would hurt an innocent or betray an ally. Force the player to choose between easy guidance and hard morality. The voice should feel like a crutch that needs questioning.`);
      } else if (trust >= 0.65 && trust <= 0.75) {
        hints.push(`WHISPER TEST — ${name} deeply trusts the voice (${trust.toFixed(2)}). Present a moral dilemma where the "smart" choice conflicts with the "right" choice. Force the player to decide: do they guide their character toward safety or integrity?`);
      } else if (trust >= 0.35 && trust <= 0.45) {
        hints.push(`WHISPER CRISIS — ${name}'s trust is at ${trust.toFixed(2)} (tipping point). Present a moment where trusting the voice would clearly HELP — a warning about hidden danger, advice that plays to their strengths. Let the player prove the voice is worth listening to.`);
      } else if (trust <= 0.20) {
        hints.push(`WHISPER DEAF — ${name} barely hears the voice anymore (${trust.toFixed(2)}). Show what happens when a character has NO inner compass — bad decisions compound, danger closes in. Make the player WANT to rebuild trust.`);
      }
    }
    if (this.characters.size >= 2) {
      const trusts = Array.from(this.characters.values()).map(c => ({
        name: getFirstName(c.definition.name),
        trust: c.state.whisperTrust,
      }));
      trusts.sort((a, b) => b.trust - a.trust);
      const gap = trusts[0]!.trust - trusts[trusts.length - 1]!.trust;
      if (gap >= 0.3) {
        hints.push(`TRUST SPLIT — ${trusts[0]!.name} (${trusts[0]!.trust.toFixed(2)}) trusts the voice while ${trusts[trusts.length - 1]!.name} (${trusts[trusts.length - 1]!.trust.toFixed(2)}) resists it. Create a situation where their different relationships with the voice put them at odds — one wants to follow a hunch, the other insists on caution.`);
      }
    }

    return hints.length > 0 ? hints.join('\n') : null;
  }

  private addTranscript(role: TranscriptMessage['role'], content: string, characterId?: string): void {
    // DM story text gets the same narration guard as the broadcast funnel.
    // A player's whisper is their own words and is never rewritten, and a
    // character's own line may call a companion "Mom".
    const guarded = role === 'dm' ? this.guardText(content) : content;
    this.transcript.push({ role, content: guarded, characterId, timestamp: new Date().toISOString() });
  }
}
