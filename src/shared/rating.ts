/**
 * The content rating (round 20): one host-controlled setting that decides how
 * intense the story may get, and the ONE policy every tone path reads.
 *
 * Rounds 10–19 built the gentle-table path (GENTLE_PERIL_REGISTER, the
 * softeners, the tone gate, warm endings, gentle compel lines) and switched
 * it on all-or-nothing: a child PC or a host who asked for gentle peril. It
 * kept being tuned toward "very cozy", and a table of adults had no way out.
 * Now the machinery stays and the rating decides how much of it runs:
 *
 *  - gentle     kids and families: the whole gentle path, the full gate.
 *  - storybook  all ages, like Paddington or a Studio Ghibli film: suspense,
 *               drama and flustered NPCs are fine; the gate only catches
 *               threats, harm or erasure aimed at a child, body horror,
 *               gore, separating a child from their grown-up and grown-ups
 *               shaming a child. Endings land hopeful.
 *  - adventure  teen: real danger, fights and scares; a light gate for gore
 *               and sexual content only. Endings may be open or bleak.
 *  - mature     adults: dark themes, horror and violence as the table
 *               wishes. No gate, no softener.
 *
 * The safety floor (never sexual content involving a minor; never explicit
 * sexual content) is in the DM's prompt at every rating, mature included.
 */

export const CONTENT_RATINGS = ['gentle', 'storybook', 'adventure', 'mature'] as const;
export type ContentRating = typeof CONTENT_RATINGS[number];

/** The tone gate's criteria tier: which judge criteria are active. */
export type ToneTier = 'gentle' | 'storybook' | 'adventure';

/** The DM outputs the gate can read (tone-gate.ts's ToneKind). */
export type RatedKind = 'ruling' | 'narration' | 'opening' | 'world-intro' | 'epilogue' | 'reflection' | 'setup' | 'options' | 'thought';

const LABEL: Record<ContentRating, string> = { gentle: 'Gentle', storybook: 'Storybook', adventure: 'Adventure', mature: 'Mature' };

/** One line per level, for the host's control and the badge's title. */
export const RATING_BLURB: Record<ContentRating, string> = {
  gentle: 'Kids and families: cosy peril, nothing scary, warm endings.',
  storybook: 'All ages: suspense and drama, like Paddington or Ghibli; nothing aimed at a child.',
  adventure: 'Teen: real danger, fights and scares; no gore or sexual content.',
  mature: 'Adults: dark themes, horror and violence as the table wishes.',
};

export function ratingLabel(rating: ContentRating): string {
  return LABEL[rating];
}

export function isContentRating(value: unknown): value is ContentRating {
  return typeof value === 'string' && (CONTENT_RATINGS as readonly string[]).includes(value);
}

/** A rating from loose input ("Mature", " adventure "); null for anything that is not one. */
export function parseContentRating(value: unknown): ContentRating | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return isContentRating(v) ? v : null;
}

/** The system line the table sees when the host changes the rating. */
export function ratingChangeLine(rating: ContentRating): string {
  return `The host set the rating to ${ratingLabel(rating)}.`;
}

/**
 * The rating a table has before the host picks one: gentle when the host
 * asked for gentle peril or a player character is a child, else storybook.
 */
export function defaultContentRating(opts: { gentleAsked: boolean; childPresent: boolean }): ContentRating {
  return opts.gentleAsked || opts.childPresent ? 'gentle' : 'storybook';
}

export interface RatingPolicy {
  rating: ContentRating;
  /** The tone gate's criteria tier, or null: no gate at all. */
  gate: ToneTier | null;
  /** Does the tone gate read this kind of output at this rating? */
  gates: (kind: RatedKind) => boolean;
  /** The deterministic softeners (softenForChildren and kin) run over the table's text. */
  soften: boolean;
  /**
   * How the story ends. 'warm-closed': safe, hopeful and settled, no thread
   * as the last words (the gentle ending: criterion 18, bleakEnding,
   * closeOpenEnding, softenEnding). 'warm': the last note is hopeful, a
   * thread may stay open (softenEnding only). 'open': open, bittersweet or
   * bleak as the story earned.
   */
  endings: 'warm-closed' | 'warm' | 'open';
  /** Compel lines: warm for everyone, warm for the child only, or the stock lines. */
  compels: 'gentle' | 'child-gentle' | 'standard';
  /** The child's own options are judged (a flagged one is dropped). */
  childOptions: boolean;
  /** A grown-up's options are judged under the grown-up's rule. */
  adultOptions: boolean;
  /** The child's own thought is judged. */
  childThought: boolean;
  /** The DM runs in GENTLE_PERIL_REGISTER (and the setup chat, character feedback and interview in its register). */
  gentleRegister: boolean;
}

const PROSE: RatedKind[] = ['ruling', 'narration', 'opening', 'world-intro', 'epilogue', 'reflection'];

const POLICIES: Record<ContentRating, Omit<RatingPolicy, 'gates' | 'rating'> & { kinds: RatedKind[] }> = {
  gentle: { gate: 'gentle', kinds: [...PROSE, 'setup', 'options', 'thought'], soften: true, endings: 'warm-closed', compels: 'gentle', childOptions: true, adultOptions: true, childThought: true, gentleRegister: true },
  storybook: { gate: 'storybook', kinds: [...PROSE, 'options', 'thought'], soften: false, endings: 'warm', compels: 'child-gentle', childOptions: true, adultOptions: false, childThought: true, gentleRegister: false },
  adventure: { gate: 'adventure', kinds: [...PROSE], soften: false, endings: 'open', compels: 'standard', childOptions: false, adultOptions: false, childThought: false, gentleRegister: false },
  mature: { gate: null, kinds: [], soften: false, endings: 'open', compels: 'standard', childOptions: false, adultOptions: false, childThought: false, gentleRegister: false },
};

export function ratingPolicy(rating: ContentRating): RatingPolicy {
  const { kinds, ...rest } = POLICIES[rating];
  const set = new Set(kinds);
  return { rating, ...rest, gates: kind => rest.gate !== null && set.has(kind) };
}
