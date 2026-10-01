import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import type {
  BotChannel,
  BotInvite,
  BotOverview,
  BotStatus,
  HuesCreatedInvite,
  HuesOverview,
} from '../../shared/api.js';
import type { AdminConfig } from '../config.js';
import { LoginError, type AdminSessions } from '../sessions.js';
import { type UpstreamClient, UpstreamError } from '../upstream.js';

export interface AdminAppDependencies {
  readonly config: Pick<
    AdminConfig,
    'path' | 'publicUrl' | 'cookieSecure' | 'trustProxy' | 'publicDir' | 'env'
  >;
  readonly sessions: AdminSessions;
  readonly bot: UpstreamClient;
  readonly hues: UpstreamClient;
  readonly logger: Logger;
  readonly now?: () => number;
}

const TWITCH_AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
const TWITCH_STATE_TTL_MS = 10 * 60 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CHANNEL = /^[a-z0-9_]{3,25}$/u;
const PASS_THROUGH_STATUSES = new Set([400, 404, 409]);

const loginSchema = z.object({ password: z.string().min(1).max(1024) });
const noteSchema = z.object({ note: z.string().trim().max(100).optional() });

export function cookieName(secure: boolean): string {
  // __Host- requires Secure, path=/ and no Domain, blocking cookie injection.
  return secure ? '__Host-st_admin' : 'st_admin';
}

/**
 * The stream-tools admin dashboard: one login for every app.
 *
 * Everything — the page, its assets and its API — lives under the secret
 * `/admin/<ADMIN_PATH>/` prefix; any other path is a plain 404, as with the
 * original bot dashboard. App data is fetched server-side from each app's
 * internal admin API, which only this service can reach.
 */
export async function buildAdminApp(deps: AdminAppDependencies): Promise<FastifyInstance> {
  const { config, sessions, bot, hues } = deps;
  const now = deps.now ?? Date.now;
  const base = `/admin/${config.path}`;
  const cookie = cookieName(config.cookieSecure);
  const twitchCallbackUrl = `${config.publicUrl}${base}/twitch-callback`;
  const pendingTwitchStates = new Map<string, number>();

  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({ loggerInstance, trustProxy: config.trustProxy, bodyLimit: 8 * 1024 });

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // The Twitch connect form posts here, then redirects to Twitch.
        formAction: ["'self'", 'https://id.twitch.tv'],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    // Not `no-referrer`: under it browsers send `Origin: null` on same-origin
    // form posts, which the CSRF check rightly rejects. `same-origin` still
    // keeps the Referer (and the secret path in it) from other sites.
    referrerPolicy: { policy: 'same-origin' },
  });
  // The Twitch connect form posts an empty urlencoded body; nothing reads it.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 1024 },
    (_request, _body, done) => {
      done(null, {});
    },
  );
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).type('text/plain').send('Not found'),
  );
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof UpstreamError) {
      // Pass through only "your request was wrong" answers. Anything else —
      // notably an app's 401 from a mismatched internal token — is the
      // dashboard's problem, and must not look like an expired admin session.
      const status = PASS_THROUGH_STATUSES.has(error.status) ? error.status : 502;
      return reply.status(status).send({ error: error.message });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) request.log.error({ err: error }, 'Unhandled error');
    return reply
      .status(statusCode)
      .send({ error: statusCode >= 500 ? 'Internal server error' : (error as Error).message });
  });

  // CSRF: state-changing requests must come from this origin.
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return undefined;
    const origin = request.headers.origin;
    let sameOrigin = false;
    if (typeof origin === 'string') {
      try {
        sameOrigin = new URL(origin).host === request.host;
      } catch {
        sameOrigin = false;
      }
    }
    if (!sameOrigin) return reply.status(403).send({ error: 'Cross-site request blocked.' });
    return undefined;
  });

  const signedIn = (request: FastifyRequest): boolean => sessions.isValid(request.cookies[cookie]);
  const requireSession = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!signedIn(request)) await reply.status(401).send({ error: 'Please sign in.' });
  };

  // Internal health check for Docker (Caddy only forwards /admin/*).
  app.get('/healthz', { logLevel: 'warn' }, () => ({ status: 'ok' }));

  // --- Page ------------------------------------------------------------------

  if (existsSync(config.publicDir)) {
    await app.register(fastifyStatic, {
      root: config.publicDir,
      prefix: `${base}/`,
      index: false,
      wildcard: false,
      // The page is served only at `${base}/`; a second URL for it would
      // break its relative API paths.
      allowedPath: (pathName) => pathName !== '/index.html',
      decorateReply: true,
      setHeaders: (response, filePath) => {
        response.header(
          'Cache-Control',
          filePath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
        );
      },
    });
    app.get(base, (_request, reply) => reply.redirect(`${base}/`));
    app.get(`${base}/`, (_request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .header('X-Robots-Tag', 'noindex')
        .sendFile('index.html'),
    );
  } else {
    deps.logger.warn(
      { publicDir: config.publicDir },
      'Dashboard build not found; run `npm run build`.',
    );
  }

  // --- Session -----------------------------------------------------------------

  app.get(`${base}/api/session`, (request) => ({ signedIn: signedIn(request) }));

  app.post(
    `${base}/api/login`,
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = loginSchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send({ error: 'Password is required.' });
      try {
        const token = sessions.login(body.data.password, request.ip);
        void reply.setCookie(cookie, token, {
          httpOnly: true,
          secure: config.cookieSecure,
          // Lax, not Strict: the Twitch OAuth callback is a cross-site
          // navigation and must still carry the session. POSTs are guarded by
          // the Origin check above.
          sameSite: 'lax',
          path: '/',
          maxAge: Math.floor(sessions.sessionTtlMs / 1000),
        });
        request.log.info('Admin signed in');
        return await reply.status(204).send();
      } catch (error) {
        if (!(error instanceof LoginError)) throw error;
        request.log.warn('Failed admin sign-in');
        if (error.retryAfterSeconds !== undefined) {
          void reply.header('Retry-After', String(error.retryAfterSeconds));
          return reply.status(429).send({ error: error.message });
        }
        return reply.status(401).send({ error: error.message });
      }
    },
  );

  app.post(`${base}/api/logout`, async (request, reply) => {
    sessions.logout(request.cookies[cookie]);
    void reply.clearCookie(cookie, {
      path: '/',
      secure: config.cookieSecure,
      httpOnly: true,
      sameSite: 'lax',
    });
    return reply.status(204).send();
  });

  // --- dbd-bot ------------------------------------------------------------------

  app.get(`${base}/api/dbd-bot`, { preHandler: requireSession }, async (): Promise<BotOverview> => {
    const [status, channels, invites] = await Promise.all([
      bot.request<BotStatus>('GET', '/status'),
      bot.request<{ channels: BotChannel[] }>('GET', '/channels'),
      bot.request<{ invites: BotInvite[] }>('GET', '/invites'),
    ]);
    return { status, channels: channels.channels, invites: invites.invites };
  });

  app.post(`${base}/api/dbd-bot/invites`, { preHandler: requireSession }, async (_request, reply) =>
    reply
      .status(201)
      .header('Cache-Control', 'no-store')
      .send(await bot.request<{ code: string }>('POST', '/invites')),
  );

  app.delete<{ Params: { id: string } }>(
    `${base}/api/dbd-bot/invites/:id`,
    { preHandler: requireSession },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isSafeInteger(id)) return reply.status(400).send({ error: 'Invalid id.' });
      await bot.request('DELETE', `/invites/${String(id)}`);
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { channel: string; action: string } }>(
    `${base}/api/dbd-bot/channels/:channel/:action`,
    { preHandler: requireSession },
    async (request, reply) => {
      const { channel, action } = request.params;
      if (!CHANNEL.test(channel) || !['join', 'leave', 'disconnect'].includes(action)) {
        return reply.status(400).send({ error: 'Invalid channel or action.' });
      }
      await bot.request('POST', `/channels/${channel}/${action}`);
      request.log.info({ channel, action }, 'Bot channel action');
      return reply.status(204).send();
    },
  );

  // Twitch chat login for the bot. The callback URL is the same as the bot's
  // old dashboard, so the redirect URL registered in the Twitch developer
  // console still works. Starting the flow is a POST, so the Origin check
  // above stops other sites from triggering it.
  app.post(`${base}/twitch-connect`, async (request, reply) => {
    if (!signedIn(request)) return reply.redirect(`${base}/`, 303);
    let status: BotStatus;
    try {
      status = await bot.request<BotStatus>('GET', '/status');
    } catch (statusError) {
      request.log.warn({ err: statusError }, 'Bot unavailable for Twitch connect');
      return reply.redirect(`${base}/?twitch=unavailable`, 303);
    }
    // Defensive: tolerate a malformed status payload rather than throwing.
    const twitch = (status as Partial<BotStatus>).twitch;
    if (!twitch?.configured || typeof twitch.clientId !== 'string') {
      return reply.redirect(`${base}/?twitch=not-configured`, 303);
    }
    const state = randomBytes(16).toString('hex');
    for (const [key, expiresAt] of pendingTwitchStates) {
      if (expiresAt <= now()) pendingTwitchStates.delete(key);
    }
    pendingTwitchStates.set(state, now() + TWITCH_STATE_TTL_MS);
    const params = new URLSearchParams({
      client_id: twitch.clientId,
      redirect_uri: twitchCallbackUrl,
      response_type: 'code',
      scope: 'chat:read chat:edit',
      state,
      // Always show Twitch's consent screen, so the admin sees (and can
      // switch) which account is being connected.
      force_verify: 'true',
    });
    return reply.redirect(`${TWITCH_AUTHORIZE_URL}?${params.toString()}`, 303);
  });

  app.get<{ Querystring: Record<string, string | undefined> }>(
    `${base}/twitch-callback`,
    async (request, reply) => {
      if (!signedIn(request)) return reply.redirect(`${base}/`);
      const { code, state, error } = request.query;
      const expiresAt = state === undefined ? undefined : pendingTwitchStates.get(state);
      if (state !== undefined) pendingTwitchStates.delete(state);
      if (error !== undefined) return reply.redirect(`${base}/?twitch=declined`);
      if (expiresAt === undefined || expiresAt <= now() || code === undefined || code === '') {
        return reply.redirect(`${base}/?twitch=expired`);
      }
      try {
        await bot.request('POST', '/twitch/exchange', { code, redirectUri: twitchCallbackUrl });
      } catch (exchangeError) {
        request.log.error({ err: exchangeError }, 'Twitch code exchange failed');
        const wrongAccount = exchangeError instanceof UpstreamError && exchangeError.status === 409;
        return reply.redirect(`${base}/?twitch=${wrongAccount ? 'wrong-account' : 'failed'}`);
      }
      request.log.info('Bot Twitch chat login connected');
      return reply.redirect(`${base}/?twitch=connected`);
    },
  );

  // --- hues-and-cues ----------------------------------------------------------------

  app.get(`${base}/api/hues-and-cues`, { preHandler: requireSession }, () =>
    hues.request<HuesOverview>('GET', '/overview'),
  );

  app.post(
    `${base}/api/hues-and-cues/invites`,
    { preHandler: requireSession },
    async (request, reply) => {
      const body = noteSchema.safeParse(request.body ?? {});
      if (!body.success)
        return reply.status(400).send({ error: 'Notes are at most 100 characters.' });
      const created = await hues.request<HuesCreatedInvite>(
        'POST',
        '/invites',
        body.data.note === undefined || body.data.note === '' ? {} : { note: body.data.note },
      );
      return reply.status(201).header('Cache-Control', 'no-store').send(created);
    },
  );

  app.delete<{ Params: { id: string } }>(
    `${base}/api/hues-and-cues/invites/:id`,
    { preHandler: requireSession },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isSafeInteger(id)) return reply.status(400).send({ error: 'Invalid id.' });
      await hues.request('DELETE', `/invites/${String(id)}`);
      return reply.status(204).send();
    },
  );

  return app;
}
