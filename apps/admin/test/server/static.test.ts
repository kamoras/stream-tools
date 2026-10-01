import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildAdminApp } from '../../src/server/http/app.js';
import { AdminSessions } from '../../src/server/sessions.js';
import { UpstreamClient } from '../../src/server/upstream.js';
import { silentLogger } from '../helpers.js';

describe('dashboard page serving', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const publicDir = mkdtempSync(join(tmpdir(), 'admin-public-'));
    writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>dash</title>');
    mkdirSync(join(publicDir, 'assets'));
    writeFileSync(join(publicDir, 'assets', 'app.js'), 'console.log(1)');
    const upstream = new UpstreamClient({ name: 'x', baseUrl: 'http://127.0.0.1:9', token: 't' });
    app = await buildAdminApp({
      config: {
        path: 'secret',
        publicUrl: 'https://bot.example.com',
        cookieSecure: false,
        trustProxy: false,
        publicDir,
        env: 'test',
      },
      sessions: new AdminSessions({ password: 'pw' }),
      bot: upstream,
      hues: upstream,
      logger: silentLogger,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the page and assets only under the secret path', async () => {
    expect((await app.inject('/admin/secret')).headers.location).toBe('/admin/secret/');
    const page = await app.inject('/admin/secret/');
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect((await app.inject('/admin/secret/assets/app.js')).statusCode).toBe(200);
    expect((await app.inject('/assets/app.js')).statusCode).toBe(404);
    expect((await app.inject('/admin/assets/app.js')).statusCode).toBe(404);
  });

  it('does not serve the page at a second URL', async () => {
    expect((await app.inject('/admin/secret/index.html')).statusCode).toBe(404);
  });
});
