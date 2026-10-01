import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';

const DAY = 24 * 60 * 60 * 1000;

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      env: 'development',
      host: '0.0.0.0',
      port: 8080,
      admin: undefined,
      inviteTtlMs: 14 * DAY,
      allowedChannels: undefined,
      trustProxy: false,
      cookieSecure: false,
      sessionTtlMs: 30 * DAY,
      roomRetentionMs: 90 * DAY,
      maxRooms: 500,
      maxRoomsPerUser: 5,
    });
    expect(config.databaseFile).toMatch(/data[\\/]hues\.db$/u);
  });

  it('parses overrides', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '3000',
      ADMIN_PASSWORD: 'a long admin password',
      ADMIN_PATH: 'secret-path_1',
      INVITE_TTL_DAYS: '3',
      ALLOWED_CHANNELS: ' #One, two ,,',
      TRUST_PROXY: 'true',
      SESSION_TTL_DAYS: '7',
    });
    expect(config).toMatchObject({
      env: 'production',
      port: 3000,
      admin: { password: 'a long admin password', path: 'secret-path_1' },
      inviteTtlMs: 3 * DAY,
      allowedChannels: ['one', 'two'],
      trustProxy: true,
      cookieSecure: true,
      sessionTtlMs: 7 * DAY,
    });
  });

  it('lets COOKIE_SECURE override the environment default', () => {
    expect(loadConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
    expect(loadConfig({ COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);
  });

  it('requires ADMIN_PASSWORD and ADMIN_PATH together, and validates them', () => {
    expect(() => loadConfig({ ADMIN_PASSWORD: 'a long admin password' })).toThrow(/set together/u);
    expect(() => loadConfig({ ADMIN_PATH: 'secret-path' })).toThrow(/set together/u);
    expect(() => loadConfig({ ADMIN_PASSWORD: 'short', ADMIN_PATH: 'secret-path' })).toThrow(
      /ADMIN_PASSWORD/u,
    );
    expect(() =>
      loadConfig({ ADMIN_PASSWORD: 'a long admin password', ADMIN_PATH: 'has/slash' }),
    ).toThrow(/ADMIN_PATH/u);
  });

  it('treats an empty channel list as unrestricted', () => {
    expect(loadConfig({ ALLOWED_CHANNELS: ' , ' }).allowedChannels).toBeUndefined();
  });

  it('reports every invalid variable', () => {
    expect(() => loadConfig({ PORT: 'eighty', LOG_LEVEL: 'loud' })).toThrow(
      /PORT[\s\S]*LOG_LEVEL/u,
    );
  });
});
