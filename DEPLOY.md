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

> Do not change `DATABASE_URL` in `docker-compose.yml`. Prisma resolves the
> relative SQLite path against the schema folder, so the live database sits at
> `prisma/prisma/prod.db` inside the `nexspace-api-data` volume. Repointing it
> silently starts a brand-new empty database.

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
Create an OAuth client at <https://console.cloud.google.com/apis/credentials>
and add this authorised redirect URI:

```
https://<your-host>/auth/google/callback
```

```dotenv
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

Left blank, the "Continue with Google" button hides itself (`/auth/config`
tells the client whether it is configured).

The redirect URI is derived from the `X-Forwarded-Host` / `X-Forwarded-Proto`
headers nginx sends. If extra proxies sit in front and Google rejects the
redirect, pin it explicitly:

```dotenv
APP_URL=https://your-host/
OAUTH_REDIRECT_URL=https://your-host/auth/google/callback
```

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
