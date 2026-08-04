# Build stage for web frontend
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root workspace & web package files
COPY package*.json ./
COPY apps/web/package*.json ./apps/web/

RUN npm install --workspace=apps/web

# Copy source files
COPY apps/web ./apps/web

# Build web frontend bundle
WORKDIR /app/apps/web
RUN npm run build

# Production stage using Nginx
FROM nginx:alpine

COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
