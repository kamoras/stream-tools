import type { Logger } from 'pino';
import { LoginThrottle } from '../auth/login-throttle.js';
import type { Db } from '../db/database.js';
import { hashToken, randomId, safeEqual } from '../security/tokens.js';

export interface AdminAuthOptions {
  readonly db: Db;
  /** The admin password; when undefined the admin area is disabled entirely. */
  readonly password: string | undefined;
  readonly logger: Logger;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly throttle?: LoginThrottle;
}

export class AdminLoginError extends Error {
  public constructor(
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AdminLoginError';
  }
}

const THROTTLE_KEY = 'admin';

/**
 * Admin sign-in, mirroring the dbd-bot's admin dashboard: a single password
 * from configuration (compared in constant time), behind a secret URL path,
 * with short server-side sessions. Admin sessions are separate from user
 * accounts, so no account can be promoted to admin.
 */
export class AdminAuth {
  private readonly db: Db;
  private readonly password: string | undefined;
  private readonly logger: Logger;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly throttle: LoginThrottle;

  public constructor(options: AdminAuthOptions) {
    this.db = options.db;
    this.password = options.password;
    this.logger = options.logger.child({ component: 'admin-auth' });
    this.ttlMs = options.ttlMs ?? 8 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.throttle = options.throttle ?? new LoginThrottle(10, 15 * 60 * 1000, this.now);
  }

  public get enabled(): boolean {
    return this.password !== undefined;
  }

  public get sessionTtlMs(): number {
    return this.ttlMs;
  }

  /** Returns a session token, or throws {@link AdminLoginError}. */
  public login(password: string): string {
    if (this.password === undefined) throw new AdminLoginError('Admin is disabled.');
    const retryAfter = this.throttle.retryAfterSeconds(THROTTLE_KEY);
    if (retryAfter > 0) {
      throw new AdminLoginError('Too many failed attempts. Try again later.', retryAfter);
    }
    if (!safeEqual(password, this.password)) {
      this.throttle.recordFailure(THROTTLE_KEY);
      this.logger.warn('Failed admin sign-in');
      throw new AdminLoginError('Incorrect password.');
    }
    this.throttle.reset(THROTTLE_KEY);
    const token = randomId(32);
    const now = this.now();
    this.db
      .prepare('INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), now, now + this.ttlMs);
    this.logger.info('Admin signed in');
    return token;
  }

  public isValid(token: string | undefined): boolean {
    if (!token || !this.enabled) return false;
    const row = this.db
      .prepare<[string], { expires_at: number }>(
        'SELECT expires_at FROM admin_sessions WHERE token_hash = ?',
      )
      .get(hashToken(token));
    return row !== undefined && row.expires_at > this.now();
  }

  public logout(token: string | undefined): void {
    if (token) {
      this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
    }
  }

  public pruneExpired(): void {
    this.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(this.now());
    this.throttle.prune();
  }
}
