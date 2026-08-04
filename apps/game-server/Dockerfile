FROM node:20-alpine

WORKDIR /app/apps/game-server

COPY apps/game-server/package*.json ./

RUN npm install

COPY apps/game-server ./

ENV PORT=2567
EXPOSE 2567

CMD ["npx", "tsx", "src/index.ts"]
