# Dead by Daylight Twitch Bot

[![CI](https://github.com/kamoras/stream-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/kamoras/stream-tools/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

> Part of [stream-tools](../../README.md). This page covers the bot itself; shared hosting and deployment are in [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md).

A Twitch chat bot for Dead by Daylight streamers. Manages a viewer queue for on-stream play sessions and includes DbD-themed commands.

One bot instance serves multiple streamers. Streamers self-onboard through an invite-only landing page — no manual config needed per channel.

## Features

- **Queue management** — viewers sign up, check their position, and leave at will
- **Role modes** — survivor is the default role; killer is opt-in (`!dbd join killer`)
- **Moderator controls** — open/close the queue, pick the next player(s), remove users
- **Live-only presence** — the bot joins a channel when its stream goes live and leaves (closing and clearing the queue) when it ends, via reconciliation polling with optional instant webhooks (requires Twitch app credentials)
- **Multi-channel** — one bot instance serves multiple streamers
- **Invite-only onboarding** — streamers self-connect via a landing page using single-use invite codes
- **Admin dashboard** — generate/revoke invite codes, monitor connected channels and live presence, manually join/leave, and watch webhook activity, in the shared [stream-tools admin dashboard](../admin/README.md)
- **DbD extras** — random killer, survivor, perk, map, and Entity messages
- **Free hosting** — runs on Oracle Cloud Always Free tier (no expiry; credit card required to sign up)
- **Auto-deploy** — GitHub Actions builds, pushes, and deploys whenever bot code changes on `main`
- **HTTPS** — served through the repository's shared Caddy reverse proxy with automatic Let's Encrypt TLS

---

## Commands

All commands use the `!dbd` prefix by default. Configurable via `BOT_PREFIX`.

### Everyone

| Command | Description |
|---------|-------------|
| `!dbd join` | Join the queue as survivor (default when `QUEUE_ROLES_MODE=both`) |
| `!dbd join killer` | Join the queue as killer |
| `!dbd leave` | Leave the queue |
| `!dbd queue` | Show the first 5 people in the queue |
| `!dbd position` | Check your spot in the queue |
| `!dbd killer` | Get a random killer |
| `!dbd survivor` | Get a random survivor |
| `!dbd perk [killer\|survivor]` | Get a random perk (optionally filtered by side) |
| `!dbd map` | Get a random map |
| `!dbd entity` | Hear from the Entity |
| `!dbd help` | Quick help — joining, leaving, and queue status |
| `!dbd help extended` | Full command reference including all mod commands and DbD extras |

### Moderators only

| Command | Description |
|---------|-------------|
| `!dbd open` | Open the queue |
| `!dbd close` | Close the queue and clear it (resets for the next session) |
| `!dbd pick [n]` | Call up the next person, or the next `n` people |
| `!dbd next` | Preview who's next without removing them |
| `!dbd remove <username>` | Remove a specific user from the queue |
| `!dbd clear` | Clear the queue without closing it |

---

## Configuration

All configuration is done via environment variables. In production these are set as GitHub Actions secrets and synced to the server on every deploy. For local development, copy `.env.example` to `.env`.

| Variable | Required | Default | Description |
|----------|:--------:|---------|-------------|
| `TWITCH_BOT_USERNAME` | ✅ | — | Twitch username of the bot account |
| `TWITCH_BOT_TOKEN` | ✅* | — | OAuth token for the bot, prefixed with `oauth:`. *Not required if `TWITCH_BOT_REFRESH_TOKEN` is set. |
| `TWITCH_BOT_REFRESH_TOKEN` | | — | One-time seed token that lets the bot refresh its own chat login forever instead of `TWITCH_BOT_TOKEN` expiring every few weeks. Requires `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET`. See below. |
| `DOMAIN` | ✅ | — | Your domain — Caddy uses this for TLS and the webhook URL |
| `INTERNAL_API_TOKEN` | | — | Enables the internal admin API used by the shared admin dashboard (generated on the server in production) |
| `INTERNAL_API_PORT` | | `9000` | Port of the internal admin API — never exposed publicly |
| `BOT_PREFIX` | | `!dbd ` | Command prefix (trailing space required for multi-word prefixes) |
| `BOT_JOIN_MESSAGE` | | themed default | Message the bot posts when it enters a channel's chat |
| `QUEUE_ROLES_MODE` | | `both` | `off` · `both` · `survivor` · `killer` |
| `QUEUE_MAX_SIZE` | | `20` | Maximum queue size |
| `PORT` | | `8080` | Internal port (Caddy proxies to this — do not expose publicly) |
| `DB_PATH` | | `./data/bot.db` | SQLite path inside the container (maps to `/opt/stream-tools/data/dbd-bot/bot.db` on host) |
| `TWITCH_CLIENT_ID` | | — | Twitch app Client ID — required for live-only presence |
| `TWITCH_CLIENT_SECRET` | | — | Twitch app Client Secret — required for live-only presence |
| `TWITCH_WEBHOOK_SECRET` | | — | Random string for EventSub signature verification (`openssl rand -hex 20`); enables instant webhook join/leave on top of polling |
| `STREAM_POLL_INTERVAL_MS` | | `90000` | How often to reconcile chat presence with live status (floored at 30000) |

### Getting a Twitch OAuth token

There are two ways to authenticate the bot's chat login. The token generated below (implicit grant) has no refresh token, so Twitch eventually expires it (in practice, anywhere from hours to a few weeks) and the bot's chat connection will start failing with `Login authentication failed` until you paste in a new one by hand.

**Quick / manual (`TWITCH_BOT_TOKEN`), expires eventually:**

1. Create a dedicated Twitch account for the bot.
2. Go to the [Twitch Developer Console](https://dev.twitch.tv/console) and register a new application.
3. Set the OAuth Redirect URL to `http://localhost`.
4. Construct the following URL (replacing `YOUR_CLIENT_ID`) and open it in a browser while logged in as the bot account:
   ```
   https://id.twitch.tv/oauth2/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost&response_type=token&scope=chat:read+chat:edit
   ```
5. Authorize the app. The browser redirects to `http://localhost` — copy the `access_token` from the URL bar.
6. Prefix it with `oauth:` when setting `TWITCH_BOT_TOKEN`.

**Self-refreshing, recommended:**

Once set up, the bot refreshes its own chat login before it expires and persists the rotated refresh token in the database (`data/bot.db`) — no more manual token regeneration.

Requires `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` from a [Twitch Developer Console](https://dev.twitch.tv/console) app. Add both `http://localhost` (for the quick/manual flow above) and `https://YOUR_DOMAIN/admin/YOUR_ADMIN_PATH/twitch-callback` to the app's OAuth Redirect URLs.

*Via the admin dashboard (easiest):* once `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` are set and the bot is deployed, open the [admin dashboard](../admin/README.md), sign in as the bot's Twitch account in the browser, and click **Connect via Twitch** in the bot's "Chat login" card. The dashboard hands the code to the bot, which exchanges it, stores the refresh token, and restarts itself to pick it up.

*Manually, if you'd rather not deploy first:*

1. Open this URL in a browser while logged in as the bot account (replacing `YOUR_CLIENT_ID`):
   ```
   https://id.twitch.tv/oauth2/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost&response_type=code&scope=chat:read+chat:edit
   ```
2. Authorize the app. The browser redirects to `http://localhost?code=...` — copy the `code` value.
3. Exchange it for a refresh token:
   ```bash
   curl -X POST https://id.twitch.tv/oauth2/token \
     -d client_id=YOUR_CLIENT_ID \
     -d client_secret=YOUR_CLIENT_SECRET \
     -d code=PASTE_CODE_HERE \
     -d grant_type=authorization_code \
     -d redirect_uri=http://localhost
   ```
4. Set `TWITCH_BOT_REFRESH_TOKEN` to the `refresh_token` from the response. `TWITCH_BOT_TOKEN` can be left unset.

---

## Local Development

```bash
# 1. Clone and install
git clone https://github.com/kamoras/stream-tools.git
cd stream-tools/apps/dbd-bot
npm install

# 2. Configure
cp .env.example .env
# Fill in at minimum: TWITCH_BOT_USERNAME, TWITCH_BOT_TOKEN

# 3. Run with auto-reload
npm run dev
```

The landing page is at `http://localhost:8080`. To use the admin dashboard locally, also set `INTERNAL_API_TOKEN` and run [apps/admin](../admin/README.md) pointed at the bot's internal port.

To onboard a test channel, generate a local invite code:

```bash
npm run invite
```

Then visit `http://localhost:8080`, enter the code and your channel name.

```bash
npm test        # Run unit tests
npm run lint    # Lint source files
npm start       # Production start (no auto-reload)
```

---

## Deployment

The bot is deployed with the rest of [stream-tools](../../README.md) to the shared Oracle Cloud VM. VM setup, how deploys work and troubleshooting are in [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md). The bot's own settings are GitHub Actions secrets:

| Secret | Required | Description |
|--------|:--------:|-------------|
| `TWITCH_BOT_USERNAME` | ✅ | Bot's Twitch username |
| `TWITCH_BOT_TOKEN` | ✅ | Bot's OAuth token (`oauth:...`) |
| `DOMAIN` | ✅ | The bot's domain (e.g. `bot.yourdomain.com`) |
| `QUEUE_ROLES_MODE` | | Defaults to `both` |
| `QUEUE_MAX_SIZE` | | Defaults to `20` |
| `BOT_PREFIX` | | Defaults to `!dbd ` (include the trailing space) |
| `TWITCH_CLIENT_ID` | | Enables stream-end auto-detection via EventSub |
| `TWITCH_CLIENT_SECRET` | | Enables stream-end auto-detection via EventSub |
| `TWITCH_WEBHOOK_SECRET` | | Random string — generate with `openssl rand -hex 20` |

On the server the bot runs as the `dbd-bot` container. Its SQLite database is at `/opt/stream-tools/data/dbd-bot/bot.db` and persists across deploys. To tail logs or back it up:

```bash
sudo docker logs -f dbd-bot
sudo sqlite3 /opt/stream-tools/data/dbd-bot/bot.db ".backup /tmp/dbd-bot-backup.db"
```

### Onboard a channel

1. Visit the admin dashboard at `https://YOUR_DOMAIN/admin/YOUR_ADMIN_PATH` and sign in.
2. In the bot's **Invite codes** card, click **Generate Code** — the code is shown only to you, never in any log.
3. Share the code with the streamer.
4. They visit `https://YOUR_DOMAIN`, enter the code and their channel name.
5. Recommended: they type `/mod YOUR_BOT_USERNAME` in their chat to give the bot moderator status (prevents Twitch rate-limiting the bot's messages).

---

## Admin Dashboard

The bot has no admin pages of its own. It is managed from the shared [stream-tools admin dashboard](../admin/README.md) at `https://YOUR_DOMAIN/admin/YOUR_ADMIN_PATH` (one login for every app), which provides for the bot:

- **Bot status** — connection state, uptime, active channel count, current prefix
- **Invite codes** — generate single-use codes; revoke any pending code before it's used
- **Connected channels** — all onboarded channels with queue size, open/closed state, and whether the bot is currently in chat; per-channel **Join**/**Leave** (manual presence override) and **Disconnect** buttons
- **Webhook activity** — EventSub delivery stats (received, rejected) and a log of recent stream-start, stream-end, and subscription-revoked events

The dashboard reaches the bot through a small internal JSON API (`src/admin-api.js`) on port 9000. It is only reachable on the server's private Docker network and requires the shared `INTERNAL_API_TOKEN`.

---

## Live-Only Presence

The bot joins a channel's chat only while its stream is live and leaves (closing and clearing the queue) when it ends. This works in two complementary layers:

- **Reconciliation polling (backbone).** With `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` set, the bot polls Twitch every `STREAM_POLL_INTERVAL_MS` (default 90s) for who's live, then joins live channels it isn't in and leaves connected channels that are no longer live. This is self-healing — it works without a public URL and recovers from any missed event.
- **Webhooks (instant, optional).** Additionally setting `TWITCH_WEBHOOK_SECRET` and `DOMAIN` lets the bot subscribe to the EventSub `stream.online` / `stream.offline` events for instant join/leave instead of waiting for the next poll. The webhook endpoint is `https://YOUR_DOMAIN/webhook/twitch`; Twitch verifies ownership during subscription setup, so the HTTPS endpoint provided by Caddy is required. Deliveries are signature-verified, and replayed or stale deliveries are ignored.

Correctness never depends on webhook delivery: webhooks only reduce latency, and the poll reconciles state on every cycle, so a missed or undelivered webhook is self-corrected within one interval. The two layers are intentionally redundant.

On `stream.offline` (or when a poll finds a channel no longer live) the queue is closed and cleared and the bot posts a message before leaving. Disconnecting a channel from the admin dashboard also removes its EventSub subscriptions, and the dashboard has manual **Join**/**Leave** buttons to override presence when needed.

Without any Twitch credentials, the bot can't tell who's live and falls back to permanently sitting in every connected channel.

---

## GitHub Actions Workflows

CI and deployment are shared across the repository; see the [root README](../../README.md#ci-and-deployment). `invite.yml` (manual only) is a bot-specific emergency fallback that generates an invite code on the server — use the admin dashboard instead; the Actions log never shows the code.

---

## Keeping DbD data up to date

Killers, survivors, perks, and maps live in `src/data/` and are community-maintained. Please open a PR when new chapters are released. Use the **DbD Data Update** issue template.

---

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for setup instructions, coding standards, commit conventions, and the PR process.

---

## License

[MIT](../../LICENSE) — free to use, modify, and distribute.
