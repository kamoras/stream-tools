# Deployment

Production runs on the **same Oracle Cloud VM as
[dead-by-daylight-twitch-bot](https://github.com/kamoras/dead-by-daylight-twitch-bot)**, deployed by
GitHub Actions in the same way: every push to `main` that passes CI is built into a multi-arch image,
pushed to GHCR and rolled out over SSH.

## How the two apps share the VM

```
                    Internet :80/:443
                           │
                ┌──────────▼───────────┐
                │ dbd-caddy (Caddy)    │  owned by dead-by-daylight-twitch-bot
                │  bot.example.com ────┼──► bot:8080           (dbd default network)
                │  hues.example.com ───┼──► hues-and-cues:8080 (shared `edge` network)
                └──────────────────────┘
                 imports /opt/caddy/sites/*.caddy
```

Only one process can bind ports 80/443, and the bot's Caddy already does. So this app runs no proxy
of its own. Instead:

1. Its container joins a shared Docker network named `edge` (alias `hues-and-cues`).
2. The deploy writes `/opt/caddy/sites/hues-and-cues.caddy` (generated from
   [`deploy/caddy-site.caddy`](../deploy/caddy-site.caddy)).
3. The deploy reloads the bot's Caddy, which imports that file and obtains a TLS certificate for this
   app's hostname automatically.

The bot repo's side of this (importing `/opt/caddy/sites`, joining `edge`) was added in
[kamoras/dead-by-daylight-twitch-bot#19](https://github.com/kamoras/dead-by-daylight-twitch-bot/pull/19).
**Merge and deploy that first.**

| Path on the VM                          | Contents                                   |
| --------------------------------------- | ------------------------------------------ |
| `/opt/hues-and-cues/docker-compose.yml` | Copied from `deploy/` on each deploy       |
| `/opt/hues-and-cues/.env`               | Written from GitHub secrets on each deploy |
| `/opt/hues-and-cues/data/hues.db`       | SQLite database: accounts, games, scores   |
| `/opt/caddy/sites/hues-and-cues.caddy`  | Caddy site for this app                    |

## One-time setup

The VM is already provisioned with Docker and open ports for the bot, so only these steps are needed.

### 1. DNS

Choose a hostname for the game, such as `hues.yourdomain.com`, and create an **A record** pointing to
the VM's public IP (the same IP as the bot's domain).

### 2. GitHub Actions secrets

In this repository go to **Settings → Secrets and variables → Actions** and add:

| Secret                 | Required | Value                                                                 |
| ---------------------- | :------: | --------------------------------------------------------------------- |
| `ORACLE_HOST`          |    ✅    | Same value as in the bot repo                                         |
| `ORACLE_USER`          |    ✅    | Same value as in the bot repo (`ubuntu`)                              |
| `ORACLE_SSH_KEY`       |    ✅    | Same private deploy key as in the bot repo                            |
| `DOMAIN`               |    ✅    | This app's hostname, e.g. `hues.yourdomain.com` (**not** the bot's)   |
| `REGISTRATION_CODE`    |          | Require this code to sign up. Recommended: only people you invite     |
| `REGISTRATION_ENABLED` |          | `false` to close sign-ups entirely (existing users can still sign in) |
| `ALLOWED_CHANNELS`     |          | Comma-separated Twitch channels that may run games                    |

GitHub secrets belong to one repository, so the three `ORACLE_*` values must be copied over from the
bot repo.

### 3. Deploy

Merge to `main`. The **Deploy** workflow runs after CI passes. It:

1. Builds `linux/amd64` and `linux/arm64` images and pushes them to
   `ghcr.io/kamoras/hues-and-cues-twitch` (tagged `latest` and `sha-<commit>`).
2. Over SSH, creates `/opt/hues-and-cues`, the `edge` network and `/opt/caddy/sites` (each only if
   missing).
3. Writes `.env` and the Caddy site file, pulls the image and runs `docker compose up -d`.
4. Waits for the container's health check, then reloads the shared Caddy.
5. Smoke-tests `https://$DOMAIN/healthz` from the runner.

You can also run it by hand from **Actions → Deploy → Run workflow**.

Then open `https://<DOMAIN>`, create your account and set up your game.

## Operations

| Task                 | Command on the VM                                                              |
| -------------------- | ------------------------------------------------------------------------------ |
| Logs                 | `sudo docker compose -f /opt/hues-and-cues/docker-compose.yml logs -f`         |
| Restart              | `sudo docker compose -f /opt/hues-and-cues/docker-compose.yml restart`         |
| Health               | `curl https://<DOMAIN>/healthz`                                                |
| Back up the database | `sudo sqlite3 /opt/hues-and-cues/data/hues.db ".backup /tmp/hues-backup.db"`   |
| Roll back            | Set `image:` to a `sha-…` tag in the compose file, then `docker compose up -d` |
| Caddy logs           | `sudo docker logs dbd-caddy`                                                   |

The database uses SQLite in WAL mode; the `.backup` command above gives a consistent copy while the
app is running. (Install the CLI with `sudo apt-get install sqlite3`.)

## Troubleshooting

- **Smoke test fails but the container is healthy.** Check that the DNS record points at the VM, and
  that the bot repo change above has been deployed: `sudo docker exec dbd-caddy ls /etc/caddy/sites`
  should list `hues-and-cues.caddy`. Then look at `sudo docker logs dbd-caddy` for certificate errors.
- **`network edge declared as external, but could not be found`.** Run
  `sudo docker network create edge`. Both deploy workflows normally do this.
- **Permission denied writing `/data`.** Run `sudo chown -R 1000:1000 /opt/hues-and-cues/data`.

## Other hosting options

The image runs anywhere Docker does. For a machine of your own with nothing else on ports 80/443,
[`compose.yaml`](../compose.yaml) runs the app behind its own Caddy:

```bash
cp .env.example .env   # set DOMAIN and, ideally, REGISTRATION_CODE
docker compose up -d --build
```

Without Docker, [`deploy/hues-and-cues.service`](../deploy/hues-and-cues.service) is a hardened
systemd unit; run it behind any TLS-terminating proxy with `TRUST_PROXY=true`.

Serverless platforms such as Vercel are **not** suitable. The app needs a long-running process that
stays connected to Twitch chat and pushes live updates to the overlay over WebSockets.

## OBS setup

1. Open the control panel and copy the **overlay URL**.
2. In OBS, go to _Sources_ → **+** → _Browser_, paste the URL and set the size to **1920 × 1080**.
3. The overlay background is already transparent, so leave the default custom CSS alone.
