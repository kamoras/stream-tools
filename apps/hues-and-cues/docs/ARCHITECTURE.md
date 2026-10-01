# Architecture

```
          Twitch IRC (wss, anonymous)
                     │  chat messages
                     ▼
┌──────────────────────────────────────────────────────────┐
│ Node.js server (Fastify)                                  │
│                                                          │
│  TwitchChatClient ──► RoomRegistry ──► Room ──► GameEngine│
│   (ref-counted joins,   (chat routing,   (broadcast      │
│    reconnect/backoff)    persistence)     throttling,    │
│                                           timers)        │
│  WS gateway (/ws) ◄──────────────────────┘               │
│  REST (/api/auth, /api/rooms) · static assets · /healthz │
│  AuthService ─ users · sessions ─┐                       │
│                         SQLite (hues.db): users, sessions, rooms
└───────────────┬───────────────────────────┬──────────────┘
                │ host state + commands     │ public state
                ▼                           ▼
        Control panel (/control)      Overlay (/overlay?room=…)
     signed-in streamer's browser       OBS browser source (public)
```

## Key decisions

**Single stateful service.** Live overlays need server push and the chat connection must stay open,
so the app is one long-running Node process rather than serverless functions. Live game state is
kept in memory for speed. Each room's state is written to SQLite as a versioned, schema-validated
JSON snapshot, with writes debounced and batched in transactions, so restarts and deploys keep
rounds and scores. Accounts and sessions live in the same SQLite database (WAL mode). Schema changes
are ordered migrations tracked with `PRAGMA user_version`.

**Pure game engine.** `GameEngine` is a deterministic state machine with injected clock and random
source and no I/O. All rules — phases, clue limits, scoring, card generation — are unit-tested in
isolation. `Room` adds the side-effects: timers, persistence notifications and broadcasting.

**Information hiding by construction.** The engine produces two views: `getPublicState()` (overlay)
and `getHostState()` (adds the secret card and target). The overlay never receives the target until
the round is revealed, so it cannot leak through browser dev tools or a shared overlay URL.

**Accounts and sessions.** Streamers register with a username and password. Passwords are hashed
with scrypt using OWASP-recommended parameters. The hashes record their own parameters, so they are
upgraded automatically on the next login if the defaults are raised. Login runs the hash even for
unknown usernames, so response timing doesn't reveal which accounts exist. Failures are limited
both per IP and per account.

A session is a random 256-bit token held in an `HttpOnly`, `SameSite=Lax` cookie, marked `Secure`
with the `__Host-` prefix in production. The server stores only its SHA-256 hash, and expiry slides
forward as the session is used. Changing the password revokes every other session.

**Cross-site protection.** State-changing requests must carry an `Origin` header matching the
server, on top of `SameSite` cookies. WebSocket upgrades for the host role are checked the same way,
which blocks cross-site WebSocket hijacking.

**Authorisation.** Every room has an owner. Room endpoints and host WebSocket connections require a
session whose user owns the room. Overlay URLs contain only the public room id and are read-only, so
an OBS browser source needs no credentials. `ALLOWED_CHANNELS` can further restrict which channels
may run games.

**Invite-only sign-up and admin.** Registration requires a single-use invite code, as in the
dbd-bot. Codes have 60 bits of entropy and are stored only as SHA-256 hashes with a short display
hint. Creating the account and consuming the code happen in one SQLite transaction, with a
conditional `UPDATE`, so a code can never create two accounts even under concurrent sign-ups. This
app has no admin UI. The shared stream-tools dashboard (`apps/admin`) generates and revokes codes
and lists accounts through an internal JSON API, which runs as a separate server on
`INTERNAL_API_PORT`. That port is never routed by the reverse proxy, and every request must carry
`INTERNAL_API_TOKEN` (compared in constant time).

**Back-pressure.** Popular channels can produce hundreds of guesses per second. Guess broadcasts are
coalesced (at most four per second per room), the public state carries a capped list of recent
guesses plus per-cell counts, and per-round guess totals are bounded. Incoming WebSocket messages
are size-limited, schema-validated with zod and rate-limited per connection; room creation is
rate-limited per IP.

**Resilience.** The chat client reconnects with jittered exponential back-off, honours Twitch's
`RECONNECT`, detects dead connections with keepalive pings and rejoins channels. Browser clients
reconnect indefinitely (OBS sources run for hours) except after an authorisation failure.

**Colour board.** Colours are generated in OKLCH (perceptually uniform) and gamut-mapped to sRGB hex
in TypeScript, so neighbouring squares look evenly spaced and the board renders identically in older
OBS browser engines that lack CSS `oklch()`.

## Wire protocol

Defined in `src/shared/protocol.ts`.

1. Client connects to `/ws` and sends `hello` with `role` (`"overlay"` or `"host"`) and `roomId`.
   Hosts are identified by their session cookie and must own the room.
2. Server replies `welcome`, `chatStatus`, then a full `state` message, and pushes a new `state`
   after every change.
3. Hosts send commands: `drawCard`, `selectTarget`, `giveClue`, `closeGuessing`, `reveal`,
   `cancelRound`, `resetScores`, `updateSettings`, `simulateGuess`.
4. Failures come back as `error` messages; fatal problems close the socket with a 44xx code.

## Game phases

```
idle ─drawCard→ picking ─giveClue→ guessing ─close→ intermission ─giveClue→ guessing
                  ↺ drawCard (redraw)    │                  │
                                         └──close/reveal──→ reveal ─drawCard→ picking
any phase ─cancelRound→ idle
```
