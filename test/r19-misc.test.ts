// Round 19: the tone gate's backstop, NPC kinds and text, live game KAZQX3
// (Liz she/her, Biz they/them, 10, gentle peril). See r19-loop.test.ts.
//  2. The epilogue's second draft was flagged ("…remains open for another
//     day", and bleakEnding's "Hazel's lavender stamp had already sealed the
//     document…"); the log said "flagged phrases removed", nothing was
//     removed, and nothing said why.
//  3. Hazel the hedgehog became "Hazel, the anxious bird" and the record
//     "Feathered creature that flinched".
//  4. "uncovered that The Typewriter" → "uncovered that Typewriter"; Liz's
//     final thought said "the brass key in your pocket"; Liz's compel line
//     quoted her trouble and said "pays for it now and collects later".
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { gateGentleTone, type ToneJudge } from '../src/server/tone-gate.js';
import { closeOpenEnding, bleakEnding, withoutTheAfterArticle, companionsNotYou } from '../src/server/narrative-guards.js';
import { closingWords, publicReflection } from '../src/server/game-loop.js';
import { npcKindOf, contradictsKind, npcCastLabel } from '../src/server/npc-kind.js';
import { npcPronounBlock, seedNpcPronouns } from '../src/server/npc-pronouns.js';
import { WorldBible } from '../src/server/world-bible.js';
import { migrate } from '../src/server/db.js';
import { gentleAdultCompelLines, gentleCompelLines, compelLines } from '../src/server/template-lines.js';

// ─── 2. The backstop says what it did ───────────────────────────────────────

const FIRST = 'Liz and Biz stood together in the Umbrella Aisle. The question of which desk handles tag repairs remains unanswered.';
const SECOND = "Liz smoothed the Fresh Sheet against the counter while Biz held the brass key tight in their pocket, the two of them standing shoulder to shoulder in the Umbrella Aisle. Hazel’s lavender stamp had already sealed the document with a burst of floral perfume, and Marmot Mailman hovered nearby, his satchel swinging gently as he watched the wet ink settle on the page. The Typewriter sat silent and still. The question of which desk handles tag repairs remains open for another day, but for now, the aisle is quiet and the pair is safe.";
const OPEN_PHRASE = 'The question of which desk handles tag repairs remains open for another day';

function run(judged: (text: string) => string[]) {
  const judge: ToneJudge = async (text) => { const phrases = judged(text); return { flagged: phrases.length > 0, phrases }; };
  return gateGentleTone({
    kind: 'epilogue', first: FIRST, textOf: t => t, regenerate: async () => SECOND, judge,
    extraFlags: t => (bleakEnding(t) ? [closingWords(t)] : []),
    soften: t => closeOpenEnding(t, ['Liz', 'Biz']),
  });
}

describe('2. the epilogue backstop always says what it did with each flagged phrase', () => {
  it('the live run: the softener already took the judge\'s phrase out, and the bleak-ending flag is left to the ending softener — both logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Two phrases on each draft, as live ("2 vs 2"): the second is kept.
    const r = await run(text => (text.includes('another day') ? [OPEN_PHRASE] : text.includes('unanswered') ? ['remains unanswered', 'stood together'] : []));
    const out = [...warn.mock.calls, ...log.mock.calls].map(c => c.join(' ')).join('\n');
    warn.mockRestore();
    log.mockRestore();
    expect(r.stillFlagged).toBe(true);
    expect(r.value).not.toContain('remains open for another day');
    expect(r.value).toContain('For now, the aisle is quiet and the pair is safe.');
    // The deterministic ending flag is never cut out whole (round 16's design).
    expect(r.value).toContain('Hazel’s lavender stamp had already sealed the document');
    expect(out).toMatch(/epilogue: flagged "The question of which desk handles tag repairs remains open for another day" is no longer in the text after softening — nothing to remove/);
    expect(out).toMatch(/epilogue: flagged "Hazel’s lavender stamp had already sealed the document[^"]*" is an ending flag — left to the ending softener, not removed/);
    expect(out).not.toMatch(/flagged phrases removed/);
  });

  it('a judge\'s phrase still in the text is removed, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await run(text => (text.includes('Marmot Mailman hovered') ? ['his satchel swinging gently'] : text.includes('unanswered') ? ['remains unanswered', 'stood together'] : []));
    const out = [...warn.mock.calls, ...log.mock.calls].map(c => c.join(' ')).join('\n');
    warn.mockRestore();
    log.mockRestore();
    expect(r.value).not.toContain('satchel swinging');
    expect(out).toMatch(/removed flagged "his satchel swinging gently"/);
  });
});

// ─── 3. An NPC's kind is fixed ──────────────────────────────────────────────

const HAZEL = 'A kind, friendly hedgehog with spectacles perched on a very straight nose and a waistcoat full of pencils. She speaks in a low, warm voice.';

describe('3. an NPC\'s kind is fixed by the first description', () => {
  it('reads the kind a description names', () => {
    expect(npcKindOf(HAZEL)).toBe('hedgehog');
    expect(npcKindOf('Nervous mail carrier with satchel')).toBeNull();
    expect(npcKindOf('Grumbling machine that improvises ink')).toBe('machine');
    expect(npcKindOf('A badger who cannot bear untidy forms')).toBe('badger');
    expect(npcKindOf('A clerk who cranes her neck at every form')).toBeNull();
  });

  it('a feathered, beaked or bird description contradicts a hedgehog; a clerk\'s does not', () => {
    expect(contradictsKind('hedgehog', 'Feathered creature that flinched')).toBe(true);
    expect(contradictsKind('hedgehog', 'Anxious bird with a lavender stamp')).toBe(true);
    expect(contradictsKind('hedgehog', 'Anxious clerk with a lavender stamp')).toBe(false);
    expect(contradictsKind('hedgehog', 'Prickly hedgehog clerk')).toBe(false);
    expect(contradictsKind('owl', 'Feathered archivist')).toBe(false);
    expect(contradictsKind('owl', 'A bird of great learning')).toBe(false);
  });

  it('the cast label: "Hazel (she/her, hedgehog)"; the kind left out when the name says it', () => {
    expect(npcCastLabel({ name: 'Hazel', pronouns: 'she/her', kind: 'hedgehog' })).toBe('Hazel (she/her, hedgehog)');
    expect(npcPronounBlock([{ name: 'Hazel', pronouns: 'she/her', kind: 'hedgehog' }, { name: 'Marmot Mailman', pronouns: 'he/him', kind: 'marmot' }, { name: 'Button', pronouns: 'it/its' }]))
      .toMatch(/Hazel \(she\/her, hedgehog\); Marmot Mailman: he\/him; Button: it\/its\./);
    expect(seedNpcPronouns([{ name: 'Hazel', description: HAZEL, pronouns: 'she/her' }])).toEqual([{ name: 'Hazel', pronouns: 'she/her', kind: 'hedgehog' }]);
  });

  const bible = () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare('INSERT INTO campaigns (id, join_code, name, dm_preset) VALUES (?, ?, ?, ?)').run('c1', 'KAZQX3', 'Test', 'chronicler');
    const wb = new WorldBible(db);
    wb.applyDiff('c1', { newLocations: [], newEntities: [{ name: 'Hazel', type: 'npc', description: HAZEL, disposition: 'kind', pronouns: 'she/her' }], newItems: [], newEvents: [], newRelationships: [] }, { seeding: true });
    const desc = () => (db.prepare("SELECT description FROM entities WHERE name = 'Hazel'").get() as { description: string }).description;
    return { db, wb, desc };
  };

  it('the extractor cannot make Hazel a bird; a description that keeps her a hedgehog is taken', () => {
    const { wb, desc } = bible();
    expect(wb.getNpcKind('c1', 'Hazel')).toBe('hedgehog');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    wb.applyDiff('c1', { newLocations: [], newEntities: [{ name: 'Hazel', type: 'npc', description: 'Feathered creature that flinched', disposition: 'startled' }], newItems: [], newEvents: [], newRelationships: [] }, { markKnown: true });
    const out = log.mock.calls.map(c => c.join(' ')).join('\n');
    log.mockRestore();
    expect(desc()).toBe(HAZEL);
    expect(out).toMatch(/Hazel is a hedgehog/);
    wb.applyDiff('c1', { newLocations: [], newEntities: [{ name: 'Hazel', type: 'npc', description: 'Anxious clerk clutching a lavender stamp', disposition: 'anxious' }], newItems: [], newEvents: [], newRelationships: [] }, { markKnown: true });
    expect(desc()).toBe('Anxious clerk clutching a lavender stamp');
    expect(wb.getNpcKind('c1', 'Hazel')).toBe('hedgehog');
  });

  it('the host\'s redraft (a reseed) sets the kind anew', () => {
    const { wb, desc } = bible();
    wb.applyDiff('c1', { newLocations: [], newEntities: [{ name: 'Hazel', type: 'npc', description: 'A kind, friendly owl clerk', disposition: 'kind' }], newItems: [], newEvents: [], newRelationships: [] }, { seeding: true });
    expect(desc()).toBe('A kind, friendly owl clerk');
    expect(wb.getNpcKind('c1', 'Hazel')).toBe('owl');
  });

  it('every prompt\'s NPC line carries the kind: the DM\'s summary and the party\'s view', () => {
    const { wb, db } = bible();
    db.prepare("UPDATE entities SET known_to_party = 1 WHERE name = 'Hazel'").run();
    expect(wb.getSummary('c1')).toContain('Hazel (she/her, hedgehog)');
    expect(wb.getPlayerKnowledge('c1')).toContain('Hazel (she/her, hedgehog)');
    expect(wb.getNpcPronouns('c1')).toEqual([{ name: 'Hazel', pronouns: 'she/her', kind: 'hedgehog' }]);
  });
});

// ─── 4. Text ────────────────────────────────────────────────────────────────

describe('4a. "The" in a name goes only after an article or possessive, never after "that" or "this"', () => {
  it('the live line is left as written', () => {
    const text = '…and Biz uncovered that The Typewriter was intentionally rewriting the log.';
    expect(withoutTheAfterArticle(text)).toBe(text);
    expect(withoutTheAfterArticle('Liz points at this The Typewriter.')).toBe('Liz points at this The Typewriter.');
  });
  it('round 18 still stands', () => {
    expect(withoutTheAfterArticle('A small, velvety The Dust Bunny hops.')).toBe('A small, velvety Dust Bunny hops.');
    expect(withoutTheAfterArticle('Biz waves at the The Pigeon.')).toBe('Biz waves at the Pigeon.');
    expect(withoutTheAfterArticle('Liz pats its The Stool.')).toBe('Liz pats its Stool.');
  });
});

describe('4b. a closing thought is a first-person monologue: a companion\'s thing is theirs by name, not "your"', () => {
  const companions = [{ name: 'Biz', inventory: ['Bottle caps', 'The Golden Key'] }];
  it('the live thought', () => {
    const t = 'I still feel the weight of the brass key in your pocket and the smooth edge of the bottle cap in my bag, a quiet reminder that we solved the muddle side by side.';
    expect(companionsNotYou(t, companions)).toBe("I still feel the weight of the brass key in Biz's pocket and the smooth edge of the bottle cap in my bag, a quiet reminder that we solved the muddle side by side.");
  });
  it('"your key" when the one companion holds a key', () => {
    expect(companionsNotYou('I think of your key, safe at last.', companions)).toBe("I think of Biz's key, safe at last.");
  });
  it('left as written: "your" not about a companion\'s thing, or a thing two companions could hold', () => {
    expect(companionsNotYou('I hope your day was kind.', companions)).toBe('I hope your day was kind.');
    expect(companionsNotYou('The brass key in your pocket.', [{ name: 'Biz', inventory: ['Key'] }, { name: 'Ada', inventory: ['Old key'] }])).toBe('The brass key in your pocket.');
  });
  it('through publicReflection: the thought gets the name, spoken words are left to address the companion', () => {
    const raw = 'SPOKEN: "We made it, Biz, and your key is safe."\nTHOUGHT: I still feel the weight of the brass key in your pocket.';
    const out = publicReflection(raw, { members: [{ name: 'Liz', pronouns: 'she/her' }, { name: 'Biz', pronouns: 'they/them' }], familyTable: true, companions });
    expect(out.thought).toBe("I still feel the weight of the brass key in Biz's pocket.");
    expect(out.spoken).toContain('your key');
  });
});

describe('4c. a grown-up\'s compel line at a gentle table: no trouble in quotes, no bookkeeping', () => {
  const lines = gentleAdultCompelLines('Liz');
  it('twenty-four, each with the name, no quote, no "pays now, collects later"', () => {
    expect(lines).toHaveLength(24);
    for (const l of lines) {
      expect(l).toContain('Liz');
      expect(l).not.toContain('"');
      expect(l).not.toMatch(/guess who|pays for|collects? later|fate|point|token|bank|owed|owes|count|trouble|every single time|again/i);
    }
  });
  it('none is a child\'s line or the live stock line', () => {
    const live = 'Guess who is back? "Worries about Biz too much". Liz pays for it now and collects later.';
    expect(lines).not.toContain(live);
    expect(compelLines('Liz', 'Worries about Biz too much')).toContain(live);
    for (const l of gentleCompelLines('Liz')) expect(lines).not.toContain(l);
  });
  it('no two share a four-word phrase', () => {
    const grams = new Map<string, number>();
    lines.forEach((l, i) => {
      const w = l.replace(/\bLiz\b/g, 'N').toLowerCase().split(/\s+/);
      for (let k = 0; k + 4 <= w.length; k++) {
        const g = w.slice(k, k + 4).join(' ');
        if (grams.has(g) && grams.get(g) !== i) throw new Error(`"${g}" in lines ${grams.get(g)} and ${i}`);
        grams.set(g, i);
      }
    });
  });
});
