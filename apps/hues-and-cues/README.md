# Hues & Cues for Twitch

A colour-guessing party game in the style of _Hues and Cues_, played by your Twitch chat.

- **Streamers** sign up with a username and password. Their games and scores are saved to their
  account.
- **The streamer** draws a card, secretly picks one of its four colours and gives a one-word clue
  (then optionally a two-word clue) from a web control panel.
- **Chat** guesses the square by typing a coordinate such as `F12` (or `!guess F12`).
- **The stream** shows a live overlay — an OBS browser source with the board, clue, timer,
  guesses, results and a running leaderboard.

Viewers never need an account. No Twitch login, bot account or developer application is required
either, because the server reads public chat anonymously.

| Overlay (OBS browser source)                    | Control panel                                     |
| ----------------------------------------------- | ------------------------------------------------- |
| Board, clues, countdown, latest guesses, scores | Card picker, clue entry, round controls, settings |

## Quick start (local)

Requires Node.js 22.12+.

```bash
npm ci
npm run build
npm start            # http://localhost:8080
```

Open <http://localhost:8080>, create an account, enter your channel name, then copy the **overlay URL** into
OBS → _Sources_ → _Browser_ (width 1920, height 1080). The control panel's
**Test without chat** card lets you rehearse a round without anyone in chat.

For development with hot reload, run `npm run dev` and open <http://localhost:5173>.

## How a round works

1. **Draw a card** — four well-separated colours appear, visible only to you.
2. **Pick a colour** and enter a **one-word clue**. Guessing opens on stream.
3. Chat types coordinates. Each chatter gets one guess per clue (they may move it while guessing
   is open unless you disable that).
4. Guessing closes when the timer runs out or you close it. Give a **second clue** (up to two
   words) for a second guess, or reveal immediately.
5. **Reveal** — the target and its scoring frames appear on the board.

### Scoring

Each guess scores by its distance from the target, measured in squares (diagonals count as one):

| Guess position             | Points |
| -------------------------- | -----: |
| On the target              |      3 |
| In the 3×3 frame around it |      2 |
| In the 5×5 frame around it |      1 |

Both of a player's guesses score. The streamer earns one point for every guess inside the 3×3
frame — a good clue pays off.

### Settings (control panel)

| Setting                   | Default | Description                                          |
| ------------------------- | ------- | ---------------------------------------------------- |
| Guess timer               | 45 s    | `0` means guessing stays open until you close it     |
| Second clue               | on      | Adds the two-word clue and second guess              |
| Let chatters change guess | on      | Latest guess counts while guessing is open           |
| Require `!guess`          | off     | Ignore bare `F12` messages; only `!guess F12` counts |
| Enforce clue word limits  | on      | One word, then two                                   |

Accepted chat formats: `F12`, `f12`, `F 12`, `F-12`, `12F`, `!guess F12`, `!g F12`, `!hue F12`.

## Accounts

- Usernames are 3–24 letters, numbers, `_` or `-`, and are unique regardless of capitalisation.
- Passwords need at least 10 characters. Any characters are allowed, and passphrases are encouraged.
- Passwords are hashed with scrypt. Sign-ins use a server-side session in a `Secure`, `HttpOnly`,
  `SameSite=Lax` cookie that lasts 30 days from last use.
- Repeated failed sign-ins are rate-limited per IP and per account.
- Changing your password signs out every other device.
- Each account can run games for up to 5 channels. Only the owner can control a game; its overlay
  link is public and read-only so OBS needs no sign-in.

### Invite-only sign-up

Sign-up works like the dbd-bot's: it is invite-only. Invite codes come from the shared
[stream-tools admin dashboard](../admin/README.md), the same login as the bot's.

1. In the dashboard's **Hues & Cues** section, click **Generate Code**, optionally noting who it's
   for. Copy the code (`XXXX-XXXX-XXXX`) and send it to the streamer. It is shown only once; only a
   hash is stored.
2. The streamer enters it when creating their account. Each code works **once** and expires after
   14 days (`INVITE_TTL_DAYS`). Unused codes can be revoked.

The dashboard also lists every account with its sign-up date, last sign-in and channels. It talks to
this app through a small internal API (`src/server/http/internal-api.ts`) on `INTERNAL_API_PORT`.
That port is never exposed publicly, and every request needs the shared `INTERNAL_API_TOKEN`.

## Deployment

Hues & Cues is part of [stream-tools](../../README.md) and is deployed with the other apps to the
shared Oracle Cloud VM whenever its code changes on `main`. See
[docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) for setup, secrets (`HUES_DOMAIN`,
`HUES_ALLOWED_CHANNELS`, …) and operations.

A long-running server is required: the app holds a WebSocket connection to Twitch chat and pushes
live updates to the overlay, which serverless platforms such as Vercel cannot do.

### Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)):

| Variable              | Default  | Purpose                                                      |
| --------------------- | -------- | ------------------------------------------------------------ |
| `INTERNAL_API_TOKEN`  | —        | Enables the internal admin API for the dashboard (32+ chars) |
| `INTERNAL_API_PORT`   | `9000`   | Port of the internal admin API; never exposed publicly       |
| `INVITE_TTL_DAYS`     | `14`     | Days an unused invite code stays valid                       |
| `SESSION_TTL_DAYS`    | `30`     | Days a sign-in lasts without use                             |
| `ALLOWED_CHANNELS`    | —        | Comma-separated allow-list of Twitch channels                |
| `MAX_ROOMS_PER_USER`  | `5`      | Games per account                                            |
| `MAX_ROOMS`           | `500`    | Games per server                                             |
| `ROOM_RETENTION_DAYS` | `90`     | Unplayed games are deleted after this long                   |
| `DATA_DIR`            | `./data` | Location of the SQLite database (`hues.db`)                  |
| `PORT`                | `8080`   | HTTP port                                                    |
| `TRUST_PROXY`         | `false`  | Set behind a reverse proxy                                   |
| `COOKIE_SECURE`       | auto     | `Secure` cookies; on by default when `NODE_ENV=production`   |
| `LOG_LEVEL`           | `info`   | Pino log level                                               |

## Development

```bash
npm run dev            # server (tsx watch) + Vite dev server with proxy
npm run check          # format check, lint, typecheck, tests
npm run test:coverage  # tests with coverage thresholds
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## Project layout

```
src/
  shared/    Board geometry, colour generation, rules and the wire protocol (server + browser)
  server/    Fastify app, accounts & sessions, WebSocket gateway, game engine, rooms,
             Twitch chat client, SQLite persistence
  client/    Landing, sign-in, control panel and overlay pages (Vite, TypeScript, no framework)
test/        Vitest unit and integration tests
```

_Hues and Cues_ is a trademark of The Op Games. This is an unofficial fan project and is not
affiliated with or endorsed by The Op.
