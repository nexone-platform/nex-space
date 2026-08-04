FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY apps/game-server/package*.json ./apps/game-server/

RUN npm install --workspace=apps/game-server

COPY apps/game-server ./apps/game-server

WORKDIR /app/apps/game-server
RUN npm run build

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/apps/game-server/package*.json ./apps/game-server/
COPY --from=builder /app/apps/game-server/dist ./apps/game-server/dist
COPY --from=builder /app/apps/game-server/node_modules ./apps/game-server/node_modules

WORKDIR /app/apps/game-server
ENV PORT=2567
EXPOSE 2567

CMD ["node", "dist/index.js"]
