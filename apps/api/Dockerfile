FROM node:20-slim

WORKDIR /app/apps/api

# Prisma needs OpenSSL present to load its query/schema engine. Debian slim +
# openssl avoids the musl/openssl-1.1.x detection failure seen on node:*-alpine.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY apps/api/package*.json ./

RUN npm install

COPY apps/api ./

# Prisma keeps a generation cache in node_modules/.cache. If one ever reaches the
# build context it makes `prisma generate` a no-op, and the client silently stays
# on the previous schema — new models come back undefined at runtime. .dockerignore
# already keeps node_modules out; clear the cache too so a stale one can't win.
RUN rm -rf node_modules/.cache && npx prisma generate

ENV PORT=3001
# compose overrides this; keep it out of apps/api/prisma so a data volume mounted
# there can never shadow schema.prisma (see docker-compose.yml)
ENV DATABASE_URL="file:/app/apps/api/data/prisma/prod.db"
EXPOSE 3001

# The commit this image was built from. Kept last so a new commit only
# rebuilds this metadata layer, and read back by scripts/deploy.sh to work out
# what is actually running.
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$GIT_SHA

CMD ["sh", "-c", "npx prisma db push && npx tsx src/index.ts"]
