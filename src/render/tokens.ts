/**
 * Average characters per token for source code.
 *
 * Deliberately lower than the ~4 usually quoted for prose: identifiers,
 * punctuation and type annotations tokenise more finely, and a budget that is
 * overshot is worse than one that is undershot.
 */
const CHARS_PER_TOKEN = 3.5;

/**
 * Approximate token count for a piece of output.
 *
 * An estimate, not a tokeniser: shipping one would mean a large dependency and
 * a model-specific vocabulary, for a number only used to decide how much of
 * the map to show.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
