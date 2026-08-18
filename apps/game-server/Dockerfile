FROM node:20-alpine

WORKDIR /app/apps/game-server

COPY apps/game-server/package*.json ./

RUN npm install

COPY apps/game-server ./

ENV PORT=2567
EXPOSE 2567

# The commit this image was built from. Kept last so a new commit only
# rebuilds this metadata layer, and read back by scripts/deploy.sh to work out
# what is actually running.
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$GIT_SHA

CMD ["npx", "tsx", "src/index.ts"]
