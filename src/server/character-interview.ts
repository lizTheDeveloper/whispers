import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CharacterDefinition, CharacterReadiness } from '../shared/types.js';
import { beatOverlap } from './narrative-guards.js';

export type InterviewStatus = 'open' | 'confirmed' | 'live' | 'revoked';

export interface InterviewTurn { role: string; content: string }

export interface InterviewRecord {
  id: string;
  campaignId: string;
  sessionToken: string;
  transcript: InterviewTurn[];
  definition: CharacterDefinition | null;
  /**
   * The sheet so far — every field the player has stated, merged turn by
   * turn. Unlike `definition` it may be unfinished; it is what the checklist
   * and the interviewer's "still needed" list are computed from.
   */
  draft: CharacterDefinition | null;
  status: InterviewStatus;
}

function parseTranscript(raw: unknown, id: string): InterviewTurn[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is InterviewTurn =>
      Boolean(t) && typeof t === 'object' && typeof t.role === 'string' && typeof t.content === 'string');
  } catch {
    console.warn(`[interview] corrupt transcript JSON for interview ${id}`);
    return [];
  }
}

function parseDefinition(raw: unknown, id: string, column: string): CharacterDefinition | null {
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw); }
  catch { console.warn(`[interview] corrupt ${column} JSON for interview ${id}`); return null; }
}

function rowToRecord(row: any): InterviewRecord {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    sessionToken: row.session_token,
    transcript: parseTranscript(row.transcript, row.id),
    definition: parseDefinition(row.definition, row.id, 'definition'),
    draft: parseDefinition(row.draft, row.id, 'draft'),
    status: row.status,
  };
}

/**
 * One interview per player per campaign, keyed on the durable session token.
 *
 * The transcript lived in process memory until now, so a browser refresh threw
 * away the whole conversation. It is also worth keeping for its own sake: the
 * raw answers say things about a character that the derived sheet does not.
 *
 * This does a read then a conditional write, same shape as appendInterviewTurn
 * below — see that function's docstring for why it is safe here too.
 */
export function getOrCreateInterview(db: Database.Database, campaignId: string, sessionToken: string): InterviewRecord {
  const existing = getInterviewBySession(db, campaignId, sessionToken);
  if (existing) return existing;
  const id = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO character_interviews (id, campaign_id, session_token) VALUES (?, ?, ?)')
    .run(id, campaignId, sessionToken);
  return { id, campaignId, sessionToken, transcript: [], definition: null, draft: null, status: 'open' };
}

export function getInterviewBySession(db: Database.Database, campaignId: string, sessionToken: string): InterviewRecord | null {
  const row = db.prepare('SELECT * FROM character_interviews WHERE campaign_id = ? AND session_token = ?')
    .get(campaignId, sessionToken) as any;
  return row ? rowToRecord(row) : null;
}

/**
 * Reads the transcript, appends one turn, writes it back — a read-modify-write
 * with no locking around it. That is safe only because better-sqlite3 is fully
 * synchronous and this function never awaits: once called, it runs to
 * completion before Node processes anything else, so no other message handler
 * can interleave a read or write in between. This is a different situation from
 * the races this project already fixed (advancePhaseIfLobby, room.ts;
 * setWorldSeedIfNotAccepted, world-seed.ts) — those had an `await` sitting
 * between the read and the write, which is what let a second call interleave.
 * If this function (or getOrCreateInterview above) ever becomes internally
 * async, or this service ever runs as more than one process against the same
 * database file, that guarantee breaks and this needs real locking.
 */
export function appendInterviewTurn(db: Database.Database, id: string, turn: InterviewTurn): void {
  const row = db.prepare('SELECT transcript FROM character_interviews WHERE id = ?').get(id) as any;
  if (!row) return;
  const transcript = parseTranscript(row.transcript, id);
  transcript.push(turn);
  db.prepare("UPDATE character_interviews SET transcript = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(transcript), id);
}

/**
 * Every call here means "the interview just derived a (possibly new) sheet" —
 * so it always resets status back to 'open'. Without this, confirming once
 * would stay confirmed forever: a player can keep talking after confirming
 * (they are allowed to change their mind), the model derives a different
 * ready sheet, and that new sheet must require its own confirmation rather
 * than silently inheriting the old confirmation.
 */
export function setInterviewDefinition(db: Database.Database, id: string, definition: CharacterDefinition | null): void {
  // The running draft follows the finished sheet: it continues from it, and
  // clearing the sheet clears the draft with it.
  const json = definition ? JSON.stringify(definition) : null;
  db.prepare("UPDATE character_interviews SET definition = ?, draft = ?, status = 'open', updated_at = datetime('now') WHERE id = ?")
    .run(json, json, id);
}

export function setInterviewDraft(db: Database.Database, id: string, draft: CharacterDefinition): void {
  db.prepare("UPDATE character_interviews SET draft = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(draft), id);
}

/** The sheet as it stands: the running draft, else the last finished sheet. */
export function interviewSheet(interview: InterviewRecord | null): CharacterDefinition | null {
  return interview?.draft ?? interview?.definition ?? null;
}

const hasText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * Fold one interview turn's reported sheet into the draft so far. The model
 * reports the whole sheet as it understands it, so a field it filled in
 * replaces the old value and a field it left empty keeps it — a stated name
 * is never lost because a later reply only asked a question.
 */
export function mergeCharacterDraft(base: Partial<CharacterDefinition> | null, update: Partial<CharacterDefinition> | null): CharacterDefinition {
  const b = base ?? {};
  const u = update ?? {};
  const text = (k: 'name' | 'highConcept' | 'trouble' | 'personality' | 'backstory') =>
    hasText(u[k]) ? u[k]!.trim() : (hasText(b[k]) ? b[k]! : '');
  const list = (k: 'aspects' | 'stunts') => {
    const next = Array.isArray(u[k]) ? u[k]!.filter(hasText) : [];
    return next.length > 0 ? next : (Array.isArray(b[k]) ? b[k]! : []);
  };
  const skills = u.skills && Object.keys(u.skills).length > 0 ? u.skills : (b.skills ?? {});
  const merged: CharacterDefinition = {
    name: text('name'),
    highConcept: text('highConcept'),
    trouble: text('trouble'),
    aspects: list('aspects'),
    personality: text('personality'),
    backstory: text('backstory'),
    skills,
    stunts: list('stunts'),
  };
  const age = u.age ?? b.age;
  if (age !== undefined) merged.age = age;
  const pronouns = u.pronouns ?? b.pronouns;
  if (pronouns !== undefined) merged.pronouns = pronouns;
  const relationships = u.relationships && u.relationships.length > 0 ? mergeRelationships(b.relationships ?? [], u.relationships) : b.relationships;
  if (relationships && relationships.length > 0) merged.relationships = relationships;
  return merged;
}

type Relationship = NonNullable<CharacterDefinition['relationships']>[number];

const sameFirst = (a: string, b: string) => a.trim().split(/\s+/)[0]?.toLowerCase() === b.trim().split(/\s+/)[0]?.toLowerCase();

/**
 * The model reports the relationships it understands this turn; an address
 * term stated earlier is kept when this turn's entry for the same person
 * leaves it out. Live: "calls Liz Mom" was on the sheet, then gone.
 */
function mergeRelationships(base: Relationship[], update: Relationship[]): Relationship[] {
  return withoutSelfAddress(update.map(r => {
    if (r.address?.trim()) return r;
    const before = base.find(o => sameFirst(o.to, r.to) && o.address?.trim());
    return before ? { ...r, address: before.address } : r;
  }));
}

/** Kin words a player uses as an address term, and the relation each implies. */
const ADDRESS_RELATION: Array<[RegExp, string]> = [
  [/^(?:mom|mommy|mum|mummy|mama|ma|mother)$/i, 'mother'],
  [/^(?:dad|daddy|papa|pa|pop|father)$/i, 'father'],
  [/^(?:grandma|granny|nana|gran)$/i, 'grandmother'],
  [/^(?:grandpa|granddad|grandad|gramps)$/i, 'grandfather'],
  [/^(?:sis)$/i, 'sister'],
  [/^(?:bro)$/i, 'brother'],
  [/^(?:auntie|aunt)$/i, 'aunt'],
  [/^(?:uncle)$/i, 'uncle'],
];

const TERM = String.raw`["“'‘]?([A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*)?)["”'’]?`;

/** Address words that name a parent, and relation words that make the other person this character's child. */
const PARENT_ADDRESS = /^(?:mom|mommy|mum|mummy|mama|ma|mother|dad|daddy|papa|pa|pop|father|grandma|granny|nana|gran|grandpa|granddad|grandad|gramps)$/i;
const CHILD_ADDRESS = /^(?:son|sonny|daughter|kiddo|kid|junior|baby|sweetie)$/i;
const CHILD_TIE = /\b(?:child|kid|son|daughter|stepchild|stepson|stepdaughter|grandchild|grandson|granddaughter|toddler|baby)\b/i;
const PARENT_TIE = /\b(?:mother|mom|mum|mama|father|dad|papa|parent|stepmother|stepfather|stepparent|grandmother|grandfather|grandparent)\b/i;

/**
 * Would this address term, on X's tie to Y, describe X rather than Y? "Mom"
 * on Liz's tie to Biz, when that tie says Biz is Liz's kid: Liz is the mom,
 * and it is Biz who says "Mom". Live, Liz then said "Good job, Mom." to Biz.
 */
export function addressDescribesSelf(relation: string | undefined, address: string | undefined): boolean {
  const a = address?.trim();
  if (!a) return false;
  const r = relation ?? '';
  return (PARENT_ADDRESS.test(a) && CHILD_TIE.test(r)) || (CHILD_ADDRESS.test(a) && PARENT_TIE.test(r));
}

/** A sheet's ties without any address term that describes the character themself (see addressDescribesSelf). */
export function withoutSelfAddress(rels: Relationship[]): Relationship[] {
  if (!rels.some(r => addressDescribesSelf(r.relation, r.address))) return rels;
  return rels.map(r => {
    if (!addressDescribesSelf(r.relation, r.address)) return r;
    console.warn(`[interview] dropped address "${r.address}" on the tie to ${r.to} (${r.relation}): it is what ${r.to} calls this character, not the other way round`);
    const { address: _a, ...rest } = r;
    return rest as Relationship;
  });
}

/**
 * Address terms the player states outright in their own message, for THIS
 * character's sheet: what this character calls someone. "calls Liz Mom"
 * with no one else as the subject ("Please keep 'calls Liz Mom' on the
 * sheet", in Biz's interview), "Biz calls her Mom" and "Biz calls me Mom" in
 * Biz's own interview. Each is { to, address }, where `to` is someone at the
 * table or on the sheet. "her"/"him"/"them" resolve only when one person is
 * meant: the sheet's single tie, else the table's single other character.
 *
 * The address belongs to the one who SAYS it. In Liz's interview, "Her kid
 * Biz calls her Mom", "Biz calls me Mom" and "my kid calls me Mom" are what
 * Biz calls Liz — Biz's sheet, not Liz's — and are left out. Live, that line
 * put "Mom" on Liz's tie to Biz and Liz said "Good job, Mom." to her kid.
 */
export function statedAddressTerms(text: string, ctx: { characterName: string; playerName: string; tableNames: string[]; relationships: Relationship[] }): Array<{ to: string; address: string }> {
  if (!text) return [];
  const known = [...new Set([...ctx.tableNames, ...ctx.relationships.map(r => r.to)].map(n => n.trim()).filter(n => n && !sameFirst(n, ctx.characterName || '\u0000')))];
  const findKnown = (word: string) => known.find(n => sameFirst(n, word));
  const out: Array<{ to: string; address: string }> = [];
  const add = (to: string | undefined, address: string) => {
    const a = address.trim().replace(/["”'’]+$/, '');
    if (!to || !a || sameFirst(a, to) || /^(?:I|Me|You|Him|Her|Them|The|A|An)$/.test(a)) return;
    if (!out.some(o => sameFirst(o.to, to))) out.push({ to, address: a });
  };
  const re = new RegExp(String.raw`\bcall(?:s|ed|ing)?\s+(?:(me|her|him|them)|([A-Z][\w'’-]*))\s+${TERM}`, 'g');
  for (const m of text.matchAll(re)) {
    const [, pronoun, name, term] = m;
    // Who is doing the calling: the words just before "calls" in this sentence.
    const before = text.slice(0, m.index).split(/[.!?;\n]/).pop() ?? '';
    const subject = before.match(/([A-Za-z][\w'’-]*)\s+(?:\w+ly\s+|still\s+|always\s+|just\s+|also\s+)?$/)?.[1];
    if (subject) {
      const s = subject.toLowerCase();
      const isSelf = ctx.characterName && sameFirst(subject, ctx.characterName);
      // "I call her Mom" is this character (the player speaking as them).
      const selfWord = s === 'i' || s === 'we';
      // "Biz calls…", "my kid calls…", "she calls…": someone else speaking — their sheet, not this one.
      const someoneElse = Boolean(findKnown(subject))
        || /^(?:kid|child|son|daughter|boy|girl|mom|dad|mother|father|she|he|they|who|everyone|people|friends?)$/i.test(s)
        || (/^[A-Z]/.test(subject) && !/^(?:Please|Also|And|But|So|Just|Keep|Note)$/.test(subject));
      if (!isSelf && !selfWord && someoneElse) continue;
    }
    let to: string | undefined;
    if (name) to = findKnown(name);
    else if (pronoun === 'me') to = subject && ctx.characterName && sameFirst(subject, ctx.characterName) ? findKnown(ctx.playerName) : undefined;
    else {
      const tied = [...new Set(ctx.relationships.map(r => r.to.trim()))];
      to = tied.length === 1 ? tied[0] : known.length === 1 ? known[0] : undefined;
    }
    add(to, term!);
  }
  return out;
}

/** The sheet with each stated address term on its tie — or on a new tie, when the term itself says what the tie is ("Mom"). Never a term that describes the character themself. */
/** "My stunt: Tiny and Quick — I can squeeze…", "Liz's stunt: Found It! — once per scene…". */
const STATED_STUNT = /\bstunts?\s*(?::|—|–|\bis\b|\bcalled\b)\s*["“]?([^"”\n:—–]{2,60}?)["”]?\s+(?:—|–|-|:)\s+([^\n]+)/gi;

const stuntKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Stunts the player described in their own words, put back where the sheet
 * kept only the name. Live (Z9JKG2): "My stunt: Tiny and Quick — I can
 * squeeze through small gaps and under counters where grown-ups can't fit."
 * was saved as "Tiny and Quick". A stunt the sheet already describes, or one
 * the player never described, is left as it is. The description runs to the
 * end of its sentence.
 */
export function withStatedStuntDescriptions<T extends Partial<CharacterDefinition>>(sheet: T, playerLines: string[]): T {
  const stunts = sheet.stunts ?? [];
  if (stunts.length === 0) return sheet;
  const stated = new Map<string, string>();
  for (const line of playerLines) {
    for (const m of line.matchAll(STATED_STUNT)) {
      const name = m[1]!.trim();
      const desc = (m[2]!.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? m[2]!).trim();
      if (name && desc.split(/\s+/).length >= 3) stated.set(stuntKey(name), `${name} — ${desc}`);
    }
  }
  if (stated.size === 0) return sheet;
  let changed = false;
  const next = stunts.map(s => {
    const full = stated.get(stuntKey(s));
    if (!full || stuntKey(s) === stuntKey(full)) return s;
    changed = true;
    return full;
  });
  if (!changed) return sheet;
  console.log(`[char-chat] stunt description restored from the player's words: ${next.filter((s, i) => s !== stunts[i]).join('; ')}`);
  return { ...sheet, stunts: next };
}

export function withStatedAddressTerms<T extends Partial<CharacterDefinition>>(sheet: T, terms: Array<{ to: string; address: string }>): T {
  const rels: Relationship[] = withoutSelfAddress([...(sheet.relationships ?? [])]);
  let changed = rels.some((r, i) => r !== sheet.relationships?.[i]);
  for (const t of terms) {
    const i = rels.findIndex(r => sameFirst(r.to, t.to));
    if (i >= 0) {
      if (addressDescribesSelf(rels[i]!.relation, t.address)) continue;
      if (rels[i]!.address?.trim() !== t.address) { rels[i] = { ...rels[i]!, address: t.address }; changed = true; }
      continue;
    }
    const relation = ADDRESS_RELATION.find(([re]) => re.test(t.address))?.[1];
    if (relation) { rels.push({ to: t.to, relation, address: t.address }); changed = true; }
  }
  return changed ? { ...sheet, relationships: rels } : sheet;
}

export function setInterviewStatus(db: Database.Database, id: string, status: InterviewStatus): void {
  db.prepare("UPDATE character_interviews SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, id);
}

/**
 * Everyone already at this table, as the interviewer needs them: characters
 * in play, characters waiting on approval, and sheets other players are
 * still shaping in their own interviews. Each player is interviewed alone,
 * so without this a mother and her son could be built in parallel with
 * neither interview knowing the other exists. Excludes the asking session's
 * own sheet; deduped by name, first source wins.
 */
export interface TableCharacter {
  name: string;
  highConcept: string;
  /** As that character's own sheet states them; null until their player says. */
  pronouns: string | null;
  relationships: Relationship[];
}

export function listTableCharacters(db: Database.Database, campaignId: string, excludeSessionToken: string): TableCharacter[] {
  const out: TableCharacter[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== 'string' || !raw) return;
    let def: Partial<CharacterDefinition>;
    try { def = JSON.parse(raw); } catch { return; }
    const name = typeof def?.name === 'string' ? def.name.trim() : '';
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    out.push({
      name,
      highConcept: typeof def.highConcept === 'string' ? def.highConcept.trim() : '',
      pronouns: typeof def.pronouns === 'string' && def.pronouns.trim() ? def.pronouns.trim() : null,
      relationships: Array.isArray(def.relationships) ? def.relationships : [],
    });
  };
  const ownCharacter = db.prepare('SELECT character_id FROM campaign_sessions WHERE token = ?').get(excludeSessionToken) as { character_id: string | null } | undefined;
  for (const row of db.prepare('SELECT id, definition FROM characters WHERE campaign_id = ? AND revoked_at IS NULL ORDER BY created_at').all(campaignId) as Array<{ id: string; definition: string }>) {
    if (row.id === ownCharacter?.character_id) continue;
    add(row.definition);
  }
  for (const row of db.prepare('SELECT definition FROM pending_characters WHERE campaign_id = ? AND session_token != ? ORDER BY created_at').all(campaignId, excludeSessionToken) as Array<{ definition: string }>) {
    add(row.definition);
  }
  for (const row of db.prepare("SELECT definition FROM character_interviews WHERE campaign_id = ? AND session_token != ? AND definition IS NOT NULL AND status != 'revoked' ORDER BY created_at").all(campaignId, excludeSessionToken) as Array<{ definition: string }>) {
    add(row.definition);
  }
  return out;
}

/**
 * An interview reply that says again, word for word, what the interviewer
 * already said this interview. Live (WXKC2C): Liz's second reply was an exact
 * copy of her first ("It is wonderful to meet you, Liz. I have noted…"),
 * after she had answered its questions.
 */
export function repeatsEarlierReply(reply: string, history: InterviewTurn[]): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const r = norm(reply);
  if (r.split(' ').length < 6) return false;
  return history.some(t => t.role === 'assistant' && (norm(t.content) === r || beatOverlap(reply, t.content) >= 0.9));
}

/**
 * What the interviewer says instead of repeating itself, when asking again
 * repeated it too: the sheet is ready, or what is still needed.
 */
export function interviewFallbackReply(readiness: CharacterReadiness): string {
  if (readiness.ready) return 'Got it — I have updated the character sheet. Have a look at it below, and confirm it when it reads right, or tell me what to change.';
  const next = readiness.detail.slice(0, 2).map(d => d.replace(/[.!?]+$/, '')).join('; ');
  return `Got it — that is on the sheet. Still to settle: ${next}.`;
}
