import bcrypt from "bcryptjs";
import { env } from "./env.js";

/** Passwords are never stored or logged in plain text. */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.bcryptRounds);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
