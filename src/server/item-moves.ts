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
import { sameItem, isStack, singleOf } from './narrative-guards.js';

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

export interface AppliedMove { item: string; from: ItemSide; to: ItemSide }

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

const first = (name: string) => name.trim().split(/\s+/)[0]!.toLowerCase();

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
 *  - from a party member: they must hold it (same item, any case or article);
 *    otherwise the move is refused. One from a stack ("qty": 1, or the single
 *    of a held stack) leaves the stack and gives the single.
 *  - from an NPC, the world or nowhere: never taken from a party member — an
 *    NPC's granola bar is the NPC's, whoever else has one. The one exception
 *    is a unique world item (opts.worldItems) the record still has in exactly
 *    one member's hands, picked up from the world: its drop went unrecorded,
 *    so it leaves that hand.
 *  - to a party member: added once — "Granola Bar" is the "Granola bar"
 *    already there.
 *  - to an NPC, the world or nowhere: it simply leaves the giver.
 */
export function planItemMoves(moves: ItemMove[], party: Array<{ id: string; name: string; inventory: string[] }>, opts: { worldItems?: string[] } = {}): MovePlan {
  const inventories = new Map(party.map(p => [p.id, [...p.inventory]]));
  const applied: AppliedMove[] = [];
  const rejected: string[] = [];
  const notes: string[] = [];
  const worldItems = opts.worldItems ?? [];

  for (const move of moves) {
    const from = resolveSide(move.from, party);
    const to = resolveSide(move.to, party);
    let item = move.item;

    if (from.kind === 'pc') {
      const inv = inventories.get(from.id)!;
      const held = inv.find(i => sameItem(i, move.item));
      if (!held) {
        rejected.push(`[items] refused a move of "${move.item}" from ${from.name} to ${describe(to)}: ${from.name} does not hold "${move.item}" (holds: ${inv.join(', ') || 'nothing'})`);
        continue;
      }
      if (to.kind === 'pc' && to.id === from.id) continue;
      const one = isStack(held) && (move.qty === 1 || !isStack(move.item));
      item = one ? singleOf(held) : held;
      if (!one) inventories.set(from.id, inv.filter(i => i !== held));
    } else {
      // Canonical name: the world's own spelling when the DM's names a world item.
      item = worldItems.find(w => sameItem(w, move.item)) ?? move.item;
      if (from.kind === 'world' && to.kind === 'pc' && worldItems.some(w => sameItem(w, item))) {
        const holders = party.filter(p => p.id !== to.id && inventories.get(p.id)!.some(i => sameItem(i, item)));
        if (holders.length === 1) {
          const h = holders[0]!;
          inventories.set(h.id, inventories.get(h.id)!.filter(i => !sameItem(i, item)));
          notes.push(`[items] "${item}" picked up from the world was still on ${h.name}'s line (its drop went unrecorded): it leaves ${h.name}`);
        }
      }
    }

    if (to.kind === 'pc') {
      const inv = inventories.get(to.id)!;
      if (inv.some(i => sameItem(i, item))) {
        notes.push(`[items] ${to.name} already holds "${inv.find(i => sameItem(i, item))}"; "${item}" is not added twice`);
      } else {
        inventories.set(to.id, [...inv, item]);
      }
    }
    applied.push({ item, from, to });
    notes.push(`[items] "${item}": ${describe(from)} → ${describe(to)} (the DM's itemMoves)`);
  }
  return { inventories, applied, rejected, notes };
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
