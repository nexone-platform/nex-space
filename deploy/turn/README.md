# The voice relay on its own machine

Use this when the app server cannot receive UDP from the internet — it sits
behind NAT nobody will reconfigure, or the provider does not forward the ports.
That is the situation this directory exists for, and it is a configuration job,
not a code change: the app never talks to the relay. It only tells browsers
where to find one.

**What you need:** a small VPS that holds a public address directly. The relay
is not demanding — one shared core and 512 MB is enough for a team; what it does
need is bandwidth, because every relayed call passes through it twice.

**Where to put it:** near the people using it. Latency here is added to every
relayed call, so a machine in the same country as the team beats a cheaper one
far away. Keeping it in Thailand also keeps the "our data stays here" claim
whole — a relay abroad would carry the audio itself.

## Setting it up

**1. Point a name at it.** An `A` record straight to the VPS address, with any
CDN proxy **off** — a proxy answers for websites and drops everything else,
which is a failure that looks exactly like a broken relay.

```
turn.xy789.click    A    <the VPS address>    DNS only
```

**2. Install docker**, if the image does not have it:

```bash
curl -fsSL https://get.docker.com | sh
```

**3. Copy this directory** to the VPS — only these three files matter:

```bash
scp -r deploy/turn root@<vps>:/opt/nexspace-turn
```

**4. Set the secret.** It must be the *same string* as `TURN_SECRET` in the app
server's `.env`. Take the value that is already there rather than making a new
one, or the two halves will not recognise each other:

```bash
cd /opt/nexspace-turn && cp .env.example .env && nano .env
```

**5. Open the firewall.** Both rows, always:

```bash
ufw allow 3478/udp
ufw allow 3478/tcp
ufw allow 49160:49260/udp
```

The second row is the one that gets forgotten. Without it a call connects,
reports success, and carries no sound — a much harder failure to trace than
nothing working at all.

**6. Start it:**

```bash
docker compose up -d && docker compose logs -f
```

The log should end with `Total General servers: N` and no error. If it lists a
long column of discovered relay addresses including `172.17.0.1` and friends,
this machine has docker bridges of its own — set `TURN_LISTEN_IP` to its real
address and restart.

## Proving it works

From a third machine — not the VPS, not the app server — in a checkout of this
repository:

```bash
node scripts/turn-check.mjs --host=turn.xy789.click --secret=<the secret>
```

Five checks, all of which must say `ok`. Each failure names its own cause: a
closed port, a mismatched secret, a private address being advertised, a missing
deny rule. Running it on the relay itself proves only that the machine can reach
itself, which is true even when the firewall blocks the world.

## Pointing the app at it

On the **app server**, in its `.env`:

```dotenv
TURN_SECRET=<the same secret>
TURN_HOST=turn.xy789.click
TURN_TLS_PORT=443          # only if you did the TLS section below
```

```bash
cd /var/www/nex-space && docker compose up -d nexspace-api
```

The app server's own relay container is no longer needed. If one was started
there, stop it — two relays with the same secret are not harmful, but the one
nobody can reach is only there to confuse the next person:

```bash
docker compose --profile turn down
```

Nothing else changes. `/ice` starts handing out the new host on the next
request, and browsers pick it up without a reload.

## TLS on 443, which is worth doing here

The strictest corporate networks allow outbound 443 and nothing else. A relay
listening on 443 over TLS gets through those; one on 3478 does not. This was not
possible on the app server, where nginx already holds 443 — on a machine
dedicated to the relay it is free.

```bash
apt install -y certbot
certbot certonly --standalone -d turn.xy789.click
```

Then in `.env`:

```dotenv
TURN_TLS_PORT=443
TURN_CERT=/certs/live/turn.xy789.click/fullchain.pem
TURN_KEY=/certs/live/turn.xy789.click/privkey.pem
```

```bash
ufw allow 443/tcp
docker compose up -d
```

Certificates expire. `certbot renew` writes new files into the same paths, but
coturn reads them once at startup, so it has to be restarted afterwards:

```bash
echo 'docker compose -f /opt/nexspace-turn/docker-compose.yml restart' \
  > /etc/letsencrypt/renewal-hooks/deploy/restart-turn.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/restart-turn.sh
```

Set `TURN_TLS_PORT=443` on the app server too, or browsers are never told the
TLS entry exists.

## Keeping it honest

The relay is a service that costs bandwidth and is reachable by anyone who finds
it, so two things are worth checking now and then:

- `docker compose logs --tail 100 coturn | grep -i "usage"` — sessions and bytes
  per user. The username carries the account or guest pass it was issued to, so
  an abusive session can be traced back.
- The deny list in `docker-compose.yml` is what stops the relay being used to
  reach this machine's own network. `turn-check` asserts it is in force; run it
  after any change to that file.
