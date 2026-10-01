'use strict';

// Must be set before requiring db so the module opens an in-memory database.
process.env.DB_PATH = ':memory:';

const crypto = require('crypto');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('../src/db');
const { createWebServer, _resetRateLimiterForTesting } = require('../src/web');

const app = createWebServer({ botName: 'testbot' });

// A second instance with webhooks enabled, capturing the calls it makes to the bot.
const calls = { added: [], online: [], offline: [] };
const WEBHOOK_SECRET = 'test-webhook-secret';
const webhookApp = createWebServer({
  botName: 'testbot',
  webhookSecret: WEBHOOK_SECRET,
  onChannelAdded: async (ch) => { calls.added.push(ch); },
  onStreamOnline: (ch) => { calls.online.push(ch); },
  onStreamOffline: (ch) => { calls.offline.push(ch); },
});

beforeEach(() => {
  _resetRateLimiterForTesting();
  for (const k of Object.keys(calls)) calls[k].length = 0;
});

// Builds a request that mimics how Twitch signs EventSub deliveries.
function signedWebhook(messageType, payload, { secret = WEBHOOK_SECRET, messageId, timestamp } = {}) {
  const id = messageId ?? crypto.randomBytes(8).toString('hex');
  const ts = timestamp ?? new Date().toISOString();
  const raw = JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', secret).update(id + ts + raw).digest('hex');
  return request(webhookApp)
    .post('/webhook/twitch')
    .set('Twitch-Eventsub-Message-Id', id)
    .set('Twitch-Eventsub-Message-Timestamp', ts)
    .set('Twitch-Eventsub-Message-Type', messageType)
    .set('Twitch-Eventsub-Message-Signature', `sha256=${hmac}`)
    .set('Content-Type', 'application/json')
    .send(raw);
}

function notification(type, channel) {
  return { subscription: { type }, event: { broadcaster_user_login: channel } };
}

describe('GET /', () => {
  it('returns 200 with the landing page', async () => {
    const res = await request(app).get('/');
    assert.equal(res.status, 200);
    assert.match(res.text, /Enter the Fog/);
    assert.match(res.text, /testbot/);
  });
});

describe('GET /health', () => {
  it('returns ok JSON', async () => {
    const res = await request(app).get('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.ok(typeof res.body.uptimeMs === 'number');
  });
});

describe('POST /onboard', () => {
  it('rejects missing fields', async () => {
    const res = await request(app).post('/onboard').type('form').send({});
    assert.equal(res.status, 400);
    assert.match(res.text, /required/i);
  });

  it('rejects an invalid channel name', async () => {
    db.createInviteCode('WEB-0001');
    const res = await request(app)
      .post('/onboard')
      .type('form')
      .send({ invite_code: 'WEB-0001', channel_name: 'invalid channel!' });
    assert.equal(res.status, 400);
    assert.match(res.text, /Invalid channel name/);
  });

  it('rejects an unknown invite code', async () => {
    const res = await request(app)
      .post('/onboard')
      .type('form')
      .send({ invite_code: 'ZZZZ-ZZZZ', channel_name: 'goodchannel' });
    assert.equal(res.status, 400);
    assert.match(res.text, /Invalid or already-used/);
  });

  it('rejects an already-used invite code', async () => {
    db.createInviteCode('WEB-0002');
    db.validateAndUseCode('WEB-0002', 'someone');
    const res = await request(app)
      .post('/onboard')
      .type('form')
      .send({ invite_code: 'WEB-0002', channel_name: 'goodchannel' });
    assert.equal(res.status, 400);
    assert.match(res.text, /Invalid or already-used/);
  });

  it('accepts a valid invite code and channel name', async () => {
    db.createInviteCode('WEB-0003');
    const res = await request(app)
      .post('/onboard')
      .type('form')
      .send({ invite_code: 'WEB-0003', channel_name: 'newstreamer' });
    assert.equal(res.status, 200);
    assert.match(res.text, /You're in the Fog/);
    assert.equal(db.channelExists('newstreamer'), true);
  });

  it('burns the invite code so it cannot be reused', async () => {
    db.createInviteCode('WEB-0004');
    await request(app)
      .post('/onboard')
      .type('form')
      .send({ invite_code: 'WEB-0004', channel_name: 'streamer1' });
    const res = await request(app)
      .post('/onboard')
      .type('form')
      .send({ invite_code: 'WEB-0004', channel_name: 'streamer2' });
    assert.equal(res.status, 400);
  });

  it('rejects a channel that is already connected', async () => {
    db.createInviteCode('WEB-0005');
    db.createInviteCode('WEB-0006');
    await request(app)
      .post('/onboard')
      .type('form')
      .send({ invite_code: 'WEB-0005', channel_name: 'existingchan' });
    const res = await request(app)
      .post('/onboard')
      .type('form')
      .send({ invite_code: 'WEB-0006', channel_name: 'existingchan' });
    assert.equal(res.status, 400);
    assert.match(res.text, /already connected/);
  });

  it('is case-insensitive for channel names', async () => {
    db.createInviteCode('WEB-0007');
    const res = await request(app)
      .post('/onboard')
      .type('form')
      .send({ invite_code: 'WEB-0007', channel_name: 'MyCHANNEL' });
    assert.equal(res.status, 200);
    assert.equal(db.channelExists('mychannel'), true);
  });
});

describe('/admin/*', () => {
  it('is not served by the bot (the dashboard is a separate service)', async () => {
    for (const path of ['/admin', '/admin/admin', '/admin/anything/login']) {
      const res = await request(app).get(path);
      assert.equal(res.status, 404);
    }
  });
});

describe('POST /webhook/twitch', () => {
  it('echoes the challenge during subscription verification', async () => {
    const res = await signedWebhook('webhook_callback_verification', { challenge: 'abc123' });
    assert.equal(res.status, 200);
    assert.equal(res.text, 'abc123');
  });

  it('fires onStreamOnline for a stream.online notification', async () => {
    const res = await signedWebhook('notification', notification('stream.online', 'goinglive'));
    assert.equal(res.status, 204);
    assert.deepEqual(calls.online, ['goinglive']);
    assert.deepEqual(calls.offline, []);
  });

  it('fires onStreamOffline for a stream.offline notification', async () => {
    const res = await signedWebhook('notification', notification('stream.offline', 'goingoff'));
    assert.equal(res.status, 204);
    assert.deepEqual(calls.offline, ['goingoff']);
    assert.deepEqual(calls.online, []);
  });

  it('rejects a bad signature with 403 and does not act', async () => {
    const id = 'msg-bad';
    const ts = new Date().toISOString();
    const res = await request(webhookApp)
      .post('/webhook/twitch')
      .set('Twitch-Eventsub-Message-Id', id)
      .set('Twitch-Eventsub-Message-Timestamp', ts)
      .set('Twitch-Eventsub-Message-Type', 'notification')
      .set('Twitch-Eventsub-Message-Signature', 'sha256=deadbeef')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(notification('stream.online', 'nope')));
    assert.equal(res.status, 403);
    assert.deepEqual(calls.online, []);
  });

  it('acknowledges but ignores a duplicate message id', async () => {
    const messageId = 'dupe-1';
    const first = await signedWebhook('notification', notification('stream.online', 'oncechan'), { messageId });
    const second = await signedWebhook('notification', notification('stream.online', 'oncechan'), { messageId });
    assert.equal(first.status, 204);
    assert.equal(second.status, 204);
    assert.deepEqual(calls.online, ['oncechan']); // only the first delivery acted
  });

  it('acknowledges but ignores a stale timestamp', async () => {
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const res = await signedWebhook('notification', notification('stream.online', 'stalechan'), { timestamp: old });
    assert.equal(res.status, 204);
    assert.deepEqual(calls.online, []);
  });

  it('records a revocation without crashing', async () => {
    const res = await signedWebhook('revocation', {
      subscription: { type: 'stream.online', status: 'authorization_revoked', condition: { broadcaster_user_id: '4242' } },
    });
    assert.equal(res.status, 204);
    assert.deepEqual(calls.online, []);
    assert.deepEqual(calls.offline, []);
  });

  it('returns 400 on an unparseable body', async () => {
    const id = crypto.randomBytes(8).toString('hex');
    const ts = new Date().toISOString();
    const raw = '{not json';
    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(id + ts + raw).digest('hex');
    const res = await request(webhookApp)
      .post('/webhook/twitch')
      .set('Twitch-Eventsub-Message-Id', id)
      .set('Twitch-Eventsub-Message-Timestamp', ts)
      .set('Twitch-Eventsub-Message-Type', 'notification')
      .set('Twitch-Eventsub-Message-Signature', `sha256=${hmac}`)
      .set('Content-Type', 'application/json')
      .send(raw);
    assert.equal(res.status, 400);
  });
});
