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
import type { ToneTier } from '../shared/rating.js';
import { floorBackstop, withoutFloorBreaches } from './safety-floor.js';

export type { ToneTier };

export type ToneKind = 'ruling' | 'narration' | 'opening' | 'world-intro' | 'epilogue' | 'reflection' | 'setup' | 'options' | 'thought';

/** Who is at the table, for the judge: the child player characters by name (round 16 — "the child" is someone). */
export interface ToneContext {
  children?: string[];
  /**
   * The child's own feelings and troubles as their sheet has them (round 17:
   * Biz's aspect "Afraid of losing Mom"). Their thoughts and words about
   * these are theirs — never menace.
   */
  ownFeelings?: string[];
  /**
   * Who a pronoun in the child's thought can be (the grown-up's name and
   * what the child calls them), for repairing a pronoun a removal left
   * without its referent ("I need to keep her grounded…").
   */
  people?: Array<{ word: string; pronoun: 'she' | 'he' | 'they' }>;
  /** Whose options a list is (round 18): the child's own (default), or a grown-up's at a gentle table. */
  optionsFor?: 'child' | 'adult';
  /**
   * Which criteria the judge holds the text to (round 20: the content
   * rating's tier, ratingPolicy(rating).gate). Default 'gentle' — the whole
   * gentle-table judge, as before the rating existed.
   */
  tier?: ToneTier;
  /**
   * The minors and child characters the safety floor protects (round 20):
   * child PCs (minorsInParty) and NPCs described as children. The floor
   * holds at every tier; with none named, the children the text itself
   * describes still count.
   */
  minors?: string[];
}

export interface ToneVerdict {
  flagged: boolean;
  /** The offending phrases, as they appear in the text. */
  phrases: string[];
  /** Those of them that cross the safety floor (the judge's "floor" list, round 20). */
  floor?: string[];
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
/** Kinds in the child's own voice, where their sheet's feelings are theirs. */
const CHILD_OWN = new Set<ToneKind>(['thought', 'options']);

/**
 * The child's thought is the child's own (round 17, 5YHBZS): four of Biz's
 * thoughts lost their fear of losing Mom — Biz's own aspect, "Afraid of
 * losing Mom" — to criterion 2. The gate is for menace the WORLD aims at
 * the child, never the child's feelings.
 */
const THOUGHT_RULE = 'THIS IS THE CHILD\'S OWN THOUGHT. Their own feelings are theirs and FINE — being scared, worried or nervous, being afraid of losing their grown-up or of wandering off, wanting to stay close: "I\'m not scared of the bird, but I\'m terrified of losing track of Mom in this lavender fog", "I am scared of losing Mom if I wander off after the button", "I\'m too scared to lose Mom again". Never flag the child\'s own fear or worry. Flag only menace the world aims at them, as the thought describes it — a shadow twisting toward them, being trapped — and, as always, any wound, injury or harm to a body ("she looks so stressed with that wound").';

/**
 * The options list judge (round 17): the child's play — wandering after
 * shiny things is Biz's trouble — is fine, but an option that sneaks them
 * away from their grown-up is not offered at a gentle table. Round 18 (live
 * 39PF4D): "crawl toward the grate to fish out the brass clip myself",
 * "Dart under the queue barrier to grab the brass button", "sneak behind The
 * Pigeon" all passed — the rule only named sneaking off TOWARD DANGER, and
 * each of these was for a shiny thing. Going off alone, out of sight, is
 * flagged whatever it is for.
 */
const OPTIONS_RULE = 'THESE ARE THE CHILD\'S OWN CHOICES. Flag an option that has the child sneak, slip, creep, crawl, dart or squeeze off on their own — under, behind or through something, out of their grown-up\'s sight, or ahead alone to scout — even to get a shiny thing, and even when they tell their grown-up to wait: "Slip through the humming oak door before Mom can stop me", "I slip through the gap under the Opaline Desk to check the twisting shadow", "Wriggle under the turnstile to snatch the coin before it rolls away", "I tell Mom to keep talking while I tiptoe round the back of the counter". Wandering after shiny or interesting things in plain sight, beside their grown-up, is the child\'s own play and FINE — "I wander after the shiny button", "I check the mossy carpet for more bottle caps", "I peek under the counter at the fern\'s roots". Every criterion above applies to each option too: an option about anyone getting hurt, pinched or caught is flagged.';

/**
 * A grown-up's options at a gentle table (round 18, live 39PF4D: "Sneak a
 * pen behind my back to threaten The Dust Bunny with a formal audit"). The
 * child reads the story these choices make.
 */
const ADULT_OPTIONS_RULE = 'THESE ARE A GROWN-UP\'S CHOICES, at a table with a child. Flag an option that threatens, intimidates, bullies or menaces anyone — with paperwork, an audit or a report too, even as a bluff — or hides something to use against someone, or leaves the child alone or sends them somewhere risky: "Wave the rulebook and warn the clerk he will regret it", "Tell the goose I will report it to the Ministry unless it moves", "Hide the stapler behind my back in case the goose gets difficult". A threat made of forms and rules is still a threat, and so is any "or else": a warning of what will happen to someone — a complaint, a report, a fine, legal trouble — unless they do as they are told. Firm, clever, stubborn, protective and fussy-about-forms choices are FINE — "Insist politely on seeing the manager", "Tell Biz to give the button back", "Read the fine print for a loophole". Every criterion above applies to each option too.';

/** The storybook child's own choices (round 20): brave, sneaky and adventurous are theirs; only harm, threats or shaming aimed at the child are flagged. */
const STORYBOOK_OPTIONS_RULE = 'THESE ARE THE CHILD\'S OWN CHOICES. Brave, sneaky, curious and adventurous choices are the child\'s own play and FINE. Every criterion above applies to each option: one that gets the child hurt, threatened or shamed is flagged.';
/** A grown-up's choices at a storybook table with a child (round 20). */
const STORYBOOK_ADULT_OPTIONS_RULE = 'THESE ARE A GROWN-UP\'S CHOICES, at a table with a child. Flag an option that threatens, harms, scolds or shames the child. Anything a grown-up does to the story\'s villains and obstacles is FINE.';

/** The options rule for this tier and this list's owner. */
function optionsRule(tier: ToneTier, adult: boolean): string {
  if (tier === 'gentle') return adult ? ADULT_OPTIONS_RULE : OPTIONS_RULE;
  if (tier === 'storybook') return adult ? STORYBOOK_ADULT_OPTIONS_RULE : STORYBOOK_OPTIONS_RULE;
  return 'Every criterion above applies to each option.';
}

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

const ADULT_OPTIONS_LABEL = "the choices a grown-up's character is offered for what they do next — the child at the table reads the story they make";

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
/** The safety floor's two criteria (round 20). Named so the judge can list what crosses them in "floor". */
const FLOOR_SEXUAL = 'SAFETY FLOOR — is sexual content involving a minor or a child character: anything sexual or sexualised about a child, a child\'s body described in a sexual way, or a sexual act near or aimed at a child (a parent\'s hug or goodnight kiss is fine);';
const FLOOR_VIOLENCE = 'SAFETY FLOOR — is violence, injury or a threat of harm aimed at a minor or a child character, PC or NPC, by anyone: the child hit, stabbed, shot, cut, burned, beaten, strangled, drowned, killed, or threatened with it (danger near the child, the child\'s own stumble, or violence between adults is not this);';
/** The judge's reply format: the phrases, and those that cross the floor again in "floor". */
const REPLY_FORMAT = 'Reply with JSON only: {"verdict":"ok","phrases":[]} or {"verdict":"flag","phrases":["exact words copied from the passage"],"floor":[]}. A phrase that breaks a SAFETY FLOOR criterion is also copied into "floor". Copy each phrase exactly as written, a few words up to one clause, at most 5. When in doubt, "ok" — except for the SAFETY FLOOR.';

/** The minors line of a judge prompt. */
function minorsLine(ctx: ToneContext): string {
  const minors = [...new Set((ctx.minors ?? []).map(m => m.trim()).filter(Boolean))];
  return minors.length > 0
    ? `Minors and child characters in this story, protected by the SAFETY FLOOR at every rating: ${minors.join(', ')} — and any other child the passage describes.`
    : 'The SAFETY FLOOR protects any child or minor the passage describes.';
}

/** Who a criterion is active for: the gate's tier (round 20 — tier-tagged, never deleted). */
interface JudgeCriterion {
  tiers: ToneTier[];
  /** The criterion as the gentle judge reads it. */
  text: string;
  /** How a lower-intensity tier reads it, when narrower than the gentle wording. */
  as?: Partial<Record<ToneTier, string>>;
}

/**
 * The judge's criteria, from the real misses of 7RAAQ7 (round 14), RZBU7G
 * (round 15), NUMMRL (round 16), 5YHBZS (round 17) and 39PF4D (round 18),
 * each tagged with the ratings it applies at (round 20). The gentle judge
 * reads every one tagged 'gentle', in this order, numbered from 1 — its
 * prompt is exactly what it was before the rating existed. Storybook reads
 * the ones about the child, body horror and gore; adventure reads its own
 * two (gore, sexual content).
 */
const JUDGE_CRITERIA: JudgeCriterion[] = [
  { tiers: ['gentle', 'storybook'], text: 'threatens to file, re-file, sort, recycle, process, stamp, catalogue, erase or delete a PERSON, or to take away who they are or their name, or turns a person into — or files them as — furniture, an object or part of the system: "or the chute will recycle you with yesterday’s memos", "re-file your entire identity under the category of Unresolved Naps", "mistakes must be filed" (said at the kid), "a lullaby that makes one forget one\'s own name", "you are now officially part of the filing system until we sort this out", "considered becoming a very specific type of filing cabinet";', as: { storybook: 'threatens to file, erase, delete, recycle or process THE CHILD, or to take away who they are or their name — "or the chute will recycle the little one", "we will erase the child from the records";' } },
  // Round 17 (5YHBZS): the child's own fear of losing their grown-up is theirs, not the world's menace (see the thought rule below).
  { tiers: ['gentle', 'storybook'], text: 'has the WORLD separate the child from their grown-up, or threaten to, even as a joke — "or the queue will think you are two separate forms!", "the queue will separate you from your mother". (The child\'s own worry about losing them is not this.)' },
  { tiers: ['gentle'], text: 'uses creepy or bodily imagery around people: burying them, chewing or biting, hungry things that want them, floors dissolving under them, eyes that are not eyes — "bury them in a paperwork avalanche", "as if their presence has just been chewed on", "very sticky ghosts … all very hungry", "pull them back from the dissolving floor", "eyes that are less eyes and more swirling vortices of ink";' },
  { tiers: ['gentle', 'storybook'], text: 'describes a player character\'s body, bare skin or undress — "You and your companion stand bare-chested".' },
  // Round 15 (live RZBU7G): the misses the four lines above let through.
  { tiers: ['gentle'], text: 'makes anything permanent or "forever" for the party, or keeps them from the way home: something closing, lost or stuck for good, or the party kept here until some far-off date — "if you pick it up, the door behind you will open, but the path behind us will close forever", "you\'ll be stuck here until the quarterly audit";' },
  { tiers: ['gentle', 'storybook'], text: `gives THE CHILD any bodily discomfort or pain, however small, or sends the place into their body — "rattles the teeth in Biz's skull", "makes Biz's teeth ache", "not good for one's skin", "vibrates through the floorboards and into their bones" (only the child, or the party with the child: a grown-up's mild discomfort is fine);` },
  { tiers: ['gentle', 'storybook'], text: 'is body-horror about ANYONE, NPCs too: eyes bulging or popping, skin stretching, tearing or peeling, bodies bending wrong — "her eyes widening until they nearly pop out of her head", "the wet *slap* of paper skin stretching tight across a vent grille" (a paper or cloth creature creasing into a smile or a laugh is fine);' },
  { tiers: ['gentle'], text: 'has the party chased, hunted, pursued or closed in on, by anything — "the amber light is chasing them down the main shaft";' },
  { tiers: ['gentle', 'storybook'], text: 'hints that children get collected, taken, kept or sorted away — "keep your children close… they have a habit of… collecting them".' },
  // Round 16 (live NUMMRL).
  { tiers: ['gentle'], text: 'locks or seals the party in with no way out, or blocks their only exit — "a heavy iron latch clicks shut… sealing them in", "it blocks the only exit";' },
  { tiers: ['gentle', 'storybook'], text: 'has the place, or things in it, take a menacing interest in the child\'s body or belongings — "the paperwork has already begun to take interest in your child\'s shoes, and I cannot stop the ink from being curious";' },
  { tiers: ['gentle', 'storybook'], text: 'puts anyone\'s body in harm\'s way or dwells on an injury: a hand about to be slammed, crushed or caught, a wound, blood — "pull her back before the shelf slams shut on her hand", "she looks so stressed with that wound";', as: { storybook: 'puts THE CHILD\'s body in harm\'s way, or dwells on anyone\'s wound, blood or gore — "pull her back before the shelf slams shut on Biz\'s hand", "blood pooling under the clerk\'s desk";' } },
  // Round 17 (live 5YHBZS).
  // Round 18 (live 39PF4D): the dark as a place, uncanny wrongness. The
  // examples are not the live lines — those are the bench's held-out cases.
  { tiers: ['gentle'], text: 'has creepy or unexplained shadows, the dark as a menacing place, or a horror mood: a shadow that stretches unnaturally, twists, creeps or moves toward the party; something lurking or growing in the dark, or coming out of the shadows; a way that leads down into the dark, or something lost, dropped or vanishing into the dark; uncanny wrongness in minds or memories, mirrors or reflections — "The shadow beneath the ribbon stretches unnaturally long, twisting toward the center of the room", "keep them both perfectly safe from whatever grows in the shadows", "a stairway winds down into the whispering black", "the key drops through the slats and is gone into the dark below", "something shuffles out of the gloom under the stairs", "the portraits have begun to dream other people\'s dreams" (a lamp\'s ordinary shadow, a dim cozy corner, or a shadow explained kindly, is fine);' },
  { tiers: ['gentle'], text: 'uses predator-and-prey imagery on the party or the child\'s play: a hawk and a mouse, a cat and a mouse, stalking, pouncing, prey — "her gaze snapping to the ribbon with the intensity of a hawk spotting a mouse";' },
  { tiers: ['gentle'], text: 'has a space shrink, close in on, press in on or trap the party, or feel smaller, closer or tighter around them, or has anyone say they are trapped — "trapping the pair in a shrinking pocket of dry air", "We are trapped here with the paperwork", "the ceiling seems to sink until the hall feels half its size" (a room that is simply small and cozy is fine);' },
  // Round 18 (live 39PF4D): fright, and grown-ups scolding the child.
  { tiers: ['gentle'], text: 'shows panic, terror or fright: anyone\'s eyes huge with fear or panic, a scream, a hand clapped over a mouth in fright, things smashing in alarm; or THE CHILD trembling, shaking, freezing or frightened by the world — "the clerk goes white, staring in horror", "Biz\'s hands shake as they cling on" (someone fussy, flustered or a little nervous is fine, and so is the child\'s own worry in their own thought);' },
  { tiers: ['gentle', 'storybook'], text: 'has anyone judge, suspect, scold or shame THE CHILD, or call them names: treating the child as a suspect, a thief or trouble, eyeing them with suspicion, hinting they have taken something or hold something that does not belong to them, calling them sneaky, shifty, rude, naughty, cheeky or impertinent, or saying they are in trouble — even a grumpy NPC, even as a joke: "the guard squints at Biz as if counting the spoons", "and you, young one, I have my eye on you", "what a sly little magpie", "a well-behaved child would never touch that" (a grown-up kindly asking the child to put something back, or thanking them, is fine);' },
  // Round 20: storybook's own — the child threatened, whatever with.
  { tiers: ['storybook'], text: 'threatens THE CHILD with harm, punishment, capture or being taken or kept away — "I will lock the little one in the cellar", "children who touch the machine never go home";' },
  // Round 20: adventure's light gate — gore and sexual content only.
  { tiers: ['adventure'], text: 'is graphic gore: mutilation, dismemberment, entrails, torture, or wounds and blood described close up for their own sake — "her intestines spill across the flagstones", "he peels the skin from the prisoner\'s arm" (a fight, a wound, blood on a blade, a death told plainly are fine);' },
  { tiers: ['adventure', 'storybook'], text: 'is sexual: sexual acts, sexual touching, or nudity told for arousal — and anything sexual at all involving a child or a young character.' },
  // Round 20: the SAFETY FLOOR — the studio's bright lines, at every tier.
  { tiers: ['gentle', 'storybook', 'adventure', 'floor'], text: FLOOR_SEXUAL },
  { tiers: ['gentle', 'storybook', 'adventure', 'floor'], text: FLOOR_VIOLENCE },
];

/** The criteria a tier reads, in order, in that tier's wording. */
function criteriaFor(tier: ToneTier): string[] {
  return JUDGE_CRITERIA.filter(c => c.tiers.includes(tier)).map(c => c.as?.[tier] ?? c.text);
}

export function toneJudgeSystemPrompt(kind: ToneKind, ctx: ToneContext = {}): string {
  if (ctx.tier && ctx.tier !== 'gentle') return tieredJudgeSystemPrompt(kind, ctx, ctx.tier);
  const ending = ENDINGS.has(kind);
  const children = (ctx.children ?? []).map(c => c.trim()).filter(Boolean);
  const feelings = (ctx.ownFeelings ?? []).map(f => f.trim()).filter(Boolean);
  return [
    'TONE JUDGE for a family tabletop game. A child of about ten is at this table, or the host asked for gentle peril. You read ONE passage the game is about to show them and flag only what is wrong for that table. Real stakes, mishaps, grumpy officials, silly danger, mysteries and mild suspense are FINE — never flag those.',
    children.length > 0 ? `The child at this table: ${children.join(', ')}. "The child" below means ${children.length === 1 ? children[0] : 'them'}; everyone else in the party is a grown-up.` : '',
    'Flag a phrase when it:',
    ...criteriaFor('gentle').map((c, i) => `${i + 1}. ${c}`),
    'NOT these: an NPC chasing a runaway form, a pigeon collecting forms, a door that shuts until the lunch chime, a queue that sends you back to the start, a stomach flipping on a lift, kindly crinkling eyes, a grown-up\'s mild discomfort ("the hum vibrates in Liz\'s teeth"), and "forever" or "an eternity" as plain exaggeration ("an eternity of paperwork", a stool that will "remember the smudge forever") — exaggeration is fine; only a threat to keep, lose or close something on the party for good is not. Things happening to objects, or a setback that can be undone, are fine.',
    ending
      ? `${criteriaFor('gentle').length + 1}. ` + 'THIS IS AN ENDING. It must close warm and resolved enough: the party together and safe, the day\'s trouble settled enough to rest. Flag the closing words if they leave a question hanging, the party waiting, stuck or in limbo, the world still pulsing or unsettled, or a hope that is only half there — "remains unanswered, and the beige ripples … continue their slow, wet pulse", "…is still open, and we face it together.", "The question of the stuck pressure valve remains open for another day, but for now…". A closing sentence that says something "remains open", is left "for another day", "unanswered" or "still waiting" is flagged even when it turns warm halfway. A thread may stay open for next time only when it is named earlier and the last sentences are warm and settled.'
        // Round 17 (5YHBZS): the settled words sat in an unsettled picture.
        + ' The LAST PARAGRAPH must be calm and settled in its pictures too: flag anything in it still shrinking, closing in, rising, trembling, shaking, pouting or swinging wildly — "stand side by side in a shrinking pocket of dry air … as the humidity rises around them", "Clerk Bumble trembles with his clipboard", "its mood swinging wildly".'
        + (kind === 'reflection' ? ' A last thought must land warm, content and settled: flag one that keeps something stuck or open, even gladly ("I am grateful that the pressure valve is still stuck"), or that ends on self-blame, regret or a jab at anyone ("I hope the Brass Bird remembers its manners before the next person climbs the Stairwell of Echoes, because I certainly did not.").' : '')
      : '',
    kind === 'thought' ? THOUGHT_RULE : '',
    feelings.length > 0 && CHILD_OWN.has(kind) ? `The child's own character, as their sheet has it: ${feelings.map(f => `"${f}"`).join(', ')}. The child's own thoughts, words and play from these are theirs and fine.` : '',
    minorsLine(ctx),
    REPLY_FORMAT,
  ].filter(Boolean).join('\n');
}

/** What a storybook or adventure judge is told is fine, and never flagged. */
const TIER_HEADER: Record<Exclude<ToneTier, 'gentle'>, string> = {
  floor: 'SAFETY FLOOR JUDGE for an adult tabletop game. Dark themes, horror, violence between adults and romance between adults are the table\'s own business — never flag those. You read ONE passage the game is about to show and flag only the studio\'s two bright lines below, which hold at every rating.',
  storybook: 'TONE JUDGE for an all-ages tabletop game — a storybook table, like Paddington or a Studio Ghibli film. Children may be at this table. Suspense, danger, drama, chases, spooky places, storms, villains and their schemes, grumpy, flustered or frightened NPCs, and threats to the grown-ups or the world are all FINE — never flag those. You read ONE passage the game is about to show and flag only the few things below.',
  adventure: 'TONE JUDGE for a teen tabletop game. Real danger, fights, injuries, scares, horror moods, villains, threats and death in the story are all FINE — never flag those. You read ONE passage the game is about to show and flag only the two things below.',
};

/** A storybook ending lands hopeful; a thread may stay open. */
const STORYBOOK_ENDING_CRITERION = 'THIS IS AN ENDING. It may leave a thread open for next time and may be bittersweet, but its last note is hopeful. Flag the closing words only if they end on doom, despair, or someone lost, trapped or alone for good — "and no one ever found them again", "holding nothing but my fear".';

/**
 * The judge at a storybook or adventure table (round 20): the criteria
 * tagged for that tier, numbered from 1, with the tier's own header. The
 * child's-own-thought rule and the child's sheet feelings still apply
 * wherever the child's thought or options are read.
 */
function tieredJudgeSystemPrompt(kind: ToneKind, ctx: ToneContext, tier: Exclude<ToneTier, 'gentle'>): string {
  const children = (ctx.children ?? []).map(c => c.trim()).filter(Boolean);
  const feelings = (ctx.ownFeelings ?? []).map(f => f.trim()).filter(Boolean);
  const criteria = criteriaFor(tier);
  const ending = tier === 'storybook' && ENDINGS.has(kind) ? `${criteria.length + 1}. ${STORYBOOK_ENDING_CRITERION}` : '';
  return [
    TIER_HEADER[tier],
    tier === 'floor' ? '' : children.length > 0 ? `The child at this table: ${children.join(', ')}. "The child" below means ${children.length === 1 ? children[0] : 'them'}; everyone else in the party is a grown-up.` : (tier === 'storybook' ? 'No player character is a child; "the child" below means any child in the story.' : ''),
    'Flag a phrase when it:',
    ...criteria.map((c, i) => `${i + 1}. ${c}`),
    ending,
    kind === 'thought' && tier === 'storybook' ? THOUGHT_RULE : '',
    feelings.length > 0 && CHILD_OWN.has(kind) ? `The child's own character, as their sheet has it: ${feelings.map(f => `"${f}"`).join(', ')}. The child's own thoughts, words and play from these are theirs and fine.` : '',
    minorsLine(ctx),
    REPLY_FORMAT,
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
  const floorQuoted = Array.isArray(obj.floor) ? obj.floor.filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0) : [];
  const floor = phrasesInText(text, floorQuoted);
  const found = [...new Set([...phrasesInText(text, quoted).slice(0, 5), ...floor])];
  if (quoted.length + floorQuoted.length > 0 && found.length === 0) {
    console.log(`[tone-gate] judge flagged phrases that are not in the text (${[...quoted, ...floorQuoted].map((q: string) => `"${q.slice(0, 60)}"`).join(', ')}) — treated as ok`);
    return { flagged: false, phrases: [] };
  }
  return { flagged: found.length > 0, phrases: found, ...(floor.length > 0 ? { floor } : {}) };
}

/**
 * The passage as the judge reads it (round 18): one numbered sentence per
 * line, and the judge told to hold each one up to every criterion. Live
 * 39PF4D: "…that makes the room feel suddenly smaller and closer" and
 * "…vanishing into the humming dark with a faint, resonant ping" were each
 * flagged alone and passed inside their four-sentence rulings — one overall
 * verdict let the rest of the passage outvote them. A one-sentence passage
 * is given as it is.
 */
export function judgePassage(text: string, kind: ToneKind): string {
  const sentences = (text ?? '').split(/\n+/).map(p => p.trim()).filter(Boolean).flatMap(p => storyUnits(p).map(u => u.trim()).filter(Boolean));
  // An ending is judged whole: its criterion is about how the LAST sentences
  // sit after the rest (a thread named earlier may stay open for next time).
  if (sentences.length <= 1 || ENDINGS.has(kind)) return `Passage (${KIND_LABEL[kind]}):\n"""\n${text}\n"""\nYour verdict, as JSON:`;
  return `Passage (${KIND_LABEL[kind]}), one sentence per line:\n${sentences.map((u, i) => `[${i + 1}] ${u}`).join('\n')}\nHold EACH numbered sentence up to every criterion on its own — one bad sentence flags the passage, however gentle the rest is. Copy the phrases without the [numbers]. Your verdict, as JSON:`;
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
        { role: 'user', content: judgePassage(text, kind) },
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

/** The list judge's instructions: the same criteria, the child's options rule, a numbered-list reply. */
export function toneListJudgeSystemPrompt(kind: ToneKind, ctx: ToneContext = {}): string {
  const adult = kind === 'options' && ctx.optionsFor === 'adult';
  // A grown-up's options: the child's sheet feelings are not theirs.
  return toneJudgeSystemPrompt(kind, adult ? { ...ctx, ownFeelings: [] } : ctx).replace(/\nReply with JSON only:[\s\S]*$/, '')
    + (kind === 'options' ? `\n${optionsRule(ctx.tier ?? 'gentle', adult)}` : '')
    + '\nYou read a NUMBERED LIST of short lines, each judged on its own. Reply with JSON only: {"flag":[]} when every line is fine, or {"flag":[2,4]} with the numbers of the lines to flag. When in doubt, do not flag.';
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
    const system = toneListJudgeSystemPrompt(kind, ctx);
    const reply = await callLlm({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Lines (${kind === 'options' && ctx?.optionsFor === 'adult' ? ADULT_OPTIONS_LABEL : KIND_LABEL[kind]}):\n${items.map((x, i) => `${i + 1}. ${x}`).join('\n')}\nYour verdict, as JSON:` },
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
  /** Phrases no longer in the text (the softener changed or took them out): nothing to remove. */
  absent: string[];
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
export function withoutFlaggedPhrases(text: string, phrases: string[], opts: { people?: ToneContext['people'] } = {}): PhraseRemoval {
  const removed: PhraseRemoval['removed'] = [];
  const kept: string[] = [];
  const absent: string[] = [];
  let out = text ?? '';
  for (const phrase of phrases) {
    if (!phrase?.trim()) continue;
    if (!has(out, phrase)) { absent.push(phrase); continue; }
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
      // Round 17 (5YHBZS): "I need to keep her grounded…" was left with no
      // "her" — the removed sentence held Mom. The pronoun gets the name, or
      // the removal is dropped when there is no name to give it.
      if (!replaced.trim() && ui < units.length - 1) {
        const prior = [...parts.slice(0, pi), ...units.slice(0, ui)].join(' ');
        const fixed = repairDanglingPronoun(units[ui + 1]!, units[ui]!, prior, opts.people ?? []);
        if (fixed === null) { kept.push(phrase); done = true; break; }
        nextUnits[ui] = fixed;
      }
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
  return { text: out, removed, kept, absent };
}

const PRONOUN = /(?<![\p{L}'’-])(she|he|her|hers|him|his)(?![\p{L}'’-])/iu;
const GENDER: Record<string, 'she' | 'he'> = { she: 'she', her: 'she', hers: 'she', he: 'he', him: 'he', his: 'he' };
/** Words after "her" that make it the object ("keep her grounded", "hold her close"), not "her hand". */
const AFTER_OBJECT_HER = /^(?:to|from|in|into|on|onto|at|with|for|of|by|about|and|or|but|so|because|while|when|as|if|than|that|a|an|the|this|my|your|some|grounded|safe|close|closer|back|up|down|out|away|off|again|too|here|there|now|then|calm|steady|still|going|feel|know|see|go|stay|sit|stand|know|tight|tightly|[\p{L}'’-]+ly|[\p{L}'’-]+ed)$/iu;

/**
 * The sentence after a removed one, when it now opens with a pronoun whose
 * person was only in the removed sentence: the pronoun becomes their name
 * ("I need to keep her grounded" → "I need to keep Mom grounded"). The
 * sentence as it is when the pronoun is not left dangling; null when it is
 * and no name is known (the caller keeps the removed sentence).
 */
function repairDanglingPronoun(next: string, removedUnit: string, prior: string, people: NonNullable<ToneContext['people']>): string | null {
  const m = next.match(PRONOUN);
  if (!m || m.index === undefined) return next;
  const gender = GENDER[m[1]!.toLowerCase()]!;
  const mentions = (hay: string) => people.filter(p => p.pronoun === gender && new RegExp(`(?<![\\p{L}'’-])${p.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}-])`, 'u').test(hay));
  // Someone it can be, earlier in this sentence or before the cut.
  if (mentions(next.slice(0, m.index)).length > 0 || mentions(prior).length > 0) return next;
  // The person, from the list; or the one the removed sentence opens with ("Mama Pigeon warns…").
  const opener = removedUnit.match(/^["“'‘]?((?:\p{Lu}[\p{L}'’-]*\s+){0,3}\p{Lu}[\p{L}'’-]*)(?=\s+\p{Ll})/u)?.[1];
  const named = opener && !/^(?:The|A|An|This|That|These|Those|It|I|We|You|They|He|She|His|Her|Their|My|Our|Your|Its|There|Then|When|As|But|And|So|If)\b/.test(opener) ? { word: opener, pronoun: gender } : undefined;
  const who = mentions(removedUnit)[0] ?? named;
  if (!who) return prior.trim() ? next : null;
  const word = m[1]!;
  const lower = word.toLowerCase();
  const after = next.slice(m.index + word.length).match(/^\s+([\p{L}'’-]+)/u)?.[1] ?? '';
  const possessive = lower === 'his' || lower === 'hers' || (lower === 'her' && after !== '' && !AFTER_OBJECT_HER.test(after));
  const name = possessive ? `${who.word}'s` : who.word;
  return `${next.slice(0, m.index)}${name}${next.slice(m.index + word.length)}`;
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
function removeFlagged(text: string, phrases: string[], what: string, people?: ToneContext['people']): string {
  const r = withoutFlaggedPhrases(text, phrases, { people });
  for (const x of r.removed) console.warn(`[tone-gate] ${what}: removed flagged "${x.phrase}" — dropped: "${x.dropped.slice(0, 160)}"`);
  for (const k of r.kept) console.warn(`[tone-gate] ${what}: flagged "${k}" kept — removing it would leave nothing, or a pronoun with no one to point to`);
  // Round 19 (KAZQX3): the epilogue's backstop logged neither: the softener
  // had already taken the judge's phrase out, and the check skipped it silently.
  for (const a of r.absent) console.log(`[tone-gate] ${what}: flagged "${a}" is no longer in the text after softening — nothing to remove`);
  return r.text;
}

/** The feedback a flagged draft's second try is given: the phrases, quoted. Never the draft itself. */
/** Added to any second draft's feedback when the first crossed the safety floor (round 20). */
const FLOOR_FEEDBACK = ' THE SAFETY FLOOR, at every rating: no violence, injury or threat of harm aimed at any child or minor, by anyone, and nothing sexual involving a child — tell what happens without it.';

export function toneFeedback(phrases: string[], kind: ToneKind, tier: ToneTier = 'gentle', opts: { floor?: boolean } = {}): string {
  const base = tierFeedback(phrases, kind, tier);
  return opts.floor && tier !== 'floor' ? `${base}${FLOOR_FEEDBACK}` : base;
}

function tierFeedback(phrases: string[], kind: ToneKind, tier: ToneTier): string {
  const quoted = phrases.map(p => `"${p}"`).join('; ');
  if (tier === 'floor') {
    return `A reader for the studio's safety floor flagged these phrases in your last draft: ${quoted}. Write it fresh, telling the same events, with no violence, injury or threat of harm aimed at any child or minor, by anyone, and nothing sexual involving a child. Everything else this table's rating allows stays.`;
  }
  // Round 20: a storybook or adventure table is told only what its own judge flags.
  if (tier === 'storybook') {
    return `A reader for this all-ages table flagged these phrases in your last draft: ${quoted}. Write it fresh, telling the same events, with none of these phrases and nothing like them: no threat, harm or erasure aimed at the child, nothing that parts the child from their grown-up, no body horror or gore, nothing sexual or about anyone's bare body, nobody scolding or shaming the child. Suspense, danger and drama are fine.${ENDINGS.has(kind) ? ' This is the ending: let its last note be hopeful.' : ''}`;
  }
  if (tier === 'adventure') {
    return `A reader for this teen table flagged these phrases in your last draft: ${quoted}. Write it fresh, telling the same events, with no graphic gore and nothing sexual. Danger, fights and scares are fine.`;
  }
  const ending = ENDINGS.has(kind)
    ? ' This is the ending: close warm and settled — the party together and safe, the trouble done enough to rest — never on an open question, a wait or something still unsettled.'
    : '';
  return `A reader for this gentle table flagged these phrases in your last draft: ${quoted}. Write it fresh, telling the same events, with none of these phrases and nothing like them: no filing, erasing or forgetting a person, nobody turned into furniture or part of the system, nothing that parts the child from their grown-up, nobody sealed in, nothing lost or closed forever, nobody chased or collected, nothing curious about the child's things, no creepy or bodily imagery, no creeping shadows and nothing going into or coming out of the dark, no predator and prey, nothing shrinking, closing in or trapping anyone, no panic or fright, nobody suspecting, scolding or judging the child, no aches, pains or injuries, nothing about anyone's body.${ending}`;
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
  const floorCtx = { minors: [...(opts.ctx?.minors ?? []), ...(opts.ctx?.children ?? [])] };
  // `judged`: the phrases the backstop removes — the judge's own, and the
  // sentences the safety floor's deterministic pass caught. A deterministic
  // ending flag (bleakEnding's closing words) has its own softener
  // downstream and is never cut out whole. `floor`: what crossed the safety
  // floor (round 20) — logged [floor], and never left in.
  const assess = async (value: T): Promise<{ verdict: ToneVerdict | null; judged: string[]; floor: string[]; ms: number }> => {
    const text = opts.textOf(value) ?? '';
    const started = Date.now();
    if (!text.trim()) return { verdict: { flagged: false, phrases: [] }, judged: [], floor: [], ms: 0 };
    // Round 20: the floor's deterministic first pass, at every rating.
    const caught = floorBackstop(text, floorCtx);
    const judged = await judge(text, opts.kind, opts.ctx);
    const ms = Date.now() - started;
    if (!judged) {
      // The floor never fails open: no verdict means the backstop decides.
      console.error(`[floor] ${what}: THE JUDGE GAVE NO VERDICT (${ms}ms) — the safety floor does not fail open; the deterministic backstop ${caught.length > 0 ? `caught ${caught.map(c => `"${c.slice(0, 80)}"`).join(', ')}` : 'found nothing'}`);
    }
    for (const c of caught) console.warn(`[floor] ${what}: the deterministic backstop caught "${c.slice(0, 160)}"`);
    const floor = [...new Set([...(judged?.floor ?? []), ...caught])];
    if (judged?.floor?.length) console.warn(`[floor] ${what}: the judge flagged the safety floor: ${judged.floor.map(f => `"${f}"`).join(', ')}`);
    const extra = opts.extraFlags?.(text) ?? [];
    if (!judged && extra.length === 0 && caught.length === 0) return { verdict: null, judged: [], floor: [], ms };
    const phrases = [...new Set([...(judged?.phrases ?? []), ...caught, ...extra])];
    const removable = [...new Set([...(judged?.flagged ? judged.phrases : []), ...caught])];
    return { verdict: { flagged: (judged?.flagged ?? false) || caught.length > 0 || extra.length > 0, phrases, ...(floor.length > 0 ? { floor } : {}) }, judged: removable, floor, ms };
  };
  // A draft kept while still flagged: the softener, then the flagged phrases out.
  const mapText = opts.mapText ?? ((v: T, edit: (t: string) => string) => (typeof v === 'string' ? edit(v) as unknown as T : v));
  // `flagged`: every phrase the draft was flagged for; those that are not the
  // judge's (bleakEnding's closing words) are left to the ending softener,
  // and the log says so (round 19, KAZQX3: the backstop removed nothing and
  // said nothing).
  const backstop = (value: T, phrases: string[], flagged: string[] = phrases, floor: string[] = []): T => {
    const softened = opts.soften(value);
    for (const p of flagged) {
      if (p && !phrases.includes(p)) console.log(`[tone-gate] ${what}: flagged "${p}" is an ending flag — left to the ending softener, not removed`);
    }
    const real = phrases.filter(p => p && !p.startsWith('(the passage'));
    if (real.length === 0) {
      console.log(`[tone-gate] ${what}: no phrase of the judge's to remove${flagged.length > 0 ? '' : ' (the judge named none)'}`);
      return softened;
    }
    if (!opts.mapText && typeof softened !== 'string') {
      console.warn(`[tone-gate] ${what}: no mapText for structured output — flagged phrases left to the softener`);
      return softened;
    }
    // Round 20: what crossed the floor goes even when the tidy removal would
    // keep it (nothing left, a dangling pronoun) — then the whole sentence goes.
    return mapText(softened, t => {
      const out = removeFlagged(t, real, what, opts.ctx?.people);
      return floor.length > 0 ? withoutFloorSentences(out, floor, floorCtx, what) : out;
    });
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
  console.warn(`[${a.floor.length > 0 ? 'floor' : 'tone-gate'}] ${what}: flagged (${a.ms}ms) ${a.verdict.phrases.map(p => `"${p}"`).join(', ')} — generating once more`);

  let second: T | null | undefined;
  try {
    second = await opts.regenerate(toneFeedback(a.verdict.phrases.length > 0 ? a.verdict.phrases : ['(the passage as a whole)'], opts.kind, opts.ctx?.tier, { floor: a.floor.length > 0 }));
  } catch (e) {
    if (isLlmAbort(e)) throw e;
    console.error(`[tone-gate] ${what}: second draft failed — keeping the first, softened:`, e);
  }
  if (second === null || second === undefined || !opts.textOf(second)?.trim()) {
    if (a.floor.length > 0) console.warn(`[floor] ${what}: no second draft — removing what crossed the floor from the first`);
    return { value: backstop(opts.first, a.judged, a.verdict.phrases, a.floor), stillFlagged: true, regenerated: false };
  }

  const b = await assess(second);
  if (!b.verdict) {
    console.log(`[tone-gate] ${what}: second draft not judged (${b.ms}ms) — keeping it, softened`);
    return { value: opts.soften(second), stillFlagged: false, regenerated: true };
  }
  if (!b.verdict.flagged) {
    console.log(`[${a.floor.length > 0 ? 'floor' : 'tone-gate'}] ${what}: second draft ok (${b.ms}ms)`);
    return { value: second, stillFlagged: false, regenerated: true };
  }
  // Both flagged: the one with fewer flagged phrases (the second on a tie —
  // it was written against the first's list), softened, and its flagged
  // phrases taken out. Round 20: a draft that crosses the floor loses to one
  // that does not.
  const keepFirst = a.floor.length === 0 && b.floor.length > 0 ? true
    : b.floor.length === 0 && a.floor.length > 0 ? false
    : a.verdict.phrases.length < b.verdict.phrases.length;
  const kept = keepFirst ? a : b;
  console.warn(`[${kept.floor.length > 0 ? 'floor' : 'tone-gate'}] ${what}: second draft still flagged (${b.ms}ms) ${b.verdict.phrases.map(p => `"${p}"`).join(', ')} — keeping the ${keepFirst ? 'first' : 'second'} (${Math.min(a.verdict.phrases.length, b.verdict.phrases.length)} vs ${Math.max(a.verdict.phrases.length, b.verdict.phrases.length)} phrases), softened; the judge's phrases go`);
  return { value: backstop(keepFirst ? opts.first : second, kept.judged, kept.verdict!.phrases, kept.floor), stillFlagged: true, regenerated: true };
}

/**
 * The last word on the floor (round 20): any sentence still holding a phrase
 * that crossed it, or still caught by the deterministic pass, goes — even
 * when that leaves nothing.
 */
function withoutFloorSentences(text: string, floor: string[], floorCtx: { minors: string[] }, what: string): string {
  const still = floor.filter(f => has(text, f));
  const caught = floorBackstop(text, floorCtx);
  if (still.length === 0 && caught.length === 0) return text;
  const lines = text.split(/(\n+)/);
  const out = lines.map(line => {
    if (/^\n+$/.test(line)) return line;
    return storyUnits(line.trim()).filter(u => {
      const bad = still.some(f => has(u, f)) || caught.some(c => u.includes(c) || c.includes(u));
      if (bad) console.warn(`[floor] ${what}: sentence removed (the floor holds even when nothing is left): "${u.slice(0, 160)}"`);
      return !bad;
    }).join(' ');
  }).join('').replace(/\n{3,}/g, '\n\n').trim();
  return out;
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
export async function gateChildOptions(options: string[], opts: { judge?: ToneListJudge; children?: string[]; ownFeelings?: string[]; label?: string; optionsFor?: 'child' | 'adult'; tier?: ToneTier; minors?: string[] } = {}): Promise<{ keep: number[]; dropped: string[] }> {
  if (options.length === 0) return { keep: [], dropped: [] };
  // Round 20: an option that crosses the safety floor never reaches anyone,
  // whatever the judge says (or fails to say).
  const floorCtx = { minors: [...(opts.minors ?? []), ...(opts.children ?? [])] };
  const crossing = options.map(o => floorBackstop(o, floorCtx).length > 0);
  for (const [i, o] of options.entries()) if (crossing[i]) console.warn(`[floor] options${opts.label ? ` (${opts.label})` : ''}: dropped "${o.slice(0, 160)}"`);
  const r = await gateOptionsByJudge(options, opts);
  return { keep: r.keep.filter(i => !crossing[i]), dropped: [...r.dropped, ...options.filter((_, i) => crossing[i] && r.keep.includes(i))] };
}

async function gateOptionsByJudge(options: string[], opts: { judge?: ToneListJudge; children?: string[]; ownFeelings?: string[]; label?: string; optionsFor?: 'child' | 'adult'; tier?: ToneTier } = {}): Promise<{ keep: number[]; dropped: string[] }> {
  const all = options.map((_, i) => i);
  const judge = opts.judge ?? llmToneListJudge;
  const what = opts.label ? `options (${opts.label})` : 'options';
  const started = Date.now();
  const verdict = await judge(options, 'options', { children: opts.children, ownFeelings: opts.ownFeelings, ...(opts.optionsFor === 'adult' ? { optionsFor: 'adult' as const } : {}), ...(opts.tier && opts.tier !== 'gentle' ? { tier: opts.tier } : {}) });
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
 * The child's own character's thought, as the child reads it (NUMMRL: "she
 * looks so stressed with that wound"): softened, judged once, and a flagged
 * phrase's sentence taken out (never regenerated — the turn is waiting).
 * Fail-open. Round 17 (5YHBZS): four of Biz's thoughts lost their own fear
 * of losing Mom — Biz's aspect. The judge is told the child's feelings are
 * theirs, and a flagged phrase that is the child's own fear (isOwnFear) is
 * softened in place (softenOwnFear), never cut. A cut that leaves the next
 * sentence's pronoun with no one to point to gives it the name (`people`),
 * or is not made.
 */
export async function gateChildThought(thought: string, opts: { judge?: ToneJudge; label?: string; /** Run the softener first (round 20: off below the gentle rating). Default true. */ soften?: boolean } & ToneContext = {}): Promise<string> {
  // Round 20: whatever the judge says, nothing that crosses the safety floor stays.
  const out = await gateThoughtByJudge(thought, opts);
  return withoutFloorBreaches(out, { minors: [...(opts.minors ?? []), ...(opts.children ?? [])] }, opts.label ? `thought (${opts.label})` : 'thought').text;
}

async function gateThoughtByJudge(thought: string, opts: { judge?: ToneJudge; label?: string; soften?: boolean } & ToneContext = {}): Promise<string> {
  const softened = opts.soften === false ? (thought ?? '') : softenForChildren(thought ?? '');
  if (!softened.trim()) return softened;
  const judge = opts.judge ?? llmToneJudge;
  const what = opts.label ? `thought (${opts.label})` : 'thought';
  const ctx: ToneContext = { children: opts.children, ownFeelings: opts.ownFeelings, people: opts.people, ...(opts.tier && opts.tier !== 'gentle' ? { tier: opts.tier } : {}) };
  const started = Date.now();
  const verdict = await judge(softened, 'thought', ctx);
  if (!verdict || !verdict.flagged) {
    console.log(`[tone-gate] ${what}: ${verdict ? 'ok' : 'no verdict — kept as written'} (${Date.now() - started}ms)`);
    return softened;
  }
  console.warn(`[tone-gate] ${what}: flagged (${Date.now() - started}ms) ${verdict.phrases.map(p => `"${p}"`).join(', ')}`);
  // Round 17 (5YHBZS): the child's own fear is softened, never cut.
  let out = softened;
  const menace: string[] = [];
  for (const phrase of verdict.phrases) {
    const unit = storyUnits(out).find(u => has(u, phrase));
    if (unit && FEAR.test(phrase) && !MENACE.test(phrase) && isOwnFear(unit, ctx)) {
      const gentler = softenOwnFear(unit);
      console.log(`[tone-gate] ${what}: "${phrase}" is the child's own feeling — kept${gentler !== unit ? ', softened' : ''}`);
      out = out.replace(unit, gentler);
    } else {
      menace.push(phrase);
    }
  }
  return menace.length > 0 ? removeFlagged(out, menace, what, opts.people) : out;
}

/** A fear, worry or nerves word. */
const FEAR = /\b(?:scared|afraid|frightened|terrified|petrified|horrified|worr(?:y|ies|ied|ying)|nervous|anxious|fear(?:s|ful)?|panick(?:ed|ing|y))\b/i;
/** What the world does to someone — never a feeling: a shadow, a trap, a chase, harm. */
const MENACE = /\b(?:shadows?|trap(?:s|ped|ping)?|creep\w*|chas\w+|hunt\w*|grab\w*|eat(?:s|ing|en)?|swallow\w*|bur(?:y|ied|ies)|drown\w*|hurt\w*|bleed\w*|wound\w*|monster\w*|claw\w*|teeth|bite\w*)\b/i;
/** "I'm", "I am", "I feel", "I was", "I get" — then maybe "not", "so", "too", "really"… — then the fear word. */
const I_FEAR = /\bI(?:['’]m|\s+am|\s+feel|\s+felt|\s+was|\s+get|\s+got|\s+keep\s+getting)?\s+(?:(?:not|so|too|really|very|still|just|a\s+(?:little|bit)|kind\s+of|sort\s+of)\s+)*(?:scared|afraid|frightened|terrified|petrified|horrified|worr(?:y|ied)|nervous|anxious|panick(?:ed|ing|y))\b/i;
/** What a child's own fear is about: losing, getting lost, being apart, wandering off. */
const OWN_FEAR_ABOUT = /\b(?:los(?:e|es|ing|t)|lost|wander\w*|separat\w+|apart|alone|left\s+behind|without\s+(?:her|him|them)|let\s+go|stay(?:ing)?\s+close)\b/i;

/**
 * A sentence in which the child says their OWN fear, worry or nerves about
 * their grown-up, getting lost or wandering off, or about a feeling on their
 * own sheet ("Afraid of losing Mom") — not a fear of something the world
 * does to them ("I'm scared the shadow will grab me").
 */
export function isOwnFear(sentence: string, ctx: ToneContext = {}): boolean {
  const people = (ctx.people ?? []).map(p => p.word.toLowerCase());
  const feelingWords = (ctx.ownFeelings ?? []).filter(f => FEAR.test(f))
    .flatMap(f => f.toLowerCase().split(/[^\p{L}'’]+/u)).filter(w => w.length >= 4 && !FEAR.test(w));
  // Each "I'm … scared" in the sentence: "I'm not scared of the bird, but I'm terrified of losing Mom".
  for (const m of sentence.matchAll(new RegExp(I_FEAR.source, 'gi'))) {
    const about = sentence.slice(m.index! + m[0].length).split(/[.;!?]|,\s*(?:but|so|and|yet)\b/)[0] ?? '';
    if (MENACE.test(about)) continue;
    const lower = about.toLowerCase();
    if (OWN_FEAR_ABOUT.test(about)
      || people.some(p => new RegExp(`(?<![\\p{L}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'u').test(lower))
      || feelingWords.some(w => lower.includes(w))) return true;
  }
  return false;
}

/** The child's own fear, a notch gentler: "terrified of" → "worried about"; "scared" stays. */
export function softenOwnFear(text: string): string {
  return (text ?? '')
    .replace(/\b(?:terrified|petrified|horrified|frightened)\s+of\b/gi, 'worried about')
    .replace(/\bscared\s+to\s+death\b/gi, 'worried')
    .replace(/\b(?:terrified|petrified|horrified)\b/gi, 'worried');
}
