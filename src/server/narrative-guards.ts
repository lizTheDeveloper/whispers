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
    correction: {
      tie: [
        `But the victory isn't clean — something slips, cracks, or shifts in the process.`,
        `Yet something catches — a snag, a cost, a complication ${didnt} foresee.`,
        `The moment teeters between triumph and consequence.`,
      ],
      'success-with-cost': [
        `But the price is steep — the effort leaves its mark.`,
        `Success, yes — but the kind that leaves bruises.`,
        `${S} ${agree(r, 'pushes', 'push')} through, but the strain shows.`,
      ],
      failure: [
        `But the numbers don't lie — the attempt falls short, and the situation shifts against ${r.object}.`,
        `Yet despite the effort, circumstances conspire — and the moment slips away.`,
        `But fate has other plans — the attempt crumbles under scrutiny.`,
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

const SENTENCES = /(?<=[.!?…]["”’']?)\s+/;

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
const HANDOFF = new RegExp(String.raw`\b(press(?:es|ed|ing)?|plac(?:e|es|ed|ing)|slip(?:s|ped|ping)?|put(?:s|ting)?|tuck(?:s|ed|ing)?|drop(?:s|ped|ping)?|push(?:es|ed|ing)?|fold(?:s|ed|ing)?|shov(?:e|es|ed|ing))\b[^.!?;]*?\b(?:into|in|onto)\s+(her|their|his|[A-Z][\w-]*['’]s)\s+${ADJS}${KEEPING}\b`, 'i');

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

/** The noun an item's name is: "Orange Key" → key, "The Letter of Truth" → letter, "Form 9-B: Return to Source (Crumpled)" → form. */
export function itemHead(name: string): string | null {
  const core = name.split(/[:(]/)[0]!.replace(/\s+of\s+.*$/i, '');
  // Whole words only: "9-B" is a label, not a noun.
  const words = core.toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z'’-]+$/, '')).filter(w => /^[a-z][a-z'’-]*$/.test(w) && !['the', 'a', 'an'].includes(w));
  return words.length > 0 ? words[words.length - 1]! : null;
}

/** Words that name this item in prose: its head noun and that noun's kin. */
function itemNouns(name: string): string[] {
  const head = itemHead(name);
  return head ? [head, ...(ITEM_KIN[head] ?? [])] : [];
}

/** An item's name for comparing: lower case, no leading article, no trailing parenthetical. */
export function sameItem(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/^(?:the|a|an)\s+/, '').replace(/\s+/g, ' ');
  return norm(a) === norm(b);
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
export function narratesItemTransfer(narration: string, item: string, actor: string, opts: { acting?: boolean } = {}): boolean {
  if (!narration || !item) return false;
  const itemWords = [...new Set([...(item.toLowerCase().match(/[a-z]+/g)?.filter(w => w.length >= 3 && !['the', 'and', 'of'].includes(w)) ?? []), ...itemNouns(item)])];
  if (itemWords.length === 0) return false;
  const first = firstName(actor);
  const name = esc(first);
  for (const sentence of unquotedSentences(narration)) {
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
export function narratesItemTransferRecently(current: string, recent: string[], item: string, actor: string, opts: { acting?: boolean } = {}): boolean {
  return narratesItemTransfer(current, item, actor, opts) || recent.some(t => narratesItemTransfer(t, item, actor));
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
  const N = `(?:${nouns.map(esc).join('|')})s?`;
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
const HANDOFF_VERB = String.raw`(?:press(?:es|ed)?|plac(?:e|es|ed)|slip(?:s|ped)?|put(?:s)?|tuck(?:s|ed)?|drop(?:s|ped)?|push(?:es|ed)?|shov(?:e|es|ed))`;

/** A sentence that shows `member` coming to hold something named by `nouns` (see narratedItemEvents). */
function showsGain(sentence: string, member: string, nouns: string[]): boolean {
  const M = esc(firstName(member));
  const N = `(?:${nouns.map(esc).join('|')})s?`;
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
    new RegExp(`\\b(?:the|a|an)\\s+${ADJS}${N}\\s+(?:in|inside|within)\\s+${M}['’]s\\s+(?:[\\w-]+\\s+){0,2}?${HELD_IN}\\b`, 'i'),
    new RegExp(`\\b${M}\\s+(?:\\w+ly\\s+)?${HOLDS}\\s+${obj}`, 'i'),
    new RegExp(`\\b${M}['’]s\\s+(?:[\\w-]+\\s+)?(?:grip|hold|grasp)\\s+(?:on|around)\\s+${obj}`, 'i'),
  ];
  return res.some(re => re.test(sentence));
}

/** Verbs of holding something already in hand. */
const HOLDS = String.raw`(?:clutch(?:es)?|clutching|holds|holding|is\s+holding|grips|gripping|clasps|clasping|cradles|cradling)`;
/** Where a held thing is: a hand, a grip, a bag. */
const HELD_IN = String.raw`(?:hand|hands|grip|grasp|fist|fingers|palm|palms|arms|pocket|pockets|bag|tote|satchel|pouch|backpack)`;

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
  const nounRe = new RegExp(`\\b(?:${nouns.map(esc).join('|')})s?\\b`, 'i');
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

/**
 * Words that say a thing is gone for good: destroyed, eaten, swallowed,
 * torn to uselessness, stolen, confiscated, lost. Completed forms only —
 * "or the door will eat the key" is a threat, not a loss.
 */
const LOSS = new RegExp([
  String.raw`\b(?:has|have|had|is|was|are|were|gets|got)\s+(?:just\s+|already\s+|now\s+|been\s+|completely\s+|utterly\s+)*(?:swallowed|eaten|devoured|gobbled(?:\s+up)?|destroyed|shredded|burned\s+up|burnt\s+up|stolen|confiscated|lost|ruined|torn\s+(?:apart|to\s+(?:shreds|pieces|bits)|in\s+(?:two|half)))`,
  String.raw`\b(?:swallows|swallowed|devours|devoured|gobbles(?:\s+up)?|gobbled(?:\s+up)?|eats|ate|shreds|shredded|destroys|destroyed|steals|stole|confiscates|confiscated)\s+(?:up\s+)?(?:the|her|his|their|[A-Z][\w-]*['’]s)\b`,
  String.raw`\b(?:tear|tears|tearing|tore|torn|rip|rips|ripping|ripped)\s+(?:it\s+|itself\s+)?(?:completely|apart|clean\s+through|to\s+(?:shreds|pieces|bits)|in\s+(?:two|half))`,
  String.raw`\buseless\s+(?:smear|pulp|scrap|mess|lump|shreds)`,
  String.raw`\b(?:crumbles?|crumbled|crumbling)\s+(?:in)?to\s+(?:dust|ash|ashes)`,
].join('|'), 'i');
/** Before a loss word: it has not happened (yet). */
const UNREAL_BEFORE = /\b(?:not|never|almost|nearly|if|unless|would|could|might|may|will|shall|['’]ll|about\s+to|threatens?\s+to|tries\s+to|trying\s+to|wants?\s+to|before|or)\b[^.!?]{0,30}$/i;

/**
 * A sentence saying the item named by `nouns` is gone: a loss word with the
 * item's noun close by — just before it ("The paper …, tearing completely")
 * or just after ("has swallowed the key") — so "…swallowed the key, … a
 * fear that tastes of old paper" loses the key, not a paper form.
 */
function showsLoss(sentence: string, nouns: string[]): boolean {
  const N = new RegExp(`\\b(?:${nouns.map(esc).join('|')})s?\\b`, 'gi');
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

/** "Biz hands the key to the Postman": the item leaves the party (group 1: who took it). */
function showsGivenAway(sentence: string, holder: string, nouns: string[], party: string[]): boolean {
  const M = esc(firstName(holder));
  const N = `(?:${nouns.map(esc).join('|')})s?`;
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
export function narratedItemEvents(text: string, party: ItemHolder[], candidates: string[] = []): ItemEvent[] {
  if (!text || party.length === 0) return [];
  const events: ItemEvent[] = [];
  const inv = new Map(party.map(p => [p.name, [...p.inventory]]));
  const holderOf = (item: string) => [...inv].find(([, items]) => items.some(i => sameItem(i, item)))?.[0] ?? null;
  const names = party.map(p => p.name);

  let prev = '';
  for (const sentence of text.split(SENTENCES)) {
    const unquoted = quoteRuns(sentence).filter(r => !r.quoted).map(r => r.text).join(' ');
    const held = [...inv].flatMap(([owner, items]) => items.map(item => ({ owner, item })));
    const all = [...held.map(h => h.item), ...candidates.filter(c => !held.some(h => sameItem(h.item, c)))];
    const pool = all.filter((c, i) => all.findIndex(o => sameItem(o, c)) === i);
    const byNoun = (item: string) => pool.filter(o => itemNouns(o).some(n => itemNouns(item).includes(n)));
    // "the Fading Form" when the world also has a Recall Form: its whole name picks it out.
    const namedIn = (t: string, item: string) => { const f = fullItemName(item); return f.includes(' ') && new RegExp(`\\b${esc(f)}\\b`, 'i').test(t); };
    const unambiguous = (item: string, t: string) => byNoun(item).length === 1 || (namedIn(t, item) && byNoun(item).filter(o => namedIn(t, o)).length === 1);
    // The items a stretch of prose names (by whole name, or by a noun only one item has).
    const mentions = (t: string) => pool.filter(o => namedIn(t, o) || itemNouns(o).some(n => new RegExp(`\\b${esc(n)}s?\\b`, 'i').test(t)));

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
          if (from) inv.set(from, inv.get(from)!.filter(i => !sameItem(i, item)));
          inv.get(member)!.push(item);
          events.push({ kind: 'gain', to: member, item, from });
          break;
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
      if (showsLoss(sentence, nouns) || showsGivenAway(unquoted, owner, nouns, names) || showsTakenByOther(unquoted, prev, owner, nouns, names, mentions, item)) {
        inv.set(owner, inv.get(owner)!.filter(i => i !== item));
        events.push({ kind: 'loss', from: owner, item });
      }
    }
    prev = unquoted;
  }
  return events;
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
        && new RegExp(`^\\s+(?:up\\s+)?${DET}${ADJS}(?:${nouns.map(esc).join('|')})s?\\b`, 'i').test(after);
    });
    for (const c of named) if (!out.some(o => sameItem(o, c))) out.push(c);
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
  const N = `(?:${nouns.map(esc).join('|')})s?`;
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
  const m = sentence.match(new RegExp(`\\b${esc(firstName(member))}\\s+(?:\\w+ly\\s+)?${SELF_TAKE}\\s+it\\b`, 'i'));
  if (!m) return false;
  const named = mentions(sentence.slice(0, m.index));
  return named.length === 1 && sameItem(named[0]!, item);
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
function storyUnits(text: string): string[] {
  const pieces = text.split(/(?<=[.!?…]["”’']?)\s+/);
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
    const kept = storyUnits(p.trim()).filter(u => {
      const words = beatWords(u);
      if (words.length < 6) return true;
      const repeated = beatOverlap(u, earlier) >= coverage || longestSharedRun(words, earlierWords) >= runLen;
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
const SWEEP: Record<string, string> = { eat: 'sweep', eats: 'sweeps', eating: 'sweeping', ate: 'swept', eaten: 'swept', devour: 'sweep', devours: 'sweeps', devouring: 'sweeping', devoured: 'swept', gobble: 'sweep', gobbles: 'sweeps', gobbling: 'sweeping', gobbled: 'swept' };
const CHILD_SOFTENERS: Array<[RegExp, string | ((...args: string[]) => string)]> = [
  [/\bnooses\b/gi, 'tangles of rope'],
  [/\bnoose\b/gi, 'tangle of rope'],
  [/\b(a|the)\s+bones?\s+(?:cracking|snapping|breaking|splintering)\b/gi, '$1 twig snapping'],
  [/\bbone[- ](?:cracking|snapping|breaking|shattering)\b/gi, 'twig-snapping'],
  [/\blike a brand\b/gi, 'like a warm coin'],
  [/\ba terrifying\b/gi, 'an unnerving'],
  [/\bterrifying\b/gi, 'unnerving'],
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
  // "before the crowd eats us" → "before the crowd sweeps us away"
  // People only, and only as the whole object: "eat them" (the cookies) and
  // "eat her sandwich" are left alone.
  [/\b(eat|eats|eating|ate|eaten|devour|devours|devouring|devoured|gobble|gobbles|gobbling|gobbled)(?:\s+up)?\s+(us|you|me|her|him)(?:\s+(?:alive|whole|up))?(?=\s*(?:[.,!?;:…"”’')—–]|$)|\s+(?:before|if|unless|and|or|too|first|next|now)\b)/gi,
    (_m: string, verb: string, who: string) => `${SWEEP[verb.toLowerCase()] ?? 'sweep'} ${who} away`],
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

export function bleakEnding(text: string): boolean {
  return !!text && BLEAK.test(text);
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
  const parts: string[] = [];
  if (quotes.length > 0) parts.push(`Lines of dialogue already spoken — do not repeat them, or have anyone echo them, word for word; NPCs say something new:\n${quotes.slice(-6).map(q => `- "${q}"`).join('\n')}`);
  if (overused.length > 0) parts.push(`Words you keep reaching for — do not repeat them; find fresh sensory detail: ${overused.join(', ')}.`);
  return parts.join('\n');
}
