import { beforeEach, describe, expect, it } from 'vitest';
import { AdminAuth, AdminLoginError } from '../../src/server/admin/admin-auth.js';
import { LoginThrottle } from '../../src/server/auth/login-throttle.js';
import { type Db, openDatabase } from '../../src/server/db/database.js';
import { fakeClock, silentLogger } from '../helpers.js';

describe('AdminAuth', () => {
  let db: Db;
  let clock: ReturnType<typeof fakeClock>;

  beforeEach(() => {
    db = openDatabase(':memory:', silentLogger);
    clock = fakeClock();
  });

  const PASSWORD = 'correct horse battery';
  const create = (password: string | undefined = PASSWORD) =>
    new AdminAuth({
      db,
      password,
      logger: silentLogger,
      ttlMs: 60_000,
      now: clock.now,
      throttle: new LoginThrottle(3, 60_000, clock.now),
    });

  it('issues expiring sessions for the right password', () => {
    const admin = create();
    const token = admin.login('correct horse battery');
    expect(admin.isValid(token)).toBe(true);
    clock.advance(60_000);
    expect(admin.isValid(token)).toBe(false);
    admin.pruneExpired();
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get()).toEqual({ n: 0 });
  });

  it('rejects wrong passwords and locks out after repeated failures', () => {
    const admin = create();
    for (let i = 0; i < 3; i += 1) {
      expect(() => admin.login('wrong')).toThrow('Incorrect password.');
    }
    const error = (() => {
      try {
        admin.login('correct horse battery');
        return undefined;
      } catch (e) {
        return e as AdminLoginError;
      }
    })();
    expect(error?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('logs out', () => {
    const admin = create();
    const token = admin.login('correct horse battery');
    admin.logout(token);
    expect(admin.isValid(token)).toBe(false);
    expect(admin.isValid(undefined)).toBe(false);
  });

  it('is disabled without a password', () => {
    const admin = new AdminAuth({ db, password: undefined, logger: silentLogger });
    expect(admin.enabled).toBe(false);
    expect(() => admin.login('')).toThrow(AdminLoginError);
  });
});
