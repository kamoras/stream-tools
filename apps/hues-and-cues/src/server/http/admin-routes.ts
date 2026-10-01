import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  type AdminOverviewResponse,
  adminLoginRequestSchema,
  type CreateInviteResponse,
  createInviteRequestSchema,
} from '../../shared/protocol.js';
import { AdminLoginError, type AdminAuth } from '../admin/admin-auth.js';
import type { InviteRepository } from '../auth/invite-codes.js';
import type { UserRepository } from '../auth/user-repository.js';
import { sendError } from './request-context.js';
import { parseBody } from './validation.js';

export interface AdminRoutesOptions {
  readonly adminAuth: AdminAuth;
  readonly path: string;
  readonly invites: InviteRepository;
  readonly users: UserRepository;
  readonly inviteTtlMs: number;
  readonly cookieSecure: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function adminCookieName(secure: boolean): string {
  return secure ? '__Host-hc_admin' : 'hc_admin';
}

/**
 * The admin area, like the dbd-bot's: everything lives under the secret
 * `/admin/<ADMIN_PATH>` prefix, so any other `/admin/*` URL is a plain 404 and
 * the page's existence isn't advertised. Only registered when configured.
 */
export function registerAdminRoutes(app: FastifyInstance, options: AdminRoutesOptions): void {
  const { adminAuth, invites, users, inviteTtlMs, cookieSecure } = options;
  const base = `/admin/${options.path}`;
  const cookieName = adminCookieName(cookieSecure);
  const cookieOptions = {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'strict',
    path: '/',
  } as const;

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!adminAuth.isValid(request.cookies[cookieName])) {
      await sendError(reply, 401, 'unauthorized', 'Please sign in as admin.');
    }
  };

  app.get(base, (_request, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Robots-Tag', 'noindex')
      .sendFile('admin.html'),
  );

  app.post(
    `${base}/api/login`,
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parseBody(adminLoginRequestSchema, request.body, reply);
      if (!body) return reply;
      try {
        const token = adminAuth.login(body.password);
        void reply.setCookie(cookieName, token, {
          ...cookieOptions,
          maxAge: Math.floor(adminAuth.sessionTtlMs / 1000),
        });
        return await reply.status(204).send();
      } catch (error) {
        if (!(error instanceof AdminLoginError)) throw error;
        if (error.retryAfterSeconds !== undefined) {
          void reply.header('Retry-After', String(error.retryAfterSeconds));
          return sendError(reply, 429, 'rate_limited', error.message);
        }
        return sendError(reply, 401, 'unauthorized', error.message);
      }
    },
  );

  app.post(`${base}/api/logout`, async (request, reply) => {
    adminAuth.logout(request.cookies[cookieName]);
    void reply.clearCookie(cookieName, cookieOptions);
    return reply.status(204).send();
  });

  app.get(`${base}/api/overview`, { preHandler: requireAdmin }, (): AdminOverviewResponse => ({
    invites: invites.list(),
    users: users.listForAdmin(),
    inviteTtlDays: Math.round(inviteTtlMs / DAY_MS),
  }));

  app.post(
    `${base}/api/invites`,
    { preHandler: requireAdmin, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parseBody(createInviteRequestSchema, request.body ?? {}, reply);
      if (!body) return reply;
      const created = invites.create(inviteTtlMs, body.note);
      request.log.info({ inviteId: created.invite.id }, 'Invite code generated');
      return reply
        .status(201)
        .header('Cache-Control', 'no-store')
        .send(created satisfies CreateInviteResponse);
    },
  );

  app.delete<{ Params: { id: string } }>(
    `${base}/api/invites/:id`,
    { preHandler: requireAdmin },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isSafeInteger(id) || !invites.revoke(id)) {
        return sendError(reply, 404, 'not_found', 'No unused invite with that id.');
      }
      request.log.info({ inviteId: id }, 'Invite code revoked');
      return reply.status(204).send();
    },
  );
}
