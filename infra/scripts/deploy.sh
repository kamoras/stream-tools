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
readonly ALL_APPS=(dbd-bot hues-and-cues)
readonly HEALTH_TIMEOUT_SECONDS=180

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
  for app in "${ALL_APPS[@]}"; do
    mkdir -p "data/$app"
    chown "$APP_UID:$APP_UID" "data/$app"
    [[ -f "env/$app.env" ]] || fail "Missing env/$app.env"
  done
  [[ -f env/caddy.env ]] || fail "Missing env/caddy.env"
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

  local app
  for app in "${apps[@]}"; do wait_healthy "$app"; done
  reload_caddy

  if migration_in_progress; then finish_migration; fi
  docker image prune -f >/dev/null
  log "Deploy complete"
}

on_exit() {
  local status=$?
  if ((status != 0)) && migration_in_progress; then rollback_migration; fi
}
trap on_exit EXIT

main "$@"
