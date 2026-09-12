import { Router } from "express";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import * as admin from "../controllers/admin.controller.js";

export const adminRouter = Router();

// Every admin endpoint requires a valid token AND the ADMIN role.
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/stats", admin.getStats);
adminRouter.get("/users", admin.listUsers);
adminRouter.get("/stocks", admin.listStocks);
adminRouter.get("/audit-logs", admin.listAuditLogs);
