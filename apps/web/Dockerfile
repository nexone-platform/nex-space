FROM node:20-alpine AS builder

WORKDIR /app/apps/web

COPY apps/web/package*.json ./

RUN npm install

COPY apps/web ./

RUN npm run build

FROM nginx:alpine

COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# The commit this image was built from. Kept last so a new commit only
# rebuilds this metadata layer, and read back by scripts/deploy.sh to work out
# what is actually running.
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$GIT_SHA

CMD ["nginx", "-g", "daemon off;"]
