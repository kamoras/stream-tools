'use strict';

const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const eventsub = require('./eventsub');

// ---------------------------------------------------------------------------
// Internal admin API
//
// JSON endpoints used by the shared stream-tools admin dashboard (apps/admin).
// They listen on a separate port that is only reachable on the private Docker
// network — Caddy never routes to it — and every request must carry the
// shared INTERNAL_API_TOKEN as a bearer token. The bot itself has no admin UI.
// ---------------------------------------------------------------------------

const CHANNEL_RE = /^[a-z0-9_]{3,25}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function requireToken(token) {
  const expected = sha256(token);
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (presented && crypto.timingSafeEqual(sha256(presented), expected)) return next();
    res.status(401).json({ error: 'Unauthorized' });
  };
}

function normaliseChannel(value) {
  const channel = String(value || '').trim().toLowerCase().replace(/^#/, '');
  return CHANNEL_RE.test(channel) ? channel : null;
}

function generateInviteCode() {
  const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

// SQLite's datetime('now') is UTC without a zone; return epoch milliseconds.
function sqliteToEpoch(value) {
  return value ? Date.parse(`${value.replace(' ', 'T')}Z`) : null;
}

function createAdminApi({
  token,
  botName,
  prefix = '!dbd ',
  startTime = Date.now(),
  isConnected = () => true,
  getChannelStats = () => [],
  getJoinedChannels = () => [],
  getWebhookStats = () => ({ enabled: false }),
  onChannelRemoved = async () => {},
  joinChannel = async () => {},
  leaveChannel = async () => {},
  twitchClientId = '',
  twitchClientSecret = '',
  chatSelfRefreshing = false,
  restartToApplyAuth = () => {},
} = {}) {
  if (!token) throw new Error('createAdminApi requires a token');

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' }));
  app.use(requireToken(token));

  const twitchConfigured = Boolean(twitchClientId && twitchClientSecret);

  app.get('/status', (_req, res) => {
    res.json({
      botName,
      prefix,
      connected: isConnected(),
      uptimeMs: Date.now() - startTime,
      chatSelfRefreshing,
      twitch: { configured: twitchConfigured, clientId: twitchConfigured ? twitchClientId : null },
      webhook: getWebhookStats(),
    });
  });

  app.get('/channels', (_req, res) => {
    const stats = new Map(getChannelStats().map(s => [s.channel, s]));
    const joined = new Set(getJoinedChannels());
    res.json({
      channels: db.getChannelList().map(row => {
        const s = stats.get(row.channel_name) || { size: 0, isOpen: true };
        return {
          channel: row.channel_name,
          addedAt: sqliteToEpoch(row.added_at),
          queueSize: s.size,
          queueOpen: s.isOpen,
          inChat: joined.has(row.channel_name),
        };
      }),
    });
  });

  app.get('/invites', (_req, res) => {
    res.json({
      invites: db.getPendingCodes().map(c => ({
        id: c.id,
        code: c.code,
        createdAt: sqliteToEpoch(c.created_at),
      })),
    });
  });

  app.post('/invites', (_req, res) => {
    const code = generateInviteCode();
    db.createInviteCode(code);
    console.log('[admin-api] Invite code generated');
    res.status(201).json({ code });
  });

  app.delete('/invites/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    db.deleteInviteCode(id);
    res.status(204).end();
  });

  // Permanent removal: leaves chat and tears down EventSub subscriptions.
  app.post('/channels/:channel/disconnect', (req, res) => {
    const channel = normaliseChannel(req.params.channel);
    if (!channel) return res.status(400).json({ error: 'Invalid channel' });
    db.removeChannel(channel);
    Promise.resolve(onChannelRemoved(channel)).catch(err => {
      console.error(`[admin-api] Failed to disconnect #${channel}:`, err.message);
    });
    res.status(204).end();
  });

  // Manual presence override — join/leave chat without changing the channel's
  // connection or subscriptions. Useful when webhooks lag.
  app.post('/channels/:channel/join', (req, res) => {
    const channel = normaliseChannel(req.params.channel);
    if (!channel) return res.status(400).json({ error: 'Invalid channel' });
    if (!db.channelExists(channel)) return res.status(404).json({ error: 'Channel is not connected' });
    Promise.resolve(joinChannel(channel)).catch(err => {
      console.error(`[admin-api] Manual join failed for #${channel}:`, err.message);
    });
    res.status(204).end();
  });

  app.post('/channels/:channel/leave', (req, res) => {
    const channel = normaliseChannel(req.params.channel);
    if (!channel) return res.status(400).json({ error: 'Invalid channel' });
    Promise.resolve(leaveChannel(channel)).catch(err => {
      console.error(`[admin-api] Manual leave failed for #${channel}:`, err.message);
    });
    res.status(204).end();
  });

  // Completes the dashboard's "Connect via Twitch" flow. The dashboard owns the
  // browser redirect and its CSRF state; the bot holds the client secret, so
  // the code is exchanged here and the bot restarts onto the new chat login.
  app.post('/twitch/exchange', async (req, res) => {
    if (!twitchConfigured) return res.status(404).json({ error: 'Twitch app credentials are not configured' });
    const { code, redirectUri } = req.body || {};
    if (typeof code !== 'string' || !code || typeof redirectUri !== 'string' || !/^https:\/\//.test(redirectUri)) {
      return res.status(400).json({ error: 'code and an https redirectUri are required' });
    }
    try {
      const data = await eventsub.exchangeAuthCode({
        code, clientId: twitchClientId, clientSecret: twitchClientSecret, redirectUri,
      });
      db.setSetting('twitch_refresh_token', data.refresh_token);
      res.status(204).end();
      restartToApplyAuth();
    } catch (err) {
      console.error('[admin-api] Twitch code exchange failed:', err.message);
      res.status(502).json({ error: 'Twitch rejected the authorization code' });
    }
  });

  return app;
}

module.exports = { createAdminApi };
