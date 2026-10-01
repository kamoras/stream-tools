import { pino } from 'pino';
import { loadConfig } from './config.js';
import { buildAdminApp } from './http/app.js';
import { AdminSessions } from './sessions.js';
import { UpstreamClient } from './upstream.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.logLevel,
    ...(config.env === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } }
      : {}),
  });
  if (config.password.length < 12) {
    logger.warn('ADMIN_PASSWORD is shorter than 12 characters; consider a longer one.');
  }

  const sessions = new AdminSessions({ password: config.password });
  const upstream = (name: string, baseUrl: string): UpstreamClient =>
    new UpstreamClient({ name, baseUrl, token: config.internalApiToken });
  const app = await buildAdminApp({
    config,
    sessions,
    bot: upstream('Dead by Daylight bot', config.upstreams['dbd-bot']),
    hues: upstream('Hues & Cues', config.upstreams['hues-and-cues']),
    logger,
  });

  const pruneTimer = setInterval(
    () => {
      sessions.prune();
    },
    60 * 60 * 1000,
  );
  pruneTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    clearInterval(pruneTimer);
    await app.close();
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
