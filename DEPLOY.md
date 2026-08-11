# Deploying NexSpace

Three containers behind one nginx (`docker-compose.yml`):

| service | role | port |
|---|---|---|
| `nexspace-web` | nginx serving the built client + reverse-proxying the others | 8087 → 80 |
| `nexspace-game` | Colyseus rooms + LiveKit token minting | 2567 |
| `nexspace-api` | auth, workspaces, avatars, maps (SQLite on a named volume) | 3001 |

The client always calls the API and game server **same-origin** (`/auth`, `/me`,
`/workspaces`, `/colyseus`, `/livekit`), so nginx must keep those `location`
blocks. Anything new on the API needs a matching block or it 404s in production.

---

## Deploy

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
