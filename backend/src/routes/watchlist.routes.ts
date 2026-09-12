import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import * as watchlist from "../controllers/watchlist.controller.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const addSchema = z.object({ symbol: z.string().trim().min(1).max(20) });

export const watchlistRouter = Router();

watchlistRouter.use(requireAuth);

watchlistRouter.get("/", watchlist.list);
watchlistRouter.post("/", validate(addSchema), watchlist.add);
watchlistRouter.delete("/:id", validate(idParam, "params"), watchlist.remove);
