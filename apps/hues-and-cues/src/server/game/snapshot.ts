import { z } from 'zod';
import { coordSchema, DEFAULT_SETTINGS, gameSettingsSchema } from '../../shared/protocol.js';

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
export const gameSnapshotSchema = z.object({
  version: z.literal(1),
  phase: z.enum(['idle', 'picking', 'guessing', 'intermission', 'reveal']),
  roundNumber: z.number().int().nonnegative(),
  round: roundSchema.nullable(),
  settings: gameSettingsSchema.catch(DEFAULT_SETTINGS),
  leaderboard: z.array(playerScoreSchema),
  hostScore: z.number().int().nonnegative(),
  lastResult: roundResultSchema.nullable(),
});
export type GameSnapshot = z.infer<typeof gameSnapshotSchema>;
