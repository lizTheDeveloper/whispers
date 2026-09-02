import type {
  CharacterDefinition, CharacterState, DiceResult, GamePhase,
} from './types.js';

export type ClientMessage =
  | { type: 'join'; joinCode: string; playerName: string }
  | { type: 'create'; name: string; dmPreset: string; scenarioId: string | null; systemId: string; houseRules: string | null }
  | { type: 'submit-character'; definition: CharacterDefinition }
  | { type: 'char-chat'; text: string }
  | { type: 'whisper'; text: string }
  | { type: 'dm-answer'; text: string }
  | { type: 'dm-inject'; text: string }
  | { type: 'dm-override'; text: string }
  | { type: 'update-dm-settings'; dmCustomPrompt: string | null; dmInstructions: string | null }
  | { type: 'dm-chat'; text: string }
  | { type: 'host-approve-character'; characterId: string }
  | { type: 'host-reject-character'; characterId: string; reason: string }
  | { type: 'negotiation-message'; characterId: string; text: string }
  | { type: 'start-game' }
  | { type: 'end-game' };

export type ServerMessage =
  | { type: 'room-joined'; campaignId: string; joinCode: string; isHost: boolean }
  | { type: 'room-state'; state: import('./types.js').RoomState }
  | { type: 'player-joined'; playerName: string; characterId: string | null }
  | { type: 'player-left'; playerName: string }
  | { type: 'character-submitted'; characterId: string; definition: CharacterDefinition }
  | { type: 'character-validated'; characterId: string; approved: boolean; feedback: string }
  | { type: 'character-pending-review'; characterId: string; definition: CharacterDefinition; aiApproved: boolean; aiFeedback: string; playerName: string }
  | { type: 'negotiation-message'; characterId: string; sender: 'dm-agent' | 'host' | 'player' | 'char-agent'; senderName: string; text: string }
  | { type: 'negotiation-opened'; characterId: string; characterName: string; playerName: string }
  | { type: 'phase-change'; phase: GamePhase }
  | { type: 'narration'; text: string; sceneNumber: number; locationName?: string; isEpilogue?: boolean }
  | { type: 'scene-image'; imageUrl: string; locationName: string }
  | { type: 'action-proposals'; characterId: string; characterName: string; actions: string[]; actionReasons?: string[]; whisperTrust: number }
  | { type: 'whisper-prompt'; characterId: string; characterName: string; mood?: string; trustHint?: string; suggestions?: string[]; goals?: string[] }
  | { type: 'action-taken'; characterId: string; characterName: string; action: string; spokenWords?: string | null; innerThought: string; whisperInfluence: 'followed' | 'partially-followed' | 'ignored' | 'none' }
  | { type: 'dice-roll'; result: DiceResult; context: string }
  | { type: 'resolution'; text: string }
  | { type: 'dm-question'; question: string }
  | { type: 'scene-end'; summary: string; sceneNumber: number; whisperStats?: Array<{ name: string; followed: number; partial: number; ignored: number; trustDelta: number }> }
  | { type: 'character-state-update'; characterId: string; state: CharacterState }
  | { type: 'dm-settings'; presetName: string; presetPrompt: string; dmCustomPrompt: string | null; dmInstructions: string | null; materials: import('./types.js').CampaignMaterial[]; uploadToken: string }
  | { type: 'dm-chat-reply'; text: string; done: boolean }
  | { type: 'char-chat-reply'; text: string; definition: CharacterDefinition | null }
  | { type: 'material-uploaded'; material: import('./types.js').CampaignMaterial }
  | { type: 'token-usage'; used: number; remaining: number | null }
  | { type: 'error'; message: string };
