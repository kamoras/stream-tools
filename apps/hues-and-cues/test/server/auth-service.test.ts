import { beforeEach, describe, expect, it } from 'vitest';
import { AuthError, AuthService } from '../../src/server/auth/auth-service.js';
import { LoginThrottle } from '../../src/server/auth/login-throttle.js';
import { hashPassword } from '../../src/server/auth/passwords.js';
import { SessionRepository } from '../../src/server/auth/session-repository.js';
import { UserRepository } from '../../src/server/auth/user-repository.js';
import { type Db, openDatabase } from '../../src/server/db/database.js';
import { FAST_SCRYPT, fakeClock, silentLogger } from '../helpers.js';

const HOUR = 60 * 60 * 1000;

describe('AuthService', () => {
  let db: Db;
  let clock: ReturnType<typeof fakeClock>;
  let users: UserRepository;
  let sessions: SessionRepository;

  const createService = (overrides: Partial<ConstructorParameters<typeof AuthService>[0]> = {}) =>
    new AuthService({
      users,
      sessions,
      logger: silentLogger,
      registrationEnabled: true,
      registrationCode: undefined,
      scryptParams: FAST_SCRYPT,
      throttle: new LoginThrottle(3, 15 * 60 * 1000, clock.now),
      ...overrides,
    });

  beforeEach(() => {
    db = openDatabase(':memory:', silentLogger);
    clock = fakeClock();
    users = new UserRepository(db, clock.now);
    sessions = new SessionRepository(db, { ttlMs: 24 * HOUR, now: clock.now });
  });

  it('registers, resolves the session and logs in again', async () => {
    const auth = createService();
    const { user, sessionToken } = await auth.register(
      'Streamer_1',
      'a long passphrase',
      undefined,
    );
    expect(user.username).toBe('Streamer_1');
    expect(auth.resolveSession(sessionToken)?.id).toBe(user.id);

    const login = await auth.login('streamer_1', 'a long passphrase');
    expect(login.user.id).toBe(user.id);
    expect(login.sessionToken).not.toBe(sessionToken);
  });

  it('rejects duplicate usernames case-insensitively', async () => {
    const auth = createService();
    await auth.register('Alice', 'password one!', undefined);
    await expect(auth.register('ALICE', 'password two!', undefined)).rejects.toMatchObject({
      code: 'username_taken',
    });
  });

  it('enforces registration settings', async () => {
    await expect(
      createService({ registrationEnabled: false }).register('bob', 'password123', undefined),
    ).rejects.toMatchObject({ code: 'registration_closed' });

    const gated = createService({ registrationCode: 'let-me-in' });
    await expect(gated.register('bob', 'password123', 'wrong')).rejects.toMatchObject({
      code: 'invalid_registration_code',
    });
    await expect(gated.register('bob', 'password123', 'let-me-in')).resolves.toBeDefined();
  });

  it('gives the same error for unknown users and wrong passwords', async () => {
    const auth = createService();
    await auth.register('carol', 'right password', undefined);
    const wrong = await auth.login('carol', 'wrong password').catch((e: unknown) => e);
    const unknown = await auth.login('nobody', 'whatever').catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(AuthError);
    expect(unknown).toBeInstanceOf(AuthError);
    expect((wrong as AuthError).message).toBe((unknown as AuthError).message);
  });

  it('throttles repeated failures for one account', async () => {
    const auth = createService();
    await auth.register('dave', 'right password', undefined);
    for (let i = 0; i < 3; i += 1) {
      await expect(auth.login('dave', 'nope')).rejects.toMatchObject({
        code: 'invalid_credentials',
      });
    }
    const error = (await auth
      .login('DAVE', 'right password')
      .catch((e: unknown) => e)) as AuthError;
    expect(error.code).toBe('throttled');
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('upgrades weak password hashes on login', async () => {
    const weak = await hashPassword('old password', { N: 2 ** 9, r: 8, p: 1 });
    const { id } = users.create('erin', weak);
    await createService().login('erin', 'old password');
    expect(users.findById(id)?.passwordHash).not.toBe(weak);
  });

  it('changes passwords and signs out other sessions', async () => {
    const auth = createService();
    const first = await auth.register('frank', 'first password', undefined);
    const second = await auth.login('frank', 'first password');

    await expect(
      auth.changePassword(first.user.id, 'not it', 'second password', first.sessionToken),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });

    await auth.changePassword(
      first.user.id,
      'first password',
      'second password',
      first.sessionToken,
    );
    expect(auth.resolveSession(first.sessionToken)).toBeDefined();
    expect(auth.resolveSession(second.sessionToken)).toBeUndefined();
    await expect(auth.login('frank', 'first password')).rejects.toBeInstanceOf(AuthError);
    await expect(auth.login('frank', 'second password')).resolves.toBeDefined();
  });

  it('logs out and expires sessions', async () => {
    const auth = createService();
    const { sessionToken } = await auth.register('gina', 'my password!', undefined);
    auth.logout(sessionToken);
    expect(auth.resolveSession(sessionToken)).toBeUndefined();
    expect(auth.resolveSession(undefined)).toBeUndefined();

    const login = await auth.login('gina', 'my password!');
    clock.advance(25 * HOUR);
    expect(auth.resolveSession(login.sessionToken)).toBeUndefined();
  });

  it('slides session expiry forward with use', async () => {
    const auth = createService();
    const { sessionToken } = await auth.register('hank', 'my password!', undefined);
    for (let i = 0; i < 5; i += 1) {
      clock.advance(20 * HOUR);
      expect(auth.resolveSession(sessionToken)).toBeDefined();
    }
  });

  it('prunes expired sessions', async () => {
    const auth = createService();
    await auth.register('ivy', 'my password!', undefined);
    clock.advance(25 * HOUR);
    auth.pruneExpired();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });
});
