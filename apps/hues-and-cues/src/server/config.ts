import { resolve } from 'node:path';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => ['true', '1', 'yes'].includes(value));

const channelList = z.string().transform((value) =>
  value
    .split(',')
    .map((channel) => channel.trim().replace(/^#/u, '').toLowerCase())
    .filter((channel) => channel !== ''),
);

const DAY_MS = 24 * 60 * 60 * 1000;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATA_DIR: z.string().default('./data'),
  /** Password for the admin page. With ADMIN_PATH, enables the admin area. */
  ADMIN_PASSWORD: z.string().min(12, 'must be at least 12 characters').optional(),
  /** Secret URL segment: the admin page lives at /admin/<ADMIN_PATH>. */
  ADMIN_PATH: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,128}$/u, 'must be 8-128 letters, numbers, _ or -')
    .optional(),
  /** Days an unused invite code stays valid. */
  INVITE_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  /** If set, only these Twitch channels may have games. Comma-separated. */
  ALLOWED_CHANNELS: channelList.optional(),
  /** Set when running behind a reverse proxy (Caddy, nginx) so client IPs are correct. */
  TRUST_PROXY: booleanString.default(false),
  /** Mark session cookies `Secure` (HTTPS only). Defaults to on in production. */
  COOKIE_SECURE: booleanString.optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  ROOM_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  MAX_ROOMS: z.coerce.number().int().min(1).default(500),
  MAX_ROOMS_PER_USER: z.coerce.number().int().min(1).max(100).default(5),
  /** Directory of built client assets. */
  PUBLIC_DIR: z.string().default('./dist/public'),
});

export interface AppConfig {
  readonly env: 'development' | 'production' | 'test';
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly databaseFile: string;
  readonly publicDir: string;
  /** Present only when both ADMIN_PASSWORD and ADMIN_PATH are set. */
  readonly admin: { readonly password: string; readonly path: string } | undefined;
  readonly inviteTtlMs: number;
  readonly allowedChannels: readonly string[] | undefined;
  readonly trustProxy: boolean;
  readonly cookieSecure: boolean;
  readonly sessionTtlMs: number;
  readonly roomRetentionMs: number;
  readonly maxRooms: number;
  readonly maxRoomsPerUser: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  const values = parsed.data;
  if ((values.ADMIN_PASSWORD === undefined) !== (values.ADMIN_PATH === undefined)) {
    throw new Error('Invalid configuration:\n  ADMIN_PASSWORD and ADMIN_PATH must be set together');
  }
  const allowed = values.ALLOWED_CHANNELS;
  return {
    env: values.NODE_ENV,
    host: values.HOST,
    port: values.PORT,
    logLevel: values.LOG_LEVEL,
    databaseFile: resolve(values.DATA_DIR, 'hues.db'),
    publicDir: resolve(values.PUBLIC_DIR),
    admin:
      values.ADMIN_PASSWORD !== undefined && values.ADMIN_PATH !== undefined
        ? { password: values.ADMIN_PASSWORD, path: values.ADMIN_PATH }
        : undefined,
    inviteTtlMs: values.INVITE_TTL_DAYS * DAY_MS,
    allowedChannels: allowed && allowed.length > 0 ? allowed : undefined,
    trustProxy: values.TRUST_PROXY,
    cookieSecure: values.COOKIE_SECURE ?? values.NODE_ENV === 'production',
    sessionTtlMs: values.SESSION_TTL_DAYS * DAY_MS,
    roomRetentionMs: values.ROOM_RETENTION_DAYS * DAY_MS,
    maxRooms: values.MAX_ROOMS,
    maxRoomsPerUser: values.MAX_ROOMS_PER_USER,
  };
}
