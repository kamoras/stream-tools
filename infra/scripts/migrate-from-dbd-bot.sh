# shellcheck shell=bash
# One-time migration from the original single-app deployment
# (/opt/dbd-bot: containers dbd-bot + dbd-caddy, compose project "dbd-bot")
# to the shared stream-tools stack. Sourced by deploy.sh.
#
# Preserves the bot's SQLite database and Caddy's certificates, keeps the old
# directory as a backup, and restores the old stack if the new one fails.

readonly LEGACY_DIR=/opt/dbd-bot
readonly LEGACY_BACKUP_DIR=/opt/dbd-bot.pre-stream-tools
readonly MIGRATION_MARKER="$ROOT/.migrated-from-dbd-bot"
MIGRATING=0

legacy_compose() {
  docker compose --project-directory "$LEGACY_DIR" -f "$LEGACY_DIR/docker-compose.yml" "$@"
}

migration_needed() {
  [[ -f "$LEGACY_DIR/docker-compose.yml" && ! -f "$MIGRATION_MARKER" ]]
}

migration_in_progress() { ((MIGRATING)); }

copy_volume() { # copy_volume FROM TO COMPOSE_VOLUME_KEY
  if ! docker volume inspect "$1" >/dev/null 2>&1; then
    log "Volume $1 not found; skipping"
    return 0
  fi
  # Labels mark the volume as Compose's own, as if `compose up` had made it.
  docker volume create \
    --label com.docker.compose.project=stream-tools \
    --label "com.docker.compose.volume=$3" \
    "$2" >/dev/null
  docker run --rm --entrypoint sh -v "$1:/from:ro" -v "$2:/to" caddy:2-alpine \
    -c 'cp -a /from/. /to/'
  log "Copied volume $1 -> $2"
}

migrate_from_dbd_bot() {
  log "Migrating from $LEGACY_DIR"
  MIGRATING=1

  # Stop the old stack first so the database is quiescent and ports 80/443
  # are free for the new Caddy.
  legacy_compose down

  if [[ -n "$(ls -A data/dbd-bot 2>/dev/null)" ]]; then
    local aside
    aside="data/dbd-bot.before-migration-$(date +%Y%m%d%H%M%S)"
    mv data/dbd-bot "$aside"
    mkdir -p data/dbd-bot
    log "Moved existing data/dbd-bot aside to $aside"
  fi
  cp -a "$LEGACY_DIR/data/." data/dbd-bot/
  chown -R "$APP_UID:$APP_UID" data/dbd-bot
  log "Copied bot database to data/dbd-bot"

  # Reusing Caddy's state avoids re-issuing certificates.
  copy_volume dbd-bot_caddy_data stream-tools-caddy-data caddy-data
  copy_volume dbd-bot_caddy_config stream-tools-caddy-config caddy-config
}

finish_migration() {
  date -u +%Y-%m-%dT%H:%M:%SZ >"$MIGRATION_MARKER"
  mv "$LEGACY_DIR" "$LEGACY_BACKUP_DIR"
  # The old .env holds every secret and was written with the default umask.
  chmod -R go-rwx "$LEGACY_BACKUP_DIR"
  MIGRATING=0
  log "Migration complete; old deployment kept at $LEGACY_BACKUP_DIR"
}

rollback_migration() {
  MIGRATING=0
  printf 'ERROR: migration failed; restoring the previous deployment\n' >&2 || true
  compose down || true
  legacy_compose up -d
  printf 'Previous deployment restored. The new stack was not started.\n' >&2 || true
}
