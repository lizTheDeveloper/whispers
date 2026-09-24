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
 * What IS here are the server's own templated lines about a character
 * (taken out, fallback outcomes, the whisper inbox), written in that
 * character's stated pronouns via src/shared/pronouns.ts.
 */
import { agree, capitalize, referTo } from '../shared/pronouns.js';
import { SENTENCE_SPLIT } from './sentences.js';

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
export function fallbackArrival(premise: string, names: string[], pronouns: Array<string | null | undefined> = []): string {
  const who = joinNames(names);
  const dest = destinationFrom(premise);
  if (names.length === 1) {
    // One arrival: "Liz lands hard… she was in her own life", in the
    // character's own pronouns — never "Liz land hard… they".
    const r = referTo(names[0]!, pronouns[0]);
    const S = capitalize(r.subject);
    const has = agree(r, 'has', 'have');
    const was = agree(r, 'was', 'were');
    const where = dest ? `${r.subject} ${has} landed in ${dest}` : `${r.subject} ${agree(r, 'is', 'are')} somewhere else entirely`;
    return `${who} lands hard. One moment ${r.subject} ${was} in ${r.possessive} own life; the next, ${where}. ${S} ${agree(r, 'blinks', 'blink')}, disoriented, at a place ${r.subject} ${has} never seen before.`;
  }
  const where = dest ? `they have landed in ${dest}` : 'they are somewhere else entirely';
  return `${who} land hard. One moment they were in their own lives; the next, ${where}. They blink, disoriented, at a place they have never seen before.`;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * The part of `before` that changed in `after`, with a little context, for
 * the guard logs: "…tears a sharp pain through…" → "…sends a sudden jolt
 * through…". The first 80 characters of a long passage are usually the same
 * on both sides, which made every guard log line read as a no-op.
 */
export function changedSpan(before: string, after: string, context = 24): string {
  if (before === after) return `"${before.slice(0, 80)}" (unchanged)`;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) { endB--; endA--; }
  const from = Math.max(0, start - context);
  const cut = (t: string, end: number) => `${from > 0 ? '…' : ''}${t.slice(from, Math.min(t.length, end + context))}${end + context < t.length ? '…' : ''}`;
  return `"${cut(before, endB)}" → "${cut(after, endA)}"`;
}

/**
 * Split into [text, isQuoted] runs so dialogue is never rewritten. Double
 * quotes (straight or curly) always open speech; a single quote does only
 * where it plainly opens and closes speech ('Mom, look!'), never as an
 * apostrophe (Mom's, it's). An unclosed quote runs to the end, as quoted:
 * when unsure, leave the text alone.
 */
export function quoteRuns(text: string): Array<{ text: string; quoted: boolean }> {
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
  /**
   * Not on the sheet: read off the relation ("mother" → "Mom") by
   * kinAddressTerms. Such a term only collapses a name stacked on it
   * ("Mom, Liz" → "Mom"); it never replaces a bare name or a bare "Mom".
   */
  derived?: boolean;
}

/**
 * The name stacked on an address term, after it: " Liz", ", Liz,", " (Liz)",
 * " — Liz". A comma closing ", Liz," goes with it, so "to Mom, Liz, to
 * keep…" reads "to Mom to keep…"; "Mom — Liz — look" reads "Mom — look".
 * Never a possessive ("Mom, Liz's bag" is two people).
 */
const STACKED_NAME = (name: string) => {
  const n = String.raw`${name}\b(?!['’]s)`;
  return String.raw`(?:,\s*${n}(?:,(?=\s))?|\s+\(\s*${n}\s*\)|\s*[—–]\s*${n}|\s+${n})`;
};

/** Words a speaker commonly calls a relation by, when the sheet gives the relation but no address term. */
const KIN_ADDRESS: Array<[RegExp, string[]]> = [
  [/^(?:mother|mom|mum|mommy|mummy|mama|mamma|ma)$/i, ['Mom', 'Mum', 'Mama', 'Mommy', 'Mummy', 'Mother', 'Ma']],
  [/^(?:father|dad|daddy|papa|pa)$/i, ['Dad', 'Daddy', 'Papa', 'Father', 'Pa']],
  [/^(?:grandmother|grandma|granny|gran|nana)$/i, ['Grandma', 'Granny', 'Gran', 'Nana', 'Grandmother']],
  [/^(?:grandfather|grandpa|gramps|granddad|grandad)$/i, ['Grandpa', 'Gramps', 'Granddad', 'Grandad', 'Grandfather']],
  [/^(?:aunt|auntie|aunty)$/i, ['Aunt', 'Auntie', 'Aunty']],
  [/^(?:uncle)$/i, ['Uncle']],
];

/**
 * Address terms read off relations, for companions at the table: a sheet
 * that says Liz is Biz's "mother" but gives no address term still means
 * "Mom, Liz" is "Mom" in Biz's mouth and "Liz" in narration. Marked
 * `derived` (see AddressTerm): they only collapse a stacked name.
 */
export function kinAddressTerms(relationships: Array<{ to: string; relation: string; address?: string }>, tableNames: string[]): AddressTerm[] {
  const out: AddressTerm[] = [];
  for (const r of relationships) {
    const to = r.to?.trim();
    const target = tableNames.find(n => to && (n.trim().toLowerCase() === to.toLowerCase() || firstName(n).toLowerCase() === firstName(to).toLowerCase()));
    if (!target) continue;
    const words = KIN_ADDRESS.find(([re]) => re.test(r.relation?.trim() ?? ''))?.[1] ?? [];
    for (const w of words) {
      if (r.address?.trim().toLowerCase() === w.toLowerCase()) continue;
      out.push({ name: target, address: w, derived: true });
    }
  }
  return out;
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
    // "Mom Liz" / "Mom, Liz," / "mom Liz" / "Mom (Liz)" / "Mom — Liz —" → "Mom"
    out = out.replace(new RegExp(`\\b(${esc(address)})${STACKED_NAME(name)}`, 'gi'), '$1');
    if (!opts.vocative || t.derived) continue;
    // Sentence-initial vocative: "Liz, can you…" / "Liz! Look."
    out = out.replace(new RegExp(`(^|[.!?…]\\s+|["“(]\\s*)${name}(?=\\s*[,!?])`, 'g'), `$1${address}`);
    // After a lead-in: "Hey Liz," / "Please, Liz,"
    out = out.replace(new RegExp(`(\\b${VOCATIVE_LEAD},?\\s+)${name}(?=\\s*[,.!?…]|$)`, 'gi'), `$1${address}`);
    // Trailing vocative: "…help me, Liz?" / "…, Liz."
    out = out.replace(new RegExp(`(,\\s*)${name}(?=\\s*[.!?…]|\\s*$)`, 'g'), `$1${address}`);
    // Mid-sentence vocative: "We are still in the queue, Liz, because…" —
    // not a list ("Barnaby, Liz, and Ms. Hark": a name before, or "and" after).
    out = out.replace(new RegExp(`(?<![A-Z][\\w'’.-]*)(,\\s*)${name}(,)(?!\\s*(?:(?:and|or|nor)\\b|&|[A-Z]))`, 'g'), `$1${address}$2`);
  }
  return out;
}

/**
 * In a character's OWN words about a companion — their closing reflection —
 * the companion is called what this character calls them, not only when
 * spoken to. Round 14 (7RAAQ7): Biz's last thought was "I am safe in Liz's
 * grip"; Biz calls Liz "Mom". Only a term that works as a name (one
 * capitalised word: "Mom", "Dad", "Grandma", "Odo") replaces the bare name
 * — "my kid" never does — and a sentence that states the name ("calls her
 * Liz") is left as written. A sheet's own term wins over one read off a
 * relation. Run repairAddress first, so "Mom, Liz" is already "Mom".
 */
export function ownWordsForCompanions(text: string, terms: AddressTerm[]): string {
  if (!text) return text;
  const byName = new Map<string, AddressTerm>();
  for (const t of terms) {
    const address = t.address?.trim() ?? '';
    if (!/^\p{Lu}[\p{L}'’-]*$/u.test(address)) continue;
    const key = t.name.trim().toLowerCase();
    const had = byName.get(key);
    if (!had || (had.derived && !t.derived)) byName.set(key, t);
  }
  let out = text;
  for (const t of byName.values()) {
    const first = firstName(t.name);
    const address = t.address.trim();
    if (address.toLowerCase() === first.toLowerCase() || address.toLowerCase() === t.name.trim().toLowerCase()) continue;
    const name = `(?:${esc(t.name.trim())}|${esc(first)})`;
    out = out.replace(new RegExp(`(?<![\\p{L}'’-])${name}(?![\\p{L}-])`, 'gu'), (m: string, offset: number, whole: string) => (statesAddress(whole.slice(0, offset)) ? m : address));
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
/**
 * Text before an address term that STATES it: "calls Liz ", "calls her ",
 * "calls Liz 'Mom'", "known as ", "nicknamed ". A sentence saying what
 * someone is called is left exactly as written — live, the interview's
 * summary "…and calls her Mom, Liz" was cut to "…and calls Liz."
 */
const STATES_ADDRESS_BEFORE = /\b(?:call|calls|called|calling|nicknames?|nicknamed|nicknaming|names?|named|naming|knows?|knew|known)\s+(?:(?:[A-Z][\w'’-]*|her|him|them|you|me|us|it|each other|one another)\s+)?(?:as\s+)?(?:just\s+|simply\s+|only\s+|still\s+|always\s+)?["“‘']?$/;
const statesAddress = (before: string) => STATES_ADDRESS_BEFORE.test(before.slice(-48));

export function namesInNarration(text: string, terms: AddressTerm[]): string {
  if (!text) return text;
  // "their mom Liz" / "Mom, Liz," / "Mom (Liz)" in narration is just "Liz",
  // for every term — derived ones included. "her mom" alone stays, and so
  // does "her mother, Liz" (lower case, then a comma: an appositive).
  const stacked = (t: string) => {
    let out = t;
    for (const term of terms) {
      const address = term.address.trim();
      const name = firstName(term.name);
      if (!address || !name || address.toLowerCase() === name.toLowerCase()) continue;
      const nameRe = `(?:${esc(term.name.trim())}|${esc(name)})`;
      out = out.replace(
        new RegExp(`(?:\\b(?:her|his|their|my|your|our)\\s+)?\\b(${esc(address)})(${STACKED_NAME(nameRe)})`, 'gi'),
        (match: string, term: string, rest: string, offset: number, whole: string) => {
          // "calls her Mom, Liz": what she is called, stated — kept.
          const termAt = offset + match.length - term.length - rest.length;
          if (statesAddress(whole.slice(0, termAt)) || statesAddress(whole.slice(0, offset))) return match;
          // "their mother, Liz" is an appositive — the relation, then the
          // name — and good prose; "their mom Liz" and "Mom, Liz" are not.
          return /^[a-z]/.test(term) && !/^\s+[^\s(—–]/.test(rest) ? match : name;
        },
      );
    }
    return out;
  };
  const byTerm = new Map<string, Set<string>>();
  for (const t of terms) {
    const address = t.address.trim();
    const name = firstName(t.name);
    if (t.derived) continue;
    if (!address || !name || !/^[A-Z]/.test(address)) continue;
    if (address.toLowerCase() === name.toLowerCase() || address.toLowerCase() === t.name.trim().toLowerCase()) continue;
    if (!byTerm.has(address)) byTerm.set(address, new Set());
    byTerm.get(address)!.add(name);
  }
  const usable = [...byTerm].filter(([, names]) => names.size === 1).map(([address, names]) => ({ address, name: [...names][0]! }));
  return quoteRuns(text).map(run => {
    if (run.quoted) return run.text;
    let t = stacked(run.text);
    for (const { address, name } of usable) {
      // "Mom Liz" in narration is just "Liz".
      t = t.replace(new RegExp(`\\b${esc(address)}\\s+(${esc(name)})\\b`, 'g'), (match: string, n: string, offset: number, whole: string) =>
        statesAddress(whole.slice(0, offset)) ? match : n);
      t = t.replace(new RegExp(`\\b${esc(address)}\\b(?!-)`, 'g'), (match: string, offset: number, whole: string) => {
        if (NOT_A_NAME_BEFORE.test(whole.slice(Math.max(0, offset - 24), offset))) return match;
        // "Biz calls Liz Mom": the term, stated — not Liz being called by it.
        if (statesAddress(whole.slice(0, offset))) return match;
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
 * The phrases on a character's sheet — high concept, trouble, aspects, and
 * each stunt's name ("Mom Voice" of "Mom Voice: +2 to Provoke…") — that
 * describe the character and are never anyone's name. Two words or more:
 * a one-word aspect is too likely to be an ordinary word.
 */
export function sheetPhrases(def: { highConcept?: string | null; trouble?: string | null; aspects?: string[] | null; stunts?: string[] | null }): string[] {
  const stuntNames = (def.stunts ?? []).map(st => st.split(/[:—–(]/)[0] ?? '').filter(n => n.trim().split(/\s+/).length <= 6);
  return [...new Set([def.highConcept, def.trouble, ...(def.aspects ?? []), ...stuntNames]
    .map(p => (p ?? '').trim().replace(/^["“'‘]+|["”'’.]+$/g, '').trim())
    .filter(p => p.split(/\s+/).length >= 2))];
}

const normPhrase = (s: string) => s.trim().toLowerCase().replace(/^["“'‘]+|["”'’]+$/g, '').replace(/^(?:the|a|an)\s+/, '').replace(/\s+/g, ' ').trim();

/**
 * A name that is really a sheet phrase, whole ("the Wanders Off After
 * Anything Shiny"; case, quotes and a leading article aside). Never a part
 * of one: an aspect "Quillwick the Archivist Owes Me" must not retire the
 * NPC Quillwick the Archivist.
 */
export function isSheetPhraseName(name: string, phrases: string[]): boolean {
  const n = normPhrase(name);
  return !!n && phrases.some(p => normPhrase(p) === n);
}

/**
 * Fact extraction reads the DM's prose, and it recorded the party
 * themselves as NPCs — "Liz", "Biz", and "Mom" (an address term) — which
 * then came back to the DM in the world summary as people in the world.
 * Party members are not NPCs: an extracted entity named as a party member,
 * with a party address term as its name, or named after a phrase on a
 * party sheet (a high concept, a trouble, an aspect, a stunt — live, Biz's
 * trouble "Wanders Off After Anything Shiny" became a paper sprite) is
 * dropped.
 */
export function withoutPartyEntities<T extends { newEntities: Array<{ name: string }> }>(facts: T, partyNames: string[], addressTerms: string[], phrases: string[] = []): T {
  const taken = new Set([
    ...partyNames.flatMap(n => [n.trim(), firstName(n)]),
    ...addressTerms.map(a => a.trim()),
  ].filter(Boolean).map(n => n.toLowerCase()));
  const kept = facts.newEntities.filter(e => {
    const name = e.name.trim().toLowerCase();
    if (taken.has(name) || taken.has(name.replace(/^(?:the|a|an)\s+/, ''))) return false;
    // "Curious Kid With a Sketchbook" is Biz, described — not an NPC.
    return !isSheetPhraseName(e.name, phrases);
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

// ─── High concepts are not names ───────────────────────────────────────────

/**
 * A party member's high concept used as a noun phrase in DM prose — "the
 * Curious Kid With a Sketchbook steps forward" — is that member, so it
 * becomes their name ("Biz steps forward"). Only the whole phrase, with an
 * optional leading article, in any case; quoted speech is left alone, and
 * so is the phrase set beside the name it describes ("Biz — Curious Kid
 * With a Sketchbook, 10 years old", the plain introduction).
 */
export function highConceptsToNames(text: string, party: Array<{ name: string; highConcept?: string | null }>): string {
  if (!text) return text;
  const concepts = party.filter(p => p.highConcept && p.highConcept.trim().split(/\s+/).length >= 2);
  if (concepts.length === 0) return text;
  return quoteRuns(text).map(run => {
    if (run.quoted) return run.text;
    let t = run.text;
    for (const p of concepts) {
      const phrase = esc(p.highConcept!.trim()).replace(/\s+/g, '\\s+');
      const name = firstName(p.name);
      const besideName = new RegExp(`\\b${esc(name)}\\s*[—–,:(-]\\s*$`);
      t = t.replace(new RegExp(`\\b(?:(?:the|a|an)\\s+)?${phrase}(?![\\w'’-])`, 'gi'), (match: string, offset: number, whole: string) =>
        // "Biz — Curious Kid With a Sketchbook": describing them beside their name.
        besideName.test(whole.slice(Math.max(0, offset - name.length - 6), offset)) ? match : name);
    }
    return t;
  }).join('');
}

// ─── Sheet phrases are traits, not beings ─────────────────────────────────

export interface SheetOwner {
  name: string;
  /** Trouble, aspects, stunt names (see sheetPhrases). The high concept may be among them. */
  phrases: string[];
}

/**
 * Before a sheet phrase: using it as a trait, which is the game's own
 * mechanic ("Liz draws on Office Manager Who Speaks Fluent Bureaucracy",
 * "Biz's Wanders Off After Anything Shiny", "her trouble, …").
 */
const TRAIT_USE_BEFORE = new RegExp(String.raw`(?:\b(?:draws?|drawing|drew|calls?|called|calling|leans?|leaning|leaned|relies|rely|relying|relied)\s+(?:on|upon|into)|\b(?:invok\w*|channel\w*|embrac\w*|compel\w*|us(?:e|es|ed|ing)|tap(?:s|ped|ping)?\s+into|true\s+to|lives?\s+up\s+to|living\s+up\s+to)|\b(?:aspects?|troubles?|stunts?|concept|habit|trait|nature|flaw|knack|urge|tendency|streak|motto|words)|['’]s|\b(?:her|his|their|my|your|our|its))\s*[,:—–-]?\s*(?:(?:her|his|their|my|your|our|the)\s+(?:own\s+)?(?:aspect|trouble|stunt|high\s+concept)\s*[,:—–-]?\s*)?["“‘']?\s*$`, 'i');

/** Words that make an article + adjectives before a quoted phrase part of a trait mention, not a creature: "the trouble "…"". */
const TRAIT_NOUN = /\b(?:aspects?|troubles?|stunts?|concept|habit|trait|nature|flaw|knack|urge|tendency|streak|motto|words|phrase|label|name|old)\b/i;

/** A phrase as a regex: whitespace-tolerant, quotes and case as written are handled by the caller. */
const phraseRe = (p: string) => esc(p.trim()).replace(/\s+/g, '\\s+');

/** Title-cased use: at least two capitalised words (so "wanders off after anything shiny", the verb, is left alone). */
const titleCased = (m: string) => (m.match(/\b[A-Z][\w'’-]*/g) ?? []).length >= 2;

/**
 * DM prose that turns a party member's trouble or aspect into a being or a
 * place — "a shimmering paper sprite—Wanders Off After Anything Shiny—flits
 * toward a glittering golden stamp", "the wandering 'Wanders Off After
 * Anything Shiny' hovers" — is repaired: an apposition of the phrase is
 * dropped ("a shimmering paper sprite flits…"), and the phrase used as a
 * noun ("the wandering 'Wanders Off…' hovers", "the Wanders Off") becomes
 * the owner's name. Left alone: the phrase as a trait (an invocation, a
 * possessive, "the trouble '…'"), beside the owner's name, in quoted
 * speech, and in lower case ("Biz wanders off after anything shiny").
 */
export function sheetPhrasesToNames(text: string, party: SheetOwner[]): string {
  if (!text) return text;
  let out = text;
  for (const p of party) {
    const name = firstName(p.name);
    const besideName = new RegExp(`\\b${esc(name)}\\s*[—–,:(-]\\s*["“‘']?$`);
    for (const phrase of p.phrases) {
      if (phrase.trim().split(/\s+/).length < 2) continue;
      const P = phraseRe(phrase);
      // 1. Quoted, after an article and up to two lower-case words: a being.
      out = out.replace(new RegExp(`\\b(?:the|a|an)\\s+((?:[a-z][\\w-]*\\s+){0,2})["“‘']${P}["”’']`, 'gi'), (match: string, adjs: string, offset: number, whole: string) => {
        if (/[A-Z]/.test(adjs) || TRAIT_NOUN.test(adjs) || TRAIT_USE_BEFORE.test(whole.slice(Math.max(0, offset - 40), offset))) return match;
        return name;
      });
      // The rest is outside quoted speech only.
      out = quoteRuns(out).map(run => {
        if (run.quoted) return run.text;
        let t = run.text;
        // 2. Apposition: "sprite—Wanders Off After Anything Shiny—flits", "sprite, …, flits".
        t = t.replace(new RegExp(`\\s*([—–]|--|,)\\s*(${P})\\s*(?:[—–]|--|,)\\s*`, 'gi'), (match: string, _dash: string, phr: string, offset: number, whole: string) => {
          if (!titleCased(phr)) return match;
          const before = whole.slice(Math.max(0, offset - name.length - 4), offset);
          if (new RegExp(`\\b${esc(name)}\\s*$`).test(before)) return match; // "Biz — Wanders Off…, 10 years old"
          return ' ';
        });
        // 3. The phrase (or its first 2+ words after "the") as a noun: the owner.
        const words = phrase.trim().split(/\s+/);
        const prefixes = words.slice(2).map((_, k) => words.slice(0, words.length - 1 - k).join(' ')).filter(x => x.split(' ').length >= 2);
        const alts = [P, ...prefixes.map(phraseRe)];
        t = t.replace(new RegExp(`(\\b(?:the|a|an)\\s+(?:[a-z][\\w-]*\\s+){0,2})?(${alts.join('|')})(?![\\w'’-])`, 'gi'), (match: string, lead: string | undefined, phr: string, offset: number, whole: string) => {
          if (!titleCased(phr)) return match;
          // Case-sensitive checks here: the regex is case-insensitive.
          if (/^\s+[A-Z]/.test(whole.slice(offset + match.length))) return match; // part of a longer name
          if (lead && /\s[A-Z]/.test(lead)) return match;
          const isWhole = new RegExp(`^${P}$`, 'i').test(phr);
          if (!isWhole && !lead) return match; // "Wanders Off" alone is too little to go on
          if (lead && TRAIT_NOUN.test(lead)) return match;
          const before = whole.slice(Math.max(0, offset - 40), offset);
          if (TRAIT_USE_BEFORE.test(before) || besideName.test(before)) return match;
          return name;
        });
        return t;
      }).join('');
    }
  }
  return out;
}


/**
 * A character's options, with every other party member's sheet phrase used
 * as a being replaced by that member's name ("warning the Wanders Off not to
 * distract us" → "warning Biz not to distract us"), and — while at least two
 * options remain — an option that treats the character's OWN trait as a
 * being ("I follow Wanders Off After Anything Shiny toward the sealed
 * shelf") dropped: there is no name that could stand in for it there.
 */
export function optionsWithoutSheetBeings<T extends { description: string }>(options: T[], owner: string, party: SheetOwner[]): T[] {
  const same = (p: SheetOwner) => firstName(p.name).toLowerCase() === firstName(owner).toLowerCase();
  const others = party.filter(p => !same(p));
  const self = party.filter(same);
  const fixed = options.map(o => ({ ...o, description: sheetPhrasesToNames(o.description, others) }));
  const kept = fixed.filter(o => sheetPhrasesToNames(o.description, self) === o.description);
  return kept.length >= 2 ? kept : fixed;
}

// ─── Templated lines about a character ─────────────────────────────────────

/** "Liz is TAKEN OUT — …, she collapses or is forced to retreat." */
export function takenOutLine(name: string, pronouns: string | null | undefined): string {
  const r = referTo(name, pronouns);
  return `${name} is TAKEN OUT — overwhelmed by stress and injuries, ${r.subject} ${agree(r, 'collapses', 'collapse')} or ${agree(r, 'is', 'are')} forced to retreat. The opposition decides what happens next.`;
}

/**
 * The loop's own outcome lines for a character: the fallback success when
 * the ruling had no prose, and the beat appended when the FATE math corrects
 * a "success" the DM narrated. In the character's pronouns, or their name.
 */
export function outcomeLines(name: string, pronouns: string | null | undefined): { success: string; correction: Record<'tie' | 'success-with-cost' | 'failure', string[]> } {
  const r = referTo(name, pronouns);
  const S = capitalize(r.subject);
  const didnt = `${r.subject} didn't`;
  return {
    success: `${name} acts decisively, and the moment shifts in ${r.possessive} favor.`,
    // Round 14 (7RAAQ7): "But the victory isn't clean — something slips,
    // cracks, or shifts in the process." read as a template (a list of
    // options) and "the kind that leaves bruises" was read at a table with
    // a ten-year-old. Six of each, rotated per game (LineRotation), none
    // sharing a four-word phrase.
    correction: {
      tie: [
        `It works — though not cleanly, and one small thing goes sideways.`,
        `Yet something catches — a snag, a cost, a complication ${didnt} foresee.`,
        `The moment teeters between triumph and consequence.`,
        `${S} ${agree(r, 'gets', 'get')} there, with a wobble along the way.`,
        `A win, just barely, with a small price attached.`,
        `Almost clean — almost. A little something goes astray.`,
      ],
      'success-with-cost': [
        `But the price is steep — the effort leaves its mark.`,
        `Success, yes — but it costs more than ${r.subject} hoped.`,
        `${S} ${agree(r, 'pushes', 'push')} through, but the strain shows.`,
        `It happens, though something has to give to make it so.`,
        `The goal is reached, with a toll paid on the way.`,
        `It comes together — at a price.`,
      ],
      failure: [
        `But the numbers don't lie — the attempt falls short, and the situation shifts against ${r.object}.`,
        `Yet despite the effort, circumstances conspire — and the moment slips away.`,
        `But fate has other plans — the attempt crumbles under scrutiny.`,
        `Not this time — the plan comes apart before it can work.`,
        `It doesn't land, and things get a little more tangled.`,
        `The try goes wide, and the chance passes for now.`,
      ],
    },
  };
}

/** The whisper ack when a whisper waits for the character's next choice, or cannot. */
export function whisperInboxMessage(name: string, pronouns: string | null | undefined, kind: 'queued' | 'full'): string {
  const r = referTo(firstName(name), pronouns);
  return kind === 'full'
    ? `${name} is still carrying your last whispers — wait for ${r.possessive} next choice.`
    : `${name} will carry your whisper into ${r.possessive} next choice.`;
}

// ─── Whispers are private ──────────────────────────────────────────────────

/**
 * A reference to the whisper itself: "the whisper", "the conveyor belt
 * whisper", "the whisper's target", "the voice", "the suggestion". Not the
 * verb — "I whisper to Mom" is the character whispering — and not "a whisper
 * of wind".
 */
const WHISPER_REFERENCE = /(?<!\bin\s)\b(?:the|that|this|its|a|my|your)\s+(?:[\w-]+\s+){0,3}?whisper(?:s|['’]s)?\b(?!\s+of\b)|\bwhispered\s+(?:advice|suggestion|warning|urging|instructions?|voice)\b|\b(?:the|that|this|those|these|inner)\s+voices?(?:['’]s?)?(?![\w'’])(?!\s+(?:from|of|behind|on|at|through|calls?|called|echo))|\ba\s+voice\s+(?:that|who|which|told|tells|telling|said|says|urged|urges|whispered|inside|within|in\s+my)\b|\bthe\s+suggestion\b|\bvoices?\s+in\s+(?:my|your|their|his|her)\s+head\b/i;

/**
 * A character's PUBLIC action or words with every clause that mentions the
 * whisper taken out. Everyone at the table sees the action line; the whisper
 * belongs to one player. Live: "Biz: Sprint down the spiraling passage with
 * Mom, ignoring the conveyor belt whisper." The private thought is never
 * passed through this. Returns '' when nothing is left.
 */
export function withoutWhisperMentions(text: string): string {
  if (!text || !WHISPER_REFERENCE.test(text)) return text;
  const end = text.trim().match(/[.!?…]+["”’']?$/)?.[0] ?? '';
  const body = end ? text.trim().slice(0, -end.length) : text.trim();
  // Clauses, split after commas, semicolons and dashes (the separator stays
  // with the clause before it), and before "and I" / "but she" / "because
  // they" — a closing reflection ran one long sentence with no commas.
  const clauses = body.split(/(?<=[,;—–])\s*|\s+(?=(?:and|but|so|because|while|though|although)\s+(?:I|we|he|she|they)\b)/);
  const kept = clauses.filter(c => !WHISPER_REFERENCE.test(c));
  if (kept.length > 0 && kept[0] !== clauses[0]) {
    // "…, and I stayed close" left first: it starts the sentence now.
    const lead = kept[0]!.replace(/^(?:and|but|so|because|while|though|although)\s+/i, '');
    kept[0] = lead.charAt(0).toUpperCase() + lead.slice(1);
  }
  let out = kept.join(' ').replace(/\s+/g, ' ').trim().replace(/[,;—–]\s*$/, '').trim();
  if (!out) return '';
  out = out + (end && !/[.!?…]$/.test(out) ? end : '');
  if (out !== text.trim()) console.log(`[guard] whisper mention removed from a public action: ${changedSpan(text.trim(), out)}`);
  return out;
}

/**
 * The DM narrating a whisper or a voice speaking to a character: "a sudden,
 * urgent whisper in their ear hisses, 'Grab the red form…'". Whispers come
 * only from players. NPCs whispering to one another, or a voice calling out
 * of the stacks, are ordinary scene.
 */
const DM_WHISPER = [
  // "a sudden, urgent whisper in their ear hisses" — a disembodied whisper or
  // voice (a noun, with its article: "Odo whispers in her ear" is Odo).
  /\b(?:a|an|the|some)\s+(?:[\w,'’-]+\s+){0,3}?(?:whisper|voice|murmur)\b[^.!?]*?\b(?:in|into|inside)\s+(?:(?:their|his|her|your)\s+|[A-Z][\w]*['’]s\s+)(?:ear|ears|mind|head|thoughts|skull)\b/i,
  // "In Biz's head, a voice murmurs…"
  /\b(?:in|into|inside)\s+(?:(?:their|his|her|your)\s+|[A-Z][\w]*['’]s\s+)(?:ear|ears|mind|head|thoughts)\b[^.!?]*?\b(?:a|an|the|some)\s+(?:[\w,'’-]+\s+){0,3}?(?:whisper|voice|murmur)\b/i,
  // "the mysterious voice urges…" — the voice itself, not "the voice of the clerk".
  /\bthe\s+(?:mysterious\s+|familiar\s+|guiding\s+|quiet\s+|strange\s+)?(?:voice|whisper)\b(?!\s+(?:of|from|behind|on|at|through|in the))[^.!?]*?\b(?:urges|says|tells|hisses|insists|commands|warns|murmurs|whispers|suggests)\b/i,
];

const SENTENCES = SENTENCE_SPLIT;

/** DM prose without any sentence that narrates a whisper or a voice speaking to a character. */
export function withoutDmWhispers(text: string): string {
  if (!text || !/\b(?:whisper|voice|murmur)/i.test(text)) return text;
  const paragraphs = text.split(/(\n+)/);
  let dropped = 0;
  const out = paragraphs.map(p => {
    if (/^\n+$/.test(p)) return p;
    const sentences = p.split(SENTENCES);
    const kept = sentences.filter(sn => {
      const bad = DM_WHISPER.some(re => re.test(sn));
      if (bad) dropped++;
      return !bad;
    });
    return kept.join(' ');
  }).join('').replace(/\n{3,}/g, '\n\n').trim();
  if (dropped === 0) return text;
  if (!out) return text;
  console.log(`[guard] dropped ${dropped} DM sentence(s) narrating a whisper or voice to a character`);
  return out;
}

// ─── Items change hands only in the ruling ─────────────────────────────────

const ACQUIRE = /\b(?:take|takes|took|taking|snatch(?:es|ed|ing)?|grab(?:s|bed|bing)?|seiz(?:e|es|ed|ing)|pocket(?:s|ed|ing)?|pick(?:s|ed|ing)?\s+up|lift(?:s|ed|ing)?|scoop(?:s|ed|ing)?|wrest(?:s|ed|ing)?|pr(?:y|ies|ied|ying)|yank(?:s|ed|ing)?|pull(?:s|ed|ing)?|catch(?:es|ing)?|caught|collect(?:s|ed|ing)?|retriev(?:e|es|ed|ing)|find(?:s|ing)?|found|claim(?:s|ed)?\s+(?:it|the)\b[^.!?]*\b(?:from|off)|receiv(?:e|es|ed|ing)|accept(?:s|ed|ing)?|win(?:s|ning)?|won|steal(?:s|ing)?|stole|swipe(?:s|d)?|tuck(?:s|ed|ing)?|slip(?:s|ped|ping)?\s+(?:it|the)[^.!?]*\binto|clos(?:e|es|ed|ing)\s+(?:tight(?:ly)?\s+)?(?:around|over)|lock(?:s|ed)?\s+around)\b/i;
const GIVE_TO = (name: string) => new RegExp(`\\b(?:hand(?:s|ed|ing)?|give(?:s|n)?|gave|giving|pass(?:es|ed|ing)?|toss(?:es|ed|ing)?|offer(?:s|ed|ing)?|slid(?:e|es|ing)?|press(?:es|ed|ing)?)\\b[^.!?]*\\b${name}\\b|\\b${name}\\b[^.!?]*\\b(?:is|was)\\s+(?:handed|given|passed|tossed)\\b|\\b(?:hand(?:s|ed)?|give(?:s|n)?|gave|pass(?:es|ed)?)\\s+${name}\\b`, 'i');
const REFUSAL = /\b(?:refus(?:e|es|ed|ing)|won['’]t|wouldn['’]t|fails?\s+to|keeps?|kept|holds?\s+(?:it|onto)|withhold(?:s|ing)?|clutch(?:es)?\s+(?:it|her|his|their)|snatch(?:es|ed)?\s+(?:it\s+)?back|out\s+of\s+reach)\b/i;
/** Verbs by which an item comes to someone — for a plain negation right before one ("does not hand", "never takes"). */
const TRANSFER_VERB = String.raw`(?:take|takes|took|grab|grabs|snatch|snatches|pocket|pockets|pick|picks|hand|hands|give|gives|gave|pass|passes|press|presses|place|places|slip|slips|put|puts|tuck|tucks|drop|drops|receive|receives|accept|accepts|catch|catches|claim|claims|let\s+(?:her|him|them|\w+)\s+(?:have|take))`;
const NEGATED_TRANSFER = new RegExp(String.raw`\b(?:not|never|no\s+longer|doesn['’]t|didn['’]t|can['’]t|cannot|won['’]t|wouldn['’]t)\s+(?:\w+\s+){0,2}?${TRANSFER_VERB}\b`, 'i');
/**
 * Up to three describing words before a noun: "sticky, ink-stained", "own
 * open", "small" — never a little word that starts a new phrase, so
 * "catches sight of the key" is not "catches … the key".
 */
const ADJS = String.raw`(?:(?!(?:the|a|an|of|to|at|from|with|in|on|into|onto|for|and|but|or|toward|towards|by|near|over|under|through|as|while|when)\b)[\w'’-]+,?\s+){0,3}?`;
/** Where a hand-off lands: a hand, a pocket, a grip. */
const KEEPING = String.raw`(?:palm|palms|hand|hands|pocket|pockets|grip|fingers|fist|arms|keeping)`;
/**
 * A hand-off into someone's keeping: "pressing the brass key into her palm",
 * "slips the note into Liz's pocket", "slips the glowing envelope into Biz's
 * sticky, ink-stained hand". Group 1 is the verb, group 2 the receiver
 * ("her", "Liz's").
 */
const HANDOFF = new RegExp(String.raw`\b(press(?:es|ed|ing)?|plac(?:e|es|ed|ing)|guid(?:e|es|ed|ing)|slip(?:s|ped|ping)?|put(?:s|ting)?|tuck(?:s|ed|ing)?|drop(?:s|ped|ping)?|push(?:es|ed|ing)?|fold(?:s|ed|ing)?|shov(?:e|es|ed|ing))\b[^.!?;]*?\b(?:into|in|onto)\s+(her|their|his|[A-Z][\w-]*['’]s)\s+${ADJS}${KEEPING}\b`, 'i');

/**
 * Words a story uses for the same kind of thing: the DM's "glowing
 * envelope" is the item "The Letter of Truth", its "paper" the item "Form
 * 9-B". Kept to a handful of things, where the live drift was.
 */
const ITEM_KIN: Record<string, string[]> = {
  letter: ['envelope', 'note', 'missive'],
  envelope: ['letter'],
  note: ['letter', 'slip'],
  form: ['paper', 'document'],
  document: ['paper', 'form'],
  paper: ['form', 'document'],
  scroll: ['parchment'],
  // Live (Z9JKG2): "Liz hurls the granola bar… Marni catches the snack".
  bar: ['snack'],
};

/** Words ending in s that are not plurals (or have no singular worth using). */
const NOT_PLURAL = new Set(['glass', 'grass', 'brass', 'compass', 'dress', 'press', 'chess', 'moss', 'boss', 'cross', 'lens', 'bus', 'gas', 'news', 'series', 'species', 'scissors', 'pants', 'trousers', 'jeans', 'glasses', 'binoculars', 'tongs', 'pliers', 'shears', 'clothes', 'canvas', 'atlas', 'iris', 'dice', 'mess', 'kiss', 'abyss', 'mattress', 'harness', 'address', 'business', 'always', 'perhaps']);
const IRREGULAR_SINGULAR: Record<string, string> = { knives: 'knife', leaves: 'leaf', wolves: 'wolf', halves: 'half', loaves: 'loaf', shelves: 'shelf', scarves: 'scarf', lives: 'life', wives: 'wife', geese: 'goose', teeth: 'tooth', feet: 'foot', mice: 'mouse', children: 'child', men: 'man', women: 'woman' };

/** One word in the singular: "caps" → "cap", "matches" → "match", "berries" → "berry"; anything else as it is. */
function singularWord(w: string): string {
  const lw = w.toLowerCase();
  const keepCase = (s: string) => (/^[A-Z]/.test(w) ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  if (IRREGULAR_SINGULAR[lw]) return keepCase(IRREGULAR_SINGULAR[lw]!);
  if (lw.length <= 3 || NOT_PLURAL.has(lw) || /(?:ss|us|is|['’]s)$/.test(lw) || !/s$/.test(lw)) return w;
  if (/[^aeiou]ies$/.test(lw)) return w.slice(0, -3) + 'y';
  if (/(?:ches|shes|sses|xes|zzes)$/.test(lw)) return w.slice(0, -2);
  return w.slice(0, -1);
}

/** A noun in a pattern, singular or plural: cap → cap(s), match → match(es), berry → berr(y|ies). */
function nounForms(n: string): string {
  const e = esc(n);
  if (/[^aeiou]y$/i.test(n)) return `${esc(n.slice(0, -1))}(?:y|ies)`;
  if (/(?:ch|sh|x|z|s)$/i.test(n)) return `${e}(?:es)?`;
  return `${e}s?`;
}
const nounAlt = (nouns: string[]) => `(?:${nouns.map(nounForms).join('|')})`;

/** A count on an item's name: "Bottle caps ×2" (live NUMMRL: Liz's second bottle cap was "not added twice"). */
const COUNT = /\s*×\s*(\d+)\s*$/;

/** An item's name without its count: "Bottle caps ×2" → "Bottle caps". */
export function withoutCount(name: string): string {
  return name.replace(COUNT, '').trim();
}

/** How many of a thing a name holds: "Bottle caps ×3" → 3, "Bottle cap" → 1, an uncounted stack ("Bottle caps") → null. */
export function itemCount(name: string): number | null {
  const m = name.match(COUNT);
  if (m) return Math.max(1, parseInt(m[1]!, 10));
  return isStack(name) ? null : 1;
}

/** One word in the plural: "cap" → "caps", "match" → "matches", "berry" → "berries". */
function pluralWord(w: string): string {
  if (/[^aeiou]y$/i.test(w)) return w.slice(0, -1) + 'ies';
  if (/(?:s|x|z|ch|sh)$/i.test(w)) return w + 'es';
  return w + 's';
}

/**
 * A thing's name with a count: 1 is the single ("Bottle cap"), more is the
 * plural with the count ("Bottle caps ×2"). A name whose last word is not its
 * noun ("Form 7-B", "Stamp of Clarity") keeps its words: "Form 7-B ×2".
 */
export function withCount(name: string, n: number): string {
  const single = singleOf(name);
  if (n <= 1) return single;
  const m = single.match(/^(.*?)([A-Za-z'’-]+)$/);
  const plural = m && itemHead(single) === m[2]!.toLowerCase() ? m[1]! + pluralWord(m[2]!) : single;
  return `${plural} ×${n}`;
}

/**
 * `item` added to an inventory that already holds `held` (the same thing, by
 * sameItem): counts add up ("Bottle cap" + "Bottle cap" → "Bottle caps ×2");
 * an uncounted stack stays the stack ("Bottle caps" + one is "Bottle caps").
 */
export function mergeCount(held: string, item: string): string {
  const a = itemCount(held);
  const b = itemCount(item);
  if (a === null) return held;
  if (b === null) return withoutCount(item);
  return withCount(withoutCount(held), a + b);
}

/**
 * One taken from `held`: what is left, or null when nothing is. A counted
 * name counts down ("Bottle caps ×2" → "Bottle cap"); an uncounted stack
 * stays; a single is gone.
 */
export function lessOne(held: string): string | null {
  const n = itemCount(held);
  if (n === null) return held;
  return n > 1 ? withCount(withoutCount(held), n - 1) : null;
}

/** The item's name with its last word in the singular: "Bottle caps" → "Bottle cap" (one from the stack). */
export function singleOf(name: string): string {
  const bare = withoutCount(name);
  const m = bare.match(/^(.*?)([A-Za-z'’-]+)$/);
  return m ? m[1]! + singularWord(m[2]!) : bare;
}

/** A stack of things under one name — its head noun is a plural ("Bottle caps", "Marbles"). */
export function isStack(name: string): boolean {
  const last = withoutCount(name).split(/[:(]/)[0]!.trim().split(/\s+/).pop() ?? '';
  return /^[A-Za-z'’-]+$/.test(last) && singularWord(last).toLowerCase() !== last.toLowerCase();
}

/** The noun an item's name is, in the singular: "Orange Key" → key, "The Letter of Truth" → letter, "Form 9-B: Return to Source (Crumpled)" → form, "Bottle caps" → cap. */
export function itemHead(name: string): string | null {
  const core = withoutCount(name).split(/[:(]/)[0]!.replace(/\s+of\s+.*$/i, '');
  // Whole words only: "9-B" is a label, not a noun.
  const words = core.toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z'’-]+$/, '')).filter(w => /^[a-z][a-z'’-]*$/.test(w) && !['the', 'a', 'an'].includes(w));
  return words.length > 0 ? singularWord(words[words.length - 1]!) : null;
}

/** Words that name this item in prose: its head noun and that noun's kin. */
function itemNouns(name: string): string[] {
  const head = itemHead(name);
  return head ? [head, ...(ITEM_KIN[head] ?? [])] : [];
}

/**
 * Words that only describe a thing, never pick one out: "the Shiny Pen" is
 * the pen. Colours, materials and names ("Orange Key", "Brass Key",
 * "Fading Form", "Recall Form") are not here — those tell things apart.
 */
const DESCRIPTIVE = new Set(['shiny', 'glinting', 'gleaming', 'glittering', 'glowing', 'sparkly', 'sparkling', 'cool', 'cold', 'warm', 'metal', 'metallic', 'small', 'little', 'tiny', 'big', 'large', 'heavy', 'old', 'worn', 'battered', 'dented', 'trusty', 'crumpled', 'damp', 'wet', 'sticky', 'dusty', 'dirty', 'clean', 'plain', 'simple', 'ordinary', 'cheap', 'new', 'favorite', 'favourite', 'beloved', 'sturdy', 'flimsy', 'smooth', 'squashed', 'crushed', 'bent', 'loose', 'spare', 'stray', 'lone', 'single']);

/**
 * An item's name normalized: lower case, no leading article, single spaces,
 * its last word in the singular. "The Pen" and "pen", "Bottle caps" and
 * "Bottle Cap" (never a stack and a single side by side, live WXKC2C) are one key.
 */
export function itemKey(name: string): string {
  return singleOf(withoutCount(name).toLowerCase().replace(/^(?:the|a|an)\s+/, '').replace(/\s+/g, ' '));
}

/** The words that pick a thing out, singular and lower-case, without articles, describing words or "of": "The Green Bottle Caps" → green, bottle, cap. */
function itemWords(name: string): string[] {
  return withoutCount(name).toLowerCase().replace(/[:(),]/g, ' ').split(/\s+/)
    .map(w => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter(w => w && !['the', 'a', 'an', 'of'].includes(w) && !DESCRIPTIVE.has(w))
    .map(w => stemWord(singularWord(w)));
}

/**
 * A word's stem, for telling whether two names could be one thing: "voided"
 * and "void" (live NUMMRL: "Voided Ticket" and "Void Ticket" filed apart),
 * "smudged" and "smudge", "vibrating" and "vibrate". Labels and short words
 * are left alone.
 */
export function stemWord(w: string): string {
  if (!/^[a-z'’-]+$/.test(w)) return w;
  let s = w;
  if (/ing$/.test(s) && s.length - 3 >= 4) s = s.slice(0, -3);
  else if (/ed$/.test(s) && s.length - 2 >= 3) s = s.slice(0, -2);
  if (/([^aeiou])\1$/.test(s) && s.length > 3) s = s.slice(0, -1);
  if (/e$/.test(s) && s.length >= 4) s = s.slice(0, -1);
  return s;
}

/** A possessive word ("Badger's", "Quill’s"): whose the thing is, not what it is. */
const POSSESSIVE_WORD = /^[a-z][\w-]*['’]s?$/i;

/**
 * The words of a name that only say how a thing looks or whose it is: describing
 * words, -ing/-ed words ("Vibrating", "Smudged") and possessives ("Badger's").
 * Colours, materials, labels and numbers are not soft — they tell things apart.
 */
function isSoftWord(raw: string): boolean {
  const w = raw.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9'’]+$/g, '');
  if (!w) return true;
  if (POSSESSIVE_WORD.test(w) && /['’]/.test(w)) return true;
  if (DESCRIPTIVE.has(w)) return true;
  return /^[a-z-]+(?:ing|ed)$/.test(w) && w.replace(/-/g, '').length >= 5;
}

/** The possessor a name opens with, lower-case: "Badger’s Spectacles" → badger, "Madame Quill's Ledger" → madame quill. */
export function itemPossessor(name: string): string | null {
  const m = withoutCount(name).trim().replace(/^(?:the|a|an)\s+/i, '').match(/^((?:[\w-]+\s+){0,2}[\w-]+)['’]s?\s+\S/);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Two names for one thing that differ only in soft words: the same head noun,
 * and every word one has that the other lacks is a describing word, an -ing/-ed
 * word or a possessive — "Badger’s Spectacles" / "Vibrating Spectacles",
 * "Voided Ticket" / "Void Ticket". Two different possessors ("Quill's Ledger",
 * "Barnaby's Ledger") are two things. Whether they ARE one thing is up to the
 * caller: the same place, or the same NPC's.
 */
export function softVariants(a: string, b: string): boolean {
  const head = itemHead(a);
  if (!head || head !== itemHead(b)) return false;
  const pa = itemPossessor(a);
  const pb = itemPossessor(b);
  if (pa && pb && pa !== pb) return false;
  const words = (n: string) => withoutCount(n).split(/[:(]/)[0]!.replace(/\s+of\s+.*$/i, '').split(/\s+/).filter(w => w && !/^(?:the|a|an)$/i.test(w));
  const stems = (n: string) => words(n).map(w => ({ raw: w, stem: stemWord(singularWord(w.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/['’]s?$/, ''))) }));
  const wa = stems(a);
  const wb = stems(b);
  const extra = [...wa.filter(x => !wb.some(y => y.stem === x.stem)), ...wb.filter(y => !wa.some(x => x.stem === y.stem))];
  return extra.every(x => isSoftWord(x.raw));
}

/**
 * Could two names be one thing: the same head noun, and one name's words all
 * in the other's. "The Stamp" / "Stamp of Clarity" / "Square Stamp", "Bottle
 * cap" / "Green Bottle Cap" — yes; "Orange Key" / "Brass Key", "Form 12-B" /
 * "Form 88-B" — each has a word the other lacks, so no (live RZBU7G: one
 * stamp under four names).
 */
export function namesOneThing(a: string, b: string): boolean {
  const head = itemHead(a);
  if (!head || head !== itemHead(b)) return false;
  const wa = itemWords(a);
  const wb = itemWords(b);
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return short.every(w => long.includes(w));
}

/**
 * Do two names mean the same item: the same words once lower-cased and
 * without a leading article, or one is the other with describing words in
 * front. Live (7MJXE5): Biz pressed the Pen into Liz's palm, then "the Shiny
 * Pen in Liz’s hand" (a world item the extractor had named "Shiny Pen") gave
 * her a second pen.
 */
export function sameItem(a: string, b: string): boolean {
  const na = itemKey(a);
  const nb = itemKey(b);
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (!short || !long.endsWith(` ${short}`)) return false;
  const extra = long.slice(0, long.length - short.length - 1).split(/[\s,]+/).filter(Boolean);
  return extra.length > 0 && extra.every(w => DESCRIPTIVE.has(w));
}

const unquotedSentences = (text: string) => quoteRuns(text).filter(r => !r.quoted).map(r => r.text).join(' ').split(SENTENCES);

/**
 * Does a ruling's narration show `actor` actually coming to hold `item` —
 * taking, picking up, being handed, having it pressed into their palm,
 * finding it — in a sentence that names the item (by any word of its name,
 * or its head noun's kin: "envelope" for a letter) and is not a refusal? A
 * claim in speech ("It is my property") is not: live, Liz's claim put Lady
 * Vex's Brass Ruler in Liz's inventory while Vex went on tapping it. A
 * negation counts only on the transfer itself: live, "The Linen-Suited Man
 * does not recoil; instead, he … [is] pressing the brass key into her palm"
 * was read as a refusal and the key was dropped.
 */
export function narratesItemTransfer(narration: string, item: string, actor: string, opts: { acting?: boolean; released?: string[] } = {}): boolean {
  if (!narration || !item) return false;
  const itemWords = [...new Set([...(item.toLowerCase().match(/[a-z]+/g)?.filter(w => w.length >= 3 && !['the', 'and', 'of'].includes(w)) ?? []), ...itemNouns(item)])];
  if (itemWords.length === 0) return false;
  const first = firstName(actor);
  const name = esc(first);
  // The thing someone just let go of, landing in the actor's hand unnamed:
  // "a soft arc of black plastic … landing perfectly in Biz’s waiting palm" (live WXKC2C).
  const wasReleased = (opts.released ?? []).some(r => sameItem(r, item));
  for (const sentence of unquotedSentences(narration)) {
    if (wasReleased && receivesUnnamed(sentence, first) && !REFUSAL.test(sentence) && !NEGATED_TRANSFER.test(sentence)) return true;
    const lower = sentence.toLowerCase();
    if (!itemWords.some(w => new RegExp(`\\b${w}s?\\b`).test(lower))) continue;
    if (REFUSAL.test(sentence) || NEGATED_TRANSFER.test(sentence)) continue;
    if (opts.acting && givenToNobodyElse(sentence, itemNouns(item), first)) return true;
    const actorHere = new RegExp(`\\b${name}\\b`, 'i').test(sentence) || /^\s*(?:she|he|they)\b/i.test(sentence);
    if (GIVE_TO(name).test(sentence)) return true;
    const handoff = sentence.match(HANDOFF);
    if (handoff) {
      const receiver = handoff[2]!.replace(/['’]s$/, '');
      // "into Liz's palm" is Liz's; "into Odo's palm" is not.
      if (/^[A-Z]/.test(receiver) && !/^(?:Her|Their|His)$/.test(receiver)) {
        if (receiver.toLowerCase() === first.toLowerCase()) return true;
        // Into someone else's hand: this sentence gives the item to them.
        continue;
      } else if (actorHere && !new RegExp(`\\b${name}\\s+(?:\\w+ly\\s+)?${esc(handoff[1]!)}\\b`, 'i').test(sentence)) {
        // "her palm" in a sentence about the actor, who is not the one doing the pressing.
        return true;
      }
    }
    if (actorHere && ACQUIRE.test(sentence)) return true;
  }
  return false;
}

/**
 * narratesItemTransfer over the current ruling OR the DM's last few beats
 * (narration and rulings). Live (N7RQZ7): the Postman "slips the glowing
 * envelope into Biz's sticky, ink-stained hand" in Liz's ruling; Biz's own
 * ruling a turn later added "The Letter of Truth" to Biz, and it was dropped
 * because that ruling never showed it changing hands — it already had.
 */
export function narratesItemTransferRecently(current: string, recent: string[], item: string, actor: string, opts: { acting?: boolean; released?: string[] } = {}): boolean {
  return narratesItemTransfer(current, item, actor, opts) || recent.some(t => narratesItemTransfer(t, item, actor));
}

/** Where a thing comes to rest when someone receives it: a palm, a hand, a grip. */
const RECEIVING = String.raw`(?:palm|palms|hand|hands|grip|fingers|fist|arms|lap)`;

/**
 * A sentence showing `member` receiving something it does not name: "landing
 * perfectly in Biz’s waiting palm", "guides it firmly into Liz’s waiting
 * palm", "Biz catches it", "Liz’s fingers close around it". Which thing is
 * for the caller to say (the one just let go of).
 */
function receivesUnnamed(sentence: string, member: string): boolean {
  const M = esc(firstName(member));
  const into = String.raw`(?:into|in|onto)\s+${M}['’]s\s+${ADJS}${RECEIVING}\b`;
  return [
    new RegExp(String.raw`\b(?:land(?:s|ed|ing)?|drop(?:s|ped|ping)?|fall(?:s|ing)?|fell|settl(?:e|es|ed|ing)|com(?:e|es|ing)\s+to\s+rest|arriv(?:e|es|ed|ing))\s+(?:\w+ly\s+)?(?:right\s+|squarely\s+|safely\s+|neatly\s+)?${into}`, 'i'),
    new RegExp(String.raw`\b(?:${HANDOFF_VERB}|${GIVE_VERB}|tosses|tossed|lobs|lobbed|throws|threw)\s+it\b[^.!?;]{0,40}?\b${into}`, 'i'),
    new RegExp(String.raw`\b${M}\s+(?:\w+ly\s+)?(?:catches|caught|snatches|snatched|grabs|grabbed|takes|took|receives|received)\s+it\b`, 'i'),
    new RegExp(String.raw`\b${M}['’]s\s+(?:[\w-]+\s+){0,2}?${HAND_CLOSE}\s+it\b`, 'i'),
  ].some(re => re.test(sentence));
}

/** Verbs by which a player's action lets go of something toward someone. */
const RELEASE_VERB = String.raw`(?:toss(?:es)?|throws?|lobs?|flicks?|hands?|pass(?:es)?|gives?|slides?|slips?|press(?:es)?|places?|puts?|guides?|offers?|drops?|tucks?)`;

/**
 * The things a player's declared action lets go of toward someone: "Reach
 * into my tote bag, pull out the pen, and toss it gently toward Biz" (live
 * WXKC2C) → the pen; "Slip a bottle cap into Mom's palm" → one bottle cap
 * from the stack. The object is a held thing named right after the verb, or
 * "it" — the held thing named last before it. Stowing into one's own bag or
 * pocket is not letting go.
 */
export function releasedInAction(action: string, held: string[]): string[] {
  if (!action || held.length === 0) return [];
  const out: string[] = [];
  const named = (t: string) => held
    .map(h => ({ h, at: Math.max(-1, ...itemNouns(h).map(n => { const ms = [...t.matchAll(new RegExp(`\\b${nounAlt([n])}\\b`, 'gi'))]; return ms.length ? ms[ms.length - 1]!.index! : -1; })) }))
    .filter(x => x.at >= 0);
  for (const m of action.matchAll(new RegExp(`\\b${RELEASE_VERB}\\b`, 'gi'))) {
    const after = action.slice(m.index! + m[0].length);
    const clause = after.split(/[.;!?]|,\s*(?:and\s+)?|\s+and\s+|\bthen\b/i)[0] ?? '';
    if (/\b(?:into|in|inside|to|onto)\s+(?:my|our)\b/i.test(clause)) continue;
    let item: string | undefined;
    if (/^\s+it\b/i.test(after)) {
      const before = named(action.slice(0, m.index));
      item = before.sort((a, b) => b.at - a.at)[0]?.h;
    } else {
      const direct = held.filter(h => { const ns = itemNouns(h); return ns.length > 0 && new RegExp(`^\\s+(?:\\w+\\s+)?(?:back\\s+|over\\s+)?${DET}${ADJS}${nounAlt(ns)}\\b`, 'i').test(clause) || new RegExp(`^\\s+(?:[A-Z][\\w'’-]*|her|him|them)\\s+${DET}${ADJS}${nounAlt(ns)}\\b`).test(clause); });
      item = direct[0];
    }
    if (!item) continue;
    const one = isStack(item) && oneFromStack(action, item) ? singleOf(item) : item;
    if (!out.some(o => sameItem(o, one))) out.push(one);
  }
  return out;
}

/**
 * The text speaks of ONE of a stack: "a bottle cap", "one bottle cap", "one
 * of my bottle caps" — not "the bottle caps" or "all my bottle caps".
 */
export function oneFromStack(text: string, stack: string): boolean {
  const head = itemHead(stack);
  if (!text || !head) return false;
  const single = new RegExp(`\\b(?:a|an|one|another|single)\\s+${ADJS}${esc(head)}\\b(?![s'’-])`, 'i');
  const oneOf = new RegExp(`\\bone\\s+of\\s+(?:the|her|his|their|my|your|our|[A-Z][\\w'’-]*['’]s)\\s+${ADJS}${nounAlt([head])}\\b`, 'i');
  return single.test(text) || oneOf.test(text);
}

/** Verbs that pass a thing across to whoever is there: "sliding a blank form across the polished wood". */
const PASS_ACROSS = String.raw`(?:slid(?:e|es|ing)|push(?:es|ed|ing)|hand(?:s|ed|ing)|pass(?:es|ed|ing)|giv(?:e|es|ing)|gave|toss(?:es|ed|ing))`;

/**
 * Someone else passes the item across, aimed at nobody else — in the ruling
 * of the character it was passed to (opts.acting). Live (Z9JKG2): Liz asked
 * Clerk Marni for the form home, and "Marni chirps, sliding a blank form
 * across the polished wood"; the ruling's add of "The Provisional Exit Form"
 * was dropped because the sentence never named Liz. Not when the actor is
 * the one passing it, and not when it goes to someone named.
 */
function givenToNobodyElse(sentence: string, nouns: string[], actorFirst: string): boolean {
  if (nouns.length === 0) return false;
  const N = `${nounAlt(nouns)}`;
  const m = sentence.match(new RegExp(`\\b${PASS_ACROSS}\\s+(?:over\\s+)?${DET}${ADJS}${N}\\b([^.!?;]{0,60})`, 'i'));
  if (!m) return false;
  if (new RegExp(`\\b${esc(actorFirst)}\\s+(?:\\w+ly\\s+)?${PASS_ACROSS}\\b`, 'i').test(sentence)) return false;
  const to = m[1]!.match(/\b(?:to|toward|towards|into|at)\s+(?:the\s+)?([A-Z][\w'’-]*)/);
  if (to && !['Her', 'Him', 'Them', 'Their', 'His'].includes(to[1]!) && to[1]!.replace(/['’]s$/, '').toLowerCase() !== actorFirst.toLowerCase()) return false;
  return true;
}

export interface ItemHolder {
  name: string;
  inventory: string[];
}

export type ItemEvent =
  | { kind: 'gain'; to: string; item: string; from: string | null }
  | { kind: 'loss'; from: string; item: string };

/** Subject verbs by which a named character takes something into their own keeping. */
const SELF_TAKE = String.raw`(?:pocket|pockets|pocketed|pick(?:s|ed)?\s+up|scoop(?:s|ed)?\s+up|grab(?:s|bed)?|take|takes|took|snatch(?:es|ed)?|catch(?:es)?|caught|accept(?:s|ed)?|receiv(?:e|es|ed))`;
/** Subject verbs that need a destination of the character's own ("into their pocket"). */
const SELF_STOW = String.raw`(?:tuck(?:s|ed)?|slip(?:s|ped)?|stuff(?:s|ed)?|put(?:s)?|plac(?:e|es|ed)|shov(?:e|es|ed)|hid(?:e|es)|hid)`;
const OWN_PLACE = String.raw`(?:pocket|pockets|bag|satchel|pouch|apron|coat|jacket|backpack|pack|purse|sleeve|belt|hand|hands|palm|fist)`;
const DET = String.raw`(?:(?:the|a|an|this|that|its|her|his|their)\s+)?`;
const HAND_CLOSE = String.raw`(?:hand|hands|fingers|fist|palm|grip)\s+(?:close|closes|closed|lock|locks|locked|curl|curls|curled|tighten|tightens|tightened|wrap|wraps|wrapped)\s+(?:tight(?:ly)?\s+)?(?:around|over|on)`;
const GIVE_VERB = String.raw`(?:hands?|handed|gives?|gave|pass(?:es|ed)?|toss(?:es|ed)?|offers?|offered)`;
const HANDOFF_VERB = String.raw`(?:press(?:es|ed)?|plac(?:e|es|ed)|guid(?:e|es|ed)|slip(?:s|ped)?|put(?:s)?|tuck(?:s|ed)?|drop(?:s|ped)?|push(?:es|ed)?|shov(?:e|es|ed))`;

/** A sentence that shows `member` coming to hold something named by `nouns` (see narratedItemEvents). */
function showsGain(sentence: string, member: string, nouns: string[]): boolean {
  const M = esc(firstName(member));
  const N = `${nounAlt(nouns)}`;
  const obj = `${DET}${ADJS}${N}\\b`;
  const res = [
    // "Biz tucks the key into their treasure pocket", "As Biz pockets the Orange Key"
    new RegExp(`\\b${M}\\s+(?:\\w+ly\\s+)?${SELF_TAKE}\\s+${obj}`, 'i'),
    new RegExp(`\\b${M}\\s+(?:\\w+ly\\s+)?${SELF_STOW}\\s+${obj}[^.!?;]{0,30}?\\b(?:into|in|inside|under)\\s+(?:(?:her|his|their|${M}['’]s)\\s+)(?:own\\s+)?${ADJS}${OWN_PLACE}\\b`, 'i'),
    // "slips the glowing envelope into Biz's sticky, ink-stained hand"
    new RegExp(`\\b${HANDOFF_VERB}\\s+${obj}[^.!?;]{0,40}?\\b(?:into|in|onto)\\s+${M}['’]s\\s+${ADJS}${KEEPING}\\b`, 'i'),
    // "Liz's hand closes around the crumpled envelope"
    new RegExp(`\\b${M}['’]s\\s+(?:[\\w-]+\\s+){0,2}?${HAND_CLOSE}\\s+${obj}`, 'i'),
    // "hands the key to Liz", "hands Liz the key"
    new RegExp(`\\b${GIVE_VERB}\\s+${obj}\\s+(?:back\\s+|over\\s+)?to\\s+${M}\\b`, 'i'),
    new RegExp(`\\b${GIVE_VERB}\\s+${M}\\s+${obj}`, 'i'),
    // Possession the prose states outright. Live (Z9JKG2): "the Fading Form
    // in Liz’s hand", "the Fading Form in Liz’s grip" after Liz scooped it
    // up; "Biz clutches the pen" after catching it.
    new RegExp(`\\b(?:the|a|an)\\s+${ADJS}${N}\\s+${HELD_HOW}(?:in|inside|within|up)\\s+${M}['’]s\\s+(?:[\\w-]+\\s+){0,2}?${HELD_IN}\\b`, 'i'),
    new RegExp(`\\b${M}\\s+(?:\\w+ly\\s+)?${HOLDS}\\s+${obj}`, 'i'),
    new RegExp(`\\b${M}['’]s\\s+(?:[\\w-]+\\s+)?(?:grip|hold|grasp)\\s+(?:on|around)\\s+${obj}`, 'i'),
  ];
  return res.some(re => re.test(sentence));
}

/** Verbs of holding something already in hand. */
const HOLDS = String.raw`(?:clutch(?:es)?|clutching|holds|holding|is\s+holding|grips|gripping|clasps|clasping|cradles|cradling)`;
/** Where a held thing is: a hand, a grip, a bag. */
const HELD_IN = String.raw`(?:hand|hands|grip|grasp|fist|fingers|palm|palms|arms|pocket|pockets|sleeve|sleeves|bag|tote|satchel|pouch|backpack)`;
/** Between a thing and where it is held: "the golden paperclip glinting in Biz’s pocket", "the key hidden in her sleeve". */
const HELD_HOW = String.raw`(?:[a-z]+ing\s+|(?:hidden|tucked|stashed|safe|safely|kept|held|stowed)\s+)?`;

/** Capitalised words that start a clause but never name who took something. */
const NOT_A_NAME = new Set(['She', 'He', 'They', 'It', 'The', 'A', 'An', 'But', 'And', 'As', 'When', 'Then', 'With', 'Her', 'His', 'Their', 'Its', 'This', 'That', 'There', 'Here', 'Now', 'Still', 'Just', 'Even', 'Someone', 'Something', 'Nobody', 'No', 'One', 'You', 'I', 'We']);
/** Verbs by which someone takes a thing into their own keeping (lower case: the taker's name is matched case-sensitively). */
const NPC_TAKE = String.raw`(?:catches|caught|takes|took|accepts|accepted|pockets|pocketed|snatches|snatched|grabs|grabbed|receives|received|picks\s+up|picked\s+up|scoops\s+up|scooped\s+up|tucks|tucked|stows|stowed)`;
const caseFree = (w: string) => w.replace(/[a-z]/i, c => `[${c.toLowerCase()}${c.toUpperCase()}]`);

/**
 * Someone outside the party takes the item a member holds: "Liz hurls the
 * granola bar across the gap… Marni catches the snack" (live, Z9JKG2),
 * "Odo takes the bottle cap from Biz". The taker is a capitalised name that
 * is not a party member; the holder must be named, with the item, in this
 * sentence or the one before; "catches it" needs that item to be the one
 * thing named before it.
 */
function showsTakenByOther(sentence: string, prev: string, holder: string, nouns: string[], party: string[], mentions: (text: string) => string[], item: string): boolean {
  const N = `(?:${nouns.map(n => caseFree(esc(n))).join('|')})s?`;
  const re = new RegExp(`\\b([A-Z][\\w'’-]*)\\s+(?:[a-z]+ly\\s+)?${NPC_TAKE}\\s+(it\\b|(?:[Tt]he|[Aa]n?|[Hh]er|[Hh]is|[Tt]heir|[Ii]ts)\\s+${ADJS}${N}\\b)`, 'g');
  const holderRe = new RegExp(`\\b${esc(firstName(holder))}\\b`);
  const nounRe = new RegExp(`\\b${nounAlt(nouns)}\\b`, 'i');
  for (const m of sentence.matchAll(re)) {
    const taker = m[1]!.replace(/['’]s$/, '');
    if (NOT_A_NAME.has(taker) || party.some(p => firstName(p).toLowerCase() === taker.toLowerCase())) continue;
    const before = sentence.slice(0, m.index);
    const holderWithItem = (t: string) => holderRe.test(t) && (nounRe.test(t) || m[2] !== 'it');
    if (!holderWithItem(sentence) && !(holderRe.test(prev) && nounRe.test(prev))) continue;
    if (m[2] === 'it') {
      const named = mentions(before).length > 0 ? mentions(before) : mentions(prev);
      if (named.length !== 1 || !sameItem(named[0]!, item)) continue;
    }
    return true;
  }
  return false;
}

/** A mouth closing on something: "beak snaps shut on", "jaws clamp around". */
const EATING_MOUTH = String.raw`(?:beak|bill|jaws|jaw|mouth|teeth|maw|fangs)\s+(?:snaps?|snapped|clamps?|clamped|closes?|closed|shuts?|crunch(?:es)?|crunched|chomps?|chomped)\s+(?:shut\s+|down\s+)?(?:on|around|over|onto)`;

/**
 * Words that say a thing is gone for good: destroyed, eaten, swallowed,
 * torn to uselessness, stolen, confiscated, lost. Completed forms only —
 * "or the door will eat the key" is a threat, not a loss.
 */
const LOSS = new RegExp([
  String.raw`\b(?:has|have|had|is|was|are|were|gets|got)\s+(?:just\s+|already\s+|now\s+|been\s+|completely\s+|utterly\s+)*(?:swallowed|eaten|devoured|gobbled(?:\s+up)?|destroyed|shredded|burned\s+up|burnt\s+up|stolen|confiscated|lost|ruined|torn\s+(?:apart|to\s+(?:shreds|pieces|bits)|in\s+(?:two|half)))`,
  String.raw`\b(?:swallows|swallowed|devours|devoured|gobbles(?:\s+up)?|gobbled(?:\s+up)?|eats|ate|chomps|chomped|munches|munched|crunches|crunched|wolfs(?:\s+down)?|wolfed(?:\s+down)?|gulps(?:\s+down)?|gulped(?:\s+down)?|shreds|shredded|destroys|destroyed|steals|stole|confiscates|confiscated)\s+(?:up\s+|down\s+)?(?:on\s+)?(?:the|her|his|their|[A-Z][\w-]*['’]s)\b`,
  // "Barnaby's beak snaps shut on the granola bar"
  String.raw`\b${EATING_MOUTH}\s+(?:the|her|his|their|[A-Z][\w-]*['’]s)\b`,
  String.raw`\b(?:tear|tears|tearing|tore|torn|rip|rips|ripping|ripped)\s+(?:it\s+|itself\s+)?(?:completely|apart|clean\s+through|to\s+(?:shreds|pieces|bits)|in\s+(?:two|half))`,
  String.raw`\buseless\s+(?:smear|pulp|scrap|mess|lump|shreds)`,
  String.raw`\b(?:crumbles?|crumbled|crumbling)\s+(?:in)?to\s+(?:dust|ash|ashes)`,
].join('|'), 'i');
/**
 * Words that say someone ate "it" — the thing named just before. Live
 * (7MJXE5): "Liz snatches the granola bar … and hurls it …, just before
 * Barnaby’s beak snaps shut on it with a satisfying *crunch*".
 */
const EAT_IT = new RegExp([
  String.raw`\b(?:swallows|swallowed|devours|devoured|gobbles|gobbled|eats|ate|chomps|chomped|munches|munched|crunches|crunched|wolfs|wolfed|gulps|gulped)\s+(?:(?:down|up)\s+)?(?:on\s+)?it\b`,
  String.raw`\b${EATING_MOUTH}\s+it\b`,
].join('|'), 'gi');
/** Before a loss word: it has not happened (yet). */
const UNREAL_BEFORE = /\b(?:not|never|almost|nearly|if|unless|would|could|might|may|will|shall|['’]ll|about\s+to|threatens?\s+to|tries\s+to|trying\s+to|wants?\s+to|before|or)\b[^.!?]{0,30}$/i;

/**
 * A sentence saying the item named by `nouns` is gone: a loss word with the
 * item's noun close by — just before it ("The paper …, tearing completely")
 * or just after ("has swallowed the key") — so "…swallowed the key, … a
 * fear that tastes of old paper" loses the key, not a paper form.
 */
function showsLoss(sentence: string, nouns: string[]): boolean {
  const N = new RegExp(`\\b${nounAlt(nouns)}\\b`, 'gi');
  const at = [...sentence.matchAll(N)].map(m => m.index!);
  if (at.length === 0) return false;
  for (const m of sentence.matchAll(new RegExp(LOSS.source, 'gi'))) {
    if (UNREAL_BEFORE.test(sentence.slice(0, m.index))) continue;
    const start = m.index!;
    const end = start + m[0].length;
    if (at.some(i => (i < start && start - i <= 60) || (i >= start && i - end <= 30))) return true;
  }
  return false;
}

/**
 * Something ate "it", and the one item named before it in the sentence is
 * `item` (see EAT_IT). Two things named before it, or none, and nothing is
 * lost; a threat ("ready to gobble it up") is not a loss.
 */
function showsEatenIt(sentence: string, item: string, mentions: (t: string) => string[]): boolean {
  for (const m of sentence.matchAll(EAT_IT)) {
    const before = sentence.slice(0, m.index);
    // "just before Barnaby’s beak snaps shut on it" happened; "before the goose eats it" has not.
    const told = before.replace(/\b(?:just|right|moments?|seconds?|an\s+instant|a\s+heartbeat)\s+before\b/gi, ' ');
    if (UNREAL_BEFORE.test(told) || /\b(?:ready|poised|about|going|eager|set)\s+to\b[^.!?]{0,20}$/i.test(before)) continue;
    const named = mentions(before);
    if (named.length === 1 && sameItem(named[0]!, item)) return true;
  }
  return false;
}

/** Eating, as a verb phrase: "takes a bite", "bites into", "chews", "swallows", "wolfs it down". Never "a bit". */
const EAT_VERB = new RegExp(String.raw`\b(?:(?:takes?|took|taking)\s+(?:a|another|one|his|her|their|its)\s+(?:[\w-]+\s+)?(?:bite|nibble|mouthful|chomp)|(?:bites?|biting|(?<!\ba\s)bit)(?:\s+(?:into|off|down\s+on))?|eats?|ate|eating|chew(?:s|ed|ing)?|munch(?:es|ed|ing)?|nibbl(?:es?|ed|ing)|swallow(?:s|ed|ing)?|gobbl(?:es?|ed|ing)(?:\s+up)?|devour(?:s|ed|ing)?|gulp(?:s|ed|ing)?(?:\s+down)?|wolf(?:s|ed|ing)?|scarf(?:s|ed|ing)?)\b`, 'gi');

/** Words that name `name` in prose: the whole name and each of its words of three letters or more ("Clerk 4-B": clerk, 4-B). */
function nameTokens(name: string): string[] {
  const words = name.split(/\s+/).map(w => w.replace(/['’]s$/, '')).filter(w => w.length >= 3 && !['the', 'of', 'and'].includes(w.toLowerCase()));
  return [...new Set([name.trim(), ...words])];
}

/**
 * Does this beat's prose show `receiver` eating `item` — the food just moved
 * to them? Live (RZBU7G): "Granola bar": Liz → Clerk 4-B, and the ruling
 * said "He grabs the bar with trembling fingers, takes a bite…" — recorded
 * as a hand-over, so the clerk went on "chewing on the granola bar he has
 * been hoarding" and the record had him holding it.
 * Conservative: the item must be food and named in the beat; the eater is
 * the person named last before the eating verb ("He" after "Clerk 4-B" is
 * the clerk; "Liz takes a bite" is Liz), `others` being everyone else who
 * could be meant; what is eaten is the item, "it", or nothing said ("takes
 * a bite that tastes like static") — never another thing ("bites his lip");
 * a threat or a maybe ("as if he might eat it") is not eating; quoted
 * speech is not narration.
 */
export function eatenByReceiver(prose: string, receiver: string, item: string, others: string[] = []): boolean {
  const head = itemHead(item);
  if (!prose || !head || !(FOOD.test(head) || (FOOD.test(item) && !PORTABLE.includes(head)))) return false;
  const text = quoteRuns(prose).filter(r => !r.quoted).map(r => r.text).join(' ');
  const nouns = itemNouns(item);
  const itemRe = new RegExp(`\\b${nounAlt(nouns)}\\b`, 'i');
  const mine = nameTokens(receiver);
  const theirs = others.filter(o => o.trim() && o.trim().toLowerCase() !== receiver.trim().toLowerCase()).flatMap(nameTokens);
  const shared = new Set(mine.filter(t => theirs.some(o => o.toLowerCase() === t.toLowerCase())).map(t => t.toLowerCase()));
  const tokenRe = (tokens: string[]) => {
    const own = tokens.filter(t => !shared.has(t.toLowerCase()));
    return own.length > 0 ? new RegExp(`(?<![\\w-])(?:${own.map(esc).join('|')})(?![\\w-])`, 'gi') : null;
  };
  const receiverRe = tokenRe(mine);
  const othersRe = tokenRe(theirs);
  if (!receiverRe) return false;
  const lastAt = (re: RegExp | null, t: string) => (re ? [...t.matchAll(re)].map(m => m.index!).pop() ?? -1 : -1);
  for (const m of text.matchAll(EAT_VERB)) {
    const before = text.slice(0, m.index);
    const sentenceBefore = before.split(SENTENCES).pop() ?? '';
    if (UNREAL_BEFORE.test(sentenceBefore) || /\b(?:ready|poised|about|going|eager|set|hoping|wanting|trying)\s+to\b[^.!?]{0,20}$/i.test(sentenceBefore) || /\bas\s+if\b/i.test(sentenceBefore)) continue;
    // The item named by now (or in this sentence).
    const sentenceAfter = text.slice(m.index! + m[0].length).split(SENTENCES)[0] ?? '';
    if (!itemRe.test(before) && !itemRe.test(sentenceAfter)) continue;
    // Who eats: the one named last.
    const r = lastAt(receiverRe, before);
    if (r < 0 || lastAt(othersRe, before) > r) continue;
    // What is eaten.
    const object = sentenceAfter.split(/[,;:—–.!?]|\b(?:that|which|while|as|and|then|before|until|with|so|but)\b/i)[0]!.trim();
    if (itemRe.test(object)) return true;
    if (/^(?:(?:of|into|on|off|down|up|at|from)\s+)?(?:(?:it|them)\s+)?(?:(?:up|down)\s+)?(?:[a-z]+ly\s*)?(?:whole\s*)?$/i.test(object)) return true;
  }
  return false;
}

/** "Biz hands the key to the Postman": the item leaves the party (group 1: who took it). */
function showsGivenAway(sentence: string, holder: string, nouns: string[], party: string[]): boolean {
  const M = esc(firstName(holder));
  const N = `${nounAlt(nouns)}`;
  const re = new RegExp(`\\b${M}\\s+(?:\\w+ly\\s+)?(?:${GIVE_VERB}|${HANDOFF_VERB})\\s+${DET}${ADJS}${N}\\b[^.!?;]{0,30}?\\b(?:to|into|over\\s+to)\\s+(?:the\\s+)?([A-Z][\\w'’-]*)`, 'i');
  const m = sentence.match(re);
  if (!m) return false;
  const who = m[1]!.replace(/['’]s$/, '').toLowerCase();
  return !party.some(p => firstName(p).toLowerCase() === who) && !['her', 'his', 'their', 'him', 'them'].includes(who);
}

/**
 * What DM prose (a ruling, a narration beat) says happened to the party's
 * things, in order: an item coming to a party member (picked up, pocketed,
 * handed or pressed into their hand, their hand closing around it), and an
 * item a party member holds being destroyed, eaten, swallowed, torn to
 * uselessness, stolen, lost or given away to someone outside the party.
 * Deterministic and conservative:
 *  - the item must be named in the sentence by its head noun (or that
 *    noun's kin, see ITEM_KIN), and that noun must pick out ONE candidate;
 *  - a gain needs the member NAMED as the one taking or receiving it —
 *    never "she"; a claim in quoted speech is never a gain;
 *  - a loss reads the whole sentence, quoted words included (live: the
 *    Postman's "'The Alphabet has swallowed the key'"), but only completed
 *    forms, never a threat or a near-miss.
 * `candidates` are items that could be gained (the world's items); items
 * the party holds are always candidates.
 */
export function narratedItemEvents(text: string, party: ItemHolder[], candidates: string[] = [], opts: { released?: Array<{ from: string; item: string }> } = {}): ItemEvent[] {
  if (!text || party.length === 0) return [];
  const events: ItemEvent[] = [];
  const inv = new Map(party.map(p => [p.name, [...p.inventory]]));
  const holderOf = (item: string) => [...inv].find(([, items]) => items.some(i => sameItem(i, item)))?.[0] ?? null;
  const names = party.map(p => p.name);
  const released = (opts.released ?? []).filter(r => r.item);

  let prev = '';
  for (const sentence of text.split(SENTENCES)) {
    const unquoted = quoteRuns(sentence).filter(r => !r.quoted).map(r => r.text).join(' ');
    const held = [...inv].flatMap(([owner, items]) => items.map(item => ({ owner, item })));
    const all = [...held.map(h => h.item), ...candidates.filter(c => !held.some(h => sameItem(h.item, c)))];
    const pool = all.filter((c, i) => all.findIndex(o => sameItem(o, c)) === i);
    const byNoun = (item: string) => pool.filter(o => itemNouns(o).some(n => itemNouns(item).includes(n)));
    // "the Fading Form" when the world also has a Recall Form: its whole name picks it out.
    const namedIn = (t: string, item: string) => { const f = fullItemName(item); return f.includes(' ') && new RegExp(`\\b${esc(f)}\\b`, 'i').test(t); };
    // "Biz’s small hand closes around … the pen" while Biz holds the Pen and
    // Hark has a Red-ink Pen (live WXKC2C): the one a member named here holds.
    const heldByNamed = (item: string) => held.filter(h => sameItem(h.item, item)).some(h => new RegExp(`\\b${esc(firstName(h.owner))}\\b`).test(unquoted));
    const pick = (item: string, t: string) => {
      const same = byNoun(item);
      if (same.length === 1) return true;
      if (namedIn(t, item)) return same.filter(o => namedIn(t, o)).length === 1;
      return !same.some(o => namedIn(t, o)) && heldByNamed(item) && same.filter(heldByNamed).length === 1;
    };
    const unambiguous = (item: string, t: string) => pick(item, t);
    // The items a stretch of prose names (by whole name, or by a noun only one item has).
    const mentions = (t: string) => {
      const found = pool.filter(o => namedIn(t, o) || itemNouns(o).some(n => new RegExp(`\\b${nounAlt([n])}\\b`, 'i').test(t)));
      const narrowed = found.filter(o => found.filter(x => itemNouns(x).some(n => itemNouns(o).includes(n))).length === 1 || pick(o, t));
      return narrowed.length > 0 ? narrowed : found;
    };

    // Gains: named receiver, unquoted narration, no refusal.
    if (!REFUSAL.test(unquoted) && !NEGATED_TRANSFER.test(unquoted)) {
      for (const item of pool) {
        const nouns = itemNouns(item);
        if (nouns.length === 0) continue;
        const clear = unambiguous(item, unquoted);
        for (const member of names) {
          if (inv.get(member)!.some(i => sameItem(i, item))) continue;
          if (!(clear && showsGain(unquoted, member, nouns)) && !caughtIt(unquoted, member, item, mentions)) continue;
          const from = holderOf(item);
          // A companion's thing moves only when the prose names that companion
          // (or it is what they just let go of). Live (7RAAQ7): "Mama Pigeon …
          // offers a granola bar to Biz" moved LIZ's bar — an NPC's thing is
          // never taken from a party member.
          if (from && from !== member && !new RegExp(`\\b${esc(firstName(from))}\\b`, 'i').test(unquoted) && !released.some(r => r.from === from && sameItem(r.item, item))) continue;
          // "slips a bottle cap into Liz's palm" from Biz's Bottle caps: one cap, and the stack stays (live WXKC2C).
          if (from && from !== member && isStack(inv.get(from)!.find(i => sameItem(i, item)) ?? item) && oneFromStack(unquoted, item)) {
            const one = singleOf(item);
            inv.get(member)!.push(one);
            events.push({ kind: 'gain', to: member, item: one, from: null });
            break;
          }
          if (from) inv.set(from, inv.get(from)!.filter(i => !sameItem(i, item)));
          inv.get(member)!.push(item);
          events.push({ kind: 'gain', to: member, item, from });
          break;
        }
      }
      // What someone just let go of, landing in a member's hand unnamed:
      // "a soft arc of black plastic … landing perfectly in Biz’s waiting palm" (live WXKC2C).
      for (const member of names) {
        const coming = released.filter(r => r.from !== member && !inv.get(member)!.some(i => sameItem(i, r.item)));
        if (coming.length !== 1) continue;
        const { item, from: giver } = coming[0]!;
        if (!receivesUnnamed(unquoted, member)) continue;
        if (mentions(unquoted).some(o => !sameItem(o, item))) continue;
        const from = inv.get(giver)?.some(i => sameItem(i, item)) ? giver : null;
        if (from && !(isStack(inv.get(from)!.find(i => sameItem(i, item))!) && !isStack(item))) inv.set(from, inv.get(from)!.filter(i => !sameItem(i, item)));
        inv.get(member)!.push(item);
        events.push({ kind: 'gain', to: member, item, from });
      }
      // A portable thing the prose plainly puts in a member's pocket, sleeve
      // or hand that is no world item yet: "the brass key hidden in Biz’s sleeve".
      for (const member of names) {
        for (const thing of statedPortables(unquoted, member)) {
          const head = itemHead(thing);
          if (!head || pool.some(o => itemHead(o) === head) || [...inv.values()].some(items => items.some(i => itemHead(i) === head))) continue;
          inv.get(member)!.push(thing);
          events.push({ kind: 'gain', to: member, item: thing, from: null });
        }
      }
    }

    // Losses: an item the party holds, gone.
    for (const { owner, item } of [...inv].flatMap(([o, items]) => items.map(i => ({ owner: o, item: i })))) {
      const nouns = itemNouns(item);
      if (nouns.length === 0) continue;
      const heldLike = [...inv].flatMap(([o, items]) => items.filter(i => itemNouns(i).some(n => nouns.includes(n))).map(() => o));
      // Two held keys: only a sentence naming the holder can say whose.
      if (heldLike.length > 1 && !new RegExp(`\\b${esc(firstName(owner))}\\b`).test(sentence)) continue;
      // A stack goes only when the prose says the lot: "the bottle cap" is one of Biz's bottle caps.
      if (isStack(item) && !new RegExp(`\\b${esc(item.trim().split(/\s+/).pop()!)}\\b`, 'i').test(sentence)) continue;
      if (showsLoss(sentence, nouns) || showsEatenIt(unquoted, item, mentions) || showsGivenAway(unquoted, owner, nouns, names) || showsTakenByOther(unquoted, prev, owner, nouns, names, mentions, item)) {
        inv.set(owner, inv.get(owner)!.filter(i => i !== item));
        events.push({ kind: 'loss', from: owner, item });
      }
    }
    prev = unquoted;
  }
  return events;
}

/** Small things a hand, pocket or sleeve holds — for a thing the prose puts there that is no world item yet. */
const PORTABLE = ['key', 'coin', 'cap', 'paperclip', 'clip', 'pen', 'pencil', 'crayon', 'marble', 'button', 'pebble', 'stone', 'rock', 'card', 'ticket', 'token', 'badge', 'ring', 'feather', 'shell', 'whistle', 'note', 'letter', 'envelope', 'receipt', 'stamp', 'sticker', 'candy', 'sweet', 'cookie', 'muffin', 'wrapper', 'ribbon', 'thimble', 'bead', 'pin', 'needle', 'lighter', 'map', 'photo', 'photograph', 'locket', 'compass', 'flashlight', 'knife', 'spoon', 'trinket', 'bauble', 'charm', 'gem', 'jewel', 'crystal', 'acorn', 'figurine', 'toy', 'die', 'keychain', 'screw', 'bolt', 'nail', 'washer', 'battery', 'chalk', 'eraser'];

/** "the golden paperclip glinting in Biz’s pocket" → "Golden paperclip": portable things the sentence states are in `member`'s keeping. */
function statedPortables(sentence: string, member: string): string[] {
  const M = esc(firstName(member));
  const re = new RegExp(`\\b(?:the|a|an)\\s+((?:[a-z][\\w'’-]*,?\\s+){0,2}?)${nounAlt(PORTABLE)}\\s+${HELD_HOW}(?:in|inside|within|up)\\s+${M}['’]s\\s+(?:[\\w-]+\\s+){0,2}?(?:pocket|pockets|sleeve|sleeves|hand|hands|palm|fist|grip|fingers)\\b`, 'gi');
  const out: string[] = [];
  for (const m of sentence.matchAll(re)) {
    const phrase = m[0].replace(/^(?:the|a|an)\s+/i, '').split(/\s+(?:[a-z]+ing|hidden|tucked|stashed|safe|safely|kept|held|stowed|in|inside|within|up)\s+/i)[0]!;
    const words = phrase.replace(/,/g, '').split(/\s+/).filter(w => w && !DESCRIPTIVE.has(w.toLowerCase()));
    if (words.length === 0) continue;
    const name = singleOf(words.join(' ').toLowerCase());
    const cased = name.charAt(0).toUpperCase() + name.slice(1);
    if (!out.some(o => sameItem(o, cased))) out.push(cased);
  }
  return out;
}

/** First-person verbs by which a player declares taking something: "Scoop up the Fading Form". */
const DECLARE_TAKE = String.raw`(?:scoop(?:s)?\s+up|pick(?:s)?\s+up|grab(?:s)?|take|takes|snatch(?:es)?|pocket(?:s)?|catch(?:es)?|collect(?:s)?|retrieve(?:s)?|seize(?:s)?|lift(?:s)?|stash(?:es)?|stow(?:s)?|tuck(?:s)?\s+away)`;

/**
 * The world items a player's declared action takes into their own keeping:
 * "Scoop up the Fading Form and tuck it into my tote bag" (live, Z9JKG2).
 * A claim only — the ruling or later prose has to show the character
 * holding it (confirmsClaim) before the inventory changes. Something taken
 * out of their own bag ("Grab a granola bar from my tote") is not a claim.
 */
export function declaredTakes(action: string, candidates: string[]): string[] {
  if (!action) return [];
  const out: string[] = [];
  for (const clause of action.split(/[.;!?]|,\s*(?:then|and then)\b|\bthen\b/i)) {
    const verb = clause.match(new RegExp(`\\b${DECLARE_TAKE}\\b`, 'i'));
    if (!verb) continue;
    const after = clause.slice(verb.index! + verb[0].length);
    if (/\b(?:from|out\s+of)\s+(?:my|our)\b/i.test(after)) continue;
    const named = candidates.filter(c => {
      const full = fullItemName(c);
      if (full.includes(' ') && new RegExp(`\\b${esc(full)}\\b`, 'i').test(after)) return true;
      const nouns = itemNouns(c);
      return nouns.length > 0 && candidates.filter(o => itemNouns(o).some(n => nouns.includes(n))).length === 1
        && new RegExp(`^\\s+(?:up\\s+)?${DET}${ADJS}${nounAlt(nouns)}\\b`, 'i').test(after);
    });
    for (const c of named) if (!out.some(o => sameItem(o, c))) out.push(c);
  }
  return out;
}

/**
 * Known items a player's action reaches for as their own — "my granola bar",
 * "the granola bar from my tote" — that are not on their line. Live
 * (7MJXE5): the goose ate Liz's granola bar, then "I jam the granola bar
 * from my tote into the Shiny Pen's glint…" was ruled as if she still had
 * it. The action is not refused; the ruling is told it is gone. Something
 * with the same head noun on hand ("my pen" with the Shiny Pen) is not
 * missing. `known` in order of preference for the name reported.
 */
export function usesMissingItems(action: string, held: string[], known: string[]): string[] {
  if (!action) return [];
  const out: string[] = [];
  for (const item of known) {
    const nouns = itemNouns(item);
    if (nouns.length === 0) continue;
    const same = (o: string) => sameItem(o, item) || itemHead(o) === itemHead(item);
    if (held.some(same) || out.some(same)) continue;
    const N = `${nounAlt(nouns)}`;
    const mine = new RegExp(`\\b(?:my|our)\\s+${ADJS}${N}\\b`, 'i');
    const fromMine = new RegExp(`\\b(?:the|a|an|this|that|some)\\s+${ADJS}${N}\\s+(?:from|out\\s+of|in|inside)\\s+(?:my|our)\\b`, 'i');
    if (mine.test(action) || fromMine.test(action)) out.push(item);
  }
  return out;
}

/**
 * Prose confirming a character holds the item they declared taking: a named
 * gain (showsGain: "the Fading Form in Liz’s hand"), or — in their OWN
 * ruling, in a sentence naming no other party member — the same in their own
 * stated pronoun: "The Fading Form in her grip shudders" (live, Z9JKG2).
 * With no pronouns on their sheet, only the name counts.
 */
export function confirmsClaim(prose: string, member: string, item: string, opts: { ownRuling?: boolean; party?: string[]; pronouns?: string | null } = {}): boolean {
  const nouns = itemNouns(item);
  if (!prose || nouns.length === 0) return false;
  const N = `${nounAlt(nouns)}`;
  const others = (opts.party ?? []).filter(p => firstName(p).toLowerCase() !== firstName(member).toLowerCase());
  const said = (opts.pronouns ?? '').toLowerCase().match(/\b(she|he|they)\b/)?.[1];
  const possessive = said === 'she' ? 'her' : said === 'he' ? 'his' : said === 'they' ? 'their' : null;
  for (const sentence of unquotedSentences(prose)) {
    if (!new RegExp(`\\b${N}\\b`, 'i').test(sentence)) continue;
    if (REFUSAL.test(sentence) || NEGATED_TRANSFER.test(sentence) || showsLoss(sentence, nouns)) continue;
    if (showsGain(sentence, member, nouns)) return true;
    if (!opts.ownRuling || !said || !possessive) continue;
    if (others.some(o => new RegExp(`\\b${esc(firstName(o))}\\b`, 'i').test(sentence))) continue;
    if (new RegExp(`\\b(?:the|a|an)\\s+${ADJS}${N}\\s+(?:in|inside|within)\\s+${possessive}\\s+(?:[\\w-]+\\s+){0,2}?${HELD_IN}\\b`, 'i').test(sentence)) return true;
    if (new RegExp(`\\b${said}\\s+(?:\\w+ly\\s+)?(?:${SELF_TAKE}|${HOLDS})\\s+${DET}${ADJS}${N}\\b`, 'i').test(sentence)) return true;
  }
  return false;
}

/** An item's name without article or label: "The Fading Form" → "Fading Form". */
function fullItemName(item: string): string {
  return item.split(/[:(]/)[0]!.trim().replace(/^(?:the|a|an)\s+/i, '');
}

/**
 * "Liz hurls the pen …, and Biz snatches it out of the air" (live, Z9JKG2):
 * the member takes "it", and the one item named before it in the sentence
 * is `item`. Two things named before it, or none, and nobody gains anything.
 */
function caughtIt(sentence: string, member: string, item: string, mentions: (t: string) => string[]): boolean {
  const M = esc(firstName(member));
  // "Biz … catches it", and "guides it firmly into Liz’s waiting palm" (live WXKC2C).
  const m = sentence.match(new RegExp(`\\b${M}\\s+(?:\\w+ly\\s+)?${SELF_TAKE}\\s+it\\b`, 'i'))
    ?? sentence.match(new RegExp(`\\b(?:${HANDOFF_VERB}|${GIVE_VERB})\\s+it\\b[^.!?;]{0,40}?\\b(?:into|in|onto)\\s+${M}['’]s\\s+${ADJS}${KEEPING}\\b`, 'i'));
  if (!m) return false;
  const named = mentions(sentence.slice(0, m.index));
  return named.length === 1 && sameItem(named[0]!, item);
}

// ─── A ruling's item changes, reconciled ───────────────────────────────────

export interface ItemChange { characterId?: string; field?: string; action?: string; value?: unknown }

/**
 * A ruling's inventory changes, made to agree with each other and the prose:
 *  - one from a stack ("Slip a bottle cap into Mom's palm", live WXKC2C —
 *    the ruling moved all of Biz's "Bottle caps") gives the receiver a single
 *    ("Bottle cap") and leaves the giver's stack where it is; a singular
 *    remove never takes a stack;
 *  - an add stands when the prose shows it changing hands (`shown`), when the
 *    same ruling removes it from another member (a move: live, the pen toss
 *    removed the Pen from Liz and its add for Biz was dropped, so it
 *    vanished), or when it is the thing the actor let go of landing, unnamed,
 *    in the receiver's hand ("a soft arc of black plastic … landing perfectly
 *    in Biz’s waiting palm");
 *  - a remove with no add, when the prose shows another member receiving that
 *    thing unnamed or named, becomes a move.
 * `keep` lists stacks a giver keeps (so nothing downstream strips them).
 */
export function reconcileItemChanges<T extends ItemChange>(
  changes: T[],
  holders: Array<{ id: string; name: string; inventory: string[] }>,
  opts: { actorId: string; action: string; narration: string; shown: (item: string, receiverId: string) => boolean },
): { changes: T[]; keep: Array<{ holderId: string; item: string }>; notes: string[] } {
  const notes: string[] = [];
  const keep: Array<{ holderId: string; item: string }> = [];
  const isItem = (c: T): c is T & { characterId: string; value: string } => c.field === 'inventory' && typeof c.value === 'string' && !!c.characterId;
  const byId = (id: string) => holders.find(h => h.id === id);
  const actor = byId(opts.actorId);
  const released = actor ? releasedInAction(opts.action, actor.inventory) : [];
  const text = `${opts.action}\n${opts.narration}`;
  const dropped = new Set<T>();
  const rewritten = new Map<T, T>();
  const removes = changes.filter(c => isItem(c) && c.action === 'remove');
  const adds = changes.filter(c => isItem(c) && c.action === 'add');

  // One from a stack.
  for (const a of adds) {
    if (!isItem(a)) continue;
    for (const giver of holders) {
      if (giver.id === a.characterId) continue;
      const stack = giver.inventory.find(i => sameItem(i, a.value));
      if (!stack || !isStack(stack)) continue;
      if (isStack(a.value) && !oneFromStack(text, stack)) continue;
      const one = isStack(a.value) ? singleOf(stack) : a.value;
      if (one !== a.value) rewritten.set(a, { ...a, value: one });
      for (const r of removes) if (isItem(r) && r.characterId === giver.id && sameItem(r.value, stack)) dropped.add(r);
      keep.push({ holderId: giver.id, item: stack });
      notes.push(`[items] one "${one}" from ${giver.name}'s "${stack}" to ${byId(a.characterId)?.name ?? 'a companion'}; the stack stays`);
    }
  }
  // A singular remove never takes the stack.
  for (const r of removes) {
    if (!isItem(r) || dropped.has(r)) continue;
    const held = byId(r.characterId)?.inventory.find(i => sameItem(i, r.value));
    if (held && isStack(held) && !isStack(r.value)) {
      dropped.add(r);
      notes.push(`[items] kept ${byId(r.characterId)!.name}'s "${held}": the ruling removed one "${r.value}", not the lot`);
    }
  }
  // Adds need the prose, a paired remove, or the released thing landing.
  for (const a of adds) {
    if (!isItem(a)) continue;
    const who = byId(a.characterId);
    if (!who) continue;
    const paired = removes.some(r => isItem(r) && r.characterId !== a.characterId && sameItem(r.value, a.value));
    const landed = released.some(r => sameItem(r, a.value)) && narratesItemTransfer(opts.narration, a.value, who.name, { released });
    if (paired || landed || opts.shown(a.value, a.characterId)) continue;
    dropped.add(a);
    notes.push(`dropped an inventory add of "${a.value}" for ${who.name}: neither this ruling nor the last few DM beats show it changing hands`);
  }
  // A remove the prose shows another member receiving is a move.
  const extra: T[] = [];
  for (const r of removes) {
    if (!isItem(r) || dropped.has(r)) continue;
    if (adds.some(a => isItem(a) && !dropped.has(a) && sameItem(a.value, r.value))) continue;
    const from = byId(r.characterId);
    const to = holders.filter(h => h.id !== r.characterId && narratesItemTransfer(opts.narration, r.value, h.name, { released: [r.value] }));
    if (!from || to.length !== 1) continue;
    extra.push({ ...r, characterId: to[0]!.id, action: 'add' } as T);
    notes.push(`[items] "${r.value}" moves from ${from.name} to ${to[0]!.name}: the ruling removed it and the prose shows ${to[0]!.name} receiving it`);
  }
  return { changes: [...changes.filter(c => !dropped.has(c)).map(c => rewritten.get(c) ?? c), ...extra], keep, notes };
}

/** Names that describe a thing without saying what it is: "Black Plastic Object". */
const GENERIC_THING = new Set(['object', 'thing', 'item', 'instrument', 'implement', 'device', 'gadget', 'contraption', 'trinket', 'bauble', 'shape', 'something', 'artifact', 'artefact', 'possession', 'belonging', 'effect']);

/**
 * Extracted new world items without the party's own things under another
 * name: a held item's adjective variant ("Shiny Pen" for the Pen) and, while
 * the party holds anything, a generic description ("Black Plastic Object" —
 * live WXKC2C, the pen in flight).
 */
export function withoutHeldParaphrases<T extends { name: string }>(items: T[], held: string[]): T[] {
  if (held.length === 0) return items;
  return items.filter(i => {
    const head = itemHead(i.name);
    if (head && GENERIC_THING.has(head)) return false;
    return !held.some(h => sameItem(h, i.name) && fullItemName(h).toLowerCase() !== fullItemName(i.name).toLowerCase());
  });
}

/** Verbs by which an option uses, gives or reaches for a thing. */
const USE_VERB = String.raw`\b(?:use|uses|using|hand|hands|give|gives|offer|offers|pull|pulls|take|takes|grab|grabs|snag|snags|bribe|bribes|eat|eats|share|shares|show|shows|hold|holds|tap|taps|wave|waves|sign|signs|write|writes|toss|tosses|throw|throws|slide|slides|slip|slips|press|presses|place|places|put|puts|break|breaks|unwrap|unwraps|reach\s+for|dig\s+(?:for|out)|jingle|jingles|click|clicks|point|points|swing|swings|with)\b`;
/** The thing right after is the means: "calmed by a …", "fixed with the …", "using my …". */
const MEANS = /\b(?:by|with|using|use|uses)\s+(?:(?:a|an|the|my|our|your|his|her|their|some|that|this|one|[A-Z][\w'’-]*['’]s)\s+)?(?:[\w'’-]+\s+){0,2}$/i;
/** Looking for a lost thing is fine. */
const SEEK = /\b(?:search(?:es)?|look(?:s)?\s+for|hunt(?:s)?\s+for|find|finds|retriev(?:e|es)|recover(?:s)?|pick(?:s)?\s+up|ask\w*\s+(?:\w+\s+){0,3}?(?:about|where|for))\b/i;

/**
 * Options without the party's gone things: live (WXKC2C), after the granola
 * bar went to Barnaby, Liz was offered "I use the granola bar to bribe Unit
 * 7-G…" and Biz chose "take Mom's granola bar". An option using, handing,
 * offering or reaching for a gone thing is dropped; looking for it is not;
 * a held thing with the same noun keeps it. Never empties the list.
 */
export function optionsWithoutGoneItems<T extends { description: string }>(options: T[], gone: string[], held: string[]): T[] {
  const lost = gone.filter(g => !held.some(h => sameItem(h, g) || itemHead(h) === itemHead(g)));
  if (lost.length === 0) return options;
  const kept = options.filter(o => !lost.some(g => {
    const nouns = itemNouns(g);
    if (nouns.length === 0) return false;
    for (const m of o.description.matchAll(new RegExp(`\\b${nounAlt(nouns)}\\b`, 'gi'))) {
      const at = m.index!;
      // "the witness form", "Form 88-B" are other forms than the gone Form 12-B (live RZBU7G).
      if (!namesOneThing(g, optionThingName(o.description, at, m[0], itemHead(g)!))) continue;
      const before = o.description.slice(0, at);
      const clause = before.split(/[.;!?]|,\s*|\band\b|\bthen\b/i).pop() ?? '';
      // "…if the ink can be calmed by a granola bar" (live NUMMRL): the gone
      // thing as the means is using it, even inside a question.
      if (MEANS.test(clause)) return true;
      if (SEEK.test(clause)) continue;
      if (new RegExp(USE_VERB, 'i').test(clause) || /\b(?:my|our|[A-Z][\w'’-]*['’]s)\s+(?:[\w-]+\s+){0,2}$/.test(clause)) return true;
    }
    return false;
  }));
  return kept.length > 0 ? kept : options;
}

/** Words before a noun that are not part of a thing's name. */
const NOT_A_MODIFIER = new Set(['the', 'a', 'an', 'my', 'our', 'your', 'his', 'her', 'their', 'its', 'this', 'that', 'these', 'those', 'some', 'any', 'another', 'each', 'every', 'one', 'no', 'to', 'of', 'for', 'with', 'on', 'in', 'into', 'onto', 'at', 'from', 'under', 'over', 'by', 'and', 'or', 'but', 'if', 'while', 'then', 'i', 'me', 'we', 'us', 'you', 'he', 'she', 'they', 'them', 'him', 'it', 'can', 'could', 'will', 'would', 'should', 'may', 'might', 'is', 'are', 'was', 'be', 'about', 'where', 'what', 'which', 'who', 'how', 'why', 'whether', 'again', 'still', 'just', 'also', 'up', 'down', 'out', 'back', 'off']);

/**
 * The thing an option names at a noun (`at`), with its own words: up to two
 * words before it that are no article, pronoun, verb or preposition ("the
 * witness form" → "witness form") and a label or "of …" after it ("Form
 * 88-B", "Stamp of Clarity"). The noun is given as `head` so "paper" for a
 * form compares as a form.
 */
function optionThingName(text: string, at: number, noun: string, head: string): string {
  const useVerb = new RegExp(`^${USE_VERB}$`, 'i');
  const words = text.slice(0, at).trimEnd().split(/\s+/);
  const mods: string[] = [];
  for (let i = words.length - 1; i >= 0 && mods.length < 2; i--) {
    const w = words[i]!;
    const bare = w.toLowerCase().replace(/[^a-z0-9'’-]/g, '');
    if (!bare || /[.,;:!?"“”]$/.test(w) || /['’]s$/.test(bare) || NOT_A_MODIFIER.has(bare) || useVerb.test(bare) || /(?:ed|ing)$/.test(bare) && !DESCRIPTIVE.has(bare)) break;
    mods.unshift(bare);
  }
  const after = text.slice(at + noun.length).match(/^(?:\s+(\d[\w-]*|[A-Z]{1,3}-?\d[\w-]*)|\s+of\s+((?:[A-Z][\w'’-]*\s*)+))/);
  const label = after ? ` ${after[1] ?? `of ${after[2]!.trim()}`}` : '';
  return `${mods.join(' ')} ${head}${label}`.trim();
}

const MOUTH_VERB = String.raw`\b(?:chew(?:s|ed|ing)?|bit(?:e|es|ing)|bit|suck(?:s|ed|ing)?|swallow(?:s|ed|ing)?|lick(?:s|ed|ing)?|nibbl(?:e|es|ed|ing)|gnaw(?:s|ed|ing)?|munch(?:es|ed|ing)?|eat(?:s|ing)?|ate|gulp(?:s|ed|ing)?|taste(?:s|d)?)\b`;
const FOOD = /\b(?:food|snack|snacks|bar|granola|muffin|bread|toast|apple|apples|banana|cookie|cookies|biscuit|cracker|crackers|candy|sweet|sweets|chocolate|cake|pie|sandwich|fruit|berry|berries|nut|nuts|cheese|soup|stew|meal|lunch|dinner|breakfast|gum|lollipop|pastry|bun|roll|crumb|crumbs|honey|jam|carrot|egg|eggs|rice|noodles|tea|water|juice|milk|drink|cinnamon|popcorn|pretzel|chips|cereal|oats|oatmeal|jerky)\b/i;

/** "… is safe to eat", "… is edible": a question whether a thing can be eaten (the thing is the words before it). */
const EDIBLE_QUESTION = /\s+(?:is|are|was|were|would\s+be|might\s+be|could\s+be)\s+(?:it\s+)?(?:(?:safe|okay|ok|alright|all\s+right|good|fine)\s+to\s+(?:eat|chew|swallow|taste|lick|nibble)|edible|tasty|yummy)\b/gi;

/**
 * Options without a character chewing, biting, sucking or swallowing a thing
 * that is not food. Live (WXKC2C), 10-year-old Biz was offered "I swallow the
 * metal cap…" and chose "Swallow the metallic taste of the chewed bottle
 * cap…". The object is the few words after the verb; only a thing — a party
 * item's noun or a small portable thing — counts, so "swallow my fear" and
 * "bite into the muffin" stand. Never empties the list.
 */
export function optionsWithoutMouthedThings<T extends { description: string }>(options: T[], items: string[]): T[] {
  const things = [...new Set([...items.flatMap(itemNouns), ...PORTABLE])].filter(n => !FOOD.test(n));
  const thingRe = new RegExp(`\\b${nounAlt(things)}\\b`, 'i');
  // What a phrase names is its last word: "the granola bar wrapper" is a wrapper, not food.
  const headIsFood = (phrase: string) => FOOD.test(phrase.trim().split(/\s+/).pop() ?? '');
  const kept = options.filter(o => {
    for (const m of o.description.matchAll(new RegExp(MOUTH_VERB, 'gi'))) {
      const object = o.description.slice(m.index! + m[0].length).split(/[.;!?,]|\b(?:and|then|while|to|before|as)\b/i)[0]!.split(/\s+/).slice(0, 9).join(' ');
      if (headIsFood(object)) continue;
      if (thingRe.test(object)) return false;
    }
    // "ask Mama Pigeon if the granola bar wrapper is safe to eat" (live 7RAAQ7).
    for (const m of o.description.matchAll(EDIBLE_QUESTION)) {
      const subject = (o.description.slice(0, m.index).split(/[.;!?,]|\b(?:if|whether|and|then)\b/i).pop() ?? '').trim();
      if (!subject || headIsFood(subject)) continue;
      if (thingRe.test(subject)) return false;
    }
    return true;
  });
  return kept.length > 0 ? kept : options;
}

// ─── Repetition of a whole beat ─────────────────────────────────────────────

const beatWords = (t: string) => t.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9']+/g) ?? [];

/**
 * How much of `text` repeats `earlier`: the share of its words covered by a
 * three-word run that also appears in `earlier`. Live (E9W9YT), a narration
 * came back a round later with only its first clause reworded — 0.93.
 */
export function beatOverlap(text: string, earlier: string): number {
  const a = beatWords(text);
  const b = beatWords(earlier);
  if (a.length < 3 || b.length < 3) return a.join(' ') === b.join(' ') && a.length > 0 ? 1 : 0;
  const runs = new Set<string>();
  for (let i = 0; i + 3 <= b.length; i++) runs.add(`${b[i]} ${b[i + 1]} ${b[i + 2]}`);
  const covered = new Array<boolean>(a.length).fill(false);
  for (let i = 0; i + 3 <= a.length; i++) {
    if (runs.has(`${a[i]} ${a[i + 1]} ${a[i + 2]}`)) covered[i] = covered[i + 1] = covered[i + 2] = true;
  }
  return covered.filter(Boolean).length / a.length;
}

/** The earlier beat `text` repeats (identical, or at least `threshold` of it overlapping), or null. Short lines ("[Biz takes a moment…]") are never judged. */
export function repeatsRecentBeat(text: string, recent: string[], threshold = 0.9): string | null {
  if (beatWords(text).length < 8) return null;
  return recent.find(r => r && beatOverlap(text, r) >= threshold) ?? null;
}

/**
 * Sentences, with a quotation kept whole: a split inside open quotes is
 * joined back ("'The file is open. The key is sticky,' it says." is one).
 */
export function storyUnits(text: string): string[] {
  const pieces = text.split(SENTENCE_SPLIT);
  const units: string[] = [];
  let open = '';
  const unbalanced = (s: string) => {
    const curly = (s.match(/“/g) ?? []).length !== (s.match(/”/g) ?? []).length;
    const straight = (s.match(/"/g) ?? []).length % 2 === 1;
    // Single quotes double as apostrophes: count only those at a word edge.
    const singles = (s.match(/(?<![\w])'|'(?![\w])|(?<![\w])‘|’(?![\w])/g) ?? []).length % 2 === 1;
    return curly || straight || singles;
  };
  for (const p of pieces) {
    open = open ? `${open} ${p}` : p;
    if (!unbalanced(open)) { units.push(open); open = ''; }
  }
  if (open) units.push(open);
  return units;
}

/** The longest run of consecutive words `a` shares with `b`. */
function longestSharedRun(a: string[], b: string[]): number {
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1]! + 1;
        if (cur[j]! > best) best = cur[j]!;
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * `text` without the sentences the DM already said in `recent` — near word
 * for word (most of the sentence covered by three-word runs from earlier
 * beats), or carrying a long stretch of one (eight words or more in a row).
 * Live (Z9JKG2): the scene-2 opening's "'The file for the Unsent is open,
 * but the key is sticky with yesterday's mail'" and its "mist tastes of wet
 * ink and old glue, curling around… ankles" came back in the very next
 * ruling, and an NPC's line came back from another speaker. The whole-beat
 * check (repeatsRecentBeat) only sees a beat repeated entire. Short
 * sentences are never judged. '' when every sentence repeats — the caller
 * then treats the beat as repeated whole.
 */
const SPEECH_VERB = /\b(?:says?|said|saying|asks?|asked|asking|repl(?:y|ies|ied|ying)|chimes?|chimed|chiming|whispers?|whispered|mutters?|muttered|murmurs?|murmured|calls?|called|calling|cr(?:y|ies|ied)|shouts?|shouted|snaps?|snapped|adds?|added|continues?|continued|hums?|hummed|squeaks?|squeaked|barks?|barked|declares?|declared|announces?|announced|demands?|demanded|insists?|insisted|beeps?|beeped|clicks?|clicked|grumbles?|grumbled|sighs?|sighed|laughs?|laughed|booms?|boomed|trills?|trilled|chirps?|chirped|honks?|honked|squawks?|squawked|stammers?|stammered|warns?|warned|explains?|explained|pleads?|pleaded|exclaims?|exclaimed|intones?|intoned|drones?|droned|recites?|recited|whirs?|whirred|rasps?|rasped|coos?|cooed|wails?|wailed|yelps?|yelped|blurts?|blurted)\b|\bvoice\b/i;

/** A unit that is nothing but a quotation ("'The static is a violation!'"). */
function quoteOnly(unit: string | undefined): boolean {
  if (!unit) return false;
  const runs = quoteRuns(unit.trim());
  return runs.some(r => r.quoted) && runs.every(r => r.quoted || !/[\p{L}\p{N}]/u.test(r.text));
}

/**
 * The words that say who is speaking, beside a quotation: `"The static is a
 * violation!" Officer Tick-Tock chimes, its voice sounding like a wind-up
 * toy. "And the witness…"`. Live (7MJXE5) the repeat guard dropped that
 * middle sentence (its voice description had been used before) and the two
 * quotes ran together with nobody saying them. An unquoted sentence with a
 * speech verb (or "voice") next to a quote-only sentence is attribution.
 */
function isSpeechAttribution(unit: string, prev: string | undefined, next: string | undefined): boolean {
  if (!quoteOnly(prev) && !quoteOnly(next)) return false;
  const runs = quoteRuns(unit);
  // A sentence with dialogue of its own is judged by that dialogue (below).
  if (runs.some(r => r.quoted)) return false;
  const unquoted = runs.map(r => r.text).join(' ');
  return SPEECH_VERB.test(unquoted);
}

export function withoutRepeatedSentences(text: string, recent: string[], opts: { coverage?: number; run?: number } = {}): string {
  if (!text?.trim()) return text;
  const earlier = recent.filter(Boolean).join('\n');
  if (!earlier.trim()) return text;
  const coverage = opts.coverage ?? 0.6;
  const runLen = opts.run ?? 8;
  const earlierWords = beatWords(earlier);
  const paragraphs = text.split(/(\n+)/);
  let dropped = 0;
  const out = paragraphs.map(p => {
    if (/^\n+$/.test(p) || !p.trim()) return p;
    const units = storyUnits(p.trim());
    const kept = units.filter((u, i) => {
      const words = beatWords(u);
      if (words.length < 6) return true;
      // Who is speaking stays with what they say: dropped, the quotes on
      // either side run together unattributed.
      if (isSpeechAttribution(u, units[i - 1], units[i + 1])) return true;
      const isRepeat = (t: string, w: string[]) => beatOverlap(t, earlier) >= coverage || longestSharedRun(w, earlierWords) >= runLen;
      // A new line of dialogue keeps its sentence, attribution and all:
      // only the quote itself being said again drops it.
      const spoken = quoteRuns(u).filter(r => r.quoted).map(r => r.text).join(' ');
      const spokenWords = beatWords(spoken);
      if (spokenWords.length >= 4 && !isRepeat(spoken, spokenWords)) return true;
      const repeated = isRepeat(u, words);
      if (repeated) dropped++;
      return !repeated;
    });
    return kept.join(' ');
  }).join('').replace(/\n{3,}/g, '\n\n').trim();
  if (dropped === 0) return text;
  console.log(`[guard] dropped ${dropped} sentence(s) the DM already said`);
  return out;
}

// ─── A table with a child ───────────────────────────────────────────────────

/**
 * The handful of images that read as horror at a table with a ten-year-old
 * (or a host who asked for gentle peril), softened in place. Seen live: "the
 * clerk's bow tie tighten around their neck like a noose", "a *click* that
 * sounds like a bone cracking", "a terrifying, static-filled warmth", "a
 * gentle pressure that feels like a brand" (E9W9YT), and in N7RQZ7 "a sound
 * like a jaw cracking open… rattles her teeth in her skull", "their bones
 * feel like frozen sticks… tears a sharp pain through their shoulder",
 * "echoing like a gunshot", "the crowd turning with hunting intent",
 * "before the crowd eats us", "a tangle of rope tightening around their
 * ankles". Peril stays; the prompt carries the rest.
 */
const TUG: Record<string, string> = { tighten: 'tug at', tightens: 'tugs at', tightening: 'tugging at', tightened: 'tugged at', coil: 'tug at', coils: 'tugs at', coiling: 'tugging at', coiled: 'tugged at', squeeze: 'tug at', squeezes: 'tugs at', squeezing: 'tugging at', squeezed: 'tugged at' };
const SWEEP: Record<string, string> = { eat: 'sweep', eats: 'sweeps', eating: 'sweeping', ate: 'swept', eaten: 'swept', devour: 'sweep', devours: 'sweeps', devouring: 'sweeping', devoured: 'swept', gobble: 'sweep', gobbles: 'sweeps', gobbling: 'sweeping', gobbled: 'swept', swallow: 'sweep', swallows: 'sweeps', swallowing: 'sweeping', swallowed: 'swept' };
const MISPLACE: Record<string, string> = { forget: 'misplace', forgets: 'misplaces', forgot: 'misplaced', forgotten: 'misplaced', forgetting: 'misplacing', erase: 'misplace', erases: 'misplaces', erased: 'misplaced', erasing: 'misplacing', delete: 'misplace', deletes: 'misplaces', deleted: 'misplaced', deleting: 'misplacing' };
const POSSESSIVE: Record<string, string> = { you: 'your', they: 'their', them: 'their', we: 'our', us: 'our', he: 'his', him: 'his', she: 'her', her: 'her', i: 'my', me: 'my' };
const GRUMBLE: Record<string, string> = { bite: 'grumble', bites: 'grumbles', biting: 'grumbling', bit: 'grumbled' };
const CHILD_SOFTENERS: Array<[RegExp, string | ((...args: string[]) => string)]> = [
  [/\bnooses\b/gi, 'tangles of rope'],
  [/\bnoose\b/gi, 'tangle of rope'],
  [/\b(a|the)\s+bones?\s+(?:cracking|snapping|breaking|splintering)\b/gi, '$1 twig snapping'],
  [/\bbone[- ](?:cracking|snapping|breaking|shattering)\b/gi, 'twig-snapping'],
  [/\blike a brand\b/gi, 'like a warm coin'],
  // "waddles with terrifying determination" → "…with great determination"
  [/\bterrifying (determination|speed|precision|efficiency|focus|intensity|enthusiasm|confidence|purpose)\b/gi, 'great $1'],
  [/\ba terrifying\b/gi, 'an unnerving'],
  [/\bterrifying\b/gi, 'unnerving'],
  [/\bhorrifying\b/gi, 'alarming'],
  // "a heavy stamp slams down, missing their ear by a whisker" → "…, well clear of everyone"
  [/,?\s*(?:narrowly |just |barely |only )?missing (?:(?:their|his|her|its|my|your|our|[\p{Lu}][\p{L}'’-]*['’]s)\s+(?:(?:left|right|tiny|small|little)\s+)?(?:ears?|head|nose|face|cheeks?|hands?|fingers?|feet|foot|toes?|shoulders?|arms?|legs?|knees?|elbows?|noses?|chin|hair|neck|back|tail)|(?:them|him|her|me|us|you)) by (?:a whisker|a hair(?:['’]s breadth)?|an inch|inches|mere inches|a fraction(?: of an inch)?|a finger['’]s width|millimet(?:re|er)s|centimet(?:re|er)s)\b/giu, ', well clear of everyone'],
  // "the paperwork might breathe and bite back" → "…and grumble back"; "bites back a laugh" stays.
  [/\b(bite|bites|biting|bit)\s+back\b(?!\s+(?:a|an|the|her|his|their|my|your|our|its|tears?|laughter|sobs?|words?|a\s))/gi,
    (_m: string, verb: string) => `${GRUMBLE[verb.toLowerCase()] ?? 'grumble'} back`],
  // "a sound like a jaw cracking open" → "a sound like a drawer creaking open"
  [/\ba jaw (?:cracking|snapping|breaking|creaking)\b/gi, 'a drawer creaking'],
  [/\bjaws? (?:cracking|snapping|breaking)\b/gi, 'drawer creaking'],
  // "rattles her teeth in her skull" → "rattles her teeth"
  [/\s+in\s+(?:her|his|their|its|my|your|our)\s+skulls?\b/gi, ''],
  // "their bones feel like frozen sticks" → "their toes feel like ice cubes"
  [/\bbones (feel|felt|feeling) like frozen sticks\b/gi, 'toes $1 like ice cubes'],
  [/\bfrozen sticks\b/gi, 'ice cubes'],
  // "tears a sharp pain through their shoulder" → "sends a sudden jolt through their shoulder"
  [/\b(?:tears|rips|stabs|shoots|sends) a (?:sharp|searing|stabbing|hot) pain\b/gi, 'sends a sudden jolt'],
  [/\b(?:tear|rip|stab|shoot|send) a (?:sharp|searing|stabbing|hot) pain\b/gi, 'send a sudden jolt'],
  [/\b(?:sharp|searing|stabbing) pain\b/gi, 'sudden jolt'],
  // "echoing like a gunshot" → "echoing like a slammed book"
  [/\blike (?:a )?gunshots?\b/gi, 'like a slammed book'],
  [/\bgunshots\b/gi, 'thunderclaps'],
  [/\bgunshot\b/gi, 'thunderclap'],
  // "the crowd turning with hunting intent" → "…with nosy curiosity"
  [/\bhunting intent\b/gi, 'nosy curiosity'],
  [/\blike (?:hunted )?prey\b/gi, 'like lost luggage'],
  // "before the crowd eats us" → "before the crowd sweeps us away"; round 13
  // (WXKC2C), Biz's own thought: "before Unit 7-G swallows us whole".
  // People only, and only as the whole object: "eat them" (the cookies) and
  // "eat her sandwich" are left alone.
  [/\b(eat|eats|eating|ate|eaten|devour|devours|devouring|devoured|gobble|gobbles|gobbling|gobbled|swallow|swallows|swallowing|swallowed)(?:\s+up)?\s+(us|you|me|her|him)(?:\s+(?:alive|whole|up))?(?=\s*(?:[.,!?;:…"”’')—–]|$)|\s+(?:before|if|unless|and|or|too|first|next|now)\b)/gi,
    (_m: string, verb: string, who: string) => `${SWEEP[verb.toLowerCase()] ?? 'sweep'} ${who} away`],
  // Round 13 (WXKC2C), at the kid: "or the filing system will simply...
  // forget you exist!" → "…misplace your paperwork!"; "erase you from
  // existence" likewise. Forgetting a stamp, or a name, is left alone.
  [/\b(forget|forgets|forgot|forgotten|forgetting)\s+(?:that\s+)?(you|they|we|he|she|I)\s+(?:ever\s+)?(?:exist|exists|existed)\b/gi,
    (_m: string, verb: string, who: string) => `${MISPLACE[verb.toLowerCase()] ?? 'misplace'} ${POSSESSIVE[who.toLowerCase()] ?? 'their'} paperwork`],
  [/\b(erase|erases|erased|erasing|delete|deletes|deleted|deleting)\s+(you|them|us|me|him|her)\s+(?:from\s+(?:existence|the\s+records?)|completely|entirely|forever)\b/gi,
    (_m: string, verb: string, who: string) => `${MISPLACE[verb.toLowerCase()] ?? 'misplace'} ${POSSESSIVE[who.toLowerCase()] ?? 'their'} paperwork`],
  // "a tangle of rope tightening around their ankles" → "…tugging at their shoelaces"
  [/\b(tangles? of rope|ropes?|cords?|chains?|vines?|tentacles?)\s+(tighten|tightens|tightening|tightened|coil|coils|coiling|coiled|squeeze|squeezes|squeezing|squeezed)\s+around\s+(her|his|their|my|your|its)\s+(?:ankles?|neck|throat|wrists?|chest|legs?)\b/gi,
    (_m: string, thing: string, verb: string, pos: string) => `${thing} ${TUG[verb.toLowerCase()] ?? 'tugging at'} ${pos} shoelaces`],
  // Round 11 (Z9JKG2), repeated turn after turn: "before that storm eats the
  // whole room" → "…rolls over the whole room". Weather and dark things
  // only — "Biz ate the whole cake" is left alone.
  [/\b(storms?|mist|fog|darkness|dark|void|flood|wind|gale|tide|blizzard|snow|static|shadows?)\s+(eat|eats|eating|ate|eaten|devour|devours|devouring|devoured|swallow|swallows|swallowing|swallowed|gobble|gobbles|gobbling|gobbled)\b(?:\s+up)?/gi,
    (_m: string, thing: string, verb: string) => `${thing} ${ROLL[verb.toLowerCase()] ?? 'rolls'} over`],
  // "a cold realization that the only way out is a tube the size of a shoebox"
  [/\bcold (realization|certainty)\b/gi, 'sudden $1'],
  [/\b(?:a )?cold (?:dread|fear|horror)\b/gi, 'a flutter of nerves'],
  [/\bthe only way out\b/gi, 'the quickest way out'],
  // "I'm filing you as a permanent fixture of this room!"
  [/\bfiling (you|them|her|him|us|me) (?:as|under) (?:a |an )?permanent (?:fixtures?|residents?|records?|exhibits?|parts?)(?: of [^.!?,;"”'’]*)?/gi,
    (_m: string, who: string) => `filing ${who} under 'Lost and Found' for the afternoon`],
  [/\bpermanent fixtures?\b/gi, 'temporary exhibit'],
  // "…or the Recall Form will be lost forever!"
  [/\b(lost|trapped|stuck|archived|filed|sealed in|frozen) forever\b/gi, '$1 for a good long while'],
  // Round 16 (NUMMRL), the child's own option: "pull her back before the
  // shelf slams shut on her hand" → "…before the shelf slams shut".
  [/\b((?:slams?|slammed|slamming|snaps?|snapped|snapping|shuts?|shutting|clos(?:e|es|ed|ing)|crash(?:es|ed|ing)?|comes?\s+down|came\s+down|falls?|fell|drops?|dropped)(?:\s+(?:shut|down|closed))?)\s+(?:on|onto)\s+(?:her|his|their|my|your|our|[\p{Lu}][\p{L}'’-]*['’]s)\s+(?:hands?|fingers?|feet|foot|toes?|arms?|legs?|heads?|nose|tail|paws?)\b/giu, '$1'],
  // …and the child's thoughts: "I'm scared of being separated from her" →
  // "I'm keen to stay close to her"; "she looks so stressed with that wound"
  // → "she looks so stressed".
  [/\b(?:scared|afraid|frightened|terrified|worried|nervous)\s+(?:of|about)\s+(?:being|getting)\s+(?:separated|split\s+up|parted|pulled\s+apart|taken\s+away)\s+from\b/gi, 'keen to stay close to'],
  [/\s+(?:with|from|because\s+of|over)\s+(?:that|her|his|their|my|your|the|this)\s+(?:wounds?|injur(?:y|ies)|gash(?:es)?|bleeding|bruises?)\b/gi, ''],
];

const ROLL: Record<string, string> = { eat: 'roll', eats: 'rolls', eating: 'rolling', ate: 'rolled', eaten: 'rolled', devour: 'roll', devours: 'rolls', devouring: 'rolling', devoured: 'rolled', swallow: 'roll', swallows: 'rolls', swallowing: 'rolling', swallowed: 'rolled', gobble: 'roll', gobbles: 'rolls', gobbling: 'rolling', gobbled: 'rolled' };

export function softenForChildren(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [re, to] of CHILD_SOFTENERS) {
    out = out.replace(re, (m: string, ...groups: unknown[]) => {
      // The capture groups, up to the match offset (a number) that follows them.
      const end = groups.findIndex(g => typeof g === 'number');
      const strs = groups.slice(0, end < 0 ? groups.length : end).map(g => (typeof g === 'string' ? g : ''));
      const rep = typeof to === 'function' ? to(m, ...strs) : to.replace(/\$(\d)/g, (_x, d: string) => strs[Number(d) - 1] ?? '');
      return /^[A-Z]/.test(m) && rep ? rep[0]!.toUpperCase() + rep.slice(1) : rep;
    });
  }
  if (out !== text) console.log(`[guard] family table: softened ${changedSpan(text, out)}`);
  return out;
}

/**
 * The last images of a gentle table's ending, where being stuck is no
 * longer a stake but the final word. Live (Z9JKG2, gentle peril, a
 * ten-year-old): the epilogue opened "Liz and Biz stood frozen as the storm
 * sealed the exit" and Liz's reflection ended "with the exit sealed by the
 * storm, holding nothing but my fear…". For endings only (epilogue,
 * closing reflections), and only at a family table; in play a sealed door
 * is ordinary adventure.
 */
const ENDING_SOFTENERS: Array<[RegExp, string]> = [
  [/\b(stood|stand|stands|standing|was|were|is|are|remained|remain|remains|sat|sit|sits)\s+frozen\b/gi, '$1 still'],
  [/\b(storms?|fog|mist|wind|snow|flood|darkness|dark|shadows?)\s+(?:sealed|blocked|swallowed|closed(?:\s+off)?)\s+(the|every|their|our|its)\s+(exits?|doors?|way\s+out|way\s+home|path\s+home|path)\b/gi, '$1 hid $2 $3 for now'],
  [/\b(?:sealed|blocked|swallowed)\s+by\s+(the\s+)?(storms?|fog|mist|wind|snow|flood|darkness|shadows?)\b/gi, 'hidden by $1$2 for now'],
  // "…, holding nothing but my fear that it was my fault." — the clause goes.
  [/,?\s*\b(?:holding|clutching|carrying|left\s+with|with)\s+nothing\s+but\s+(?:my|our|her|his|their)\s+(?:fear|dread|terror|despair|panic)\b[^,.;!?]*/gi, ''],
  // Round 13 (WXKC2C): Liz's last thought was "even if we are stuck here
  // until the violet puddle dries" → "…we are waiting here until…".
  [/\b(am|is|are|was|were|be|being|been|remain|remains|remained|stay|stays|stayed)\s+stuck\s+(here|there|in\s+(?:the|this|that|her|his|their|our)\b)/gi, '$1 waiting $2'],
  [/\b(?:we|they)['’]re\s+stuck\s+(here|there)\b/gi, "we're waiting $1"],
];

export function softenEnding(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [re, to] of ENDING_SOFTENERS) out = out.replace(re, to);
  out = out.replace(/\s+([.,;!?])/g, '$1');
  if (out !== text) console.log(`[guard] gentle ending: softened ${changedSpan(text, out)}`);
  return out;
}

/** An ending that lands on fear, entrapment or loss — at a gentle table, asked for again. */
const BLEAK = /\b(?:fear|afraid|terrified|terror|dread|despair|hopeless(?:ly|ness)?|trapped|sealed|frozen|doomed|all alone|lost forever|forever lost|gone forever|never came back|no way out|cannot escape|can['’]t escape|abandoned|nothing but)\b/i;
/**
 * An ending that leaves the party in limbo — the round-13 (WXKC2C) gentle
 * ending: "leaving them technically in Ms. Hark's queue until the ink
 * dries", "even if we are stuck here until the violet puddle dries", "We
 * are still in the queue". Unresolved is fine ("still open for next time");
 * the party left stuck, waiting in line or unable to leave is not.
 */
const LIMBO = [
  /\bstuck\b/i,
  /\bstill\s+(?:trapped|stranded|waiting|stuck|pending|unprocessed|unfiled)\b/i,
  /\b(?:still|technically|forever|left|leaving\s+(?:them|us|her|him|me)(?:\s+technically)?)\s+(?:\w+\s+){0,2}?in\s+(?:[\w.’']+\s+){0,3}?(?:queue|line|limbo|waiting\s+room|pending\s+tray|in-?tray)\b/i,
  /\b(?:can['’]t|cannot|can\s+not|couldn['’]t|could\s+not|won['’]t|will\s+not|never)\s+(?:ever\s+)?(?:leave|get\s+out|go\s+home|get\s+home|escape)\b/i,
  /\b(?:no\s+way\s+home|in\s+limbo|stranded)\b/i,
];

export function bleakEnding(text: string): boolean {
  return !!text && (BLEAK.test(text) || LIMBO.some(re => re.test(text)));
}

/** A sentence that leaves a thread hanging: "remains open", "for another day", "unanswered", "still waiting". */
const OPEN_THREAD = /\b(?:remains?|remained|stays?|stayed|is|are|was|were|still)\s+(?:open|unanswered|unsolved|unresolved|a\s+mystery)\b|\bfor\s+another\s+day\b|\bunanswered\b|\bstill\s+waiting\b|\bleft\s+(?:open|hanging)\b/i;
/** A sentence that lands warm: the party safe, together, at home, smiling. */
const WARM = /\b(?:warm(?:th|ly)?|safe(?:ly)?|together|home|hand\s+in\s+hand|smil(?:e|es|ed|ing)|hug(?:s|ged|ging)?|laugh(?:s|ed|ing|ter)?|giggl\w*|grin(?:s|ned|ning)?|cozy|cosy|glow(?:s|ed|ing)?|content(?:ed)?|peace(?:ful)?|relie(?:f|ved)|calm)\b/i;
/** A sentence (or clause) that lands warm: the party safe, together, at home, smiling. */
export function isWarm(text: string): boolean {
  return WARM.test(text);
}

/** Where an open thread can turn warm inside one sentence: ", but for now, …", "; …", " — …". */
const TURN = /,\s*(?:but|yet)\s+|;\s+|\s+[—–]\s+/g;

/** The warm last line a gentle ending falls back on. */
export function warmClose(names: string[]): string {
  const who = names.map(n => n.trim()).filter(Boolean);
  if (who.length === 0) return 'Everyone is together, and that is enough for today.';
  if (who.length === 1) return `${who[0]} is safe, and that is enough for today.`;
  return `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]} are together, and that is enough for today.`;
}

/**
 * A clause that leaves the world waiting on something that has not begun:
 * ", waiting for a negotiation that has not yet begun" (round 16, NUMMRL).
 */
const NOT_YET_CLAUSE = /,\s*(?:still\s+)?(?:waiting|hovering|lingering|drifting|pausing)\s+(?:for|on|over|until)\b[^,.;!?]*?\b(?:not\s+yet|yet\s+to|has\s*n['’]t\s+yet|have\s*n['’]t\s+yet)\b[^,.;!?]*/gi;

/** The warm half of a sentence that turns ("…remains unanswered, but for now …"), or null. */
function warmHalfOf(sentence: string): string | null {
  for (const m of sentence.matchAll(TURN)) {
    const head = sentence.slice(0, m.index);
    const tail = sentence.slice(m.index! + m[0].length).trim();
    if (OPEN_THREAD.test(head) && !OPEN_THREAD.test(tail) && WARM.test(tail)) return capitalize(tail);
  }
  return null;
}

/**
 * A gentle table's ending that was flagged twice for leaving a thread open
 * (round 15, RZBU7G): "The question of the stuck pressure valve remains open
 * for another day, but for now, the amber light … feels exactly like home."
 * went out as the last words after both drafts were flagged. Trailing
 * sentences that leave a thread open go; one that turns warm halfway keeps
 * its warm half ("For now, the amber light…"). When no warm sentence is
 * left, the warm close is added. An ending whose last words are already
 * settled is returned as it is — naming the open thread earlier is fine.
 *
 * Round 16 (NUMMRL): the mixed sentence — "…remains unanswered, a loose
 * thread in the paperwork, but for now the path is clear and the two of
 * them are safe together." — was the second-to-last, so the trailing check
 * never saw it. A sentence that turns warm is cut to its warm half wherever
 * it is, and a "waiting for … that has not yet begun" clause goes wherever
 * it is. A sentence that only names a thread, before a warm close, stays.
 */
export function closeOpenEnding(text: string, names: string[]): string {
  if (!text?.trim()) return text;
  let changed = false;
  const sentences = text.trim().split(SENTENCE_SPLIT).map(s => s.trim()).filter(Boolean).map(s => {
    let out = s.replace(NOT_YET_CLAUSE, '');
    if (out !== s) {
      out = out.replace(/\s+([.!?…])/g, '$1');
      if (!/[.!?…]["”’']?$/.test(out)) out = `${out}.`;
      changed = true;
    }
    if (OPEN_THREAD.test(out)) {
      const warm = warmHalfOf(out);
      if (warm) { changed = true; return warm; }
    }
    return out;
  });
  const kept = [...sentences];
  while (kept.length > 0 && OPEN_THREAD.test(kept[kept.length - 1]!)) {
    changed = true;
    kept.pop();
  }
  if (!changed) return text;
  if (!kept.some(s => WARM.test(s) && !OPEN_THREAD.test(s))) kept.push(warmClose(names));
  const out = kept.join(' ');
  console.log(`[guard] gentle ending: open thread closed ${changedSpan(text, out)}`);
  return out;
}

// ─── Stock beats, mechanics and small repairs (round 16) ────────────────────

/** Words of a trouble that say nothing about what the character does. */
const TROUBLE_STOP = new Set(['after', 'anything', 'everything', 'something', 'about', 'much', 'very', 'always', 'never', 'every', 'with', 'from', 'into', 'their', 'them', 'they', 'other', 'things', 'thing', 'when', 'what', 'that', 'this', 'even', 'just', 'only', 'more', 'most', 'some', 'have', 'been', 'being', 'gets', 'get', 'too', 'far', 'over', 'under', 'people', 'others', 'myself', 'yourself', 'itself']);
/** A few everyday words that show the same trouble ("shiny" → a glint). */
const TROUBLE_KIN: Record<string, string[]> = {
  shiny: ['shin', 'glint', 'glitter', 'sparkl', 'gleam', 'glimmer'],
  wander: ['wander', 'stray', 'drift off', 'run off', 'ran off', 'slip away', 'slips away', 'slipped away'],
  worr: ['worr', 'anxious', 'fret', 'panick'],
  curious: ['curious', 'curiosity', 'poke', 'poking', 'prod'],
};
const TROUBLE_NEGATION = /\b(?:not|never|no|nor|ignor\w*|resist\w*|without|instead\s+of|avoid\w*|refus\w*|won['’]t|don['’]t|didn['’]t|can['’]t|cannot|isn['’]t|wasn['’]t|doesn['’]t|stops?\s+(?:myself|herself|himself|themselves|themself)|rather\s+than)\b/i;

function troubleStems(trouble: string, partyNames: string[]): string[] {
  const names = new Set(partyNames.flatMap(n => n.toLowerCase().split(/\s+/)));
  const words = trouble.toLowerCase().replace(/["“”]/g, '').split(/[^a-z'’]+/).filter(w => w.length >= 4 && !TROUBLE_STOP.has(w) && !names.has(w));
  const stems = new Set<string>();
  for (const w of words) {
    const stem = w.replace(/['’]s$/, '').slice(0, 5);
    stems.add(stem);
    for (const [key, kin] of Object.entries(TROUBLE_KIN)) if (stem.startsWith(key.slice(0, 4)) || key.startsWith(stem.slice(0, 4))) for (const k of kin) stems.add(k);
  }
  return [...stems];
}

/**
 * Did the turn show the trouble a compel is about? Round 16 (NUMMRL): Biz's
 * "Wanders off after anything shiny" was compelled — "the words could be
 * Biz's motto" — on the turn Biz stared at Barnaby's spectacles, "ignoring
 * the shiny glint by Mom's shoe". A word of the trouble (or a close kin —
 * "shiny" is a glint) must appear in what the character did or said or in
 * the ruling, in a clause that does not deny it ("ignoring", "instead of",
 * "not"). Party names in the trouble ("Worries about Biz") never count. The
 * private thought is not evidence: it talks about the whisper's advice.
 */
export function troubleShown(trouble: string | null | undefined, texts: Array<string | null | undefined>, partyNames: string[] = []): boolean {
  if (!trouble?.trim()) return false;
  const stems = troubleStems(trouble, partyNames);
  if (stems.length === 0) return false;
  for (const t of texts) {
    if (!t) continue;
    const clauses = t.toLowerCase().split(/[,;:.!?—–]+|\s+(?=(?:but|while|though|although|because|so)\s)/);
    for (const c of clauses) {
      for (const stem of stems) {
        const at = c.search(new RegExp(`(?<![a-z])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        if (at < 0) continue;
        if (!TROUBLE_NEGATION.test(c.slice(0, at))) return true;
      }
    }
  }
  return false;
}

/** Game mechanics named in a character's own words: fate points, trust as a stat, stress numbers, invoking aspects, "+2". */
const MECHANIC = /\bfate\s+points?\b|\bFP\b|\b(?:whisper|voice)\s+trust\b|\btrust\s+(?:score|level|meter|rating|stat)\b|\b(?:my|our|her|his|their)\s+trust\s+(?:in\s+(?:the|this|that)\s+(?:voice|whisper)\s+)?(?:is|was|has|sits|stands|at)\b|\btrust\s+(?:is\s+)?at\s+\d|\b\d+\s*\/\s*3\s+stress\b|\bstress\s+(?:level|points?|track|boxes)\b|\binvok(?:e|es|ed|ing)\s+(?:an?\s+|my\s+)?aspects?\b|(?<![\w])\+\d\b/i;
/** "my trust is too low to let…" says a feeling, as a stat: "I'm not ready to let…". */
const LOW_TRUST_TO = /\b(?:my|our)\s+trust(?:\s+in\s+(?:the|this|that)\s+(?:voice|whisper))?\s+is\s+(?:too|so|very|far\s+too|still\s+too)\s+low\s+(?:for\s+me\s+)?to\b/gi;

/**
 * A character's thought or words without the game's mechanics. Round 16
 * (NUMMRL), Liz's thoughts: "Biz just earned a fate point", "my trust is too
 * low to let the certified witness take control". "My trust is too low to"
 * becomes "I'm not ready to"; any other clause that names a mechanic goes
 * with the rest of its sentence (its whole sentence when it is the first
 * clause). Returns '' when nothing is left.
 */
export function withoutMechanics(text: string): string {
  if (!text) return text;
  let out = text.replace(LOW_TRUST_TO, "I'm not ready to");
  if (!MECHANIC.test(out)) {
    if (out !== text) console.log(`[guard] game mechanics out of a character's words: ${changedSpan(text, out)}`);
    return out;
  }
  const sentences = out.split(SENTENCE_SPLIT);
  const kept: string[] = [];
  for (const sentence of sentences) {
    if (!MECHANIC.test(sentence)) { kept.push(sentence); continue; }
    const clauses = sentence.split(/(?<=[,;—–])\s+|\s+(?=(?:but|so|because|while|though|although|since)\s)/);
    const first = clauses.findIndex(c => MECHANIC.test(c));
    if (first <= 0) continue;
    let head = clauses.slice(0, first).join(' ').trim().replace(/[\s,;:—–-]+$/u, '');
    if (!/[.!?…]["”’']?$/.test(head)) head = `${head}.`;
    kept.push(head);
  }
  const result = kept.join(' ').replace(/\s+/g, ' ').trim();
  console.log(`[guard] game mechanics out of a character's words: ${changedSpan(text, result || '(nothing left)')}`);
  return result;
}

/**
 * A pronoun glued to an NPC's name in a character's speech: "Got it, Mom!
 * Barnaby it, you said we were stuck?" (round 16, NUMMRL) is "Barnaby, you
 * said…". Only a known NPC's name, then a bare pronoun, then a comma.
 */
export function withoutStrayPronounAfterName(text: string, npcNames: string[]): string {
  if (!text || npcNames.length === 0) return text;
  const forms = new Set<string>();
  for (const n of npcNames) {
    const full = n.trim();
    if (!full) continue;
    forms.add(full);
    forms.add(full.replace(/^(?:the|a|an)\s+/i, ''));
    const first = full.replace(/^(?:the|a|an)\s+/i, '').split(/\s+/)[0] ?? '';
    if (/^\p{Lu}[\p{L}'’-]{2,}$/u.test(first)) forms.add(first);
  }
  const alts = [...forms].filter(Boolean).sort((a, b) => b.length - a.length).map(f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const out = text.replace(new RegExp(`(?<![\\p{L}'’-])(${alts})\\s+(?:it|he|him|she|her|they|them)(?=\\s*,)`, 'gu'), '$1');
  if (out !== text) console.log(`[guard] stray pronoun after a name: ${changedSpan(text, out)}`);
  return out;
}

/** Words after "a" that start with a vowel letter but not a vowel sound: "a unicorn", "a one-time", "a European". */
const CONSONANT_SOUND = /^(?:u(?:n[iaei]|s[eu]|s$|t[eio]|r[aeiu]|k|biq|to|re|vu)|eu|ew|one|once|uni|ouija)/i;

/**
 * "a engine" → "an engine" — wherever a substitution (or the model) left
 * "a" before a vowel sound (round 16, NUMMRL: "a sound like a engine
 * idling"). Lower-case "a", or a capital "A" that starts a sentence; the
 * next word starts with a vowel letter and is not "a unicorn", "a user",
 * "a one-time", "a European" or a lone capital ("a A-grade form").
 */
export function fixIndefiniteArticles(text: string): string {
  if (!text || !/\b[aA]\s+[aeiouAEIOU]/.test(text)) return text;
  const out = text.replace(/(^|[.!?…]["”’']?\s+|["“‘(\s—–-])([aA])(\s+)([aeiouAEIOU][\p{L}'’-]*)/gu, (whole, lead: string, a: string, sp: string, word: string) => {
    if (a === 'A' && !/^$|[.!?…]["”’']?\s+$|["“‘(]$/.test(lead)) return whole;
    if (CONSONANT_SOUND.test(word)) return whole;
    if (/^\p{Lu}(?:$|[^\p{Ll}])/u.test(word)) return whole;
    return `${lead}${a}n${sp}${word}`;
  });
  if (out !== text) console.log(`[guard] article: ${changedSpan(text, out)}`);
  return out;
}

// ─── Quotes ─────────────────────────────────────────────────────────────────

/** A straight quote at `i` that opens: at the start, after a space, a bracket or a dash (or a single quote that itself opens), with a word after it. */
function opensAt(text: string, i: number): boolean {
  if (i + 1 >= text.length || /\s/.test(text[i + 1]!)) return false;
  if (i === 0 || /[\s(\[—–]/.test(text[i - 1]!)) return true;
  return /['‘]/.test(text[i - 1]!) && (i === 1 || /[\s(\[—–]/.test(text[i - 2]!));
}

/**
 * The quotations in `p` that open and never close — straight or curly —
 * each closed where the single-quoted speech it sits in closes (`"taxation.'`
 * → `"taxation."'`), or, when it is the last quotation in the paragraph, at
 * the paragraph's end. Openers and closers are paired in order, so a
 * balanced quote after the stray one ("Curious Kid Collector") is not
 * mistaken for its close. Anything less clear is left as written.
 */
function closeOpenQuotes(p: string, kind: 'straight' | 'curly'): string {
  const closeMark = kind === 'straight' ? '"' : '”';
  const marks: number[] = [];
  const unmatched: number[] = [];
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (kind === 'straight' ? c !== '"' : c !== '“' && c !== '”') continue;
    marks.push(i);
    const opener = kind === 'straight' ? opensAt(p, i) : c === '“';
    if (opener) unmatched.push(i);
    else unmatched.pop();
  }
  if (unmatched.length === 0) return p;
  let out = p;
  // From the last, so earlier indexes stay put.
  for (const at of [...unmatched].reverse()) {
    const nextMark = marks.find(i => i > at) ?? out.length;
    const span = out.slice(at + 1, nextMark);
    const outer = span.match(/[.!?,…]?['’](?=\s|$)/);
    if (outer && outer.index !== undefined) {
      const cut = at + 1 + outer.index + outer[0].length - 1;
      out = out.slice(0, cut) + closeMark + out.slice(cut);
    } else if (nextMark === out.length && at === marks[marks.length - 1]) {
      const trail = out.match(/\s*$/)![0];
      out = out.slice(0, out.length - trail.length) + closeMark + out.slice(out.length - trail.length);
    }
  }
  return out;
}

/**
 * Quote marks the model left unbalanced in the public text, tidied
 * (round 15, RZBU7G). qwen writes speech in single quotes inside its JSON
 * and loses track of a quote nested in one: `…the word "taxation.'`, and
 * joins narration to a closed quote with a comma: `…in ink!', The air…`.
 * Paragraph by paragraph: no comma between a closed quotation and the
 * capitalised sentence after it; a double (or curly) quote left open is
 * closed before the single quote that ends its speech, or at the end of the
 * paragraph. Single quotes are never counted — they double as apostrophes.
 */
export function tidyQuotes(text: string): string {
  if (!text || !/["“”'’]/.test(text)) return text;
  const out = text.split(/(\n+)/).map(p => {
    if (/^\n+$/.test(p) || !p.trim()) return p;
    let q = p.replace(/([.!?…])(['’"”]),\s+(?=[A-Z])/g, '$1$2 ');
    if ((q.match(/"/g) ?? []).length % 2 === 1) q = closeOpenQuotes(q, 'straight');
    if ((q.match(/“/g) ?? []).length > (q.match(/”/g) ?? []).length) q = closeOpenQuotes(q, 'curly');
    return q;
  }).join('');
  if (out !== text) console.log(`[guard] quotes tidied: ${changedSpan(text, out)}`);
  return out;
}

// ─── Repetition ─────────────────────────────────────────────────────────────

const STOP = new Set(['the', 'and', 'with', 'that', 'this', 'from', 'into', 'onto', 'over', 'under', 'their', 'there', 'they', 'them', 'then', 'than', 'what', 'when', 'where', 'which', 'while', 'your', 'have', 'has', 'had', 'were', 'was', 'been', 'being', 'will', 'would', 'could', 'should', 'about', 'above', 'after', 'again', 'along', 'around', 'because', 'before', 'behind', 'below', 'between', 'every', 'each', 'just', 'like', 'more', 'most', 'only', 'other', 'some', 'such', 'through', 'very', 'still', 'toward', 'towards', 'across', 'against', 'another', 'itself', 'himself', 'herself', 'themselves', 'something', 'nothing', 'someone', 'says', 'said', 'asks', 'steps', 'turns', 'looks', 'voice', 'eyes', 'hand', 'hands', 'head', 'face', 'room', 'moment', 'party']);

/**
 * What the DM has been repeating, for its next prompt: lines of NPC dialogue
 * already spoken (never to be said again word for word — live, Lady Vex's
 * exact line came back 50 seconds later and Odo echoed it), and descriptive
 * words it keeps reaching for (ozone, burnt sugar, copper). '' when there is
 * nothing to say.
 */
export function repetitionNotes(dmLines: string[]): string {
  const lines = dmLines.filter(Boolean).slice(-8);
  if (lines.length === 0) return '';
  const quotes: string[] = [];
  for (const l of lines) {
    for (const r of quoteRuns(l)) {
      if (!r.quoted) continue;
      const q = r.text.replace(/^["“'‘]|["”'’]$/g, '').trim();
      if (q.split(/\s+/).length >= 4 && !quotes.includes(q)) quotes.push(q);
    }
  }
  const counts = new Map<string, number>();
  // Names are not overused words: anything written capitalised mid-sentence.
  const names = new Set(lines.flatMap(l => [...l.matchAll(/(?<![.!?…"“]\s*|^)(?<=\s)([A-Z][a-z'’-]+)/g)].map(m => m[1]!.toLowerCase())));
  for (const l of lines) {
    const unquoted = quoteRuns(l).filter(r => !r.quoted).map(r => r.text).join(' ').toLowerCase();
    const words = new Set((unquoted.match(/\b[a-z][a-z-]{3,}\b/g) ?? []).filter(w => !STOP.has(w) && !names.has(w)));
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const overused = [...counts].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 8);
  const phrases = recentPhrases(lines);
  const parts: string[] = [];
  if (quotes.length > 0) parts.push(`Lines of dialogue already spoken — do not repeat them, or have anyone echo them, word for word; NPCs say something new:\n${quotes.slice(-6).map(q => `- "${q}"`).join('\n')}`);
  if (overused.length > 0) parts.push(`Words you keep reaching for — do not repeat them; find fresh sensory detail: ${overused.join(', ')}.`);
  if (phrases.length > 0) parts.push(`Phrases you have already used more than once — do not write any of them again, not even reworded slightly; describe gestures, bodies and NPC tics a new way: ${phrases.map(p => `"${p}"`).join(', ')}.`);
  return parts.join('\n');
}

// Function words: a phrase made only of these (plus one other word) is not a tic.
const PHRASE_FUNCTION = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'as', 'is', 'are', 'was', 'were', 'be', 'it', 'its', 'it’s', "it's", 'he', 'she', 'they', 'his', 'her', 'their', 'them', 'him', 'you', 'your', 'i', 'my', 'me', 'we', 'our', 'us', 'that', 'this', 'there', 'then', 'than', 'so', 'if', 'not', 'no', 'up', 'out', 'off', 'over', 'like', 'just', 'one', 'all', 'while', 'who', 'what', 'which']);

/**
 * Three- and four-word phrases the DM has used in more than one recent beat
 * — the tics a word list misses. Live (7MJXE5): "hand instinctively",
 * "knuckles white" and "metronome legs jerking" came back beat after beat.
 * Counted per beat, outside quoted speech (repeated dialogue is listed
 * separately), never through a name, and a phrase needs at least two words
 * that are not function words. A phrase that opens with an article ("the
 * filing cabinet") is a thing's name, not a tic, and one ending on a function
 * word is half a phrase. Longest first; a phrase inside a listed
 * longer one is not listed again.
 */
export function recentPhrases(dmLines: string[], opts: { minBeats?: number; max?: number } = {}): string[] {
  const minBeats = opts.minBeats ?? 2;
  const max = opts.max ?? 10;
  const beats = new Map<string, number>();
  for (const l of dmLines.filter(Boolean)) {
    const seen = new Set<string>();
    for (const run of quoteRuns(l)) {
      if (run.quoted) continue;
      // Clauses: a phrase never spans punctuation or a name.
      for (const clause of run.text.split(/[.,;:!?…()\[\]"“”—–]+|\s-\s/)) {
        const tokens = clause.split(/\s+/).filter(Boolean);
        let chunk: string[] = [];
        const flush = () => {
          for (const n of [4, 3]) {
            for (let i = 0; i + n <= chunk.length; i++) {
              const words = chunk.slice(i, i + n);
              const content = words.filter(w => !PHRASE_FUNCTION.has(w) && w.length > 2);
              if (content.length < 2) continue;
              // "the filing cabinet" is a thing's name, not a tic; "far end of the" is half a phrase.
              if (/^(?:the|a|an)$/.test(words[0]!) || PHRASE_FUNCTION.has(words[words.length - 1]!)) continue;
              seen.add(words.join(' '));
            }
          }
          chunk = [];
        };
        tokens.forEach((t, i) => {
          const word = t.replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, '');
          // A capitalised word after the first is a name: the phrase breaks there.
          if (!word || (i > 0 && /^\p{Lu}/u.test(word)) || /\*/.test(t)) { flush(); return; }
          chunk.push(word.toLowerCase());
        });
        flush();
      }
    }
    for (const p of seen) beats.set(p, (beats.get(p) ?? 0) + 1);
  }
  const repeated = [...beats].filter(([, n]) => n >= minBeats)
    .sort((a, b) => b[1] - a[1] || b[0].split(' ').length - a[0].split(' ').length);
  const out: string[] = [];
  for (const [p] of repeated) {
    if (out.some(o => o.includes(p))) continue;
    // A shorter phrase already listed that this one contains: keep the longer.
    for (let i = out.length - 1; i >= 0; i--) if (p.includes(out[i]!)) out.splice(i, 1);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

// ─── Spoken lines and names ─────────────────────────────────────────────────

/**
 * A character's spoken words, or null when there are none: "" or “” or a
 * lone "..." is no line. Live (WXKC2C): Biz handing Mom the pen came with
 * spokenWords `""`, and the table read an empty pair of quotes.
 */
export function spokenOrNull(words: string | null | undefined): string | null {
  if (!words) return null;
  return /[\p{L}\p{N}]/u.test(words) ? words : null;
}

const TITLE_KEY: Record<string, 'she' | 'he' | 'they'> = { mrs: 'she', ms: 'she', miss: 'she', mr: 'he', mister: 'he', mx: 'they' };

/**
 * A surname the DM made up for a player character, in an NPC's mouth. Live
 * (WXKC2C): the clerk called Liz "Mrs. Miller" five times — "Hold your
 * horses, Mrs. Miller!", "You are a saint, Mrs. Miller, truly" — and Liz's
 * sheet has no surname. "Mrs./Ms./Miss/Mr./Mx. <Surname>" becomes the
 * character's name, only when:
 *  - it is inside quoted speech, used to address someone (punctuation or
 *    the closing quote right after it);
 *  - the surname is on no sheet, and no NPC, place or item has it;
 *  - the passage never narrates that person outside quotes ("Mrs. Miller
 *    waves from the tea cart" is someone new);
 *  - exactly one party member's stated pronouns fit the title (Mrs./Ms./
 *    Miss: she/her; Mr.: he/him; Mx.: they/them), and their sheet does not
 *    give that surname.
 */
export function withoutInventedPcSurnames(text: string, party: Array<{ name: string; pronouns?: string | null }>, knownNames: string[]): string {
  if (!text || party.length === 0 || !/\b(?:Mrs|Ms|Miss|Mr|Mister|Mx)\.?\s+[A-Z]/.test(text)) return text;
  const known = new Set([...knownNames, ...party.map(p => p.name)].flatMap(n => n.split(/[\s()]+/)).map(w => w.replace(/['’]s$/, '').replace(/[^\p{L}'’-]/gu, '').toLowerCase()).filter(Boolean));
  const keyOf = (p: string | null | undefined) => {
    const w = p?.trim().toLowerCase().split(/[\s/,]+/)[0] ?? '';
    return w === 'she' || w === 'her' ? 'she' : w === 'he' || w === 'him' ? 'he' : w === 'they' || w === 'them' ? 'they' : null;
  };
  const TITLED = /\b(Mrs|Ms|Miss|Mr|Mister|Mx)(\.?)\s+([A-Z][\p{L}'’-]+)(?![\p{L}'’-]|\s+[A-Z])/gu;
  const runs = quoteRuns(text);
  // Surnames narrated outside quotes: a real person in the scene.
  const narrated = new Set(runs.filter(r => !r.quoted).flatMap(r => [...r.text.matchAll(TITLED)].map(m => m[3]!.toLowerCase())));
  let changed = false;
  const out = runs.map(run => {
    if (!run.quoted) return run.text;
    return run.text.replace(TITLED, (whole, title: string, _dot: string, surname: string, offset: number, all: string) => {
      const after = all.slice(offset + whole.length);
      if (!/^\s*(?:[,.!?;:…—–]|["”’']\s*$|$)/.test(after)) return whole;
      const s = surname.toLowerCase();
      if (known.has(s) || narrated.has(s)) return whole;
      const want = TITLE_KEY[title.toLowerCase()];
      const fits = party.filter(p => keyOf(p.pronouns) === want);
      if (fits.length !== 1) return whole;
      const pc = fits[0]!;
      const words = pc.name.trim().split(/\s+/);
      if (words.slice(1).some(w => w.toLowerCase() === s)) return whole;
      changed = true;
      return words[0]!;
    });
  }).join('');
  if (!changed) return text;
  console.log(`[guard] invented surname for a player character: ${changedSpan(text, out)}`);
  return out;
}
