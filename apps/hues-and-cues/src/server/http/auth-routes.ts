import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  type AuthUser,
  changePasswordRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
} from '../../shared/protocol.js';
import { AuthError, type AuthErrorCode, type AuthService } from '../auth/auth-service.js';
import type { User } from '../auth/user-repository.js';
import {
  clearSessionCookie,
  type CookieSettings,
  currentUser,
  requireUser,
  sendError,
  setSessionCookie,
} from './request-context.js';
import { parseBody } from './validation.js';

const AUTH_ERROR_STATUS: Readonly<Record<AuthErrorCode, number>> = {
  invalid_credentials: 401,
  wrong_password: 403,
  invalid_invite: 403,
  username_taken: 409,
  throttled: 429,
};

function toAuthUser(user: User): AuthUser {
  return { id: user.id, username: user.username };
}

function sendAuthError(reply: FastifyReply, error: AuthError): FastifyReply {
  const status = AUTH_ERROR_STATUS[error.code];
  if (error.retryAfterSeconds !== undefined) {
    void reply.header('Retry-After', String(error.retryAfterSeconds));
  }
  const code =
    status === 401
      ? 'unauthorized'
      : status === 403
        ? 'forbidden'
        : status === 409
          ? 'conflict'
          : 'rate_limited';
  return sendError(reply, status, code, error.message);
}

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  cookies: CookieSettings,
): void {
  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const body = parseBody(registerRequestSchema, request.body, reply);
      if (!body) return reply;
      try {
        const { user, sessionToken } = await auth.register(
          body.username,
          body.password,
          body.inviteCode,
        );
        setSessionCookie(reply, sessionToken, cookies);
        return await reply.status(201).send({ user: toAuthUser(user) });
      } catch (error) {
        if (error instanceof AuthError) return sendAuthError(reply, error);
        throw error;
      }
    },
  );

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parseBody(loginRequestSchema, request.body, reply);
      if (!body) return reply;
      try {
        const { user, sessionToken } = await auth.login(body.username, body.password, request.ip);
        // Replace any existing session rather than accumulating them.
        auth.logout(request.sessionToken ?? undefined);
        setSessionCookie(reply, sessionToken, cookies);
        return { user: toAuthUser(user) };
      } catch (error) {
        if (error instanceof AuthError) return sendAuthError(reply, error);
        throw error;
      }
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    auth.logout(request.sessionToken ?? undefined);
    clearSessionCookie(reply, cookies);
    return reply.status(204).send();
  });

  app.get('/api/auth/me', { preHandler: requireUser }, (request) => ({
    user: toAuthUser(currentUser(request)),
  }));

  app.post(
    '/api/auth/password',
    { preHandler: requireUser, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parseBody(changePasswordRequestSchema, request.body, reply);
      if (!body) return reply;
      try {
        await auth.changePassword(
          currentUser(request).id,
          body.currentPassword,
          body.newPassword,
          request.sessionToken ?? '',
        );
        return await reply.status(204).send();
      } catch (error) {
        if (error instanceof AuthError) return sendAuthError(reply, error);
        throw error;
      }
    },
  );
}
