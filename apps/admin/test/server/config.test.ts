import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';

const REQUIRED = {
  ADMIN_PASSWORD: 'admin password',
  PUBLIC_URL: 'https://bot.example.com',
  INTERNAL_API_TOKEN: 't'.repeat(64),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(REQUIRED)).toMatchObject({
      port: 8080,
      path: 'admin',
      publicUrl: 'https://bot.example.com',
      upstreams: { 'dbd-bot': 'http://dbd-bot:9000', 'hues-and-cues': 'http://hues-and-cues:9000' },
      cookieSecure: false,
    });
    expect(loadConfig({ ...REQUIRED, NODE_ENV: 'production' }).cookieSecure).toBe(true);
  });

  it('requires the password, public URL and token', () => {
    expect(() => loadConfig({})).toThrow(
      /ADMIN_PASSWORD[\s\S]*PUBLIC_URL[\s\S]*INTERNAL_API_TOKEN/u,
    );
  });

  it('validates the path, URL and token length', () => {
    expect(() => loadConfig({ ...REQUIRED, ADMIN_PATH: 'has/slash' })).toThrow(/ADMIN_PATH/u);
    expect(() => loadConfig({ ...REQUIRED, PUBLIC_URL: 'https://x.example.com/' })).toThrow(
      /PUBLIC_URL/u,
    );
    expect(() => loadConfig({ ...REQUIRED, INTERNAL_API_TOKEN: 'short' })).toThrow(
      /INTERNAL_API_TOKEN/u,
    );
  });
});
