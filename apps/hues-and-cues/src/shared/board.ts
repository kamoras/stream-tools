/**
 * Board geometry shared by the server (scoring, chat parsing) and the
 * browser clients (rendering). The board mirrors the original game:
 * 30 columns (1-30) by 16 rows (A-P).
 */

export const BOARD_COLUMNS = 30;
export const BOARD_ROWS = 16;
export const ROW_LABELS = 'ABCDEFGHIJKLMNOP';

/** A zero-based board position. */
export interface Coord {
  readonly row: number;
  readonly col: number;
}

export function isValidCoord(coord: Coord): boolean {
  return (
    Number.isInteger(coord.row) &&
    Number.isInteger(coord.col) &&
    coord.row >= 0 &&
    coord.row < BOARD_ROWS &&
    coord.col >= 0 &&
    coord.col < BOARD_COLUMNS
  );
}

/** Formats a coordinate the way players type it, e.g. `F12`. */
export function formatCoord(coord: Coord): string {
  return `${ROW_LABELS.charAt(coord.row)}${coord.col + 1}`;
}

/** Stable numeric key for a coordinate, useful for maps and sets. */
export function coordKey(coord: Coord): number {
  return coord.row * BOARD_COLUMNS + coord.col;
}

export function coordsEqual(a: Coord, b: Coord): boolean {
  return a.row === b.row && a.col === b.col;
}

/**
 * Chebyshev ("king move") distance, which is what the physical game's
 * square scoring frames measure.
 */
export function chebyshevDistance(a: Coord, b: Coord): number {
  return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
}

const LETTER_FIRST = /^([a-p])\s*[-:,.]?\s*(\d{1,2})$/i;
const NUMBER_FIRST = /^(\d{1,2})\s*[-:,.]?\s*([a-p])$/i;

/**
 * Parses a coordinate typed by a human, accepting `F12`, `f 12`, `F-12`
 * and `12F`. Returns `null` for anything that is not a cell on the board.
 */
export function parseCoord(input: string): Coord | null {
  const text = input.trim();
  let letter: string | undefined;
  let digits: string | undefined;

  const letterFirst = LETTER_FIRST.exec(text);
  if (letterFirst) {
    [, letter, digits] = letterFirst;
  } else {
    const numberFirst = NUMBER_FIRST.exec(text);
    if (numberFirst) {
      [, digits, letter] = numberFirst;
    }
  }
  if (letter === undefined || digits === undefined) {
    return null;
  }

  const coord: Coord = {
    row: ROW_LABELS.indexOf(letter.toUpperCase()),
    col: Number.parseInt(digits, 10) - 1,
  };
  return isValidCoord(coord) ? coord : null;
}

/** Every cell on the board in row-major order. */
export function allCoords(): Coord[] {
  const coords: Coord[] = [];
  for (let row = 0; row < BOARD_ROWS; row += 1) {
    for (let col = 0; col < BOARD_COLUMNS; col += 1) {
      coords.push({ row, col });
    }
  }
  return coords;
}
