import { asyncHandler } from "../middleware/error.js";
import { currentUser } from "../middleware/auth.js";
import { ok } from "../utils/http.js";
import * as adminService from "../services/admin.service.js";

export const getStats = asyncHandler(async (_req, res) => {
  const stats = await adminService.getStats();
  ok(res, stats);
});

export const listUsers = asyncHandler(async (req, res) => {
  const rows = await adminService.listUsers(currentUser(req).userId, String(req.query["search"] ?? ""));
  ok(res, rows);
});

export const listAuditLogs = asyncHandler(async (_req, res) => {
  const rows = await adminService.listAuditLogs();
  ok(res, rows);
});

export const listStocks = asyncHandler(async (_req, res) => {
  const rows = await adminService.listManagedStocks();
  ok(res, rows);
});
