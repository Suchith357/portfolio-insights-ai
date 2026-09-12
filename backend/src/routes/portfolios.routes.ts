import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import * as portfolios from "../controllers/portfolio.controller.js";
import * as analysis from "../controllers/analysis.controller.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });

const createSchema = z.object({
  name: z.string().trim().min(3, "Enter a name with at least 3 characters.").max(100),
  description: z.string().trim().max(500).optional().default(""),
});

const updateSchema = z.object({
  name: z.string().trim().min(3, "Enter a name with at least 3 characters.").max(100).optional(),
  description: z.string().trim().max(500).optional(),
});

export const portfoliosRouter = Router();

portfoliosRouter.use(requireAuth);

portfoliosRouter.get("/", portfolios.list);
portfoliosRouter.post("/", validate(createSchema), portfolios.create);

portfoliosRouter.get("/:id", validate(idParam, "params"), portfolios.getOne);
portfoliosRouter.put("/:id", validate(idParam, "params"), validate(updateSchema), portfolios.update);
portfoliosRouter.patch("/:id", validate(idParam, "params"), validate(updateSchema), portfolios.update);
portfoliosRouter.delete("/:id", validate(idParam, "params"), portfolios.remove);

/** Analytics for one portfolio (read-only view powering the detail page). */
portfoliosRouter.get("/:id/analysis", validate(idParam, "params"), analysis.portfolioAnalysis);
/** Explicit snapshotting variant — also stores a portfolio_analysis row. */
portfoliosRouter.post("/:id/analyze", validate(idParam, "params"), analysis.analyzeAndSnapshot);
