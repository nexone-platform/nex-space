# Deploying NexSpace

Three containers behind one nginx (`docker-compose.yml`):

| service | role | port |
|---|---|---|
| `nexspace-web` | nginx serving the built client + reverse-proxying the others | 8087 → 80 |
| `nexspace-game` | Colyseus rooms + LiveKit token minting | 2567 |
| `nexspace-api` | auth, workspaces, avatars, maps (SQLite on a named volume) | 3001 |

The client always calls the API and game server **same-origin** (`/auth`, `/me`,
`/workspaces`, `/guest-pass`, `/colyseus`, `/livekit`), so nginx must keep those
`location` blocks. Anything new on the API needs a matching block — without one
the request falls through to the SPA and comes back as `index.html` with a
**200**, so the caller sees HTML where it expected JSON and nothing looks like an
error. `npm run preflight` compares the two lists and fails if one is missing.

---

## Deploy

Two scripts. Run the first on your machine before pushing, the second on the
server.

```bash
npm run preflight          # local: types, translations, routing, build, e2e
./scripts/deploy.sh        # server: pull, rebuild what changed, verify
```

`scripts/preflight.sh` checks the things this project has actually shipped
broken: a type error, a **new API route with no nginx block** (production answers
`index.html` with a 200 and nothing can parse it), a Thai string with no English,
a theme the API would refuse, and a Prisma schema that does not parse. It also
runs the API's e2e suites when a dev server is up, and says what is uncommitted
or unpushed. `--quick` skips the production build.

`scripts/deploy.sh` pulls, works out which images the new commits actually
affect, backs the database up before the API restarts, rebuilds, waits for all
three containers to report `running`, and then verifies.

It works out what to rebuild by **asking the containers what they are**: every
image carries the commit it was built from as an OCI revision label, and each
service is rebuilt only when the files under its own directory moved between that
commit and HEAD. So an API-only change never pays for the 386 MB web image, and
pulling by hand before running the script — or a run that failed its checks
earlier — cannot confuse it. An image with no stamp is rebuilt, which is what
makes the first run after this change build all three.

The checks:

| check | what it catches |
|---|---|
| API `/health` | the API is up at all |
| Prisma client vs `schema.prisma` | the volume-shadowing failure below — new models missing at runtime |
| game server listening | a Colyseus crash loop |
| `/guest-pass` answers 404, not 200 | an API route with no nginx block, silently served as the SPA |
| `/health` through nginx | the proxy chain itself |
| web serves `index.html` | a bad nginx config or an empty build |

Options: `--all` (rebuild everything), `--check` (run only the checks against
what is already running), `--no-pull` (deploy the tree as it is), `--dry-run`
(say what it would do). On failure it prints the logs and the exact command to go
back.

The probes address the containers as `127.0.0.1`, never `localhost`: inside these
images `localhost` resolves to `::1` first while the servers bind IPv4 only, so
every check reports "connection refused" against a stack that is working.

Each check also gets up to 120s to come good (`READY_WINDOW` to change it). A
container reads `running` the moment its entrypoint starts, but the API spends its
first half minute in `prisma db push` and `prisma generate` before it listens —
asked any earlier it answers ECONNREFUSED, and nginx answers 502 on its behalf.

Doing it by hand instead:

```bash
git pull
docker compose up -d --build
```

Rebuild only what changed if you prefer:

| changed | rebuild |
|---|---|
| `apps/web/**` (client, assets, nginx.conf) | `docker compose up -d --build nexspace-web` |
| `apps/game-server/**` (rooms, schema) | `docker compose up -d --build nexspace-game` |
| `apps/api/**`, `prisma/schema.prisma` | `docker compose up -d --build nexspace-api` |

The realtime schema (`apps/game-server/src/schema.ts`) is shared with the client:
a field added there reaches browsers only once **nexspace-game** is rebuilt, and
until then the client reads `undefined` rather than getting an error. The deploy
script adds that service to the rebuild by itself when the schema moved.

The API runs `prisma db push` on every start, so schema changes apply
themselves. Adding tables and nullable columns is non-destructive; **renaming or
dropping** a column is not — dump the volume first if you ever do that.

### The data volume must not cover apps/api/prisma

`nexspace-api-data` mounts at **`/app/apps/api/data`**, deliberately not at
`/app/apps/api/prisma`.

A volume mounted over the prisma directory hides the image's `schema.prisma`
behind the copy Docker seeds into the volume on the very first deploy. Every
later start then reads that frozen schema: `prisma db push` reports "already in
sync" (old schema vs old database — quite true), and the runtime
`prisma generate` overwrites the correct client built into the image with one
generated from the stale file. New columns simply do not exist as far as the
running code is concerned, and requests fail with things like
`Argument 'passwordHash' is missing`. Rebuilding, even `--no-cache`, cannot fix
it, because the damage happens at container start.

**One-time move for an existing deployment.** The database is already at
`prisma/prod.db` *inside* the volume, so remounting the same volume at `./data`
leaves it exactly where `DATABASE_URL` now points — no copying needed. Confirm
before and after:

```bash
# before: where is the live database?
docker compose exec nexspace-api ls -l /app/apps/api/prisma/prisma/

# take a backup anyway
docker compose cp nexspace-api:/app/apps/api/prisma/prisma/prod.db ./prod.db.backup

git pull && docker compose up -d --build nexspace-api

# after: same file, now reached through ./data
docker compose exec nexspace-api ls -l /app/apps/api/data/prisma/
```

Then check the client actually matches the schema — this is the thing that was
silently wrong:

```bash
docker compose exec nexspace-api node -e "const{Prisma}=require('@prisma/client');console.log(Prisma.dmmf.datamodel.models.find(m=>m.name==='User').fields.map(f=>f.name).join(', '))"
```

It must list `googleId`, `photoUrl`, `role`, `companySize` and `desk`. If it
stops at `avatar, createdAt`, something is still shadowing the schema.

## Check it came up

```bash
docker compose ps
docker compose logs --tail 30 nexspace-api
```

`nexspace-api` should print `NexSpace API on http://localhost:3001` and no
Prisma engine errors. All three must read `Up`, not `Restarting`.

---

## Optional configuration

Put these in a `.env` next to `docker-compose.yml`. **Everything below is
optional** — without it the app still runs, it just loses that feature.

### Google sign-in

1. Open <https://console.cloud.google.com/apis/credentials> and create an
   **OAuth client ID** of type *Web application*.
2. Under **Authorised redirect URIs** add exactly this — it must match
   character for character, including the scheme:

   ```
   https://nexspace.xy789.click/auth/google/callback
   ```

   (For a local run add `http://localhost:3001/auth/google/callback` too.)
3. Put the client id and secret in the `.env` next to `docker-compose.yml`:

   ```dotenv
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```
4. `docker compose up -d --build nexspace-api nexspace-web` and reload the site.
   The "Continue with Google" button appears once `/auth/config` reports
   `{"google":true}` — it hides itself while the credentials are blank.

The redirect URI is derived from the `X-Forwarded-Proto` / `X-Forwarded-Host`
headers. nginx passes through whatever the outer proxy sent and only falls back
to its own `$scheme`, which matters here because TLS terminates upstream: taking
`$scheme` directly would build an `http://` redirect that Google rejects.

If a different proxy chain still produces the wrong URI, pin it:

```dotenv
APP_URL=https://nexspace.xy789.click/
OAUTH_REDIRECT_URL=https://nexspace.xy789.click/auth/google/callback
```

Signing in with Google matches on email address, so an account that already
exists keeps its workspaces, desks and avatar.

**Running it locally** needs no `APP_URL`. The web app tells the API which origin
to hand the token back to, so the sign-in returns to the dev server on 5173 rather
than to the API's own root on 3001 — which is where it used to land, as a bare
"Cannot GET /" with the session sitting in the URL. The API only honours that
answer for the host it was reached on, the configured `APP_URL`, or a loopback
address; anything else is refused and it falls back, because a token in a redirect
is a session and "send it here" cannot be taken on trust.

### Email sign-in codes
```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=<16-character app password>
SMTP_FROM=NexSpace <you@gmail.com>
```

Gmail needs an **App Password**, not the account password. Left blank, codes are
written to the API log instead of emailed — fine for testing, not for real users:

```bash
docker compose logs -f nexspace-api | grep "sign-in code"
```

### Voice relay (TURN) — the one that fails silently

Without this, calls work at home and fail at the office. Two people can only hear
each other if at least one of them can accept a connection from the outside;
plenty of corporate networks allow neither. There is no error for it — the call
just never connects, and both people sit there saying "can you hear me?".

A relay is a machine both ends can reach outbound, which forwards their audio.
It costs bandwidth, so it is closed: coturn holds a secret, the API signs
short-lived passwords with the same secret, and nothing else gets in.

**1. Make a secret and put it in `.env`.**

```bash
openssl rand -hex 32
```

```dotenv
TURN_SECRET=<the 64 characters from above>
TURN_HOST=nexspace.xy789.click     # must resolve to THIS machine
```

`TURN_HOST` is what browsers dial directly — not through nginx — so it has to be
a name or address that reaches this server from the internet. If the machine sits
behind NAT and only knows a private address, add the public one:

```dotenv
TURN_EXTERNAL_IP=203.0.113.10
```

> **If this machine cannot receive UDP from the internet at all**, stop here and
> put the relay on its own VPS instead: [`deploy/turn/`](deploy/turn/README.md).
> A machine behind NAT that nobody will reconfigure is not a problem to be solved
> in this file — and a dedicated relay can also listen on 443 over TLS, which is
> the only thing that gets through the strictest corporate networks. The app side
> is then two lines of `.env` and no code change at all.

**1b. If the machine is behind NAT** — it does not hold its own public address.
Check with `ip -4 addr`: if the address there is a private one (10.x, 172.16–31.x,
192.168.x) while the world reaches you on something else, this applies.

```dotenv
TURN_LISTEN_IP=172.24.8.51                       # this machine's own address
TURN_EXTERNAL_IP=203.151.66.51/172.24.8.51       # public/private
```

Both matter, for different reasons:

- Without `TURN_LISTEN_IP`, coturn binds every address it can find — which on a
  docker host includes every bridge network. It will happily hand a caller a
  relay address on `172.22.0.1`, which nothing outside this machine can reach.
  `docker compose logs nexspace-turn` shows the full list it discovered; if that
  list is long, this setting is missing.
- `TURN_EXTERNAL_IP` in the `public/private` form tells coturn "when you would
  say 172.24.8.51, say 203.151.66.51 instead". Without it, callers are told to
  send their audio to an address that only exists inside your network.

**Port forwarding is a separate job.** `ufw` only controls what the machine
itself accepts; it cannot make the router hand the packets over. On a NAT'd host
the hypervisor, router, or provider firewall must forward to the private address:

| Port | Protocol | Why |
|---|---|---|
| 3478 | UDP and TCP | where callers ask for a relay |
| 49160–49260 | UDP | the relays themselves, one port per call |

Forgetting the second row is the subtle one: the check passes, calls still fail.

**2. Open the firewall.** This is the step that gets missed, and it fails in a way
that looks exactly like the relay not working at all:

```bash
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 49160:49260/udp     # one port per live call
```

**3. Start it.** The relay sits behind a compose profile, so a deployment without
a secret is not left with a container that cannot start:

```bash
docker compose --profile turn up -d nexspace-turn
docker compose up -d --build nexspace-api nexspace-web
```

**4. Prove it works** — from another machine, not this one, or the test proves
only that the server can reach itself:

```bash
node scripts/turn-check.mjs --host=nexspace.xy789.click --secret=<TURN_SECRET>
```

It does what a browser does: asks for a relay address with a freshly minted
credential, and then asks the relay to forward to `127.0.0.1` to confirm it
refuses. Five lines, all of which must say `ok`. Each failure names its own cause
— a closed port, a mismatched secret, a private address being advertised, or a
missing deny rule.

**What you get without it:** everything still works for anyone whose network
allows a direct path, which is most home connections. `/ice` answers
`{"relay": false}`, the browser uses STUN alone, and `./scripts/deploy.sh` prints
`call relay — STUN only` on every deploy so it cannot be forgotten quietly.

**Limits worth knowing.** Ports 3478 and 49160+ are open outbound on most networks
but not all; the strictest firewalls allow only 443. If you have a spare address,
moving the relay to 443 catches those too — that needs a second IP, because nginx
already holds 443 on this one. TLS (`turns:`) needs a certificate and is off
unless `TURN_TLS_PORT` is set.

### Chat history

Room chat is kept for 90 days and then swept. The sweep runs when the API starts
and once a day after that, so a deployment that restarts often still gets it and
one that runs for months does not skip it.

```dotenv
CHAT_KEEP_DAYS=90      # 0 keeps everything, and the file grows without end
```

Two things follow from where it is stored. It lives in the same SQLite file as
everything else, so it is included in whatever backs that file up — and it is the
part of the database that grows on its own, which makes it the first reason this
deployment will eventually want Postgres.

## Files in the chat

People can attach a picture or a document to any message — room chat, the
meeting composer, or a private thread — by the paperclip, by pasting, or by
dragging one in.

```dotenv
UPLOAD_MAX_BYTES=10000000   # 10 MB per file
UPLOAD_SECRET=              # blank is fine; see below
```

**The bytes live in the same volume as the database**, under
`apps/api/data/uploads`, filed by month. They are therefore included in whatever
backs that volume up — and they are the fastest-growing thing in it. A file is
removed when the message that showed it is swept, so `CHAT_KEEP_DAYS` above is
also how long a shared file is kept; anything uploaded but never sent is swept
after a day.

**There is no per-person quota.** Anybody who may talk in a space may upload, and
nothing stops one account from doing it repeatedly. On a private company
deployment that is a housekeeping matter rather than an attack, but it is the
reason to watch the volume rather than assume it:

```bash
docker compose exec nexspace-api du -sh /app/apps/api/data/uploads
```

**`UPLOAD_SECRET` signs the links that open a file.** Left blank, one is
generated on first use and kept in the volume, which survives restarts — that is
the right answer for a single API container. Set it explicitly if you ever run
more than one, or every container would sign links the others reject.

**nginx has its own body limit** and it must stay above `UPLOAD_MAX_BYTES`, or it
refuses the upload with its own HTML error page, which the browser cannot read
and reports as a generic failure. It is set in `apps/web/nginx.conf`:

```nginx
client_max_body_size 12m;
```

**What may be uploaded is a list, not a filter.** Pictures, PDF, plain text, CSV,
JSON, ZIP and the Office formats. **SVG and HTML are refused on purpose**: both
run script in a browser, and serving one from your own domain hands the person
who uploaded it the session of everyone who clicks it. A type that is not on the
list is refused rather than served as a download.

## Room bookings and the calendar feed

Meeting rooms can be held for a stretch of time from the calendar in the sidebar.
Two bookings cannot overlap in one room; the rule is enforced by the API, not by
the browser.

```dotenv
BOOKING_MAX_MINUTES=480   # the longest one booking may be
BOOKING_MAX_DAYS=90       # how far ahead anybody may reach
BOOKING_KEEP_DAYS=120     # then old bookings are swept
```

**The .ics feed address is a credential.** Each space has its own key, separate
from the invite code, so a calendar can be handed to somebody without handing
them the door. It is minted the first time a member opens "ซิงก์เข้าปฏิทินของคุณ",
and anybody holding the address can read that space's bookings without signing
in — which is what makes it work in Google Calendar, and what makes it worth
rotating if it leaks. An owner or admin rotates it by posting to
`/workspaces/<slug>/calendar-url`, which stops every existing subscriber.

**Google Calendar is read-only, by subscription.** Writing into somebody's Google
calendar needs the `calendar` scope, which Google treats as sensitive and will
not grant to an app that has not been through its verification review — a
process with a privacy policy and a demo video attached, and one only the
operator of a deployment can run. The feed needs none of it and is read by
Outlook and Apple Calendar too.

## Attendance and the dashboard

Owners and admins see who used the space at `/admin.html?w=<slug>`, reachable
from the space settings: arrivals and departures, hours per day, the hours of the
day people are actually here, and which rooms get used.

The room server writes each visit with the credential that let that person in,
so a space whose API is briefly unreachable loses a line in a report rather than
refusing to let anybody in. A visit that never closed — someone still here, or a
session lost to a restart — counts as an arrival and contributes no time at all.

```dotenv
STATS_KEEP_DAYS=365    # 0 keeps everything, and the table grows without end
```

Like chat, this lives in the same SQLite file as everything else, and it is the
second table that grows on its own.

## Stored maps

A space loads one of the three layouts compiled into the client, named by its
`theme`. It can also store a map of its own, which then wins — that is what the
map editor writes, and what `PUT /workspaces/:slug/map` accepts from an owner or
an admin. `DELETE` on the same path puts the space back on its stock layout, so
a broken map is one request away from being undone.

Owners and admins draw one at `/editor.html?w=<slug>`, reachable from the space
settings. A space may hold several maps — floors, or separate offices — and the
editor's tabs move between them. People reach the others through a portal that
names one, the floor switcher in the sidebar, or a `?m=<map>` in the URL; the
first map in the order is where new arrivals land. It is a second page rather than a route inside the app, so nginx's
`try_files $uri` serves the file directly and no config change is needed.

The row is validated before it is stored and again before it is drawn, because a
map reaches every browser in the space at once: a bad one is not a bad record,
it is a room nobody can walk into. A stored map that stops parsing is not fatal
either — the API logs it and serves the stock layout, so the space still opens.

```dotenv
MAP_MAX_BYTES=2000000  # a stored map is part of everyone's page load
MAPS_PER_SPACE=12      # floors of a building, or separate offices
```

The three built-in layouts bake down to about 6 KB each, so the default leaves a
great deal of room. Lower it if you would rather a large map were refused than
served slowly to everybody.

Who may read a space's history is decided by the same door as the space itself: a
member's session, or a live guest pass. A visitor's lines are recorded under the
name on their pass, since there is no account to look one up from later, and a
member who renames themselves does not rewrite what people remember reading.

### Map theme

Chosen **once, in the create-space wizard**, and fixed after that. It belongs to
the workspace, not the person: two people on different maps would stand inside
each other's walls. Desk ids also belong to a layout (`hall-1` exists in classic,
`open-1` in office), so changing one later would cancel every desk the team had
claimed — `PATCH /workspaces/:slug` rejects a different theme rather than allow
that quietly. **⚙️ → ทั่วไป** shows which layout a space uses, read-only.

If a space genuinely has to move, it is a deliberate database change plus telling
the team their desks are gone:

```bash
docker compose exec nexspace-api node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.workspace.update({where:{slug:'SLUG'},data:{theme:'office'}}).then(w=>console.log(w.slug,w.theme)).finally(()=>p.\$disconnect())"
```

Everyone's open tab notices on its next workspace fetch and reloads once: the
scene picks its map synchronously at boot, so the theme is cached in
`localStorage` per workspace, and a tab whose cache disagrees writes the server's
value and reloads. `?theme=<id>` previews a layout for one visit without saving.

Adding a theme means adding it to `THEMES` in
`apps/web/src/scenes/mapThemes.ts` **and** to the `THEMES` whitelist in
`apps/api/src/index.ts`, which is what stops an unknown value from reaching every
client's map loader.

### Art credits (licence obligation)

Some of the art is third-party under licences that **require attribution wherever
the work is published** — OGA-BY 3.0, CC-BY, CC-BY-SA and GPL. **⚙️ → เครดิต
งานศิลป์** is that attribution, and it must stay reachable while these files ship:

- **Office theme props** — LPC "The Office" by Eliza Wyatt and Lanea Zimmerman
  (Sharm), OGA-BY 3.0.
- **Avatar sprites** — Universal LPC Spritesheet: 749 parts by 71 artists under a
  mix of the licences above. The dialog names every artist and links
  `/lpc/CREDITS.txt`, the full per-part list.
- CoolSchool desks (CC0) and the PixelLab art are credited as courtesy.

`apps/web/src/artCredits.ts` and `public/lpc/CREDITS.txt` are **generated** from
the upstream sheet definitions, not written by hand. After adding or removing
spritesheets, regenerate them or the credit stops matching what ships:

```bash
node apps/web/scripts/build-credits.mjs
```

### Member roles

Four ranks, set from the ⋮ menu next to each person in **ตั้งค่า Workspace**:

| | เจ้าของ (owner) | ผู้ดูแล (admin) | สมาชิก (member) | ผู้เยี่ยมชม (guest) |
|---|---|---|---|---|
| Rename the space, toggle guest access, reset the invite | ✓ | ✓ | | |
| Change roles / remove people | anyone | ranks below admin only | | |
| See and share the invite link | ✓ | ✓ | ✓ | |
| Claim a desk | ✓ | ✓ | ✓ | |
| Enter, walk, chat, call | ✓ | ✓ | ✓ | ✓ |

An admin deliberately cannot promote someone to admin, demote a fellow admin, or
touch the owner — otherwise any admin could lock the owner out of their own
workspace. The owner has no "leave" option for the same reason: the space would
be left ownerless. All of this is enforced in the API, not just hidden in the UI;
`npm run test:roles -w apps/api` walks the whole table including the refusals.

Guests are blocked from claiming a desk in two places — the API (`PUT /me/desk`)
and the realtime server (`claimDesk`) — so a client talking straight to the
socket cannot take one either. Demoting someone does not evict them from a desk
they already hold, but they can release it and cannot take it back.

### Guest passes

**⚙️ → จัดการแขก** (owner/admin only). A pass is a link for one named visitor:
`?w=<slug>&g=<code>`. It carries their name, may expire, records each visit, and
can be revoked on its own.

A live pass is checked **before** membership and before the space's own
`allowGuests` setting, because it is the one credential meant to work while the
space is closed to guests. Every other state — expired, revoked, archived — falls
straight back to whatever `allowGuests` says, so revoking one pass never opens or
closes the door for anyone else. Holders arrive with the `guest` role, which
means no desk, exactly like a workspace guest.

Worth knowing before support questions:

- Revoking blocks the **next** entry. Someone already in the room stays until
  they reload — the room checks the pass when they join, not continuously.
- The code is 128 bits from the CSPRNG, so the link is the credential; anyone it
  is forwarded to can walk in until it is revoked.
- `GET /guest-pass/:code` is deliberately unauthenticated: it tells the holder
  the name on their own pass so the app can greet them by it. It needs its own
  nginx block (see the routing note at the top).
- Nothing here needs configuration. Passes live in the `GuestPass` table, which
  `prisma db push` creates on the first start after deploying.

### Language and colour mode

**⚙️ → ทั่วไป** carries two personal settings, both stored per device and needing
no server configuration:

- **ภาษาที่แสดง** — ไทย or English, applied live. The Thai text is the
  translation key, so a phrase with no entry stays Thai rather than breaking;
  `npm run -w @nexspace/web i18n` fails if any is missing, and `npm run preflight`
  runs it.
- **โหมดสี** — light, dark or match-system. The map is not themed: it is pixel
  art with its own palette.

### Authenticator app (2FA)

Works with no configuration — codes are verified locally, nothing is sent
anywhere. The only optional setting is the name shown inside the user's
authenticator app:

```dotenv
TOTP_ISSUER=NexSpace
```

Users turn it on themselves from **ความปลอดภัย** in the dashboard header. Notes
worth knowing before support questions arrive:

- Enrolment shows **8 recovery codes once**. They are stored bcrypt-hashed, so a
  user who loses both their phone and those codes cannot be recovered — there is
  no admin override. Clearing it by hand takes a database write:
  ```bash
  docker compose exec nexspace-api npx prisma studio   # or the SQL below
  # UPDATE User SET totpSecret=NULL, totpEnabledAt=NULL, recoveryCodes=NULL WHERE email='...';
  ```
- A code is accepted for one 30s step either side of the server clock, and never
  twice. If the server clock drifts more than ~30s from real time every code
  looks wrong — keep NTP running on the host.
- Five wrong codes throw the half-finished sign-in away and the user starts over.

### LiveKit (voice/video SFU)
```dotenv
LIVEKIT_URL=wss://...
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```
Left blank, clients fall back to a peer-to-peer mesh, which is fine for small
rooms but degrades past roughly a handful of people.

---

## Smoke test after deploying

1. Open the site — the sign-in card shows the **N** logo.
2. Enter an email → the 6-digit code screen appears. Grab the code from the API
   log (or your inbox) and complete sign-in.
3. The spaces dashboard loads. Create a space through the wizard.
4. You land in the office. Walk with WASD, claim a desk, check the name tag dot
   is **green**.
5. Open the invite link (`?w=<slug>`) in a private window — it should show the
   workspace name, and a member-only space must refuse a non-member.
6. Press the leave button — you should return to the dashboard.
7. **ความปลอดภัย** → เปิดใช้งาน → scan the QR with any authenticator app, enter the
   code, and save the recovery codes. Sign out and back in: the 2FA screen must
   appear, the app's code must let you through, and a second use of that same code
   must be refused.

## Notes

- Workspaces are isolated at three levels: the Colyseus room (`filterBy`
  workspace), the LiveKit room (`office-<slug>`), and claimed desks. The game
  server checks membership with the API before admitting anyone, using
  `API_URL=http://nexspace-api:3001` from compose — that variable must stay set
  or private workspaces stop admitting members.
- `apps/web/public/lpc/` is ~386 MB of avatar part sprites (88k files) fetched on
  demand by the avatar editor. It makes the web image large but costs users
  nothing until they open the editor.
- `apps/web/asset-library/` is the raw PixelLab source library. It is gitignored
  and deliberately outside `public/`, so it never ships.
