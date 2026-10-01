import type { FastifyInstance } from 'fastify';
import { createRoomRequestSchema, type RoomSummary } from '../../shared/protocol.js';
import { RoomLimitError, type RoomRegistry } from '../rooms/room-registry.js';
import { currentUser, requireUser, sendError } from './request-context.js';
import { parseBody } from './validation.js';

export interface RoomRoutesOptions {
  readonly registry: RoomRegistry;
  readonly allowedChannels: readonly string[] | undefined;
}

export function registerRoomRoutes(app: FastifyInstance, options: RoomRoutesOptions): void {
  const { registry, allowedChannels } = options;

  app.get('/api/rooms', { preHandler: requireUser }, (request) => ({
    rooms: registry.summaries(currentUser(request).id),
  }));

  app.post(
    '/api/rooms',
    { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parseBody(createRoomRequestSchema, request.body, reply);
      if (!body) return reply;
      if (allowedChannels && !allowedChannels.includes(body.channel)) {
        return sendError(reply, 403, 'forbidden', 'This server is not set up for that channel.');
      }
      try {
        const { room, created } = registry.getOrCreate(currentUser(request).id, body.channel);
        const summary: RoomSummary = {
          roomId: room.id,
          channel: room.channel,
          createdAt: room.createdAt,
          lastActiveAt: room.lastActiveAt,
        };
        return await reply.status(created ? 201 : 200).send({ room: summary });
      } catch (error) {
        if (error instanceof RoomLimitError) {
          return sendError(reply, 409, 'conflict', error.message);
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: { roomId: string } }>(
    '/api/rooms/:roomId',
    { preHandler: requireUser },
    async (request, reply) => {
      if (!registry.delete(request.params.roomId, currentUser(request).id)) {
        return sendError(reply, 404, 'not_found', 'Game not found.');
      }
      return reply.status(204).send();
    },
  );
}
