import { beforeEach, describe, expect, it } from 'vitest';
import { AuthError, AuthService } from '../../src/server/auth/auth-service.js';
import { InviteRepository } from '../../src/server/auth/invite-codes.js';
import { LoginThrottle } from '../../src/server/auth/login-throttle.js';
import { hashPassword } from '../../src/server/auth/passwords.js';
import { SessionRepository } from '../../src/server/auth/session-repository.js';
import { UserRepository } from '../../src/server/auth/user-repository.js';
import { type Db, openDatabase } from '../../src/server/db/database.js';
import { FAST_SCRYPT, fakeClock, silentLogger } from '../helpers.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('AuthService', () => {
  let db: Db;
  let clock: ReturnType<typeof fakeClock>;
  let users: UserRepository;
  let sessions: SessionRepository;
  let invites: InviteRepository;

  /** A fresh single-use invite code. */
  const invite = (): string => invites.create(DAY).code;

  const createService = (overrides: Partial<ConstructorParameters<typeof AuthService>[0]> = {}) =>
    new AuthService({
      users,
      sessions,
      invites,
      transaction: (fn) => db.transaction(fn)(),
      logger: silentLogger,
      scryptParams: FAST_SCRYPT,
      throttle: new LoginThrottle(3, 15 * 60 * 1000, clock.now),
      ...overrides,
    });

  beforeEach(() => {
    db = openDatabase(':memory:', silentLogger);
    clock = fakeClock();
    users = new UserRepository(db, clock.now);
    sessions = new SessionRepository(db, { ttlMs: 24 * HOUR, now: clock.now });
    invites = new InviteRepository(db, clock.now);
  });

  it('registers, resolves the session and logs in again', async () => {
    const auth = createService();
    const { user, sessionToken } = await auth.register('Streamer_1', 'a long passphrase', invite());
    expect(user.username).toBe('Streamer_1');
    expect(auth.resolveSession(sessionToken)?.id).toBe(user.id);

    const login = await auth.login('streamer_1', 'a long passphrase');
    expect(login.user.id).toBe(user.id);
    expect(login.sessionToken).not.toBe(sessionToken);
  });

  it('rejects duplicate usernames case-insensitively', async () => {
    const auth = createService();
    await auth.register('Alice', 'password one!', invite());
    await expect(auth.register('ALICE', 'password two!', invite())).rejects.toMatchObject({
      code: 'username_taken',
    });
  });

  it('requires a valid invite code and uses it up', async () => {
    const auth = createService();
    await expect(auth.register('bob', 'password123', 'NOPE-NOPE-NOPE')).rejects.toMatchObject({
      code: 'invalid_invite',
    });
    const code = invite();
    const { user } = await auth.register(
      'bob',
      'password123',
      code.toLowerCase().replace(/-/gu, ' '),
    );
    expect(invites.list()[0]).toMatchObject({ status: 'used', usedBy: 'bob' });
    expect(user.username).toBe('bob');
    await expect(auth.register('bob2', 'password123', code)).rejects.toMatchObject({
      code: 'invalid_invite',
    });
  });

  it('does not use up the code when the username is taken', async () => {
    const auth = createService();
    await auth.register('carl', 'password123', invite());
    const code = invite();
    await expect(auth.register('CARL', 'password123', code)).rejects.toMatchObject({
      code: 'username_taken',
    });
    expect(invites.isRedeemable(code)).toBe(true);
  });

  it('lets only one of two concurrent sign-ups use a code', async () => {
    const auth = createService();
    const code = invite();
    const results = await Promise.allSettled([
      auth.register('racer_a', 'password123', code),
      auth.register('racer_b', 'password123', code),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(users.count()).toBe(1);
  });

  it('rejects expired and revoked codes', async () => {
    const auth = createService();
    const expired = invite();
    clock.advance(DAY + 1);
    await expect(auth.register('dora', 'password123', expired)).rejects.toMatchObject({
      code: 'invalid_invite',
    });
    const { code, invite: summary } = invites.create(DAY);
    invites.revoke(summary.id);
    await expect(auth.register('dora', 'password123', code)).rejects.toMatchObject({
      code: 'invalid_invite',
    });
  });

  it('gives the same error for unknown users and wrong passwords', async () => {
    const auth = createService();
    await auth.register('carol', 'right password', invite());
    const wrong = await auth.login('carol', 'wrong password').catch((e: unknown) => e);
    const unknown = await auth.login('nobody', 'whatever').catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(AuthError);
    expect(unknown).toBeInstanceOf(AuthError);
    expect((wrong as AuthError).message).toBe((unknown as AuthError).message);
  });

  it('throttles repeated failures for one account', async () => {
    const auth = createService();
    await auth.register('dave', 'right password', invite());
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

  it('throttles per client, so one attacker cannot lock the owner out', async () => {
    const auth = createService();
    await auth.register('ivy', 'right password', invite());
    for (let i = 0; i < 3; i += 1) {
      await expect(auth.login('ivy', 'nope', '203.0.113.9')).rejects.toMatchObject({
        code: 'invalid_credentials',
      });
    }
    await expect(auth.login('ivy', 'right password', '203.0.113.9')).rejects.toMatchObject({
      code: 'throttled',
    });
    await expect(auth.login('ivy', 'right password', '198.51.100.1')).resolves.toBeDefined();
  });

  it('counts concurrent attempts before hashing', async () => {
    const auth = createService();
    await auth.register('jo', 'right password', invite());
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => auth.login('jo', 'nope', '203.0.113.9')),
    );
    const codes = results.map((r) =>
      r.status === 'rejected' ? (r.reason as AuthError).code : 'ok',
    );
    expect(codes.filter((c) => c === 'throttled')).toHaveLength(3);
  });

  it('reports when a session slides, so the cookie can be re-issued', async () => {
    const auth = createService();
    const { sessionToken } = await auth.register('kim', 'right password', invite());
    expect(auth.resolveSessionDetailed(sessionToken)?.renewed).toBe(false);
    clock.advance(2 * HOUR);
    expect(auth.resolveSessionDetailed(sessionToken)?.renewed).toBe(true);
    expect(auth.resolveSessionDetailed(sessionToken)?.renewed).toBe(false);
  });

  it('upgrades weak password hashes on login', async () => {
    const weak = await hashPassword('old password', { N: 2 ** 9, r: 8, p: 1 });
    const { id } = users.create('erin', weak);
    await createService().login('erin', 'old password');
    expect(users.findById(id)?.passwordHash).not.toBe(weak);
  });

  it('changes passwords and signs out other sessions', async () => {
    const auth = createService();
    const first = await auth.register('frank', 'first password', invite());
    const second = await auth.login('frank', 'first password');

    await expect(
      auth.changePassword(first.user.id, 'not it', 'second password', first.sessionToken),
    ).rejects.toMatchObject({ code: 'wrong_password' });

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
    const { sessionToken } = await auth.register('gina', 'my password!', invite());
    auth.logout(sessionToken);
    expect(auth.resolveSession(sessionToken)).toBeUndefined();
    expect(auth.resolveSession(undefined)).toBeUndefined();

    const login = await auth.login('gina', 'my password!');
    clock.advance(25 * HOUR);
    expect(auth.resolveSession(login.sessionToken)).toBeUndefined();
  });

  it('slides session expiry forward with use', async () => {
    const auth = createService();
    const { sessionToken } = await auth.register('hank', 'my password!', invite());
    for (let i = 0; i < 5; i += 1) {
      clock.advance(20 * HOUR);
      expect(auth.resolveSession(sessionToken)).toBeDefined();
    }
  });

  it('prunes expired sessions', async () => {
    const auth = createService();
    await auth.register('ivy', 'my password!', invite());
    clock.advance(25 * HOUR);
    auth.pruneExpired();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });
});
