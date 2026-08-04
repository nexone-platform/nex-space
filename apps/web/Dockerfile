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

CMD ["nginx", "-g", "daemon off;"]
