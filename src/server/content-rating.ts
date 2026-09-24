/**
 * Where a table's content rating lives (round 20): the campaigns row's
 * content_rating column, set only by the host (the rating control, or the
 * setup chat acting on the host's answer). Until the host chooses, the
 * rating is the default — gentle when the host asked for gentle peril or a
 * player character is a child, else storybook — computed fresh, so a child
 * approved later still makes an unchosen table gentle. See
 * src/shared/rating.ts for what each level does.
 */
import type Database from 'better-sqlite3';
import { childrenInParty, wantsGentlePeril, type PartyMember } from './agents/dm.js';
import { defaultContentRating, parseContentRating, type ContentRating } from '../shared/rating.js';
import type { CharacterDefinition } from '../shared/types.js';

/** What the host said in the setup chat, as stored on the campaign (an unreadable chat says nothing). */
export function hostSetupMessages(db: Database.Database, campaignId: string): string[] {
  const row = db.prepare('SELECT setup_chat FROM campaigns WHERE id = ?').get(campaignId) as { setup_chat?: string | null } | undefined;
  try {
    const chat = row?.setup_chat ? JSON.parse(row.setup_chat) as Array<{ role: string; content: string }> : [];
    return Array.isArray(chat) ? chat.filter(m => m?.role === 'user' && typeof m.content === 'string').map(m => m.content) : [];
  } catch {
    return [];
  }
}

/**
 * Did the host ask for gentle or cozy peril? Read off what they said — their
 * setup messages and the direction written from them, all stored on the
 * campaign. Throws when the campaign cannot be read.
 */
export function campaignWantsGentlePeril(db: Database.Database, campaignId: string): boolean {
  const row = db.prepare('SELECT dm_instructions, dm_custom_prompt FROM campaigns WHERE id = ?').get(campaignId) as { dm_instructions?: string | null; dm_custom_prompt?: string | null } | undefined;
  return wantsGentlePeril([...hostSetupMessages(db, campaignId), row?.dm_instructions, row?.dm_custom_prompt]);
}

/** The rating the host chose, or null while they have not. */
export function storedContentRating(db: Database.Database, campaignId: string): ContentRating | null {
  const row = db.prepare('SELECT content_rating FROM campaigns WHERE id = ?').get(campaignId) as { content_rating?: string | null } | undefined;
  return parseContentRating(row?.content_rating ?? null);
}

/** The host's choice, on the campaign row (null clears it back to the default). */
export function setStoredContentRating(db: Database.Database, campaignId: string, rating: ContentRating | null): void {
  db.prepare("UPDATE campaigns SET content_rating = ?, updated_at = datetime('now') WHERE id = ?").run(rating, campaignId);
}

/** The live (not revoked) party as the child check reads it. */
function liveParty(db: Database.Database, campaignId: string): PartyMember[] {
  const rows = db.prepare('SELECT definition FROM characters WHERE campaign_id = ? AND revoked_at IS NULL').all(campaignId) as Array<{ definition: string }>;
  const out: PartyMember[] = [];
  for (const r of rows) {
    try {
      const d = JSON.parse(r.definition) as CharacterDefinition;
      out.push({ name: d.name, highConcept: d.highConcept, age: d.age, pronouns: d.pronouns, relationships: d.relationships });
    } catch { /* an unreadable sheet names no child */ }
  }
  return out;
}

/** Is a live player character a child (childrenInParty)? */
export function campaignChildPresent(db: Database.Database, campaignId: string): boolean {
  return childrenInParty(liveParty(db, campaignId)).length > 0;
}

export interface TableRating {
  rating: ContentRating;
  /** The host chose it (else it is the default). */
  explicit: boolean;
  /** A player character is a child — the setting UI says so when the rating is above gentle. */
  childPresent: boolean;
}

/**
 * The table's rating as it stands: the host's choice, else the default. A
 * failed read of the gentle ask or the party is logged and read as "no"
 * (the same as the gentle-peril read has always been).
 */
export function tableRating(db: Database.Database, campaignId: string): TableRating {
  let childPresent = false;
  try { childPresent = campaignChildPresent(db, campaignId); } catch (e) { console.error('[rating] could not read the party:', e); }
  const stored = storedContentRating(db, campaignId);
  if (stored) return { rating: stored, explicit: true, childPresent };
  let gentleAsked = false;
  try { gentleAsked = campaignWantsGentlePeril(db, campaignId); } catch (e) { console.error('[rating] could not read the table tone:', e); }
  return { rating: defaultContentRating({ gentleAsked, childPresent }), explicit: false, childPresent };
}

const LEVEL = '(gentle|storybook|adventure|mature)';
/** A sentence saying the table IS (or will be) rated a level: "I'll set the rating to Mature", "We're rated Adventure", "a Storybook rating". */
const RATING_CLAIM = [
  new RegExp(String.raw`\b(?:rating|rated|rate)\b[^.!?]{0,40}?\b${LEVEL}\b`, 'i'),
  new RegExp(String.raw`\b${LEVEL}\b[\s"'”’]{0,3}(?:rating|rated|level|tier)\b`, 'i'),
  new RegExp(String.raw`\bset\s+(?:it|this|things|the\s+(?:game|table|tone|intensity))\s+(?:to|at)\s+["'“‘]?${LEVEL}\b`, 'i'),
];

/** The levels a sentence names as the table's rating, if it claims one. */
function claimedLevels(sentence: string): string[] {
  const found = new Set<string>();
  for (const re of RATING_CLAIM) {
    const m = sentence.match(re);
    if (m?.[1]) found.add(m[1].toLowerCase());
  }
  return [...found];
}

/**
 * The setup chat never claims a rating it did not set (round 20). A
 * sentence in the reply that says the table is (or will be) rated a level
 * other than the rating the table actually has after this reply comes out;
 * a question offering the levels ("Gentle, Storybook, Adventure or
 * Mature?") is not a claim. Nothing left: `fallback`.
 */
export function withoutUnsetRatingClaims(reply: string, actual: ContentRating, fallback: string): string {
  if (!reply?.trim()) return reply;
  const lines = reply.split(/(\n+)/);
  let changed = false;
  const out = lines.map(line => {
    if (/^\n+$/.test(line)) return line;
    const sentences = line.split(/(?<=[.!?…]["”’']?)\s+/);
    const kept = sentences.filter(sentence => {
      if (/\?["”’']?\s*$/.test(sentence)) return true;
      const levels = [...sentence.matchAll(new RegExp(String.raw`\b${LEVEL}\b`, 'gi'))].map(m => m[1]!.toLowerCase());
      if (new Set(levels).size >= 2) return true;
      const claimed = claimedLevels(sentence);
      if (claimed.length === 0 || claimed.every(c => c === actual)) return true;
      console.log(`[dm-chat] the reply claims a rating it did not set (${claimed.join(', ')}; the table is ${actual}) — sentence removed: "${sentence.slice(0, 120)}"`);
      changed = true;
      return false;
    });
    return kept.join(' ');
  }).join('').replace(/\n{3,}/g, '\n\n').trim();
  if (!changed) return reply;
  return out || fallback;
}

/**
 * The host naming a rating outright in the setup chat ("let's rate it
 * Mature", "make it Adventure", "storybook rating please"). Only a plain
 * statement — a question ("is Mature too much?") or a message naming two
 * levels is not an answer. Null when there is none.
 */
export function ratingStatedIn(hostText: string): ContentRating | null {
  if (!hostText?.trim()) return null;
  const levels = new Set([...hostText.matchAll(new RegExp(String.raw`\b${LEVEL}\b`, 'gi'))].map(m => m[1]!.toLowerCase()));
  if (levels.size !== 1) return null;
  for (const sentence of hostText.split(/(?<=[.!?…])\s+/)) {
    if (/\?\s*$/.test(sentence)) continue;
    const claimed = claimedLevels(sentence);
    // "make it Mature.", "go with Storybook" — the level as the whole answer. Never
    // "I want an adventure", and never "gentle" alone: "make it gentle and
    // silly" is the gentle-peril ask, read elsewhere.
    const direct = sentence.match(/\b(?:(?:make|keep|set)\s+(?:it|this|the\s+game|things)\s+(?:at\s+)?|(?:let['’]?s\s+)?go\s+with\s+)["'“‘]?(storybook|adventure|mature)["'”’]?\s*(?:[.!,]|$)/i)?.[1];
    const level = claimed[0] ?? direct;
    const parsed = parseContentRating(level ?? null);
    if (parsed) return parsed;
  }
  return null;
}
