import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type {
  AdminOverviewResponse,
  CreateInviteResponse,
  HostGameState,
  RoomSummary,
  ServerMessage,
} from '../../src/shared/protocol.js';
import { AdminAuth } from '../../src/server/admin/admin-auth.js';
import { AuthService } from '../../src/server/auth/auth-service.js';
import { InviteRepository } from '../../src/server/auth/invite-codes.js';
import { SessionRepository } from '../../src/server/auth/session-repository.js';
import { UserRepository } from '../../src/server/auth/user-repository.js';
import { type Db, openDatabase } from '../../src/server/db/database.js';
import { buildApp } from '../../src/server/http/app.js';
import { RoomRegistry } from '../../src/server/rooms/room-registry.js';
import { RoomStore } from '../../src/server/rooms/room-store.js';
import { FAST_SCRYPT, silentLogger } from '../helpers.js';

class FakeChat {
  public connected = true;
  public readonly refs = new Map<string, number>();
  public acquire(channel: string): void {
    this.refs.set(channel, (this.refs.get(channel) ?? 0) + 1);
  }
  public release(channel: string): void {
    this.refs.set(channel, (this.refs.get(channel) ?? 0) - 1);
  }
}

/** A WebSocket test client that buffers messages so none are missed. */
class TestClient {
  private readonly queue: ServerMessage[] = [];
  private waiters: (() => void)[] = [];
  public closeCode: number | null = null;
  private readonly closed: Promise<void>;

  private constructor(public readonly socket: WebSocket) {
    socket.on('message', (data) => {
      this.queue.push(JSON.parse((data as Buffer).toString('utf8')) as ServerMessage);
      this.notify();
    });
    this.closed = new Promise((resolve) => {
      socket.on('close', (code) => {
        this.closeCode = code;
        this.notify();
        resolve();
      });
    });
  }

  public static async connect(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<TestClient> {
    const socket = new WebSocket(url, { headers });
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return client;
  }

  public send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Resolves with the next message matching `predicate`, discarding others. */
  public async next(
    predicate: (message: ServerMessage) => boolean = () => true,
  ): Promise<ServerMessage> {
    for (;;) {
      const index = this.queue.findIndex(predicate);
      const [match] = index === -1 ? [] : this.queue.splice(index, 1);
      if (match) return match;
      if (this.closeCode !== null) throw new Error(`socket closed (${String(this.closeCode)})`);
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  public async nextState(
    predicate: (state: HostGameState) => boolean = () => true,
  ): Promise<HostGameState> {
    const message = await this.next(
      (m) => m.type === 'state' && predicate(m.state as HostGameState),
    );
    return (message as Extract<ServerMessage, { type: 'state' }>).state as HostGameState;
  }

  public async waitForClose(): Promise<number | null> {
    await this.closed;
    return this.closeCode;
  }

  public close(): void {
    this.socket.close();
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

const ADMIN = { password: 'admin password 123', path: 'secret-admin-path' };

interface SetupOptions {
  admin?: boolean;
  allowedChannels?: string[];
  maxRoomsPerUser?: number;
}

describe('HTTP + WebSocket API', () => {
  let app: FastifyInstance;
  let db: Db;
  let registry: RoomRegistry;
  let invites: InviteRepository;
  let chat: FakeChat;
  let origin: string;
  let wsUrl: string;
  const clients: TestClient[] = [];

  const setup = async (options: SetupOptions = {}) => {
    db = openDatabase(':memory:', silentLogger);
    const users = new UserRepository(db);
    invites = new InviteRepository(db);
    const auth = new AuthService({
      users,
      invites,
      sessions: new SessionRepository(db, { ttlMs: 60_000 }),
      transaction: (fn) => db.transaction(fn)(),
      logger: silentLogger,
      scryptParams: FAST_SCRYPT,
    });
    const adminEnabled = options.admin ?? true;
    registry = new RoomRegistry({
      logger: silentLogger,
      store: new RoomStore(db),
      retentionMs: 60_000,
      maxRooms: 100,
      maxRoomsPerUser: options.maxRoomsPerUser ?? 5,
    });
    chat = new FakeChat();
    app = await buildApp({
      config: {
        allowedChannels: options.allowedChannels,
        publicDir: '/nonexistent',
        trustProxy: false,
        env: 'test',
        cookieSecure: false,
        sessionTtlMs: 60_000,
        admin: adminEnabled ? ADMIN : undefined,
        inviteTtlMs: 24 * 60 * 60 * 1000,
      },
      auth,
      adminAuth: new AdminAuth({
        db,
        password: adminEnabled ? ADMIN.password : undefined,
        logger: silentLogger,
      }),
      invites,
      users,
      registry,
      chat,
      logger: silentLogger,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    origin = `http://127.0.0.1:${String(port)}`;
    wsUrl = `ws://127.0.0.1:${String(port)}/ws`;
  };

  /** Sends a same-origin request, optionally with a session cookie. */
  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: unknown,
    cookie?: string,
  ) =>
    app.inject({
      method,
      url,
      headers: { origin, host: new URL(origin).host, ...(cookie ? { cookie } : {}) },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  const invite = (): string => invites.create(60_000).code;

  const register = async (username = 'streamer', password = 'a good password') => {
    const response = await call('POST', '/api/auth/register', {
      username,
      password,
      inviteCode: invite(),
    });
    expect(response.statusCode).toBe(201);
    const cookie = response.cookies.find((c) => c.name === 'hc_session');
    if (!cookie) throw new Error('no session cookie');
    return `${cookie.name}=${cookie.value}`;
  };

  const createRoom = async (cookie: string, channel = 'Streamer'): Promise<RoomSummary> => {
    const response = await call('POST', '/api/rooms', { channel }, cookie);
    expect(response.statusCode).toBe(201);
    return response.json<{ room: RoomSummary }>().room;
  };

  const connect = async (hello: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const client = await TestClient.connect(wsUrl, headers);
    clients.push(client);
    client.send({ type: 'hello', ...hello });
    return client;
  };

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await app.close();
    registry.shutdown();
    db.close();
  });

  describe('accounts', () => {
    beforeEach(() => setup());

    it('registers with a secure, HttpOnly session cookie', async () => {
      const response = await call('POST', '/api/auth/register', {
        username: 'NewUser',
        password: 'a good password',
        inviteCode: invite(),
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ user: { id: 1, username: 'NewUser' } });
      const cookie = response.cookies[0];
      expect(cookie).toMatchObject({
        name: 'hc_session',
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
      });
    });

    it('validates registration input', async () => {
      const short = await call('POST', '/api/auth/register', {
        username: 'ok_name',
        password: 'short',
        inviteCode: invite(),
      });
      expect(short.statusCode).toBe(400);
      expect(short.json<{ error: string }>().error).toMatch(/at least 10/u);
      const badName = await call('POST', '/api/auth/register', {
        username: 'no spaces',
        password: 'a good password',
        inviteCode: invite(),
      });
      expect(badName.statusCode).toBe(400);
    });

    it('rejects duplicate usernames with 409', async () => {
      await register('taken');
      const response = await call('POST', '/api/auth/register', {
        username: 'TAKEN',
        password: 'another password',
        inviteCode: invite(),
      });
      expect(response.statusCode).toBe(409);
    });

    it('signs in, reports the current user and signs out', async () => {
      await register('carol', 'carols password');
      const bad = await call('POST', '/api/auth/login', { username: 'carol', password: 'nope' });
      expect(bad.statusCode).toBe(401);

      const login = await call('POST', '/api/auth/login', {
        username: 'Carol',
        password: 'carols password',
      });
      expect(login.statusCode).toBe(200);
      const session = login.cookies[0];
      const cookie = `${session?.name ?? ''}=${session?.value ?? ''}`;
      expect((await call('GET', '/api/auth/me', undefined, cookie)).json()).toEqual({
        user: { id: 1, username: 'carol' },
      });

      const logout = await call('POST', '/api/auth/logout', undefined, cookie);
      expect(logout.statusCode).toBe(204);
      expect((await call('GET', '/api/auth/me', undefined, cookie)).statusCode).toBe(401);
    });

    it('changes the password', async () => {
      const cookie = await register('dana', 'first password');
      const wrong = await call(
        'POST',
        '/api/auth/password',
        { currentPassword: 'nope', newPassword: 'second password' },
        cookie,
      );
      expect(wrong.statusCode).toBe(401);
      const ok = await call(
        'POST',
        '/api/auth/password',
        { currentPassword: 'first password', newPassword: 'second password' },
        cookie,
      );
      expect(ok.statusCode).toBe(204);
      const login = await call('POST', '/api/auth/login', {
        username: 'dana',
        password: 'second password',
      });
      expect(login.statusCode).toBe(200);
    });

    it('blocks cross-site state-changing requests', async () => {
      const evil = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: 'https://evil.example' },
        payload: { username: 'a', password: 'b' },
      });
      expect(evil.statusCode).toBe(403);
      const missing = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'a', password: 'b' },
      });
      expect(missing.statusCode).toBe(403);
    });

    it('requires sign-in for game management', async () => {
      expect((await call('GET', '/api/rooms')).statusCode).toBe(401);
      expect((await call('POST', '/api/rooms', { channel: 'abc' })).statusCode).toBe(401);
    });

    it('sets security headers', async () => {
      const response = await call('GET', '/healthz');
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  describe('invite-only sign-up', () => {
    beforeEach(() => setup());

    it('requires a valid, unused invite code', async () => {
      const missing = await call('POST', '/api/auth/register', {
        username: 'someone',
        password: 'a good password',
      });
      expect(missing.statusCode).toBe(400);
      const wrong = await call('POST', '/api/auth/register', {
        username: 'someone',
        password: 'a good password',
        inviteCode: 'AAAA-BBBB-CCCC',
      });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json<{ error: string }>().error).toMatch(/invalid, expired or already used/u);

      const code = invite();
      const ok = await call('POST', '/api/auth/register', {
        username: 'someone',
        password: 'a good password',
        inviteCode: code,
      });
      expect(ok.statusCode).toBe(201);
      const reused = await call('POST', '/api/auth/register', {
        username: 'someone_else',
        password: 'a good password',
        inviteCode: code,
      });
      expect(reused.statusCode).toBe(403);
    });
  });

  describe('admin area', () => {
    const base = `/admin/${ADMIN.path}`;

    const adminLogin = async (): Promise<string> => {
      const response = await call('POST', `${base}/api/login`, { password: ADMIN.password });
      expect(response.statusCode).toBe(204);
      const cookie = response.cookies.find((c) => c.name === 'hc_admin');
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
      return `hc_admin=${cookie?.value ?? ''}`;
    };

    it('hides everything except the secret path', async () => {
      await setup();
      expect((await call('GET', '/admin/wrong-path/api/overview')).statusCode).toBe(404);
      expect(
        (await call('POST', '/admin/wrong-path/api/login', { password: ADMIN.password }))
          .statusCode,
      ).toBe(404);
      expect((await call('GET', `${base}/api/overview`)).statusCode).toBe(401);
    });

    it('does not exist at all when not configured', async () => {
      await setup({ admin: false });
      expect(
        (await call('POST', `${base}/api/login`, { password: ADMIN.password })).statusCode,
      ).toBe(404);
    });

    it('rejects a wrong password', async () => {
      await setup();
      const response = await call('POST', `${base}/api/login`, { password: 'not the password' });
      expect(response.statusCode).toBe(401);
    });

    it('generates single-use codes that let people sign up, and shows who used them', async () => {
      await setup();
      const admin = await adminLogin();

      const created = await call('POST', `${base}/api/invites`, { note: 'for Sam' }, admin);
      expect(created.statusCode).toBe(201);
      const { code, invite: summary } = created.json<CreateInviteResponse>();
      expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/u);
      expect(summary).toMatchObject({ note: 'for Sam', status: 'unused', hint: code.slice(0, 4) });

      const signup = await call('POST', '/api/auth/register', {
        username: 'sam',
        password: 'a good password',
        inviteCode: code,
      });
      expect(signup.statusCode).toBe(201);
      const session = signup.cookies.find((c) => c.name === 'hc_session');
      await call(
        'POST',
        '/api/rooms',
        { channel: 'sams_channel' },
        `hc_session=${session?.value ?? ''}`,
      );

      const overview = (
        await call('GET', `${base}/api/overview`, undefined, admin)
      ).json<AdminOverviewResponse>();
      expect(overview.inviteTtlDays).toBe(1);
      expect(overview.invites).toEqual([
        expect.objectContaining({ id: summary.id, status: 'used', usedBy: 'sam' }),
      ]);
      expect(overview.users).toEqual([
        expect.objectContaining({
          username: 'sam',
          channels: ['sams_channel'],
          lastLoginAt: expect.any(Number) as number,
        }),
      ]);
      // The full code is never returned again.
      expect(JSON.stringify(overview)).not.toContain(code);
    });

    it('revokes unused codes', async () => {
      await setup();
      const admin = await adminLogin();
      const { code, invite: summary } = (
        await call('POST', `${base}/api/invites`, {}, admin)
      ).json<CreateInviteResponse>();
      const revokeUrl = `${base}/api/invites/${String(summary.id)}`;
      expect((await call('DELETE', revokeUrl, undefined, admin)).statusCode).toBe(204);
      expect((await call('DELETE', revokeUrl, undefined, admin)).statusCode).toBe(404);
      const signup = await call('POST', '/api/auth/register', {
        username: 'late',
        password: 'a good password',
        inviteCode: code,
      });
      expect(signup.statusCode).toBe(403);
    });

    it('signs out', async () => {
      await setup();
      const admin = await adminLogin();
      expect((await call('POST', `${base}/api/logout`, undefined, admin)).statusCode).toBe(204);
      expect((await call('GET', `${base}/api/overview`, undefined, admin)).statusCode).toBe(401);
    });

    it('is not usable with a regular user session', async () => {
      await setup();
      const user = await register('regular');
      expect((await call('GET', `${base}/api/overview`, undefined, user)).statusCode).toBe(401);
      expect((await call('POST', `${base}/api/invites`, {}, user)).statusCode).toBe(401);
    });
  });

  describe('games', () => {
    it('creates, lists and deletes games per account', async () => {
      await setup();
      const alice = await register('alice');
      const bob = await register('bob');
      const room = await createRoom(alice, '#MyChannel');
      expect(room.channel).toBe('mychannel');

      const again = await call('POST', '/api/rooms', { channel: 'mychannel' }, alice);
      expect(again.statusCode).toBe(200);
      expect(again.json<{ room: RoomSummary }>().room.roomId).toBe(room.roomId);

      expect((await call('GET', '/api/rooms', undefined, alice)).json()).toMatchObject({
        rooms: [{ roomId: room.roomId }],
      });
      expect((await call('GET', '/api/rooms', undefined, bob)).json()).toEqual({ rooms: [] });

      expect((await call('DELETE', `/api/rooms/${room.roomId}`, undefined, bob)).statusCode).toBe(
        404,
      );
      expect((await call('DELETE', `/api/rooms/${room.roomId}`, undefined, alice)).statusCode).toBe(
        204,
      );
    });

    it('validates channels and enforces limits', async () => {
      await setup({ allowedChannels: ['allowed', 'second'], maxRoomsPerUser: 1 });
      const cookie = await register();
      expect((await call('POST', '/api/rooms', { channel: 'no spaces!' }, cookie)).statusCode).toBe(
        400,
      );
      expect((await call('POST', '/api/rooms', { channel: 'other' }, cookie)).statusCode).toBe(403);
      await createRoom(cookie, 'allowed');
      expect((await call('POST', '/api/rooms', { channel: 'second' }, cookie)).statusCode).toBe(
        409,
      );
    });
  });

  describe('WebSocket game flow', () => {
    beforeEach(() => setup());

    const hostHeaders = (cookie: string) => ({ cookie, origin });

    it('plays a full round, hiding the target from the overlay until reveal', async () => {
      const cookie = await register();
      const room = await createRoom(cookie);
      const host = await connect({ role: 'host', roomId: room.roomId }, hostHeaders(cookie));
      const overlay = await connect({ role: 'overlay', roomId: room.roomId });
      await host.next((m) => m.type === 'welcome');
      await overlay.next((m) => m.type === 'welcome');
      expect(chat.refs.get('streamer')).toBe(2);

      host.send({ type: 'updateSettings', settings: { useSecondClue: false } });
      host.send({ type: 'drawCard' });
      const picking = await host.nextState((s) => s.phase === 'picking');
      expect(picking.card).toHaveLength(4);

      host.send({ type: 'selectTarget', index: 2 });
      const selected = await host.nextState((s) => s.target !== null);
      const target = selected.target;
      if (!target) throw new Error('target missing');

      host.send({ type: 'giveClue', clue: 'ocean' });
      const overlayGuessing = await overlay.nextState((s) => s.phase === 'guessing');
      expect(overlayGuessing.clues).toEqual(['ocean']);
      expect(overlayGuessing).not.toHaveProperty('target');
      expect(overlayGuessing).not.toHaveProperty('card');

      registry.routeChat({
        channel: 'streamer',
        userId: '1',
        login: 'viewer',
        displayName: 'Viewer',
        color: null,
        text: `${'ABCDEFGHIJKLMNOP'.charAt(target.row)}${String(target.col + 1)}`,
      });
      await overlay.nextState((s) => s.totalGuesses === 1);

      host.send({ type: 'closeGuessing' });
      const revealed = await overlay.nextState((s) => s.phase === 'reveal');
      expect(revealed.lastResult?.target).toEqual(target);
      expect(revealed.leaderboard).toEqual([
        { userId: '1', displayName: 'Viewer', color: null, score: 3 },
      ]);
    });

    it('reports invalid commands without dropping the connection', async () => {
      const cookie = await register();
      const room = await createRoom(cookie);
      const host = await connect({ role: 'host', roomId: room.roomId }, hostHeaders(cookie));
      await host.next((m) => m.type === 'welcome');
      host.send({ type: 'closeGuessing' });
      expect(await host.next((m) => m.type === 'error')).toMatchObject({ code: 'invalid_state' });
      host.send({ type: 'explode' });
      expect(await host.next((m) => m.type === 'error')).toMatchObject({ code: 'bad_request' });
      host.send({ type: 'drawCard' });
      await host.nextState((s) => s.phase === 'picking');
    });

    it('requires a signed-in host', async () => {
      const cookie = await register();
      const room = await createRoom(cookie);
      const anonymous = await connect({ role: 'host', roomId: room.roomId }, { origin });
      expect(await anonymous.waitForClose()).toBe(4401);
    });

    it('rejects hosts connecting from another site', async () => {
      const cookie = await register();
      const room = await createRoom(cookie);
      const hijack = await connect(
        { role: 'host', roomId: room.roomId },
        { cookie, origin: 'https://evil.example' },
      );
      expect(await hijack.waitForClose()).toBe(4401);
    });

    it('rejects hosts who do not own the game', async () => {
      const owner = await register('owner');
      const other = await register('other');
      const room = await createRoom(owner);
      const intruder = await connect({ role: 'host', roomId: room.roomId }, hostHeaders(other));
      expect(await intruder.waitForClose()).toBe(4403);
    });

    it('rejects unknown rooms and malformed hellos', async () => {
      const overlay = await connect({ role: 'overlay', roomId: 'missing-room' });
      expect(await overlay.waitForClose()).toBe(4404);
      const bad = await connect({ role: 'admin' });
      expect(await bad.waitForClose()).toBe(4400);
    });

    it('keeps overlays read-only', async () => {
      const cookie = await register();
      const room = await createRoom(cookie);
      const overlay = await connect({ role: 'overlay', roomId: room.roomId });
      await overlay.next((m) => m.type === 'welcome');
      overlay.send({ type: 'drawCard' });
      expect(await overlay.next((m) => m.type === 'error')).toMatchObject({ code: 'unauthorized' });
    });

    it('releases the chat channel when clients disconnect', async () => {
      const cookie = await register();
      const room = await createRoom(cookie);
      const overlay = await connect({ role: 'overlay', roomId: room.roomId });
      await overlay.next((m) => m.type === 'welcome');
      overlay.close();
      await overlay.waitForClose();
      await expect.poll(() => chat.refs.get('streamer')).toBe(0);
    });
  });
});
