import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "./env.js";
import { unauthorized } from "./http.js";

export type Role = "USER" | "ADMIN";

export interface TokenPayload {
  userId: number;
  email: string;
  role: Role;
}

/**
 * Runtime payload validation. TypeScript types describe what we *intend* to
 * sign; anything that arrives in a token is untrusted input until this passes.
 */
const payloadSchema = z.object({
  userId: z.number().int().positive(),
  email: z.string().email().max(255),
  role: z.enum(["USER", "ADMIN"]),
  iat: z.number().int().positive().optional(),
});

export function signToken(payload: TokenPayload, issuedAt?: Date): string {
  const iat = Math.floor((issuedAt?.getTime() ?? Date.now()) / 1000);
  return jwt.sign({ ...payload, iat }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  } as jwt.SignOptions);
}

/**
 * Verifies signature/expiry AND validates the payload shape at runtime.
 * Returns the parsed payload plus the token's issued-at instant (epoch ms) so
 * callers can enforce role freshness and password-change invalidation.
 */
export function verifyToken(token: string): TokenPayload & { issuedAtMs: number } {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, env.jwtSecret);
  } catch {
    throw unauthorized("Your session has expired. Please sign in again.");
  }
  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw unauthorized("Your session has expired. Please sign in again.");
  }
  return {
    userId: parsed.data.userId,
    email: parsed.data.email,
    role: parsed.data.role,
    issuedAtMs: (parsed.data.iat ?? 0) * 1000,
  };
}
