FROM node:20-alpine AS builder

WORKDIR /app/apps/game-server

COPY apps/game-server/package*.json ./

RUN npm install

COPY apps/game-server ./

RUN npm run build

FROM node:20-alpine

WORKDIR /app/apps/game-server

COPY --from=builder /app/apps/game-server/package*.json ./
COPY --from=builder /app/apps/game-server/dist ./dist
COPY --from=builder /app/apps/game-server/node_modules ./node_modules

ENV PORT=2567
EXPOSE 2567

CMD ["node", "dist/index.js"]
