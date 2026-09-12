import { asyncHandler } from "../middleware/error.js";
import { currentUser } from "../middleware/auth.js";
import { ok } from "../utils/http.js";
import * as alertService from "../services/alert.service.js";

export const list = asyncHandler(async (req, res) => {
  const rows = await alertService.listAlerts(currentUser(req).userId);
  ok(res, rows);
});

export const markRead = asyncHandler(async (req, res) => {
  const row = await alertService.markRead(currentUser(req).userId, Number(req.params["id"]));
  ok(res, row);
});

export const markAllRead = asyncHandler(async (req, res) => {
  const result = await alertService.markAllRead(currentUser(req).userId);
  ok(res, result);
});
