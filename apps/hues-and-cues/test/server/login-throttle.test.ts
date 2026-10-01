import { describe, expect, it } from 'vitest';
import { LoginThrottle } from '../../src/server/auth/login-throttle.js';
import { fakeClock } from '../helpers.js';

describe('LoginThrottle', () => {
  it('locks a key after repeated failures until the window passes', () => {
    const clock = fakeClock();
    const throttle = new LoginThrottle(3, 60_000, clock.now);
    for (let i = 0; i < 3; i += 1) {
      expect(throttle.retryAfterSeconds('alice')).toBe(0);
      throttle.recordFailure('alice');
      clock.advance(1000);
    }
    expect(throttle.retryAfterSeconds('alice')).toBe(57);
    expect(throttle.retryAfterSeconds('bob')).toBe(0);
    clock.advance(57_000);
    expect(throttle.retryAfterSeconds('alice')).toBe(0);
  });

  it('resets on success and prunes stale entries', () => {
    const clock = fakeClock();
    const throttle = new LoginThrottle(2, 60_000, clock.now);
    throttle.recordFailure('a');
    throttle.recordFailure('a');
    throttle.reset('a');
    expect(throttle.retryAfterSeconds('a')).toBe(0);
    throttle.recordFailure('b');
    clock.advance(61_000);
    throttle.prune();
    expect(throttle.retryAfterSeconds('b')).toBe(0);
  });
});
