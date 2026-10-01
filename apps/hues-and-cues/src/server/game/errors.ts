import type { ErrorCode } from '../../shared/protocol.js';

/** An expected, user-facing failure (bad command for the current phase etc.). */
export class GameError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GameError';
  }
}
