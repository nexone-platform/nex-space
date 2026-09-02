#!/usr/bin/env bash
# Everything worth knowing before pushing, run locally:
#
#   ./scripts/preflight.sh           checks; the e2e suites run if the dev servers are up
#   ./scripts/preflight.sh --quick   skip the production web build (the slow part)
#
# The checks are the failures this project has actually shipped: a type error, a
# new API route with no nginx block (it answers index.html with a 200 in
# production and nothing can parse it), a Thai string with no English, a theme the
# API would refuse, and a Prisma schema that does not parse.
set -uo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
say()  { printf '\n%s\n' "${BOLD}==>${OFF} $*"; }
ok()   { printf '%s\n' "  ${GREEN}ok${OFF}    $*"; }
warn() { printf '%s\n' "  ${YELLOW}warn${OFF}  $*"; }
bad()  { printf '%s\n' "  ${RED}fail${OFF}  $*" >&2; fails=$((fails + 1)); }

QUICK=0
for arg in "$@"; do
  case "$arg" in
    --quick)   QUICK=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

fails=0
run() { # run <label> <command...>
  local label="$1"; shift
  local out
  if out=$("$@" 2>&1); then ok "$label"; else
    bad "$label"
    printf '%s\n' "$out" | tail -15 | sed 's/^/        /' >&2
  fi
}

# ------------------------------------------------------------------- typecheck
say "Types"
run "web typechecks"         npm run --silent -w @nexspace/web check --if-present
[ -f apps/web/tsconfig.json ] && run "web tsc" npx --prefix apps/web tsc -p apps/web --noEmit
run "api typechecks"         npx tsc -p apps/api --noEmit
run "game server typechecks" npx tsc -p apps/game-server --noEmit

# ---------------------------------------------------------------------- schema
say "Database schema"
# validate only parses the schema, but it still refuses to start without the URL
# the datasource names, so a throwaway one is passed in
run "prisma schema is valid" env DATABASE_URL="file:./preflight.db"   npx --prefix apps/api prisma validate --schema apps/api/prisma/schema.prisma

# --------------------------------------------------------------- translations
say "Translations"
if out=$(node apps/web/scripts/i18n-coverage.mjs 2>&1); then
  ok "every Thai string has an English entry ($(echo "$out" | grep -oE 'dictionary entries: *[0-9]+' | grep -oE '[0-9]+') in the dictionary)"
else
  bad "missing English translations"
  echo "$out" | grep '^no EN' | head -10 | sed 's/^/        /' >&2
fi

# -------------------------------------------------------------- routing/nginx
# Every API prefix the client can reach needs an nginx location block. Without
# one, production answers index.html with a 200 and the caller sees HTML where it
# expected JSON — silent, and it has happened here.
say "Production routing"
missing=""
for prefix in $(grep -oE 'app\.(get|post|put|patch|delete)\("/[a-z-]+' apps/api/src/index.ts \
                | grep -oE '"/[a-z-]+' | tr -d '"' | sort -u); do
  grep -qE "location (= )?${prefix}" apps/web/nginx.conf || missing="$missing $prefix"
done
if [ -z "$missing" ]; then
  ok "every API route has an nginx block"
else
  bad "no nginx location block for:$missing"
  echo "        add one to apps/web/nginx.conf or it 404s (as HTML) in production" >&2
fi

# a layout the API would refuse can never be created, so the two lists must agree
web_themes=$(grep -oE '^  (classic|departments|office):' apps/web/src/scenes/mapThemes.ts | tr -d ' :' | sort | xargs)
api_themes=$(grep -oE 'const THEMES = \[[^]]*\]' apps/api/src/index.ts | grep -oE '"[a-z]+"' | tr -d '"' | sort | xargs)
if [ "$web_themes" = "$api_themes" ]; then
  ok "theme whitelists agree ($web_themes)"
else
  bad "theme lists differ — web: [$web_themes]  api: [$api_themes]"
fi

# ------------------------------------------------------------------- the relay
# The relay checker is the only thing that can tell a working TURN server from a
# configured one, so it has to be known-good before anyone trusts its verdict.
# This runs it against a mock that lies in four different ways.
# Two failures have reached the server through this file — a required-variable
# guard that blocked every compose command, and a deleted volumes: block. Both
# are structural, and neither needs docker to catch.
say "Compose file"
if out=$(node scripts/compose-check.mjs 2>&1); then
  ok "docker-compose.yml — $(echo "$out" | grep -oE '[0-9]+ passed, [0-9]+ failed' | tail -1)"
else
  bad "docker-compose.yml would be refused by docker"
  echo "$out" | grep -E '^! FAIL' | head -6 | sed 's/^/        /' >&2
fi

# A few rules have to hold in more than one app, and the three apps build from
# separate Docker contexts so none can import from another. Copies plus a guard.
say "Duplicated files"
if out=$(node scripts/copies-check.mjs 2>&1); then
  ok "$(echo "$out" | tail -1)"
else
  bad "a duplicated file has drifted from its twin"
  echo "$out" | sed 's/^/        /' >&2
fi

# The editor offers whatever this list says exists. A prop it offers that is not
# on disk 404s in the palette and again in every browser the saved map reaches.
say "Asset catalogue"
if out=$(node scripts/asset-catalogue.mjs --check 2>&1); then
  ok "$out"
else
  bad "the editor's prop catalogue is out of date"
  echo "$out" | sed 's/^/        /' >&2
fi

say "Relay checker"
if out=$(node scripts/turn-check.test.mjs 2>&1); then
  ok "turn-check — $(echo "$out" | grep -oE '[0-9]+ passed, [0-9]+ failed' | tail -1)"
else
  bad "turn-check is broken — its verdict cannot be trusted"
  echo "$out" | grep -E '^! FAIL|passed,' | head -8 | sed 's/^/        /' >&2
fi

# The credential minter and the relay must be told the same secret, and the
# browser must be told a host it can actually reach. Half a configuration is the
# worst case: it looks set up and relays nothing.
if [ -f .env ]; then
  turn_secret=$(grep -E '^TURN_SECRET=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
  turn_host=$(grep -E '^TURN_HOST=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ -n "$turn_secret" ] && [ -n "$turn_host" ]; then
    ok "relay configured ($turn_host) — run: node scripts/turn-check.mjs"
  elif [ -z "$turn_secret" ] && [ -z "$turn_host" ]; then
    warn "no relay configured — calls fail for anyone behind a strict firewall"
  else
    bad "half a relay: TURN_SECRET and TURN_HOST must both be set"
  fi
fi

# ----------------------------------------------------------------------- build
if [ "$QUICK" = 0 ]; then
  say "Production build"
  run "web builds" npm run --silent build -w @nexspace/web
else
  say "Production build"
  warn "skipped (--quick)"
fi

# ------------------------------------------------------------------------ e2e
# These talk to a running API and game server, so they are skipped rather than
# failed when the dev stack is down.
say "End-to-end suites"
if curl -sf --max-time 2 http://localhost:3001/health >/dev/null 2>&1; then
  for suite in roles desk guests totp ice chat dm profile presence areas map stats emote roles2 files calendar invite invited; do
    if out=$(npm run --silent "test:$suite" -w @nexspace/api 2>&1); then
      ok "$suite — $(echo "$out" | grep -oE '[0-9]+ passed, [0-9]+ failed' | tail -1)"
    else
      bad "$suite"
      echo "$out" | grep -E '^! FAIL|passed,' | head -8 | sed 's/^/        /' >&2
    fi
  done
else
  warn "skipped — no API on :3001 (start it with npm run dev)"
fi

# ------------------------------------------------------------------ repo state
say "Repository"
if [ -n "$(git status --porcelain)" ]; then
  warn "uncommitted changes — they will not be deployed"
  git status --short | sed 's/^/        /'
else
  ok "working tree is clean"
fi
ahead=$(git rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 0)
[ "$ahead" -gt 0 ] && warn "$ahead commit(s) not pushed — the server pulls from the remote" || ok "in sync with the remote"

echo
if [ "$fails" -gt 0 ]; then
  printf '%s\n' "${RED}${fails} check(s) failed${OFF} — fix these before deploying" >&2
  exit 1
fi
printf '%s\n' "${GREEN}ready to deploy${OFF} — push, then run ./scripts/deploy.sh on the server"
