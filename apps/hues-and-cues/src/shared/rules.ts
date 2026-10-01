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
