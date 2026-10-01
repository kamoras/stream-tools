import type { Logger } from 'pino';
import type { InviteRepository } from './invite-codes.js';
import { LoginThrottle } from './login-throttle.js';
import {
  DEFAULT_SCRYPT_PARAMS,
  hashPassword,
  needsRehash,
  type ScryptParams,
  verifyPassword,
} from './passwords.js';
import type { SessionRepository } from './session-repository.js';
import {
  normalizeUsername,
  type User,
  type UserRepository,
  UsernameTakenError,
} from './user-repository.js';

export type AuthErrorCode =
  'invalid_credentials' | 'wrong_password' | 'invalid_invite' | 'username_taken' | 'throttled';

export class AuthError extends Error {
  public constructor(
    public readonly code: AuthErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthServiceOptions {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly invites: InviteRepository;
  /** Runs `fn` atomically (a database transaction). */
  readonly transaction: <T>(fn: () => T) => T;
  readonly logger: Logger;
  /** Failures per username and client IP. Defaults to 5 per 15 minutes. */
  readonly throttle?: LoginThrottle;
  /**
   * Failures per username from any IP: a ceiling against distributed
   * guessing that is high enough that one attacker can't lock the owner out.
   * Defaults to 50 per 15 minutes.
   */
  readonly accountThrottle?: LoginThrottle;
  readonly scryptParams?: ScryptParams;
}

export interface AuthResult {
  readonly user: User;
  /** Raw session token for the cookie. */
  readonly sessionToken: string;
}

const INVALID_CREDENTIALS = 'Incorrect username or password.';

/** Account registration, login and password management. */
export class AuthService {
  private readonly users: UserRepository;
  private readonly sessions: SessionRepository;
  private readonly logger: Logger;
  private readonly throttle: LoginThrottle;
  private readonly accountThrottle: LoginThrottle;
  private readonly scryptParams: ScryptParams;
  private readonly invites: InviteRepository;
  private readonly transaction: <T>(fn: () => T) => T;
  private dummyHash: Promise<string> | null = null;

  public constructor(options: AuthServiceOptions) {
    this.users = options.users;
    this.sessions = options.sessions;
    this.logger = options.logger.child({ component: 'auth' });
    this.invites = options.invites;
    this.transaction = options.transaction;
    this.throttle = options.throttle ?? new LoginThrottle();
    this.accountThrottle = options.accountThrottle ?? new LoginThrottle(50);
    this.scryptParams = options.scryptParams ?? DEFAULT_SCRYPT_PARAMS;
  }

  /** Creates an account, consuming a single-use invite code. */
  public async register(
    username: string,
    password: string,
    inviteCode: string,
  ): Promise<AuthResult> {
    // Cheap checks first, so bad codes don't cost a password hash.
    if (!this.invites.isRedeemable(inviteCode)) throw invalidInvite();
    if (this.users.findByUsername(username)) throw usernameTaken();

    const passwordHash = await hashPassword(password, this.scryptParams);
    // Re-check and consume inside one transaction: the code can only ever
    // create one account, even under concurrent sign-ups.
    const user = this.transaction(() => {
      let created: User;
      try {
        created = this.users.create(username, passwordHash);
      } catch (error) {
        if (error instanceof UsernameTakenError) throw usernameTaken();
        throw error;
      }
      if (this.invites.consume(inviteCode, created.id, created.username) !== 'ok') {
        throw invalidInvite();
      }
      this.users.recordLogin(created.id);
      return created;
    });
    this.logger.info({ userId: user.id }, 'Account created');
    return { user, sessionToken: this.sessions.create(user.id) };
  }

  public async login(
    username: string,
    password: string,
    clientIp = 'unknown',
  ): Promise<AuthResult> {
    const accountKey = normalizeUsername(username);
    const clientKey = `${accountKey}|${clientIp}`;
    const retryAfter = Math.max(
      this.throttle.retryAfterSeconds(clientKey),
      this.accountThrottle.retryAfterSeconds(accountKey),
    );
    if (retryAfter > 0) {
      throw new AuthError(
        'throttled',
        'Too many failed sign-in attempts. Try again later.',
        retryAfter,
      );
    }
    // Count the attempt before the (slow) hash, so concurrent requests can't
    // all slip past the limit; a successful sign-in takes it back.
    this.throttle.recordFailure(clientKey);
    this.accountThrottle.recordFailure(accountKey);

    const user = this.users.findByUsername(username);
    // Always run the hash so response time doesn't reveal whether the user exists.
    const valid = await verifyPassword(password, user?.passwordHash ?? (await this.getDummyHash()));
    if (!user || !valid) {
      this.logger.info({ username: accountKey }, 'Failed sign-in');
      throw new AuthError('invalid_credentials', INVALID_CREDENTIALS);
    }

    this.throttle.reset(clientKey);
    this.accountThrottle.forgiveOne(accountKey);
    if (needsRehash(user.passwordHash, this.scryptParams)) {
      this.users.updatePasswordHash(user.id, await hashPassword(password, this.scryptParams));
    }
    this.users.recordLogin(user.id);
    return {
      user: { id: user.id, username: user.username, createdAt: user.createdAt },
      sessionToken: this.sessions.create(user.id),
    };
  }

  /** Changes the password and signs out every other session. */
  public async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
    currentSessionToken: string,
  ): Promise<void> {
    const user = this.users.findById(userId);
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new AuthError('wrong_password', 'Your current password is incorrect.');
    }
    this.users.updatePasswordHash(userId, await hashPassword(newPassword, this.scryptParams));
    this.sessions.revokeAllForUser(userId, currentSessionToken);
    this.logger.info({ userId }, 'Password changed');
  }

  public resolveSession(token: string | undefined): User | undefined {
    return token ? this.sessions.resolve(token) : undefined;
  }

  public logout(token: string | undefined): void {
    if (token) this.sessions.revoke(token);
  }

  public pruneExpired(): void {
    this.sessions.pruneExpired();
    this.throttle.prune();
    this.accountThrottle.prune();
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword('dummy-password-for-timing', this.scryptParams);
    return this.dummyHash;
  }
}

function invalidInvite(): AuthError {
  return new AuthError('invalid_invite', 'That invite code is invalid, expired or already used.');
}

function usernameTaken(): AuthError {
  return new AuthError('username_taken', 'That username is already taken.');
}
