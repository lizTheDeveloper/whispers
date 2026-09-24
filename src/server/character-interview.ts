import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CharacterDefinition } from '../shared/types.js';

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
  return update.map(r => {
    if (r.address?.trim()) return r;
    const before = base.find(o => sameFirst(o.to, r.to) && o.address?.trim());
    return before ? { ...r, address: before.address } : r;
  });
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

/**
 * Address terms the player states outright in their own message: "calls Liz
 * Mom", "Biz calls her Mom", "Biz calls me Mom" (the player speaking as the
 * person called). Each is { to, address }, where `to` is someone at the table
 * or on the sheet. "her"/"him"/"them" resolve only when one person is meant:
 * the sheet's single tie, else the table's single other character.
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
    let to: string | undefined;
    if (name) to = findKnown(name);
    else if (pronoun === 'me') to = findKnown(ctx.playerName);
    else {
      const tied = [...new Set(ctx.relationships.map(r => r.to.trim()))];
      to = tied.length === 1 ? tied[0] : known.length === 1 ? known[0] : undefined;
    }
    add(to, term!);
  }
  return out;
}

/** The sheet with each stated address term on its tie — or on a new tie, when the term itself says what the tie is ("Mom"). */
export function withStatedAddressTerms<T extends Partial<CharacterDefinition>>(sheet: T, terms: Array<{ to: string; address: string }>): T {
  if (terms.length === 0) return sheet;
  const rels: Relationship[] = [...(sheet.relationships ?? [])];
  let changed = false;
  for (const t of terms) {
    const i = rels.findIndex(r => sameFirst(r.to, t.to));
    if (i >= 0) {
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
export function listTableCharacters(db: Database.Database, campaignId: string, excludeSessionToken: string): Array<{ name: string; highConcept: string }> {
  const out: Array<{ name: string; highConcept: string }> = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== 'string' || !raw) return;
    let def: Partial<CharacterDefinition>;
    try { def = JSON.parse(raw); } catch { return; }
    const name = typeof def?.name === 'string' ? def.name.trim() : '';
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    out.push({ name, highConcept: typeof def.highConcept === 'string' ? def.highConcept.trim() : '' });
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
