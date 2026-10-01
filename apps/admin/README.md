# stream-tools admin

One dashboard and one login for every app in [stream-tools](../../README.md).

| App                  | What you can do                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dead by Daylight bot | Bot status and uptime, **Connect via Twitch** for the chat login, single-use invite codes, connected channels with Join/Leave/Disconnect, webhook activity |
| Hues & Cues          | Single-use invite codes (with notes, expiry and revoke), every account with last sign-in and channels                                                      |

It lives at `https://<ADMIN_DOMAIN>/admin/<ADMIN_PATH>` when the optional `ADMIN_DOMAIN` secret is
set (the old URL on the bot's domain then redirects there), and otherwise at the bot's admin URL,
`https://<DOMAIN>/admin/<ADMIN_PATH>`. Old bookmarks keep working either way; with `ADMIN_DOMAIN`,
add the new Twitch OAuth redirect URL as described in
[docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md). Any other `/admin/*` URL returns 404.

## How it works

```
browser ──HTTPS──► Caddy ── /admin/* on ADMIN_DOMAIN ──► admin:8080
                                                     │  Bearer <that app's token>
                                     ┌───────────────┴───────────────┐
                                     ▼                               ▼
                         dbd-bot:9000 (internal)        hues-and-cues:9000 (internal)
```

- **One login.** Sign in with `ADMIN_PASSWORD`, which is compared in constant time and throttled
  after repeated failures. That creates an 8-hour session in an `HttpOnly`, `SameSite=Lax`,
  `__Host-` cookie. State-changing requests must come from the dashboard's own origin.
- **No app data lives here.** The dashboard calls each app's internal admin API server-side. Those
  ports are never routed by Caddy, so they are reachable only on the server's private Docker network,
  and every call needs that app's own token, so one compromised app can't use another's API. In
  production the tokens are generated once on the server (`env/internal-<app>.env`) and never
  leave it.
- **Twitch chat login.** **Connect via Twitch** sends you to Twitch with a single-use state value.
  Twitch redirects back to `/admin/<ADMIN_PATH>/twitch-callback`, and the dashboard hands the code to
  the bot, which exchanges it using its client secret and restarts on the new login. The dashboard
  never sees the client secret.
- **Missing apps are fine.** If an app can't be reached, only its section shows an error.

## Configuration

| Variable            | Default                     | Purpose                                                             |
| ------------------- | --------------------------- | ------------------------------------------------------------------- |
| `ADMIN_PASSWORD`    | — (required)                | The one admin password                                              |
| `ADMIN_PATH`        | `admin`                     | Secret URL segment; the dashboard is `/admin/<ADMIN_PATH>/`         |
| `PUBLIC_URL`        | — (required)                | Origin the dashboard is served from, e.g. `https://bot.example.com` |
| `DBD_BOT_API_TOKEN` | — (required, 32+ chars)     | The bot's `INTERNAL_API_TOKEN`                                      |
| `DBD_BOT_API_URL`   | `http://dbd-bot:9000`       | Bot's internal API                                                  |
| `HUES_API_TOKEN`    | — (required, 32+ chars)     | Hues & Cues's `INTERNAL_API_TOKEN`                                  |
| `HUES_API_URL`      | `http://hues-and-cues:9000` | Hues & Cues's internal API                                          |
| `PORT`              | `8080`                      | HTTP port                                                           |
| `TRUST_PROXY`       | `false`                     | Set behind Caddy (compose does this)                                |
| `COOKIE_SECURE`     | on in production            | `Secure` cookies                                                    |

In production these come from the `ADMIN_PASSWORD`, `ADMIN_PATH` and `ADMIN_DOMAIN` (or `DOMAIN`) secrets; see
[docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md).

## Development

```bash
cp .env.example .env   # matches the apps' .env.example tokens and ports
npm ci
npm run dev            # builds the page, then serves it with auto-reload
npm run check          # format, lint, typecheck, tests
```

Then open `http://localhost:8081/admin/local-admin/` (`PORT` and `ADMIN_PATH` from `.env`). Run the
bot and Hues & Cues from their own directories (with their `.env.example` copied to `.env`) to see
their sections; Connect via Twitch also needs `http://localhost:8081/admin/local-admin/twitch-callback`
registered as a redirect URL on your Twitch app.
