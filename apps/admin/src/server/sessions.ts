import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class LoginError extends Error {
  public constructor(
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'LoginError';
  }
}

export interface AdminSessionsOptions {
  readonly password: string;
  readonly ttlMs?: number;
  readonly maxFailures?: number;
  readonly failureWindowMs?: number;
  readonly now?: () => number;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * The single admin login. The password is compared in constant time; failed
 * attempts are throttled per client IP, so a stranger can't lock the admin
 * out. Sessions are random 256-bit tokens kept (hashed) in memory with an
 * 8-hour lifetime; restarting the dashboard signs the admin out, which is
 * acceptable for a single operator.
 */
export class AdminSessions {
  private readonly passwordDigest: Buffer;
  private readonly ttlMs: number;
  private readonly maxFailures: number;
  private readonly failureWindowMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, number>();
  private readonly failures = new Map<string, number[]>();

  public constructor(options: AdminSessionsOptions) {
    this.passwordDigest = digest(options.password);
    this.ttlMs = options.ttlMs ?? 8 * 60 * 60 * 1000;
    this.maxFailures = options.maxFailures ?? 10;
    this.failureWindowMs = options.failureWindowMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  public get sessionTtlMs(): number {
    return this.ttlMs;
  }

  /** Returns a new session token, or throws {@link LoginError}. */
  public login(password: string, clientKey = 'unknown'): string {
    const now = this.now();
    const recent = this.recentFailures(clientKey, now);
    if (recent.length >= this.maxFailures) {
      const oldest = recent[0] ?? now;
      throw new LoginError(
        'Too many failed attempts. Try again later.',
        Math.max(1, Math.ceil((oldest + this.failureWindowMs - now) / 1000)),
      );
    }
    if (!timingSafeEqual(digest(password), this.passwordDigest)) {
      this.failures.set(clientKey, [...recent, now]);
      throw new LoginError('Incorrect password.');
    }
    this.failures.delete(clientKey);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(digest(token).toString('hex'), now + this.ttlMs);
    return token;
  }

  public isValid(token: string | undefined): boolean {
    if (!token) return false;
    const key = digest(token).toString('hex');
    const expiresAt = this.sessions.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  public logout(token: string | undefined): void {
    if (token) this.sessions.delete(digest(token).toString('hex'));
  }

  /** Drops expired sessions and stale failure records so memory stays bounded. */
  public prune(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.sessions) if (expiresAt <= now) this.sessions.delete(key);
    for (const key of [...this.failures.keys()]) this.recentFailures(key, now);
  }

  private recentFailures(clientKey: string, now: number): number[] {
    const recent = (this.failures.get(clientKey) ?? []).filter(
      (at) => at > now - this.failureWindowMs,
    );
    if (recent.length === 0) this.failures.delete(clientKey);
    else this.failures.set(clientKey, recent);
    return recent;
  }
}
