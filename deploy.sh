#!/usr/bin/env bash
#
# deploy.sh — deploys Whispers on the production host. Runs ON the server,
# from inside a git clone of https://github.com/lizTheDeveloper/whispers at
# /opt/whispers (see DEPLOY.md for the one-time setup that gets you there).
#
# What it does, in order:
#   1. Pulls the target branch from git (never from a local working tree)
#      and prints the exact commit SHA being deployed.
#   2. Backs up the live database (with a timestamp) before touching
#      anything, and prunes old backups.
#   3. Tags the currently-running image as a rollback target, then builds
#      the new image — all before the running container is touched, so a
#      failed build never causes downtime.
#   4. Recreates the container (compose create, so the app cannot start and
#      initialise a fresh database before we've had a chance to check the
#      state volume) and starts it.
#   5. Polls the Dockerfile's own HEALTHCHECK (hits /healthz) until it
#      reports healthy or a timeout is hit.
#   6. On health-check failure, loudly rolls back to the previous image and
#      exits non-zero. It does NOT roll back the database — see DEPLOY.md.
#
# Safe to run twice in a row: every step is guarded to be a no-op (or a
# harmless repeat) if the previous run already got there. Never touches
# .env — the only git operation is a fast-forward-only merge of tracked
# files, and .env is untracked/gitignored.
set -euo pipefail

# ---- config -----------------------------------------------------------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRANCH="${WHISPERS_DEPLOY_BRANCH:-main}"
COMPOSE_FILE="docker-compose.prod.yml"
CONTAINER="whispers-server"
IMAGE_REPO="whispers-server"
BACKUP_DIR="$REPO_DIR/backups"
KEEP_BACKUPS="${WHISPERS_KEEP_BACKUPS:-14}"
STATE_DIR_IN_CONTAINER="/app/state"
LEGACY_DATA_DIR_IN_CONTAINER="/app/data"
HEALTH_TIMEOUT_SECS="${WHISPERS_HEALTH_TIMEOUT_SECS:-120}"
DB_FILES=(whispers.db whispers.db-wal whispers.db-shm)

cd "$REPO_DIR"

log()  { echo "[deploy] $*"; }
warn() { echo "[deploy] WARNING: $*" >&2; }
die()  { echo "[deploy] ERROR: $*" >&2; exit 1; }

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# ---- 1. deploy from git, never from a local working tree ---------------
[ -d .git ] || die "$REPO_DIR is not a git checkout. See DEPLOY.md for the one-time conversion from an rsync'd copy."

log "Fetching origin/$BRANCH..."
git fetch origin "$BRANCH"

# Fast-forward only: if the server has diverged (e.g. someone hand-edited a
# tracked file), stop rather than silently discarding it. This never
# touches untracked/gitignored files (.env, backups/) either way.
git checkout "$BRANCH"
git merge --ff-only "origin/$BRANCH" || die "Local $BRANCH has diverged from origin/$BRANCH — resolve by hand before redeploying. Nothing has been touched."

DEPLOY_SHA="$(git rev-parse HEAD)"
log "Deploying commit $DEPLOY_SHA ($(git log -1 --format=%s HEAD))"

# ---- 2. back up the database before touching anything -------------------
mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  log "Backing up live database (timestamp $TIMESTAMP)..."
  BACKED_UP_ANY=false
  # Check both the new (STATE_DIR) and legacy (DATA_DIR) in-container
  # locations — a host mid-transition to the volume-backed layout may still
  # have its only copy at the legacy path. Copy sidecars before the main
  # .db file: if a checkpoint races with this copy, worst case is a stale,
  # harmless orphan -wal that SQLite ignores on open, never a mismatched
  # pair that loses data.
  for container_dir in "$STATE_DIR_IN_CONTAINER" "$LEGACY_DATA_DIR_IN_CONTAINER"; do
    if docker exec "$CONTAINER" test -f "$container_dir/whispers.db" 2>/dev/null; then
      for f in whispers.db-wal whispers.db-shm whispers.db; do
        if docker exec "$CONTAINER" test -f "$container_dir/$f" 2>/dev/null; then
          docker cp "$CONTAINER:$container_dir/$f" "$BACKUP_DIR/${TIMESTAMP}.${f}"
        fi
      done
      BACKED_UP_ANY=true
      break # prefer STATE_DIR if both somehow exist; don't back up twice
    fi
  done
  if [ "$BACKED_UP_ANY" = false ]; then
    warn "No existing database found in the running container at $STATE_DIR_IN_CONTAINER or $LEGACY_DATA_DIR_IN_CONTAINER — nothing to back up."
  else
    log "Backup written to $BACKUP_DIR/${TIMESTAMP}.whispers.db*"
  fi
else
  log "No running container named $CONTAINER — nothing to back up (first-ever deploy?)."
fi

# Prune old backups, keeping the most recent $KEEP_BACKUPS timestamps.
mapfile -t BACKUP_TIMESTAMPS < <(find "$BACKUP_DIR" -maxdepth 1 -name '*.whispers.db' -printf '%f\n' 2>/dev/null \
  | sed -E 's/\.whispers\.db$//' | sort -r)
if [ "${#BACKUP_TIMESTAMPS[@]}" -gt "$KEEP_BACKUPS" ]; then
  for old in "${BACKUP_TIMESTAMPS[@]:$KEEP_BACKUPS}"; do
    log "Pruning old backup set $old"
    rm -f "$BACKUP_DIR/${old}.whispers.db" "$BACKUP_DIR/${old}.whispers.db-wal" "$BACKUP_DIR/${old}.whispers.db-shm"
  done
fi

# ---- 3. build the new image BEFORE stopping the running container -------
if docker image inspect "${IMAGE_REPO}:latest" >/dev/null 2>&1; then
  log "Tagging current image as ${IMAGE_REPO}:rollback"
  docker tag "${IMAGE_REPO}:latest" "${IMAGE_REPO}:rollback"
  HAVE_ROLLBACK_TARGET=true
else
  warn "No existing ${IMAGE_REPO}:latest image found — rollback will not be available if this deploy fails health checks."
  HAVE_ROLLBACK_TARGET=false
fi

log "Building new image (running container is untouched so far)..."
compose build

# ---- 4. recreate (create, don't start yet) then start -------------------
log "Recreating container..."
compose create --force-recreate

STATE_HAS_DB=false
if docker cp "$CONTAINER:$STATE_DIR_IN_CONTAINER/whispers.db" - >/dev/null 2>&1; then
  STATE_HAS_DB=true
fi

if [ "$STATE_HAS_DB" = false ] && [ -f "$BACKUP_DIR/${TIMESTAMP}.whispers.db" ]; then
  log "State volume is empty — seeding the legacy path from this run's backup so the app's boot-time migration (src/server/db.ts) adopts it into the volume."
  for f in whispers.db-wal whispers.db-shm whispers.db; do
    if [ -f "$BACKUP_DIR/${TIMESTAMP}.${f}" ]; then
      docker cp "$BACKUP_DIR/${TIMESTAMP}.${f}" "$CONTAINER:$LEGACY_DATA_DIR_IN_CONTAINER/$f"
    fi
  done
fi

log "Starting container..."
compose start

# ---- 5. health-check --------------------------------------------------
log "Waiting for /healthz (up to ${HEALTH_TIMEOUT_SECS}s)..."
DEADLINE=$((SECONDS + HEALTH_TIMEOUT_SECS))
STATUS="starting"
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  STATUS="$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "unknown")"
  if [ "$STATUS" = "healthy" ]; then
    break
  fi
  if [ "$STATUS" = "unhealthy" ]; then
    break
  fi
  sleep 2
done

if [ "$STATUS" = "healthy" ]; then
  log "Deploy succeeded. Commit $DEPLOY_SHA is live and healthy."
  exit 0
fi

# ---- 6. roll back loudly on health-check failure -------------------------
echo "########################################################################" >&2
echo "[deploy] DEPLOY FAILED HEALTH CHECK (status: $STATUS) — ROLLING BACK" >&2
echo "########################################################################" >&2

if [ "$HAVE_ROLLBACK_TARGET" != true ]; then
  die "No rollback image is available. The failed container has been left running for inspection — see 'docker logs $CONTAINER'. Database backup for this run: $BACKUP_DIR/${TIMESTAMP}.whispers.db*"
fi

log "Stopping failed container..."
compose stop || true

log "Rolling back to ${IMAGE_REPO}:rollback (previous image, current database volume kept as-is)..."
WHISPERS_IMAGE_TAG=rollback compose up -d --no-build

ROLLBACK_DEADLINE=$((SECONDS + HEALTH_TIMEOUT_SECS))
ROLLBACK_STATUS="starting"
while [ "$SECONDS" -lt "$ROLLBACK_DEADLINE" ]; do
  ROLLBACK_STATUS="$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "unknown")"
  [ "$ROLLBACK_STATUS" = "healthy" ] && break
  [ "$ROLLBACK_STATUS" = "unhealthy" ] && break
  sleep 2
done

if [ "$ROLLBACK_STATUS" = "healthy" ]; then
  echo "[deploy] Rollback succeeded — previous version is live and healthy. Commit $DEPLOY_SHA did NOT deploy." >&2
else
  echo "[deploy] ROLLBACK ALSO FAILED (status: $ROLLBACK_STATUS). Manual intervention required — see DEPLOY.md's rollback-by-hand section." >&2
fi

echo "[deploy] Database backup for this run, if you need it: $BACKUP_DIR/${TIMESTAMP}.whispers.db*" >&2
exit 1
