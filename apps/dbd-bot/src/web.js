'use strict';

const express = require('express');
const db = require('./db');

const START_TIME = Date.now();

// ---------------------------------------------------------------------------
// Webhook stats (in-memory, resets on restart)
// ---------------------------------------------------------------------------

const webhookStats = {
  received: 0,
  verified: 0,
  rejected: 0,
  online: 0,
  offline: 0,
  revoked: 0,
  lastReceivedAt: null,
  recentEvents: [], // [{channel, type, time}], capped at 20
};

function recordWebhookReceived() { webhookStats.received += 1; webhookStats.lastReceivedAt = Date.now(); }
function recordWebhookVerified() { webhookStats.verified += 1; }
function recordWebhookRejected() { webhookStats.rejected += 1; }
function recordWebhookEvent(channel, type) {
  if (type === 'online') webhookStats.online += 1;
  else if (type === 'offline') webhookStats.offline += 1;
  else if (type === 'revoked') webhookStats.revoked += 1;
  webhookStats.recentEvents.unshift({ channel, type, time: Date.now() });
  if (webhookStats.recentEvents.length > 20) webhookStats.recentEvents.pop();
}

// ---------------------------------------------------------------------------
// SVG assets
// ---------------------------------------------------------------------------

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="#0a0a10"/>
  <g stroke="#cc2222" stroke-linecap="round" stroke-linejoin="round" fill="none" stroke-width="2.2">
    <circle cx="15" cy="6.5" r="3.2"/>
    <line x1="15" y1="9.7" x2="15" y2="21.5"/>
    <path d="M15 21.5 Q15 27.5 20.5 27.5 Q26 27.5 26 22.5"/>
    <line x1="26" y1="22.5" x2="21.5" y2="21"/>
  </g>
</svg>`;

const FAVICON_URI = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;

const OG_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="bg" cx="50%" cy="40%" r="65%">
      <stop offset="0%" stop-color="#1a0820"/>
      <stop offset="100%" stop-color="#050508"/>
    </radialGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="618" width="1200" height="12" fill="#8b0000" opacity="0.8"/>
  <g transform="translate(90,130)" stroke="#cc2222" fill="none" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)" opacity="0.85">
    <circle cx="85" cy="52" r="38" stroke-width="13"/>
    <line x1="85" y1="90" x2="85" y2="275" stroke-width="13"/>
    <path d="M85 275 Q85 345 155 345 Q225 345 225 275" stroke-width="13"/>
    <line x1="225" y1="275" x2="178" y2="258" stroke-width="13"/>
  </g>
  <line x1="365" y1="175" x2="365" y2="455" stroke="#cc2222" stroke-width="1.5" stroke-opacity="0.25"/>
  <text x="410" y="265" font-family="'Segoe UI',Helvetica,Arial,sans-serif" font-size="82" font-weight="700" fill="#ffffff" letter-spacing="0">Dead by Daylight</text>
  <text x="414" y="355" font-family="'Segoe UI',Helvetica,Arial,sans-serif" font-size="62" font-weight="700" fill="#cc2222" letter-spacing="10">QUEUE BOT</text>
  <text x="416" y="428" font-family="'Segoe UI',Helvetica,Arial,sans-serif" font-size="28" fill="#555577" letter-spacing="4">Invite-only  •  Multi-channel  •  Free</text>
</svg>`;

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

function makeRateLimiter(maxAttempts, windowMs) {
  const map = new Map();
  function limiter(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    const entry = map.get(ip);
    if (entry && now < entry.resetAt) {
      if (entry.count >= maxAttempts) {
        return res.status(429).send(renderError('Too many attempts. Please wait and try again.'));
      }
      entry.count += 1;
    } else {
      map.set(ip, { count: 1, resetAt: now + windowMs });
    }
    next();
  }
  limiter._map = map;
  return limiter;
}

const onboardRateLimit = makeRateLimiter(5, 15 * 60 * 1000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function metaTags(baseUrl) {
  if (!baseUrl) return '';
  return `
  <meta property="og:type" content="website">
  <meta property="og:url" content="${baseUrl}">
  <meta property="og:title" content="Dead by Daylight Queue Bot — Enter the Fog">
  <meta property="og:description" content="Connect your Twitch channel to the Dead by Daylight Queue Bot. Invite-only, multi-channel, free.">
  <meta property="og:image" content="${baseUrl}/og-image.svg">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Dead by Daylight Queue Bot — Enter the Fog">
  <meta name="twitter:description" content="Connect your Twitch channel to the Dead by Daylight Queue Bot.">
  <meta name="twitter:image" content="${baseUrl}/og-image.svg">`;
}

// ---------------------------------------------------------------------------
// Public page rendering
// ---------------------------------------------------------------------------

function renderPage({ title, heading, headingColor = '#cc2222', body, botName, baseUrl = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="icon" type="image/svg+xml" href="${FAVICON_URI}">
  <link rel="apple-touch-icon" href="${FAVICON_URI}">${metaTags(baseUrl)}
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#080810;color:#c8c8d8;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background-image:radial-gradient(ellipse at top,#1a0a1a 0%,#080810 70%)}
    .card{background:rgba(20,10,25,.95);border:1px solid rgba(180,0,0,.3);border-radius:8px;padding:2.5rem;width:100%;max-width:440px;box-shadow:0 0 60px rgba(120,0,0,.2)}
    h1{font-size:1.6rem;color:${headingColor};margin-bottom:.4rem;letter-spacing:.05em}
    .sub{font-size:.9rem;color:#888;margin-bottom:2rem}
    label{display:block;font-size:.85rem;color:#aaa;margin-bottom:.4rem}
    input{width:100%;padding:.65rem .9rem;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:4px;color:#e8e8e8;font-size:.95rem;margin-bottom:1.2rem;outline:none;transition:border-color .2s}
    input:focus{border-color:rgba(180,0,0,.6)}
    button{width:100%;padding:.75rem;background:#8b0000;color:#fff;border:none;border-radius:4px;font-size:1rem;cursor:pointer;transition:background .2s}
    button:hover{background:#a00000}
    .steps{margin-top:1.8rem;padding-top:1.4rem;border-top:1px solid rgba(255,255,255,.06)}
    .steps p{font-size:.8rem;color:#666;margin-bottom:.5rem}
    .steps ol{font-size:.82rem;color:#888;padding-left:1.2rem;line-height:1.8}
    .steps code{background:rgba(255,255,255,.08);padding:.1rem .35rem;border-radius:3px;font-size:.82rem}
    .error{background:rgba(180,0,0,.15);border:1px solid rgba(180,0,0,.4);border-radius:4px;padding:.75rem 1rem;margin-bottom:1.2rem;color:#ff6666;font-size:.9rem}
    footer{margin-top:1.5rem;text-align:center;font-size:.75rem;color:#2a2a35}
    footer a{color:#333;text-decoration:none}
    footer a:hover{color:#666}
  </style>
</head>
<body>
  <div class="card">
    <h1>${heading}</h1>
    ${body(botName)}
  </div>
  <footer>
    Built by <a href="https://github.com/kamoras" target="_blank" rel="noopener">kamoras</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/kamoras/stream-tools/tree/main/apps/dbd-bot" target="_blank" rel="noopener">Open source on GitHub</a>
  </footer>
</body>
</html>`;
}

// Formats a command for display, handling prefixes with or without a trailing space.
// "!dbd " + "help" → "!dbd help"; "!dbd" + "help" → "!dbd help"; "!" + "help" → "!help"
function cmd(prefix, name) {
  const p = prefix.trimEnd();
  return p.length > 1 ? `${p} ${name}` : `${p}${name}`;
}

function renderLanding(botName, errorMsg, prefix, baseUrl) {
  return renderPage({
    title: 'Enter the Fog — Dead by Daylight Queue Bot',
    heading: 'Enter the Fog',
    botName,
    baseUrl,
    body: (bot) => `
      <p class="sub">Connect your Twitch channel to the Dead by Daylight Queue Bot</p>
      ${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}
      <form method="POST" action="/onboard">
        <label for="invite_code">Invite Code</label>
        <input type="text" id="invite_code" name="invite_code" placeholder="XXXX-XXXX" autocomplete="off" spellcheck="false" required>
        <label for="channel_name">Your Twitch Channel Name</label>
        <input type="text" id="channel_name" name="channel_name" placeholder="your_channel" autocomplete="off" spellcheck="false" required>
        <button type="submit">Join the Fog →</button>
      </form>
      <div class="steps">
        <p>After connecting:</p>
        <ol>
          <li>Go to your Twitch channel</li>
          <li>Type <code>/mod ${bot}</code> — recommended to avoid rate limiting</li>
          <li>Type <code>${cmd(prefix, 'help')}</code> in chat to see all commands</li>
        </ol>
      </div>`,
  });
}

function renderSuccess(botName, channelName, prefix) {
  return renderPage({
    title: "You're in the Fog!",
    heading: "You're in the Fog!",
    headingColor: '#33cc66',
    botName,
    body: (bot) => `
      <p class="sub">Channel <strong style="color:#fff">${channelName}</strong> is now connected.</p>
      <div class="steps" style="margin-top:1.5rem;padding-top:0;border:none">
        <p>Next steps:</p>
        <ol>
          <li>Go to your Twitch channel</li>
          <li>Type <code>/mod ${bot}</code> — recommended to avoid rate limiting</li>
          <li>Type <code>${cmd(prefix, 'help')}</code> to see all available commands</li>
        </ol>
      </div>`,
  });
}

function renderError(message) {
  return `<html><body style="font-family:sans-serif;background:#080810;color:#ff6666;display:flex;align-items:center;justify-content:center;height:100vh"><p>${message}</p></body></html>`;
}

// ---------------------------------------------------------------------------
// Main server factory
// ---------------------------------------------------------------------------

function createWebServer({
  botName,
  prefix = '!dbd ',
  domain = '',
  webhookSecret = '',
  onChannelAdded = async () => {},      // onboarding: join chat + subscribe to EventSub
  isConnected = () => true,
  onStreamOnline = () => {},
  onStreamOffline = () => {},
} = {}) {
  const baseUrl = domain ? `https://${domain}` : '';

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false }));

  // ── Public routes ──────────────────────────────────────────────────────────

  // ── Twitch EventSub webhook ────────────────────────────────────────────────
  // Uses express.raw() so we can verify the HMAC signature over the raw body.

  if (webhookSecret) {
    const { verifySignature } = require('./eventsub');

    // Replay protection: reject messages older than the tolerance and ignore
    // message IDs we've already processed (Twitch retries on non-2xx).
    const REPLAY_TOLERANCE_MS = 10 * 60 * 1000;
    const seenMessageIds = new Map(); // messageId -> expiresAt

    function isReplayedId(messageId) {
      const now = Date.now();
      if (seenMessageIds.size > 1000) {
        for (const [id, exp] of seenMessageIds) if (exp <= now) seenMessageIds.delete(id);
      }
      if ((seenMessageIds.get(messageId) ?? 0) > now) return true;
      seenMessageIds.set(messageId, now + REPLAY_TOLERANCE_MS);
      return false;
    }

    function isStaleTimestamp(timestamp) {
      const t = Date.parse(timestamp);
      if (Number.isNaN(t)) return false; // unparseable — let it through rather than drop a real event
      return Date.now() - t > REPLAY_TOLERANCE_MS;
    }

    app.post('/webhook/twitch', express.raw({ type: 'application/json' }), (req, res) => {
      const messageId = req.headers['twitch-eventsub-message-id'] ?? '';
      const timestamp = req.headers['twitch-eventsub-message-timestamp'] ?? '';
      const signature = req.headers['twitch-eventsub-message-signature'] ?? '';
      const messageType = req.headers['twitch-eventsub-message-type'] ?? '';

      recordWebhookReceived();

      if (!verifySignature(webhookSecret, messageId, timestamp, req.body.toString(), signature)) {
        recordWebhookRejected();
        return res.status(403).end();
      }

      recordWebhookVerified();

      // Signature is valid, but acknowledge (don't act on) stale or duplicate
      // deliveries so replays can't re-trigger joins/leaves.
      if (isStaleTimestamp(timestamp) || isReplayedId(messageId)) {
        return res.status(204).end();
      }

      let body;
      try {
        body = JSON.parse(req.body.toString());
      } catch {
        return res.status(400).end();
      }

      if (messageType === 'webhook_callback_verification') {
        return res.status(200).send(body.challenge);
      }

      if (messageType === 'revocation') {
        const sub = body.subscription || {};
        const who = sub.condition?.broadcaster_user_id || 'unknown';
        console.warn(`[web] EventSub subscription revoked — type=${sub.type} status=${sub.status} broadcaster=${who}`);
        recordWebhookEvent(who, 'revoked');
        return res.status(204).end();
      }

      if (messageType === 'notification') {
        const channel = body.event?.broadcaster_user_login;
        if (channel) {
          if (body.subscription?.type === 'stream.offline') {
            recordWebhookEvent(channel, 'offline');
            onStreamOffline(channel);
          } else if (body.subscription?.type === 'stream.online') {
            recordWebhookEvent(channel, 'online');
            onStreamOnline(channel);
          }
        }
      }

      res.status(204).end();
    });
  }

  app.get('/og-image.svg', (_req, res) => {
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(OG_IMAGE_SVG);
  });

  app.get('/', (_req, res) => {
    res.send(renderLanding(botName, null, prefix, baseUrl));
  });

  app.post('/onboard', onboardRateLimit, (req, res) => {
    const rawCode = (req.body.invite_code || '').trim();
    const rawChannel = (req.body.channel_name || '').trim().toLowerCase().replace(/^#/, '');

    if (!rawCode || !rawChannel) {
      return res.status(400).send(renderLanding(botName, 'Both fields are required.', prefix, baseUrl));
    }
    if (!/^[a-zA-Z0-9_]{3,25}$/.test(rawChannel)) {
      return res.status(400).send(renderLanding(botName, 'Invalid channel name. Use only letters, numbers, and underscores (3–25 characters).', prefix, baseUrl));
    }
    if (db.channelExists(rawChannel)) {
      return res.status(400).send(renderLanding(botName, 'This channel is already connected.', prefix, baseUrl));
    }
    const valid = db.validateAndUseCode(rawCode, rawChannel);
    if (!valid) {
      return res.status(400).send(renderLanding(botName, 'Invalid or already-used invite code.', prefix, baseUrl));
    }

    db.addChannel(rawChannel, rawChannel);
    Promise.resolve(onChannelAdded(rawChannel)).catch(err => {
      console.error(`[web] Failed to connect #${rawChannel}:`, err.message);
    });
    return res.send(renderSuccess(botName, rawChannel, prefix));
  });

  app.get('/health', (_req, res) => {
    const connected = isConnected();
    res
      .status(connected ? 200 : 503)
      .json({ status: connected ? 'ok' : 'disconnected', uptimeMs: Date.now() - START_TIME });
  });

  // The admin dashboard is a separate service (apps/admin) that reaches the
  // bot through its internal API (src/admin-api.js); nothing here.
  app.all('/admin/*path', (_req, res) => res.status(404).send(renderError('Not found.')));

  return app;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function _resetRateLimiterForTesting() {
  onboardRateLimit._map.clear();
}

/** Snapshot of EventSub webhook activity for the admin API. */
function getWebhookStats() {
  return { ...webhookStats, recentEvents: [...webhookStats.recentEvents] };
}

module.exports = { createWebServer, getWebhookStats, START_TIME, _resetRateLimiterForTesting };
