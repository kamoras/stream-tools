import { describe, expect, it } from 'vitest';
import { allCoords } from '../../src/shared/board.js';
import {
  cellColor,
  contrastingTextColor,
  oklchToHex,
  readableOnDark,
} from '../../src/shared/color.js';

const HEX = /^#[0-9a-f]{6}$/u;

describe('cellColor', () => {
  it('produces a valid, unique colour for every cell', () => {
    const colours = allCoords().map(cellColor);
    for (const colour of colours) expect(colour).toMatch(HEX);
    expect(new Set(colours).size).toBe(colours.length);
  });

  it('is deterministic', () => {
    expect(cellColor({ row: 3, col: 7 })).toBe(cellColor({ row: 3, col: 7 }));
  });

  it('gets darker down the board', () => {
    const top = Number.parseInt(cellColor({ row: 0, col: 10 }).slice(1), 16);
    const bottom = Number.parseInt(cellColor({ row: 15, col: 10 }).slice(1), 16);
    const brightness = (v: number) => ((v >> 16) & 0xff) + ((v >> 8) & 0xff) + (v & 0xff);
    expect(brightness(top)).toBeGreaterThan(brightness(bottom));
  });
});

describe('oklchToHex', () => {
  it('maps achromatic extremes to black and white', () => {
    expect(oklchToHex(1, 0, 0)).toBe('#ffffff');
    expect(oklchToHex(0, 0, 0)).toBe('#000000');
  });

  it('gamut-maps out-of-range chroma instead of clipping wildly', () => {
    expect(oklchToHex(0.7, 0.5, 140)).toMatch(HEX);
  });
});

describe('text colour helpers', () => {
  it('chooses contrasting text', () => {
    expect(contrastingTextColor('#ffffff')).toBe('#000000');
    expect(contrastingTextColor('#101010')).toBe('#ffffff');
  });

  it('lightens dark chat colours and keeps light ones', () => {
    expect(readableOnDark('#FFFF00')).toBe('#ffff00');
    const lightened = readableOnDark('#0000ff');
    expect(lightened).not.toBe('#0000ff');
    expect(contrastingTextColor(lightened)).toBe('#000000');
    expect(readableOnDark('not-a-colour')).toBe('#ffffff');
  });
});
