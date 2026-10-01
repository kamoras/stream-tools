import { describe, expect, it } from 'vitest';
import { cueRuleViolation, cueWords, pointsForGuess } from '../../src/shared/rules.js';

const none = new Set<string>();

describe('cueRuleViolation', () => {
  it('allows specific colour names and ordinary words', () => {
    for (const cue of ['lavender', 'teal', 'Redwood', 'sunset', 'ocean!']) {
      expect(cueRuleViolation(cue, 1, none)).toBeNull();
    }
    expect(cueRuleViolation('a lemon', 2, none)).toBeNull();
  });

  it('limits cue 1 to one word and cue 2 to two', () => {
    expect(cueRuleViolation('deep sea', 1, none)).toMatch(/at most 1 word/u);
    expect(cueRuleViolation('very deep sea', 2, none)).toMatch(/at most 2 words/u);
  });

  it('forbids the basic colour names, including simple variants', () => {
    for (const cue of ['red', 'GREY', 'gray', 'reddish', 'pinky', 'blues', 'orangey']) {
      expect(cueRuleViolation(cue, 1, none)).toMatch(/Basic colour names/u);
    }
  });

  it("forbids the board's letters and numbers", () => {
    for (const cue of ['F12', 'f-12', '12F', '7']) {
      expect(cueRuleViolation(cue, 1, none)).toMatch(/letters or numbers/u);
    }
  });

  it('forbids repeating a cue word', () => {
    expect(cueRuleViolation('Ocean.', 1, new Set(['ocean']))).toMatch(/already used/u);
  });

  it('forbids pointing from the first guesses in cue 2 only', () => {
    expect(cueRuleViolation('slightly darker', 2, none)).toMatch(/first guesses/u);
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
