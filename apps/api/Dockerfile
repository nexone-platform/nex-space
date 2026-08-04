FROM node:20-alpine AS builder

WORKDIR /app/apps/api

COPY apps/api/package*.json ./

RUN npm install

COPY apps/api ./

RUN npx prisma generate
RUN npm run build

FROM node:20-alpine

WORKDIR /app/apps/api

COPY --from=builder /app/apps/api/package*.json ./
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/prisma ./prisma
COPY --from=builder /app/apps/api/node_modules ./node_modules

ENV PORT=3001
ENV DATABASE_URL="file:./prod.db"
EXPOSE 3001

CMD ["sh", "-c", "npx prisma db push && node dist/index.js"]
