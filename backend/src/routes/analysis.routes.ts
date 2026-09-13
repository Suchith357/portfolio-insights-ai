import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import * as analysis from "../controllers/analysis.controller.js";

const symbolParam = z.object({ symbol: z.string().trim().min(1).max(20) });

const buySchema = z.object({
  portfolioId: z.coerce.number().int().positive(),
  symbol: z.string().trim().min(1).max(20),
  amount: z.coerce.number().positive("Amount must be greater than 0.").max(1_000_000_000),
});

const sellSchema = z.object({
  holdingId: z.coerce.number().int().positive(),
  pct: z.coerce.number().min(1).max(100),
});

export const analysisRouter = Router();

analysisRouter.use(requireAuth);

analysisRouter.get("/overview", analysis.overview);
analysisRouter.get("/market-freshness", analysis.marketFreshness);
analysisRouter.get("/stock/:symbol", validate(symbolParam, "params"), analysis.stockRisk);
analysisRouter.get("/correlation/:symbol", validate(symbolParam, "params"), analysis.correlation);
analysisRouter.post("/buy-simulation", validate(buySchema), analysis.buySimulation);
analysisRouter.post("/sell-simulation", validate(sellSchema), analysis.sellSimulation);
