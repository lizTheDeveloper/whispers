import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { WorldBible } from './world-bible.js';
import { safeDataFile } from './data-paths.js';
import { WorldSeedSchema } from './agents/schemas.js';
import type { WorldSeed } from '../shared/types.js';
import { neutralSetupNouns } from './pronoun-consistency.js';
import { pronounsInDescription } from './npc-pronouns.js';

/**
 * Write a seed into the world bible.
 *
 * This is the mapping that used to live inside GameLoop.seedScenario. It moved
 * out so the world can exist before a game starts — a player has to be able to
 * meet the world before they build a character for it. This is the only caller
 * that passes allowNewLocations: true; in-play updates must not create places.
 *
 * Locations, entities, and items are deduped by name inside applyDiff, so
 * re-seeding an identical seed is safe for those categories. Events are not:
 * applyDiff's event-reconciliation branch only runs for events that arrive
 * with an outcome, and a seeded plot hook always has outcome: null, so a
 * second seedWorld call would otherwise add a second, identical event every
 * time. That reconciliation logic is shared with the in-play fact extractor,
 * so rather than touch its semantics, seedWorld does its own dedup here: drop
 * any plot hook whose description already exists for this campaign as an
 * event — resolved or not.
 *
 * Deduping against resolved events too (not just unresolved ones) matters
 * now that accept-world-seed and regenerate-world-seed can call seedWorld
 * more than once for the same campaign: without it, re-seeding could
 * resurrect a plot hook the table already played out and resolved as a
 * brand-new open thread, which is worse than the duplicate-row bug this
 * dedup originally existed to prevent.
 */
export function seedWorld(db: Database.Database, campaignId: string, seed: WorldSeed): void {
  const worldBible = new WorldBible(db);
  const existingEvents = new Set(
    worldBible.getEventDescriptions(campaignId).map(d => d.trim().toLowerCase())
  );
  const newHooks = seed.plotHooks.filter(hook => !existingEvents.has(hook.trim().toLowerCase()));

  worldBible.applyDiff(campaignId, {
    newLocations: seed.locations.map(l => ({ name: l.name, description: l.description, terrain: l.terrain ?? null })),
    newEntities: seed.npcs.map(n => ({
      name: n.name,
      type: 'npc' as const,
      description: n.description,
      disposition: n.disposition ?? null,
      // Its own column, so the DM's summary can show it and the party's
      // view (getPlayerKnowledge) never does.
      motivation: n.motivation ?? null,
      // Stated, else read off the description ("…magnify their eyes…"):
      // the DM is handed these every turn and they never drift.
      pronouns: n.pronouns?.trim() || pronounsInDescription(n.description),
    })),
    newItems: seed.items.map(i => ({ name: i.name, description: i.description, properties: {} })),
    newEvents: newHooks.map(hook => ({ sceneNumber: 0, description: hook, participants: [], outcome: null })),
    newRelationships: [],
  }, { allowNewLocations: true });
}

/**
 * A stock scenario is just a pre-written seed. Loading it here means improvised
 * and stock campaigns travel one code path from this point on.
 */
export function loadStockScenario(scenarioId: string): { seed: WorldSeed; openingNarration: string | null } | null {
  const file = safeDataFile('scenarios', scenarioId, '.json');
  if (!file) {
    console.warn(`[world-seed] Scenario ${scenarioId} not found — falling back to a from-scratch draft.`);
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    const parsed = WorldSeedSchema.safeParse({
      premise: raw.description ?? raw.name ?? '',
      locations: raw.locations ?? [],
      npcs: raw.npcs ?? [],
      plotHooks: raw.plotHooks ?? [],
      items: raw.items ?? [],
    });
    if (!parsed.success) {
      console.warn(`[world-seed] Scenario ${scenarioId} failed validation:`, parsed.error.issues.map(i => i.path.join('.')).join(', '));
      return null;
    }
    if (raw.openingNarration !== undefined && typeof raw.openingNarration !== 'string') {
      console.warn(`[world-seed] Scenario ${scenarioId} has a non-string openingNarration — dropping it.`);
    }
    return { seed: parsed.data, openingNarration: typeof raw.openingNarration === 'string' ? raw.openingNarration : null };
  } catch (e) {
    console.warn(`[world-seed] Failed to load scenario ${scenarioId}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

export function getWorldSeed(db: Database.Database, campaignId: string): WorldSeed | null {
  const row = db.prepare('SELECT world_seed FROM campaigns WHERE id = ?').get(campaignId) as any;
  if (!row?.world_seed) return null;
  try {
    const parsed = WorldSeedSchema.safeParse(JSON.parse(row.world_seed));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function setWorldSeed(db: Database.Database, campaignId: string, seed: WorldSeed): void {
  db.prepare("UPDATE campaigns SET world_seed = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(seed), campaignId);
}

/**
 * Writes a seed only if the campaign has not accepted one yet. Regenerating a
 * seed involves a real await (the LLM call that drafts it) that an
 * accept-world-seed on the same socket can complete during — that call does
 * all of its own work synchronously, so it can finish first, write the seed
 * that is actually in the world bible, and advance the phase, all before this
 * redraft resolves. An unconditional setWorldSeed after that would silently
 * clobber campaigns.world_seed with a draft nobody accepted, leaving the DB
 * out of sync with the world bible. The WHERE clause makes the write atomic
 * the same way advancePhaseIfLobby's is: whichever write actually happens is
 * the only one the caller should act on. Returns whether this call's write
 * took effect.
 */
export function setWorldSeedIfNotAccepted(db: Database.Database, campaignId: string, seed: WorldSeed): boolean {
  const result = db.prepare(
    "UPDATE campaigns SET world_seed = ?, updated_at = datetime('now') WHERE id = ? AND seed_accepted_at IS NULL"
  ).run(JSON.stringify(seed), campaignId);
  return result.changes === 1;
}

export function markSeedAccepted(db: Database.Database, campaignId: string): void {
  db.prepare("UPDATE campaigns SET seed_accepted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(campaignId);
}

export function isSeedAccepted(db: Database.Database, campaignId: string): boolean {
  const row = db.prepare('SELECT seed_accepted_at FROM campaigns WHERE id = ?').get(campaignId) as any;
  return Boolean(row?.seed_accepted_at);
}

/** Labels of the DM's private draft that never belong in a chat reply, for any host. */
const FIELD_LABEL = String.raw`dm[ _]?instructions|dm[ _]?custom[ _]?prompt|plot\s+hooks?|key\s+npcs?|current\s+situation|secrets?|twists?`;
/** …and, for a host who plays or asked for no spoilers, the NPCs the DM has in mind. */
const NPC_LABEL = String.raw`npcs?(?:\s*\d+)?`;
const labelAt = (labels: string) => new RegExp(String.raw`^\s*(?:[-*•>#]+\s*|\d+[.)]\s*)?(?:\*\*|__)?\s*(?:${labels})\s*(?:\*\*|__)?\s*:`, 'i');
/** A label after a sentence inside a line: "…ready. Plot Hook: the clerk vanished." */
const labelInline = (labels: string) => new RegExp(String.raw`(?<=[.!?…]["”’']?\s+)(?:\*\*|__)?\s*(?:${labels})\s*(?:\*\*|__)?\s*:`, 'i');

/**
 * A setup-chat reply with the DM's draft fields taken out. Live (E9W9YT, a
 * host playing and asking for no spoilers), the model wrote its structured
 * output into `reply` itself: first a "**Plot Hook:**" block, then
 * "**dmInstructions:**" and "**dmCustomPrompt:**" dumps with "Current
 * Situation" and "Key NPCs". Nothing in the server copies those fields into
 * the reply; the model echoed them. A block — its label line and the lines
 * after it up to a blank line — goes, for every host (a DM host reads the
 * drafted world on its card, not in the chat), and so does an intro line
 * ending in ":" right before it. `noSpoilers` also drops "NPC 1:" blocks.
 */
export function withoutSetupFieldDumps(reply: string, opts: { noSpoilers?: boolean; fallback?: string } = {}): string {
  if (!reply) return reply;
  const labels = opts.noSpoilers ? `${FIELD_LABEL}|${NPC_LABEL}` : FIELD_LABEL;
  const atStart = labelAt(labels);
  const inline = labelInline(labels);
  if (!reply.split('\n').some(l => atStart.test(l)) && !inline.test(reply)) return reply;
  const kept: string[] = [];
  let dropping = false;
  let dropped = 0;
  for (const line of reply.split('\n')) {
    if (dropping) {
      if (line.trim() === '') { dropping = false; kept.push(line); }
      continue;
    }
    if (atStart.test(line)) {
      dropping = true;
      dropped++;
      // "Here is the summary of how we will run this game:" introduced it.
      let k = kept.length - 1;
      while (k >= 0 && kept[k]!.trim() === '') k--;
      if (k >= 0 && /:\s*$/.test(kept[k]!) && !atStart.test(kept[k]!)) kept.splice(k, 1);
      continue;
    }
    const m = line.match(inline);
    if (m && m.index !== undefined) {
      dropped++;
      kept.push(line.slice(0, m.index).trimEnd());
      continue;
    }
    kept.push(line);
  }
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (dropped > 0) console.log(`[dm-chat] dropped ${dropped} draft-field block(s) from a setup reply`);
  return out || opts.fallback || 'I have the shape of it — the rest you will discover in play. What tone do you want at the table?';
}

/** "I've drafted a starting world…", "Please review the world card I've drafted." */
const DRAFT_CLAIM = /\b(?:I|we)(?:['’]ve|\s+have|['’]ll\s+have|\s+just)?\s+(?:\w+\s+){0,2}?(?:drafted|built|created|prepared|put\s+together|sketched(?:\s+out)?|written\s+up|made)\b[^.!?]*\b(?:world|card|draft|seed)\b|\b(?:review|check|look\s+over|see|accept)\b[^.!?]*\b(?:world\s+card|the\s+card|the\s+draft|(?:the|this|that)\s+(?:starting\s+)?world\s+(?:I|we)(?:['’]ve|\s+have)?\s+(?:drafted|built|made))\b|\b(?:world\s+card|draft)\s+(?:is|should\s+be)\s+(?:ready|up|below|above|waiting)\b/i;
/** A sentence that only makes sense after one: "If it looks good, just let me know!" */
const DRAFT_FOLLOW_UP = /^\s*(?:if\s+(?:it|that|this|everything)\s+looks\s+(?:good|right)|let\s+me\s+know\s+if\s+(?:it|you)\s+(?:looks|want\s+(?:to\s+)?change))/i;

/**
 * A setup reply without a claim to have drafted a world that is not on its
 * way. Live (Z9JKG2): "I've drafted a starting world… Please review the
 * world card I've drafted." — no world-seed-draft was sent (the reply had
 * not set done with a summary, so no draft could run) and the readiness
 * panel still listed the seed as missing; the host answered "I don't see a
 * world card yet". The draft is made by the server after the reply, from a
 * finished setup; the model cannot make it by saying so. When `draftComing`
 * is false the claim and its follow-up come out and `fallback` (the next
 * thing setup needs) is asked instead.
 */
export function withoutFalseDraftClaim(reply: string, opts: { draftComing: boolean; fallback: string }): string {
  if (!reply || opts.draftComing || !DRAFT_CLAIM.test(reply)) return reply;
  let dropped = 0;
  const out = reply.split(/(\n+)/).map(p => {
    if (/^\n+$/.test(p)) return p;
    const kept: string[] = [];
    for (const sentence of p.split(/(?<=[.!?…]["”’']?)\s+/)) {
      if (DRAFT_CLAIM.test(sentence) || (dropped > 0 && DRAFT_FOLLOW_UP.test(sentence))) { dropped++; continue; }
      kept.push(sentence);
    }
    return kept.join(' ');
  }).join('').replace(/\n{3,}/g, '\n\n').trim();
  console.log(`[dm-chat] dropped ${dropped} sentence(s) claiming a world draft that is not coming`);
  const question = opts.fallback.replace(/^Noted\.\s*/, '');
  return out ? `${out} ${question}` : question;
}

/**
 * The readiness list as the setup model is told it. Before a world exists,
 * "Review and accept the starting world" read to it as "tell the host to
 * review the card" (live, it did — twice — with no card). The seed line
 * says how the card gets made and that the model never claims it.
 */
export function setupUnmetForModel(readiness: { unmet: string[]; detail: string[] }): string[] {
  const noSeed = readiness.unmet.includes('seed');
  return readiness.unmet.flatMap((u, i) => {
    if (u === 'seedAccepted' && noSeed) return [];
    if (u === 'seed') return ['The world card has not been drafted yet. It is drafted for the host automatically, after your reply, once at least three influences are recorded and you set "done": true with dmInstructions. Never say or imply that a world or a world card is drafted or ready to review.'];
    return [readiness.detail[i] ?? u];
  });
}

/** Sentences of the DM's private direction that carry a secret: its labelled secret blocks, and any sentence about motives, secrets or who is behind what. */
export function directionSecrets(direction: string | null | undefined): string[] {
  if (!direction?.trim()) return [];
  const out: string[] = [];
  const atStart = labelAt(`${FIELD_LABEL}|${NPC_LABEL}`);
  let inBlock = false;
  for (const line of direction.split('\n')) {
    if (atStart.test(line)) { inBlock = true; out.push(line); continue; }
    if (inBlock && (line.trim() === '' || /^\s*(?:\*\*|__)[^*_]+(?:\*\*|__)\s*:?/.test(line) && !/^\s*\d/.test(line))) inBlock = false;
    if (inBlock) { out.push(line); continue; }
    for (const sentence of line.split(/(?<=[.!?…]["”’']?)\s+/)) {
      if (/\b(?:secret\w*|hidden|hides?|hiding|actually|truly|really|twist\w*|behind|responsible|culprit|motive\w*|betray\w*|plans?\s+to|wants?\s+to|scheme\w*|vanish\w*|disappear\w*)\b/i.test(sentence)) out.push(sentence);
    }
  }
  return out;
}

/**
 * A setup-chat reply for a host who plays or asked for no spoilers, with
 * every sentence dropped that repeats a plot hook or an NPC motivation from
 * the drafted world — three words in a row of it, up to six — or a secret
 * of the DM's direction still being drafted (`direction`: four words in a
 * row of a secret sentence, see directionSecrets). The prompt asks for
 * this; this is the net under it. Nothing to compare against: as written.
 */
export function withoutSeedSpoilers(reply: string, seed: WorldSeed | null, fallback?: string, direction: Array<string | null | undefined> = []): string {
  if (!reply) return reply;
  const words = (t: string) => t.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9']+/g) ?? [];
  const runs = new Set<string>();
  const addRuns = (texts: string[], min: number) => {
    for (const w of texts.map(words).filter(x => x.length >= min)) {
      const n = Math.min(6, w.length);
      for (let i = 0; i + n <= w.length; i++) runs.add(w.slice(i, i + n).join(' '));
      if (min > 3) for (let k = min; k < n; k++) for (let i = 0; i + k <= w.length; i++) runs.add(w.slice(i, i + k).join(' '));
    }
  };
  if (seed) addRuns([...seed.plotHooks, ...seed.npcs.map(n => n.motivation ?? '')], 3);
  // The draft direction is long and repeats the host's own premise; only its secrets count, at four words.
  addRuns(direction.flatMap(d => directionSecrets(d)), 4);
  if (runs.size === 0) return reply;
  const minRun = seed ? 3 : 4;
  const spoils = (sentence: string) => {
    const w = words(sentence);
    for (let n = minRun; n <= 6; n++) {
      for (let i = 0; i + n <= w.length; i++) if (runs.has(w.slice(i, i + n).join(' '))) return true;
    }
    return false;
  };
  const kept = reply.split('\n').map(line => {
    const sentences = line.split(/(?<=[.!?…]["”’']?)\s+/);
    const ok = sentences.filter(s => !spoils(s));
    if (ok.length !== sentences.length) console.log(`[dm-chat] dropped ${sentences.length - ok.length} spoiler sentence(s) for a spoiler-free host`);
    return ok.join(' ');
  });
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // A caller-chosen fallback moves the setup on; the fixed line, sent for
  // every fully-dropped reply, read to the host as the DM stuck in a loop.
  return out || fallback || 'I have the shape of it — the rest you will discover in play. What tone do you want at the table?';
}


/**
 * The drafted or accepted world in the host's own relation words: live, the
 * host wrote "her 10-year-old kid, Biz" and the seed said "her ten-year-old
 * son Biz", which was then copied into Liz's backstory. The setup chat is
 * had before anyone states pronouns, so a gendered noun for a character the
 * host named becomes "kid" unless the host used that noun themselves.
 */
export function seedWithHostNouns(seed: WorldSeed, hostMessages: string[]): WorldSeed {
  const fix = (t: string) => neutralSetupNouns(t, hostMessages);
  const out: WorldSeed = {
    ...seed,
    premise: fix(seed.premise),
    locations: seed.locations.map(l => ({ ...l, description: l.description ? fix(l.description) : l.description })),
    npcs: seed.npcs.map(n => ({ ...n, description: n.description ? fix(n.description) : n.description, motivation: n.motivation ? fix(n.motivation) : n.motivation })),
    plotHooks: seed.plotHooks.map(fix),
  };
  return JSON.stringify(out) === JSON.stringify(seed) ? seed : out;
}

/**
 * The world as it may travel to a host who plays in it or asked for no
 * spoilers: premise, places, people by name, description and disposition,
 * items — what their card shows — and nothing else. Live (N7RQZ7) the card
 * hid the plot hooks and NPC motives, but the world-seed-draft frame carried
 * them ("Luma … burying the truth about the recent 'incidents' under a
 * mountain of paperwork") for anyone who opened devtools. The full seed
 * stays on the server for the DM; accept-world-seed puts the withheld
 * fields back (withHiddenSeedFields).
 */
export function seedForHost(seed: WorldSeed, noSpoilers: boolean): WorldSeed {
  if (!noSpoilers) return seed;
  return {
    ...seed,
    npcs: seed.npcs.map(n => ({ ...n, motivation: null })),
    plotHooks: [],
  };
}

/**
 * The seed a spoiler-free host accepts, with what seedForHost withheld from
 * them put back from the stored draft: its plot hooks, and each NPC's
 * motivation (matched by name). A field the host's copy does carry is theirs.
 */
export function withHiddenSeedFields(incoming: WorldSeed, stored: WorldSeed | null): WorldSeed {
  if (!stored) return incoming;
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  return {
    ...incoming,
    plotHooks: incoming.plotHooks.length > 0 ? incoming.plotHooks : stored.plotHooks,
    npcs: incoming.npcs.map(n => {
      if (n.motivation?.trim()) return n;
      const was = stored.npcs.find(s => same(s.name, n.name));
      return was?.motivation ? { ...n, motivation: was.motivation } : n;
    }),
  };
}
