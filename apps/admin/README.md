# stream-tools admin

One dashboard and one login for every app in [stream-tools](../../README.md).

| App                  | What you can do                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dead by Daylight bot | Bot status and uptime, **Connect via Twitch** for the chat login, single-use invite codes, connected channels with Join/Leave/Disconnect, webhook activity |
| Hues & Cues          | Single-use invite codes (with notes, expiry and revoke), every account with last sign-in and channels                                                      |

It lives at the bot's admin URL, `https://<DOMAIN>/admin/<ADMIN_PATH>`, so existing bookmarks and the
Twitch OAuth redirect URL keep working. Any other `/admin/*` URL returns 404.

## How it works

```
browser ──HTTPS──► Caddy ── /admin/* on DOMAIN ──► admin:8080
                                                     │  Bearer INTERNAL_API_TOKEN
                                     ┌───────────────┴───────────────┐
                                     ▼                               ▼
                         dbd-bot:9000 (internal)        hues-and-cues:9000 (internal)
```

- **One login.** Sign in with `ADMIN_PASSWORD`, which is compared in constant time and throttled
  after repeated failures. That creates an 8-hour session in an `HttpOnly`, `SameSite=Lax`,
  `__Host-` cookie. State-changing requests must come from the dashboard's own origin.
- **No app data lives here.** The dashboard calls each app's internal admin API server-side. Those
  ports are never routed by Caddy, so they are reachable only on the server's private Docker network,
  and every call needs `INTERNAL_API_TOKEN`. In production the token is generated once on the server
  (`env/internal.env`) and never leaves it.
- **Twitch chat login.** **Connect via Twitch** sends you to Twitch with a single-use state value.
  Twitch redirects back to `/admin/<ADMIN_PATH>/twitch-callback`, and the dashboard hands the code to
  the bot, which exchanges it using its client secret and restarts on the new login. The dashboard
  never sees the client secret.
- **Missing apps are fine.** If an app can't be reached, only its section shows an error.

## Configuration

| Variable             | Default                     | Purpose                                                             |
| -------------------- | --------------------------- | ------------------------------------------------------------------- |
| `ADMIN_PASSWORD`     | — (required)                | The one admin password                                              |
| `ADMIN_PATH`         | `admin`                     | Secret URL segment; the dashboard is `/admin/<ADMIN_PATH>/`         |
| `PUBLIC_URL`         | — (required)                | Origin the dashboard is served from, e.g. `https://bot.example.com` |
| `INTERNAL_API_TOKEN` | — (required, 32+ chars)     | Shared with each app's internal API                                 |
| `DBD_BOT_API_URL`    | `http://dbd-bot:9000`       | Bot's internal API                                                  |
| `HUES_API_URL`       | `http://hues-and-cues:9000` | Hues & Cues's internal API                                          |
| `PORT`               | `8080`                      | HTTP port                                                           |
| `TRUST_PROXY`        | `false`                     | Set behind Caddy (compose does this)                                |
| `COOKIE_SECURE`      | on in production            | `Secure` cookies                                                    |

In production these come from the existing `ADMIN_PASSWORD`, `ADMIN_PATH` and `DOMAIN` secrets; see
[docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md).

## Development

```bash
cp .env.example .env   # point *_API_URL at locally running apps with the same INTERNAL_API_TOKEN
npm ci
npm run dev            # builds the page, then serves it with auto-reload
npm run check          # format, lint, typecheck, tests
```

Then open `http://localhost:8080/admin/<ADMIN_PATH>/`.
