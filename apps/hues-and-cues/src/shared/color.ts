import { BOARD_COLUMNS, BOARD_ROWS, type Coord } from './board.js';

/**
 * Colour generation for the board.
 *
 * Colours are laid out in the perceptually uniform OKLCH space so that
 * neighbouring cells look evenly spaced: hue sweeps across the columns and
 * lightness falls from the top row to the bottom row. Each colour uses the
 * strongest chroma that still fits inside the sRGB gamut (capped so the
 * board stays pleasant), and is converted to hex here rather than relying on
 * CSS `oklch()`, which older OBS browser sources do not support.
 */

const HUE_OFFSET_DEGREES = 20;
const LIGHTNESS_TOP = 0.93;
const LIGHTNESS_BOTTOM = 0.3;
const MAX_CHROMA = 0.19;

type Rgb = readonly [number, number, number];

function oklchToLinearSrgb(lightness: number, chroma: number, hueDegrees: number): Rgb {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function isInGamut([r, g, b]: Rgb): boolean {
  const epsilon = 1e-6;
  return [r, g, b].every((channel) => channel >= -epsilon && channel <= 1 + epsilon);
}

function linearToSrgbChannel(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

function toHex(linear: Rgb): string {
  return `#${linear
    .map((channel) => linearToSrgbChannel(channel).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Converts an OKLCH colour to sRGB hex, reducing chroma until it is displayable. */
export function oklchToHex(lightness: number, chroma: number, hueDegrees: number): string {
  if (isInGamut(oklchToLinearSrgb(lightness, chroma, hueDegrees))) {
    return toHex(oklchToLinearSrgb(lightness, chroma, hueDegrees));
  }
  let low = 0;
  let high = chroma;
  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) / 2;
    if (isInGamut(oklchToLinearSrgb(lightness, mid, hueDegrees))) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return toHex(oklchToLinearSrgb(lightness, low, hueDegrees));
}

/** The display colour of a board cell as `#rrggbb`. */
export function cellColor(coord: Coord): string {
  const hue = HUE_OFFSET_DEGREES + (coord.col / BOARD_COLUMNS) * 360;
  const lightness =
    LIGHTNESS_TOP - (coord.row / (BOARD_ROWS - 1)) * (LIGHTNESS_TOP - LIGHTNESS_BOTTOM);
  return oklchToHex(lightness, MAX_CHROMA, hue);
}

/** Picks black or white text for legibility on top of `hex`. */
export function contrastingTextColor(hex: string): '#000000' | '#ffffff' {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.55 ? '#000000' : '#ffffff';
}

/**
 * Twitch lets users pick very dark name colours that vanish on a dark
 * overlay. Lightens such colours toward white while keeping their hue.
 */
export function readableOnDark(hex: string): string {
  if (!/^#[0-9a-f]{6}$/iu.test(hex)) return '#ffffff';
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  const [r = 0, g = 0, b = 0] = channels;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (luminance >= 0.45) return hex.toLowerCase();
  const mix = Math.min(0.75, (0.45 - luminance) / 0.45 + 0.2);
  return `#${channels
    .map((channel) =>
      Math.round(channel + (255 - channel) * mix)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
