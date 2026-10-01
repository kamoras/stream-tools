# stream-tools

[![CI](https://github.com/kamoras/stream-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/kamoras/stream-tools/actions/workflows/ci.yml)
[![Deploy](https://github.com/kamoras/stream-tools/actions/workflows/deploy.yml/badge.svg)](https://github.com/kamoras/stream-tools/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Twitch stream apps, hosted together on one Oracle Cloud Always Free VM.

| App                                           | What it does                                                                                     | Stack                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------- |
| [**dbd-bot**](apps/dbd-bot/README.md)         | Dead by Daylight chat bot: viewer queue, mod controls and DbD-themed commands, for many channels | Node.js, Express, tmi.js      |
| [**hues-and-cues**](apps/hues-and-cues/README.md) | _Hues and Cues_-style colour-guessing game played by chat, with an OBS overlay and streamer accounts | TypeScript, Fastify, Vite |

## Repository layout

```
apps/
  dbd-bot/          Each app is self-contained: its own package.json,
  hues-and-cues/    tests, Dockerfile and README.
infra/
  docker-compose.yml    Production stack: Caddy + every app
  caddy/Caddyfile       Imports one site file per app
  sites-available/      Site files, published only when the app's domain is set
  scripts/deploy.sh     Applies the stack on the server (run by the Deploy workflow)
docs/DEPLOYMENT.md  VM setup, secrets, operations and troubleshooting
```

Apps share nothing but the server and its Caddy reverse proxy. Each runs in its own container with
its own data directory and configuration.

## Local development

Work inside the app's directory; each has its own instructions:

```bash
cd apps/dbd-bot && npm install && npm run dev
cd apps/hues-and-cues && npm ci && npm run dev
```

## CI and deployment

| Workflow     | Trigger                 | What it does                                                                                   |
| ------------ | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `ci.yml`     | Pull requests           | Lints and tests every app, builds every image, validates `infra/`                              |
| `deploy.yml` | Push to `main`, manual  | Runs CI, then rebuilds and restarts **only the apps that changed** since the last deploy       |
| `invite.yml` | Manual                  | dbd-bot emergency fallback for generating an invite code on the server                         |

A change confined to `apps/hues-and-cues/` never restarts the bot, and vice versa. Changes to `infra/`
re-apply configuration (for example Caddy sites) without restarting any app. To redeploy by hand, run
**Deploy** from the Actions tab with `all`, `none` (configuration only) or a list such as `dbd-bot`.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the one-time VM setup and the GitHub secrets each app
needs.

### Adding an app

1. Create `apps/<name>/` with a `Dockerfile` whose container listens on port 8080 and defines a
   health check.
2. Add a service named `<name>` to `infra/docker-compose.yml` with `env_file: env/<name>.env` and
   `./data/<name>` for persistent data.
3. Add `infra/sites-available/<name>.caddy` with a `# requires: <DOMAIN_VAR>` header.
4. Add `<name>` to `ALL_APPS` in `infra/scripts/deploy.sh`, `KNOWN_APPS` and the path filters in
   `.github/workflows/deploy.yml`, the jobs in `ci.yml`, and `.github/dependabot.yml`.
5. Write `env/<name>.env` and the domain variable in the **Write configuration** step of `deploy.yml`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
