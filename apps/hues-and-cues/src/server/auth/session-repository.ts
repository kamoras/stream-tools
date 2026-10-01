import type { Db } from '../db/database.js';
import { hashToken, randomId } from '../security/tokens.js';
import type { User } from './user-repository.js';

export interface SessionOptions {
  /** Sessions expire after this much inactivity. */
  readonly ttlMs: number;
  readonly now?: () => number;
}

interface SessionRow {
  user_id: number;
  username: string;
  user_created_at: number;
  last_seen_at: number;
  expires_at: number;
}

export interface ResolvedSession {
  readonly user: User;
  /** True when this lookup extended the expiry, so the cookie should be re-issued. */
  readonly renewed: boolean;
}

/** Writes to `last_seen_at` are batched to at most once per this interval. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Server-side sessions. The browser holds a random 256-bit token; only its
 * SHA-256 hash is stored, so a leaked database cannot be used to log in.
 * Expiry slides forward with use.
 */
export class SessionRepository {
  private readonly ttlMs: number;
  private readonly now: () => number;

  public constructor(
    private readonly db: Db,
    options: SessionOptions,
  ) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  /** Creates a session and returns the raw token for the cookie. */
  public create(userId: number): string {
    const token = randomId(32);
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(hashToken(token), userId, now, now, now + this.ttlMs);
    return token;
  }

  /** Returns the session's user, extending the session, or `undefined` if invalid. */
  public resolve(token: string): User | undefined {
    return this.resolveDetailed(token)?.user;
  }

  /** Like {@link resolve}, also reporting whether the expiry was extended. */
  public resolveDetailed(token: string): ResolvedSession | undefined {
    const tokenHash = hashToken(token);
    const row = this.db
      .prepare<[string], SessionRow>(
        `SELECT s.user_id, s.last_seen_at, s.expires_at,
                u.username, u.created_at AS user_created_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?`,
      )
      .get(tokenHash);
    if (!row) return undefined;

    const now = this.now();
    if (row.expires_at <= now) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      return undefined;
    }
    const renewed = now - row.last_seen_at >= TOUCH_INTERVAL_MS;
    if (renewed) {
      this.db
        .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
        .run(now, now + this.ttlMs, tokenHash);
    }
    return {
      user: { id: row.user_id, username: row.username, createdAt: row.user_created_at },
      renewed,
    };
  }

  public revoke(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  /** Signs the user out everywhere, optionally keeping one session. */
  public revokeAllForUser(userId: number, exceptToken?: string): void {
    if (exceptToken === undefined) {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    } else {
      this.db
        .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
        .run(userId, hashToken(exceptToken));
    }
  }

  public pruneExpired(): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now()).changes;
  }
}
