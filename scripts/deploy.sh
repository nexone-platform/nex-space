#!/usr/bin/env bash
# Deploy NexSpace on the server. Run from anywhere inside the repo:
#
#   ./scripts/deploy.sh              pull, rebuild what changed, verify
#   ./scripts/deploy.sh --all        rebuild all three images
#   ./scripts/deploy.sh --check      only run the checks against what is running
#   ./scripts/deploy.sh --no-pull    deploy the working tree as it is
#   ./scripts/deploy.sh --dry-run    say what it would do, then stop
#
# Only the services whose files moved get rebuilt: the web image carries ~386 MB
# of avatar sprites, and rebuilding it for an API change costs minutes for
# nothing. Once the containers are up it checks the things that have actually
# broken deploys here — a Prisma client that no longer matches the schema, a new
# API route with no nginx block, a container stuck restarting.
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
say()  { printf '%s\n' "${BOLD}==>${OFF} $*"; }
ok()   { printf '%s\n' "  ${GREEN}ok${OFF}    $*"; }
warn() { printf '%s\n' "  ${YELLOW}warn${OFF}  $*"; }
die()  { printf '%s\n' "  ${RED}fail${OFF}  $*" >&2; exit 1; }

PULL=1; ALL=0; DRY=0; CHECK=0
for arg in "$@"; do
  case "$arg" in
    --all)     ALL=1 ;;
    --no-pull) PULL=0 ;;
    --dry-run) DRY=1 ;;
    --check)   CHECK=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         die "unknown option: $arg (try --help)" ;;
  esac
done

# ---------------------------------------------------------------- preconditions
[ -f docker-compose.yml ] || die "no docker-compose.yml here — is this the NexSpace repo?"
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "docker compose is not installed"
fi
[ -f .env ] || warn ".env is missing — Google sign-in, SMTP and LiveKit stay off"

BEFORE=$(git rev-parse HEAD)
SERVICES=""

if [ "$CHECK" = 1 ]; then
  say "Checking what is already running (no pull, no build)"
else
  # ----------------------------------------------------------------- what moved
  # Each image is stamped at build time with the commit it came from, so the
  # question "what is deployed?" is answered by the containers themselves. A state
  # file next to the repo cannot answer it: a run that fails its checks never
  # writes one, --check deliberately does not, and pulling by hand before running
  # this moves HEAD out from under it. The stamp survives all three.
  deployed_rev() { # deployed_rev <service>
    local rev
    rev=$($DC images -q "$1" 2>/dev/null | head -1)
    [ -n "$rev" ] || return 0
    rev=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$rev" 2>/dev/null || true)
    git cat-file -e "${rev}^{commit}" 2>/dev/null && printf '%s' "$rev"
  }

  if [ "$PULL" = 1 ]; then
    say "Pulling"
    git pull --ff-only
  else
    say "Skipping the pull (--no-pull)"
  fi
  AFTER=$(git rev-parse HEAD)

  SERVICES=""
  if [ "$ALL" = 1 ]; then
    SERVICES="nexspace-api nexspace-game nexspace-web"
  else
    # a change to any of these can affect every image
    SHARED=$(git diff --name-only "$BEFORE" "$AFTER" 2>/dev/null \
      | grep -E '^(docker-compose\.yml|\.dockerignore|package(-lock)?\.json)$' || true)
    for svc in nexspace-api nexspace-game nexspace-web; do
      case "$svc" in
        nexspace-api)  path=apps/api ;;
        nexspace-game) path=apps/game-server ;;
        nexspace-web)  path=apps/web ;;
      esac
      rev=$(deployed_rev "$svc" || true)
      if [ -z "$rev" ]; then
        SERVICES="$SERVICES $svc"                       # never stamped, or not built yet
        warn "$svc carries no commit stamp — rebuilding it"
      elif [ "$rev" != "$AFTER" ] && { [ -n "$SHARED" ] || [ -n "$(git diff --name-only "$rev" "$AFTER" -- "$path")" ]; }; then
        SERVICES="$SERVICES $svc"
      fi
    done
    SERVICES=$(echo "$SERVICES" | xargs || true)
    if [ -z "$SERVICES" ]; then
      say "Everything running is already built from $(git log -1 --format='%h %s')"
      echo "  nothing to rebuild — pass --all to force one anyway"
      exit 0
    fi
  fi

  # The realtime schema is shared with the client, so a field added to it reaches
  # browsers only once the game image is rebuilt — until then the client reads
  # undefined, quietly.
  GAME_REV=$(deployed_rev nexspace-game || true)
  if [ -n "$GAME_REV" ] && [ -n "$(git diff --name-only "$GAME_REV" "$AFTER" -- apps/game-server/src/schema.ts)" ] \
     && ! echo "$SERVICES" | grep -q nexspace-game; then
    SERVICES="$SERVICES nexspace-game"
    warn "the Colyseus schema changed — adding nexspace-game to the rebuild"
  fi

  say "Deploying $(git log -1 --format='%h %s')"
  for svc in $SERVICES; do
    rev=$(deployed_rev "$svc" || true)
    if [ -n "$rev" ] && [ "$rev" != "$AFTER" ]; then
      echo "  $svc: $(git log -1 --format=%h "$rev") -> $(git log -1 --format=%h "$AFTER")"
    else
      echo "  $svc: rebuilding"
    fi
  done


  if [ "$DRY" = 1 ]; then
    say "Dry run — stopping here"
    exit 0
  fi

  # ----------------------------------------------------- back up before the API
  # The API runs `prisma db push` at start-up. New tables and nullable columns
  # are safe; anything else is not, and this copy is the only way back.
  if echo "$SERVICES" | grep -q nexspace-api && $DC ps 2>/dev/null | grep -q nexspace-api; then
    mkdir -p backups
    STAMP=$(date +%Y%m%d-%H%M%S)
    if $DC cp nexspace-api:/app/apps/api/data/prisma/prod.db "backups/prod-$STAMP.db" >/dev/null 2>&1; then
      ok "database backed up to backups/prod-$STAMP.db"
      ls -1t backups/prod-*.db 2>/dev/null | tail -n +11 | xargs -r rm -- || true
    else
      warn "no database to copy yet — first deploy?"
    fi
  fi

  # ---------------------------------------------------------------------- build
  say "Building and starting"
  # stamped into each image so the next run can tell what is deployed
  export GIT_SHA="$AFTER"
  # shellcheck disable=SC2086
  $DC up -d --build $SERVICES
fi

# --------------------------------------------------------------------- settling
say "Waiting for the containers to settle"
DEADLINE=$((SECONDS + 180))
while :; do
  BAD=""
  for svc in nexspace-api nexspace-game nexspace-web; do
    state=$($DC ps --format '{{.Name}} {{.State}}' 2>/dev/null | awk -v s="$svc" '$1 == s { print $2 }')
    [ "$state" = "running" ] || BAD="$BAD $svc(${state:-missing})"
  done
  [ -z "$BAD" ] && break
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    printf '%s\n' "  ${RED}fail${OFF}  still not healthy:$BAD" >&2
    say "Recent logs"
    $DC logs --tail 40 nexspace-api nexspace-game nexspace-web || true
    die "did not come up. Retry with ./scripts/deploy.sh --no-pull --all, or go back with git checkout $BEFORE"
  fi
  sleep 3
done
ok "all three containers are running"

# -------------------------------------------------------------------- verifying
fails=0

# "running" only means the entrypoint started. The API spends its first half
# minute in `prisma db push` and `prisma generate` before it listens, so a check
# fired the moment the container is up gets ECONNREFUSED — and nginx, asked in the
# same breath, answers 502. Each check therefore gets a window to come good in.
READY_WINDOW=${READY_WINDOW:-120}

check() { # check <label> <command...>
  local label="$1"; shift
  local out waited=0 deadline=$((SECONDS + READY_WINDOW))
  while :; do
    if out=$("$@" 2>&1); then
      [ "$waited" -gt 0 ] && printf '\r%*s\r' 78 ""
      if [ "$waited" -gt 0 ]; then
        ok "$label${out:+ - $out} (ready after ${waited}s)"
      else
        ok "$label${out:+ - $out}"
      fi
      return
    fi
    [ "$SECONDS" -ge "$deadline" ] && break
    sleep 3
    waited=$((waited + 3))
    printf '\r  ...   %s - waiting (%ss of %ss)' "$label" "$waited" "$READY_WINDOW"
  done
  [ "$waited" -gt 0 ] && printf '\r%*s\r' 78 ""
  printf '%s\n' "  ${RED}fail${OFF}  $label" >&2
  [ -n "$out" ] && printf '%s\n' "        $out" >&2
  fails=$((fails + 1))
}

# 127.0.0.1, never "localhost". Inside these containers localhost resolves to ::1
# first while the servers bind IPv4 only, so every probe came back "connection
# refused" against a stack that was working perfectly.
API_HEALTH='fetch("http://127.0.0.1:3001/health").then(r => r.json()).then(d => { if (!d.ok) { console.error(JSON.stringify(d)); process.exit(1); } }).catch(e => { console.error(String(e && e.cause || e)); process.exit(1); })'

# The failure that has silently broken this deployment before: a data volume
# mounted over apps/api/prisma leaves the generated client on an older schema, so
# new models come back undefined at runtime while every step reports success.
SCHEMA_MATCH='const fs = require("fs"); const { Prisma } = require("@prisma/client"); const want = [...fs.readFileSync("prisma/schema.prisma", "utf8").matchAll(/^model\s+(\w+)/gm)].map(m => m[1]); const have = new Set(Prisma.dmmf.datamodel.models.map(m => m.name)); const missing = want.filter(m => !have.has(m)); if (missing.length) { console.error("client is missing: " + missing.join(", ")); process.exit(1); } process.stdout.write(want.length + " models")'

GAME_UP='fetch("http://127.0.0.1:2567/").then(r => { if (r.status >= 500) { console.error("status " + r.status); process.exit(1); } }).catch(e => { console.error(String(e && e.cause || e)); process.exit(1); })'

# Every API route needs its own nginx block. Without one the request falls through
# to the SPA and comes back as index.html with a 200, which no caller can parse.
# An unknown pass must answer 404, so a 200 means nginx served the app instead.
# The status line is what gets read, not the body: the wget in nginx:alpine is
# busybox, and it prints no body at all for an error status.
GUEST_ROUTE='out=$(wget -S -O /dev/null http://127.0.0.1/guest-pass/__probe__ 2>&1 || true); case "$out" in *404*) exit 0 ;; *200*) echo "answered 200 - nginx served the SPA, the location block is missing"; exit 1 ;; *) echo "no usable answer: $(echo "$out" | tr -d "\n" | cut -c1-110)"; exit 1 ;; esac'
API_VIA_NGINX='wget -qO- http://127.0.0.1/health 2>/dev/null | grep -q ok || { echo "no JSON from /health through nginx"; exit 1; }'
WEB_SERVES='wget -qO- http://127.0.0.1/ 2>/dev/null | grep -q "<title>" || { echo "index.html did not come back"; exit 1; }'

say "Verifying (a service still starting gets up to ${READY_WINDOW}s to answer)"
check "API answers /health"                     $DC exec -T nexspace-api  node -e "$API_HEALTH"
check "Prisma client matches schema.prisma"     $DC exec -T nexspace-api  node -e "$SCHEMA_MATCH"
check "game server is listening"                $DC exec -T nexspace-game node -e "$GAME_UP"
check "nginx proxies /guest-pass to the API"    $DC exec -T nexspace-web  sh -c "$GUEST_ROUTE"
check "nginx reaches the API from the app host" $DC exec -T nexspace-web  sh -c "$API_VIA_NGINX"
check "web serves the app"                      $DC exec -T nexspace-web  sh -c "$WEB_SERVES"

echo
if [ "$fails" -gt 0 ]; then
  say "Recent API logs"
  $DC logs --tail 30 nexspace-api || true
  die "$fails check(s) failed. To go back: git checkout $BEFORE && ./scripts/deploy.sh --no-pull --all"
fi

say "${GREEN}$([ "$CHECK" = 1 ] && echo 'All checks passed' || echo 'Deployed')${OFF} $(git log -1 --format='%h %s')"
$DC ps
echo
echo "  smoke test:  DEPLOY.md, \"Smoke test after deploying\""
echo "  logs:        $DC logs -f nexspace-api"
