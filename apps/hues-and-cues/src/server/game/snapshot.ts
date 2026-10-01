import { z } from 'zod';
import { coordSchema, gameSettingsSchema } from '../../shared/protocol.js';

/**
 * Stored settings, field by field: an invalid, missing or renamed setting is
 * dropped (and later replaced by its default) without discarding the rest.
 */
const { shape: settingsShape } = gameSettingsSchema;
const storedSettingsSchema = z
  .object({
    guessDurationSeconds: settingsShape.guessDurationSeconds.optional().catch(undefined),
    allowGuessChanges: settingsShape.allowGuessChanges.optional().catch(undefined),
    oneGuessPerSquare: settingsShape.oneGuessPerSquare.optional().catch(undefined),
    useSecondClue: settingsShape.useSecondClue.optional().catch(undefined),
    requireGuessCommand: settingsShape.requireGuessCommand.optional().catch(undefined),
    enforceCueRules: settingsShape.enforceCueRules.optional().catch(undefined),
  })
  .catch({});

const clueNumberSchema = z.union([z.literal(1), z.literal(2)]);

const guessSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  color: z.string().nullable(),
  coord: coordSchema,
  clueNumber: clueNumberSchema,
  at: z.number(),
});

const playerScoreSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  color: z.string().nullable(),
  score: z.number().int().nonnegative(),
});

const roundResultSchema = z.object({
  roundNumber: z.number().int(),
  target: coordSchema,
  clues: z.array(z.string()),
  awards: z.array(
    z.object({
      userId: z.string(),
      displayName: z.string(),
      color: z.string().nullable(),
      points: z.number().int(),
      bestGuess: coordSchema,
    }),
  ),
  hostPoints: z.number().int(),
  totalGuessers: z.number().int(),
});

const roundSchema = z.object({
  card: z.array(coordSchema),
  targetIndex: z.number().int().nullable(),
  clues: z.array(z.string()),
  activeClue: clueNumberSchema.nullable(),
  deadline: z.number().nullable(),
  guesses: z.array(guessSchema),
});

/** Persistable form of a game. Versioned so the format can evolve safely. */
export const gameSnapshotSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(['idle', 'picking', 'guessing', 'intermission', 'reveal']),
    roundNumber: z.number().int().nonnegative(),
    round: roundSchema.nullable(),
    settings: storedSettingsSchema,
    leaderboard: z.array(playerScoreSchema),
    hostScore: z.number().int().nonnegative(),
    lastResult: roundResultSchema.nullable(),
    /** Added after version 1 shipped; older snapshots have none. */
    usedCues: z.array(z.string()).default([]),
  })
  .superRefine((snapshot, ctx) => {
    // Reject internally inconsistent state instead of letting it crash the engine later.
    const { phase, round } = snapshot;
    if (round === null) {
      if (phase === 'picking' || phase === 'guessing' || phase === 'intermission') {
        ctx.addIssue({ code: 'custom', path: ['round'], message: `phase ${phase} needs a round` });
      }
      return;
    }
    if (
      round.targetIndex !== null &&
      (round.targetIndex < 0 || round.targetIndex >= round.card.length)
    ) {
      ctx.addIssue({ code: 'custom', path: ['round', 'targetIndex'], message: 'not on the card' });
    }
    if ((phase === 'guessing' || phase === 'intermission') && round.targetIndex === null) {
      ctx.addIssue({ code: 'custom', path: ['round', 'targetIndex'], message: 'target required' });
    }
    if (
      phase === 'guessing' &&
      (round.activeClue === null || round.clues.length < round.activeClue)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['round', 'activeClue'],
        message: 'active clue required',
      });
    }
  });
export type GameSnapshot = z.infer<typeof gameSnapshotSchema>;
