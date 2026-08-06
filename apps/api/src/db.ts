import { PrismaClient } from "@prisma/client";

// Docker sets DATABASE_URL; without it (a plain `npm run dev`) Prisma throws
// "Environment variable not found: DATABASE_URL" before serving a single
// request. Fall back to a local SQLite file so the API runs out of the box.
// (relative SQLite paths resolve against the schema folder -> apps/api/prisma/dev.db)
process.env.DATABASE_URL ||= "file:./dev.db";

export const prisma = new PrismaClient();
