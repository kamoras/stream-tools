import { describe, expect, it } from 'vitest';
import {
  allCoords,
  BOARD_COLUMNS,
  BOARD_ROWS,
  chebyshevDistance,
  coordKey,
  formatCoord,
  isValidCoord,
  parseCoord,
} from '../../src/shared/board.js';

describe('parseCoord', () => {
  it.each([
    ['F12', { row: 5, col: 11 }],
    ['f12', { row: 5, col: 11 }],
    ['  A1 ', { row: 0, col: 0 }],
    ['P30', { row: 15, col: 29 }],
    ['F 12', { row: 5, col: 11 }],
    ['F-12', { row: 5, col: 11 }],
    ['12F', { row: 5, col: 11 }],
    ['12 f', { row: 5, col: 11 }],
    ['a01', { row: 0, col: 0 }],
  ])('parses %j', (input, expected) => {
    expect(parseCoord(input)).toEqual(expected);
  });

  it.each(['', 'Q1', 'A0', 'A31', 'F', '12', 'F12 please', 'hello', 'AA1', 'F123'])(
    'rejects %j',
    (input) => {
      expect(parseCoord(input)).toBeNull();
    },
  );
});

describe('formatCoord', () => {
  it('round-trips every cell through parseCoord', () => {
    for (const coord of allCoords()) {
      expect(parseCoord(formatCoord(coord))).toEqual(coord);
    }
  });
});

describe('geometry', () => {
  it('measures Chebyshev distance', () => {
    expect(chebyshevDistance({ row: 5, col: 5 }, { row: 5, col: 5 })).toBe(0);
    expect(chebyshevDistance({ row: 5, col: 5 }, { row: 6, col: 6 })).toBe(1);
    expect(chebyshevDistance({ row: 5, col: 5 }, { row: 3, col: 6 })).toBe(2);
    expect(chebyshevDistance({ row: 0, col: 0 }, { row: 15, col: 29 })).toBe(29);
  });

  it('gives every cell a unique key', () => {
    const keys = new Set(allCoords().map(coordKey));
    expect(keys.size).toBe(BOARD_ROWS * BOARD_COLUMNS);
  });

  it('validates bounds', () => {
    expect(isValidCoord({ row: 0, col: 0 })).toBe(true);
    expect(isValidCoord({ row: -1, col: 0 })).toBe(false);
    expect(isValidCoord({ row: 0, col: BOARD_COLUMNS })).toBe(false);
    expect(isValidCoord({ row: 1.5, col: 0 })).toBe(false);
  });
});
