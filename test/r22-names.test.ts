// Round 22 (live BH9P94): "Sir Aldric Vey" was shortened to "Sir" — seven
// times in the story ("Sir's jaw clenches", "Sir braced…") and in the
// character chat ("your relationship with Sir"). Mara's sheet calls him
// "Aldric"; namesInNarration turned that address term into the "first name"
// of "Sir Aldric Vey", which was its first token, "Sir". The DM's party
// block also told it, as its worked example, that NPCs call him "Sir".
// Every short name skips honorifics and titles.
import { describe, it, expect } from 'vitest';
import { shortName, isPartOfName } from '../src/shared/names.js';
import { namesInNarration, repairAddress, ownWordsForCompanions, whisperInboxMessage } from '../src/server/narrative-guards.js';
import { guardInterviewReply } from '../src/server/pronoun-consistency.js';
import { describeParty } from '../src/server/agents/dm.js';
import { npcPronounInNarration } from '../src/server/whisper-suggestions.js';
import { partyPronounLine } from '../src/server/npc-pronouns.js';

describe('shortName skips honorifics and titles', () => {
  it.each([
    ['Sir Aldric Vey', 'Aldric'],
    ['Captain Vane', 'Vane'],
    ['Bosun Calloway', 'Calloway'],
    ['Dr. Mira Osei', 'Mira'],
    ['Dr Mira Osei', 'Mira'],
    ['Lady Ashford', 'Ashford'],
    ['Lord Tennant', 'Tennant'],
    ['Mr. Hark', 'Hark'],
    ['Ms Hark', 'Hark'],
    ['Mrs. Miller', 'Miller'],
    ['Mx Rowan Pike', 'Rowan'],
    ['Crewman Silas', 'Silas'],
    ['First Mate Grell', 'Grell'],
    ['the Widow Marrow', 'Widow'],
    ['Mara Kestrel', 'Mara'],
    ['Pip', 'Pip'],
    // Nothing but a title: the name as given.
    ['Sir', 'Sir'],
    ['  Captain  ', 'Captain'],
  ])('%s → %s', (full, want) => {
    expect(shortName(full)).toBe(want);
  });

  it('isPartOfName: any given word of the name', () => {
    expect(isPartOfName('Aldric', 'Sir Aldric Vey')).toBe(true);
    expect(isPartOfName('vey', 'Sir Aldric Vey')).toBe(true);
    expect(isPartOfName('Sir', 'Sir Aldric Vey')).toBe(false);
    expect(isPartOfName('Mom', 'Liz Parker')).toBe(false);
  });
});

describe('the live lines', () => {
  const MARA_CALLS_ALDRIC = [{ name: 'Sir Aldric Vey', address: 'Aldric' }];

  it('the story: "Aldric\'s jaw clenches" stays Aldric', () => {
    expect(namesInNarration('Aldric’s jaw clenches, the muscles in his neck straining.', MARA_CALLS_ALDRIC)).toBe('Aldric’s jaw clenches, the muscles in his neck straining.');
    expect(namesInNarration('Aldric braced against the rail.', MARA_CALLS_ALDRIC)).toBe('Aldric braced against the rail.');
  });

  it('the character chat: "your relationship with Aldric" stays Aldric', () => {
    const sheet = { name: 'Mara Kestrel', pronouns: 'she/her', relationships: [{ to: 'Sir Aldric Vey', relation: 'cellmate', address: 'Aldric' }, { to: 'Bosun Calloway', relation: 'customer', address: 'Kael' }] };
    const out = guardInterviewReply('Mara, you are locked in, with your relationship with Aldric noted as a wary cellmate.', sheet, [{ name: 'Sir Aldric Vey', pronouns: 'he/him' }]);
    expect(out).toContain('relationship with Aldric');
    expect(out).not.toMatch(/\bSir\b/);
  });

  it('an address term that is another word of the name is left alone', () => {
    expect(repairAddress('Vey, hold the door!', [{ name: 'Sir Aldric Vey', address: 'Vey' }], { vocative: true })).toBe('Vey, hold the door!');
    expect(ownWordsForCompanions('I trust Aldric now.', MARA_CALLS_ALDRIC)).toBe('I trust Aldric now.');
    // A real address term still works through the title: "Sir Aldric, help me" → "Knight, help me".
    expect(repairAddress('Aldric, help me!', [{ name: 'Sir Aldric Vey', address: 'Knight' }], { vocative: true })).toBe('Knight, help me!');
  });

  it('the DM party block never tells the DM he is called "Sir"', () => {
    const block = describeParty([
      { name: 'Sir Aldric Vey', highConcept: 'Disgraced Knight Seeking Redemption', trouble: 'Haunted by the Village He Failed', age: 41, pronouns: 'he/him' } as any,
      { name: 'Mara Kestrel', highConcept: 'Cutthroat Smuggler', trouble: 'Owes Blood Debts', age: 34, pronouns: 'she/her', relationships: [{ to: 'Sir Aldric Vey', relation: 'cellmate', address: 'Old Man' }] } as any,
    ]);
    // The full name in quotes is fine ("calls him \"Sir Aldric Vey\""); "Sir" as the short name is not.
    expect(block).not.toMatch(/"Sir(?! Aldric Vey")/);
    expect(block).not.toMatch(/\bSir's\b/);
    expect(block).toContain('"Aldric steps forward"');
    expect(block).toContain('"Aldric\'s trouble');
    expect(block).toContain('("Aldric" — never');
    expect(block).toContain('"Mara steadies Aldric"');
  });

  it('whisper acks, suggestions and pronoun lines use the given name', () => {
    expect(whisperInboxMessage('Sir Aldric Vey', null, 'queued')).toBe('Sir Aldric Vey will carry your whisper into Aldric\'s next choice.');
    expect(npcPronounInNarration('Captain Vane', 'Vane turns. He grips the rail.')).toBe('he');
    expect(partyPronounLine([{ name: 'Sir Rowan Ash', pronouns: 'they/them' }])).not.toMatch(/\bSir\b(?! Rowan)/);
  });
});
