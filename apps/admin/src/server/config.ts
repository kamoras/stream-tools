import { resolve } from 'node:path';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => ['true', '1', 'yes'].includes(value));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** The one admin password for every app. */
  ADMIN_PASSWORD: z.string().min(1, 'is required'),
  /** Secret URL segment: the dashboard lives at /admin/<ADMIN_PATH>. */
  ADMIN_PATH: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/u, 'must be letters, numbers, _ or -')
    .default('admin'),
  /** Public origin the dashboard is served from, e.g. https://bot.example.com. */
  PUBLIC_URL: z.url().refine((url) => !url.endsWith('/'), 'must not end with /'),
  /** Shared secret presented to each app's internal admin API. */
  INTERNAL_API_TOKEN: z.string().min(32, 'must be at least 32 characters'),
  DBD_BOT_API_URL: z.url().default('http://dbd-bot:9000'),
  HUES_API_URL: z.url().default('http://hues-and-cues:9000'),
  TRUST_PROXY: booleanString.default(false),
  COOKIE_SECURE: booleanString.optional(),
  PUBLIC_DIR: z.string().default('./dist/public'),
});

export interface AdminConfig {
  readonly env: 'development' | 'production' | 'test';
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly password: string;
  readonly path: string;
  readonly publicUrl: string;
  readonly internalApiToken: string;
  readonly upstreams: { readonly 'dbd-bot': string; readonly 'hues-and-cues': string };
  readonly trustProxy: boolean;
  readonly cookieSecure: boolean;
  readonly publicDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  const v = parsed.data;
  return {
    env: v.NODE_ENV,
    host: v.HOST,
    port: v.PORT,
    logLevel: v.LOG_LEVEL,
    password: v.ADMIN_PASSWORD,
    path: v.ADMIN_PATH,
    publicUrl: v.PUBLIC_URL,
    internalApiToken: v.INTERNAL_API_TOKEN,
    upstreams: { 'dbd-bot': v.DBD_BOT_API_URL, 'hues-and-cues': v.HUES_API_URL },
    trustProxy: v.TRUST_PROXY,
    cookieSecure: v.COOKIE_SECURE ?? v.NODE_ENV === 'production',
    publicDir: resolve(v.PUBLIC_DIR),
  };
}
