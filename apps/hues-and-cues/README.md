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
npm run invite       # prints a single-use invite code
npm run build
npm start            # http://localhost:8080
```

Sign-up is invite-only. In production codes come from the shared admin dashboard
([apps/admin](../admin)); locally, `npm run invite` writes one straight into the database (it reads
`.env` if present, so set `DATA_DIR` there if you changed it).

Open <http://localhost:8080>, create an account with the code, enter your channel name, then copy the **overlay URL** into
OBS → _Sources_ → _Browser_ (width 1920, height 1080). The control panel's
**Test without chat** card lets you rehearse a round without anyone in chat.

For development with hot reload, run `cp .env.example .env`, then `npm run dev`, and open
<http://localhost:5173/control>.

## How a round works

The game follows the official _Hues and Cues_ rules, with you as the cue giver and chat as the
players.

1. **Draw a card.** Four colours appear, visible only to you. Pick one in secret.
2. **Give a one-word cue.** Guessing opens on stream, and chat types coordinates such as `F12`.
   Each chatter places one guess. Your own messages don't count, since you know the answer.
3. **Give a second cue** of one or two words when guessing closes, for a second guess. Or skip it
   and reveal straight away, as the rules allow.
4. **Reveal.** The target and the scoring frame appear on the board.

### Cue rules

The official cue rules, enforced by default ("Enforce official cue rules"):

- The first cue is one word; the second is one or two words. Punctuation such as hyphens, dashes
  or commas separates words, so "deep-sea" is two words.
- No basic colour names: black, blue, brown, grey/gray, green, orange, pink, purple, red, white or
  yellow, nor simple variants such as "reddish", "bluish" or "greener". Specific names such as
  "lavender" or "teal" are fine.
- No references to the board's letters or numbers: a position such as "F12", or a cue made only of
  letters and board numbers ("12", "twelve", "F"). Ordinary phrases such as "cloud nine" or "plan B",
  and numbers that aren't on the board such as "1984", are fine.
- No repeating a cue already given this game. Reusing a word is fine: "ocean" then "deep ocean"
  is allowed.
- The second cue can't compare against the first guesses: no comparatives such as "lighter",
  "darker" or "paler", and no cue that only steers, such as "more", "up", "top left" or
  "north east". Phrases like "left bank" are fine.

Cues are checked with accents, look-alike characters and invisible characters folded away, so
"réd" or a full-width "ＲＥＤ" is treated as "red".

The rules also forbid comparing the colour to objects in the room. That can't be checked
automatically, so it's up to you.

### Placing guesses

As on the physical board, only one guess fits on each square ("One guess per square"), first come
first served. A player's two guesses can never share a square. Guesses are final once placed,
unless you turn on "Let chatters change their guess".

### Scoring

Points depend on each guess's distance from the target, measured in squares (diagonals count as
one):

| Guess position                               | Points |
| -------------------------------------------- | -----: |
| On the target                                |      3 |
| Inside the 3×3 scoring frame                 |      2 |
| Touching the frame's outside edge (5×5 ring) |      1 |

Both of a player's guesses score, so 5 is the most anyone can earn in a round. You, the cue giver,
earn one point for every guess inside the scoring frame. With one guess per square that's at most 9.

**Reset scores** starts a new game, which also clears the list of cues already given.

### Adapted for Twitch

- **You are always the cue giver.** The board game passes the role around; on stream, the
  streamer gives every cue.
- **There is no fixed end.** The board game ends after everyone has given cues once or twice. Here
  you play as many rounds as you like, and the leaderboard shows the standings.
- **No 3-player bonus.** The board game doubles the cue giver's points with exactly three players.
  That doesn't apply to an open chat.
- **Guesses arrive in chat order.** There are no turns around the table.

### Settings (control panel)

| Setting                         | Default | Description                                                   |
| ------------------------------- | ------- | ------------------------------------------------------------- |
| Guess timer                     | 45 s    | `0` means guessing stays open until you close it              |
| Second clue                     | on      | Adds the two-word cue and second guess                        |
| Let chatters change their guess | off     | Latest guess counts while guessing is open (not official)     |
| Require `!guess`                | off     | Ignore bare `F12` messages; only `!guess F12` counts          |
| One guess per square            | on      | Official rule; turn off for very large chats                  |
| Enforce official cue rules      | on      | Word limits, no basic colours, no board positions, no repeats |

Accepted chat formats: `F12`, `f12`, `F 12`, `F-12`, `12F`, `!guess F12`, `!g F12`, `!hue F12`.

## Accounts

- Usernames are 3–24 letters, numbers, `_` or `-`, and are unique regardless of capitalisation.
- Passwords need at least 10 characters. Any characters are allowed, and passphrases are encouraged.
- Passwords are hashed with scrypt. Sign-ins use a server-side session in a `Secure`, `HttpOnly`,
  `SameSite=Lax` cookie that lasts 30 days from last use.
- Repeated failed sign-ins are limited per account and IP, with a higher ceiling per account.
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
