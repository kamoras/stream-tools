import { existsSync } from 'node:fs';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { AdminAuth } from '../admin/admin-auth.js';
import type { AuthService } from '../auth/auth-service.js';
import type { InviteRepository } from '../auth/invite-codes.js';
import type { UserRepository } from '../auth/user-repository.js';
import type { AppConfig } from '../config.js';
import type { RoomRegistry } from '../rooms/room-registry.js';
import type { TwitchChatClient } from '../twitch/chat-client.js';
import { registerAdminRoutes } from './admin-routes.js';
import { registerAuthRoutes } from './auth-routes.js';
import {
  type CookieSettings,
  isSameOrigin,
  sendError,
  sessionCookieName,
} from './request-context.js';
import { registerRoomRoutes } from './room-routes.js';
import { MAX_WS_PAYLOAD_BYTES, registerWsGateway } from './ws-gateway.js';

export interface AppDependencies {
  readonly config: Pick<
    AppConfig,
    | 'allowedChannels'
    | 'publicDir'
    | 'trustProxy'
    | 'env'
    | 'cookieSecure'
    | 'sessionTtlMs'
    | 'admin'
    | 'inviteTtlMs'
  >;
  readonly auth: AuthService;
  readonly adminAuth: AdminAuth;
  readonly invites: InviteRepository;
  readonly users: UserRepository;
  readonly registry: RoomRegistry;
  readonly chat: Pick<TwitchChatClient, 'acquire' | 'release' | 'connected'>;
  readonly logger: Logger;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { config, auth, registry, chat } = deps;
  const cookies: CookieSettings = { secure: config.cookieSecure, ttlMs: config.sessionTtlMs };
  const cookieName = sessionCookieName(cookies.secure);

  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({ loggerInstance, trustProxy: config.trustProxy, bodyLimit: 8 * 1024 });

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        imgSrc: ["'self'", 'data:'],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        scriptSrc: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_WS_PAYLOAD_BYTES } });

  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);
  app.addHook('onRequest', async (request, reply) => {
    // CSRF defence: state-changing requests must come from our own pages.
    // (SameSite=Lax cookies are the first line; this covers older browsers.)
    if (!SAFE_METHODS.has(request.method) && !isSameOrigin(request)) {
      return sendError(reply, 403, 'forbidden', 'Cross-site request blocked.');
    }
    const token = request.cookies[cookieName];
    if (token) {
      request.sessionToken = token;
      request.user = auth.resolveSession(token) ?? null;
    }
    return undefined;
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled error');
      return sendError(reply, statusCode, 'internal', 'Internal server error');
    }
    if (statusCode === 429) {
      return sendError(reply, 429, 'rate_limited', 'Too many requests. Please wait a moment.');
    }
    return sendError(reply, statusCode, 'bad_request', (error as Error).message);
  });

  // Health checks run every few seconds; keep them out of the request log.
  app.get('/healthz', { logLevel: 'warn' }, () => ({
    status: 'ok',
    chatConnected: chat.connected,
    rooms: registry.size,
  }));

  registerAuthRoutes(app, auth, cookies);
  if (config.admin) {
    registerAdminRoutes(app, {
      adminAuth: deps.adminAuth,
      path: config.admin.path,
      invites: deps.invites,
      users: deps.users,
      inviteTtlMs: config.inviteTtlMs,
      cookieSecure: config.cookieSecure,
    });
  }
  registerRoomRoutes(app, { registry, allowedChannels: config.allowedChannels });
  registerWsGateway(app, { registry, chat, logger: deps.logger });

  if (existsSync(config.publicDir)) {
    await app.register(fastifyStatic, {
      root: config.publicDir,
      index: false,
      wildcard: true,
      // The admin page is only reachable through its secret path.
      allowedPath: (pathName) => pathName !== '/admin.html',
      maxAge: config.env === 'production' ? '1h' : 0,
      setHeaders: (response, filePath) => {
        if (filePath.includes('/assets/')) {
          response.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (filePath.endsWith('.html')) {
          response.header('Cache-Control', 'no-cache');
        }
      },
    });

    app.get('/', (_request, reply) =>
      reply.header('Cache-Control', 'no-cache').sendFile('index.html'),
    );
    app.get('/overlay', (_request, reply) =>
      reply.header('Cache-Control', 'no-cache').sendFile('overlay.html'),
    );
    app.get('/login', (request, reply) =>
      request.user
        ? reply.redirect('/control')
        : reply.header('Cache-Control', 'no-cache').sendFile('login.html'),
    );
    app.get('/control', (request, reply) =>
      request.user
        ? reply.header('Cache-Control', 'no-store').sendFile('control.html')
        : reply.redirect('/login?next=%2Fcontrol'),
    );
  } else {
    deps.logger.warn(
      { publicDir: config.publicDir },
      'Client build not found; run `npm run build:client` (or use `npm run dev`).',
    );
  }

  return app;
}
