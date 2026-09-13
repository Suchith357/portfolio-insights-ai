import type { NextFunction, Request, Response } from "express";
import { forbidden, unauthorized } from "../utils/http.js";
import { verifyToken, type Role } from "../utils/jwt.js";
import { prisma } from "../utils/prisma.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { userId: number; email: string; role: Role; issuedAtMs: number };
    }
  }
}

/**
 * Requires a valid `Authorization: Bearer <jwt>` header.
 *
 * Beyond signature/expiry, two freshness rules are enforced per request:
 *   1. Password-change invalidation — tokens issued before the account's
 *      `password_changed_at` instant are rejected, so changing a password
 *      ends every session issued earlier.
 *   2. Role freshness — the role is re-read from the database, so a demoted
 *      ADMIN cannot keep riding an old token past this request. The user row
 *      lookup is a single indexed PK read; acceptable for this project and it
 *      also rejects tokens for deleted users.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return next(unauthorized());
  try {
    const payload = verifyToken(token);

    const user = await prisma.users.findUnique({
      where: { user_id: payload.userId },
      select: { role: true, password_changed_at: true },
    });
    if (!user) return next(unauthorized("Your session has expired. Please sign in again."));
    if (user.password_changed_at && payload.issuedAtMs < user.password_changed_at.getTime()) {
      return next(unauthorized("Your session has expired. Please sign in again."));
    }

    req.user = { userId: payload.userId, email: payload.email, role: user.role as Role, issuedAtMs: payload.issuedAtMs };
    next();
  } catch {
    next(unauthorized("Your session has expired. Please sign in again."));
  }
}

/** Role-based authorization. Route visibility in the UI is never the guard. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

export const requireAdmin = requireRole("ADMIN");

/** Convenience accessor for handlers running behind `requireAuth`. */
export function currentUser(req: Request): { userId: number; email: string; role: Role; issuedAtMs: number } {
  if (!req.user) throw unauthorized();
  return req.user;
}
