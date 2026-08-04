FROM node:20-alpine

WORKDIR /app/apps/api

COPY apps/api/package*.json ./

RUN npm install

COPY apps/api ./

RUN npx prisma generate

ENV PORT=3001
ENV DATABASE_URL="file:./prisma/prod.db"
EXPOSE 3001

CMD ["sh", "-c", "npx prisma db push && npx tsx src/index.ts"]
