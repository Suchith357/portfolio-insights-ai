/**
 * Intelligence user endpoints (Phase 2) — mounted at /api/intelligence.
 *
 * Every query is scoped by the AUTHENTICATED user (never a client-supplied
 * userId); portfolioId filters are ownership-checked before use. Admins use
 * the existing /api/admin/intelligence routes for system-level views.
 *
 *   GET /api/intelligence/portfolio/impacts   — my portfolio-aware impacts
 *   GET /api/intelligence/portfolio/exposure  — my current exposure snapshot
 */
import { Router } from "express";
import { z } from "zod";
import { requireAuth, currentUser } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { forbidden, notFound } from "../utils/http.js";
import { prisma } from "../utils/prisma.js";
import * as impactService from "../services/news/event-impact.service.js";
import { getUserPortfolioExposure } from "../services/news/portfolio-exposure.service.js";
import * as readService from "../services/news/intelligence-read.service.js";
import * as riskController from "../controllers/risk.controller.js";

const impactsQuerySchema = z.object({
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  direction: z.enum(["POSITIVE", "NEGATIVE", "MIXED", "UNCERTAIN", "NEUTRAL"]).optional(),
  exposureType: z
    .enum([
      "DIRECT_HOLDING",
      "WATCHLIST",
      "SECTOR_EXPOSURE",
      "INDIRECT_EXPOSURE",
      "MACRO_EXPOSURE",
      "COMPETITOR_EXPOSURE",
      "SUPPLIER_EXPOSURE",
      "CUSTOMER_EXPOSURE",
      "UNKNOWN",
    ])
    .optional(),
  portfolioId: z.coerce.number().int().positive().optional(),
  stockId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** Ownership check: the portfolio must belong to the authenticated user. */
async function assertPortfolioOwnership(userId: number, portfolioId: number): Promise<void> {
  const owned = await prisma.portfolios.findFirst({
    where: { portfolio_id: portfolioId, user_id: userId },
    select: { portfolio_id: true },
  });
  if (!owned) throw forbidden("You don't have access to this portfolio.");
}

export const intelligenceRouter = Router();

intelligenceRouter.use(requireAuth);

intelligenceRouter.get(
  "/portfolio/impacts",
  validate(impactsQuerySchema, "query"),
  async (req, res, next) => {
    try {
      const q = req.query as unknown as z.infer<typeof impactsQuerySchema>;
      if (q.portfolioId !== undefined) {
        await assertPortfolioOwnership(currentUser(req).userId, q.portfolioId);
      }
      let impacts = await impactService.getUserImpacts(currentUser(req).userId, {
        severity: q.severity,
        direction: q.direction,
        exposureType: q.exposureType,
        limit: q.limit,
      });
      if (q.portfolioId !== undefined) {
        impacts = impacts.filter((i) => i.portfolioId === String(q.portfolioId));
      }
      if (q.stockId !== undefined) {
        impacts = impacts.filter((i) => i.stockId === String(q.stockId));
      }
      res.json({ data: impacts });
    } catch (error) {
      next(error);
    }
  },
);

intelligenceRouter.get("/portfolio/exposure", async (req, res, next) => {
  try {
    const exposure = await getUserPortfolioExposure(currentUser(req).userId);
    res.json({
      data: {
        priceAsOf: exposure.priceAsOf,
        stalePrices: exposure.stalePrices,
        portfolios: exposure.portfolios.map((p) => ({
          portfolioId: String(p.portfolioId),
          portfolioName: p.portfolioName,
          totalValue: p.totalValue,
          priceAsOf: p.priceAsOf,
          stalePrices: p.stalePrices,
          holdings: Array.from(p.byStock.values()).map((h) => ({
            stockId: String(h.stockId),
            symbol: h.symbol,
            sector: h.sector,
            quantity: h.quantity,
            latestPrice: h.latestPrice,
            priceAsOf: h.priceAsOf,
            marketValue: h.marketValue,
            portfolioWeightPct: h.portfolioWeight === null ? null : Number((h.portfolioWeight * 100).toFixed(2)),
          })),
          sectors: Array.from(p.bySector.entries()).map(([sector, s]) => ({
            sector,
            weightPct: Number((s.weight * 100).toFixed(2)),
            value: s.value,
          })),
        })),
        userAggregate: Array.from(exposure.userAggregateByStock.entries()).map(([stockId, a]) => ({
          stockId: String(stockId),
          value: a.value,
          weightPct: a.weight === null ? null : Number((a.weight * 100).toFixed(2)),
        })),
        watchlistStockIds: Array.from(exposure.watchlistStockIds).map(String),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Phase 3 — alert delivery views + evidence-backed event detail
// ---------------------------------------------------------------------------

const idParam = z.object({ id: z.coerce.number().int().positive() });
const eventParam2 = z.object({ eventId: z.coerce.number().int().positive() });
const stockParam = z.object({ stockId: z.coerce.number().int().positive() });

/** My INTELLIGENCE alerts (unread first), scoped to the authenticated user. */
intelligenceRouter.get(
  "/alerts",
  validate(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), "query"),
  async (req, res, next) => {
    try {
      const q = req.query as unknown as { limit: number };
      res.json({ data: await readService.getUserIntelligenceAlerts(currentUser(req).userId, q.limit) });
    } catch (error) {
      next(error);
    }
  },
);

/** Mark one of MY intelligence alerts read. Others' alerts → 404. */
intelligenceRouter.post("/alerts/:id/read", validate(idParam, "params"), async (req, res, next) => {
  try {
    const result = await readService.markIntelligenceAlertRead(
      currentUser(req).userId,
      Number(req.params["id"]),
    );
    if (result === null) throw notFound("We couldn't find that alert.");
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

/**
 * Event detail: summary, source evidence, affected stocks/sectors and MY
 * exposure rows. Other users' impacts are never included.
 */
intelligenceRouter.get("/events/:id", validate(idParam, "params"), async (req, res, next) => {
  try {
    const detail = await readService.getEventDetailForUser(
      Number(req.params["id"]),
      currentUser(req).userId,
    );
    if (!detail) throw notFound("We couldn't find that event.");
    res.json({ data: detail });
  } catch (error) {
    next(error);
  }
});

/** Recent intelligence for one stock (shared, no personal exposure data). */
intelligenceRouter.get("/stocks/:stockId", validate(stockParam, "params"), async (req, res, next) => {
  try {
    const q = req.query as unknown as { limit?: number };
    const intel = await readService.getStockIntelligence(
      Number(req.params["stockId"]),
      Math.min(20, Math.max(1, Number(q.limit ?? 5))),
    );
    if (!intel) throw notFound("We couldn't find that stock.");
    res.json({ data: intel });
  } catch (error) {
    next(error);
  }
});

/** Exposure summary for the Intelligence page (per-stock rollup). */
intelligenceRouter.get("/summary", async (req, res, next) => {
  try {
    res.json({ data: await readService.getIntelligenceSummary(currentUser(req).userId) });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Phase 4 — quantitative risk intelligence (ownership-checked per portfolio)
// ---------------------------------------------------------------------------

intelligenceRouter.get("/risk/overview", validate(z.object({ portfolioId: z.coerce.number().int().positive() }), "query"), riskController.riskOverview);

intelligenceRouter.get("/risk/attribution", validate(z.object({ portfolioId: z.coerce.number().int().positive() }), "query"), riskController.riskAttribution);

intelligenceRouter.get("/risk/correlation", validate(z.object({ portfolioId: z.coerce.number().int().positive() }), "query"), riskController.riskCorrelation);

intelligenceRouter.get("/risk/history", validate(z.object({ portfolioId: z.coerce.number().int().positive() }), "query"), riskController.riskHistory);

intelligenceRouter.get("/risk/stress", validate(z.object({ portfolioId: z.coerce.number().int().positive() }), "query"), riskController.scenarioStress);

// ---------------------------------------------------------------------------
// Phase 5 — historical analogues + scenario lab
// ---------------------------------------------------------------------------

intelligenceRouter.get("/analogues/:eventId", validate(z.object({ eventId: z.coerce.number().int().positive() }), "params"), riskController.eventAnalogues);

intelligenceRouter.post("/scenarios/analyze", riskController.scenarioAnalyze);

intelligenceRouter.post("/scenarios/compare", riskController.scenarioCompare);

intelligenceRouter.post("/scenarios/what-if", riskController.scenarioWhatIf);

// ---------------------------------------------------------------------------
// Phase 6 — event → scenario orchestration + portfolio summary
// ---------------------------------------------------------------------------

intelligenceRouter.get("/events/:eventId/intelligence", validate(eventParam2, "params"), riskController.eventIntelligence);

intelligenceRouter.post("/events/:eventId/scenario", validate(eventParam2, "params"), riskController.eventScenarioRun);

intelligenceRouter.get("/portfolio-summary", validate(z.object({ portfolioId: z.coerce.number().int().positive() }), "query"), riskController.portfolioIntelligenceSummary);

// ---------------------------------------------------------------------------
// Phase 7 — benchmark + persistent risk history
// ---------------------------------------------------------------------------

intelligenceRouter.get("/risk/benchmark", validate(z.object({ portfolioId: z.coerce.number().int().positive() }), "query"), riskController.riskBenchmark);

intelligenceRouter.get("/risk/snapshots", validate(z.object({ portfolioId: z.coerce.number().int().positive(), limit: z.coerce.number().int().min(1).max(365).optional() }), "query"), riskController.riskSnapshots);

// ---------------------------------------------------------------------------
// Phase 8 — transaction-true performance + health score
// ---------------------------------------------------------------------------

intelligenceRouter.get("/performance/transactions", validate(z.object({ portfolioId: z.coerce.number().int().positive() }), "query"), riskController.performanceTransactions);

intelligenceRouter.get("/health-score", validate(z.object({ portfolioId: z.coerce.number().int().positive() }), "query"), riskController.healthScore);
