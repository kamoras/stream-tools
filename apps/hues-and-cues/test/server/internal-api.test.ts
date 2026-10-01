import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdminOverviewResponse, CreateInviteResponse } from '../../src/shared/protocol.js';
import { InviteRepository } from '../../src/server/auth/invite-codes.js';
import { UserRepository } from '../../src/server/auth/user-repository.js';
import { type Db, openDatabase } from '../../src/server/db/database.js';
import { buildInternalApi } from '../../src/server/http/internal-api.js';
import { silentLogger } from '../helpers.js';

const TOKEN = 'internal-token-'.padEnd(40, 'x');
const DAY = 24 * 60 * 60 * 1000;

describe('internal admin API', () => {
  let db: Db;
  let invites: InviteRepository;
  let users: UserRepository;
  let api: FastifyInstance;

  beforeEach(() => {
    db = openDatabase(':memory:', silentLogger);
    invites = new InviteRepository(db);
    users = new UserRepository(db);
    api = buildInternalApi({
      token: TOKEN,
      invites,
      users,
      inviteTtlMs: 14 * DAY,
      logger: silentLogger,
    });
  });

  afterEach(async () => {
    await api.close();
    db.close();
  });

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, token = TOKEN) =>
    api.inject({
      method,
      url,
      headers: token === '' ? {} : { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });

  it('requires the bearer token', async () => {
    expect((await call('GET', '/overview', undefined, '')).statusCode).toBe(401);
    expect((await call('GET', '/overview', undefined, 'wrong')).statusCode).toBe(401);
    expect((await call('POST', '/invites', {}, 'wrong')).statusCode).toBe(401);
    expect(invites.list()).toEqual([]);
  });

  it('generates codes, then reports who used them and every account', async () => {
    const created = await call('POST', '/invites', { note: 'for Sam' });
    expect(created.statusCode).toBe(201);
    const { code, invite } = created.json<CreateInviteResponse>();
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/u);
    expect(invite).toMatchObject({ note: 'for Sam', status: 'unused', hint: code.slice(0, 4) });

    const sam = users.create('sam', 'hash');
    invites.consume(code, sam.id, 'sam');
    db.prepare(
      "INSERT INTO rooms (id, owner_id, channel, created_at, last_active_at, game) VALUES ('r1', ?, 'sams_channel', 0, 0, '{}')",
    ).run(sam.id);

    const overview = (await call('GET', '/overview')).json<AdminOverviewResponse>();
    expect(overview.inviteTtlDays).toBe(14);
    expect(overview.invites).toEqual([expect.objectContaining({ status: 'used', usedBy: 'sam' })]);
    expect(overview.users).toEqual([
      expect.objectContaining({ username: 'sam', channels: ['sams_channel'] }),
    ]);
    // The full code is never returned again.
    expect(JSON.stringify(overview)).not.toContain(code);
  });

  it('revokes unused codes only', async () => {
    const { invite } = (await call('POST', '/invites', {})).json<CreateInviteResponse>();
    expect((await call('DELETE', `/invites/${String(invite.id)}`)).statusCode).toBe(204);
    expect((await call('DELETE', `/invites/${String(invite.id)}`)).statusCode).toBe(404);
    expect((await call('DELETE', '/invites/abc')).statusCode).toBe(404);
  });

  it('validates the note', async () => {
    expect((await call('POST', '/invites', { note: 'x'.repeat(101) })).statusCode).toBe(400);
  });
});
