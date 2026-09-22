import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { HttpError } from "../utils/http.js";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `No API route matches ${req.method} ${req.originalUrl}` },
  });
}

/** Single place where errors become JSON. Internal details never leak out. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Zod body/query validation failures are client errors, not server faults.
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first ? first.path.join(".") : "body";
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: first ? `${where}: ${first.message}` : "Invalid request payload.",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      res.status(409).json({ error: { code: "CONFLICT", message: "That record already exists." } });
      return;
    }
    if (err.code === "P2025") {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Resource not found." } });
      return;
    }
    if (err.code === "P2003") {
      res.status(400).json({
        error: { code: "BAD_REQUEST", message: "A referenced record does not exist." },
      });
      return;
    }
  }

  console.error("[error]", err);
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Something went wrong on our end. Please try again." },
  });
}

/** Wraps async handlers so rejections reach the error handler. */
export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => unknown>(
  fn: T,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
