import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../utils/http.js";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Periodically drop expired buckets so the map never grows unbounded. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweep = Date.now();

function sweep(now: number) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Lightweight in-process fixed-window rate limiter — no external service.
 * Keyed by IP (+optional extra scope) and meant for the auth endpoints and
 * other abuse-prone routes. For multi-instance deployments a shared store
 * (e.g. Redis) would replace the Map.
 */
export function rateLimit(options: {
  windowMs: number;
  max: number;
  message?: string;
  scope?: string;
}) {
  const { windowMs, max, message = "Too many requests. Please try again shortly.", scope = "" } = options;
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    sweep(now);

    const ip =
      req.ip ??
      (Array.isArray(req.socket?.remoteAddress) ? String(req.socket.remoteAddress[0]) : String(req.socket?.remoteAddress ?? "unknown"));
    const key = `${scope}|${ip}`;

    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader("X-RateLimit-Limit", String(max));
      res.setHeader("X-RateLimit-Remaining", String(max - 1));
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retrySec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retrySec));
      next(new HttpError(429, message, "RATE_LIMITED"));
      return;
    }
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(max - bucket.count));
    next();
  };
}
