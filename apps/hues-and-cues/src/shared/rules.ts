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

/** Words in a cue, ignoring punctuation and emoji (see {@link cueWords}). */
export function countWords(text: string): number {
  return cueWords(text).length;
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
 * The second cue may not compare against where the first guesses landed
 * ("lighter", "darker"). These comparatives are refused anywhere in cue 2.
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
  'higher',
  'lower',
  'closer',
  'nearer',
  'further',
  'farther',
];

/**
 * Words that steer only when they make up the whole cue ("more", "up",
 * "down left", "slightly more"); in "left bank" or "down under" they don't.
 */
const STEERING_WORDS: ReadonlySet<string> = new Set([
  'up',
  'down',
  'left',
  'right',
  'above',
  'below',
  'more',
  'less',
  'slightly',
  'little',
  'bit',
  'much',
  'way',
  'too',
  'top',
  'bottom',
  'upper',
  'far',
  'side',
  'middle',
  'centre',
  'center',
  'corner',
  'north',
  'south',
  'east',
  'west',
]);

/**
 * Numbers as words: one–thirty and first–thirtieth (the board has 30
 * columns). Like digits, they are refused only when the whole cue is a
 * number, so "cloud nine" or "first light" are fine.
 */
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
const COLOUR_SUFFIXES = 's|es|ish|dish|nish|y|dy|ness|er|der|ner|est|dest|nest';
/**
 * A colour name or a simple variant: reds, reddish, bluish, purply, greener,
 * bluest. A shortened stem ("blu") only counts with a suffix, so "blu-ray"
 * is fine.
 */
const FORBIDDEN_COLOUR_PATTERN = new RegExp(
  `^(?:(?:${FORBIDDEN_COLOUR_WORDS.join('|')})(?:${COLOUR_SUFFIXES})?|(?:${COLOUR_STEMS.filter(
    (stem) => !FORBIDDEN_COLOUR_WORDS.includes(stem),
  ).join('|')})(?:${COLOUR_SUFFIXES}))$`,
  'u',
);
/** A board position such as F12 or 12F. */
const POSITION_PATTERN = /^(?:[a-p]\d{1,2}|\d{1,2}[a-p])$/u;
/** A row letter on its own. Refused only when the whole cue is letters and numbers ("f", "f 12"). */
const ROW_LETTER_PATTERN = /^[a-p]$/u;
/** One or two digits, optionally an ordinal such as 12th ("007" is a name, not a column). */
const DIGITS_PATTERN = /^(\d{1,2})(?:st|nd|rd|th)?$/u;

/** A board column (1–30) in digits, so "1984" or "007" are fine. */
function isColumnNumber(word: string): boolean {
  const digits = DIGITS_PATTERN.exec(word)?.[1];
  if (digits === undefined) return false;
  const value = Number(digits);
  return value >= 1 && value <= 30;
}

function isPositionWord(word: string): boolean {
  return isColumnNumber(word) || NUMBER_WORDS.has(word) || ROW_LETTER_PATTERN.test(word);
}

/** Lower-case words of a cue, without punctuation around them or a possessive "'s". */
export function cueWords(text: string): string[] {
  // NFKC folds look-alikes such as full-width "ＢＬＵＥ" and composes accents.
  return splitWords(text.normalize('NFKC').toLowerCase())
    .map((word) =>
      word.replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, '').replace(/['’]s$/u, ''),
    )
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
 * - No references to the board's letters or numbers (a position such as F12,
 *   or a cue made only of row letters and numbers, such as "twelve" or "f").
 * - No repeating a cue already given this game.
 * - Cue 2 may not compare against the first guesses (see {@link RELATIVE_CUE_WORDS})
 *   or consist only of steering words such as "more" or "down left".
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
  const words = cueWords(text);
  if (words.length === 0) {
    return 'The cue needs at least one word.';
  }
  if (words.length > limit) {
    return `Cue ${String(clueNumber)} may be at most ${String(limit)} word${limit === 1 ? '' : 's'}.`;
  }
  for (const word of words) {
    if (FORBIDDEN_COLOUR_PATTERN.test(word)) {
      return `Basic colour names like "${word}" aren't allowed; try something more specific.`;
    }
    if (POSITION_PATTERN.test(word)) {
      return "Cues can't refer to the board's letters or numbers.";
    }
    if (clueNumber === 2 && RELATIVE_CUE_WORDS.includes(word)) {
      return `The second cue can't compare against the first guesses (like "${word}").`;
    }
  }
  if (words.every(isPositionWord)) {
    return "Cues can't refer to the board's letters or numbers.";
  }
  if (clueNumber === 2 && words.every((word) => STEERING_WORDS.has(word))) {
    return `The second cue can't steer from the first guesses (like "${words.join(' ')}").`;
  }
  if (usedCues.has(normalizeCue(text))) {
    return 'That cue was already given this game.';
  }
  return null;
}
