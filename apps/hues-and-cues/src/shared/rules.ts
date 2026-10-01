import { chebyshevDistance, type Coord } from './board.js';

/** Points for a guess by Chebyshev distance from the target (index = distance). */
export const GUESS_POINTS_BY_DISTANCE: readonly number[] = [3, 2, 1];

/** Guesses within this distance of the target earn the cue giver a point. */
export const HOST_SCORING_DISTANCE = 1;

/** Number of colour options on each drawn card. */
export const CARD_SIZE = 4;

/** Clue word limits from the original rules: one word, then up to two. */
export const CLUE_WORD_LIMITS: Readonly<Record<1 | 2, number>> = { 1: 1, 2: 2 };

export const MAX_CLUE_LENGTH = 40;

export function pointsForGuess(guess: Coord, target: Coord): number {
  return GUESS_POINTS_BY_DISTANCE[chebyshevDistance(guess, target)] ?? 0;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length;
}

/**
 * Basic colour names the official rules forbid in cues (more specific names
 * such as "lavender" or "teal" are allowed). "Grey" is the British spelling.
 */
export const FORBIDDEN_COLOUR_WORDS: readonly string[] = [
  'black',
  'blue',
  'brown',
  'gray',
  'grey',
  'green',
  'orange',
  'pink',
  'purple',
  'red',
  'white',
  'yellow',
];

/**
 * The second cue may not refer to where the first guesses landed. These are
 * the unambiguous ways of doing that ("lighter", "darker", directions).
 */
export const RELATIVE_CUE_WORDS: readonly string[] = [
  'lighter',
  'darker',
  'brighter',
  'duller',
  'higher',
  'lower',
  'left',
  'right',
  'up',
  'down',
  'above',
  'below',
  'closer',
  'nearer',
  'further',
  'farther',
];

const FORBIDDEN_COLOUR_PATTERN = new RegExp(
  `^(?:${FORBIDDEN_COLOUR_WORDS.join('|')})(?:s|es|ish|dish|nish|y|ness)?$`,
  'u',
);
/** A board position: a row letter A–P and/or a column number, e.g. F12, 12F, 12. */
const POSITION_PATTERN = /^(?:[a-p]-?\d{1,2}|\d{1,2}-?[a-p]|\d+)$/u;

/** Lower-case words of a cue, without surrounding punctuation. */
export function cueWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/u)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((word) => word !== '');
}

/**
 * Checks a cue against the official rules. Returns why it breaks them, or
 * `null` if it is allowed. Shared by the server (authoritative) and the
 * control page (instant feedback).
 *
 * - Cue 1 is one word; cue 2 is one or two words.
 * - No basic colour names (see {@link FORBIDDEN_COLOUR_WORDS}).
 * - No references to the board's letters or numbers.
 * - No word already used in an earlier cue this game.
 * - Cue 2 may not refer to the first guesses (see {@link RELATIVE_CUE_WORDS}).
 *
 * Comparing the colour to objects in the room is also against the rules, but
 * can't be checked automatically.
 */
export function cueRuleViolation(
  text: string,
  clueNumber: 1 | 2,
  usedWords: ReadonlySet<string>,
): string | null {
  const limit = CLUE_WORD_LIMITS[clueNumber];
  if (countWords(text) > limit) {
    return `Cue ${String(clueNumber)} may be at most ${String(limit)} word${limit === 1 ? '' : 's'}.`;
  }
  for (const word of cueWords(text)) {
    if (FORBIDDEN_COLOUR_PATTERN.test(word)) {
      return `Basic colour names like "${word}" aren't allowed; try something more specific.`;
    }
    if (POSITION_PATTERN.test(word)) {
      return "Cues can't refer to the board's letters or numbers.";
    }
    if (usedWords.has(word)) {
      return `"${word}" was already used as a cue this game.`;
    }
    if (clueNumber === 2 && RELATIVE_CUE_WORDS.includes(word)) {
      return `The second cue can't point from the first guesses (like "${word}").`;
    }
  }
  return null;
}
