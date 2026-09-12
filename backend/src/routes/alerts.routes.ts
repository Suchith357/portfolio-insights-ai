import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import * as alerts from "../controllers/alert.controller.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });

export const alertsRouter = Router();

alertsRouter.use(requireAuth);

alertsRouter.get("/", alerts.list);
alertsRouter.patch("/read-all", alerts.markAllRead);
alertsRouter.patch("/:id/read", validate(idParam, "params"), alerts.markRead);
