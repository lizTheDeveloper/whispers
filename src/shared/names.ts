/**
 * The short name a person is called by (round 22, live BH9P94): "Sir Aldric
 * Vey" is "Aldric", never "Sir" — the story said "Sir's jaw clenches" seven
 * times and the character chat "your relationship with Sir", because every
 * short name was the first token. Honorifics, ranks, titles and a leading
 * article are skipped; a name that is nothing but titles is kept as given.
 */

/** Words that are never the part of a name someone is called by. Lower case, without a trailing period. */
export const NAME_TITLES: ReadonlySet<string> = new Set([
  // Articles ("the Widow Marrow").
  'the', 'a', 'an',
  // Honorifics.
  'sir', 'ser', 'dame', 'lady', 'lord', 'mr', 'mrs', 'ms', 'mx', 'miss', 'mister', 'missus', 'madam', 'madame', 'mistress', 'master',
  'monsieur', 'mademoiselle', 'señor', 'senor', 'señora', 'senora', 'herr', 'frau',
  // Nobility.
  'king', 'queen', 'prince', 'princess', 'duke', 'duchess', 'count', 'countess', 'baron', 'baroness', 'marquis', 'marquess', 'viscount', 'emperor', 'empress',
  // Learned and religious.
  'dr', 'doctor', 'professor', 'prof', 'reverend', 'rev', 'father', 'mother', 'sister', 'brother', 'friar', 'abbot', 'abbess', 'bishop', 'saint', 'st', 'elder', 'chief',
  // Ship and military ranks.
  'captain', 'capt', 'cap', 'bosun', 'boatswain', 'crewman', 'crewmate', 'first', 'second', 'third', 'mate', 'quartermaster', 'deckhand', 'sailor', 'seaman', 'midshipman', 'commodore',
  'admiral', 'commander', 'lieutenant', 'lt', 'sergeant', 'sgt', 'corporal', 'cpl', 'private', 'pvt', 'colonel', 'col', 'major', 'maj', 'general', 'gen', 'officer', 'ensign', 'marshal',
  // Offices.
  'sheriff', 'deputy', 'constable', 'inspector', 'detective', 'agent', 'warden', 'judge', 'magistrate', 'mayor', 'governor', 'senator', 'ambassador', 'chancellor',
]);

/** A word of a name, bare: no surrounding punctuation ("Dr." → "Dr"). */
function bare(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’-]+$/gu, '').replace(/[.]+$/, '');
}

/** Is this word an honorific or title ("Sir", "Dr.", "Bosun")? */
export function isNameTitle(word: string): boolean {
  return NAME_TITLES.has(bare(word).toLowerCase());
}

/** The words of a name that are not titles: "Sir Aldric Vey" → ["Aldric", "Vey"]. */
export function givenNameWords(fullName: string): string[] {
  return (fullName ?? '').trim().split(/\s+/).map(bare).filter(w => w && !NAME_TITLES.has(w.toLowerCase()));
}

/** "Sir Aldric Vey" → "Aldric"; "Captain Vane" → "Vane"; "Dr. Mira Osei" → "Mira"; "Pip" → "Pip"; "Sir" → "Sir". */
export function shortName(fullName: string): string {
  const name = (fullName ?? '').trim();
  if (!name) return name;
  return givenNameWords(name)[0] ?? bare(name.split(/\s+/)[0]!) ?? name;
}

/** Is `word` one of the given (non-title) words of `fullName`? ("Vey" of "Sir Aldric Vey": yes; "Sir": no.) */
export function isPartOfName(word: string, fullName: string): boolean {
  const w = bare(word ?? '').toLowerCase();
  return !!w && givenNameWords(fullName).some(g => g.toLowerCase() === w);
}
