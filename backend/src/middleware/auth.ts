import type { NextFunction, Request, Response } from "express";
import { forbidden, unauthorized } from "../utils/http.js";
import { verifyToken, type Role, type TokenPayload } from "../utils/jwt.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

/** Requires a valid `Authorization: Bearer <jwt>` header. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return next(unauthorized());
  try {
    req.user = verifyToken(token);
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
export function currentUser(req: Request): TokenPayload {
  if (!req.user) throw unauthorized();
  return req.user;
}
