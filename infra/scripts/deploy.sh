#!/usr/bin/env bash
# Applies the stream-tools stack on the server.
#
#   sudo bash /opt/stream-tools/scripts/deploy.sh [app...]
#
# Each named app has its image pulled and is restarted only if the image or
# its configuration changed; other apps are left running untouched. With no
# arguments, only configuration (env files, Caddy sites) is applied.
#
# On the first run it migrates the old single-app deployment in /opt/dbd-bot
# (see migrate-from-dbd-bot.sh) and rolls back to it if anything fails.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
readonly APP_UID=1000 # the `node` user in both app images
readonly ALL_APPS=(dbd-bot hues-and-cues admin)
readonly DATA_APPS=(dbd-bot hues-and-cues) # apps with persistent data
# Apps with an internal admin API, and the admin variable holding each one's token.
declare -rA API_TOKEN_VARS=([dbd-bot]=DBD_BOT_API_TOKEN [hues-and-cues]=HUES_API_TOKEN)
readonly HEALTH_TIMEOUT_SECONDS=180

# Survive the SSH session going away (job cancelled or timed out): ignore
# SIGHUP/SIGPIPE and send all output through tee, which keeps writing the log
# file after its stdout pipe closes. A half-finished migration can then still
# roll back. The latest run's output is kept in deploy.log.
trap '' HUP PIPE
exec > >(tee --output-error=warn-nopipe "$ROOT/deploy.log") 2>&1
TEE_PID=$!

log() { printf '==> %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

cd "$ROOT"
compose() { docker compose --project-directory "$ROOT" -f "$ROOT/docker-compose.yml" "$@"; }

# shellcheck source=SCRIPTDIR/migrate-from-dbd-bot.sh
source "$ROOT/scripts/migrate-from-dbd-bot.sh"

validate_args() {
  local app known candidate
  for app in "$@"; do
    known=0
    for candidate in "${ALL_APPS[@]}"; do [[ "$app" == "$candidate" ]] && known=1; done
    ((known)) || fail "Unknown app '$app'. Known apps: ${ALL_APPS[*]}"
  done
}

prepare_directories() {
  mkdir -p caddy/sites env
  chmod 700 env
  local app
  for app in "${DATA_APPS[@]}"; do
    mkdir -p "data/$app"
    chown "$APP_UID:$APP_UID" "data/$app"
  done
  for app in "${ALL_APPS[@]}"; do
    [[ -f "env/$app.env" ]] || fail "Missing env/$app.env"
  done
  [[ -f env/caddy.env ]] || fail "Missing env/caddy.env"
}

# Each app's internal admin API has its own token, so a compromised app can't
# drive another app's API; only the admin dashboard holds all of them. They
# never leave the server, so they are generated here once and kept.
ensure_internal_tokens() {
  local app file token lines=''
  for app in "${!API_TOKEN_VARS[@]}"; do
    file="env/internal-$app.env"
    if [[ ! -s "$file" ]]; then
      token="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
      (umask 077 && printf 'INTERNAL_API_TOKEN=%s\n' "$token" >"$file")
      log "Generated internal API token for $app"
    fi
    lines+="${API_TOKEN_VARS[$app]}=$(env_value "$file" INTERNAL_API_TOKEN)"$'\n'
  done
  (umask 077 && printf '%s' "$lines" >env/internal-admin.env)
  rm -f env/internal.env # single shared token used by earlier versions
}

env_value() { # env_value FILE NAME -> value of NAME in FILE, or empty
  grep -E "^$2=" "$1" | tail -n 1 | cut -d= -f2- || true
}

# Publishes an app's site only when the domain it needs is configured, so an
# unset domain can never stop Caddy from serving the other apps.
sync_caddy_sites() {
  local site name required domain
  for site in sites-available/*.caddy; do
    name="$(basename "$site")"
    required="$(sed -n 's/^# requires: //p' "$site")"
    domain="$(env_value env/caddy.env "$required")"
    if [[ -n "$domain" ]]; then
      cp "$site" "caddy/sites/$name"
      log "Site ${name%.caddy}: https://$domain"
    else
      rm -f "caddy/sites/$name"
      log "Site ${name%.caddy}: not published ($required is not set)"
    fi
  done
}

wait_healthy() { # wait_healthy CONTAINER
  local container="$1" status deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  log "Waiting for $container to become healthy"
  while ((SECONDS < deadline)); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || echo missing)"
    case "$status" in
      healthy) log "$container is healthy"; return 0 ;;
      unhealthy | exited | dead) break ;;
    esac
    sleep 3
  done
  compose logs --tail 50 "$container" >&2 || true
  fail "$container did not become healthy (status: $status)"
}

reload_caddy() {
  log "Validating and reloading Caddy"
  compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
}

main() {
  validate_args "$@"
  local apps=("$@")

  prepare_directories
  ensure_internal_tokens
  sync_caddy_sites

  local migrate=0
  if migration_needed; then
    migrate=1
    apps=("${ALL_APPS[@]}") # first start of the new stack: verify everything
  fi

  # Pull before touching anything that is running, to keep downtime short.
  if ((${#apps[@]} > 0)); then
    log "Pulling: ${apps[*]}"
    compose pull "${apps[@]}"
  fi
  if ((migrate)); then migrate_from_dbd_bot; fi

  # Only services whose image or configuration changed are recreated.
  compose up -d --remove-orphans

  # Every app, not just the ones deployed: a configuration change can recreate
  # any of them. Healthy ones pass on the first check.
  local app
  for app in "${ALL_APPS[@]}"; do wait_healthy "$app"; done
  reload_caddy

  if migration_in_progress; then finish_migration; fi
  docker image prune -f >/dev/null
  log "Deploy complete"
}

on_exit() {
  local status=$?
  if ((status != 0)) && migration_in_progress; then rollback_migration; fi
  # Let tee flush the last lines before the SSH session reports the exit.
  exec >&- 2>&-
  wait "$TEE_PID" 2>/dev/null || true
}
trap on_exit EXIT

main "$@"
