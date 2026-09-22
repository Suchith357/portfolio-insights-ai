/**
 * Quantitative risk + scenario endpoints (Phase 4/5).
 * Every handler verifies PORTFOLIO OWNERSHIP before any calculation.
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.js";
import { currentUser } from "../middleware/auth.js";
import { ok, notFound, forbidden } from "../utils/http.js";
import { prisma } from "../utils/prisma.js";
import { recordAudit } from "../utils/audit.js";
import * as risk from "../services/news/quantitative-risk.service.js";
import * as analogues from "../services/news/historical-analogue.service.js";
import * as scenarios from "../services/news/scenario.service.js";
import { ScenarioValidationError, type ShockInput } from "../services/news/scenario.service.js";
import * as eventIntel from "../services/news/event-scenario-intelligence.service.js";
import * as benchmarkPerf from "../services/benchmark-performance.service.js";
import * as txPerf from "../services/transaction-performance.service.js";
import * as snapshots from "../services/risk-snapshot.service.js";
import * as health from "../services/health-score.service.js";

/** Load an owned portfolio or throw 404/403. */
async function ownedPortfolio(userId: number, portfolioId: number) {
  const p = await prisma.portfolios.findUnique({
    where: { portfolio_id: portfolioId },
    select: { portfolio_id: true, user_id: true, name: true },
  });
  if (!p) throw notFound("We couldn't find that portfolio.");
  if (p.user_id !== userId) throw forbidden("You don't have access to this portfolio.");
  return p;
}

async function ownedHoldings(portfolioId: number) {
  return prisma.holdings.findMany({
    where: { portfolio_id: portfolioId },
    select: { stock_id: true, quantity: true, stocks: { select: { symbol: true, sector: true } } },
    orderBy: { stock_id: "asc" },
  });
}

const portfolioParam = z.object({ portfolioId: z.coerce.number().int().positive() });

export const riskOverview = asyncHandler(async (req: Request, res: Response) => {
  const q = portfolioParam.parse(req.query);
  const userId = currentUser(req).userId;
  const p = await ownedPortfolio(userId, q.portfolioId);
  const holdings = await ownedHoldings(p.portfolio_id);
  const data = await risk.getRiskOverview(
    p.portfolio_id,
    holdings.map((h) => ({
      stock_id: h.stock_id,
      symbol: h.stocks.symbol,
      sector: h.stocks.sector,
      quantity: Number(h.quantity),
    })),
  );
  ok(res, { ...data, portfolioMeta: { portfolioId: String(p.portfolio_id), name: p.name } });
});

export const riskAttribution = asyncHandler(async (req: Request, res: Response) => {
  const q = portfolioParam.parse(req.query);
  const userId = currentUser(req).userId;
  const p = await ownedPortfolio(userId, q.portfolioId);
  const holdings = await ownedHoldings(p.portfolio_id);
  const rows = holdings.map((h) => ({
    stock_id: h.stock_id,
    symbol: h.stocks.symbol,
    sector: h.stocks.sector,
    quantity: Number(h.quantity),
  }));
  const bundle = await risk.loadAlignedSeries(rows.map((r) => r.stock_id));
  ok(res, { portfolioMeta: { portfolioId: String(p.portfolio_id), name: p.name }, attribution: risk.performanceAttribution(bundle, rows) });
});

export const riskCorrelation = asyncHandler(async (req: Request, res: Response) => {
  const q = portfolioParam.parse(req.query);
  const userId = currentUser(req).userId;
  const p = await ownedPortfolio(userId, q.portfolioId);
  const holdings = await ownedHoldings(p.portfolio_id);
  const bundle = await risk.loadAlignedSeries(holdings.map((h) => h.stock_id));
  ok(res, {
    portfolioMeta: { portfolioId: String(p.portfolio_id), name: p.name },
    correlation: risk.correlationStats(
      bundle.returns,
      holdings.map((h) => h.stocks.symbol),
    ),
    provenance: { latestDataDate: bundle.latestDate, observationDays: bundle.returns[0]?.length ?? 0 },
  });
});

export const riskHistory = asyncHandler(async (req: Request, res: Response) => {
  const q = portfolioParam.parse(req.query);
  const userId = currentUser(req).userId;
  const p = await ownedPortfolio(userId, q.portfolioId);
  const holdings = await ownedHoldings(p.portfolio_id);
  const rows = holdings.map((h) => ({
    stock_id: h.stock_id,
    symbol: h.stocks.symbol,
    sector: h.stocks.sector,
    quantity: Number(h.quantity),
  }));
  const bundle = await risk.loadAlignedSeries(rows.map((r) => r.stock_id));
  const idxById = new Map(bundle.symbols.map((s, i) => [Number(s), i]));
  const ordered = rows.map((r) => idxById.get(r.stock_id)).filter((i): i is number => i !== undefined);
  const closes = ordered.map((i) => bundle.closes[i]!);
  const qty = ordered.map((i) => rows.find((r) => Number(bundle.symbols[i]) === r.stock_id)?.quantity ?? 0);
  const pv: number[] = [];
  const t = closes[0]?.length ?? 0;
  for (let i = 0; i < t; i++) pv.push(closes.reduce((acc, c, h) => acc + c[i]! * qty[h]!, 0));
  const rolling = risk.rollingRisk(pv, bundle.dates);
  ok(res, {
    portfolioMeta: { portfolioId: String(p.portfolio_id), name: p.name },
    rolling,
    provenance: { latestDataDate: bundle.latestDate, observationDays: t },
  });
});

/* ---------------------------------- analogues -------------------------------- */

const eventParam = z.object({ eventId: z.coerce.number().int().positive() });

export const eventAnalogues = asyncHandler(async (req: Request, res: Response) => {
  const p = eventParam.parse(req.params);
  const result = await analogues.findAnalogues(p.eventId);
  if (!result) throw notFound("We couldn't find that event.");
  ok(res, result);
});

/* ---------------------------------- scenarios -------------------------------- */

const shockSchema = z.object({
  stockId: z.coerce.number().int().positive().optional(),
  sector: z.string().trim().min(1).max(60).optional(),
  shockPct: z.coerce.number().min(-100).max(500),
});

const analyzeSchema = z.object({
  portfolioId: z.coerce.number().int().positive(),
  shocks: z.array(shockSchema).min(1).max(50),
});

export const scenarioAnalyze = asyncHandler(async (req: Request, res: Response) => {
  const body = analyzeSchema.parse(req.body);
  const userId = currentUser(req).userId;
  const p = await ownedPortfolio(userId, body.portfolioId);
  try {
    const result = await scenarios.applyShocks(p.portfolio_id, body.shocks);
    await recordAudit({
      userId,
      action: "ANALYSIS_SNAPSHOT",
      entityType: "PORTFOLIO",
      entityId: p.portfolio_id,
      details: `Scenario run: ${body.shocks.length} shock(s) → ${result.impact.portfolioImpactPct}% direct estimate.`,
    });
    ok(res, result);
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: error.message } });
      return;
    }
    throw error;
  }
});

const compareSchema = z.object({
  portfolioId: z.coerce.number().int().positive(),
  scenarios: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(60),
        shocks: z.array(shockSchema).min(1).max(50),
      }),
    )
    .min(2)
    .max(3),
});

export const scenarioCompare = asyncHandler(async (req: Request, res: Response) => {
  const body = compareSchema.parse(req.body);
  const userId = currentUser(req).userId;
  const p = await ownedPortfolio(userId, body.portfolioId);
  try {
    const result = await scenarios.compareScenarios(p.portfolio_id, body.scenarios);
    await recordAudit({
      userId,
      action: "ANALYSIS_SNAPSHOT",
      entityType: "PORTFOLIO",
      entityId: p.portfolio_id,
      details: `Scenario comparison: ${body.scenarios.length} scenarios.`,
    });
    ok(res, result);
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: error.message } });
      return;
    }
    throw error;
  }
});

const whatIfSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ADD_POSITION"), portfolioId: z.coerce.number().int().positive(), stockId: z.coerce.number().int().positive(), amount: z.coerce.number().positive().max(1_000_000_000) }),
  z.object({ kind: z.literal("REMOVE_POSITION"), portfolioId: z.coerce.number().int().positive(), stockId: z.coerce.number().int().positive() }),
  z.object({ kind: z.literal("REBALANCE"), portfolioId: z.coerce.number().int().positive(), stockId: z.coerce.number().int().positive(), targetWeightPct: z.coerce.number().min(0).max(100) }),
]);

export const scenarioWhatIf = asyncHandler(async (req: Request, res: Response) => {
  const body = whatIfSchema.parse(req.body);
  const userId = currentUser(req).userId;
  const p = await ownedPortfolio(userId, body.portfolioId);
  try {
    const { portfolioId: _ignored, ...input } = body;
    void _ignored;
    const result = await scenarios.runWhatIf(p.portfolio_id, input as Parameters<typeof scenarios.runWhatIf>[1]);
    await recordAudit({
      userId,
      action: "ANALYSIS_SNAPSHOT",
      entityType: "PORTFOLIO",
      entityId: p.portfolio_id,
      details: `What-if (${body.kind}) run.`,
    });
    ok(res, result);
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: error.message } });
      return;
    }
    throw error;
  }
});

export const scenarioStress = asyncHandler(async (req: Request, res: Response) => {
  const q = portfolioParam.parse(req.query);
  const userId = currentUser(req).userId;
  const p = await ownedPortfolio(userId, q.portfolioId);
  try {
    const result = await scenarios.runStressSuite(p.portfolio_id);
    await recordAudit({
      userId,
      action: "ANALYSIS_SNAPSHOT",
      entityType: "PORTFOLIO",
      entityId: p.portfolio_id,
      details: `Stress suite run: ${result.runs.length} scenarios.`,
    });
    ok(res, result);
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: error.message } });
      return;
    }
    throw error;
  }
});

// ---------------------------------------------------------------------------
// Phase 6 — event → scenario orchestration
// ---------------------------------------------------------------------------

// (eventParam reused from the Phase 5 analogue section above)


/** GET /api/intelligence/events/:eventId/intelligence?portfolioId= */
export const eventIntelligence = asyncHandler(async (req: Request, res: Response) => {
  const { eventId } = eventParam.parse(req.params);
  const parsed = z.object({ portfolioId: z.coerce.number().int().positive().optional() }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid portfolioId." } });
    return;
  }
  const userId = currentUser(req).userId;
  ok(res, await eventIntel.getEventIntelligence(userId, eventId, parsed.data.portfolioId));
});

/** POST /api/intelligence/events/:eventId/scenario — one-click what-if. */
export const eventScenarioRun = asyncHandler(async (req: Request, res: Response) => {
  const { eventId } = eventParam.parse(req.params);
  const body = z
    .object({
      portfolioId: z.coerce.number().int().positive(),
      shocks: z
        .array(
          z.object({
            stockId: z.coerce.number().int().positive().optional(),
            sector: z.string().trim().min(1).max(100).optional(),
            shockPct: z.coerce.number().min(-100).max(500),
          }),
        )
        .min(1)
        .max(50),
    })
    .parse(req.body);
  const userId = currentUser(req).userId;
  try {
    const result = await eventIntel.runEventScenario(userId, eventId, body.portfolioId, body.shocks as ShockInput[]);
    await recordAudit({
      userId,
      action: "SCENARIO_RUN",
      entityType: "EVENT",
      entityId: eventId,
      details: `Event what-if run on portfolio ${body.portfolioId} with ${body.shocks.length} shock(s).`,
    });
    ok(res, result);
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: error.message } });
      return;
    }
    throw error;
  }
});

/** GET /api/intelligence/portfolio-summary?portfolioId= */
export const portfolioIntelligenceSummary = asyncHandler(async (req: Request, res: Response) => {
  const q = portfolioParam.parse(req.query);
  const userId = currentUser(req).userId;
  ok(res, await eventIntel.getPortfolioIntelligenceSummary(userId, q.portfolioId));
});

// ---------------------------------------------------------------------------
// Phase 7 — benchmark performance + persistent risk history
// ---------------------------------------------------------------------------

/** GET /api/intelligence/risk/benchmark?portfolioId= */
export const riskBenchmark = asyncHandler(async (req: Request, res: Response) => {
  const q = portfolioParam.parse(req.query);
  const userId = currentUser(req).userId;
  const p = await ownedPortfolio(userId, q.portfolioId);
  const holdings = await ownedHoldings(p.portfolio_id);
  const rows = holdings.map((h) => ({
    stock_id: h.stock_id,
    symbol: h.stocks.symbol,
    sector: h.stocks.sector,
    quantity: Number(h.quantity),
  }));
  ok(res, { portfolioMeta: { portfolioId: String(p.portfolio_id), name: p.name }, performance: await benchmarkPerf.benchmarkPerformance(p.portfolio_id, rows) });
});

/** GET /api/intelligence/risk/snapshots?portfolioId= — persistent history. */
export const riskSnapshots = asyncHandler(async (req: Request, res: Response) => {
  const q = z.object({ portfolioId: z.coerce.number().int().positive(), limit: z.coerce.number().int().min(1).max(365).optional() }).parse(req.query);
  const userId = currentUser(req).userId;
  const p = await ownedPortfolio(userId, q.portfolioId);
  ok(res, { portfolioMeta: { portfolioId: String(p.portfolio_id), name: p.name }, snapshots: await snapshots.snapshotHistory(p.portfolio_id, q.limit ?? 180) });
});

// ---------------------------------------------------------------------------
// Phase 8 — transaction-true performance + health score
// ---------------------------------------------------------------------------

/** GET /api/intelligence/performance/transactions?portfolioId= */
export const performanceTransactions = asyncHandler(async (req: Request, res: Response) => {
  const q = portfolioParam.parse(req.query);
  const userId = currentUser(req).userId;
  const p = await ownedPortfolio(userId, q.portfolioId);
  ok(res, { portfolioMeta: { portfolioId: String(p.portfolio_id), name: p.name }, performance: await txPerf.transactionPerformance(p.portfolio_id) });
});

/** GET /api/intelligence/health-score?portfolioId= */
export const healthScore = asyncHandler(async (req: Request, res: Response) => {
  const q = portfolioParam.parse(req.query);
  const userId = currentUser(req).userId;
  const p = await ownedPortfolio(userId, q.portfolioId);
  const holdings = await ownedHoldings(p.portfolio_id);
  const rows = holdings.map((h) => ({
    stock_id: h.stock_id,
    symbol: h.stocks.symbol,
    sector: h.stocks.sector,
    quantity: Number(h.quantity),
  }));
  ok(res, { portfolioMeta: { portfolioId: String(p.portfolio_id), name: p.name }, health: await health.portfolioHealthScore(userId, p.portfolio_id, { holdings: rows }) });
});
