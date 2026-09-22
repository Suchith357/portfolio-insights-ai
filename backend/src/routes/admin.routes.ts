import { Router } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import * as admin from "../controllers/admin.controller.js";
import * as intelligence from "../controllers/intelligence.controller.js";
import { providerStatuses } from "../services/market-providers/fallback.js";
import { ok } from "../utils/http.js";

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
// Feature A: multi-provider diagnostics (which providers are configured).
adminRouter.get("/market-data/providers", async (_req, res) => {
  // Core market-data providers + auxiliary macro/FX context providers
  // (World Bank, Frankfurter/ECB) — the latter are fail-isolated context
  // sources for Deep AI Research, not price-history chains.
  const { fetchMacroContext } = await import("../services/market-providers/macro.providers.js");
  const aux = await fetchMacroContext();
  ok(res, {
    providers: providerStatuses(),
    auxiliary: [
      { id: "WORLD_BANK", displayName: "World Bank Indicators (macro)", ok: aux.macro.ok, reason: aux.macro.reason ?? null, indicators: aux.macro.indicators.length, fetchedAt: aux.macro.fetchedAt },
      { id: "FRANKFURTER", displayName: "ECB via Frankfurter (USD/INR)", ok: aux.fx.ok, reason: aux.fx.reason ?? null, usdInr: aux.fx.usdInr, asOf: aux.fx.asOf, fetchedAt: aux.fx.fetchedAt },
    ],
  });
});

// Intelligence Engine — Phase 1 news foundation (ADMIN only).
adminRouter.get("/intelligence/news/status", intelligence.getStatus);
adminRouter.get("/intelligence/news/recent", intelligence.getRecentNews);
adminRouter.get("/intelligence/events/recent", intelligence.getRecentEvents);
adminRouter.post("/intelligence/news/fetch", intelligence.triggerFetch);
adminRouter.post("/intelligence/news/cleanup", intelligence.triggerCleanup);

// Phase 2: portfolio impact mapping (ADMIN only).
adminRouter.post("/intelligence/exposure/process", intelligence.triggerExposureProcess);
adminRouter.get("/intelligence/impacts/system", intelligence.getSystemImpacts);

// Phase 3: alert delivery (ADMIN only).
adminRouter.post("/intelligence/alerts/deliver", intelligence.triggerAlertDelivery);

// Phase 4/5: quantitative diagnostics (ADMIN only).
adminRouter.get("/intelligence/risk/status", intelligence.riskStatus);
adminRouter.get("/intelligence/analogues/status", intelligence.analogueStatus);
