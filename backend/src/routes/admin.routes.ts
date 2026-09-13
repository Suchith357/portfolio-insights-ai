import { Router } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import * as admin from "../controllers/admin.controller.js";

const listQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const adminRouter = Router();

// Every admin endpoint requires a valid token AND the ADMIN role.
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/stats", admin.getStats);
adminRouter.get("/users", validate(listQuerySchema, "query"), admin.listUsers);
adminRouter.get("/stocks", admin.listStocks);
adminRouter.get("/audit-logs", validate(listQuerySchema, "query"), admin.listAuditLogs);

// Market-data operations (ADMIN only).
adminRouter.post("/market-data/sync", admin.triggerSync);
adminRouter.get("/market-data/status", admin.syncStatus);
