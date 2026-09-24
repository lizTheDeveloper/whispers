// Round 14: what the round-13 live game (7RAAQ7; qwen3.8-27b; Liz she/her,
// Biz they/them and ten, Biz calls Liz "Mom", the host asked for gentle
// peril) still got wrong. Each block quotes the live line.
//  1. The tone gate: a judge at a gentle table instead of more patterns.
//  2. "…in the filing cabinet.". But the victory isn't clean — …": the
//     correction line's joining, quoting and template.
//  3. Stock lines verbatim for both characters: the rotation remembered
//     exact lines, so a variant said for Liz was new for Biz.
//  4. "I am Clerk Ozymandias" in scene 3: the DM is told who the party met.
//  5. Biz's reflection: "I am safe in Liz's grip".
//  6. "The Next Pigeon" / "Next Pigeon", "Button" / "The Glossy Button".
//  7. Pronouns in seed and personality prompts; skills all +0; the submit
//     button after approval.
// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  gateGentleTone, parseToneVerdict, phrasesInText, toneJudgeSystemPrompt, toneFeedback, llmToneJudge,
  type ToneJudge, type ToneVerdict,
} from '../src/server/tone-gate.js';
import { LineRotation, compelLines, invokeLines, appendBeat } from '../src/server/template-lines.js';
import { outcomeLines, softenForChildren } from '../src/server/narrative-guards.js';
import { publicReflection, closingWords } from '../src/server/game-loop.js';
import { metNpcsBlock } from '../src/server/agents/dm.js';
import { npcsMet } from '../src/server/npc-pronouns.js';
import { checkCharacterReadiness } from '../src/server/character-readiness.js';

// ─── 1. The tone gate ───────────────────────────────────────────────────────

const MENACE = 'The Next Pigeon squawks: \'Please present the signed Form 88-B, or I shall have to re-file your entire identity under the category of Unresolved Naps.\'';
const GENTLE = 'The Next Pigeon squawks: \'Please present the signed Form 88-B, and do mind the bell — it is very loud.\'';

function mockJudge(verdicts: Record<string, ToneVerdict | null>): ToneJudge & { calls: string[] } {
  const calls: string[] = [];
  const judge = (async (text: string) => {
    calls.push(text);
    for (const [needle, v] of Object.entries(verdicts)) if (text.includes(needle)) return v;
    return { flagged: false, phrases: [] };
  }) as ToneJudge & { calls: string[] };
  judge.calls = calls;
  return judge;
}

describe('1a. the gate: judge, regenerate once with the phrases, keep the better one', () => {
  it('an ok draft goes out as written, with one judge call and no second draft', async () => {
    const judge = mockJudge({});
    const regenerate = vi.fn();
    const r = await gateGentleTone({ kind: 'narration', first: GENTLE, textOf: t => t, regenerate, soften: t => t, judge });
    expect(r.value).toBe(GENTLE);
    expect(regenerate).not.toHaveBeenCalled();
    expect(judge.calls).toHaveLength(1);
  });

  it('the live line: flagged, generated ONCE more with the phrase quoted as feedback, and the clean second draft kept', async () => {
    const judge = mockJudge({ 'Unresolved Naps': { flagged: true, phrases: ['re-file your entire identity under the category of Unresolved Naps'] } });
    const regenerate = vi.fn(async (_feedback: string) => GENTLE);
    const r = await gateGentleTone({ kind: 'narration', first: MENACE, textOf: t => t, regenerate, soften: t => t, judge });
    expect(r.value).toBe(GENTLE);
    expect(r.regenerated).toBe(true);
    expect(regenerate).toHaveBeenCalledTimes(1);
    const feedback = regenerate.mock.calls[0]![0];
    expect(feedback).toContain('"re-file your entire identity under the category of Unresolved Naps"');
    // Feedback, never a rewrite: the draft itself is not handed back.
    expect(feedback).not.toContain('Please present the signed Form 88-B');
  });

  it('both drafts flagged: the one with fewer phrases is kept, the softener runs over it, and (round 16) the flagged sentence goes', async () => {
    const second = 'Mama Pigeon warns that mistakes must be filed. She smooths her feathers.';
    const judge = mockJudge({
      'Unresolved Naps': { flagged: true, phrases: ['re-file your entire identity', 'Unresolved Naps'] },
      'mistakes must be filed': { flagged: true, phrases: ['mistakes must be filed'] },
    });
    const soften = vi.fn((t: string) => `${t} [softened]`);
    const r = await gateGentleTone({ kind: 'ruling', first: MENACE, textOf: t => t, regenerate: async () => second, soften, judge });
    // Round 17: "She" lost its person with the removed sentence; it gets the name back.
    expect(r.value).toBe('Mama Pigeon smooths her feathers. [softened]');
    expect(r.stillFlagged).toBe(true);
    expect(soften).toHaveBeenCalledTimes(1);
  });

  it('…and the first when it had fewer', async () => {
    const worse = 'They bury them in a paperwork avalanche, very sticky ghosts, all very hungry.';
    const judge = mockJudge({
      'Unresolved Naps': { flagged: true, phrases: ['Unresolved Naps'] },
      avalanche: { flagged: true, phrases: ['bury them in a paperwork avalanche', 'very sticky ghosts, all very hungry'] },
    });
    const r = await gateGentleTone({ kind: 'ruling', first: MENACE, textOf: t => t, regenerate: async () => worse, soften: t => softenForChildren(t), judge });
    expect(r.value).toBe(softenForChildren(MENACE));
  });

  it('no verdict (a judge timeout) fails open: kept as written, nothing regenerated', async () => {
    const regenerate = vi.fn();
    const r = await gateGentleTone({ kind: 'narration', first: MENACE, textOf: t => t, regenerate, soften: t => t, judge: async () => null });
    expect(r.value).toBe(MENACE);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it('a deterministic flag (bleakEnding) regenerates even when the judge says ok or times out', async () => {
    const regenerate = vi.fn(async () => 'Liz and Biz walk home together, hand in hand.');
    const r = await gateGentleTone({
      kind: 'epilogue', first: 'Liz and Biz are still stuck in the queue.', textOf: t => t, regenerate, soften: t => t,
      judge: async () => null, extraFlags: t => (/stuck/.test(t) ? ['still stuck in the queue'] : []),
    });
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(r.value).toBe('Liz and Biz walk home together, hand in hand.');
  });

  it('works on structured output (a ruling): the text is read through textOf', async () => {
    const judge = mockJudge({ 'bare-chested': { flagged: true, phrases: ['stand bare-chested'] } });
    const first = { outcome: 'tie', narration: 'You and your companion stand bare-chested in the lobby.' };
    const second = { outcome: 'tie', narration: 'You and your companion stand in the lobby with no lanyards.' };
    const r = await gateGentleTone({ kind: 'ruling', first, textOf: v => v.narration, regenerate: async () => second, soften: v => v, judge });
    expect(r.value).toBe(second);
  });
});

describe('1b. the judge\'s verdict is read strictly', () => {
  it('phrases are checked against the text — a made-up quote is no evidence', () => {
    expect(parseToneVerdict('{"verdict":"flag","phrases":["the goose bites"]}', GENTLE)).toEqual({ flagged: false, phrases: [] });
    expect(parseToneVerdict({ verdict: 'flag', phrases: ['Unresolved Naps'] }, MENACE)).toEqual({ flagged: true, phrases: ['Unresolved Naps'] });
  });

  it('a quote with an ellipsis matches its parts in order ("bury them in a … avalanche")', () => {
    const text = 'The shelves threaten to bury them in a sighing, rustling avalanche of forms.';
    expect(phrasesInText(text, ['bury them in a … avalanche'])).toEqual(['bury them in a … avalanche']);
    expect(phrasesInText(text, ['avalanche … bury them'])).toEqual([]);
  });

  it('curly quotes and case do not matter', () => {
    expect(phrasesInText('“A lullaby that makes one forget one’s own name,” she hums.', ["a lullaby that makes one forget one's own name"])).toHaveLength(1);
  });

  it('anything that is not a verdict is null (the gate fails open on it)', () => {
    expect(parseToneVerdict('ok', GENTLE)).toBeNull();
    expect(parseToneVerdict('*thinks quietly*', GENTLE)).toBeNull();
    expect(parseToneVerdict('{"verdict":"maybe"}', GENTLE)).toBeNull();
    expect(parseToneVerdict('Sure! {"verdict":"ok","phrases":[]}', GENTLE)).toEqual({ flagged: false, phrases: [] });
  });
});

describe('1c. the judge\'s criteria are the real misses of 7RAAQ7', () => {
  const prompt = toneJudgeSystemPrompt('narration');
  it.each([
    're-file your entire identity under the category of Unresolved Naps',
    'mistakes must be filed',
    "a lullaby that makes one forget one's own name",
    'or the queue will think you are two separate forms!',
    'as if their presence has just been chewed on',
    'very sticky ghosts … all very hungry',
    'pull them back from the dissolving floor',
    'eyes that are less eyes and more swirling vortices of ink',
    'You and your companion stand bare-chested',
  ])('names "%s"', (miss) => {
    expect(prompt).toContain(miss);
  });

  it('only an ending is held to a warm, resolved close — with the live limbo ending and Liz\'s half-hopeful one', () => {
    expect(prompt).not.toContain('THIS IS AN ENDING');
    for (const kind of ['epilogue', 'reflection'] as const) {
      const p = toneJudgeSystemPrompt(kind);
      expect(p).toContain('THIS IS AN ENDING');
      expect(p).toContain('remains unanswered, and the beige ripples … continue their slow, wet pulse');
      expect(p).toContain('is still open, and we face it together');
    }
    expect(toneFeedback(['remains unanswered'], 'epilogue')).toMatch(/warm and settled/);
  });
});

describe('1d. the LLM judge: one short call, a hard timeout, fail-open', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.WHISPERS_TONE_JUDGE_MS;
  });

  it('asks the proxy with /no_think and a small budget, and reads the verdict', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ text: '{"verdict":"flag","phrases":["Unresolved Naps"]}' }), { status: 200 });
    }));
    const v = await llmToneJudge(MENACE, 'narration');
    expect(v).toEqual({ flagged: true, phrases: ['Unresolved Naps'] });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].injectNoThink).toBe(true);
    expect(bodies[0].max_tokens).toBeLessThanOrEqual(1024);
    expect(bodies[0].temperature).toBe(0);
  });

  it('a judge slower than its budget is dropped: null within the budget, and a log line', async () => {
    process.env.WHISPERS_TONE_JUDGE_MS = '80';
    vi.stubGlobal('fetch', vi.fn((_url: string, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = Date.now();
    const v = await llmToneJudge(MENACE, 'ruling');
    expect(v).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/timed out.*fail-open/);
    warn.mockRestore();
  });

  it('a proxy error fails open too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 400 })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await llmToneJudge(MENACE, 'narration')).toBeNull();
    warn.mockRestore();
  });
});

describe('1e. the bleak close is quoted by its own words', () => {
  it('the sentence bleakEnding reads as bleak, not just the last one', () => {
    expect(closingWords('SPOKEN: "We did it, Mom."\nTHOUGHT: I am grateful, even if we are stuck here until the puddle dries. Tomorrow is another day.'))
      .toBe('I am grateful, even if we are stuck here until the puddle dries.');
  });
});

// ─── 2. The correction line ─────────────────────────────────────────────────

describe('2. "…in the filing cabinet.". But the victory isn\'t clean — something slips, cracks, or shifts"', () => {
  const LIVE = 'Clerk Ozymandias leans in, his spectacles fogging slightly, and whispers, "Ah, a signature of trust; I had forgotten how rare those are in the filing cabinet."';

  it('a beat after a closing quote is joined with a space, never ".". "', () => {
    expect(appendBeat(LIVE, 'It works.')).toBe(`${LIVE} It works.`);
    expect(appendBeat('He whispers, “Of course.”', 'It works.')).toBe('He whispers, “Of course.” It works.');
    expect(appendBeat('The door opens', 'It works.')).toBe('The door opens. It works.');
    expect(appendBeat('He says, "wait"', 'It works.')).toBe('He says, "wait". It works.');
    expect(appendBeat('The door opens!  ', 'It works.')).toBe('The door opens! It works.');
    expect(appendBeat('', 'It works.')).toBe('It works.');
  });

  it('no correction line reads like a template ("slips, cracks, or shifts") or bruises a child', () => {
    for (const p of ['she/her', 'they/them', null]) {
      const all = Object.values(outcomeLines('Biz', p).correction).flat();
      for (const line of all) {
        expect(line).not.toMatch(/\b\w+, \w+, or \w+\b/);
        expect(line).not.toMatch(/bruise|blood|wound/i);
      }
    }
  });

  it('each correction family has enough variants to rotate', () => {
    const c = outcomeLines('Liz', 'she/her').correction;
    for (const k of ['tie', 'success-with-cost', 'failure'] as const) expect(c[k].length).toBeGreaterThanOrEqual(6);
  });
});

// ─── 3. Stock lines ─────────────────────────────────────────────────────────

const WHO: Array<{ name: string; trouble: string; aspect: string }> = [
  { name: 'Liz', trouble: 'I worry about Biz too much', aspect: 'Unflappable Accountant Mom' },
  { name: 'Biz', trouble: 'Wanders off after anything shiny', aspect: 'Curious Kid Collector' },
];
const skeleton = (line: string) => {
  let out = line;
  for (const w of WHO) out = out.split(w.trouble).join('T').split(w.aspect).join('A').split(w.name).join('N');
  return out;
};
/** Every run of four words that is not a placeholder: what a reader recognises as "that line again". */
const fourGrams = (line: string) => {
  const words = skeleton(line).toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(w => w && !['n', 't', 'a'].includes(w));
  const out = new Set<string>();
  for (let i = 0; i + 4 <= words.length; i++) out.add(words.slice(i, i + 4).join(' '));
  return out;
};

describe('3. no stock line or stock phrase comes round again, for either character', () => {
  it('the live repeats: "But fate is generous to those it tests." came back for Biz after Liz, and so did "the pull of old habits" and "rears its head"', () => {
    const lines = new LineRotation();
    const said: string[] = [];
    // The live order: Biz, Liz, Liz, Biz, … — 15 compels.
    for (let i = 0; i < 15; i++) {
      const w = WHO[[1, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 0][i]!]!;
      said.push(lines.pick('compel', compelLines(w.name, w.trouble)));
    }
    const shapes = said.map(skeleton);
    expect(new Set(shapes).size).toBe(shapes.length);
    // Round 15 retired this one: it read as a template (test/r15-tone.test.ts, 6).
    expect(said.filter(l => l.includes('fate is generous to those it tests'))).toHaveLength(0);
    // Round 17 retired "the pull of old habits … a small mercy" (test/r17-tone.test.ts, 6b).
    expect(said.filter(l => l.includes('the pull of old habits'))).toHaveLength(0);
    expect(said.filter(l => l.includes('rears its head'))).toHaveLength(1);
  });

  it('~20 compels and ~20 invokes across two characters: every line new, and no four-word stock phrase said twice', () => {
    const lines = new LineRotation();
    const said: string[] = [];
    for (let i = 0; i < 20; i++) {
      const w = WHO[(i * 7 + (i >> 2)) % 2]!;
      said.push(lines.pick('compel', compelLines(w.name, w.trouble), said.join('\n')));
      said.push(lines.pick('invoke', invokeLines(w.name, w.aspect), said.join('\n')));
    }
    expect(said.every(Boolean)).toBe(true);
    expect(new Set(said.map(skeleton)).size).toBe(said.length);
    const seen = new Map<string, string>();
    for (const line of said) {
      for (const g of fourGrams(line)) {
        expect(seen.get(g), `"${g}" in both:\n  ${seen.get(g)}\n  ${line}`).toBeUndefined();
        seen.set(g, line);
      }
    }
  });

  it('within each family, no two variants share a four-word phrase (no shared suffix fragments)', () => {
    for (const family of [compelLines('N', 'T'), invokeLines('N', 'A'), ...Object.values(outcomeLines('N', 'she/her').correction)]) {
      const owner = new Map<string, number>();
      family.forEach((line, i) => {
        for (const g of fourGrams(line)) {
          expect(owner.get(g) ?? i, `"${g}" shared:\n  ${family[owner.get(g) ?? i]}\n  ${line}`).toBe(i);
          owner.set(g, i);
        }
      });
    }
  });

  it('once every variant has been said, a compel or invoke says nothing rather than repeat one', () => {
    const lines = new LineRotation();
    const n = compelLines('Liz', 'x').length;
    const said = Array.from({ length: n + 3 }, (_, i) => lines.pick('compel', compelLines(WHO[i % 2]!.name, WHO[i % 2]!.trouble), '', { whenSpent: 'skip' }));
    expect(new Set(said.slice(0, n)).size).toBe(n);
    expect(said.slice(n)).toEqual(['', '', '']);
  });

  it('the memory survives a resume: snapshot → restore carries what was said', () => {
    const a = new LineRotation();
    const first = Array.from({ length: 5 }, () => a.pick('compel', compelLines('Liz', WHO[0]!.trouble)));
    const b = new LineRotation();
    b.restore(JSON.parse(JSON.stringify(a.snapshot())));
    const next = Array.from({ length: 5 }, () => b.pick('compel', compelLines('Biz', WHO[1]!.trouble)));
    const shapes = [...first, ...next].map(skeleton);
    expect(new Set(shapes).size).toBe(10);
    // A garbled snapshot is ignored, not thrown on.
    expect(() => new LineRotation().restore({ compel: 'nope' } as any)).not.toThrow();
    expect(() => new LineRotation().restore(undefined)).not.toThrow();
  });
});

// ─── 4. Who the party has met ───────────────────────────────────────────────

describe('4. "I am Clerk Ozymandias," in scene 3 — the DM is told who the party has met', () => {
  it('NPCs named in the story so far, in any of the ways prose names them', () => {
    const npcs = ['Clerk Ozymandias', 'Mama Pigeon', 'Button', 'The Archivist'];
    const story = ['Clerk Ozymandias’s glasses slide down his nose.', 'A pigeon waddles past. Mama Pigeon clucks.'];
    expect(npcsMet(npcs, story)).toEqual(['Clerk Ozymandias', 'Mama Pigeon']);
    expect(npcsMet(npcs, ['Ozymandias sighs.'])).toEqual(['Clerk Ozymandias']);
    expect(npcsMet(npcs, [])).toEqual([]);
  });

  it('the block tells the DM nobody introduces themselves twice', () => {
    const b = metNpcsBlock(['Clerk Ozymandias', 'Mama Pigeon']);
    expect(b).toContain('The party has already met: Clerk Ozymandias, Mama Pigeon.');
    expect(b).toMatch(/introduces themselves again/);
    expect(metNpcsBlock([])).toBe('');
  });
});

// ─── 5. Biz's words for Liz ─────────────────────────────────────────────────

describe('5. "I am safe in Liz\'s grip" — Biz calls Liz "Mom" in the body of the reflection too', () => {
  const BIZ = { name: 'Biz', pronouns: 'they/them', relationships: [{ to: 'Liz', relation: 'mother' }] };
  const LIZ = { name: 'Liz', pronouns: 'she/her', relationships: [{ to: 'Biz', relation: 'kid' }] };
  const opts = { self: BIZ, members: [LIZ, BIZ], familyTable: true, addressTerms: [{ name: 'Liz', address: 'Mom' }] };

  it('the live thought', () => {
    const r = publicReflection('SPOKEN: "We found the lanyard!"\nTHOUGHT: I am safe in Liz\'s grip, and the bottle caps are still in my pocket.', opts);
    expect(r.thought).toBe('I am safe in Mom\'s grip, and the bottle caps are still in my pocket.');
  });

  it('references in the spoken line too, and a stacked "Mom, Liz" is just "Mom"', () => {
    expect(publicReflection('SPOKEN: "I stayed right next to Liz the whole time."\nTHOUGHT: Mom, Liz, is the best.', opts))
      .toEqual({ spoken: 'I stayed right next to Mom the whole time.', thought: 'Mom is the best.' });
  });

  it('a derived term ("mother" → "Mom", not on the sheet) works as well', () => {
    const r = publicReflection('SPOKEN: "Home."\nTHOUGHT: Liz held my hand.', { ...opts, addressTerms: [{ name: 'Liz', address: 'Mom', derived: true }] });
    expect(r.thought).toBe('Mom held my hand.');
  });

  it('Liz\'s own reflection keeps "Biz" (her word for Biz is their name), and a lower-case term ("my kid") is never swapped in', () => {
    const r = publicReflection('SPOKEN: "Stay close, Biz."\nTHOUGHT: Biz was brave today.', { self: LIZ, members: [LIZ, BIZ], familyTable: true, addressTerms: [{ name: 'Biz', address: 'my kid' }] });
    expect(r.thought).toBe('Biz was brave today.');
  });
});

// ─── 7. Readiness ───────────────────────────────────────────────────────────

describe('7. a sheet whose skills are all +0 is not finished (the readiness panel hid itself)', () => {
  const sheet = {
    name: 'Biz', highConcept: 'Curious Kid Collector', trouble: 'Wanders off after anything shiny',
    aspects: ['A pocket full of bottle caps', 'Mom is my home base'], stunts: ['Tiny and Quick — slips through gaps grown-ups can\'t'],
    pronouns: 'they/them',
  };
  it('the live sheet: Notice 0, Stealth 0, Athletics 0, Rapport 0', () => {
    const r = checkCharacterReadiness({ ...sheet, skills: { Notice: 0, Stealth: 0, Athletics: 0, Rapport: 0 } });
    expect(r.ready).toBe(false);
    expect(r.unmet).toContain('skills');
    expect(r.detail.join(' ')).toMatch(/above \+0/);
  });
  it('one rated skill is enough', () => {
    expect(checkCharacterReadiness({ ...sheet, skills: { Notice: 4, Stealth: 0 } }).ready).toBe(true);
  });
});
