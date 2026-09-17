# Deploying Whispers

Production runs as a docker-compose service named `whispers-server` on the
Hetzner box (`multiverse-games-hel1`, ssh alias `games`), fronted by
Traefik, at `/opt/whispers`, serving `https://play.multiversestudios.xyz/whispers/`.

## The problem this process solves

The container's `/app/data` holds two unrelated things: static content
baked into the image at build time (`data/scenarios/`, `data/dm-presets/`,
`data/systems/`) and, until this change, the live SQLite database. With no
volume mounted there, every `docker compose up --build` destroyed the
database along with the old container.

The fix has two parts:

- The app now reads the database location from `STATE_DIR` (defaults to
  `DATA_DIR`, so local dev is unaffected), separate from the static content
  in `DATA_DIR`. See `src/server/db.ts`.
- `docker-compose.prod.yml` mounts a named volume (`whispers_state`) at
  `STATE_DIR` (`/app/state`) only — `DATA_DIR` (`/app/data`) is left alone
  so the image's static content is never shadowed.
- A boot-time migration in `db.ts` (`migrateLegacyDatabase`) moves an
  existing database from the old `DATA_DIR` location onto the new
  `STATE_DIR` volume the first time it finds one there. It's a no-op on
  every later boot.

## One-time setup: converting `/opt/whispers` to a git clone

`/opt/whispers` is currently an rsync'd copy of someone's working tree, not
a git checkout, and `deploy.sh` requires a git checkout (it deploys from
`origin/main` of https://github.com/lizTheDeveloper/whispers, never from a
working tree). Do this **once**, by hand, on the server:

```bash
ssh games
cd /opt

# Preserve what must survive the swap: existing backups, and the live
# .env if this host has one (multiverse-games-hel1 does not — it gets its
# config from docker-compose.prod.yml, so the cp is expected to fail there).
mv whispers/backups whispers-backups.preserve
cp whispers/.env whispers-env.preserve 2>/dev/null || true

# Keep the old directory around as a fallback rather than deleting it.
mv whispers whispers.rsync-backup

# Clone the real thing.
git clone https://github.com/lizTheDeveloper/whispers.git whispers
cd whispers

# Restore what was preserved.
mv /opt/whispers-backups.preserve backups
cp /opt/whispers-env.preserve .env 2>/dev/null || true
chmod +x deploy.sh

# Sanity check before trusting it: nothing should differ except files that
# were never tracked (.env, backups/, node_modules/, dist/, data/*.db*).
diff -rq --exclude=.git --exclude=node_modules --exclude=dist \
  --exclude=backups --exclude='*.db*' --exclude=.env \
  /opt/whispers.rsync-backup /opt/whispers || true
```

Only delete `/opt/whispers.rsync-backup` after a deploy has succeeded and
you've confirmed the site is healthy.

## Running a deploy

```bash
ssh games
cd /opt/whispers
./deploy.sh
```

What it does, in order — see the comment header in `deploy.sh` for the full
detail:

1. `git fetch` + fast-forward-only merge of `main` from the public repo,
   and prints the commit SHA it's deploying. It never touches `.env`
   (which is untracked/gitignored, and the script never runs `git clean`
   or `reset --hard`) and it refuses to proceed (rather than force-reset)
   if the checkout has diverged from `origin/main`.
2. Backs up the live database — from whichever of the new (`/app/state`)
   or legacy (`/app/data`) in-container path currently has it — into
   `backups/<timestamp>.whispers.db{,-wal,-shm}`, then prunes to the most
   recent 14 backup sets (override with `WHISPERS_KEEP_BACKUPS`).
3. Tags the current image `whispers-server:rollback`, then builds the new
   image. The running container is not touched until this succeeds, so a
   broken build never causes downtime.
4. Recreates the container (`docker compose create --force-recreate`, so
   the app process doesn't run yet) and, only if the state volume turns
   out to be empty, seeds the legacy path from the backup just taken so
   the app's own boot-time migration adopts it into the volume. Then
   starts it.
5. Polls the image's built-in `HEALTHCHECK` (which hits `/healthz`) for up
   to 120 seconds (override with `WHISPERS_HEALTH_TIMEOUT_SECS`).
6. If it never reports healthy, **rolls back loudly** to
   `whispers-server:rollback` and exits non-zero, printing the failure to
   stderr. It does **not** roll back the database — see below.

Safe to run twice in a row: every step either no-ops or repeats harmlessly
if the previous run already got there (see the comment header in
`deploy.sh` for the reasoning behind each step's idempotency).

## What this process does NOT cover

Be honest about the gaps:

- **The pre-swap database backup is a best-effort hot copy**, not a
  transactionally consistent snapshot — it's a `docker cp` of the live
  files while the app may still be writing. Sidecars are copied before the
  main `.db` file specifically to bias any race toward "harmless stale
  orphan WAL" rather than "lost data," but it is not a guarantee. For a
  guaranteed-consistent backup, stop the container first.
- **Rollback restores the previous image, not the previous database.** If
  a bad deploy corrupts data (as opposed to just failing to boot), you
  need to restore a backup by hand (below) — `deploy.sh` won't do it for
  you, because guessing which backup is "correct" after a partial write is
  not something to automate.
- **No automatic backup restore path exists yet.** Restoring is a manual
  procedure (below).
- `deploy.sh` assumes Compose v2 (`docker compose`, not `docker-compose`)
  and GNU coreutils/findutils (this is fine on the actual Linux host; it
  will not run correctly on macOS as-is).
- This has **not been run against the actual server** — it was written and
  tested against the migration logic and compose config locally. The first
  real run should be watched closely.

## Backups

Location: `/opt/whispers/backups/<UTC timestamp>.whispers.db`,
`.whispers.db-wal`, `.whispers.db-shm`. The 14 most recent timestamps are
kept; older ones are deleted automatically by `deploy.sh`.

## Rolling back by hand

If `deploy.sh`'s automatic rollback didn't run (e.g. you're undoing a
deploy that "succeeded" but is behaviorally wrong) or you need to also
restore data:

```bash
ssh games
cd /opt/whispers

# 1. Roll back the image only (keeps the current database):
docker compose -f docker-compose.prod.yml stop
WHISPERS_IMAGE_TAG=rollback docker compose -f docker-compose.prod.yml up -d --no-build

# 2. If you also need to restore the database from a backup:
docker compose -f docker-compose.prod.yml stop
ls backups/   # pick a timestamp
docker cp backups/<timestamp>.whispers.db     whispers-server:/app/state/whispers.db
docker cp backups/<timestamp>.whispers.db-wal whispers-server:/app/state/whispers.db-wal
docker cp backups/<timestamp>.whispers.db-shm whispers-server:/app/state/whispers.db-shm
docker compose -f docker-compose.prod.yml start
docker inspect --format '{{.State.Health.Status}}' whispers-server
```

Note `whispers-server:rollback` only exists after at least one `deploy.sh`
run has tagged it — it's overwritten by the *next* successful deploy, so it
always reflects "the image before the most recent deploy," not a deep
history.
