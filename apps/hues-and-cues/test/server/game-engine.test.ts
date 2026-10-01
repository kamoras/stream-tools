import { beforeEach, describe, expect, it } from 'vitest';
import { chebyshevDistance, type Coord } from '../../src/shared/board.js';
import { GameError } from '../../src/server/game/errors.js';
import { GameEngine, type GuessInput } from '../../src/server/game/game-engine.js';
import { gameSnapshotSchema } from '../../src/server/game/snapshot.js';
import { fakeClock, seededRandom } from '../helpers.js';

function guess(userId: string, coord: Coord): GuessInput {
  return { userId, displayName: userId.toUpperCase(), color: null, coord };
}

function offset(coord: Coord, dRow: number, dCol: number): Coord {
  return { row: coord.row + dRow, col: coord.col + dCol };
}

describe('GameEngine', () => {
  let clock: ReturnType<typeof fakeClock>;
  let engine: GameEngine;

  beforeEach(() => {
    clock = fakeClock();
    engine = new GameEngine({ channel: 'streamer', now: clock.now, random: seededRandom(42) });
    engine.updateSettings({ guessDurationSeconds: 30 });
  });

  /** Starts a round whose target sits away from the board edges. */
  function startRound(): Coord {
    engine.drawCard();
    const card = engine.getHostState().card ?? [];
    const index = card.findIndex((c) => c.row >= 2 && c.row <= 13 && c.col >= 2 && c.col <= 27);
    engine.selectTarget(Math.max(0, index));
    const target = engine.getHostState().target;
    if (!target) throw new Error('no target');
    return target;
  }

  describe('card drawing', () => {
    it('draws four well-separated colours and starts a round', () => {
      engine.drawCard();
      const state = engine.getHostState();
      expect(state.phase).toBe('picking');
      expect(state.roundNumber).toBe(1);
      expect(state.card).toHaveLength(4);
      const card = state.card ?? [];
      for (let i = 0; i < card.length; i += 1) {
        for (let j = i + 1; j < card.length; j += 1) {
          const [a, b] = [card[i], card[j]];
          if (a && b) expect(chebyshevDistance(a, b)).toBeGreaterThanOrEqual(3);
        }
      }
    });

    it('redraws without advancing the round number', () => {
      engine.drawCard();
      engine.drawCard();
      expect(engine.getHostState().roundNumber).toBe(1);
    });

    it('rejects drawing mid-round', () => {
      startRound();
      engine.giveClue('ocean');
      expect(() => engine.drawCard()).toThrow(GameError);
    });
  });

  describe('clues', () => {
    it('requires a chosen colour before the first clue', () => {
      engine.drawCard();
      expect(() => engine.giveClue('ocean')).toThrow(/Choose a colour/u);
    });

    it('rejects out-of-range card indices', () => {
      engine.drawCard();
      expect(() => engine.selectTarget(4)).toThrow(GameError);
      expect(() => engine.selectTarget(-1)).toThrow(GameError);
    });

    it('enforces word limits when enabled', () => {
      startRound();
      expect(() => engine.giveClue('deep ocean')).toThrow(/at most 1 word/u);
      engine.giveClue('  ocean ');
      expect(engine.getPublicState().clues).toEqual(['ocean']);
      engine.closeGuessing();
      expect(() => engine.giveClue('very deep sea')).toThrow(/at most 2 words/u);
      engine.giveClue('deep   sea');
      expect(engine.getPublicState().clues).toEqual(['ocean', 'deep sea']);
    });

    it('enforces the official cue rules', () => {
      startRound();
      expect(() => engine.giveClue('Blue')).toThrow(/Basic colour names/u);
      expect(() => engine.giveClue('greenish')).toThrow(/Basic colour names/u);
      expect(() => engine.giveClue('F12')).toThrow(/letters or numbers/u);
      engine.giveClue('ocean');
      engine.closeGuessing();
      expect(() => engine.giveClue('darker')).toThrow(/first guesses/u);
      expect(() => engine.giveClue('Ocean!')).toThrow(/already given/u);
      // Only whole cues may not repeat; reusing a word is fine.
      engine.giveClue('deep ocean');
      expect(engine.getHostState().usedCues).toEqual(['ocean', 'deep ocean']);
    });

    it('forbids repeating a cue until a new game', () => {
      startRound();
      engine.giveClue('ocean');
      engine.reveal();
      startRound();
      expect(() => engine.giveClue('ocean')).toThrow(/already given/u);
      engine.resetScores();
      engine.giveClue('ocean');
      expect(engine.currentPhase).toBe('guessing');
    });

    it('allows any clue when the cue rules are disabled', () => {
      engine.updateSettings({ enforceCueRules: false });
      startRound();
      engine.giveClue('the deep blue sea');
      expect(engine.currentPhase).toBe('guessing');
    });

    it('rejects whitespace-only clues', () => {
      startRound();
      expect(() => engine.giveClue('   ')).toThrow(/empty/u);
    });
  });

  describe('guessing', () => {
    it('ignores guesses outside the guessing phase', () => {
      expect(engine.submitGuess(guess('a', { row: 0, col: 0 }))).toBe('rejected_closed');
      startRound();
      expect(engine.submitGuess(guess('a', { row: 0, col: 0 }))).toBe('rejected_closed');
    });

    it('rejects off-board coordinates', () => {
      startRound();
      engine.giveClue('ocean');
      expect(engine.submitGuess(guess('a', { row: 16, col: 0 }))).toBe('rejected_closed');
    });

    it('lets players change their guess when allowed', () => {
      engine.updateSettings({ allowGuessChanges: true });
      startRound();
      engine.giveClue('ocean');
      expect(engine.submitGuess(guess('a', { row: 0, col: 0 }))).toBe('accepted');
      expect(engine.submitGuess(guess('a', { row: 0, col: 0 }))).toBe('unchanged');
      expect(engine.submitGuess(guess('a', { row: 1, col: 1 }))).toBe('updated');
      const state = engine.getPublicState();
      expect(state.totalGuesses).toBe(1);
      expect(state.cellCounts).toEqual([[31, 1]]);
    });

    it('locks guesses by default, like placed pieces', () => {
      startRound();
      engine.giveClue('ocean');
      engine.submitGuess(guess('a', { row: 0, col: 0 }));
      expect(engine.submitGuess(guess('a', { row: 1, col: 1 }))).toBe('rejected_already_guessed');
    });

    it('allows one guess per square, first come first served', () => {
      startRound();
      engine.giveClue('ocean');
      expect(engine.submitGuess(guess('a', { row: 2, col: 2 }))).toBe('accepted');
      expect(engine.submitGuess(guess('b', { row: 2, col: 2 }))).toBe('rejected_occupied');
      engine.closeGuessing();
      engine.giveClue('stormy sea');
      expect(engine.submitGuess(guess('b', { row: 2, col: 2 }))).toBe('rejected_occupied');
      expect(engine.submitGuess(guess('b', { row: 2, col: 3 }))).toBe('accepted');
    });

    it("never lets a player's second guess share their first guess's square", () => {
      engine.updateSettings({ oneGuessPerSquare: false });
      startRound();
      engine.giveClue('ocean');
      engine.submitGuess(guess('a', { row: 2, col: 2 }));
      expect(engine.submitGuess(guess('b', { row: 2, col: 2 }))).toBe('accepted');
      engine.closeGuessing();
      engine.giveClue('stormy sea');
      expect(engine.submitGuess(guess('a', { row: 2, col: 2 }))).toBe('rejected_occupied');
    });

    it('frees a square when its guess moves', () => {
      engine.updateSettings({ allowGuessChanges: true });
      startRound();
      engine.giveClue('ocean');
      engine.submitGuess(guess('a', { row: 2, col: 2 }));
      expect(engine.submitGuess(guess('a', { row: 2, col: 3 }))).toBe('updated');
      expect(engine.submitGuess(guess('b', { row: 2, col: 2 }))).toBe('accepted');
    });

    it('aggregates guesses per cell and orders recent guesses', () => {
      engine.updateSettings({ oneGuessPerSquare: false });
      startRound();
      engine.giveClue('ocean');
      engine.submitGuess(guess('a', { row: 2, col: 2 }));
      clock.advance(10);
      engine.submitGuess(guess('b', { row: 2, col: 2 }));
      clock.advance(10);
      engine.submitGuess(guess('c', { row: 3, col: 3 }));
      const state = engine.getPublicState();
      expect(new Map(state.cellCounts).get(2 * 30 + 2)).toBe(2);
      expect(state.guesses.map((g) => g.userId)).toEqual(['a', 'b', 'c']);
    });

    it('gives each player one guess per clue', () => {
      startRound();
      engine.giveClue('ocean');
      engine.submitGuess(guess('a', { row: 0, col: 0 }));
      engine.closeGuessing();
      engine.giveClue('stormy sea');
      expect(engine.submitGuess(guess('a', { row: 5, col: 5 }))).toBe('accepted');
      expect(engine.getPublicState().totalGuesses).toBe(2);
    });
  });

  describe('timing', () => {
    it('sets a deadline and expires it', () => {
      startRound();
      engine.giveClue('ocean');
      expect(engine.deadline).toBe(clock.now() + 30_000);
      clock.advance(29_999);
      expect(engine.expireIfDue()).toBe(false);
      clock.advance(1);
      expect(engine.expireIfDue()).toBe(true);
      expect(engine.currentPhase).toBe('intermission');
      expect(engine.deadline).toBeNull();
    });

    it('has no deadline in manual mode', () => {
      engine.updateSettings({ guessDurationSeconds: 0 });
      startRound();
      engine.giveClue('ocean');
      expect(engine.deadline).toBeNull();
      expect(engine.expireIfDue()).toBe(false);
    });
  });

  describe('scoring', () => {
    it('scores 3/2/1 by distance across both clues and credits the host', () => {
      const target = startRound();
      engine.giveClue('ocean');
      engine.submitGuess(guess('exact', target));
      engine.submitGuess(guess('near', offset(target, 1, -1)));
      engine.submitGuess(guess('ring2', offset(target, 2, 0)));
      engine.submitGuess(guess('far', offset(target, 0, 3 * (target.col > 15 ? -1 : 1))));
      engine.closeGuessing();
      engine.giveClue('stormy sea');
      engine.submitGuess(guess('far', offset(target, 1, 0)));
      engine.submitGuess(guess('exact', offset(target, 0, 1)));
      engine.closeGuessing();

      const state = engine.getPublicState();
      expect(state.phase).toBe('reveal');
      const result = state.lastResult;
      expect(result?.target).toEqual(target);
      const points = Object.fromEntries(result?.awards.map((a) => [a.userId, a.points]) ?? []);
      // A player's two pieces can't share a square, so 5 is the most per round.
      expect(points).toEqual({ exact: 5, near: 2, ring2: 1, far: 2 });
      expect(result?.awards[0]?.userId).toBe('exact');
      // Host earns a point per guess within the 3×3 frame: exact×2, near, far (2nd).
      expect(result?.hostPoints).toBe(4);
      expect(state.hostScore).toBe(4);
      expect(result?.totalGuessers).toBe(4);
      expect(state.leaderboard.map((p) => [p.userId, p.score])).toEqual([
        ['exact', 5],
        ['far', 2],
        ['near', 2],
        ['ring2', 1],
      ]);
    });

    it('accumulates scores across rounds and resets on demand', () => {
      let target = startRound();
      engine.giveClue('ocean');
      engine.submitGuess(guess('a', target));
      engine.reveal();
      target = startRound();
      engine.giveClue('grass');
      engine.submitGuess(guess('a', target));
      engine.reveal();
      expect(engine.getPublicState().leaderboard[0]).toMatchObject({ userId: 'a', score: 6 });
      expect(engine.getPublicState().roundNumber).toBe(2);
      engine.resetScores();
      expect(engine.getPublicState().leaderboard).toEqual([]);
      expect(engine.getPublicState().hostScore).toBe(0);
    });

    it('skips the second clue when disabled', () => {
      engine.updateSettings({ useSecondClue: false });
      startRound();
      engine.giveClue('ocean');
      engine.closeGuessing();
      expect(engine.currentPhase).toBe('reveal');
    });

    it('cancelling awards nothing', () => {
      const target = startRound();
      engine.giveClue('ocean');
      engine.submitGuess(guess('a', target));
      engine.cancelRound();
      expect(engine.currentPhase).toBe('idle');
      expect(engine.getPublicState().leaderboard).toEqual([]);
      expect(() => engine.cancelRound()).toThrow(GameError);
    });
  });

  describe('views', () => {
    it('never exposes the card or target publicly', () => {
      startRound();
      engine.giveClue('ocean');
      const publicState = engine.getPublicState() as unknown as Record<string, unknown>;
      expect(publicState).not.toHaveProperty('card');
      expect(publicState).not.toHaveProperty('target');
      expect(publicState.lastResult).toBeNull();
      expect(engine.getHostState().target).not.toBeNull();
    });
  });

  describe('snapshots', () => {
    it('round-trips mid-round state through the schema', () => {
      const target = startRound();
      engine.giveClue('ocean');
      engine.submitGuess(guess('a', target));
      engine.submitGuess(guess('b', offset(target, 1, 1)));

      const json = JSON.parse(JSON.stringify(engine.toSnapshot())) as unknown;
      const restored = new GameEngine({
        channel: 'streamer',
        now: clock.now,
        snapshot: gameSnapshotSchema.parse(json),
      });
      expect(restored.getHostState()).toEqual(engine.getHostState());
      expect(restored.getHostState().usedCues).toEqual(['ocean']);

      restored.reveal();
      expect(restored.getPublicState().lastResult?.hostPoints).toBe(2);
    });

    it('round-trips a revealed game', () => {
      startRound();
      engine.giveClue('ocean');
      engine.reveal();
      const restored = new GameEngine({
        channel: 'streamer',
        snapshot: gameSnapshotSchema.parse(engine.toSnapshot()),
      });
      expect(restored.getPublicState()).toEqual(engine.getPublicState());
    });

    it('loads snapshots saved before cue words were recorded', () => {
      const older: Partial<ReturnType<typeof engine.toSnapshot>> = engine.toSnapshot();
      delete older.usedCues;
      expect(gameSnapshotSchema.parse(older).usedCues).toEqual([]);
    });

    it('replaces only invalid or missing stored settings with defaults', () => {
      const snapshot = {
        ...engine.toSnapshot(),
        // An old snapshot: an invalid value, a renamed setting, others missing.
        settings: { guessDurationSeconds: -5, useSecondClue: false, enforceClueWordLimits: true },
      };
      const restored = new GameEngine({
        channel: 'streamer',
        snapshot: gameSnapshotSchema.parse(snapshot),
      });
      expect(restored.currentSettings).toEqual({
        guessDurationSeconds: 45,
        allowGuessChanges: false,
        oneGuessPerSquare: true,
        useSecondClue: false,
        requireGuessCommand: false,
        enforceCueRules: true,
      });
    });
  });
});
