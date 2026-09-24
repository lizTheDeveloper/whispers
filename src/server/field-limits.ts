/**
 * The size limits on free-text fields, in one place: the accept-time
 * validators (index.ts), the world drafter's prompt and the clamp applied to
 * every drafted world all read them from here.
 *
 * Live (5YHBZS): the drafter wrote Mistress Prune a ~330-character
 * disposition, the host's accept was refused twice with "NPC disposition
 * must be at most 256 characters", and nothing the host could do in the chat
 * changed it. The server must never refuse text it drafted itself, so a
 * drafted world is clamped to these limits before the host sees it.
 */
import type { WorldSeed } from '../shared/types.js';

export const FIELD_LIMITS = {
  /** Names, terrain, disposition, pronouns — and a character's name, high concept, trouble, aspects. */
  short: 256,
  /** Premise, descriptions, motivations, plot hooks — and a character's backstory, personality. */
  long: 5000,
  /** Entries in any one list. */
  list: 20,
} as const;

export function isValidShortField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= FIELD_LIMITS.short;
}

export function isValidLongField(value: unknown): value is string {
  return typeof value === 'string' && value.length <= FIELD_LIMITS.long;
}

function isValidNullableBoundedString(value: unknown, max: number): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.length <= max);
}

/**
 * WorldSeedSchema validates shape but not size — a host-supplied seed is
 * persisted verbatim, expanded into unbounded locations/entities/items/events
 * rows, and then injected into every DM prompt for the rest of the campaign.
 * Bound it the same way submit-character bounds a character definition:
 * reject rather than truncate a field the host wrote, so the host gets an
 * explicit reason instead of a silently thinned-out world. (Fields the
 * server drafted are clamped before this runs — see acceptableSeed.)
 */
export function validateWorldSeedShape(seed: WorldSeed): string | null {
  const { short, long, list } = FIELD_LIMITS;
  if (!isValidLongField(seed.premise)) return `Premise must be at most ${long} characters.`;
  if (seed.locations.length > list) return `At most ${list} locations are allowed.`;
  for (const loc of seed.locations) {
    if (!isValidShortField(loc.name)) return `Location names must be 1-${short} characters.`;
    if (!isValidLongField(loc.description)) return `Location descriptions must be at most ${long} characters.`;
    if (!isValidNullableBoundedString(loc.terrain, short)) return `Location terrain must be at most ${short} characters.`;
  }
  if (seed.npcs.length > list) return `At most ${list} NPCs are allowed.`;
  for (const npc of seed.npcs) {
    if (!isValidShortField(npc.name)) return `NPC names must be 1-${short} characters.`;
    if (!isValidLongField(npc.description)) return `NPC descriptions must be at most ${long} characters.`;
    if (!isValidNullableBoundedString(npc.disposition, short)) return `NPC disposition must be at most ${short} characters.`;
    if (!isValidNullableBoundedString(npc.motivation, long)) return `NPC motivation must be at most ${long} characters.`;
    if (!isValidNullableBoundedString(npc.pronouns, short)) return `NPC pronouns must be at most ${short} characters.`;
  }
  if (seed.plotHooks.length > list) return `At most ${list} plot hooks are allowed.`;
  if (!seed.plotHooks.every(h => isValidLongField(h))) return `Plot hooks must be at most ${long} characters each.`;
  if (seed.items.length > list) return `At most ${list} items are allowed.`;
  for (const item of seed.items) {
    if (!isValidShortField(item.name)) return `Item names must be 1-${short} characters.`;
    if (!isValidLongField(item.description)) return `Item descriptions must be at most ${long} characters.`;
  }
  return null;
}

/** A sentence end: ".", "!", "?" or "…", with any closing quote or bracket, before a space or the end. */
const SENTENCE_END = /[.!?…]["'”’)\]]*(?=\s|$)/g;

/**
 * `text` cut to at most `max` characters: at the last sentence end that
 * fits (when that keeps at least 40% of the room), else at the last word
 * boundary with "…" — never mid-word unless a single word is longer than the
 * limit. A `name` is cut at a word with no ellipsis. Text within the limit
 * comes back unchanged.
 */
export function clampText(text: string, max: number, opts: { name?: boolean } = {}): string {
  if (text.length <= max) return text;
  if (!opts.name) {
    const window = text.slice(0, max);
    let end = -1;
    for (const m of window.matchAll(SENTENCE_END)) end = m.index! + m[0].length;
    if (end >= max * 0.4) return window.slice(0, end).trim();
  }
  const room = opts.name ? max : max - 1;
  const window = text.slice(0, room + 1);
  const space = window.search(/\s\S*$/);
  let cut = space > 0 ? text.slice(0, space) : text.slice(0, room);
  cut = cut.replace(/[\s,;:—–-]+$/, '');
  if (cut.length > room) cut = cut.slice(0, room);
  return opts.name ? cut : `${cut}…`;
}

/**
 * A world with every field the accept validator checks cut to its limit
 * (clampText) and every list to FIELD_LIMITS.list entries. `only`, when
 * given, limits the clamp to the text values it accepts — acceptableSeed
 * uses it to clamp the server's own text and nothing the host wrote.
 */
export function clampWorldSeed(seed: WorldSeed, opts: { only?: (value: string) => boolean } = {}): WorldSeed {
  const { short, long, list } = FIELD_LIMITS;
  const may = (v: string) => !opts.only || opts.only(v);
  const s = (v: string, name = false) => (may(v) ? clampText(v, short, { name }) : v);
  const l = (v: string) => (may(v) ? clampText(v, long) : v);
  const ns = <T extends string | null | undefined>(v: T): T => (typeof v === 'string' ? (s(v) as T) : v);
  const nl = <T extends string | null | undefined>(v: T): T => (typeof v === 'string' ? (l(v) as T) : v);
  const cap = <T>(xs: T[]) => (opts.only ? xs : xs.slice(0, list));
  const out: WorldSeed = {
    ...seed,
    premise: l(seed.premise),
    locations: cap(seed.locations).map(loc => ({ ...loc, name: s(loc.name, true), description: l(loc.description), terrain: ns(loc.terrain) })),
    npcs: cap(seed.npcs).map(n => ({ ...n, name: s(n.name, true), description: l(n.description), disposition: ns(n.disposition), motivation: nl(n.motivation), pronouns: ns(n.pronouns) })),
    plotHooks: cap(seed.plotHooks).map(l),
    items: cap(seed.items).map(i => ({ ...i, name: s(i.name, true), description: l(i.description) })),
  };
  const clamped = JSON.stringify(out) !== JSON.stringify(seed);
  if (clamped) console.log('[world-seed] clamped drafted field(s) to the accept-time limits');
  return clamped ? out : seed;
}

/** Every text value in a world. */
function seedTexts(seed: WorldSeed): Set<string> {
  const out = new Set<string>([seed.premise, ...seed.plotHooks]);
  for (const l of seed.locations) for (const v of [l.name, l.description, l.terrain]) if (typeof v === 'string') out.add(v);
  for (const n of seed.npcs) for (const v of [n.name, n.description, n.disposition, n.motivation, n.pronouns]) if (typeof v === 'string') out.add(v);
  for (const i of seed.items) for (const v of [i.name, i.description]) if (typeof v === 'string') out.add(v);
  return out;
}

/**
 * The world the host accepts, with any over-long field the SERVER drafted
 * (the value is exactly the stored draft's) clamped, so accept never fails
 * on the server's own text — a stored draft from before drafts were clamped
 * included. A field the host wrote is theirs, and the validator still
 * refuses it with a reason.
 */
export function acceptableSeed(incoming: WorldSeed, stored: WorldSeed | null): WorldSeed {
  if (!stored) return incoming;
  const drafted = seedTexts(stored);
  return clampWorldSeed(incoming, { only: v => drafted.has(v) });
}

/** The limits, for the drafter's prompt. */
export function seedLimitsForPrompt(): string {
  const { short, long, list } = FIELD_LIMITS;
  return `FIELD LIMITS (hard — the host cannot accept a world that breaks them, and anything longer is cut): every name, "terrain", "disposition" and "pronouns" at most ${short} characters — a disposition is a few words or one short sentence ("wary but kind"), never a paragraph; the premise and every description, motivation and plot hook at most ${long} characters; at most ${list} locations, ${list} npcs, ${list} plotHooks and ${list} items.`;
}
