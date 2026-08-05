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

RUN npx prisma generate

ENV PORT=3001
ENV DATABASE_URL="file:./prisma/prod.db"
EXPOSE 3001

CMD ["sh", "-c", "npx prisma db push && npx tsx src/index.ts"]
