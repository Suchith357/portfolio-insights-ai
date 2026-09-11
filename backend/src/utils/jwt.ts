import jwt from "jsonwebtoken";
import { env } from "./env.js";

export type Role = "USER" | "ADMIN";

export interface TokenPayload {
  userId: number;
  email: string;
  role: Role;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, env.jwtSecret) as TokenPayload;
}
