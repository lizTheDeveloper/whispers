export interface Campaign {
  id: string;
  joinCode: string;
  name: string;
  dmPreset: string;
  scenarioId: string | null;
  systemId: string;
  hostUserId: string | null;
  houseRules: string | null;
  dmInstructions: string | null;
  dmCustomPrompt: string | null;
  phase: GamePhase;
  hostTableRole: TableRole | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignMaterial {
  id: string;
  filename: string;
  chunkCount: number;
  createdAt: string;
}

/**
 * Who someone is to this character, from this character's side.
 * `relation` is what `to` is TO THIS CHARACTER ("mother" on Biz's sheet means
 * Liz is Biz's mother); `address` is what this character calls them ("Mom").
 */
export interface CharacterRelationship {
  to: string;
  relation: string;
  address?: string;
}

export interface CharacterDefinition {
  name: string;
  backstory: string;
  personality: string;
  highConcept: string;
  trouble: string;
  aspects: string[];
  skills: Record<string, number>;
  stunts: string[];
  /** Optional: a number or a phrase ("late thirties"). Children should play as children. */
  age?: number | string;
  /**
   * Optional, only as the player stated it ("she/her", "they/them"). Unset
   * means unspecified: nobody — DM included — may guess a gender from a name,
   * an age or a relation word.
   */
  pronouns?: string;
  relationships?: CharacterRelationship[];
}

export interface CharacterState {
  stress: number;
  consequences: string[];
  fatePoints: number;
  inventory: string[];
  xpMilestones: string[];
  whisperTrust: number;
}

export interface Character {
  id: string;
  campaignId: string;
  playerUserId: string | null;
  definition: CharacterDefinition;
  state: CharacterState;
  createdAt: string;
  updatedAt: string;
}

export interface Entity {
  id: string;
  campaignId: string;
  type: 'npc' | 'creature' | 'organization';
  name: string;
  description: string | null;
  disposition: string | null;
  alive: boolean;
  locationId: string | null;
  metadata: Record<string, unknown>;
  /** DM-only: why this NPC does what they do. Never shown to characters. */
  motivation?: string | null;
  /** Whether the story has revealed this NPC to the party yet. */
  knownToParty?: boolean;
}

export interface Location {
  id: string;
  campaignId: string;
  name: string;
  description: string | null;
  terrain: string | null;
  connections: string[];
  coords: { x: number; y: number } | null;
}

export interface Item {
  id: string;
  campaignId: string;
  name: string;
  description: string | null;
  properties: Record<string, unknown>;
  holderId: string | null;
  locationId: string | null;
}

export interface GameEvent {
  id: string;
  campaignId: string;
  sceneNumber: number;
  description: string;
  participants: string[];
  outcome: string | null;
}

export interface Relationship {
  campaignId: string;
  entityAId: string;
  entityBId: string;
  type: string;
  description: string | null;
}

export interface Scene {
  id: string;
  campaignId: string;
  sceneNumber: number;
  transcript: TranscriptMessage[];
  summary: string | null;
  createdAt: string;
}

export interface TranscriptMessage {
  role: 'dm' | 'character' | 'system' | 'whisper' | 'dice';
  characterId?: string;
  content: string;
  timestamp: string;
}

export interface DiceResult {
  expression: string;
  total: number;
  rolls: number[];
  description: string;
}

export type GamePhase = 'lobby' | 'character-creation' | 'playing' | 'ended';

export type TableRole = 'dm' | 'player';

export interface WorldSeedLocation { name: string; description: string; terrain: string | null }
export interface WorldSeedNpc { name: string; description: string; disposition: string | null; motivation: string | null; pronouns?: string }
export interface WorldSeedItem { name: string; description: string }

export interface WorldSeed {
  premise: string;
  locations: WorldSeedLocation[];
  npcs: WorldSeedNpc[];
  plotHooks: string[];
  items: WorldSeedItem[];
}

export type WorldReadinessItem = 'influences' | 'seed' | 'dmInstructions' | 'tableRole' | 'seedAccepted';

export interface WorldReadiness {
  ready: boolean;
  unmet: WorldReadinessItem[];
  /** Human-readable, one per unmet item, in the same order. Shown to the host and fed back to the model. */
  detail: string[];
}

export type CharacterReadinessItem = 'name' | 'highConcept' | 'trouble' | 'aspects' | 'skills' | 'stunts' | 'pronouns';

export interface CharacterReadiness {
  ready: boolean;
  unmet: CharacterReadinessItem[];
  /** Human-readable, one per unmet item, in the same order. Shown to the player and fed back to the model. */
  detail: string[];
}

export interface RoomState {
  campaignId: string;
  joinCode: string;
  phase: GamePhase;
  currentScene: number;
  currentTurn: number;
  initiativeOrder: string[];
  activeCharacterId: string | null;
  awaitingWhisper: boolean;
  awaitingDmAnswer: boolean;
  currentLocationId: string | null;
  sceneTurnCount?: number;
  /** Server-side: the stock-line variants said this game, per family (LineRotation.snapshot), so a resume keeps them. */
  stockLines?: Record<string, number[]>;
  /** The content rating the host chose (round 20), carried in every checkpoint so a resume restores it. Unset: not chosen. */
  contentRating?: import('./rating.js').ContentRating;
}
