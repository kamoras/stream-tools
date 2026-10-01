'use strict';

const crypto = require('crypto');
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

const EVENT_LABELS = {
  online: 'Stream started',
  offline: 'Stream ended',
  revoked: 'Subscription revoked',
};

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
// Session management (in-memory, 8-hour TTL)
// ---------------------------------------------------------------------------

const sessions = new Map(); // token -> expiresAt

function createSession() {
  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
  return token;
}

function isValidSession(token) {
  if (!token || !sessions.has(token)) return false;
  if (Date.now() > sessions.get(token)) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function getSessionToken(req) {
  const raw = req.headers.cookie || '';
  const pair = raw.split(';').map(s => s.trim()).find(s => s.startsWith('admin_session='));
  return pair ? decodeURIComponent(pair.split('=').slice(1).join('=')) : null;
}

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
const adminRateLimit = makeRateLimiter(3, 15 * 60 * 1000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function formatTimeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatDate(sqliteDate) {
  return new Date(sqliteDate.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

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
    <a href="https://github.com/kamoras/dead-by-daylight-twitch-bot" target="_blank" rel="noopener">Open source on GitHub</a>
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
// Admin page rendering
// ---------------------------------------------------------------------------

const ADMIN_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#080810;color:#c8c8d8;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;background-image:radial-gradient(ellipse at top,#1a0a1a 0%,#080810 70%)}
  a{color:inherit;text-decoration:none}
  .wrap{max-width:960px;margin:0 auto;padding:1.5rem}
  .header{display:flex;align-items:center;justify-content:space-between;margin-bottom:2rem;padding-bottom:1rem;border-bottom:1px solid rgba(255,255,255,.07)}
  .header-left{display:flex;align-items:center;gap:.75rem}
  .header h1{font-size:1rem;color:#666;font-weight:400;letter-spacing:.06em;text-transform:uppercase}
  .header-right{font-size:.8rem;color:#444}
  .header-right a:hover{color:#888}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem}
  .card{background:rgba(20,10,25,.95);border:1px solid rgba(180,0,0,.2);border-radius:8px;padding:1.4rem}
  .card.full{grid-column:1/-1}
  .card h2{font-size:.72rem;text-transform:uppercase;letter-spacing:.12em;color:#444;margin-bottom:1.1rem}
  .stat{display:flex;align-items:center;gap:.55rem;margin-bottom:.55rem;font-size:.88rem;color:#999}
  .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .dot.ok{background:#33cc66}
  .dot.err{background:#cc3333}
  .stat strong{color:#ccc}
  .code-box{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:1.1rem;text-align:center;margin-bottom:1rem}
  .code-box span{font-family:monospace;font-size:1.7rem;letter-spacing:.2em;color:#fff}
  .code-note{font-size:.75rem;color:#555;text-align:center;margin-bottom:1rem}
  .btn{width:100%;padding:.6rem;background:#8b0000;color:#fff;border:none;border-radius:4px;font-size:.9rem;cursor:pointer;transition:background .2s}
  .btn:hover{background:#a00000}
  .btn.secondary{background:transparent;border:1px solid rgba(255,255,255,.1);color:#666;font-size:.8rem;margin-top:.5rem}
  .btn.secondary:hover{color:#999;border-color:rgba(255,255,255,.2)}
  table{width:100%;border-collapse:collapse;font-size:.83rem}
  thead th{text-align:left;color:#444;font-weight:400;font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;padding:.35rem .6rem;border-bottom:1px solid rgba(255,255,255,.06)}
  tbody td{padding:.5rem .6rem;color:#888;border-bottom:1px solid rgba(255,255,255,.04)}
  tbody td:first-child{color:#bbb}
  tbody tr:last-child td{border-bottom:none}
  .badge{display:inline-block;padding:.15rem .45rem;border-radius:3px;font-size:.72rem;letter-spacing:.04em}
  .badge.open{background:rgba(51,204,102,.12);color:#33cc66}
  .badge.closed{background:rgba(200,50,50,.12);color:#cc5555}
  .badge.live{background:rgba(51,204,102,.12);color:#33cc66}
  .badge.absent{background:rgba(120,120,140,.1);color:#777}
  .empty{color:#444;font-size:.85rem;padding:.5rem 0}
  .btn-revoke{background:transparent;border:1px solid rgba(180,0,0,.25);color:#994444;padding:.2rem .55rem;border-radius:3px;cursor:pointer;font-size:.72rem;transition:all .15s}
  .btn-revoke:hover{background:rgba(180,0,0,.1);border-color:#cc3333;color:#cc5555}
  .btn-act{background:transparent;border:1px solid rgba(255,255,255,.12);color:#888;padding:.2rem .55rem;border-radius:3px;cursor:pointer;font-size:.72rem;transition:all .15s;margin-right:.3rem}
  .btn-act:hover{border-color:rgba(255,255,255,.3);color:#ccc}
  .btn-act.join{border-color:rgba(51,204,102,.3);color:#4a9a6a}
  .btn-act.join:hover{background:rgba(51,204,102,.08);color:#33cc66}
  .login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh}
  .login-card{background:rgba(20,10,25,.95);border:1px solid rgba(180,0,0,.3);border-radius:8px;padding:2.5rem;width:100%;max-width:380px}
  .login-card h1{font-size:1.4rem;color:#888;margin-bottom:.4rem;letter-spacing:.05em}
  .login-card .sub{font-size:.85rem;color:#555;margin-bottom:1.8rem}
  label{display:block;font-size:.82rem;color:#888;margin-bottom:.35rem}
  input[type=password]{width:100%;padding:.6rem .85rem;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:4px;color:#e8e8e8;font-size:.9rem;margin-bottom:1.1rem;outline:none;transition:border-color .2s}
  input[type=password]:focus{border-color:rgba(180,0,0,.6)}
  .error-msg{background:rgba(180,0,0,.12);border:1px solid rgba(180,0,0,.3);border-radius:4px;padding:.65rem .9rem;margin-bottom:1rem;color:#ff6666;font-size:.85rem}
  @media(max-width:580px){
    .wrap{padding:1rem}
    .grid{grid-template-columns:1fr}
    .card{padding:1.1rem}
    .header{margin-bottom:1.25rem}
    .header h1{font-size:.8rem;line-height:1.3}
    /* Stacked-card tables: each row becomes a labelled card instead of overflowing. */
    table,tbody,tr,td{display:block;width:100%}
    thead{display:none}
    tbody tr{border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:.35rem .85rem;margin-bottom:.7rem}
    tbody tr:last-child{margin-bottom:0}
    tbody td{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.45rem 0;border-bottom:1px solid rgba(255,255,255,.05);color:#aaa}
    tbody tr td:last-child{border-bottom:none}
    tbody td:first-child{color:#fff;font-weight:600}
    tbody td::before{content:attr(data-label);color:#555;font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;flex-shrink:0}
    tbody td.actions{justify-content:flex-end;flex-wrap:wrap;gap:.5rem;padding-top:.65rem}
    tbody td.actions::before{display:none}
    .btn-act,.btn-revoke{margin:0;padding:.45rem .85rem;font-size:.8rem}
  }`;

function renderLoginPage(adminPath, errorMsg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — Dead by Daylight Queue Bot</title>
  <link rel="icon" type="image/svg+xml" href="${FAVICON_URI}">
  <style>${ADMIN_CSS}</style>
</head>
<body>
  <div class="login-wrap">
    <div class="login-card">
      <h1>Command Centre</h1>
      <p class="sub">Sign in to manage the bot</p>
      ${errorMsg ? `<div class="error-msg">${errorMsg}</div>` : ''}
      <form method="POST" action="/admin/${adminPath}/login">
        <label for="pw">Password</label>
        <input type="password" id="pw" name="password" autocomplete="current-password" autofocus required>
        <button class="btn" type="submit">Sign in →</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

function renderDashboard({ adminPath, botName, connected, uptimeMs, channels, channelStatsMap, joinedChannels, pendingCodes, generatedCode, prefix, webhook, chatSelfRefreshing, twitchConfigured }) {
  const joinedSet = new Set(joinedChannels);
  const pendingRows = pendingCodes.map(c => `<tr>
    <td data-label="Code" style="font-family:monospace;letter-spacing:.08em">${c.code}</td>
    <td data-label="Created">${formatDate(c.created_at)}</td>
    <td class="actions">
      <form method="POST" action="/admin/${adminPath}/revoke" style="margin:0">
        <input type="hidden" name="id" value="${c.id}">
        <button class="btn-revoke" type="submit">Revoke</button>
      </form>
    </td>
  </tr>`).join('');
  const rows = channels.map(ch => {
    const stats = channelStatsMap.get(ch.channel_name) || { size: 0, isOpen: true };
    const badge = stats.isOpen
      ? '<span class="badge open">Open</span>'
      : '<span class="badge closed">Closed</span>';
    const present = joinedSet.has(ch.channel_name);
    const presenceBadge = present
      ? '<span class="badge live">In chat</span>'
      : '<span class="badge absent">Not in chat</span>';
    // Manual override: Join when absent, Leave when present, plus permanent Disconnect.
    const presenceBtn = present
      ? `<form method="POST" action="/admin/${adminPath}/leave" style="display:inline;margin:0">
          <input type="hidden" name="channel" value="${ch.channel_name}">
          <button class="btn-act" type="submit">Leave</button>
        </form>`
      : `<form method="POST" action="/admin/${adminPath}/join" style="display:inline;margin:0">
          <input type="hidden" name="channel" value="${ch.channel_name}">
          <button class="btn-act join" type="submit">Join</button>
        </form>`;
    return `<tr>
      <td data-label="Channel">#${ch.channel_name}</td>
      <td data-label="Connected since">${formatDate(ch.added_at)}</td>
      <td data-label="In queue">${stats.size}</td>
      <td data-label="Queue">${badge}</td>
      <td data-label="Bot">${presenceBadge}</td>
      <td class="actions">
        ${presenceBtn}
        <form method="POST" action="/admin/${adminPath}/disconnect" style="display:inline;margin:0">
          <input type="hidden" name="channel" value="${ch.channel_name}">
          <button class="btn-revoke" type="submit">Disconnect</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — Dead by Daylight Queue Bot</title>
  <link rel="icon" type="image/svg+xml" href="${FAVICON_URI}">
  <meta http-equiv="refresh" content="60">
  <style>${ADMIN_CSS}</style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="header-left">
        <div class="dot ${connected ? 'ok' : 'err'}"></div>
        <h1>Dead by Daylight Queue Bot &nbsp;/&nbsp; Admin</h1>
      </div>
      <div class="header-right">
        <a href="/admin/${adminPath}/logout">Sign out</a>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Bot Status</h2>
        <div class="stat">
          <span class="dot ${connected ? 'ok' : 'err'}"></span>
          <span>${connected ? '<strong>Connected</strong>' : '<strong style="color:#cc3333">Disconnected</strong>'} as ${botName}</span>
        </div>
        <div class="stat">Uptime: <strong>${formatUptime(uptimeMs)}</strong></div>
        <div class="stat">Channels: <strong>${channels.length}</strong></div>
        <div class="stat">Pending invite codes: <strong>${pendingCodes.length}</strong></div>
        <div class="stat">Command prefix: <strong style="font-family:monospace">${cmd(prefix, '…')}</strong></div>
        <div class="stat" style="margin-top:.75rem;font-size:.72rem;color:#333">Auto-refreshes every 60s</div>
      </div>

      <div class="card">
        <h2>Invite Code</h2>
        ${generatedCode ? `
        <div class="code-box"><span>${generatedCode}</span></div>
        <p class="code-note">Single-use. Share this with your streamer.</p>
        ` : ''}
        <form method="POST" action="/admin/${adminPath}/invite">
          <button class="btn" type="submit">${generatedCode ? 'Generate Another →' : 'Generate Invite Code →'}</button>
        </form>
      </div>
    </div>

    <div class="card full">
      <h2>Chat Login</h2>
      ${chatSelfRefreshing
        ? `<div class="stat"><span class="dot ok"></span><span>Self-refreshing — the bot renews its own Twitch chat login automatically, no manual token needed.</span></div>`
        : twitchConfigured
          ? `<p class="code-note" style="text-align:left;margin:0 0 .9rem">The bot's chat login (<code style="font-size:.8rem">TWITCH_BOT_TOKEN</code>) can expire and needs manual replacement when it does. Connect once via Twitch to make it self-refreshing instead.</p>
             <a class="btn" style="display:inline-block;text-decoration:none;width:auto;padding:.6rem 1.2rem" href="/admin/${adminPath}/twitch-connect">Connect via Twitch →</a>`
          : `<p class="empty">Set <code style="font-size:.8rem">TWITCH_CLIENT_ID</code> and <code style="font-size:.8rem">TWITCH_CLIENT_SECRET</code> to enable a self-refreshing chat login.</p>`}
    </div>

    <div class="card full">
      <h2>Connected Channels</h2>
      ${channels.length === 0
        ? '<p class="empty">No channels connected yet. Generate an invite code and share it with a streamer.</p>'
        : `<table>
            <thead><tr><th>Channel</th><th>Connected since</th><th>In queue</th><th>Queue</th><th>Bot</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
    </div>

    <div class="card full">
      <h2>Pending Invite Codes</h2>
      ${pendingCodes.length === 0
        ? '<p class="empty">No pending codes.</p>'
        : `<table>
            <thead><tr><th>Code</th><th>Created</th><th></th></tr></thead>
            <tbody>${pendingRows}</tbody>
          </table>`}
    </div>

    <div class="card full">
      <h2>Webhook Activity</h2>
      ${!webhook.enabled
        ? `<p class="empty">Webhooks not configured — set <code style="font-size:.8rem">TWITCH_CLIENT_ID</code>, <code style="font-size:.8rem">TWITCH_CLIENT_SECRET</code>, <code style="font-size:.8rem">TWITCH_WEBHOOK_SECRET</code> and <code style="font-size:.8rem">DOMAIN</code> for instant join/leave. Live-only presence still works via polling with just the client credentials.</p>`
        : `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:.75rem;margin-bottom:1.25rem">
            <div style="background:rgba(255,255,255,.03);border-radius:6px;padding:.9rem;text-align:center">
              <div style="font-size:1.6rem;font-weight:700;color:#fff">${webhook.received}</div>
              <div style="font-size:.72rem;color:#555;margin-top:.2rem;text-transform:uppercase;letter-spacing:.08em">Received</div>
            </div>
            <div style="background:rgba(200,50,50,.06);border-radius:6px;padding:.9rem;text-align:center">
              <div style="font-size:1.6rem;font-weight:700;color:#cc3333">${webhook.rejected}</div>
              <div style="font-size:.72rem;color:#555;margin-top:.2rem;text-transform:uppercase;letter-spacing:.08em">Rejected</div>
            </div>
            <div style="background:rgba(51,204,102,.06);border-radius:6px;padding:.9rem;text-align:center">
              <div style="font-size:1.6rem;font-weight:700;color:#33cc66">${webhook.online}</div>
              <div style="font-size:.72rem;color:#555;margin-top:.2rem;text-transform:uppercase;letter-spacing:.08em">Stream Starts</div>
            </div>
            <div style="background:rgba(255,255,255,.03);border-radius:6px;padding:.9rem;text-align:center">
              <div style="font-size:1.6rem;font-weight:700;color:#fff">${webhook.offline}</div>
              <div style="font-size:.72rem;color:#555;margin-top:.2rem;text-transform:uppercase;letter-spacing:.08em">Stream Ends</div>
            </div>
            <div style="background:rgba(220,140,40,.06);border-radius:6px;padding:.9rem;text-align:center">
              <div style="font-size:1.6rem;font-weight:700;color:${webhook.revoked ? '#e0902a' : '#fff'}">${webhook.revoked}</div>
              <div style="font-size:.72rem;color:#555;margin-top:.2rem;text-transform:uppercase;letter-spacing:.08em">Revoked</div>
            </div>
          </div>
          <div class="stat" style="margin-bottom:1rem">Last received: <strong>${formatTimeAgo(webhook.lastReceivedAt)}</strong></div>
          ${webhook.recentEvents.length === 0
            ? '<p class="empty">No events received yet.</p>'
            : `<table>
                <thead><tr><th>Channel</th><th>Event</th><th>When</th></tr></thead>
                <tbody>
                  ${webhook.recentEvents.map(e => `<tr><td data-label="Channel">#${e.channel}</td><td data-label="Event">${EVENT_LABELS[e.type] || e.type}</td><td data-label="When">${formatTimeAgo(e.time)}</td></tr>`).join('')}
                </tbody>
              </table>`}
        `}
    </div>
  </div>
</body>
</html>`;
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
  onChannelRemoved = async () => {},    // disconnect: leave chat + remove EventSub subs
  joinChannel = async () => {},         // raw manual join (no DB / subscription change)
  leaveChannel = async () => {},        // raw manual leave (no DB / subscription change)
  isConnected = () => true,
  getChannelStats = () => [],
  getJoinedChannels = () => [],
  onStreamOnline = () => {},
  onStreamOffline = () => {},
  twitchClientId = '',
  twitchClientSecret = '',
  chatSelfRefreshing = false,
  restartToApplyAuth = () => {},
} = {}) {
  const baseUrl = domain ? `https://${domain}` : '';
  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminPath = process.env.ADMIN_PATH || 'admin';

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

  // ── Admin routes ───────────────────────────────────────────────────────────
  // 404 everything if admin is not configured.

  if (!adminPassword) {
    app.all(`/admin/*path`, (_req, res) => res.status(404).send(renderError('Not found.')));
  } else {
    function buildDashboard(req, res, generatedCode = null) {
      const statsMap = new Map(getChannelStats().map(s => [s.channel, s]));
      return res.send(renderDashboard({
        adminPath,
        botName,
        prefix,
        connected: isConnected(),
        uptimeMs: Date.now() - START_TIME,
        channels: db.getChannelList(),
        channelStatsMap: statsMap,
        joinedChannels: getJoinedChannels(),
        pendingCodes: db.getPendingCodes(),
        generatedCode,
        webhook: { enabled: !!webhookSecret, ...webhookStats },
        chatSelfRefreshing,
        twitchConfigured: !!(twitchClientId && twitchClientSecret),
      }));
    }

    function requireAuth(req, res, next) {
      if (isValidSession(getSessionToken(req))) return next();
      res.redirect(302, `/admin/${adminPath}`);
    }

    app.get(`/admin/${adminPath}`, (req, res) => {
      if (isValidSession(getSessionToken(req))) return buildDashboard(req, res);
      res.send(renderLoginPage(adminPath));
    });

    app.post(`/admin/${adminPath}/login`, adminRateLimit, (req, res) => {
      if (req.body.password !== adminPassword) {
        return res.status(401).send(renderLoginPage(adminPath, 'Incorrect password.'));
      }
      const token = createSession();
      res.set('Set-Cookie', `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
      res.redirect(302, `/admin/${adminPath}`);
    });

    // Lets an admin authorize the bot's Twitch chat login from the browser
    // instead of manually running curl commands (see README). Only available
    // once TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET are configured, since the
    // code exchange needs them.
    if (twitchClientId && twitchClientSecret) {
      const { exchangeAuthCode } = require('./eventsub');
      // CSRF guard for the Twitch redirect — short-lived, single-use.
      const pendingStates = new Map(); // state -> expiresAt
      const twitchCallbackUrl = `${baseUrl}/admin/${adminPath}/twitch-callback`;

      app.get(`/admin/${adminPath}/twitch-connect`, requireAuth, (_req, res) => {
        const state = crypto.randomBytes(16).toString('hex');
        pendingStates.set(state, Date.now() + 10 * 60 * 1000);
        const params = new URLSearchParams({
          client_id: twitchClientId,
          redirect_uri: twitchCallbackUrl,
          response_type: 'code',
          scope: 'chat:read chat:edit',
          state,
        });
        res.redirect(302, `https://id.twitch.tv/oauth2/authorize?${params}`);
      });

      app.get(`/admin/${adminPath}/twitch-callback`, requireAuth, async (req, res) => {
        const { code, state, error, error_description: errorDescription } = req.query;
        const expiresAt = pendingStates.get(state);
        pendingStates.delete(state);

        if (error) {
          return res.status(400).send(renderError(`Twitch declined: ${errorDescription || error}`));
        }
        if (!state || !expiresAt || Date.now() > expiresAt) {
          return res.status(400).send(renderError('This authorization link expired or was already used — go back to the admin dashboard and try again.'));
        }
        if (!code) {
          return res.status(400).send(renderError('Missing authorization code.'));
        }

        try {
          const data = await exchangeAuthCode({
            code, clientId: twitchClientId, clientSecret: twitchClientSecret, redirectUri: twitchCallbackUrl,
          });
          db.setSetting('twitch_refresh_token', data.refresh_token);
          res.send(renderError('Connected! The bot is restarting to apply the new chat login — refresh the admin dashboard in a few seconds.'));
          restartToApplyAuth();
        } catch (err) {
          console.error('[web] Twitch code exchange failed:', err.message);
          res.status(500).send(renderError('Failed to connect — check server logs.'));
        }
      });
    }

    app.post(`/admin/${adminPath}/invite`, requireAuth, (req, res) => {
      const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
      const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      db.createInviteCode(code);
      buildDashboard(req, res, code);
    });

    app.post(`/admin/${adminPath}/revoke`, requireAuth, (req, res) => {
      const id = parseInt(req.body.id, 10);
      if (!isNaN(id)) db.deleteInviteCode(id);
      res.redirect(302, `/admin/${adminPath}`);
    });

    // Pulls a normalised, validated channel name from the request, or null.
    function validChannel(req) {
      const channel = (req.body.channel || '').trim().toLowerCase().replace(/^#/, '');
      return /^[a-z0-9_]{3,25}$/.test(channel) ? channel : null;
    }

    app.post(`/admin/${adminPath}/disconnect`, requireAuth, (req, res) => {
      const channel = validChannel(req);
      if (channel) {
        db.removeChannel(channel);
        Promise.resolve(onChannelRemoved(channel)).catch(err => {
          console.error(`[web] Failed to disconnect #${channel}:`, err.message);
        });
      }
      res.redirect(302, `/admin/${adminPath}`);
    });

    // Manual presence override — join/leave the channel's chat without changing
    // its connection or EventSub subscriptions. Useful when webhooks lag.
    app.post(`/admin/${adminPath}/join`, requireAuth, (req, res) => {
      const channel = validChannel(req);
      if (channel && db.channelExists(channel)) {
        Promise.resolve(joinChannel(channel)).catch(err => {
          console.error(`[web] Manual join failed for #${channel}:`, err.message);
        });
      }
      res.redirect(302, `/admin/${adminPath}`);
    });

    app.post(`/admin/${adminPath}/leave`, requireAuth, (req, res) => {
      const channel = validChannel(req);
      if (channel) {
        Promise.resolve(leaveChannel(channel)).catch(err => {
          console.error(`[web] Manual leave failed for #${channel}:`, err.message);
        });
      }
      res.redirect(302, `/admin/${adminPath}`);
    });

    app.get(`/admin/${adminPath}/logout`, (req, res) => {
      const token = getSessionToken(req);
      if (token) sessions.delete(token);
      res.set('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      res.redirect(302, `/admin/${adminPath}`);
    });

    // Block requests to /admin/*path that don't match the secret path
    app.all('/admin/*path', (_req, res) => res.status(404).send(renderError('Not found.')));
  }

  return app;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function _resetRateLimiterForTesting() {
  onboardRateLimit._map.clear();
  adminRateLimit._map.clear();
}

module.exports = { createWebServer, _resetRateLimiterForTesting };
