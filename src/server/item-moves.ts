/**
 * Items, structurally. The DM states every move of a thing as data —
 * itemMoves: {item, from, to, qty?} on a ruling or a narration beat — and
 * the server checks each move against the real inventories before applying
 * it. That is the record. Reading moves out of the DM's prose
 * (narratedItemEvents and friends in narrative-guards.ts) is only a
 * cross-check now: four rounds of new prose patterns kept losing to new
 * wordings (live 7RAAQ7: "Mama Pigeon … offers a granola bar to Biz" moved
 * Liz's bar; an eaten bar came back as "Granola Bar"; a torn tote vanished
 * while the pen it scattered stayed; a dropped and re-taken key registered
 * neither way).
 *
 * Pure: no database, no LLM. The game loop applies the plan.
 */
import { sameItem, isStack, singleOf, itemHead, namesOneThing, withoutCount, mergeCount, lessOne, moveShownInProse } from './narrative-guards.js';
import { shortName } from '../shared/names.js';

/** One move as the DM states it. `from`/`to`: a player character's name, an NPC's name, "world", or null (appears / is gone). */
export interface ItemMove {
  item: string;
  from: string | null;
  to: string | null;
  qty?: 1 | 'all';
}

/** Where a thing is, resolved. */
export type ItemSide =
  | { kind: 'pc'; id: string; name: string }
  | { kind: 'npc'; name: string }
  | { kind: 'world' }
  | { kind: 'none' };

export interface AppliedMove {
  item: string;
  from: ItemSide;
  to: ItemSide;
  /**
   * Picked up from the world where the world's record of that name lies at
   * another place (live NUMMRL: the Bottle cap sunk at the Inkwell Market,
   * and a "tiny shiny glint" pocketed at the Queue): another one, so the
   * record stays where it is.
   */
  fresh?: true;
}

export interface MovePlan {
  /** Every party member's inventory after the moves, by id (unchanged ones included). */
  inventories: Map<string, string[]>;
  applied: AppliedMove[];
  /** Why a move was refused, for the log. */
  rejected: string[];
  /** What happened, for the log. */
  notes: string[];
}

/** "The floor", "the counter", "world": the scene itself — dropped, set down, lying there. */
const WORLD = /^(?:the\s+)?(?:world|floor|ground|scene|room|here|there|table|counter|desk|shelf|environment|location|surroundings|nearby)$/i;
/** Nobody: a thing that appears from nowhere, or is eaten, used up, destroyed. */
const NOWHERE = /^(?:null|none|nobody|no\s*one|nothing|n\/a|gone|destroyed|consumed|eaten|used\s+up|lost|void|-)$/i;

/**
 * The DM's itemMoves, leniently: a malformed entry is dropped, never the
 * reply. undefined when the DM sent none at all (the field absent) — the
 * game loop then falls back to the older inventory stateChanges.
 */
export function parseItemMoves(raw: unknown): ItemMove[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const list = Array.isArray(raw) ? raw : [];
  const out: ItemMove[] = [];
  const side = (v: unknown): string | null => (typeof v === 'string' && v.trim() && !NOWHERE.test(v.trim()) ? v.trim() : null);
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const o = entry as Record<string, unknown>;
    const item = typeof o.item === 'string' ? o.item.trim() : typeof o.name === 'string' ? o.name.trim() : '';
    if (!item) continue;
    const q = o.qty ?? o.quantity;
    const qty = q === 1 || q === '1' ? 1 : q === 'all' ? 'all' : undefined;
    out.push({ item, from: side(o.from), to: side(o.to), ...(qty ? { qty } : {}) });
  }
  return out;
}

const first = (name: string) => shortName(name).toLowerCase();

function resolveSide(v: string | null, party: Array<{ id: string; name: string }>): ItemSide {
  if (v === null) return { kind: 'none' };
  const name = v.replace(/['’]s$/, '').trim();
  const pc = party.find(p => p.name.toLowerCase() === name.toLowerCase()) ?? party.find(p => first(p.name) === first(name) && name.split(/\s+/).length === 1);
  if (pc) return { kind: 'pc', id: pc.id, name: pc.name };
  if (WORLD.test(name)) return { kind: 'world' };
  return { kind: 'npc', name };
}

const describe = (s: ItemSide) => s.kind === 'pc' || s.kind === 'npc' ? s.name : s.kind === 'world' ? 'the world' : 'nowhere';

/**
 * Check the DM's moves against the party's inventories and work out the
 * result, in order:
 *  - from and to the same place (live RZBU7G: "Bottle caps": the world →
 *    the world, meaning Biz dropped one): logged and resolved, never
 *    silently dropped — when exactly one member holds the thing, that member
 *    set it (one, from a stack) down; otherwise it stays where it is.
 *  - from a party member: they must hold it (same item, any case or article;
 *    or a known alias of it; or, when they hold exactly ONE thing with its
 *    head noun, that thing — live RZBU7G, "Stamp of Clarity" for "The
 *    Stamp"); otherwise the move is refused. One from a stack ("qty": 1, or
 *    the single of a held stack) leaves the stack and gives the single.
 *  - from an NPC, the world or nowhere: never taken from a party member — an
 *    NPC's granola bar is the NPC's, whoever else has one. The one exception
 *    is a unique world item (opts.worldItems) the record still has in exactly
 *    one member's hands, picked up from the world: its drop went unrecorded,
 *    so it leaves that hand. The name is the world's own (or the item an
 *    alias names); picked up from the world under a new name, it is the one
 *    thing lying loose (opts.looseItems) that name could be ("Green Bottle
 *    Cap" for the dropped "Bottle cap").
 *    Only a thing lying HERE (opts.looseItems: at this location, or touched
 *    this scene) is picked up by name or head noun; a world item of that name
 *    lying elsewhere (opts.elsewhere) is not it (live NUMMRL).
 *  - to a party member who already holds it: a new one when the thing
 *    demonstrably came from somewhere — a companion who held it, one lying
 *    loose here, an NPC the record has holding it, or another one picked up
 *    away from the record's — and the counts add ("Bottle cap" + one is
 *    "Bottle caps ×2"; live NUMMRL). Otherwise it is the same thing restated
 *    ("Granola Bar" is the "Granola bar" already there): not added twice.
 *  - to an NPC, the world or nowhere: it simply leaves the giver.
 */
export function planItemMoves(
  moves: ItemMove[],
  party: Array<{ id: string; name: string; inventory: string[] }>,
  opts: {
    worldItems?: string[];
    aliases?: Array<{ alias: string; name: string }>;
    /** World things lying loose HERE: at the current location, or touched this scene. */
    looseItems?: string[];
    /** World things lying loose somewhere else. */
    elsewhere?: string[];
    /**
     * Things a party member set down in the world a beat or two ago (round
     * 19, KAZQX3): lying here wherever the record places them — the party
     * moved on and picked it up, it went with them.
     */
    recentDrops?: string[];
    /** The moves that stood in the last beat or two: one the same again is that event told twice (round 19). */
    recentMoves?: AppliedMove[];
    /** Things the record has an NPC holding. */
    npcItems?: Array<{ name: string; heldBy: string }>;
    /** The acting character's id, on a ruling; none on a narration beat. */
    actorId?: string;
    /**
     * The ruling's or beat's prose. Given, a move from a party member other
     * than the actor stands only when the prose shows it (moveShownInProse).
     */
    prose?: string;
  } = {},
): MovePlan {
  const inventories = new Map(party.map(p => [p.id, [...p.inventory]]));
  const applied: AppliedMove[] = [];
  const rejected: string[] = [];
  const notes: string[] = [];
  const worldItems = opts.worldItems ?? [];
  const aliases = opts.aliases ?? [];
  const aliasOf = (name: string) => aliases.find(a => sameItem(a.alias, name))?.name;
  // Round 19 (KAZQX3): Biz set a cap by Mom's feet in the lobby; the scene
  // moved to the Umbrella Aisle and Liz pocketed it — "this is another one".
  // A thing a party member set down a beat or two ago went with the party.
  const recentDrops = opts.recentDrops ?? [];
  const carried = (opts.elsewhere ?? []).filter(e => recentDrops.some(d => sameItem(d, e)));
  const looseItems = [...(opts.looseItems ?? []), ...carried];
  const elsewhere = (opts.elsewhere ?? []).filter(e => !carried.includes(e));

  for (const move of moves) {
    let from = resolveSide(move.from, party);
    const to = resolveSide(move.to, party);
    let item = move.item;
    let dropsOne = false;
    let fresh = false;
    /** Whether this is demonstrably a unit more for a receiver who already holds one. */
    let newUnit = false;

    if (sameSide(from, to)) {
      const holders = from.kind === 'world'
        ? party.filter(p => inventories.get(p.id)!.some(i => sameItem(i, move.item) || (aliasOf(move.item) && sameItem(i, aliasOf(move.item)!))))
        : [];
      if (from.kind === 'world' && holders.length === 1) {
        const h = holders[0]!;
        notes.push(`[items] "${move.item}": from and to are the same place (${describe(from)}); ${h.name} holds it, so ${h.name} set it down`);
        from = { kind: 'pc', id: h.id, name: h.name };
        dropsOne = true;
      } else {
        notes.push(`[items] "${move.item}": from and to are the same place (${describe(from)}); nothing moves`);
        if (from.kind === 'world') applied.push({ item: worldItems.find(w => sameItem(w, move.item)) ?? aliasOf(move.item) ?? move.item, from, to });
        continue;
      }
    }

    // Round 19 (KAZQX3): one cap rolled out of Liz's tote, and the next
    // ruling (Biz's) sent `Bottle cap: Liz → the world` again — ×3 → ×2 → 1.
    // The same move as the last beat's, from a member who is not acting now,
    // is the same event told twice unless the prose shows another one.
    if (from.kind === 'pc' && from.id !== opts.actorId && !freshInstance(opts.prose ?? '', move.item)) {
      const again = (opts.recentMoves ?? []).find(r => sameItem(r.item, move.item) && sameSide(r.from, from) && sameSide(r.to, to));
      if (again) {
        notes.push(`[items] "${move.item}": ${describe(from)} → ${describe(to)} is the same move as the last beat's, and the prose shows no other one — the same event told again, not applied twice`);
        continue;
      }
    }

    if (from.kind === 'pc') {
      const inv = inventories.get(from.id)!;
      const alias = aliasOf(move.item);
      let held = inv.find(i => sameItem(i, move.item)) ?? (alias ? inv.find(i => sameItem(i, alias)) : undefined);
      if (!held) {
        const head = itemHead(move.item);
        const like = head ? inv.filter(i => itemHead(i) === head) : [];
        if (like.length === 1) {
          held = like[0]!;
          notes.push(`[items] "${move.item}" from ${from.name}: ${from.name} holds one thing by that noun, "${held}" — the move is taken as that`);
        } else {
          rejected.push(`[items] refused a move of "${move.item}" from ${from.name} to ${describe(to)}: ${from.name} does not hold "${move.item}"${like.length > 1 ? ` (${like.map(l => `"${l}"`).join(', ')} could each be meant)` : ''} (holds: ${inv.join(', ') || 'nothing'})`);
          continue;
        }
      }
      // Live (5YHBZS): Liz swept "Biz's loose bottle cap" into her tote; Biz
      // had dropped none and the ruling never mentions a cap, but the DM moved
      // `Bottle cap: Biz → Liz`. A companion's thing moves only when the
      // prose names it, or hands over "it"/"one".
      if (!dropsOne && opts.prose !== undefined && from.id !== opts.actorId && !moveShownInProse(move.item, opts.prose) && !moveShownInProse(held, opts.prose)) {
        rejected.push(`[items] refused a move of "${move.item}" from ${from.name} to ${describe(to)}: ${from.name} is not the one acting, and the ruling's prose never shows it change hands (no "${itemHead(held) ?? held}", no "it" handed over)`);
        continue;
      }
      const one = isStack(held) && (dropsOne || move.qty === 1 || !isStack(move.item));
      item = one ? singleOf(held) : held;
      if (one) {
        // "Bottle caps ×2" counts down to "Bottle cap"; an uncounted stack stays.
        const left = lessOne(held);
        if (left !== held) inventories.set(from.id, inv.flatMap(i => (i === held ? (left ? [left] : []) : [i])));
      } else {
        inventories.set(from.id, inv.filter(i => i !== held));
      }
      newUnit = true;
    } else {
      // Canonical name: the world's own spelling when the DM's names a world item, or the item an alias names.
      item = worldItems.find(w => sameItem(w, move.item)) ?? aliasOf(move.item) ?? move.item;
      if (from.kind === 'world' && carried.some(c => sameItem(c, item)) && !(opts.looseItems ?? []).some(l => sameItem(l, item))) {
        notes.push(`[items] "${move.item}" from the world: the record's "${item}" was set down by the party a moment ago — it went with them, so it is that one`);
      }
      if (from.kind === 'world' && elsewhere.some(e => sameItem(e, item)) && !looseItems.some(l => sameItem(l, item))) {
        // The record's one lies at another place: this is another one.
        notes.push(`[items] "${move.item}" from the world: the record's "${item}" lies at another place — this is another one, and that one stays where it is`);
        item = move.item;
        fresh = true;
        newUnit = true;
      } else if (from.kind === 'world' && item === move.item && !worldItems.some(w => sameItem(w, item))) {
        const head = itemHead(move.item);
        const loose = looseItems.filter(l => head && itemHead(l) === head);
        if (loose.length === 1 && namesOneThing(loose[0]!, move.item)) {
          item = loose[0]!;
          notes.push(`[items] "${move.item}" from the world: the one loose thing by that name is "${item}" — the move is taken as that`);
        }
      }
      if (from.kind === 'world' && looseItems.some(l => sameItem(l, item))) newUnit = true;
      if (from.kind === 'npc' && (opts.npcItems ?? []).some(n => sameItem(n.name, item) && n.heldBy.toLowerCase() === from.name.toLowerCase())) newUnit = true;
      if (!fresh && from.kind === 'world' && to.kind === 'pc' && worldItems.some(w => sameItem(w, item))) {
        // One off the floor from a stack a member still holds ("Bottle cap", Biz's "Bottle caps") is one, not the stack.
        const holders = party.filter(p => p.id !== to.id && inventories.get(p.id)!.some(i => sameItem(i, item) && !(isStack(i) && !isStack(item))));
        if (holders.length === 1) {
          const h = holders[0]!;
          inventories.set(h.id, inventories.get(h.id)!.filter(i => !sameItem(i, item)));
          notes.push(`[items] "${item}" picked up from the world was still on ${h.name}'s line (its drop went unrecorded): it leaves ${h.name}`);
        }
      }
    }

    if (to.kind === 'pc') {
      const inv = inventories.get(to.id)!;
      const had = inv.find(i => sameItem(i, item));
      if (had && newUnit) {
        const merged = mergeCount(had, item);
        inventories.set(to.id, inv.map(i => (i === had ? merged : i)));
        notes.push(`[items] ${to.name} already holds "${had}" and gets one more: "${merged}"`);
      } else if (had) {
        notes.push(`[items] ${to.name} already holds "${had}"; "${item}" is the same one restated — not added twice`);
      } else {
        inventories.set(to.id, [...inv, item]);
      }
    }
    applied.push({ item: to.kind === 'pc' ? item : withoutCount(item), from, to, ...(fresh ? { fresh: true as const } : {}) });
    notes.push(`[items] "${item}": ${describe(from)} → ${describe(to)} (the DM's itemMoves)`);
  }
  return { inventories, applied, rejected, notes };
}

/**
 * Does the prose show a fresh one of `item` — "another", "a second", "one
 * more", "yet another" before its noun, or "again" after it?
 */
export function freshInstance(prose: string, item: string): boolean {
  const head = itemHead(item);
  if (!prose || !head) return false;
  const noun = `${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:e?s)?`;
  return new RegExp(`\\b(?:another|a\\s+(?:second|third|fourth|fifth|new)|one\\s+more|the\\s+(?:second|third|other))\\s+(?:[\\w'’-]+\\s+){0,2}?${noun}\\b`, 'i').test(prose)
    || new RegExp(`\\b${noun}\\b[^.!?]{0,40}\\bagain\\b`, 'i').test(prose);
}

/** Two sides that are one place: the world and the world, nowhere and nowhere, one member, one NPC. */
function sameSide(a: ItemSide, b: ItemSide): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'pc') return a.id === (b as { id: string }).id;
  if (a.kind === 'npc') return a.name.toLowerCase() === (b as { name: string }).name.toLowerCase();
  return true;
}

/**
 * What each party member holds at the end, and what is gone, for the
 * epilogue and the closing reflections. Live (7RAAQ7): Liz's last words were
 * "I will keep the granola bar in my pocket for later" — the clerk had eaten it.
 */
export function endingItemsBlock(party: Array<{ name: string; inventory: string[] }>, gone: string[]): string {
  if (party.length === 0) return '';
  const lines = party.map(p => `- ${p.name}: ${p.inventory.length > 0 ? p.inventory.join(', ') : 'nothing'}`);
  const goneLine = gone.length > 0 ? `\nGone — eaten, used up, given away or lost, nobody in the party has these any more: ${gone.join(', ')}. Never say anyone still has, keeps, carries or will keep one of these.` : '';
  return `\n\nWhat each character is carrying at the end (exactly this, nothing else):\n${lines.join('\n')}${goneLine}`;
}
