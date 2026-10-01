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
      registrationEnabled: true,
      registrationCode: undefined,
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
      REGISTRATION_ENABLED: 'false',
      REGISTRATION_CODE: 'secret',
      ALLOWED_CHANNELS: ' #One, two ,,',
      TRUST_PROXY: 'true',
      SESSION_TTL_DAYS: '7',
    });
    expect(config).toMatchObject({
      env: 'production',
      port: 3000,
      registrationEnabled: false,
      registrationCode: 'secret',
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

  it('treats an empty channel list as unrestricted', () => {
    expect(loadConfig({ ALLOWED_CHANNELS: ' , ' }).allowedChannels).toBeUndefined();
  });

  it('reports every invalid variable', () => {
    expect(() => loadConfig({ PORT: 'eighty', LOG_LEVEL: 'loud' })).toThrow(
      /PORT[\s\S]*LOG_LEVEL/u,
    );
  });
});
