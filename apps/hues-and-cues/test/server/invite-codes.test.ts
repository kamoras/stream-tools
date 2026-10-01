import { beforeEach, describe, expect, it } from 'vitest';
import {
  generateInviteCode,
  InviteRepository,
  normalizeInviteCode,
} from '../../src/server/auth/invite-codes.js';
import { UserRepository } from '../../src/server/auth/user-repository.js';
import { type Db, openDatabase } from '../../src/server/db/database.js';
import { fakeClock, silentLogger } from '../helpers.js';

const DAY = 24 * 60 * 60 * 1000;

describe('invite code format', () => {
  it('generates distinct, grouped codes', () => {
    const codes = new Set(Array.from({ length: 200 }, generateInviteCode));
    expect(codes.size).toBe(200);
    for (const code of codes)
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/u);
  });

  it('normalises case, separators and look-alike characters', () => {
    expect(normalizeInviteCode('ab12-cd34-ef56')).toBe('AB12CD34EF56');
    expect(normalizeInviteCode(' AB12 CD34 EF56 ')).toBe('AB12CD34EF56');
    expect(normalizeInviteCode('O0IL-0000-0000')).toBe('0011' + '0'.repeat(8));
  });

  it('rejects input that cannot be a code', () => {
    for (const bad of ['', 'SHORT', 'AB12-CD34-EF56-GH78', 'AB12-CD34-EF5U', 'AB12-CD34-EF5!']) {
      expect(normalizeInviteCode(bad)).toBeNull();
    }
  });
});

describe('InviteRepository', () => {
  let db: Db;
  let clock: ReturnType<typeof fakeClock>;
  let invites: InviteRepository;
  let userId: number;

  beforeEach(() => {
    db = openDatabase(':memory:', silentLogger);
    clock = fakeClock();
    invites = new InviteRepository(db, clock.now);
    userId = new UserRepository(db).create('alice', 'hash').id;
  });

  it('stores only a hash and a hint, never the code', () => {
    const { code, invite } = invites.create(DAY, '  for Alice  ');
    expect(invite).toMatchObject({
      hint: code.slice(0, 4),
      note: 'for Alice',
      status: 'unused',
      usedBy: null,
    });
    const stored = JSON.stringify(db.prepare('SELECT * FROM invite_codes').all());
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(code.replace(/-/gu, ''));
  });

  it('is single-use', () => {
    const { code } = invites.create(DAY);
    expect(invites.isRedeemable(code)).toBe(true);
    expect(invites.consume(code, userId, 'alice')).toBe('ok');
    expect(invites.isRedeemable(code)).toBe(false);
    expect(invites.consume(code, userId, 'alice')).toBe('invalid');
    expect(invites.list()[0]).toMatchObject({
      status: 'used',
      usedBy: 'alice',
      usedAt: clock.now(),
    });
  });

  it('expires', () => {
    const { code } = invites.create(DAY);
    clock.advance(DAY);
    expect(invites.isRedeemable(code)).toBe(false);
    expect(invites.consume(code, userId, 'alice')).toBe('invalid');
    expect(invites.list()[0]?.status).toBe('expired');
  });

  it('revokes only unused codes', () => {
    const unused = invites.create(DAY);
    const used = invites.create(DAY);
    invites.consume(used.code, userId, 'alice');
    expect(invites.revoke(used.invite.id)).toBe(false);
    expect(invites.revoke(unused.invite.id)).toBe(true);
    expect(invites.revoke(unused.invite.id)).toBe(false);
    expect(invites.revoke(9999)).toBe(false);
    expect(invites.isRedeemable(unused.code)).toBe(false);
    expect(invites.get(unused.invite.id)?.status).toBe('revoked');
  });

  it('lists newest first and keeps the username if the account is deleted', () => {
    const first = invites.create(DAY);
    clock.advance(1000);
    invites.create(DAY);
    invites.consume(first.code, userId, 'alice');
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    const [newest, oldest] = invites.list();
    expect(newest?.id).toBeGreaterThan(oldest?.id ?? 0);
    expect(oldest).toMatchObject({ status: 'used', usedBy: 'alice' });
  });
});
