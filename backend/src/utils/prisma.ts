import { PrismaClient } from "@prisma/client";

/** Single shared Prisma client. All database access goes through this. */
export const prisma = new PrismaClient({
  log: process.env["NODE_ENV"] === "development"
    ? ["warn", "error"]
    : ["error"],
});

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
