import { describe, expect, it } from 'vitest';
import { AdminSessions, type LoginError } from '../../src/server/sessions.js';
import { fakeClock } from '../helpers.js';

describe('AdminSessions', () => {
  it('issues sessions that expire', () => {
    const clock = fakeClock();
    const sessions = new AdminSessions({ password: 'pw', ttlMs: 1000, now: clock.now });
    const token = sessions.login('pw');
    expect(sessions.isValid(token)).toBe(true);
    clock.advance(1000);
    expect(sessions.isValid(token)).toBe(false);
  });

  it('logs out and prunes', () => {
    const clock = fakeClock();
    const sessions = new AdminSessions({ password: 'pw', ttlMs: 1000, now: clock.now });
    const a = sessions.login('pw');
    const b = sessions.login('pw');
    sessions.logout(a);
    expect(sessions.isValid(a)).toBe(false);
    clock.advance(2000);
    sessions.prune();
    expect(sessions.isValid(b)).toBe(false);
    expect(sessions.isValid(undefined)).toBe(false);
  });

  it('throttles repeated failures, then recovers', () => {
    const clock = fakeClock();
    const sessions = new AdminSessions({
      password: 'pw',
      maxFailures: 2,
      failureWindowMs: 60_000,
      now: clock.now,
    });
    expect(() => sessions.login('x')).toThrow('Incorrect password.');
    expect(() => sessions.login('y')).toThrow('Incorrect password.');
    let error: LoginError | undefined;
    try {
      sessions.login('pw');
    } catch (e) {
      error = e as LoginError;
    }
    expect(error?.retryAfterSeconds).toBe(60);
    clock.advance(60_001);
    expect(sessions.login('pw')).toBeTypeOf('string');
  });
});
