import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/error.js";
import { currentUser } from "../middleware/auth.js";
import { badRequest, ok } from "../utils/http.js";
import * as adminService from "../services/admin.service.js";
import * as syncService from "../services/market-data.sync.js";

const asNumber = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export const getStats = asyncHandler(async (_req, res) => {
  const stats = await adminService.getStats();
  ok(res, stats);
});

export const listUsers = asyncHandler(async (req, res) => {
  const rows = await adminService.listUsers(currentUser(req).userId, {
    search: req.query["search"] ? String(req.query["search"]) : undefined,
    page: asNumber(req.query["page"]),
    pageSize: asNumber(req.query["pageSize"]),
  });
  ok(res, rows.rows, 200, {
    total: rows.total,
    page: rows.page,
    pageSize: rows.pageSize,
    pageCount: rows.pageCount,
  });
});

export const listAuditLogs = asyncHandler(async (req, res) => {
  const rows = await adminService.listAuditLogs(
    asNumber(req.query["page"]) ?? 1,
    asNumber(req.query["pageSize"]) ?? 50,
  );
  ok(res, rows.rows, 200, {
    total: rows.total,
    page: rows.page,
    pageSize: rows.pageSize,
    pageCount: rows.pageCount,
  });
});

export const listStocks = asyncHandler(async (_req, res) => {
  const rows = await adminService.listManagedStocks();
  ok(res, rows);
});

/** Manual market-data refresh (ADMIN only). Single-flight via the sync lock. */
export const triggerSync = asyncHandler(async (req: Request, res: Response) => {
  // Accept the mode from either the query string (?mode=FULL) or the body.
  const mode = (req.query["mode"] ?? req.body?.["mode"]) === "FULL" ? "FULL" : "LATEST";
  if (syncService.isSyncRunning()) {
    ok(res, { started: false, message: "A market-data sync is already running." }, 202);
    return;
  }
  if (mode === "FULL" && !req.query["confirm"]) {
    // FULL replaces synthetic rows inside the real-data window; require an
    // explicit confirmation flag for the heavier operation.
    throw badRequest("Pass ?confirm=true to run a FULL sync (replaces demo price rows inside the real-data window).");
  }
  // Fire-and-forget: the sync can take minutes; report acceptance immediately.
  void syncService.runSync("MANUAL", mode).catch((err) => {
    console.error("[market-data] manual sync failed:", err instanceof Error ? err.message : err);
  });
  ok(res, { started: true, mode, message: `Manual ${mode} market-data sync started.` }, 202);
});

export const syncStatus = asyncHandler(async (_req, res) => {
  const last = await syncService.lastSync();
  ok(res, {
    running: syncService.isSyncRunning(),
    last: last
      ? {
          id: String(last.sync_id),
          triggerType: last.trigger_type,
          mode: last.mode,
          status: last.status,
          startedAt: last.started_at.toISOString(),
          finishedAt: last.finished_at?.toISOString() ?? null,
          stocksProcessed: last.stocks_processed,
          pricesUpserted: last.prices_upserted,
          fundamentalsUpdated: last.fundamentals_updated,
          failures: last.failures,
          errorMessage: last.error_message,
        }
      : null,
  });
});
