'use strict';

// Must be set before requiring db so the module opens an in-memory database.
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'secret';
process.env.ADMIN_PATH = 'admin';

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('../src/db');
const eventsub = require('../src/eventsub');
const { createWebServer, _resetRateLimiterForTesting } = require('../src/web');

async function adminLogin(app) {
  const res = await request(app).post('/admin/admin/login').type('form').send({ password: 'secret' });
  return res.headers['set-cookie'];
}

describe('admin - Twitch chat login connect flow', () => {
  let originalExchange;
  let exchangeCalls;
  let restarted;
  let app;

  before(() => {
    originalExchange = eventsub.exchangeAuthCode;
    exchangeCalls = [];
    eventsub.exchangeAuthCode = async (opts) => {
      exchangeCalls.push(opts);
      return { access_token: 'tok', refresh_token: 'fresh-refresh-token', expires_in: 14400 };
    };
    restarted = false;
    app = createWebServer({
      botName: 'testbot',
      domain: 'bot.example.com',
      twitchClientId: 'client123',
      twitchClientSecret: 'secretabc',
      restartToApplyAuth: () => { restarted = true; },
    });
  });

  after(() => {
    eventsub.exchangeAuthCode = originalExchange;
  });

  beforeEach(() => {
    _resetRateLimiterForTesting();
  });

  it('redirects to Twitch with a state param when authenticated', async () => {
    const cookie = await adminLogin(app);
    const res = await request(app).get('/admin/admin/twitch-connect').set('Cookie', cookie);
    assert.equal(res.status, 302);
    const location = new URL(res.headers.location);
    assert.equal(location.origin + location.pathname, 'https://id.twitch.tv/oauth2/authorize');
    assert.equal(location.searchParams.get('client_id'), 'client123');
    assert.equal(location.searchParams.get('redirect_uri'), 'https://bot.example.com/admin/admin/twitch-callback');
    assert.ok(location.searchParams.get('state'));
  });

  it('requires auth for the connect route', async () => {
    const res = await request(app).get('/admin/admin/twitch-connect');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin/admin');
  });

  it('exchanges a valid code+state, persists the refresh token, and restarts', async () => {
    const cookie = await adminLogin(app);
    const connectRes = await request(app).get('/admin/admin/twitch-connect').set('Cookie', cookie);
    const state = new URL(connectRes.headers.location).searchParams.get('state');

    const res = await request(app)
      .get('/admin/admin/twitch-callback')
      .query({ code: 'authcode123', state })
      .set('Cookie', cookie);

    assert.equal(res.status, 200);
    assert.equal(db.getSetting('twitch_refresh_token'), 'fresh-refresh-token');
    assert.equal(restarted, true);
    assert.equal(exchangeCalls.length, 1);
    assert.equal(exchangeCalls[0].code, 'authcode123');
  });

  it('rejects a callback with an unknown or reused state', async () => {
    const cookie = await adminLogin(app);
    const res = await request(app)
      .get('/admin/admin/twitch-callback')
      .query({ code: 'authcode123', state: 'not-a-real-state' })
      .set('Cookie', cookie);
    assert.equal(res.status, 400);
  });

  it('is not registered when Twitch client credentials are absent', async () => {
    const bareApp = createWebServer({ botName: 'testbot' });
    const cookie = await adminLogin(bareApp);
    const res = await request(bareApp).get('/admin/admin/twitch-connect').set('Cookie', cookie);
    assert.equal(res.status, 404);
  });
});
