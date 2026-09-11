import type { Response } from "express";

/** Application error with an HTTP status. Messages here are user-safe. */
export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, message: string, code = "ERROR", details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (m = "Invalid request.", d?: unknown) =>
  new HttpError(400, m, "BAD_REQUEST", d);
export const unauthorized = (m = "Authentication required.") =>
  new HttpError(401, m, "UNAUTHORIZED");
export const forbidden = (m = "You don't have access to this resource.") =>
  new HttpError(403, m, "FORBIDDEN");
export const notFound = (m = "Resource not found.") => new HttpError(404, m, "NOT_FOUND");
export const conflict = (m = "That resource already exists.") => new HttpError(409, m, "CONFLICT");

/** Consistent success envelope: { data, meta? }. */
export function ok<T>(res: Response, data: T, status = 200, meta?: unknown): Response {
  return res.status(status).json(meta === undefined ? { data } : { data, meta });
}

/** Decimal/BigInt values from Prisma are serialised as numbers/strings safely. */
export function serialize<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (typeof v === "bigint") return Number(v);
      if (v && typeof v === "object" && typeof (v as { toNumber?: unknown }).toNumber === "function") {
        return (v as { toNumber: () => number }).toNumber();
      }
      return v;
    }),
  );
}
