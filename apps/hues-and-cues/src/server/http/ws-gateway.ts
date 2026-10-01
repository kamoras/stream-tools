import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type WebSocket from 'ws';
import {
  type ClientRole,
  type ErrorCode,
  helloMessageSchema,
  hostCommandSchema,
  type ServerMessage,
  WS_PATH,
} from '../../shared/protocol.js';
import type { AuthService } from '../auth/auth-service.js';
import { GameError } from '../game/errors.js';
import type { Room, RoomClient } from '../rooms/room.js';
import type { RoomRegistry } from '../rooms/room-registry.js';
import type { TwitchChatClient } from '../twitch/chat-client.js';
import { TokenBucket } from './rate-limiter.js';
import { isSameOrigin } from './request-context.js';

export const MAX_WS_PAYLOAD_BYTES = 16 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * Game-state updates are skipped for a socket this far behind (each state is
 * complete, so only the latest matters); it gets the current state once its
 * buffer drains.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;
const DRAIN_CHECK_MS = 250;

/**
 * Rooms send the same message object to every client of a role, so cache the
 * serialised form per object instead of re-stringifying it per socket.
 */
const serialized = new WeakMap<ServerMessage, string>();
function serialize(message: ServerMessage): string {
  let text = serialized.get(message);
  if (text === undefined) {
    text = JSON.stringify(message);
    serialized.set(message, text);
  }
  return text;
}

/** Close codes in the 4000-4999 application range. */
export const CloseCode = {
  BadHello: 4400,
  Unauthorized: 4401,
  Forbidden: 4403,
  NotFound: 4404,
  HelloTimeout: 4408,
} as const;

export interface WsGatewayOptions {
  readonly registry: RoomRegistry;
  readonly chat: Pick<TwitchChatClient, 'acquire' | 'release' | 'connected'>;
  /** Re-checks host sessions, so signing out or changing password revokes live control. */
  readonly auth: Pick<AuthService, 'resolveSession'>;
  readonly logger: Logger;
}

/**
 * WebSocket endpoint shared by the overlay and host control page.
 *
 * Each connection must first send a `hello` naming its room and role.
 * Overlays are public and read-only. Hosts must be signed in (session
 * cookie), connect from our own origin (blocking cross-site WebSocket
 * hijacking) and own the room; they may then send validated, rate-limited
 * game commands.
 */
export function registerWsGateway(app: FastifyInstance, options: WsGatewayOptions): void {
  const { registry, chat, auth } = options;
  const logger = options.logger.child({ component: 'ws' });

  app.get(WS_PATH, { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    const user = request.user;
    const trustedOrigin = isSameOrigin(request);
    let session: { room: Room; client: RoomClient; role: ClientRole } | null = null;
    let alive = true;
    const bucket = new TokenBucket(20, 5);

    const send = (message: ServerMessage): void => {
      if (socket.readyState !== socket.OPEN) return;
      if (message.type === 'state') {
        if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
          staleState = true;
          scheduleCatchUp();
          return;
        }
        staleState = false;
      }
      socket.send(serialize(message));
    };
    let staleState = false;
    let drainTimer: NodeJS.Timeout | null = null;
    /** Sends the current state once a backed-up socket has drained. */
    const scheduleCatchUp = (): void => {
      if (drainTimer !== null) return;
      drainTimer = setTimeout(() => {
        drainTimer = null;
        if (!staleState || session === null) return;
        if (socket.bufferedAmount > MAX_BUFFERED_BYTES) scheduleCatchUp();
        else session.room.resendState(session.client);
      }, DRAIN_CHECK_MS);
    };
    /** Whether a host connection's sign-in is still valid and still owns its room. */
    const hostStillAuthorized = (room: Room): boolean => {
      const current = auth.resolveSession(request.sessionToken ?? undefined);
      return current?.id === room.ownerId;
    };
    const sendError = (code: ErrorCode, message: string): void => {
      send({ type: 'error', code, message });
    };

    const helloTimer = setTimeout(() => {
      socket.close(CloseCode.HelloTimeout, 'hello timeout');
    }, HELLO_TIMEOUT_MS);
    const heartbeat = setInterval(() => {
      if (session?.role === 'host' && !hostStillAuthorized(session.room)) {
        socket.close(CloseCode.Unauthorized, 'signed out');
        return;
      }
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, HEARTBEAT_INTERVAL_MS);

    socket.on('pong', () => {
      alive = true;
    });

    socket.on('message', (data, isBinary) => {
      alive = true;
      if (!bucket.tryRemove()) {
        sendError('rate_limited', 'Slow down — too many messages.');
        return;
      }
      const payload = isBinary ? null : parseJson(data);
      if (payload === null) {
        sendError('bad_request', 'Messages must be JSON text.');
        return;
      }

      if (session === null) {
        const hello = helloMessageSchema.safeParse(payload);
        if (!hello.success) {
          socket.close(CloseCode.BadHello, 'expected hello');
          return;
        }
        let room: Room | undefined;
        if (hello.data.role === 'host') {
          if (user === null || !trustedOrigin) {
            socket.close(CloseCode.Unauthorized, 'sign in required');
            return;
          }
          room = registry.getOwned(hello.data.roomId, user.id);
          if (!room) {
            socket.close(CloseCode.Forbidden, 'not your game');
            return;
          }
        } else {
          room = registry.get(hello.data.roomId);
          if (!room) {
            socket.close(CloseCode.NotFound, 'room not found');
            return;
          }
        }
        clearTimeout(helloTimer);
        const client: RoomClient = {
          role: hello.data.role,
          send,
          close: (code, reason) => {
            socket.close(code, reason);
          },
        };
        session = { room, client, role: hello.data.role };
        chat.acquire(room.channel);
        send({ type: 'welcome', role: hello.data.role, serverTime: Date.now() });
        send({ type: 'chatStatus', connected: chat.connected });
        room.attach(client);
        logger.debug({ room: room.id, role: hello.data.role }, 'Client attached');
        return;
      }

      if (session.role !== 'host') {
        sendError('unauthorized', 'Overlays are read-only.');
        return;
      }
      if (!hostStillAuthorized(session.room)) {
        socket.close(CloseCode.Unauthorized, 'signed out');
        return;
      }
      const command = hostCommandSchema.safeParse(payload);
      if (!command.success) {
        sendError('bad_request', 'Unrecognised command.');
        return;
      }
      try {
        session.room.execute(command.data);
      } catch (error) {
        if (error instanceof GameError) {
          sendError(error.code, error.message);
        } else {
          logger.error({ err: error, room: session.room.id }, 'Command failed');
          sendError('internal', 'Something went wrong.');
        }
      }
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      clearInterval(heartbeat);
      if (drainTimer !== null) clearTimeout(drainTimer);
      if (session) {
        session.room.detach(session.client);
        chat.release(session.room.channel);
        session = null;
      }
    });

    socket.on('error', (error) => {
      logger.warn({ err: error }, 'WebSocket error');
    });
  });
}

function parseJson(data: WebSocket.RawData): unknown {
  try {
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data as ArrayBuffer).toString('utf8');
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
