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

/** Splits a cue into words. Hyphens, underscores and slashes separate words too. */
function splitWords(text: string): string[] {
  return text.split(/[\s\-_/]+/u).filter((word) => word !== '');
}

export function countWords(text: string): number {
  return splitWords(text.trim()).length;
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
 * The second cue may not compare against where the first guesses landed.
 * These are the unambiguous ways of doing that ("lighter", "darker", "more",
 * directions).
 */
export const RELATIVE_CUE_WORDS: readonly string[] = [
  'lighter',
  'darker',
  'paler',
  'deeper',
  'brighter',
  'duller',
  'warmer',
  'cooler',
  'more',
  'less',
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

/** Numbers as words: one–thirty and first–thirtieth (the board has 30 columns). */
const NUMBER_WORDS: ReadonlySet<string> = (() => {
  const units = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const unitOrdinals = [
    'first',
    'second',
    'third',
    'fourth',
    'fifth',
    'sixth',
    'seventh',
    'eighth',
    'ninth',
  ];
  const words = [
    ...units,
    ...unitOrdinals,
    ...['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen'],
    ...['sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty'],
    ...['tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth'],
    ...['sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth', 'thirtieth'],
    ...units.map((unit) => `twenty${unit}`),
    ...unitOrdinals.map((ordinal) => `twenty${ordinal}`),
  ];
  return new Set(words);
})();

/** Each colour and, for those ending in "e", its stem ("blu" for "bluish"). */
const COLOUR_STEMS = FORBIDDEN_COLOUR_WORDS.flatMap((word) =>
  word.endsWith('e') ? [word, word.slice(0, -1)] : [word],
);
/** A colour name or a simple variant: reds, reddish, bluish, purply, greener, bluest. */
const FORBIDDEN_COLOUR_PATTERN = new RegExp(
  `^(?:${COLOUR_STEMS.join('|')})(?:s|es|ish|dish|nish|y|dy|ness|er|der|ner|est|dest|nest)?$`,
  'u',
);
/** A board position, e.g. F12, 12F, 12, or a lone row letter (except the words "a" and "i"). */
const POSITION_PATTERN = /^(?:[a-p]\d{1,2}|\d{1,2}[a-p]|\d+|[b-hj-p])$/u;

/** Lower-case words of a cue, without punctuation around or between them. */
export function cueWords(text: string): string[] {
  return splitWords(text.toLowerCase())
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((word) => word !== '');
}

/** The form cues are compared in when checking for repeats. */
export function normalizeCue(text: string): string {
  return cueWords(text).join(' ');
}

/**
 * Checks a cue against the official rules. Returns why it breaks them, or
 * `null` if it is allowed. Shared by the server (authoritative) and the
 * control page (instant feedback).
 *
 * - Cue 1 is one word; cue 2 is one or two words.
 * - No basic colour names (see {@link FORBIDDEN_COLOUR_WORDS}).
 * - No references to the board's letters or numbers.
 * - No repeating a cue already given this game.
 * - Cue 2 may not compare against the first guesses (see {@link RELATIVE_CUE_WORDS}).
 *
 * Comparing the colour to objects in the room is also against the rules, but
 * can't be checked automatically.
 */
export function cueRuleViolation(
  text: string,
  clueNumber: 1 | 2,
  usedCues: ReadonlySet<string>,
): string | null {
  const limit = CLUE_WORD_LIMITS[clueNumber];
  if (countWords(text) > limit) {
    return `Cue ${String(clueNumber)} may be at most ${String(limit)} word${limit === 1 ? '' : 's'}.`;
  }
  for (const word of cueWords(text)) {
    if (FORBIDDEN_COLOUR_PATTERN.test(word)) {
      return `Basic colour names like "${word}" aren't allowed; try something more specific.`;
    }
    if (POSITION_PATTERN.test(word) || NUMBER_WORDS.has(word)) {
      return "Cues can't refer to the board's letters or numbers.";
    }
    if (clueNumber === 2 && RELATIVE_CUE_WORDS.includes(word)) {
      return `The second cue can't compare against the first guesses (like "${word}").`;
    }
  }
  if (usedCues.has(normalizeCue(text))) {
    return 'That cue was already given this game.';
  }
  return null;
}
