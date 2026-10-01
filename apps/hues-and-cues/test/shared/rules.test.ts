import { describe, expect, it } from 'vitest';
import {
  cueRuleViolation,
  cueWords,
  normalizeCue,
  pointsForGuess,
} from '../../src/shared/rules.js';

const none = new Set<string>();

describe('cueRuleViolation', () => {
  it('allows specific colour names and ordinary words', () => {
    for (const cue of ['lavender', 'teal', 'Redwood', 'sunset', 'ocean!']) {
      expect(cueRuleViolation(cue, 1, none)).toBeNull();
    }
    expect(cueRuleViolation('a lemon', 2, none)).toBeNull();
    expect(cueRuleViolation('i scream', 2, none)).toBeNull();
    // Numbers and direction words are fine when they don't point at the board.
    for (const cue of ['cloud nine', 'first light', 'seventh heaven', 'cloud 9']) {
      expect(cueRuleViolation(cue, 2, none)).toBeNull();
    }
    for (const cue of ['left bank', 'down under', 'right whale', 'more moss']) {
      expect(cueRuleViolation(cue, 2, none)).toBeNull();
    }
    // Single letters in ordinary words, and shortened colour stems on their own.
    for (const cue of ['plan b', 'vitamin c', 'k-pop', 'd-day', 'blu-ray']) {
      expect(cueRuleViolation(cue, 2, none)).toBeNull();
    }
    // Numbers outside the board's 1–30 columns, and directions in ordinary phrases.
    for (const cue of ['1984', '007', '404', 'top gun', 'east end']) {
      expect(cueRuleViolation(cue, 2, none)).toBeNull();
    }
    // Punctuation and emoji don't count as words.
    expect(cueRuleViolation('🌊 ocean!', 1, none)).toBeNull();
  });

  it('limits cue 1 to one word and cue 2 to two', () => {
    expect(cueRuleViolation('deep sea', 1, none)).toMatch(/at most 1 word/u);
    expect(cueRuleViolation('very deep sea', 2, none)).toMatch(/at most 2 words/u);
  });

  it('forbids the basic colour names, including simple variants', () => {
    for (const cue of [
      'red',
      'GREY',
      'gray',
      'reddish',
      'pinky',
      'blues',
      'orangey',
      'bluish',
      'purplish',
      'whitish',
      'purply',
      'redder',
      'greener',
      'bluest',
    ]) {
      expect(cueRuleViolation(cue, 1, none)).toMatch(/Basic colour names/u);
    }
  });

  it("forbids the board's letters and numbers", () => {
    for (const cue of ['F12', '12F', '7', '12th', 'f', 'f 12', 'twelve', 'twelfth', 'twenty-one']) {
      expect(cueRuleViolation(cue, 2, none)).toMatch(/letters or numbers/u);
    }
  });

  it('forbids repeating a whole cue, not reusing its words', () => {
    const used = new Set(['ocean', 'deep sea']);
    expect(cueRuleViolation('Ocean.', 1, used)).toMatch(/already given/u);
    expect(cueRuleViolation('deep  SEA', 2, used)).toMatch(/already given/u);
    expect(cueRuleViolation('deep ocean', 2, used)).toBeNull();
    expect(cueRuleViolation('the sea', 2, new Set(['the moon']))).toBeNull();
  });

  it('needs at least one word', () => {
    expect(cueRuleViolation('!!!', 1, new Set(['']))).toMatch(/at least one word/u);
  });

  it('refuses second cues that only steer, in any words', () => {
    for (const cue of ['top left', 'far left', 'bottom right', 'north east']) {
      expect(cueRuleViolation(cue, 2, none)).toMatch(/first guesses/u);
    }
  });

  it('folds full-width and decomposed characters', () => {
    expect(cueRuleViolation('ＢＬＵＥ', 1, none)).toMatch(/Basic colour names/u);
    expect(cueRuleViolation('cafe\u0301', 1, new Set([normalizeCue('café')]))).toMatch(
      /already given/u,
    );
  });

  it('sees colour names in possessives', () => {
    expect(cueRuleViolation("snow white's", 2, none)).toMatch(/Basic colour names/u);
    expect(cueRuleViolation('grey’s anatomy', 2, none)).toMatch(/Basic colour names/u);
  });

  it('splits words on any punctuation and ignores invisible characters', () => {
    for (const cue of ['red,green', 'sky—blue', 'sky–blue', 'blue&gold', 're\u00addish']) {
      expect(cueRuleViolation(cue, 2, none)).toMatch(/Basic colour names/u);
    }
    expect(cueRuleViolation('f.12', 2, none)).toMatch(/letters or numbers/u);
    expect(cueRuleViolation('f\u200b12', 1, none)).toMatch(/letters or numbers/u);
    expect(cueRuleViolation('even,lighter', 2, none)).toMatch(/first guesses/u);
    expect(cueRuleViolation('red,green', 1, none)).toMatch(/at most 1 word/u);
    expect(cueRuleViolation("don't", 1, none)).toBeNull();
  });

  it('sees through apostrophes, accents and invisible characters', () => {
    const colour = /Basic colour names/u;
    for (const cue of [
      "red'green",
      'red’green',
      "red''s",
      'réd',
      'red\ufe0f',
      're\u034fd',
      'red\u3164',
    ]) {
      expect(cueRuleViolation(cue, 1, none)).toMatch(colour);
    }
    for (const cue of ["f'12", '12’f', '1\ufe0f\u20e32\ufe0f\u20e3', 'f12\u20e3']) {
      expect(cueRuleViolation(cue, 1, none)).toMatch(/letters or numbers/u);
    }
    expect(cueRuleViolation("darker''s", 2, none)).toMatch(/first guesses/u);
    expect(cueRuleViolation("ocean''s", 1, new Set(['ocean']))).toMatch(/already given/u);
    expect(cueRuleViolation('\u2764\ufe0f', 1, none)).toMatch(/at least one word/u);
    // Apostrophes still keep ordinary words whole for the word limit.
    for (const cue of ["o'clock", "rock'n'roll", "don't"]) {
      expect(cueRuleViolation(cue, 1, none)).toBeNull();
    }
  });

  it('treats hyphens, underscores and slashes as word breaks', () => {
    expect(cueRuleViolation('deep-sea', 1, none)).toMatch(/at most 1 word/u);
    expect(cueRuleViolation('sky-blue', 2, none)).toMatch(/Basic colour names/u);
    expect(cueRuleViolation('blue/green', 2, none)).toMatch(/Basic colour names/u);
  });

  it('forbids pointing from the first guesses in cue 2 only', () => {
    for (const cue of ['slightly darker', 'paler', 'warmer', 'more', 'down left', 'slightly up']) {
      expect(cueRuleViolation(cue, 2, none)).toMatch(/first guesses/u);
    }
    expect(cueRuleViolation('down', 1, none)).toBeNull();
  });
});

describe('cueWords', () => {
  it('lower-cases and strips surrounding punctuation', () => {
    expect(cueWords('  "Deep"  Sea! ')).toEqual(['deep', 'sea']);
  });
});

describe('pointsForGuess', () => {
  it('scores 3 on the target, 2 inside the frame, 1 touching it, else 0', () => {
    const target = { row: 5, col: 5 };
    expect(pointsForGuess(target, target)).toBe(3);
    expect(pointsForGuess({ row: 6, col: 4 }, target)).toBe(2);
    expect(pointsForGuess({ row: 7, col: 3 }, target)).toBe(1);
    expect(pointsForGuess({ row: 8, col: 5 }, target)).toBe(0);
  });
});
