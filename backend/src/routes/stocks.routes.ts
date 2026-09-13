import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import * as stocks from "../controllers/stock.controller.js";

const symbolParam = z.object({ symbol: z.string().trim().min(1).max(20) });

const querySchema = z.object({
  search: z.string().trim().max(100).optional(),
  sector: z.string().trim().max(100).optional(),
  sort: z.enum(["symbol", "name", "price-desc", "price-asc", "mcap-desc"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

const pricesQuerySchema = z.object({
  // Explicit, bounded "latest N" — unbounded values are rejected here so the
  // service never has to guess what an arbitrary limit means.
  limit: z.coerce.number().int().positive().max(2600).optional(),
});

export const stocksRouter = Router();

// Catalogue browsing is public read-only; portfolio features stay protected.
stocksRouter.get("/", validate(querySchema, "query"), stocks.list);
stocksRouter.get("/sectors", stocks.listSectors);
stocksRouter.get(
  "/:symbol/prices",
  validate(symbolParam, "params"),
  validate(pricesQuerySchema, "query"),
  stocks.getPrices,
);
stocksRouter.get("/:symbol/risk", validate(symbolParam, "params"), stocks.getRisk);
stocksRouter.get("/:symbol", validate(symbolParam, "params"), stocks.getDetail);
