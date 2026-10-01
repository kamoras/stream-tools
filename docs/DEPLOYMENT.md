# Deployment

Every app in this repository runs on one Oracle Cloud Always Free VM, behind a single Caddy reverse
proxy that provides HTTPS for each app's domain. GitHub Actions deploys automatically on every push
to `main`.

```
                    Internet :80/:443
                           │
            ┌──────────────▼───────────────┐
            │ caddy                        │  infra/caddy + infra/sites-available
            │  ADMIN_DOMAIN ────► admin:8080 ───┐ Bearer <per-app token>
            │  DOMAIN ──────────► dbd-bot:8080  ├──► dbd-bot:9000 (internal)
            │  HUES_DOMAIN ─────► hues-and-cues:8080
            └──────────────────────────────┘    └──► hues-and-cues:9000 (internal)
               /opt/stream-tools on the VM
```

The shared [admin dashboard](../apps/admin/README.md) is served at
`https://<ADMIN_DOMAIN>/admin/<ADMIN_PATH>`. Without `ADMIN_DOMAIN` it stays at the bot's original
admin URL, `https://<DOMAIN>/admin/<ADMIN_PATH>`; with it, that old URL redirects to the new one. It manages every app through each app's internal admin API on port
9000. Caddy never routes to that port, so it is reachable only on the private Docker network, and
every call needs that app's own token from `env/internal-<app>.env`, so a compromised app can't use
another app's API. The tokens are generated on the server by the first deploy and kept from then
on; only the dashboard holds all of them (`env/internal-admin.env`).

The apps share the VM but can't get in each other's way. Each has its own container, database and
Twitch connection: Hues & Cues reads chat anonymously and never posts as the bot. Hues & Cues and
the dashboard have memory and CPU caps (`mem_limit`, `cpus` in the compose file), so a busy game
can't starve the bot.

| Path on the VM                     | Contents                                                               |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `docker-compose.yml`, `caddy/`, `sites-available/`, `scripts/` | Copied from `infra/` on every deploy  |
| `env/*.env`                        | Per-app configuration, written from GitHub secrets on every deploy     |
| `env/internal-*.env`               | Internal API tokens, generated once on the server; never in GitHub     |
| `deploy.log`, `.deploy.lock`       | Output of the latest `deploy.sh` run; lock allowing one run at a time  |
| `caddy/sites/`                     | Sites currently published (managed by `deploy.sh`)                     |
| `data/dbd-bot/`                    | Bot database (`bot.db`)                                                |
| `data/hues-and-cues/`              | Hues & Cues database (`hues.db`)                                       |

## How a deploy works

1. **CI** lints, tests and builds every app.
2. **Plan** works out which apps changed since the last successful deploy (not just since the last
   push, so changes from cancelled or failed runs are never skipped). It refuses to run on any
   branch other than `main`.
3. **Build** produces `linux/amd64` + `linux/arm64` images for the changed apps only and pushes them to
   `ghcr.io/kamoras/stream-tools/<app>`, tagged `latest` and `sha-<commit>`.
4. **Deploy** copies `infra/` to the VM, writes `env/*.env` from secrets and runs
   [`infra/scripts/deploy.sh`](../infra/scripts/deploy.sh), which:
   - publishes each app's Caddy site only if its domain is set, so a missing domain can't take down
     the other apps;
   - pulls the changed apps' images and runs `docker compose up -d`, which recreates only containers
     whose image or configuration changed;
   - waits for every app's health check (a configuration change can recreate any of them), then
     validates and hot-reloads Caddy.
5. **Smoke test** checks each app over HTTPS from outside.

## One-time setup

### 1. Oracle Cloud VM

Skip this section if the VM already exists (it does if the bot has been deployed before).

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com).
2. Navigate to **Compute → Instances → Create Instance**.
3. Choose an **Always Free** shape: `VM.Standard.E2.1.Micro` (AMD) or `VM.Standard.A1.Flex` (Arm).
4. Select **Ubuntu 24 Minimal** as the image.
5. Add your SSH public key during creation.
6. Note the **Public IP address** once the instance starts.

### Open ports

In the Oracle console under **Networking → Virtual Cloud Networks → Security Lists**, add ingress rules for TCP ports **80** and **443**.

Then on the VM:

```bash
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

### Install Docker

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) \
  signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

### 2. Deploy SSH key

On your **local machine**:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/stream_tools_deploy -N ""
```

Add the public key to the Oracle VM:

```bash
# On the Oracle VM:
echo "PASTE_CONTENTS_OF_stream_tools_deploy.pub_HERE" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### 3. DNS

Point an **A record** for each app's hostname at the VM's public IP, e.g. `bot.yourdomain.com` and
`hues.yourdomain.com`.

### 4. GitHub secrets

Under **Settings → Secrets and variables → Actions**, add:

**Server**

| Secret           | Required | Description                                                    |
| ---------------- | :------: | -------------------------------------------------------------- |
| `ORACLE_HOST`    |    ✅    | VM public IP or hostname                                       |
| `ORACLE_USER`    |    ✅    | SSH username (`ubuntu`)                                        |
| `ORACLE_SSH_KEY` |    ✅    | The **private** deploy key from step 2                         |

**Admin dashboard** (one login for every app)

| Secret           | Required | Description                                                            |
| ---------------- | :------: | ---------------------------------------------------------------------- |
| `ADMIN_PASSWORD` |    ✅    | The admin password                                                     |
| `ADMIN_PATH`     |    ✅    | Secret URL segment of letters, numbers, `_` or `-`, e.g. output of `openssl rand -hex 12` |
| `ADMIN_DOMAIN`   |          | The dashboard's own hostname, e.g. `stream-tools.yourdomain.com`        |

`ADMIN_PASSWORD` and `ADMIN_PATH` are the bot's original admin secrets, so an existing setup needs no
changes, unless `ADMIN_PATH` contains other characters: the deploy then stops with an error asking
you to change it.

Without `ADMIN_DOMAIN` the dashboard is at `https://<DOMAIN>/admin/<ADMIN_PATH>`. To give it a
domain of its own:

1. Point an A record for the new hostname at the VM (DNS only, if you use Cloudflare).
2. In the [Twitch developer console](https://dev.twitch.tv/console/apps), add
   `https://<ADMIN_DOMAIN>/admin/<ADMIN_PATH>/twitch-callback` to the app's OAuth redirect URLs
   (keep the old one until the deploy has finished).
3. Add the `ADMIN_DOMAIN` secret and deploy (**Actions → Deploy → Run workflow** with `none`).

The dashboard then lives at `https://<ADMIN_DOMAIN>/admin/<ADMIN_PATH>`; the old URL on the bot's
domain redirects there, and the root of the new domain shows nothing (404).

**dbd-bot**: see [apps/dbd-bot/README.md](../apps/dbd-bot/README.md#deployment). `DOMAIN` is the
bot's hostname.

**hues-and-cues**

| Secret                      | Required | Description                                                              |
| --------------------------- | :------: | ------------------------------------------------------------------------ |
| `HUES_DOMAIN`               |    ✅¹   | The game's hostname, e.g. `hues.yourdomain.com`                          |
| `HUES_ALLOWED_CHANNELS`     |          | Comma-separated Twitch channels that may run games                       |

¹ Without it the game still runs, but is not published.

Hues & Cues sign-up is invite-only. Generate codes in the admin dashboard's **Hues & Cues** section.

### 5. Deploy

Push to `main`, or run **Actions → Deploy → Run workflow** with `all`.

## Migrating from the original bot deployment

Before this repository held several apps, the bot was deployed on its own to `/opt/dbd-bot`
(containers `dbd-bot` and `dbd-caddy`). The first deploy of this layout migrates automatically,
in [`migrate-from-dbd-bot.sh`](../infra/scripts/migrate-from-dbd-bot.sh):

1. New images are pulled while the old stack keeps serving.
2. The old stack is stopped; the bot's database is copied to `data/dbd-bot/`, and Caddy's
   certificates and state are copied into the new volumes, so nothing is re-issued.
3. The new stack starts and every app must pass its health check.
4. On success, `/opt/dbd-bot` is kept as `/opt/dbd-bot.pre-stream-tools` for reference and can be
   deleted once you're happy.
5. If `deploy.sh` fails at any point, including the GitHub job being cancelled or timing out
   mid-run (the script keeps running and logs to `deploy.log`), the new stack is removed and **the
   old stack is restarted from its own untouched files**. Anything the new bot wrote in the
   meantime (for example an invite used or a channel added) is discarded with it.

The bot is unavailable only between steps 2 and 3, a few seconds in rehearsal. Nothing needs to be
done by hand. The smoke test runs after a successful migration; if only it fails, the new stack
stays up (see Troubleshooting).

## Operations

All commands run on the VM from `/opt/stream-tools`.

| Task                    | Command                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| Status                  | `sudo docker compose ps`                                                      |
| Logs                    | `sudo docker compose logs -f dbd-bot` (or `hues-and-cues`, `caddy`)           |
| Restart one app         | `sudo docker compose restart hues-and-cues`                                   |
| Re-apply configuration  | `sudo bash scripts/deploy.sh`                                                 |
| Roll back an app        | Set its `image:` to a `sha-…` tag in `docker-compose.yml`, then `sudo docker compose up -d <app>` (the next deploy restores `latest`) |
| Back up a database      | `sudo sqlite3 data/hues-and-cues/hues.db ".backup /tmp/hues.db"` (likewise `data/dbd-bot/bot.db`) |

SQLite runs in WAL mode, so `.backup` gives a consistent copy while apps are running. Install the CLI
with `sudo apt-get install sqlite3`.

## Troubleshooting

- **Smoke test fails but `deploy.sh` succeeded.** Check that the app's DNS record points at the VM,
  then look for certificate errors with `sudo docker compose logs caddy`.
- **`dbd-bot did not become healthy`.** The container health check (`/health/live`) only needs the
  bot's web server to be up, so this means it crashed or failed to start: check
  `sudo docker compose logs dbd-bot`. The public `/health` used by the smoke test additionally
  requires the Twitch chat connection; if only that fails, reconnect via the admin dashboard.
- **A site isn't published.** `deploy.sh` logs `not published (… is not set)` when its domain secret
  is missing.
- **Permission denied writing data.** Both app images run as uid 1000:
  `sudo chown -R 1000:1000 data/<app>`.
