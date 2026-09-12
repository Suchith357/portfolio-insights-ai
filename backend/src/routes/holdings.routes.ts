import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import * as holdings from "../controllers/holding.controller.js";

const portfolioParam = z.object({ portfolioId: z.coerce.number().int().positive() });
const idParam = z.object({ id: z.coerce.number().int().positive() });

export const holdingsRouter = Router();

holdingsRouter.use(requireAuth);

holdingsRouter.get("/", holdings.listAll);
holdingsRouter.get("/portfolio/:portfolioId", validate(portfolioParam, "params"), holdings.listForPortfolio);
holdingsRouter.get("/:id", validate(idParam, "params"), holdings.getOne);
holdingsRouter.delete("/:id", validate(idParam, "params"), holdings.remove);
