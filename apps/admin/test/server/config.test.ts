import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';

const REQUIRED = {
  ADMIN_PASSWORD: 'admin password',
  PUBLIC_URL: 'https://bot.example.com',
  DBD_BOT_API_TOKEN: 'b'.repeat(64),
  HUES_API_TOKEN: 'h'.repeat(64),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(REQUIRED)).toMatchObject({
      port: 8080,
      path: 'admin',
      publicUrl: 'https://bot.example.com',
      upstreams: {
        'dbd-bot': { url: 'http://dbd-bot:9000', token: 'b'.repeat(64) },
        'hues-and-cues': { url: 'http://hues-and-cues:9000', token: 'h'.repeat(64) },
      },
      cookieSecure: false,
    });
    expect(loadConfig({ ...REQUIRED, NODE_ENV: 'production' }).cookieSecure).toBe(true);
  });

  it('requires the password, public URL and a token per app', () => {
    expect(() => loadConfig({})).toThrow(
      /ADMIN_PASSWORD[\s\S]*PUBLIC_URL[\s\S]*DBD_BOT_API_TOKEN[\s\S]*HUES_API_TOKEN/u,
    );
  });

  it('validates the path, URL and token length', () => {
    expect(() => loadConfig({ ...REQUIRED, ADMIN_PATH: 'has/slash' })).toThrow(/ADMIN_PATH/u);
    expect(() => loadConfig({ ...REQUIRED, PUBLIC_URL: 'https://x.example.com/' })).toThrow(
      /PUBLIC_URL/u,
    );
    expect(() => loadConfig({ ...REQUIRED, HUES_API_TOKEN: 'short' })).toThrow(/HUES_API_TOKEN/u);
  });
});
