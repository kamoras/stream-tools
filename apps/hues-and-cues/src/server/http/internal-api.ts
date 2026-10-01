import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import {
  type AdminOverviewResponse,
  type CreateInviteResponse,
  createInviteRequestSchema,
} from '../../shared/protocol.js';
import type { InviteRepository } from '../auth/invite-codes.js';
import type { UserRepository } from '../auth/user-repository.js';
import { sendError } from './request-context.js';
import { parseBody } from './validation.js';

export interface InternalApiOptions {
  readonly token: string;
  readonly invites: InviteRepository;
  readonly users: UserRepository;
  readonly inviteTtlMs: number;
  readonly logger: Logger;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Internal admin API for the shared stream-tools dashboard (apps/admin).
 *
 * It runs as a separate server on its own port, which the reverse proxy
 * never exposes, so it is reachable only on the private Docker network.
 * Every request must also present the shared INTERNAL_API_TOKEN.
 */
export function buildInternalApi(options: InternalApiOptions): FastifyInstance {
  const { invites, users, inviteTtlMs } = options;
  const expected = digest(options.token);
  const loggerInstance: FastifyBaseLogger = options.logger.child({ component: 'internal-api' });
  const app = Fastify({ loggerInstance, bodyLimit: 4 * 1024 });

  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (presented === '' || !timingSafeEqual(digest(presented), expected)) {
      return sendError(reply, 401, 'unauthorized', 'Unauthorized');
    }
    return undefined;
  });

  // Polled by the dashboard; keep it out of the request log.
  app.get('/overview', { logLevel: 'warn' }, (): AdminOverviewResponse => ({
    invites: invites.list(),
    users: users.listForAdmin(),
    inviteTtlDays: Math.round(inviteTtlMs / DAY_MS),
  }));

  app.post('/invites', async (request, reply) => {
    const body = parseBody(createInviteRequestSchema, request.body ?? {}, reply);
    if (!body) return reply;
    const created = invites.create(inviteTtlMs, body.note);
    request.log.info({ inviteId: created.invite.id }, 'Invite code generated');
    return reply.status(201).send(created satisfies CreateInviteResponse);
  });

  app.delete<{ Params: { id: string } }>('/invites/:id', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || !invites.revoke(id)) {
      return sendError(reply, 404, 'not_found', 'No unused invite with that id.');
    }
    request.log.info({ inviteId: id }, 'Invite code revoked');
    return reply.status(204).send();
  });

  return app;
}
