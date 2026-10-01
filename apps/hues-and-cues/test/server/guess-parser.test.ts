import { describe, expect, it } from 'vitest';
import { parseChatGuess } from '../../src/server/twitch/guess-parser.js';

describe('parseChatGuess', () => {
  it('accepts bare coordinates by default', () => {
    expect(parseChatGuess('F12', false)).toEqual({ row: 5, col: 11 });
    expect(parseChatGuess('12f', false)).toEqual({ row: 5, col: 11 });
  });

  it('ignores the invisible characters chat clients add to repeat a message', () => {
    expect(parseChatGuess('F12 \u{E0000}', false)).toEqual({ row: 5, col: 11 });
    expect(parseChatGuess('!guess F12 \u034f', false)).toEqual({ row: 5, col: 11 });
  });

  it('accepts commands', () => {
    expect(parseChatGuess('!guess F12', false)).toEqual({ row: 5, col: 11 });
    expect(parseChatGuess('!G a1', true)).toEqual({ row: 0, col: 0 });
    expect(parseChatGuess('!hue P30', true)).toEqual({ row: 15, col: 29 });
  });

  it('ignores bare coordinates when a command is required', () => {
    expect(parseChatGuess('F12', true)).toBeNull();
  });

  it('ignores ordinary chat', () => {
    expect(parseChatGuess('a1 stream!', false)).toBeNull();
    expect(parseChatGuess('!guess banana', false)).toBeNull();
    expect(parseChatGuess('lol', false)).toBeNull();
  });
});
