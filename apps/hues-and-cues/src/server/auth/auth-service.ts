import type { Logger } from 'pino';
import { safeEqual } from '../security/tokens.js';
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
  | 'invalid_credentials'
  | 'registration_closed'
  | 'invalid_registration_code'
  | 'username_taken'
  | 'throttled';

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
  readonly logger: Logger;
  readonly registrationEnabled: boolean;
  readonly registrationCode: string | undefined;
  readonly throttle?: LoginThrottle;
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
  private readonly scryptParams: ScryptParams;
  private dummyHash: Promise<string> | null = null;

  public readonly registrationEnabled: boolean;
  public readonly registrationCode: string | undefined;

  public constructor(options: AuthServiceOptions) {
    this.users = options.users;
    this.sessions = options.sessions;
    this.logger = options.logger.child({ component: 'auth' });
    this.registrationEnabled = options.registrationEnabled;
    this.registrationCode = options.registrationCode;
    this.throttle = options.throttle ?? new LoginThrottle();
    this.scryptParams = options.scryptParams ?? DEFAULT_SCRYPT_PARAMS;
  }

  public async register(
    username: string,
    password: string,
    registrationCode: string | undefined,
  ): Promise<AuthResult> {
    if (!this.registrationEnabled) {
      throw new AuthError('registration_closed', 'Registration is closed on this server.');
    }
    if (
      this.registrationCode !== undefined &&
      !safeEqual(registrationCode ?? '', this.registrationCode)
    ) {
      throw new AuthError('invalid_registration_code', 'Incorrect registration code.');
    }
    if (this.users.findByUsername(username)) {
      throw new AuthError('username_taken', 'That username is already taken.');
    }
    const passwordHash = await hashPassword(password, this.scryptParams);
    let user: User;
    try {
      user = this.users.create(username, passwordHash);
    } catch (error) {
      // Lost a race with a concurrent registration for the same name.
      if (error instanceof UsernameTakenError) {
        throw new AuthError('username_taken', 'That username is already taken.');
      }
      throw error;
    }
    this.logger.info({ userId: user.id }, 'Account created');
    return { user, sessionToken: this.sessions.create(user.id) };
  }

  public async login(username: string, password: string): Promise<AuthResult> {
    const key = normalizeUsername(username);
    const retryAfter = this.throttle.retryAfterSeconds(key);
    if (retryAfter > 0) {
      throw new AuthError(
        'throttled',
        'Too many failed sign-in attempts. Try again later.',
        retryAfter,
      );
    }

    const user = this.users.findByUsername(username);
    // Always run the hash so response time doesn't reveal whether the user exists.
    const valid = await verifyPassword(password, user?.passwordHash ?? (await this.getDummyHash()));
    if (!user || !valid) {
      this.throttle.recordFailure(key);
      this.logger.info({ username: key }, 'Failed sign-in');
      throw new AuthError('invalid_credentials', INVALID_CREDENTIALS);
    }

    this.throttle.reset(key);
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
      throw new AuthError('invalid_credentials', 'Your current password is incorrect.');
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
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword('dummy-password-for-timing', this.scryptParams);
    return this.dummyHash;
  }
}
