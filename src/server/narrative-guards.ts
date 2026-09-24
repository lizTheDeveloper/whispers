/**
 * Narrative guards: the things a prompt ASKS the model for, enforced in code.
 *
 * A live table (c54792c) showed the model ignoring four prompt instructions:
 * an isekai opening with nobody arriving, a kid of unstated gender called
 * "he" from round one, "Liz" where the kid calls her "Mom", and a character
 * declared TAKEN OUT who leaned in and whispered one line later. Everything
 * here is deterministic and pure — no LLM call — so it runs on every piece of
 * outgoing text without cost, and it is tuned to leave text alone whenever
 * it is not sure. A missed repair is a cosmetic slip; a wrong repair (an NPC
 * renamed, dialogue rewritten) is a bug the players can see.
 *
 * Pronouns are deliberately NOT repaired here any more. A rule-based rewrite
 * of he/she in model prose produced clumsy, mixed text ("…clinging to their
 * boots as Biz steps…"); instead the character interview asks each player
 * how their character is referred to, and the prompts carry that answer.
 */

// ─── Arrival ───────────────────────────────────────────────────────────────

/**
 * A premise or backstory that moves the characters from somewhere else into
 * this world. Simple on purpose: the words people actually use for it.
 */
const ARRIVAL_PREMISE = new RegExp([
  String.raw`\bisekai\w*`,
  String.raw`\bportals?\b`,
  String.raw`\bsummon(?:s|ed|ing)?\b`,
  String.raw`\btransport(?:s|ed|ing)?\b`,
  String.raw`\bteleport(?:s|ed|ing)?\b`,
  String.raw`\b(?:woke|wake|wakes|waking|awake[ns]?|awoke) up (?:in|on|at|inside|aboard)\b`,
  String.raw`\b(?:fell|fall|falls|falling|fallen) (?:into|through)\b`,
  String.raw`\b(?:pulled|pull|pulls|dragged|yanked|sucked|swept|whisked|spirited|dropped|flung|thrown|hurled|beamed|sent|carried|stolen|abducted) (?:away |off )?(?:in|into|to|through|across|out of)\b`,
  String.raw`\breincarnat\w*`,
  String.raw`\breborn (?:in|into|as)\b`,
  String.raw`\b(?:another|other|different) world\b`,
  String.raw`\bshipwreck\w*`,
  String.raw`\bcrash[- ]?land\w*`,
  String.raw`\bstranded\b`,
  String.raw`\barriv(?:e|es|ed|ing|al)\b`,
].join('|'), 'i');

export function premiseImpliesArrival(...texts: Array<string | null | undefined>): boolean {
  return texts.some(t => !!t && ARRIVAL_PREMISE.test(t));
}

/**
 * Prose that actually narrates an arrival happening to someone: the landing,
 * the waking, the blinking and reeling — not a room with nobody in it.
 */
const ARRIVAL_BEAT = new RegExp([
  String.raw`\barriv(?:e|es|ed|ing|al)\b`,
  String.raw`\bland(?:s|ed|ing)? (?:hard|on|in|with|face|flat|sprawl)`,
  String.raw`\b(?:wake|wakes|woke|waking|awake[ns]?|awoke|come to|comes to|came to)\b`,
  String.raw`\bblink(?:s|ed|ing)?\b`,
  String.raw`\bdisorient\w*`,
  String.raw`\bdizz\w*`,
  String.raw`\breel(?:s|ed|ing)?\b`,
  String.raw`\blurch(?:es|ed|ing)?\b`,
  String.raw`\b(?:stumble|stumbles|stumbled|stumbling|tumble|tumbles|tumbled|tumbling)\b`,
  String.raw`\b(?:fell|fall|falls|falling) (?:into|through|out of|onto)\b`,
  String.raw`\b(?:spat|spit|dropped|drops|thrown|flung|dumped|deposited) (?:out |onto |into |on )`,
  String.raw`\bmaterializ\w*`,
  String.raw`\b(?:find|finds|found) themselves\b`,
  String.raw`\bone moment\b`,
  String.raw`\b(?:a )?(?:moment|heartbeat|second|breath)s? (?:ago|before)\b`,
  String.raw`\bnever seen\b`,
  String.raw`\b(?:pulled|yanked|sucked|whisked|summoned|transported|isekaied) (?:in|into|through|here|across|out)\b`,
].join('|'), 'i');

export function hasArrivalBeat(text: string | null | undefined): boolean {
  return !!text && ARRIVAL_BEAT.test(text);
}

/**
 * Prose that narrates the transport itself — the flash, the pull, being
 * hurled out of one place into another. When the opening's scene prose does
 * this, it IS the arrival, and nothing else may be put in front of it: two
 * transports in a row read as the party being moved twice.
 */
const TRANSPORT_BEAT = new RegExp([
  String.raw`\b(?:hurl|fling|flung|throw|thrown|threw|pull|yank|suck|whisk|tear|tore|torn|rip|sweep|swept|drag|snatch|spin|spun|toss|catapult|launch|wrench|pluck|beam|teleport|transport|summon|isekai)(?:s|es|ed|ing|ped|ping)?\b[^.!?]{0,40}\b(?:from|out of|through|across|away)\b`,
  String.raw`\b(?:blinding|searing|sudden|brilliant|violent) (?:flash|light|burst|glare)\b`,
  String.raw`\bflash of (?:light|white|blue|gold|green)\b`,
  String.raw`\b(?:portal|vortex|wormhole)\b`,
  String.raw`\bone moment\b[^.!?]*\bthe next\b`,
].join('|'), 'i');

export function narratesTransport(text: string | null | undefined): boolean {
  return !!text && TRANSPORT_BEAT.test(text);
}

function joinNames(names: string[]): string {
  if (names.length === 0) return 'The party';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "the Bureau of Misfiled Souls" out of "…has isekaied a mother and child into the Bureau of Misfiled Souls, a kingdom…". */
function destinationFrom(premise: string): string | null {
  const m = premise.match(/\b(?:into|to|through|in|inside|onto)\s+((?:the\s+)?[A-Z][\w'’-]*(?:\s+(?:of|the|de|du|la|le|and|&|[A-Z][\w'’-]*))*)/);
  if (!m) return null;
  const dest = m[1]!.replace(/\s+(?:of|the|de|du|la|le|and|&)$/i, '').trim();
  return dest.length >= 3 ? dest : null;
}

/**
 * The arrival beat when the DM did not write one: plain, built from the
 * premise, names the party, and invents nothing beyond "they were somewhere
 * else a moment ago" — which the premise itself already says.
 */
export function fallbackArrival(premise: string, names: string[]): string {
  const who = joinNames(names);
  const dest = destinationFrom(premise);
  const where = dest ? `they have landed in ${dest}` : 'they are somewhere else entirely';
  return `${who} land hard. One moment they were in their own lives; the next, ${where}. They blink, disoriented, at a place they have never seen before.`;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * Split into [text, isQuoted] runs so dialogue is never rewritten. Double
 * quotes (straight or curly) always open speech; a single quote does only
 * where it plainly opens and closes speech ('Mom, look!'), never as an
 * apostrophe (Mom's, it's). An unclosed quote runs to the end, as quoted:
 * when unsure, leave the text alone.
 */
function quoteRuns(text: string): Array<{ text: string; quoted: boolean }> {
  const runs: Array<{ text: string; quoted: boolean }> = [];
  const re = /"[^"]*"?|“[^”]*”?|(?<=^|[\s:(\[—–-])['‘](?=[A-Za-z])[\s\S]*?(?:[^\s]['’](?![A-Za-z])|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    if (m.index > last) runs.push({ text: text.slice(last, m.index), quoted: false });
    runs.push({ text: m[0], quoted: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), quoted: false });
  return runs;
}

// ─── Address terms ─────────────────────────────────────────────────────────

export interface AddressTerm {
  /** The companion's name ("Liz"). */
  name: string;
  /** What the speaker calls them ("Mom"). */
  address: string;
}

const VOCATIVE_LEAD = String.raw`(?:hey|oh|please|okay|ok|look|listen|come on|thanks|thank you|sorry|yes|no|right|wait|so|and|but|well)`;

/**
 * A speaker with an address term for a companion uses it: "Mom Liz" is always
 * collapsed to "Mom", and — with `vocative` (the speaker's own spoken words
 * only) — the companion's bare first name used to call to them ("Liz, can
 * you…", "…help me, Liz?", "Hey Liz,") becomes the address term. A name used
 * to talk ABOUT them ("Liz's handwriting", "Liz is right") is left alone.
 */
export function repairAddress(text: string, terms: AddressTerm[], opts: { vocative: boolean }): string {
  if (!text) return text;
  let out = text;
  for (const t of terms) {
    const first = firstName(t.name);
    const address = t.address.trim();
    if (!address || address.toLowerCase() === first.toLowerCase() || address.toLowerCase() === t.name.trim().toLowerCase()) continue;
    const name = `(?:${esc(t.name.trim())}|${esc(first)})`;
    // "Mom Liz" / "Mom, Liz" → "Mom"
    out = out.replace(new RegExp(`\\b(${esc(address)})(?:,)?\\s+${name}\\b(?!['’]s)`, 'g'), '$1');
    if (!opts.vocative) continue;
    // Sentence-initial vocative: "Liz, can you…" / "Liz! Look."
    out = out.replace(new RegExp(`(^|[.!?…]\\s+|["“(]\\s*)${name}(?=\\s*[,!?])`, 'g'), `$1${address}`);
    // After a lead-in: "Hey Liz," / "Please, Liz,"
    out = out.replace(new RegExp(`(\\b${VOCATIVE_LEAD},?\\s+)${name}(?=\\s*[,.!?…]|$)`, 'gi'), `$1${address}`);
    // Trailing vocative: "…help me, Liz?" / "…, Liz."
    out = out.replace(new RegExp(`(,\\s*)${name}(?=\\s*[.!?…]|\\s*$)`, 'g'), `$1${address}`);
  }
  return out;
}

/** Words before an address term that make it a common noun, not a name: "her Mom", "the Mom Voice", "Biz's Mom". */
const NOT_A_NAME_BEFORE = /(?:\b(?:her|his|their|my|your|our|its|the|a|an|this|that|whose|every|some|any)|['’]s)\s+$/i;

/**
 * In DM-authored text — narration, resolutions, scene summaries, the
 * epilogue — a party member is called by name. An address term ("Mom") is
 * what one character calls another, so outside quoted speech "Biz steadies
 * Mom" becomes "Biz steadies Liz" and "Mom's hand" becomes "Liz's hand".
 * Narrow on purpose: only the term exactly as the sheet writes it,
 * capitalised, used as a name. "her mom", "her Mom", "the Mom Voice", a
 * term two characters use for two different people, and anything inside
 * quotation marks are left alone.
 */
export function namesInNarration(text: string, terms: AddressTerm[]): string {
  if (!text) return text;
  const byTerm = new Map<string, Set<string>>();
  for (const t of terms) {
    const address = t.address.trim();
    const name = firstName(t.name);
    if (!address || !name || !/^[A-Z]/.test(address)) continue;
    if (address.toLowerCase() === name.toLowerCase() || address.toLowerCase() === t.name.trim().toLowerCase()) continue;
    if (!byTerm.has(address)) byTerm.set(address, new Set());
    byTerm.get(address)!.add(name);
  }
  const usable = [...byTerm].filter(([, names]) => names.size === 1).map(([address, names]) => ({ address, name: [...names][0]! }));
  if (usable.length === 0) return text;
  return quoteRuns(text).map(run => {
    if (run.quoted) return run.text;
    let t = run.text;
    for (const { address, name } of usable) {
      // "Mom Liz" in narration is just "Liz".
      t = t.replace(new RegExp(`\\b${esc(address)}\\s+(${esc(name)})\\b`, 'g'), '$1');
      t = t.replace(new RegExp(`\\b${esc(address)}\\b(?!-)`, 'g'), (match: string, offset: number, whole: string) => {
        if (NOT_A_NAME_BEFORE.test(whole.slice(Math.max(0, offset - 24), offset))) return match;
        // "Mom Voice": part of a longer capitalised name, not the person.
        if (/^\s+[A-Z][a-z]/.test(whole.slice(offset + match.length)) && !/^['’]s/.test(whole.slice(offset + match.length))) {
          const next = whole.slice(offset + match.length).match(/^\s+([A-Z][\w'’-]*)/)?.[1] ?? '';
          if (!/^(?:And|But|Or|As|While|When|Then)$/.test(next)) return match;
        }
        return name;
      });
    }
    return t;
  }).join('');
}

/**
 * Fact extraction reads the DM's prose, and it recorded the party
 * themselves as NPCs — "Liz", "Biz", and "Mom" (an address term) — which
 * then came back to the DM in the world summary as people in the world.
 * Party members are not NPCs: an extracted entity named as a party member,
 * or with a party address term as its name, is dropped.
 */
export function withoutPartyEntities<T extends { newEntities: Array<{ name: string }> }>(facts: T, partyNames: string[], addressTerms: string[]): T {
  const taken = new Set([
    ...partyNames.flatMap(n => [n.trim(), firstName(n)]),
    ...addressTerms.map(a => a.trim()),
  ].filter(Boolean).map(n => n.toLowerCase()));
  const kept = facts.newEntities.filter(e => {
    const name = e.name.trim().toLowerCase();
    return !taken.has(name) && !taken.has(name.replace(/^the\s+/, ''));
  });
  return kept.length === facts.newEntities.length ? facts : { ...facts, newEntities: kept };
}

// ─── Taken out ─────────────────────────────────────────────────────────────

/** The consequence that marks a character as taken out until they recover. */
export const TAKEN_OUT = 'Taken Out (recovering)';

export function isTakenOut(state: { consequences: string[] }): boolean {
  return state.consequences.includes(TAKEN_OUT);
}

/**
 * Recovery at a scene break. Being taken out lasts until the next scene (the
 * FATE sense: out of THIS conflict), so it always clears here. Other
 * consequences keep the loop's existing rule: a lone consequence heals, and
 * when a character carries more than one (being taken out included) the
 * others are kept — those are lasting injuries.
 */
export function recoverAtSceneBreak(consequences: string[]): { kept: string[]; recovered: string[] } {
  const others = consequences.filter(c => c !== TAKEN_OUT);
  const recovered = consequences.includes(TAKEN_OUT) ? [TAKEN_OUT] : [];
  if (consequences.length > 1) return { kept: others, recovered };
  return { kept: [], recovered: [...recovered, ...others] };
}

/**
 * Party members a piece of DM prose declares taken out ("Liz is TAKEN OUT",
 * "Liz is taken out by the cabinet"), so the mechanics follow the story.
 * Requires the name as the subject of "is/was/… taken out" or the name
 * followed closely by the all-caps game term — never "have Liz taken out of
 * the queue" or "takes out a bottle cap".
 */
export function declaredTakenOut(text: string, names: string[]): string[] {
  return names.filter(n => {
    const first = esc(firstName(n));
    return new RegExp(`\\b${first}\\b\\s+(?:is|was|has been|gets|got|goes|went|lies)\\s+(?:now\\s+|utterly\\s+|completely\\s+|finally\\s+)?taken out\\b(?!\\s+of\\b)`, 'i').test(text)
      || new RegExp(`\\b${first}\\b[^.!?]{0,40}\\bTAKEN OUT\\b`).test(text);
  });
}

/** An action that helps a downed companion back up. */
const AID = /\b(?:help(?:s|ed|ing)?|tend(?:s|ed|ing)?|reviv(?:e|es|ed|ing)|rous(?:e|es|ed|ing)|wak(?:e|es|ing)|woke|shak(?:e|es|ing)|shook|lift(?:s|ed|ing)?|pull(?:s|ed|ing)? \w+ up|haul(?:s|ed|ing)? \w+ up|drag(?:s|ged|ging)?|carr(?:y|ies|ied|ying)|bandag(?:e|es|ed|ing)|heal(?:s|ed|ing)?|stead(?:y|ies|ied|ying)|kneel(?:s|ing)?|knelt|check(?:s|ed|ing)? on|comfort(?:s|ed|ing)?|support(?:s|ed|ing)?|cradl(?:e|es|ed|ing)|brac(?:e|es|ed|ing)|rush(?:es|ed|ing)? to)\b/i;

/** Does `text` (an action, maybe with spoken words) aid someone called any of `names`? */
export function aidsCharacter(text: string, names: string[]): boolean {
  if (!AID.test(text)) return false;
  return names.filter(Boolean).some(n => new RegExp(`\\b${esc(n)}\\b`, 'i').test(text));
}
