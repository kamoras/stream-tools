import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, verifyPassword } from '../../src/server/auth/passwords.js';
import { FAST_SCRYPT } from '../helpers.js';

describe('passwords', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery', FAST_SCRYPT);
    expect(hash).toMatch(/^scrypt\$1024\$8\$1\$[\w-]+\$[\w-]+$/u);
    await expect(verifyPassword('correct horse battery', hash)).resolves.toBe(true);
    await expect(verifyPassword('correct horse batterY', hash)).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same password', FAST_SCRYPT),
      hashPassword('same password', FAST_SCRYPT),
    ]);
    expect(a).not.toBe(b);
  });

  it('normalises Unicode so equivalent input matches', async () => {
    const hash = await hashPassword('café au lait', FAST_SCRYPT);
    await expect(verifyPassword('café au lait', hash)).resolves.toBe(true);
  });

  it('rejects malformed hashes without throwing', async () => {
    for (const bad of [
      '',
      'plain',
      'scrypt$x$8$1$a$b',
      'bcrypt$1$2$3$4$5',
      'scrypt$1024$8$1$c2FsdA$c2hvcnQ',
    ]) {
      await expect(verifyPassword('anything', bad)).resolves.toBe(false);
    }
  });

  it('flags hashes weaker than the current parameters', async () => {
    const weak = await hashPassword('password123', FAST_SCRYPT);
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(weak, FAST_SCRYPT)).toBe(false);
    expect(needsRehash('garbage')).toBe(true);
  });
});
