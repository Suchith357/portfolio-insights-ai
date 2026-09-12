import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import * as transactions from "../controllers/transaction.controller.js";

const portfolioParam = z.object({ portfolioId: z.coerce.number().int().positive() });

const createSchema = z.object({
  portfolioId: z.coerce.number().int().positive(),
  stockId: z.coerce.number().int().positive().optional(),
  symbol: z.string().trim().min(1).max(20).optional(),
  type: z.enum(["BUY", "SELL"]),
  quantity: z.coerce.number().positive("Quantity must be greater than 0."),
  price: z.coerce.number().positive("Price must be greater than 0."),
  executedAt: z.string().datetime({ offset: true }).optional(),
});

export const transactionsRouter = Router();

transactionsRouter.use(requireAuth);

transactionsRouter.get("/", transactions.listAll);
transactionsRouter.get(
  "/portfolio/:portfolioId",
  validate(portfolioParam, "params"),
  transactions.listForPortfolio,
);
transactionsRouter.post("/", validate(createSchema), transactions.create);
