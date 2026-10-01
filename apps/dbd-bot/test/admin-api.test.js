'use strict';

// Must be set before requiring db so the module opens an in-memory database.
process.env.DB_PATH = ':memory:';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('../src/db');
const eventsub = require('../src/eventsub');
const { createAdminApi } = require('../src/admin-api');

const TOKEN = 'internal-test-token';
const calls = { removed: [], joined: [], left: [] };
let restarted = false;

const api = createAdminApi({
  token: TOKEN,
  botName: 'testbot',
  prefix: '!dbd ',
  startTime: Date.now() - 5000,
  isConnected: () => true,
  getChannelStats: () => [{ channel: 'streamer', size: 3, isOpen: false }],
  getJoinedChannels: () => ['streamer'],
  getWebhookStats: () => ({ enabled: true, received: 2, recentEvents: [] }),
  onChannelRemoved: async (ch) => { calls.removed.push(ch); },
  joinChannel: async (ch) => { calls.joined.push(ch); },
  leaveChannel: async (ch) => { calls.left.push(ch); },
  twitchClientId: 'client123',
  twitchClientSecret: 'secretabc',
  chatSelfRefreshing: true,
  restartToApplyAuth: () => { restarted = true; },
});

const authed = (req) => req.set('Authorization', `Bearer ${TOKEN}`);

beforeEach(() => {
  for (const k of Object.keys(calls)) calls[k].length = 0;
  restarted = false;
});

describe('admin API auth', () => {
  it('rejects requests without the token', async () => {
    assert.equal((await request(api).get('/status')).status, 401);
  });

  it('rejects a wrong token', async () => {
    const res = await request(api).get('/status').set('Authorization', 'Bearer nope');
    assert.equal(res.status, 401);
  });

  it('refuses to start without a token', () => {
    assert.throws(() => createAdminApi({}), /requires a token/);
  });
});

describe('GET /status', () => {
  it('reports bot, Twitch and webhook state without exposing the client secret', async () => {
    const res = await authed(request(api).get('/status'));
    assert.equal(res.status, 200);
    assert.equal(res.body.botName, 'testbot');
    assert.equal(res.body.connected, true);
    assert.ok(res.body.uptimeMs >= 5000);
    assert.equal(res.body.chatSelfRefreshing, true);
    assert.deepEqual(res.body.twitch, { configured: true, clientId: 'client123' });
    assert.equal(res.body.webhook.received, 2);
    assert.ok(!JSON.stringify(res.body).includes('secretabc'));
  });
});

describe('channels', () => {
  it('lists connected channels with queue and presence', async () => {
    db.addChannel('streamer', 'streamer');
    db.addChannel('quiet', 'quiet');
    const res = await authed(request(api).get('/channels'));
    const byName = Object.fromEntries(res.body.channels.map((c) => [c.channel, c]));
    assert.deepEqual(
      { size: byName.streamer.queueSize, open: byName.streamer.queueOpen, inChat: byName.streamer.inChat },
      { size: 3, open: false, inChat: true },
    );
    assert.equal(byName.quiet.inChat, false);
    assert.equal(typeof byName.quiet.addedAt, 'number');
  });

  it('disconnect removes the channel and tears down its subscriptions', async () => {
    db.addChannel('leaver', 'leaver');
    const res = await authed(request(api).post('/channels/leaver/disconnect'));
    assert.equal(res.status, 204);
    assert.equal(db.channelExists('leaver'), false);
    assert.deepEqual(calls.removed, ['leaver']);
  });

  it('rejects invalid channel names without acting', async () => {
    const res = await authed(request(api).post('/channels/bad%20name!/disconnect'));
    assert.equal(res.status, 400);
    assert.deepEqual(calls.removed, []);
  });

  it('joins only channels that are connected', async () => {
    db.addChannel('joinme', 'joinme');
    assert.equal((await authed(request(api).post('/channels/joinme/join'))).status, 204);
    assert.equal((await authed(request(api).post('/channels/stranger/join'))).status, 404);
    assert.deepEqual(calls.joined, ['joinme']);
  });

  it('leaves a channel', async () => {
    assert.equal((await authed(request(api).post('/channels/streamer/leave'))).status, 204);
    assert.deepEqual(calls.left, ['streamer']);
  });

  it('does not act without the token', async () => {
    db.addChannel('victim', 'victim');
    assert.equal((await request(api).post('/channels/victim/disconnect')).status, 401);
    assert.equal(db.channelExists('victim'), true);
  });
});

describe('invites', () => {
  it('generates, lists and revokes single-use codes', async () => {
    const created = await authed(request(api).post('/invites'));
    assert.equal(created.status, 201);
    assert.match(created.body.code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);

    const list = await authed(request(api).get('/invites'));
    const invite = list.body.invites.find((i) => i.code === created.body.code);
    assert.ok(invite);
    assert.equal(typeof invite.createdAt, 'number');

    assert.equal((await authed(request(api).delete(`/invites/${invite.id}`))).status, 204);
    const after = await authed(request(api).get('/invites'));
    assert.ok(!after.body.invites.some((i) => i.code === created.body.code));
    assert.equal(db.validateAndUseCode(created.body.code, 'someone'), false);
  });

  it('rejects a non-numeric id', async () => {
    assert.equal((await authed(request(api).delete('/invites/abc'))).status, 400);
  });
});

describe('POST /twitch/exchange', () => {
  let originalExchange;
  let exchangeCalls;

  before(() => {
    originalExchange = eventsub.exchangeAuthCode;
    eventsub.exchangeAuthCode = async (opts) => {
      exchangeCalls.push(opts);
      if (opts.code === 'bad') throw new Error('invalid code');
      return { access_token: 'tok', refresh_token: 'fresh-refresh-token', expires_in: 14400 };
    };
  });

  after(() => {
    eventsub.exchangeAuthCode = originalExchange;
  });

  beforeEach(() => {
    exchangeCalls = [];
  });

  const redirectUri = 'https://bot.example.com/admin/secret/twitch-callback';

  it('exchanges the code, persists the refresh token and restarts', async () => {
    const res = await authed(request(api).post('/twitch/exchange')).send({ code: 'authcode123', redirectUri });
    assert.equal(res.status, 204);
    assert.equal(db.getSetting('twitch_refresh_token'), 'fresh-refresh-token');
    assert.equal(restarted, true);
    assert.deepEqual(exchangeCalls[0], {
      code: 'authcode123', clientId: 'client123', clientSecret: 'secretabc', redirectUri,
    });
  });

  it('reports a rejected code without restarting', async () => {
    const res = await authed(request(api).post('/twitch/exchange')).send({ code: 'bad', redirectUri });
    assert.equal(res.status, 502);
    assert.equal(restarted, false);
  });

  it('validates input', async () => {
    const res = await authed(request(api).post('/twitch/exchange')).send({ code: 'x', redirectUri: 'http://insecure' });
    assert.equal(res.status, 400);
    assert.equal(exchangeCalls.length, 0);
  });

  it('is unavailable when Twitch credentials are absent', async () => {
    const bare = createAdminApi({ token: TOKEN });
    const res = await request(bare).post('/twitch/exchange').set('Authorization', `Bearer ${TOKEN}`)
      .send({ code: 'x', redirectUri });
    assert.equal(res.status, 404);
  });
});
