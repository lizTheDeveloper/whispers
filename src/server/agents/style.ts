/**
 * Appended to every prompt whose output a player reads as prose. Players saw
 * raw **bold**, *italics*, bullet lists and headings in narration, actions and
 * thoughts. The client now renders a small safe subset of markdown, but the
 * table reads like a story, not a document, so the models are asked not to
 * format at all. For JSON prompts this applies to the prose inside the
 * string values.
 */
export const PLAIN_PROSE_STYLE =
  'Style: write plain prose, like a novel. No markdown formatting: no asterisks or underscores for emphasis, no headings, no bullet or numbered lists.';
