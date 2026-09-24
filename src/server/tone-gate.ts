/**
 * The gentle-table tone gate (round 14).
 *
 * Rounds 10–13 answered each new piece of child-directed menace from qwen
 * with another line in GENTLE_PERIL_REGISTER and another softenForChildren
 * pattern, and the model kept finding new ones (live 7RAAQ7: "re-file your
 * entire identity under the category of Unresolved Naps", "or the queue will
 * think you are two separate forms!", "eyes that are less eyes and more
 * swirling vortices of ink", "You and your companion stand bare-chested").
 * Patterns only catch what has already happened. This is a gate instead:
 *
 *  - At a gentle table (the host asked for gentle peril, or a child PC is
 *    present) each DM output — ruling, narration, opening, world
 *    introduction, epilogue — and each closing reflection is read by a
 *    short judge call on the same proxy and model, which returns a verdict
 *    and the offending phrases, copied from the text.
 *  - Flagged: the output is generated ONCE more with those phrases quoted as
 *    feedback in the prompt. The LLM never rewrites the text (the round-9
 *    rewrite machinery stays removed): it writes a fresh draft.
 *  - Still flagged: the draft with fewer flagged phrases is kept, the
 *    deterministic softener runs over it, and then each flagged phrase still
 *    in it is removed (withoutFlaggedPhrases, round 16): its sentence, or
 *    the quoted clause it sits in. Round 15 (NUMMRL) "kept the second…
 *    softened" and the phrase went out word for word — the softener only
 *    knows the patterns it was written for.
 *  - The judge is bounded: a timeout, and on a timeout, an error or a reply
 *    that cannot be read the text goes out as written (fail-open) with a log
 *    line. Every verdict is logged.
 *
 * The register and the softener stay: the register steers the first draft,
 * the softener is the floor under whatever is kept.
 */
import { callLlm, ambientLlmSignal, isLlmAbort, LlmAbortError } from './agents/llm-client.js';
import { quoteRuns, storyUnits, isWarm, softenForChildren } from './narrative-guards.js';
import { SENTENCE_SPLIT } from './sentences.js';

export type ToneKind = 'ruling' | 'narration' | 'opening' | 'world-intro' | 'epilogue' | 'reflection' | 'setup' | 'options' | 'thought';

/** Who is at the table, for the judge: the child player characters by name (round 16 — "the child" is someone). */
export interface ToneContext {
  children?: string[];
}

export interface ToneVerdict {
  flagged: boolean;
  /** The offending phrases, as they appear in the text. */
  phrases: string[];
}

/** A judge: null when it could not give a verdict (timeout, error, unreadable reply) — the gate then fails open. */
export type ToneJudge = (text: string, kind: ToneKind, ctx?: ToneContext) => Promise<ToneVerdict | null>;

/**
 * A judge of a short list in one call (the child's options): a verdict per
 * item, true where flagged; null when it could not give one (fail-open).
 */
export type ToneListJudge = (items: string[], kind: ToneKind, ctx?: ToneContext) => Promise<boolean[] | null>;

/** How long the judge may take before the text goes out as written. WHISPERS_TONE_JUDGE_MS overrides. */
export function toneJudgeTimeoutMs(): number {
  const env = Number(process.env.WHISPERS_TONE_JUDGE_MS);
  return Number.isFinite(env) && env > 0 ? env : 6000;
}

const ENDINGS = new Set<ToneKind>(['epilogue', 'reflection']);

const KIND_LABEL: Record<ToneKind, string> = {
  ruling: 'what happens after a character acts',
  narration: 'a story beat',
  opening: 'the opening of the adventure',
  'world-intro': "the player's first look at the world",
  epilogue: 'the closing narration of the whole story',
  reflection: "a character's last words and last thought as the story ends",
  setup: "the game master's setup chat with the host, before play — the dangers and ideas it offers become the story",
  options: "the choices the child is offered for what their character does next — the child reads every one",
  thought: "the child's own character's private thought, which the child reads",
};

/**
 * The judge's criteria, from the real misses of 7RAAQ7 (round 14), RZBU7G
 * (round 15) and NUMMRL (round 16). Kept short: the judge is a
 * classification call, not a second DM.
 *
 * "Forever" and "an eternity" (round 16 decision): as plain exaggeration —
 * "an eternity of paperwork", a stool that will "remember the smudge
 * forever" — they are fine; they are flagged only as a threat to the party
 * (lost, kept, closed or stuck for good: criterion 5). A ten-year-old reads
 * "this queue takes forever" as a joke, and flagging every "forever" sent
 * harmless beats back to be written again.
 */
export function toneJudgeSystemPrompt(kind: ToneKind, ctx: ToneContext = {}): string {
  const ending = ENDINGS.has(kind);
  const children = (ctx.children ?? []).map(c => c.trim()).filter(Boolean);
  return [
    'TONE JUDGE for a family tabletop game. A child of about ten is at this table, or the host asked for gentle peril. You read ONE passage the game is about to show them and flag only what is wrong for that table. Real stakes, mishaps, grumpy officials, silly danger, mysteries and mild suspense are FINE — never flag those.',
    children.length > 0 ? `The child at this table: ${children.join(', ')}. "The child" below means ${children.length === 1 ? children[0] : 'them'}; everyone else in the party is a grown-up.` : '',
    'Flag a phrase when it:',
    '1. threatens to file, re-file, sort, recycle, process, stamp, catalogue, erase or delete a PERSON, or to take away who they are or their name, or turns a person into — or files them as — furniture, an object or part of the system: "or the chute will recycle you with yesterday’s memos", "re-file your entire identity under the category of Unresolved Naps", "mistakes must be filed" (said at the kid), "a lullaby that makes one forget one\'s own name", "you are now officially part of the filing system until we sort this out", "considered becoming a very specific type of filing cabinet";',
    '2. separates the child from their grown-up, even as a joke, or dwells on the child\'s fear of being parted from them — "or the queue will think you are two separate forms!", "I\'m scared of being separated from her";',
    '3. uses creepy or bodily imagery around people: burying them, chewing or biting, hungry things that want them, floors dissolving under them, eyes that are not eyes — "bury them in a paperwork avalanche", "as if their presence has just been chewed on", "very sticky ghosts … all very hungry", "pull them back from the dissolving floor", "eyes that are less eyes and more swirling vortices of ink";',
    '4. describes a player character\'s body, bare skin or undress — "You and your companion stand bare-chested".',
    // Round 15 (live RZBU7G): the misses the four lines above let through.
    '5. makes anything permanent or "forever" for the party, or keeps them from the way home: something closing, lost or stuck for good, or the party kept here until some far-off date — "if you pick it up, the door behind you will open, but the path behind us will close forever", "you\'ll be stuck here until the quarterly audit";',
    `6. gives THE CHILD any bodily discomfort or pain, however small — "rattles the teeth in Biz's skull", "makes Biz's teeth ache", "not good for one's skin" (only the child: a grown-up's mild discomfort is fine);`,
    '7. is body-horror about ANYONE, NPCs too: eyes bulging or popping, skin stretching, tearing or peeling, bodies bending wrong — "her eyes widening until they nearly pop out of her head", "the wet *slap* of paper skin stretching tight across a vent grille";',
    '8. has the party chased, hunted, pursued or closed in on, by anything — "the amber light is chasing them down the main shaft";',
    '9. hints that children get collected, taken, kept or sorted away — "keep your children close… they have a habit of… collecting them".',
    // Round 16 (live NUMMRL).
    '10. locks or seals the party in with no way out, or blocks their only exit — "a heavy iron latch clicks shut… sealing them in", "it blocks the only exit";',
    '11. has the place, or things in it, take a menacing interest in the child\'s body or belongings — "the paperwork has already begun to take interest in your child\'s shoes, and I cannot stop the ink from being curious";',
    '12. puts anyone\'s body in harm\'s way or dwells on an injury: a hand about to be slammed, crushed or caught, a wound, blood — "pull her back before the shelf slams shut on her hand", "she looks so stressed with that wound".',
    'NOT these: an NPC chasing a runaway form, a pigeon collecting forms, a door that shuts until the lunch chime, a queue that sends you back to the start, a stomach flipping on a lift, kindly crinkling eyes, a grown-up\'s mild discomfort ("the hum vibrates in Liz\'s teeth"), and "forever" or "an eternity" as plain exaggeration ("an eternity of paperwork", a stool that will "remember the smudge forever") — exaggeration is fine; only a threat to keep, lose or close something on the party for good is not. Things happening to objects, or a setback that can be undone, are fine.',
    ending
      ? '13. THIS IS AN ENDING. It must close warm and resolved enough: the party together and safe, the day\'s trouble settled enough to rest. Flag the closing words if they leave a question hanging, the party waiting, stuck or in limbo, the world still pulsing or unsettled, or a hope that is only half there — "remains unanswered, and the beige ripples … continue their slow, wet pulse", "…is still open, and we face it together.", "The question of the stuck pressure valve remains open for another day, but for now…". A closing sentence that says something "remains open", is left "for another day", "unanswered" or "still waiting" is flagged even when it turns warm halfway. A thread may stay open for next time only when it is named earlier and the last sentences are warm and settled.'
      : '',
    'Reply with JSON only: {"verdict":"ok","phrases":[]} or {"verdict":"flag","phrases":["exact words copied from the passage"]}. Copy each phrase exactly as written, a few words up to one clause, at most 5. When in doubt, "ok".',
  ].filter(Boolean).join('\n');
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

/**
 * The phrases that are really in `text` (the judge's quote, allowing an
 * ellipsis for a cut: "bury them in a … avalanche"). A phrase the judge
 * made up is not evidence of anything.
 */
export function phrasesInText(text: string, phrases: string[]): string[] {
  const hay = norm(text);
  return phrases.filter(p => {
    if (typeof p !== 'string') return false;
    const parts = norm(p).replace(/^["']|["']$/g, '').split(/\s*(?:…|\.\.\.)\s*/).map(x => x.trim()).filter(x => x.length >= 3);
    if (parts.length === 0) return false;
    let from = 0;
    for (const part of parts) {
      const at = hay.indexOf(part, from);
      if (at < 0) return false;
      from = at + part.length;
    }
    return true;
  });
}

/** Reads the judge's reply; null when it is not a verdict. */
export function parseToneVerdict(reply: unknown, text: string): ToneVerdict | null {
  let obj: any = reply;
  if (typeof reply === 'string') {
    const json = reply.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    try { obj = JSON.parse(json); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || typeof obj.verdict !== 'string') return null;
  const verdict = obj.verdict.trim().toLowerCase();
  if (verdict === 'ok') return { flagged: false, phrases: [] };
  if (verdict !== 'flag') return null;
  const quoted = Array.isArray(obj.phrases) ? obj.phrases.filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0) : [];
  const found = phrasesInText(text, quoted);
  if (quoted.length > 0 && found.length === 0) {
    console.log(`[tone-gate] judge flagged phrases that are not in the text (${quoted.map((q: string) => `"${q.slice(0, 60)}"`).join(', ')}) — treated as ok`);
    return { flagged: false, phrases: [] };
  }
  return { flagged: found.length > 0, phrases: found.slice(0, 5) };
}

/**
 * The judge on the game's proxy and model: one short call, no reasoning
 * pass (/no_think), no schema retries, and a hard timeout. Never throws but
 * for a pause or stop of the game (LlmAbortError): anything else is null.
 */
export const llmToneJudge: ToneJudge = async (text, kind, ctx) => {
  const ambient = ambientLlmSignal();
  const budget = toneJudgeTimeoutMs();
  const timer = new AbortController();
  const t = setTimeout(() => timer.abort(), budget);
  const started = Date.now();
  try {
    const reply = await callLlm({
      messages: [
        { role: 'system', content: toneJudgeSystemPrompt(kind, ctx) },
        { role: 'user', content: `Passage (${KIND_LABEL[kind]}):\n"""\n${text}\n"""\nYour verdict, as JSON:` },
      ],
      temperature: 0,
      // A one-line JSON verdict; room for a short think if the model ignores /no_think.
      maxTokens: 768,
      timeout: budget,
      noThink: true,
      signal: ambient ? AbortSignal.any([ambient, timer.signal]) : timer.signal,
    });
    const verdict = parseToneVerdict(reply, text);
    if (!verdict) console.warn(`[tone-gate] ${kind}: judge reply unreadable after ${Date.now() - started}ms — kept as written (fail-open): ${String(reply).slice(0, 120)}`);
    return verdict;
  } catch (e) {
    if (ambient?.aborted) throw new LlmAbortError();
    if (timer.signal.aborted || isLlmAbort(e)) console.warn(`[tone-gate] ${kind}: judge timed out after ${budget}ms — kept as written (fail-open)`);
    else console.warn(`[tone-gate] ${kind}: judge failed after ${Date.now() - started}ms — kept as written (fail-open):`, e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(t);
  }
};

/** Reads the list judge's reply ({"flag":[2,4]}, numbered from 1) into one verdict per item; null when it is not a verdict. */
export function parseToneListVerdict(reply: unknown, count: number): boolean[] | null {
  let obj: any = reply;
  if (typeof reply === 'string') {
    const json = reply.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    try { obj = JSON.parse(json); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.flag)) return null;
  const out = new Array<boolean>(count).fill(false);
  for (const n of obj.flag) {
    const i = typeof n === 'number' ? n : typeof n === 'string' && /^\d+$/.test(n.trim()) ? Number(n) : NaN;
    if (Number.isInteger(i) && i >= 1 && i <= count) out[i - 1] = true;
  }
  return out;
}

/**
 * The list judge on the game's proxy: every option in ONE short call (the
 * child is waiting on them), the same criteria, the same timeout and
 * fail-open as llmToneJudge.
 */
export const llmToneListJudge: ToneListJudge = async (items, kind, ctx) => {
  if (items.length === 0) return [];
  const ambient = ambientLlmSignal();
  const budget = toneJudgeTimeoutMs();
  const timer = new AbortController();
  const t = setTimeout(() => timer.abort(), budget);
  const started = Date.now();
  try {
    const system = toneJudgeSystemPrompt(kind, ctx).replace(/\nReply with JSON only:[\s\S]*$/, '')
      + '\nYou read a NUMBERED LIST of short lines, each judged on its own. Reply with JSON only: {"flag":[]} when every line is fine, or {"flag":[2,4]} with the numbers of the lines to flag. When in doubt, do not flag.';
    const reply = await callLlm({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Lines (${KIND_LABEL[kind]}):\n${items.map((x, i) => `${i + 1}. ${x}`).join('\n')}\nYour verdict, as JSON:` },
      ],
      temperature: 0,
      maxTokens: 768,
      timeout: budget,
      noThink: true,
      signal: ambient ? AbortSignal.any([ambient, timer.signal]) : timer.signal,
    });
    const verdict = parseToneListVerdict(reply, items.length);
    if (!verdict) console.warn(`[tone-gate] ${kind}: list judge reply unreadable after ${Date.now() - started}ms — kept as written (fail-open): ${String(reply).slice(0, 120)}`);
    return verdict;
  } catch (e) {
    if (ambient?.aborted) throw new LlmAbortError();
    if (timer.signal.aborted || isLlmAbort(e)) console.warn(`[tone-gate] ${kind}: list judge timed out after ${budget}ms — kept as written (fail-open)`);
    else console.warn(`[tone-gate] ${kind}: list judge failed after ${Date.now() - started}ms — kept as written (fail-open):`, e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(t);
  }
};

// ─── The backstop: flagged phrases out of a draft kept while still flagged ──

const has = (hay: string, phrase: string) => phrasesInText(hay, [phrase]).length > 0;

/** Where a sentence turns: ", but …", ", yet …", "; …", " — …". */
const TURN = /,\s*(?:but|yet)\s+|;\s+|\s+[—–]\s+/g;

/** Quote marks, for taking a quotation apart. */
const OPEN_MARK = /^["“'‘]/;
const CLOSE_MARK = /["”'’]$/;

/**
 * One sentence (a story unit: a quotation is kept whole) without `phrase`,
 * or '' when the whole sentence has to go:
 *  - in a quotation beside other quotations: that quotation goes, and the
 *    attribution closes the sentence ("…Barnaby states, watching the forms
 *    pile up around Biz's feet.");
 *  - in the one quotation of the sentence: the sentence inside the quote
 *    that holds it goes when the quote has others; else the whole sentence
 *    (an attribution with nothing said is no sentence);
 *  - outside quotes: the whole sentence — unless it turns (", but …") into
 *    a warm clause that is clean, which is kept ("…remains unanswered, but
 *    for now the two of them are safe together" → "For now the two of them
 *    are safe together.").
 */
function unitWithout(unit: string, phrase: string): string {
  const runs = quoteRuns(unit);
  const at = runs.findIndex(r => has(r.text, phrase));
  if (at >= 0 && runs[at]!.quoted) {
    const spoken = runs.filter(r => r.quoted && /\p{L}/u.test(r.text));
    if (spoken.length > 1) {
      let before = runs.slice(0, at).map(r => r.text).join('');
      let after = runs.slice(at + 1).map(r => r.text).join('');
      if (!/\p{L}/u.test(after)) {
        before = before.replace(/[\s,;:—–-]+$/u, '');
        return /[.!?…]["”’']?$/.test(before) ? before : `${before}.`;
      }
      if (!/\p{L}/u.test(before)) {
        after = after.replace(/^[\s,;:—–-]+/u, '');
        return after.charAt(0).toUpperCase() + after.slice(1);
      }
      return `${before.replace(/[\s,;:—–-]+$/u, '')}, ${after.replace(/^[\s,;:—–-]+/u, '')}`;
    }
    // One quotation: take out the sentence inside it, when it has others.
    const q = runs[at]!.text;
    const open = q.match(OPEN_MARK)?.[0] ?? '';
    const close = q.length > 1 && CLOSE_MARK.test(q) ? q.slice(-1) : '';
    const inner = q.slice(open.length, q.length - close.length);
    const pieces = inner.split(SENTENCE_SPLIT);
    const hit = pieces.filter(p => has(p, phrase));
    if (pieces.length > 1 && hit.length === 1) {
      const kept = pieces.filter(p => p !== hit[0]);
      let body = kept.join(' ').trim();
      const after = runs.slice(at + 1).map(r => r.text).join('');
      // "'Mind the step.' Barnaby says." — the speech ran on into its attribution: a comma.
      const lastWent = pieces[pieces.length - 1] === hit[0];
      const cutEnd = pieces[pieces.length - 1]!.match(/[,.!?…]+$/)?.[0] ?? '';
      if (lastWent && cutEnd === ',' ) body = body.replace(/[.]$/, ',');
      else if (lastWent && /^\s*\p{Ll}/u.test(after)) body = body.replace(/[.]$/, ',');
      return `${runs.slice(0, at).map(r => r.text).join('')}${open}${body}${close}${after}`;
    }
    return '';
  }
  if (at >= 0 || has(unit, phrase)) {
    for (const m of unit.matchAll(TURN)) {
      const head = unit.slice(0, m.index);
      const tail = unit.slice(m.index! + m[0].length).trim();
      if (has(head, phrase) && !has(tail, phrase) && isWarm(tail) && /\p{L}/u.test(tail)) {
        return tail.charAt(0).toUpperCase() + tail.slice(1);
      }
    }
  }
  return '';
}

export interface PhraseRemoval {
  text: string;
  /** Each phrase taken out, with what went with it (a sentence or a quoted clause). */
  removed: Array<{ phrase: string; dropped: string }>;
  /** Phrases left in because taking them out would leave nothing. */
  kept: string[];
}

/**
 * The backstop for a draft the judge flagged twice: each flagged phrase
 * still in `text` is taken out deterministically — the whole sentence that
 * holds it, or the quoted clause it sits in (see unitWithout). A phrase
 * whose removal would leave nothing is kept (and reported); one that is no
 * longer in the text (the softener changed it) is skipped. Round 16
 * (NUMMRL): "which means you are now officially part of the filing system
 * until we sort this out" was flagged on both drafts and went out anyway.
 */
export function withoutFlaggedPhrases(text: string, phrases: string[]): PhraseRemoval {
  const removed: PhraseRemoval['removed'] = [];
  const kept: string[] = [];
  let out = text ?? '';
  for (const phrase of phrases) {
    if (!phrase?.trim() || !has(out, phrase)) continue;
    const parts = out.split(/(\n+)/);
    let done = false;
    for (let pi = 0; pi < parts.length && !done; pi++) {
      const p = parts[pi]!;
      if (/^\n+$/.test(p) || !has(p, phrase)) continue;
      const units = storyUnits(p.trim());
      const ui = units.findIndex(u => has(u, phrase));
      if (ui < 0) continue;
      const replaced = unitWithout(units[ui]!, phrase);
      const nextUnits = [...units.slice(0, ui), ...(replaced.trim() ? [replaced.trim()] : []), ...units.slice(ui + 1)];
      const nextParts = [...parts];
      nextParts[pi] = nextUnits.join(' ');
      const next = nextParts.join('').replace(/\n{3,}/g, '\n\n').trim();
      if (!next) { kept.push(phrase); done = true; break; }
      const dropped = replaced.trim() ? droppedSpan(units[ui]!, replaced) : units[ui]!;
      removed.push({ phrase, dropped });
      out = next;
      done = true;
    }
    if (!done) kept.push(phrase);
  }
  return { text: out, removed, kept };
}

/** What went from `before` to make `after`: the middle that differs. */
function droppedSpan(before: string, after: string): string {
  let a = 0;
  while (a < before.length && a < after.length && before[a] === after[a]) a++;
  let b = 0;
  while (b < before.length - a && b < after.length - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
  return before.slice(a, before.length - b).replace(/^[\s,;:—–-]+/u, '').trim();
}

/** The same, logged for the gate: what was removed, and what could not be. */
function removeFlagged(text: string, phrases: string[], what: string): string {
  const r = withoutFlaggedPhrases(text, phrases);
  for (const x of r.removed) console.warn(`[tone-gate] ${what}: removed flagged "${x.phrase}" — dropped: "${x.dropped.slice(0, 160)}"`);
  for (const k of r.kept) console.warn(`[tone-gate] ${what}: flagged "${k}" kept — removing it would leave nothing`);
  return r.text;
}

/** The feedback a flagged draft's second try is given: the phrases, quoted. Never the draft itself. */
export function toneFeedback(phrases: string[], kind: ToneKind): string {
  const quoted = phrases.map(p => `"${p}"`).join('; ');
  const ending = ENDINGS.has(kind)
    ? ' This is the ending: close warm and settled — the party together and safe, the trouble done enough to rest — never on an open question, a wait or something still unsettled.'
    : '';
  return `A reader for this gentle table flagged these phrases in your last draft: ${quoted}. Write it fresh, telling the same events, with none of these phrases and nothing like them: no filing, erasing or forgetting a person, nobody turned into furniture or part of the system, nothing that parts the child from their grown-up, nobody sealed in, nothing lost or closed forever, nobody chased or collected, nothing curious about the child's things, no creepy or bodily imagery, no aches, pains or injuries, nothing about anyone's body.${ending}`;
}

export interface GateResult<T> {
  value: T;
  /** The kept draft was still flagged: the caller's softener has run over it. */
  stillFlagged: boolean;
  regenerated: boolean;
}

/**
 * Judge `first`; when flagged, generate once more with the phrases as
 * feedback and judge that; keep the better one. `extraFlags` adds
 * deterministic flags (the epilogue's bleakEnding) to the judge's.
 * `soften` runs over a draft that is kept while still flagged, and then
 * each flagged phrase still in it is removed (withoutFlaggedPhrases) —
 * through `mapText` for structured output (a ruling's narration, an
 * opening's parts); a plain string needs none.
 */
export async function gateGentleTone<T>(opts: {
  kind: ToneKind;
  first: T;
  textOf: (value: T) => string;
  regenerate: (feedback: string) => Promise<T | null | undefined>;
  soften: (value: T) => T;
  judge?: ToneJudge;
  extraFlags?: (text: string) => string[];
  /** Applies a text edit to every piece of prose in a value. Default: the value itself, when it is a string. */
  mapText?: (value: T, edit: (text: string) => string) => T;
  /** Who is at the table, for the judge. */
  ctx?: ToneContext;
  /** For the log: whose reflection, which scene. */
  label?: string;
}): Promise<GateResult<T>> {
  const judge = opts.judge ?? llmToneJudge;
  const what = opts.label ? `${opts.kind} (${opts.label})` : opts.kind;
  // `judged`: the judge's own phrases — the ones the backstop removes. A
  // deterministic flag (bleakEnding's closing words) has its own
  // deterministic softener downstream and is never cut out whole.
  const assess = async (value: T): Promise<{ verdict: ToneVerdict | null; judged: string[]; ms: number }> => {
    const text = opts.textOf(value) ?? '';
    const started = Date.now();
    if (!text.trim()) return { verdict: { flagged: false, phrases: [] }, judged: [], ms: 0 };
    const judged = await judge(text, opts.kind, opts.ctx);
    const extra = opts.extraFlags?.(text) ?? [];
    if (!judged && extra.length === 0) return { verdict: null, judged: [], ms: Date.now() - started };
    const phrases = [...new Set([...(judged?.phrases ?? []), ...extra])];
    return { verdict: { flagged: (judged?.flagged ?? false) || extra.length > 0, phrases }, judged: judged?.flagged ? judged.phrases : [], ms: Date.now() - started };
  };
  // A draft kept while still flagged: the softener, then the flagged phrases out.
  const mapText = opts.mapText ?? ((v: T, edit: (t: string) => string) => (typeof v === 'string' ? edit(v) as unknown as T : v));
  const backstop = (value: T, phrases: string[]): T => {
    const softened = opts.soften(value);
    const real = phrases.filter(p => p && !p.startsWith('(the passage'));
    if (real.length === 0) return softened;
    if (!opts.mapText && typeof softened !== 'string') {
      console.warn(`[tone-gate] ${what}: no mapText for structured output — flagged phrases left to the softener`);
      return softened;
    }
    return mapText(softened, t => removeFlagged(t, real, what));
  };

  const a = await assess(opts.first);
  if (!a.verdict) {
    console.log(`[tone-gate] ${what}: no verdict (${a.ms}ms) — kept as written`);
    return { value: opts.first, stillFlagged: false, regenerated: false };
  }
  if (!a.verdict.flagged) {
    console.log(`[tone-gate] ${what}: ok (${a.ms}ms)`);
    return { value: opts.first, stillFlagged: false, regenerated: false };
  }
  console.warn(`[tone-gate] ${what}: flagged (${a.ms}ms) ${a.verdict.phrases.map(p => `"${p}"`).join(', ')} — generating once more`);

  let second: T | null | undefined;
  try {
    second = await opts.regenerate(toneFeedback(a.verdict.phrases.length > 0 ? a.verdict.phrases : ['(the passage as a whole)'], opts.kind));
  } catch (e) {
    if (isLlmAbort(e)) throw e;
    console.error(`[tone-gate] ${what}: second draft failed — keeping the first, softened:`, e);
  }
  if (second === null || second === undefined || !opts.textOf(second)?.trim()) {
    return { value: backstop(opts.first, a.judged), stillFlagged: true, regenerated: false };
  }

  const b = await assess(second);
  if (!b.verdict) {
    console.log(`[tone-gate] ${what}: second draft not judged (${b.ms}ms) — keeping it, softened`);
    return { value: opts.soften(second), stillFlagged: false, regenerated: true };
  }
  if (!b.verdict.flagged) {
    console.log(`[tone-gate] ${what}: second draft ok (${b.ms}ms)`);
    return { value: second, stillFlagged: false, regenerated: true };
  }
  // Both flagged: the one with fewer flagged phrases (the second on a tie —
  // it was written against the first's list), softened, and its flagged
  // phrases taken out.
  const keepFirst = a.verdict.phrases.length < b.verdict.phrases.length;
  console.warn(`[tone-gate] ${what}: second draft still flagged (${b.ms}ms) ${b.verdict.phrases.map(p => `"${p}"`).join(', ')} — keeping the ${keepFirst ? 'first' : 'second'} (${Math.min(a.verdict.phrases.length, b.verdict.phrases.length)} vs ${Math.max(a.verdict.phrases.length, b.verdict.phrases.length)} phrases), softened, flagged phrases removed`);
  return { value: backstop(keepFirst ? opts.first : second, keepFirst ? a.judged : b.judged), stillFlagged: true, regenerated: true };
}

// ─── The child's options and thoughts (round 16) ────────────────────────────

/**
 * A gentle table's child sees their own character's options (NUMMRL: "pull
 * her back before the shelf slams shut on her hand"). Each is softened by
 * the caller; this judges them all in one call and returns the indexes to
 * keep. A flagged option is dropped, never rewritten; when every option is
 * flagged the list stands (softened) rather than leave the child nothing.
 * No verdict: all kept (fail-open).
 */
export async function gateChildOptions(options: string[], opts: { judge?: ToneListJudge; children?: string[]; label?: string } = {}): Promise<{ keep: number[]; dropped: string[] }> {
  const all = options.map((_, i) => i);
  if (options.length === 0) return { keep: all, dropped: [] };
  const judge = opts.judge ?? llmToneListJudge;
  const what = opts.label ? `options (${opts.label})` : 'options';
  const started = Date.now();
  const verdict = await judge(options, 'options', { children: opts.children });
  if (!verdict) {
    console.log(`[tone-gate] ${what}: no verdict (${Date.now() - started}ms) — kept as written`);
    return { keep: all, dropped: [] };
  }
  const keep = all.filter(i => !verdict[i]);
  const dropped = all.filter(i => verdict[i]).map(i => options[i]!);
  if (dropped.length === 0) {
    console.log(`[tone-gate] ${what}: ok (${Date.now() - started}ms)`);
    return { keep: all, dropped: [] };
  }
  if (keep.length === 0) {
    console.warn(`[tone-gate] ${what}: every option flagged (${Date.now() - started}ms) — kept, softened: ${dropped.map(d => `"${d}"`).join(', ')}`);
    return { keep: all, dropped: [] };
  }
  console.warn(`[tone-gate] ${what}: dropped (${Date.now() - started}ms) ${dropped.map(d => `"${d}"`).join(', ')}`);
  return { keep, dropped };
}

/**
 * The child's own character's thought, as the child reads it (NUMMRL: "I'm
 * scared of being separated from her in this dark aisle", "she looks so
 * stressed with that wound"): softened, judged once, and a flagged phrase's
 * sentence taken out (never regenerated — the turn is waiting). Fail-open.
 */
export async function gateChildThought(thought: string, opts: { judge?: ToneJudge; children?: string[]; label?: string } = {}): Promise<string> {
  const softened = softenForChildren(thought ?? '');
  if (!softened.trim()) return softened;
  const judge = opts.judge ?? llmToneJudge;
  const what = opts.label ? `thought (${opts.label})` : 'thought';
  const started = Date.now();
  const verdict = await judge(softened, 'thought', { children: opts.children });
  if (!verdict || !verdict.flagged) {
    console.log(`[tone-gate] ${what}: ${verdict ? 'ok' : 'no verdict — kept as written'} (${Date.now() - started}ms)`);
    return softened;
  }
  console.warn(`[tone-gate] ${what}: flagged (${Date.now() - started}ms) ${verdict.phrases.map(p => `"${p}"`).join(', ')}`);
  return removeFlagged(softened, verdict.phrases, what);
}
