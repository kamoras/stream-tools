import { pino } from 'pino';

export const silentLogger = pino({ level: 'silent' });

/** Deterministic PRNG (mulberry32) so card draws are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A manually advanced clock. */
export function fakeClock(start = 1_700_000_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

/** Cheap scrypt parameters so tests stay fast. Never use outside tests. */
export const FAST_SCRYPT = { N: 2 ** 10, r: 8, p: 1 } as const;
