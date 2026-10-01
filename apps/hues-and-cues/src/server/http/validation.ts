import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { sendError } from './request-context.js';

/**
 * Validates a request body. On failure sends a 400 naming the first problem
 * and returns `undefined`; the handler should then return the reply.
 */
export function parseBody<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
  reply: FastifyReply,
): z.output<Schema> | undefined {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  void sendError(reply, 400, 'bad_request', result.error.issues[0]?.message ?? 'Invalid request.');
  return undefined;
}
