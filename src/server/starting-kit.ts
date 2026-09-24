import type { CharacterDefinition } from '../shared/types.js';

/**
 * The things a character sheet says the character has on them, as starting
 * inventory. Live (Z9JKG2): Liz's "Carrying a tote bag with a granola bar
 * and a pen" and Biz's "Pocket full of bottle caps" were only ever aspects,
 * so her inventory said [] while she threw the pen to Biz and the granola
 * bar to a clerk. The aspects stay as they are; this only reads them.
 *
 * Deterministic and conservative: only an aspect (or the high concept) that
 * says the character carries something — "Carrying …", "Armed with …",
 * "Never without …", "<a bag> with …", "<a pocket> full of …" — and only
 * concrete things: "the weight of the world", "a grudge", "a heavy heart"
 * are not kit.
 */
export function startingKit(def: Pick<CharacterDefinition, 'aspects' | 'highConcept'>): string[] {
  const kit: string[] = [];
  const add = (item: string) => {
    const name = item.charAt(0).toUpperCase() + item.slice(1);
    if (!kit.some(k => k.toLowerCase() === name.toLowerCase())) kit.push(name);
  };
  for (const phrase of [...(def.aspects ?? []), def.highConcept ?? '']) {
    for (const item of kitIn(phrase)) add(item);
  }
  return kit;
}

const CONTAINER = String.raw`(?:tote\s+bag|bag|backpack|rucksack|satchel|pouch|purse|pack|knapsack|basket|box|tin|case|briefcase|suitcase|pocket|pockets|apron|belt|bandolier|toolbelt|tool\s+belt|lunchbox)`;
const CARRY = /\b(?:carrying|carries|carry|packing|packs|armed\s+with|equipped\s+with|never\s+without|always\s+has|has\s+(?:a|an|her|his|their|my)\b)/i;
/** Heads that are never a thing in the hand. */
const ABSTRACT = new Set(['weight', 'burden', 'burdens', 'grudge', 'grudges', 'secret', 'secrets', 'heart', 'hope', 'hopes', 'dream', 'dreams', 'memory', 'memories', 'past', 'guilt', 'grief', 'sorrow', 'pride', 'fear', 'fears', 'shame', 'name', 'reputation', 'debt', 'debts', 'promise', 'promises', 'curse', 'chip', 'torch' /* "carrying a torch for" */, 'attitude', 'temper', 'smile', 'plan', 'plans', 'score', 'vendetta', 'mission', 'purpose', 'destiny', 'responsibility', 'responsibilities', 'doubt', 'doubts', 'wound', 'wounds', 'scar', 'scars', 'grin', 'mind', 'soul', 'voice', 'luck', 'knack', 'gift', 'talent', 'way', 'lot', 'history', 'reason', 'point']);
const LEAD = /^(?:a|an|the|some|her|his|their|my|your|one|two|three|several)\s+/i;

/** The concrete things one phrase says the character carries. */
function kitIn(phrase: string): string[] {
  const text = phrase.trim();
  if (!text) return [];
  const out: string[] = [];
  // "Pocket full of bottle caps", "Satchel full of maps": the container (unless it is a pocket) and what fills it.
  const full = text.match(new RegExp(String.raw`\b(${CONTAINER})\s+(?:full|stuffed|crammed|packed)\s+(?:of|with)\s+(.+)$`, 'i'));
  if (full) {
    if (!/^pockets?$/i.test(full[1]!)) out.push(...things(full[1]!));
    out.push(...list(full[2]!));
    return out;
  }
  const carry = text.match(CARRY);
  if (carry) {
    const rest = text.slice(carry.index! + carry[0].length).replace(/^\s+/, '');
    const lead = /^has\s/i.test(carry[0]) ? carry[0].split(/\s+/).pop()! + ' ' : '';
    // "a tote bag with a granola bar and a pen": the bag, then what is in it.
    const inBag = (lead + rest).match(new RegExp(String.raw`^(.*?\b${CONTAINER})\s+(?:with|of|holding|containing)\s+(.+)$`, 'i'));
    if (inBag) return [...things(inBag[1]!), ...list(inBag[2]!)];
    return list(lead + rest);
  }
  // A container named with its contents anywhere else: "…with a tote bag holding a pen".
  const bag = text.match(new RegExp(String.raw`\b((?:a|an|her|his|their|my)\s+(?:[\w-]+\s+)?${CONTAINER})\s+(?:with|holding|containing)\s+(.+)$`, 'i'));
  if (bag) return [...things(bag[1]!), ...list(bag[2]!)];
  return out;
}

/** "a granola bar and a pen", "a rusty sword, a wooden shield" → each thing. */
function list(text: string): string[] {
  const clause = text.split(/[;.:!?—–(]|\s-\s|\b(?:that|which|who|because|since|for|to|from|in|at|on|while|but)\b/i)[0]!;
  return clause.split(/,\s*(?:and\s+)?|\s+and\s+|\s+&\s+/i).flatMap(things);
}

/** One named thing, or nothing if it is not a concrete thing. */
function things(raw: string): string[] {
  let t = raw.trim().replace(/[.,;]+$/, '');
  if (/\bof\b/i.test(t)) return []; // "the weight of the world", "a pocketful of dreams"
  let prev = '';
  while (prev !== t) { prev = t; t = t.replace(LEAD, ''); }
  const name = t;
  const words = name.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return [];
  if (!words.every(w => /^[a-z][a-z'’-]*$/.test(w))) return [];
  if (ABSTRACT.has(words[words.length - 1]!)) return [];
  return [name.toLowerCase()];
}
