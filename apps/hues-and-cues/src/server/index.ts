import { pino } from 'pino';
import { loadConfig } from './config.js';
import { buildApp } from './http/app.js';
import { buildInternalApi } from './http/internal-api.js';
import { AuthService } from './auth/auth-service.js';
import { InviteRepository } from './auth/invite-codes.js';
import { SessionRepository } from './auth/session-repository.js';
import { UserRepository } from './auth/user-repository.js';
import { openDatabase } from './db/database.js';
import { RoomRegistry } from './rooms/room-registry.js';
import { RoomStore } from './rooms/room-store.js';
import { TwitchChatClient } from './twitch/chat-client.js';

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.logLevel,
    ...(config.env === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } }
      : {}),
  });

  const db = openDatabase(config.databaseFile, logger);
  const users = new UserRepository(db);
  const invites = new InviteRepository(db);
  const auth = new AuthService({
    users,
    invites,
    sessions: new SessionRepository(db, { ttlMs: config.sessionTtlMs }),
    transaction: (fn) => db.transaction(fn)(),
    logger,
  });
  const internalApi = config.internalApi
    ? buildInternalApi({
        token: config.internalApi.token,
        invites,
        users,
        inviteTtlMs: config.inviteTtlMs,
        logger,
      })
    : undefined;
  if (!internalApi) {
    logger.warn(
      'INTERNAL_API_TOKEN is not set: the admin dashboard cannot reach this app, so no invite codes can be generated and nobody can sign up.',
    );
  }
  const registry = new RoomRegistry({
    logger,
    store: new RoomStore(db),
    retentionMs: config.roomRetentionMs,
    maxRooms: config.maxRooms,
    maxRoomsPerUser: config.maxRoomsPerUser,
  });
  registry.load();

  const chat = new TwitchChatClient({ logger });
  chat.on('message', (message) => {
    registry.routeChat(message);
  });
  const announceChatStatus = (): void => {
    registry.forEach((room) => {
      room.sendToAll({ type: 'chatStatus', connected: chat.connected });
    });
  };
  chat.on('connected', announceChatStatus);
  chat.on('disconnected', announceChatStatus);
  chat.start();

  const app = await buildApp({ config, auth, registry, chat, logger });
  const maintenanceTimer = setInterval(() => {
    registry.prune();
    auth.pruneExpired();
  }, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    clearInterval(maintenanceTimer);
    // Persist game state first, so a slow close can't lose it to the force-exit timer.
    registry.flush();
    chat.stop();
    // Drop WebSocket clients without waiting for close handshakes; they reconnect to the new process.
    for (const client of app.websocketServer.clients) client.terminate();
    await app.close();
    await internalApi?.close();
    registry.shutdown();
    db.close();
    logger.info('Shutdown complete');
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  await app.listen({ host: config.host, port: config.port });
  if (internalApi && config.internalApi) {
    await internalApi.listen({ host: config.host, port: config.internalApi.port });
  }
}

main().catch((error: unknown) => {
  // Logger may not exist yet (e.g. invalid configuration), so fall back to stderr.
  process.stderr.write(
    `Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
