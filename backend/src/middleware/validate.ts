import type { NextFunction, Request, Response } from "express";
import type { ZodTypeAny } from "zod";
import { badRequest } from "../utils/http.js";

type Source = "body" | "query" | "params";

/** Validates and replaces the given request section with the parsed value. */
export function validate(schema: ZodTypeAny, source: Source = "body") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        field: i.path.join(".") || source,
        message: i.message,
      }));
      return next(badRequest("Some of the details you entered aren't valid.", details));
    }
    if (source === "body") {
      req.body = result.data;
    } else if (source === "query") {
      // Express 5 getters are plain properties; this also keeps future
      // middleware reading req.query consistent with the parsed values.
      Object.defineProperty(req, "query", { value: result.data, writable: true, configurable: true });
    } else {
      Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true });
    }
    next();
  };
}
