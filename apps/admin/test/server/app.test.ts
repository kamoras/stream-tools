import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAdminApp } from '../../src/server/http/app.js';
import { AdminSessions } from '../../src/server/sessions.js';
import { UpstreamClient } from '../../src/server/upstream.js';
import { silentLogger } from '../helpers.js';

const TOKEN = 'internal-token'.padEnd(64, 'x');
const PASSWORD = 'the admin password';
const PATH = 'secret-admin';
const BASE = `/admin/${PATH}`;
const PUBLIC_URL = 'https://bot.example.com';
const ORIGIN = { origin: 'http://localhost', host: 'localhost' };

interface Recorded {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}

/** A stand-in for an app's internal admin API that records what it receives. */
async function fakeUpstream(
  routes: Record<string, (body: unknown) => { status?: number; body?: unknown }>,
): Promise<{ server: FastifyInstance; url: string; calls: Recorded[] }> {
  const calls: Recorded[] = [];
  const server = Fastify();
  server.all('/*', async (request, reply) => {
    calls.push({
      method: request.method,
      url: request.url,
      auth: request.headers.authorization,
      body: request.body,
    });
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const handler = routes[`${request.method} ${request.url}`];
    if (!handler) return reply.status(404).send({ error: 'no route' });
    const result = handler(request.body);
    return reply.status(result.status ?? 200).send(result.body ?? null);
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const { port } = server.server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${String(port)}`, calls };
}

const BOT_STATUS = {
  botName: 'queuebot',
  prefix: '!dbd ',
  connected: true,
  uptimeMs: 1000,
  chatSelfRefreshing: false,
  twitch: { configured: true, clientId: 'client123' },
  webhook: { enabled: false },
};

describe('admin dashboard', () => {
  let app: FastifyInstance;
  let bot: Awaited<ReturnType<typeof fakeUpstream>>;
  let hues: Awaited<ReturnType<typeof fakeUpstream>>;

  beforeEach(async () => {
    bot = await fakeUpstream({
      'GET /status': () => ({ body: BOT_STATUS }),
      'GET /channels': () => ({ body: { channels: [{ channel: 'streamer', inChat: true }] } }),
      'GET /invites': () => ({ body: { invites: [{ id: 1, code: 'ABCD-1234', createdAt: 0 }] } }),
      'POST /invites': () => ({ status: 201, body: { code: 'NEW1-CODE' } }),
      'DELETE /invites/1': () => ({ status: 204 }),
      'POST /channels/streamer/join': () => ({ status: 204 }),
      'POST /channels/streamer/disconnect': () => ({ status: 204 }),
      'POST /twitch/exchange': (body) =>
        (body as { code?: string }).code === 'bad'
          ? { status: 502, body: { error: 'rejected' } }
          : { status: 204 },
    });
    hues = await fakeUpstream({
      'GET /overview': () => ({ body: { invites: [], users: [], inviteTtlDays: 14 } }),
      'POST /invites': () => ({ status: 201, body: { code: 'AAAA-BBBB-CCCC', invite: { id: 7 } } }),
      'DELETE /invites/7': () => ({ status: 204 }),
    });
    app = await buildAdminApp({
      config: {
        path: PATH,
        publicUrl: PUBLIC_URL,
        cookieSecure: false,
        trustProxy: false,
        publicDir: '/nonexistent',
        env: 'test',
      },
      sessions: new AdminSessions({ password: PASSWORD }),
      bot: new UpstreamClient({ name: 'Dead by Daylight bot', baseUrl: bot.url, token: TOKEN }),
      hues: new UpstreamClient({ name: 'Hues & Cues', baseUrl: hues.url, token: TOKEN }),
      logger: silentLogger,
    });
  });

  afterEach(async () => {
    await app.close();
    await bot.server.close();
    await hues.server.close();
  });

  const login = async (): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/api/login`,
      headers: ORIGIN,
      payload: { password: PASSWORD },
    });
    expect(response.statusCode).toBe(204);
    const cookie = response.cookies.find((c) => c.name === 'st_admin');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    return `st_admin=${cookie?.value ?? ''}`;
  };

  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    cookie?: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url,
      headers: { ...ORIGIN, ...(cookie ? { cookie } : {}) },
      ...(payload === undefined ? {} : { payload }),
    });

  describe('login', () => {
    it('rejects a wrong password', async () => {
      const response = await call('POST', `${BASE}/api/login`, undefined, { password: 'nope' });
      expect(response.statusCode).toBe(401);
    });

    it('reports and ends the session', async () => {
      expect((await call('GET', `${BASE}/api/session`)).json()).toEqual({ signedIn: false });
      const cookie = await login();
      expect((await call('GET', `${BASE}/api/session`, cookie)).json()).toEqual({ signedIn: true });
      expect((await call('POST', `${BASE}/api/logout`, cookie)).statusCode).toBe(204);
      expect((await call('GET', `${BASE}/api/session`, cookie)).json()).toEqual({
        signedIn: false,
      });
    });

    it('blocks cross-site POSTs', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `${BASE}/api/login`,
        headers: { origin: 'https://evil.example', host: 'localhost' },
        payload: { password: PASSWORD },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('secret path', () => {
    it('404s everything outside it', async () => {
      for (const url of ['/', '/admin', '/admin/wrong/api/session', '/admin/wrong/api/login']) {
        expect((await call('GET', url)).statusCode).toBe(404);
      }
      expect(
        (await call('POST', '/admin/wrong/api/login', undefined, { password: PASSWORD }))
          .statusCode,
      ).toBe(404);
    });

    it('requires a session for app data and actions', async () => {
      for (const [method, url] of [
        ['GET', `${BASE}/api/dbd-bot`],
        ['POST', `${BASE}/api/dbd-bot/invites`],
        ['POST', `${BASE}/api/dbd-bot/channels/streamer/disconnect`],
        ['GET', `${BASE}/api/hues-and-cues`],
        ['POST', `${BASE}/api/hues-and-cues/invites`],
      ] as const) {
        expect((await call(method, url)).statusCode).toBe(401);
      }
      expect(bot.calls).toEqual([]);
      expect(hues.calls).toEqual([]);
    });
  });

  describe('dbd-bot', () => {
    it('combines status, channels and invites, authenticating with the internal token', async () => {
      const cookie = await login();
      const response = await call('GET', `${BASE}/api/dbd-bot`, cookie);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: BOT_STATUS,
        channels: [{ channel: 'streamer', inChat: true }],
        invites: [{ id: 1, code: 'ABCD-1234', createdAt: 0 }],
      });
      expect(bot.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    });

    it('generates and revokes invites and acts on channels', async () => {
      const cookie = await login();
      expect((await call('POST', `${BASE}/api/dbd-bot/invites`, cookie)).json()).toEqual({
        code: 'NEW1-CODE',
      });
      expect((await call('DELETE', `${BASE}/api/dbd-bot/invites/1`, cookie)).statusCode).toBe(204);
      expect(
        (await call('POST', `${BASE}/api/dbd-bot/channels/streamer/join`, cookie)).statusCode,
      ).toBe(204);
      expect(
        (await call('POST', `${BASE}/api/dbd-bot/channels/streamer/disconnect`, cookie)).statusCode,
      ).toBe(204);
      expect(bot.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        'POST /invites',
        'DELETE /invites/1',
        'POST /channels/streamer/join',
        'POST /channels/streamer/disconnect',
      ]);
    });

    it('validates channel actions before calling the bot', async () => {
      const cookie = await login();
      expect(
        (await call('POST', `${BASE}/api/dbd-bot/channels/streamer/delete`, cookie)).statusCode,
      ).toBe(400);
      expect(
        (await call('POST', `${BASE}/api/dbd-bot/channels/BAD!/join`, cookie)).statusCode,
      ).toBe(400);
      expect(bot.calls).toEqual([]);
    });
  });

  describe('Twitch chat login', () => {
    const connect = async (cookie: string): Promise<URL> => {
      const response = await call('GET', `${BASE}/twitch-connect`, cookie);
      expect(response.statusCode).toBe(302);
      return new URL(String(response.headers.location));
    };

    it('redirects to Twitch with the original callback URL and a state', async () => {
      const location = await connect(await login());
      expect(location.origin + location.pathname).toBe('https://id.twitch.tv/oauth2/authorize');
      expect(location.searchParams.get('client_id')).toBe('client123');
      expect(location.searchParams.get('redirect_uri')).toBe(
        `${PUBLIC_URL}${BASE}/twitch-callback`,
      );
      expect(location.searchParams.get('scope')).toBe('chat:read chat:edit');
      expect(location.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/u);
    });

    it('hands a valid code to the bot once', async () => {
      const cookie = await login();
      const state = (await connect(cookie)).searchParams.get('state') ?? '';
      const callback = await call(
        'GET',
        `${BASE}/twitch-callback?code=good&state=${state}`,
        cookie,
      );
      expect(callback.headers.location).toBe(`${BASE}/?twitch=connected`);
      expect(bot.calls.at(-1)).toMatchObject({
        method: 'POST',
        url: '/twitch/exchange',
        body: { code: 'good', redirectUri: `${PUBLIC_URL}${BASE}/twitch-callback` },
      });
      const replay = await call('GET', `${BASE}/twitch-callback?code=good&state=${state}`, cookie);
      expect(replay.headers.location).toBe(`${BASE}/?twitch=expired`);
    });

    it('rejects unknown state, declined auth and failed exchanges', async () => {
      const cookie = await login();
      expect(
        (await call('GET', `${BASE}/twitch-callback?code=x&state=forged`, cookie)).headers.location,
      ).toBe(`${BASE}/?twitch=expired`);
      const state1 = (await connect(cookie)).searchParams.get('state') ?? '';
      expect(
        (await call('GET', `${BASE}/twitch-callback?error=access_denied&state=${state1}`, cookie))
          .headers.location,
      ).toBe(`${BASE}/?twitch=declined`);
      const state2 = (await connect(cookie)).searchParams.get('state') ?? '';
      expect(
        (await call('GET', `${BASE}/twitch-callback?code=bad&state=${state2}`, cookie)).headers
          .location,
      ).toBe(`${BASE}/?twitch=failed`);
    });

    it('sends signed-out visitors back to the login page', async () => {
      const response = await call('GET', `${BASE}/twitch-connect`);
      expect(response.headers.location).toBe(`${BASE}/`);
      expect(bot.calls).toEqual([]);
    });
  });

  describe('hues-and-cues', () => {
    it('proxies overview, invite creation (with note) and revocation', async () => {
      const cookie = await login();
      expect((await call('GET', `${BASE}/api/hues-and-cues`, cookie)).json()).toEqual({
        invites: [],
        users: [],
        inviteTtlDays: 14,
      });
      const created = await call('POST', `${BASE}/api/hues-and-cues/invites`, cookie, {
        note: ' for Sam ',
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ code: 'AAAA-BBBB-CCCC' });
      expect((await call('DELETE', `${BASE}/api/hues-and-cues/invites/7`, cookie)).statusCode).toBe(
        204,
      );
      expect(hues.calls.map((c) => [c.method, c.url, c.body])).toEqual([
        ['GET', '/overview', undefined],
        ['POST', '/invites', { note: 'for Sam' }],
        ['DELETE', '/invites/7', undefined],
      ]);
    });

    it('passes app errors through and reports unreachable apps', async () => {
      const cookie = await login();
      expect(
        (await call('DELETE', `${BASE}/api/hues-and-cues/invites/99`, cookie)).statusCode,
      ).toBe(404);
      await hues.server.close();
      const response = await call('GET', `${BASE}/api/hues-and-cues`, cookie);
      expect(response.statusCode).toBe(502);
      expect(response.json<{ error: string }>().error).toMatch(/Hues & Cues is not reachable/u);
    });
  });
});
