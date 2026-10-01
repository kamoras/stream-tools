import { describe, expect, it } from 'vitest';
import { cueRuleViolation, cueWords, pointsForGuess } from '../../src/shared/rules.js';

const none = new Set<string>();

describe('cueRuleViolation', () => {
  it('allows specific colour names and ordinary words', () => {
    for (const cue of ['lavender', 'teal', 'Redwood', 'sunset', 'ocean!']) {
      expect(cueRuleViolation(cue, 1, none)).toBeNull();
    }
    expect(cueRuleViolation('a lemon', 2, none)).toBeNull();
    expect(cueRuleViolation('i scream', 2, none)).toBeNull();
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
    for (const cue of ['F12', '12F', '7', 'f', 'twelve', 'twelfth', 'twenty-one']) {
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

  it('treats hyphens, underscores and slashes as word breaks', () => {
    expect(cueRuleViolation('deep-sea', 1, none)).toMatch(/at most 1 word/u);
    expect(cueRuleViolation('sky-blue', 2, none)).toMatch(/Basic colour names/u);
    expect(cueRuleViolation('blue/green', 2, none)).toMatch(/Basic colour names/u);
  });

  it('forbids pointing from the first guesses in cue 2 only', () => {
    for (const cue of ['slightly darker', 'paler', 'more', 'warmer']) {
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
