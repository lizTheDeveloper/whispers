/**
 * An NPC's kind — hedgehog, badger, owl, machine — fixed once, like its
 * pronouns (npc-pronouns.ts). Round 19 (KAZQX3): the host's chat edit made
 * Hazel a hedgehog; in scene 2 she was "Hazel, the anxious bird" with a
 * beak, feathers and wings, and the extractor rewrote her entry to
 * "Feathered creature that flinched".
 *
 * Deterministic only: the kind is read from the first description the record
 * has (the seed, or the host's redraft), handed to the DM with the pronouns
 * ("Hazel (she/her, hedgehog)"), and a later description that makes the NPC
 * another kind is not stored.
 */

/** Kinds by family: two kinds in one family never contradict ("owl" and "bird"). */
const FAMILIES: Record<string, string[]> = {
  bird: ['bird', 'owl', 'goose', 'pigeon', 'dove', 'duck', 'crow', 'raven', 'magpie', 'sparrow', 'robin', 'finch', 'wren', 'hen', 'chicken', 'rooster', 'heron', 'crane', 'stork', 'swan', 'gull', 'seagull', 'parrot', 'penguin', 'hawk', 'eagle', 'falcon', 'vulture', 'peacock', 'turkey', 'pelican', 'flamingo', 'canary', 'budgie', 'kiwi', 'woodpecker', 'hummingbird', 'songbird'],
  hedgehog: ['hedgehog', 'porcupine'],
  rodent: ['mouse', 'rat', 'hamster', 'gerbil', 'squirrel', 'chipmunk', 'marmot', 'beaver', 'vole', 'capybara', 'dormouse', 'groundhog', 'woodchuck'],
  rabbit: ['rabbit', 'hare', 'bunny'],
  mustelid: ['badger', 'otter', 'weasel', 'ferret', 'stoat', 'mink', 'wolverine'],
  canine: ['dog', 'hound', 'puppy', 'wolf', 'fox', 'jackal', 'coyote'],
  feline: ['cat', 'kitten', 'lion', 'tiger', 'leopard', 'lynx', 'panther'],
  bear: ['bear'],
  raccoon: ['raccoon'],
  mole: ['mole'],
  deer: ['deer', 'stag', 'elk', 'moose', 'reindeer'],
  frog: ['frog', 'toad', 'newt', 'salamander', 'axolotl'],
  reptile: ['lizard', 'snake', 'turtle', 'tortoise', 'crocodile', 'alligator', 'gecko', 'iguana', 'chameleon'],
  fish: ['fish', 'goldfish', 'carp', 'eel', 'shark'],
  insect: ['beetle', 'ant', 'bee', 'wasp', 'moth', 'butterfly', 'ladybug', 'cricket', 'grasshopper', 'dragonfly', 'firefly'],
  spider: ['spider'],
  snail: ['snail', 'slug'],
  octopus: ['octopus', 'squid'],
  crab: ['crab', 'lobster'],
  bat: ['bat'],
  sloth: ['sloth'],
  monkey: ['monkey', 'ape', 'gorilla', 'lemur', 'chimp', 'chimpanzee', 'orangutan'],
  horse: ['horse', 'pony', 'donkey', 'mule', 'unicorn'],
  cow: ['cow', 'bull', 'ox', 'goat', 'sheep', 'lamb', 'pig', 'llama', 'alpaca'],
  dragon: ['dragon', 'wyvern'],
  ghost: ['ghost', 'spirit', 'phantom', 'specter', 'spectre'],
  machine: ['robot', 'automaton', 'machine', 'typewriter', 'clockwork'],
};

const KIND_OF = new Map<string, string>(Object.entries(FAMILIES).flatMap(([family, kinds]) => kinds.map(k => [k, family] as [string, string])));

/** Body words that only one family has: a beak or feathers is a bird's. */
const BODY_CUES: Array<{ family: string; re: RegExp }> = [
  { family: 'bird', re: /\b(?:feather(?:s|ed|y)?|beak(?:s|ed)?|plumage|wings?|winged|talons?|tail\s+feathers)\b/i },
  { family: 'hedgehog', re: /\b(?:quills?|spines?|prickles?|prickly)\b/i },
  { family: 'fish', re: /\b(?:fins?|gills?|scales)\b/i },
];

const plural = (w: string) => (/(?:s|sh|ch|x|z)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);
const KIND_WORDS = [...KIND_OF.keys()].sort((a, b) => b.length - a.length);
const KIND_RE = new RegExp(`\\b(${KIND_WORDS.flatMap(k => [plural(k), k]).join('|')})\\b`, 'gi');

/** Before a word used as a verb: "can't bear", "to duck", "she cranes". */
const VERB_BEFORE = /\b(?:to|can|can['’]t|cannot|could|couldn['’]t|would|will|won['’]t|not|never|i|you|he|she|they|we|it|who|that)\s+$/i;
/** After a word used as a verb: "cranes her neck", "bears the weight", "ducks behind". */
const VERB_AFTER = /^\s+(?:her|his|their|its|my|your|our|them|him|me|us|the|a|an|behind|under|away|down|out|into|for|up|off)\b/i;

/** Each kind a text names as a noun, in order. */
function kindsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(KIND_RE)) {
    const before = text.slice(0, m.index);
    const after = text.slice(m.index! + m[0].length);
    if (VERB_BEFORE.test(before) || VERB_AFTER.test(after)) continue;
    const w = m[1]!.toLowerCase();
    const single = KIND_OF.has(w) ? w : KIND_WORDS.find(k => plural(k) === w);
    if (single) out.push(single);
  }
  return out;
}

/** The kind a description names first ("A kind, friendly hedgehog with spectacles…" → "hedgehog"), or null. */
export function npcKindOf(description: string | null | undefined): string | null {
  if (!description?.trim()) return null;
  return kindsIn(description)[0] ?? null;
}

/** The families a text makes something: by a kind word, or a body word only one family has. */
function familiesIn(text: string): Set<string> {
  const out = new Set<string>(kindsIn(text).map(k => KIND_OF.get(k)!));
  for (const cue of BODY_CUES) if (cue.re.test(text)) out.add(cue.family);
  return out;
}

/**
 * Does `description` make an NPC of kind `kind` something else — another
 * kind ("bird" for a hedgehog), or a body only another kind has
 * ("Feathered creature that flinched")? A description that says nothing of
 * kind ("Anxious clerk with a stamp"), or the same family ("owl" for a
 * bird), does not.
 */
export function contradictsKind(kind: string | null | undefined, description: string | null | undefined): boolean {
  const k = kind?.trim().toLowerCase();
  if (!k || !description?.trim()) return false;
  const family = KIND_OF.get(k) ?? k;
  const found = familiesIn(description);
  if (found.size === 0) return false;
  return !found.has(family);
}

/** "Hazel (she/her, hedgehog)"; "Hazel (she/her)" with no kind; the kind is left out when the name says it ("Marmot Mailman"). */
export function npcCastLabel(n: { name: string; pronouns: string; kind?: string | null }): string {
  const kind = n.kind?.trim();
  const named = kind && new RegExp(`\\b${kind}`, 'i').test(n.name);
  return `${n.name} (${[n.pronouns, named ? '' : kind].filter(Boolean).join(', ')})`;
}
