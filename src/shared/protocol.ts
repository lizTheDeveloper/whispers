import type {
  CharacterDefinition, CharacterReadiness, CharacterState, DiceResult, GamePhase,
} from './types.js';

export type ClientMessage =
  | { type: 'join'; joinCode: string; playerName: string }
  | { type: 'create'; name: string; dmPreset: string; scenarioId: string | null; systemId: string; houseRules: string | null }
  | { type: 'submit-character'; definition: CharacterDefinition }
  | { type: 'char-chat'; text: string }
  | { type: 'confirm-character' }
  | { type: 'rejoin'; joinCode: string; sessionToken: string }
  | { type: 'whisper'; text: string }
  | { type: 'dm-answer'; text: string }
  | { type: 'dm-inject'; text: string }
  | { type: 'dm-override'; text: string }
  | { type: 'update-dm-settings'; dmCustomPrompt: string | null; dmInstructions: string | null }
  | { type: 'dm-chat'; text: string }
  | { type: 'choose-table-role'; role: import('./types.js').TableRole }
  | { type: 'accept-world-seed'; seed: import('./types.js').WorldSeed }
  | { type: 'regenerate-world-seed'; note?: string }
  | { type: 'host-approve-character'; characterId: string }
  | { type: 'host-reject-character'; characterId: string; reason: string }
  | { type: 'revoke-character'; characterId: string; reason?: string }
  | { type: 'negotiation-message'; characterId: string; text: string }
  | { type: 'start-game' }
  | { type: 'end-game' }
  | { type: 'pause-game' }
  | { type: 'resume-game' };

/**
 * Why a table is paused. 'host' — the host pressed Pause. 'no-players' — the
 * last socket left the room. 'quiet' — QUIET_TURNS_BEFORE_PAUSE turns went by
 * with no human whisper. 'restart' — the server restarted under a game in
 * play. Only the host's Resume (or, for 'quiet', any whisper) restarts play;
 * nothing resumes on a timer.
 */
export type PauseReason = 'host' | 'no-players' | 'quiet' | 'restart';

export type WhisperInfluence = 'followed' | 'partially-followed' | 'ignored' | 'none';

/**
 * One display line of a session's playing-phase log, shaped exactly like the
 * live ServerMessage that produced it (plus two kinds that never were
 * broadcasts: the player's own whisper echo and a revoke note). A
 * character-thought row is its owner's alone and replays only to their
 * session, like a whisper echo. Sent as an
 * array by 'transcript-replay' when a client rejoins mid-game or after the
 * table ended, so a page refresh does not erase the story so far.
 */
export type ReplayEntry =
  | { type: 'narration'; text: string; sceneNumber: number; locationName?: string; isEpilogue?: boolean }
  | { type: 'resolution'; text: string }
  | { type: 'dice-roll'; result: DiceResult; context: string }
  | { type: 'action-taken'; characterId: string; characterName: string; action: string; spokenWords?: string | null; innerThought?: string; whisperInfluence?: WhisperInfluence }
  | { type: 'character-thought'; characterId: string; characterName: string; innerThought: string; whisperInfluence: WhisperInfluence }
  | { type: 'scene-end'; summary: string; sceneNumber: number; whisperStats?: Array<{ name: string; followed: number; partial: number; ignored: number; trustDelta: number }> }
  | { type: 'whisper-echo'; text: string }
  | { type: 'revoked-note'; text: string };

export type ServerMessage =
  | { type: 'room-joined'; campaignId: string; joinCode: string; isOwner: boolean; tableRole: import('./types.js').TableRole | null; sessionToken: string; gameName: string; playerName: string; phase: GamePhase; characterId: string | null }
  | { type: 'lobby-state'; players: string[]; setupChat: Array<{ role: string; content: string }>; dmReady: boolean; approvedCount: number; phase: GamePhase; influences: string[]; hostTableRole: import('./types.js').TableRole | null; readiness: import('./types.js').WorldReadiness }
  | { type: 'room-state'; state: import('./types.js').RoomState }
  | { type: 'player-joined'; playerName: string; characterId: string | null }
  | { type: 'player-left'; playerName: string }
  | { type: 'character-submitted'; characterId: string; definition: CharacterDefinition }
  | { type: 'character-revoked'; characterId: string; reason: string }
  | { type: 'character-validated'; characterId: string; approved: boolean; feedback: string }
  | { type: 'character-rejected'; characterId: string; reason: string }
  | { type: 'character-pending-review'; characterId: string; definition: CharacterDefinition; aiApproved: boolean; aiFeedback: string; playerName: string }
  | { type: 'negotiation-message'; characterId: string; sender: 'dm-agent' | 'host' | 'player' | 'char-agent' | 'summary'; senderName: string; text: string }
  | { type: 'negotiation-opened'; characterId: string; characterName: string; playerName: string }
  | { type: 'negotiation-closed'; characterId: string }
  | { type: 'character-roster'; characters: Array<{ id: string; name: string }> }
  | { type: 'phase-change'; phase: GamePhase }
  | { type: 'narration'; text: string; sceneNumber: number; locationName?: string; isEpilogue?: boolean }
  | { type: 'scene-image'; imageUrl: string; locationName: string }
  // A character's private thinking goes ONLY to the seat that plays that
  // character (never a broadcast, not even to the host): action-proposals,
  // whisper-guidance and character-thought. What the table sees of a turn is
  // the whisper-prompt (who is deciding, and the countdown), the public
  // action-taken, the dice and the DM's words.
  | { type: 'action-proposals'; characterId: string; characterName: string; actions: string[]; actionReasons?: string[]; whisperTrust: number }
  // The owner-only half of a whisper-prompt: sent right after it, to fill
  // the whisper panel's mood line, goals and suggestion chips.
  | { type: 'whisper-guidance'; characterId: string; mood?: string; trustHint?: string; suggestions?: string[]; goals?: string[] }
  // The owner-only half of an action-taken: what the character thought, and
  // how they took the owner's whisper. Sent right after the action-taken.
  | { type: 'character-thought'; characterId: string; characterName: string; innerThought: string; whisperInfluence: WhisperInfluence }
  // Broadcast. mood/trustHint/suggestions/goals are the owner's alone and
  // arrive separately in whisper-guidance; the fields remain optional here.
  // windowMs: the window's full length; remainingMs: what is left of it as
  // of sending (less than windowMs when replayed to a tab that rejoins
  // mid-window). The client counts down from remainingMs. Both absent when
  // carryingQueued is set — there is no window then.
  | { type: 'whisper-prompt'; characterId: string; characterName: string; mood?: string; trustHint?: string; suggestions?: string[]; goals?: string[]; carryingQueued?: number; windowMs?: number; remainingMs?: number }
  | { type: 'whisper-ack'; status: 'delivered' | 'queued' | 'rejected'; characterId: string | null; characterName: string | null; message: string }
  | { type: 'whisper-dropped'; characterId: string; count: number }
  // innerThought/whisperInfluence are absent from the live broadcast (they
  // travel in character-thought); older replay rows may still carry them.
  | { type: 'action-taken'; characterId: string; characterName: string; action: string; spokenWords?: string | null; innerThought?: string; whisperInfluence?: WhisperInfluence }
  | { type: 'dice-roll'; result: DiceResult; context: string }
  | { type: 'resolution'; text: string }
  | { type: 'dm-question'; question: string }
  | { type: 'scene-end'; summary: string; sceneNumber: number; whisperStats?: Array<{ name: string; followed: number; partial: number; ignored: number; trustDelta: number }> }
  | { type: 'character-state-update'; characterId: string; state: CharacterState }
  | { type: 'dm-settings'; presetName: string; presetPrompt: string; dmCustomPrompt: string | null; dmInstructions: string | null; materials: import('./types.js').CampaignMaterial[]; uploadToken: string }
  | { type: 'dm-chat-reply'; text: string; done: boolean }
  | { type: 'world-seed-draft'; seed: import('./types.js').WorldSeed; accepted: boolean }
  | { type: 'world-readiness'; readiness: import('./types.js').WorldReadiness; influences: string[] }
  | { type: 'char-chat-reply'; text: string; definition: CharacterDefinition | null }
  | { type: 'world-introduction'; text: string }
  | { type: 'character-preview'; definition: CharacterDefinition; readiness: CharacterReadiness }
  | { type: 'character-readiness'; readiness: CharacterReadiness }
  | { type: 'interview-replay'; transcript: Array<{ role: string; content: string }>; definition: CharacterDefinition | null }
  | { type: 'transcript-replay'; entries: ReplayEntry[]; omitted: number }
  | { type: 'material-uploaded'; material: import('./types.js').CampaignMaterial }
  | { type: 'token-usage'; used: number; remaining: number | null }
  // Broadcast on every pause/resume, and sent to a (re)joining socket when
  // the table is paused. reason is null on a resume.
  | { type: 'game-paused'; paused: boolean; reason: PauseReason | null; by?: string }
  // Broadcast the moment the table starts closing (End Game, or the loop's
  // own finale), before the epilogue is written: every open whisper window
  // is closed with no turn taken, so clients stop their countdowns and lock
  // the whisper box now rather than after the epilogue and closing
  // reflections arrive. The 'ended' phase-change still follows.
  | { type: 'game-ending' }
  | { type: 'error'; message: string };
