import {
  allCoords,
  chebyshevDistance,
  coordKey,
  type Coord,
  isValidCoord,
} from '../../shared/board.js';
import {
  type ClueNumber,
  DEFAULT_SETTINGS,
  type GameSettings,
  type HostGameState,
  type Phase,
  type PlayerScore,
  type PublicGameState,
  type PublicGuess,
  type RoundAward,
  type RoundResult,
} from '../../shared/protocol.js';
import {
  CARD_SIZE,
  cueRuleViolation,
  normalizeCue,
  HOST_SCORING_DISTANCE,
  pointsForGuess,
} from '../../shared/rules.js';
import { GameError } from './errors.js';
import type { GameSnapshot } from './snapshot.js';

/** Minimum Chebyshev distance between the colours on one card, so options differ. */
const MIN_CARD_SPACING = 3;
/** Most recent guesses included in the public state. */
const PUBLIC_GUESS_LIMIT = 200;
/** Players shown on the public leaderboard. */
const PUBLIC_LEADERBOARD_LIMIT = 50;
/** Hard cap on guesses accepted per clue, protecting memory on huge channels. */
const MAX_GUESSES_PER_CLUE = 10_000;

export interface GuessInput {
  readonly userId: string;
  readonly displayName: string;
  readonly color: string | null;
  readonly coord: Coord;
}

export type GuessOutcome =
  | 'accepted'
  | 'updated'
  | 'unchanged'
  | 'rejected_closed'
  | 'rejected_already_guessed'
  | 'rejected_occupied'
  | 'rejected_capacity';

export interface GameEngineOptions {
  readonly channel: string;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly snapshot?: GameSnapshot;
}

interface Round {
  card: Coord[];
  targetIndex: number | null;
  clues: string[];
  activeClue: ClueNumber | null;
  deadline: number | null;
  /** Guesses keyed by user id, one map per clue. */
  guesses: [Map<string, PublicGuess>, Map<string, PublicGuess>];
}

interface MutablePlayerScore {
  userId: string;
  displayName: string;
  color: string | null;
  score: number;
}

/**
 * The rules of one channel's game as a deterministic state machine.
 *
 * ```
 * idle ──drawCard──▶ picking ──giveClue──▶ guessing ──close──▶ intermission
 *   ▲                  ▲  │ selectTarget      │ ▲                │ giveClue
 *   │                  └──┘                   │ └────────────────┘
 *   │                                         ▼ (close/reveal)
 *   └──────────── cancelRound ─────────── reveal ──drawCard──▶ picking
 * ```
 *
 * Time and randomness are injected so behaviour is fully testable. The engine
 * performs no I/O; callers persist {@link GameEngine.toSnapshot} and schedule
 * {@link GameEngine.expireIfDue} for timed guessing windows.
 */
export class GameEngine {
  public readonly channel: string;

  private readonly now: () => number;
  private readonly random: () => number;

  private phase: Phase = 'idle';
  private roundNumber = 0;
  private round: Round | null = null;
  private settings: GameSettings = { ...DEFAULT_SETTINGS };
  private readonly leaderboard = new Map<string, MutablePlayerScore>();
  private hostScore = 0;
  private lastResult: RoundResult | null = null;
  /** Cues given since the scores were last reset (one "game"), normalised. */
  private readonly usedCues = new Set<string>();

  public constructor(options: GameEngineOptions) {
    this.channel = options.channel;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    if (options.snapshot) {
      this.restore(options.snapshot);
    }
  }

  public get currentPhase(): Phase {
    return this.phase;
  }

  public get currentSettings(): Readonly<GameSettings> {
    return this.settings;
  }

  /** Epoch ms at which the current guessing window closes, or `null`. */
  public get deadline(): number | null {
    return this.phase === 'guessing' ? (this.round?.deadline ?? null) : null;
  }

  // ---------------------------------------------------------------------------
  // Host commands
  // ---------------------------------------------------------------------------

  /** Draws a new card. Starts a new round, or redraws while still picking. */
  public drawCard(): void {
    this.assertPhase(['idle', 'picking', 'reveal'], 'draw a card');
    if (this.phase !== 'picking') {
      this.roundNumber += 1;
    }
    this.round = {
      card: this.generateCard(),
      targetIndex: null,
      clues: [],
      activeClue: null,
      deadline: null,
      guesses: [new Map<string, PublicGuess>(), new Map<string, PublicGuess>()],
    };
    this.phase = 'picking';
  }

  public selectTarget(index: number): void {
    const round = this.requireRound('picking', 'choose a colour');
    if (!Number.isInteger(index) || index < 0 || index >= round.card.length) {
      throw new GameError('bad_request', 'That colour is not on the card.');
    }
    round.targetIndex = index;
  }

  /** Gives the first clue (from `picking`) or the second clue (from `intermission`). */
  public giveClue(rawClue: string): void {
    this.assertPhase(['picking', 'intermission'], 'give a clue');
    const round = this.requireRound(this.phase, 'give a clue');
    if (this.phase === 'picking' && round.targetIndex === null) {
      throw new GameError('invalid_state', 'Choose a colour from the card before giving a clue.');
    }

    const clue = rawClue.trim().replace(/\s+/gu, ' ');
    const clueNumber: ClueNumber = this.phase === 'picking' ? 1 : 2;
    if (clue === '') {
      throw new GameError('bad_request', 'The clue cannot be empty.');
    }
    if (this.settings.enforceCueRules) {
      const violation = cueRuleViolation(clue, clueNumber, this.usedCues);
      if (violation !== null) throw new GameError('bad_request', violation);
    }

    this.usedCues.add(normalizeCue(clue));
    round.clues.push(clue);
    round.activeClue = clueNumber;
    round.deadline =
      this.settings.guessDurationSeconds > 0
        ? this.now() + this.settings.guessDurationSeconds * 1000
        : null;
    this.phase = 'guessing';
  }

  /** Stops accepting guesses; moves to the second clue or straight to the reveal. */
  public closeGuessing(): void {
    const round = this.requireRound('guessing', 'close guessing');
    round.deadline = null;
    if (round.activeClue === 1 && this.settings.useSecondClue) {
      round.activeClue = null;
      this.phase = 'intermission';
    } else {
      this.revealAndScore(round);
    }
  }

  /** Reveals the target immediately (skipping any remaining clue) and scores the round. */
  public reveal(): void {
    this.assertPhase(['guessing', 'intermission'], 'reveal the colour');
    this.revealAndScore(this.requireRound(this.phase, 'reveal the colour'));
  }

  /** Abandons the current round without awarding points. */
  public cancelRound(): void {
    this.assertPhase(['picking', 'guessing', 'intermission', 'reveal'], 'cancel the round');
    this.round = null;
    this.phase = 'idle';
  }

  /** Starts a new game: clears scores and the record of cues given. */
  public resetScores(): void {
    this.leaderboard.clear();
    this.usedCues.clear();
    this.hostScore = 0;
    this.lastResult = null;
  }

  public updateSettings(patch: Partial<GameSettings>): void {
    const next: GameSettings = { ...this.settings };
    for (const [key, value] of Object.entries(patch) as [keyof GameSettings, unknown][]) {
      if (value !== undefined) {
        Object.assign(next, { [key]: value });
      }
    }
    this.settings = next;
  }

  /** Closes guessing if its deadline has passed. Returns whether anything changed. */
  public expireIfDue(): boolean {
    const deadline = this.deadline;
    if (deadline !== null && this.now() >= deadline) {
      this.closeGuessing();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Player input
  // ---------------------------------------------------------------------------

  public submitGuess(input: GuessInput): GuessOutcome {
    const round = this.round;
    if (this.phase !== 'guessing' || round?.activeClue == null || !isValidCoord(input.coord)) {
      return 'rejected_closed';
    }

    const guesses = round.guesses[round.activeClue - 1];
    if (guesses === undefined) {
      return 'rejected_closed';
    }
    const previous = guesses.get(input.userId);
    if (previous) {
      if (!this.settings.allowGuessChanges) {
        return 'rejected_already_guessed';
      }
      if (previous.coord.row === input.coord.row && previous.coord.col === input.coord.col) {
        return 'unchanged';
      }
    } else if (guesses.size >= MAX_GUESSES_PER_CLUE) {
      return 'rejected_capacity';
    }
    if (this.isSquareTaken(round, input.userId, input.coord)) {
      return 'rejected_occupied';
    }

    // Delete first so the map's insertion order stays "most recent last".
    guesses.delete(input.userId);
    guesses.set(input.userId, {
      userId: input.userId,
      displayName: input.displayName,
      color: input.color,
      coord: { row: input.coord.row, col: input.coord.col },
      clueNumber: round.activeClue,
      at: this.now(),
    });
    return previous ? 'updated' : 'accepted';
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  public getPublicState(): PublicGameState {
    const round = this.round;
    const allGuesses = round ? [...round.guesses[0].values(), ...round.guesses[1].values()] : [];
    const cellCounts = new Map<number, number>();
    for (const guess of allGuesses) {
      const key = coordKey(guess.coord);
      cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
    }
    const recent = [...allGuesses].sort((a, b) => a.at - b.at).slice(-PUBLIC_GUESS_LIMIT);

    return {
      channel: this.channel,
      phase: this.phase,
      roundNumber: this.roundNumber,
      clues: round ? [...round.clues] : [],
      activeClue: this.phase === 'guessing' ? (round?.activeClue ?? null) : null,
      deadline: this.deadline,
      guesses: recent,
      cellCounts: [...cellCounts.entries()],
      totalGuesses: allGuesses.length,
      leaderboard: this.sortedLeaderboard().slice(0, PUBLIC_LEADERBOARD_LIMIT),
      hostScore: this.hostScore,
      lastResult: this.phase === 'reveal' ? this.lastResult : null,
      settings: { ...this.settings },
    };
  }

  public getHostState(): HostGameState {
    const round = this.round;
    const target = round?.targetIndex != null ? (round.card[round.targetIndex] ?? null) : null;
    return {
      ...this.getPublicState(),
      card: round ? [...round.card] : null,
      target,
      usedCues: [...this.usedCues],
    };
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  public toSnapshot(): GameSnapshot {
    const round = this.round;
    return {
      version: 1,
      phase: this.phase,
      roundNumber: this.roundNumber,
      round: round
        ? {
            card: round.card.map((c) => ({ ...c })),
            targetIndex: round.targetIndex,
            clues: [...round.clues],
            activeClue: round.activeClue,
            deadline: round.deadline,
            guesses: [...round.guesses[0].values(), ...round.guesses[1].values()].map((g) => ({
              ...g,
              coord: { ...g.coord },
            })),
          }
        : null,
      settings: { ...this.settings },
      leaderboard: this.sortedLeaderboard().map((p) => ({ ...p })),
      hostScore: this.hostScore,
      lastResult: this.lastResult && {
        ...this.lastResult,
        target: { ...this.lastResult.target },
        clues: [...this.lastResult.clues],
        awards: this.lastResult.awards.map((award) => ({
          ...award,
          bestGuess: { ...award.bestGuess },
        })),
      },
      usedCues: [...this.usedCues],
    };
  }

  private restore(snapshot: GameSnapshot): void {
    // Stored settings are kept field by field, so one invalid or renamed
    // setting falls back to its default without resetting the others.
    this.settings = { ...DEFAULT_SETTINGS };
    for (const [key, value] of Object.entries(snapshot.settings)) {
      if (value !== undefined) Object.assign(this.settings, { [key]: value });
    }
    this.roundNumber = snapshot.roundNumber;
    this.hostScore = snapshot.hostScore;
    for (const cue of snapshot.usedCues) this.usedCues.add(cue);
    this.lastResult = snapshot.lastResult;
    for (const player of snapshot.leaderboard) {
      this.leaderboard.set(player.userId, { ...player });
    }

    const round = snapshot.round;
    if (round === null) {
      this.phase = snapshot.phase === 'reveal' ? 'reveal' : 'idle';
      return;
    }
    this.round = {
      card: round.card.map((c) => ({ ...c })),
      targetIndex: round.targetIndex,
      clues: [...round.clues],
      activeClue: round.activeClue,
      deadline: round.deadline,
      guesses: [new Map<string, PublicGuess>(), new Map<string, PublicGuess>()],
    };
    for (const guess of [...round.guesses].sort((a, b) => a.at - b.at)) {
      this.round.guesses[guess.clueNumber - 1]?.set(guess.userId, guess);
    }
    this.phase = snapshot.phase;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Whether a guess at `coord` would break the one-piece-per-square rules. A
   * player's second guess can never share their first guess's square (in the
   * board game both pieces are on the board), and with `oneGuessPerSquare`
   * nobody may take a square another player holds. Moving within the same
   * clue frees the player's previous square.
   */
  private isSquareTaken(round: Round, userId: string, coord: Coord): boolean {
    const activeIndex = (round.activeClue ?? 1) - 1;
    for (const [index, guesses] of round.guesses.entries()) {
      for (const guess of guesses.values()) {
        if (guess.coord.row !== coord.row || guess.coord.col !== coord.col) continue;
        if (guess.userId === userId) {
          if (index !== activeIndex) return true;
        } else if (this.settings.oneGuessPerSquare) {
          return true;
        }
      }
    }
    return false;
  }

  private revealAndScore(round: Round): void {
    const target = round.targetIndex === null ? undefined : round.card[round.targetIndex];
    if (target === undefined) {
      throw new GameError('invalid_state', 'No colour was chosen this round.');
    }

    const perPlayer = new Map<string, { guess: PublicGuess; points: number; best: Coord }>();
    let hostPoints = 0;
    for (const guess of [...round.guesses[0].values(), ...round.guesses[1].values()]) {
      const points = pointsForGuess(guess.coord, target);
      if (chebyshevDistance(guess.coord, target) <= HOST_SCORING_DISTANCE) {
        hostPoints += 1;
      }
      const existing = perPlayer.get(guess.userId);
      if (!existing) {
        perPlayer.set(guess.userId, { guess, points, best: guess.coord });
        continue;
      }
      const isBetter =
        chebyshevDistance(guess.coord, target) < chebyshevDistance(existing.best, target);
      perPlayer.set(guess.userId, {
        guess: guess.at >= existing.guess.at ? guess : existing.guess,
        points: existing.points + points,
        best: isBetter ? guess.coord : existing.best,
      });
    }

    const awards: RoundAward[] = [];
    for (const [userId, { guess, points, best }] of perPlayer) {
      if (points > 0) {
        awards.push({
          userId,
          displayName: guess.displayName,
          color: guess.color,
          points,
          bestGuess: best,
        });
      }
      const player = this.leaderboard.get(userId);
      if (player) {
        player.score += points;
        player.displayName = guess.displayName;
        player.color = guess.color;
      } else if (points > 0) {
        this.leaderboard.set(userId, {
          userId,
          displayName: guess.displayName,
          color: guess.color,
          score: points,
        });
      }
    }
    awards.sort((a, b) => b.points - a.points || a.displayName.localeCompare(b.displayName));

    this.hostScore += hostPoints;
    round.deadline = null;
    round.activeClue = null;
    this.lastResult = {
      roundNumber: this.roundNumber,
      target: { ...target },
      clues: [...round.clues],
      awards,
      hostPoints,
      totalGuessers: perPlayer.size,
    };
    this.phase = 'reveal';
  }

  private sortedLeaderboard(): PlayerScore[] {
    return [...this.leaderboard.values()]
      .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName))
      .map((p) => ({ ...p }));
  }

  private generateCard(): Coord[] {
    const pool = allCoords();
    const card: Coord[] = [];
    while (card.length < CARD_SIZE && pool.length > 0) {
      const index = Math.floor(this.random() * pool.length);
      const [candidate] = pool.splice(index, 1);
      if (
        candidate !== undefined &&
        card.every((picked) => chebyshevDistance(picked, candidate) >= MIN_CARD_SPACING)
      ) {
        card.push(candidate);
      }
    }
    return card;
  }

  private assertPhase(allowed: readonly Phase[], action: string): void {
    if (!allowed.includes(this.phase)) {
      throw new GameError('invalid_state', `Cannot ${action} while the game is ${this.phase}.`);
    }
  }

  private requireRound(phase: Phase, action: string): Round {
    this.assertPhase([phase], action);
    if (this.round === null) {
      throw new GameError('invalid_state', `Cannot ${action}: no round is in progress.`);
    }
    return this.round;
  }
}
