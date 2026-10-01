# Deployment

Every app in this repository runs on one Oracle Cloud Always Free VM, behind a single Caddy reverse
proxy that provides HTTPS for each app's domain. GitHub Actions deploys automatically on every push
to `main`.

```
                    Internet :80/:443
                           │
            ┌──────────────▼───────────────┐
            │ caddy                        │  infra/caddy + infra/sites-available
            │  DOMAIN ──────────► dbd-bot:8080
            │  HUES_DOMAIN ─────► hues-and-cues:8080
            └──────────────────────────────┘
               /opt/stream-tools on the VM
```

| Path on the VM                     | Contents                                                               |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `docker-compose.yml`, `caddy/`, `sites-available/`, `scripts/` | Copied from `infra/` on every deploy  |
| `env/*.env`                        | Per-app configuration, written from GitHub secrets on every deploy     |
| `caddy/sites/`                     | Sites currently published (managed by `deploy.sh`)                     |
| `data/dbd-bot/`                    | Bot database (`bot.db`)                                                |
| `data/hues-and-cues/`              | Hues & Cues database (`hues.db`)                                       |

## How a deploy works

1. **CI** lints, tests and builds every app.
2. **Plan** works out which apps changed since the last successful deploy (not just since the last
   push, so changes from cancelled or failed runs are never skipped).
3. **Build** produces `linux/amd64` + `linux/arm64` images for the changed apps only and pushes them to
   `ghcr.io/kamoras/stream-tools/<app>`, tagged `latest` and `sha-<commit>`.
4. **Deploy** copies `infra/` to the VM, writes `env/*.env` from secrets and runs
   [`infra/scripts/deploy.sh`](../infra/scripts/deploy.sh), which:
   - publishes each app's Caddy site only if its domain is set, so a missing domain can't take down
     the other apps;
   - pulls the changed apps' images and runs `docker compose up -d`, which recreates only containers
     whose image or configuration changed;
   - waits for each deployed app's health check, then validates and hot-reloads Caddy.
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

**dbd-bot**: see [apps/dbd-bot/README.md](../apps/dbd-bot/README.md#deployment). `DOMAIN` is the
bot's hostname.

**hues-and-cues**

| Secret                      | Required | Description                                                              |
| --------------------------- | :------: | ------------------------------------------------------------------------ |
| `HUES_DOMAIN`               |    ✅¹   | The game's hostname, e.g. `hues.yourdomain.com`                          |
| `HUES_ADMIN_PASSWORD`       |    ✅²   | Password for the admin page (12+ characters)                             |
| `HUES_ADMIN_PATH`           |    ✅²   | Secret URL segment, e.g. output of `openssl rand -hex 12`               |
| `HUES_ALLOWED_CHANNELS`     |          | Comma-separated Twitch channels that may run games                       |

¹ Without it the game still runs, but is not published.
² Sign-up is invite-only, and invite codes are generated on the admin page at
`https://<HUES_DOMAIN>/admin/<HUES_ADMIN_PATH>`, just like the bot's. Without these two secrets
nobody can create an account. Set both or neither; the deploy fails early if only one is set.

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
5. On any failure, the new stack is removed and **the old stack is restarted unchanged**.

The bot is unavailable only between steps 2 and 3, a few seconds in rehearsal. Nothing needs to be
done by hand.

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
- **`dbd-bot did not become healthy`.** The bot reports healthy only once it is connected to Twitch
  chat; check its token and `sudo docker compose logs dbd-bot`.
- **A site isn't published.** `deploy.sh` logs `not published (… is not set)` when its domain secret
  is missing.
- **Permission denied writing data.** Both app images run as uid 1000:
  `sudo chown -R 1000:1000 data/<app>`.
