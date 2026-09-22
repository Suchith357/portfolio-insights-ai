import { asyncHandler } from "../middleware/error.js";
import { currentUser } from "../middleware/auth.js";
import { ok } from "../utils/http.js";
import * as analysisService from "../services/analysis.service.js";
import { marketDataFreshness } from "../services/market-data.sync.js";

/** GET /api/portfolios/:id/analysis — computed metrics (read-only view). */
export const portfolioAnalysis = asyncHandler(async (req, res) => {
  const result = await analysisService.analyzePortfolio(currentUser(req).userId, Number(req.params["id"]));
  ok(res, result);
});

/** POST /api/portfolios/:id/analyze — computed metrics + stored snapshot. */
export const analyzeAndSnapshot = asyncHandler(async (req, res) => {
  const result = await analysisService.analyzePortfolio(currentUser(req).userId, Number(req.params["id"]), true);
  ok(res, result);
});

/** GET /api/analysis/overview — aggregate metrics across all user portfolios. */
export const overview = asyncHandler(async (req, res) => {
  const [result, freshness] = await Promise.all([
    analysisService.getAggregateMetrics(currentUser(req).userId),
    marketDataFreshness(),
  ]);
  ok(res, result, 200, { freshness });
});

/**
 * GET /api/analysis/market-freshness — platform-wide market-data freshness
 * for the global header badge. Lightweight (three indexed lookups).
 */
export const marketFreshness = asyncHandler(async (req, res) => {
  ok(res, await marketDataFreshness());
});

/** GET /api/analysis/stock/:symbol — standalone stock risk profile. */
export const stockRisk = asyncHandler(async (req, res) => {
  const risk = await analysisService.getStockRiskProfile(String(req.params["symbol"]));
  ok(res, risk);
});

/**
 * POST /api/analysis/buy-simulation — read-only simulation.
 * Body: { portfolioId, symbol, amount }. Never mutates database state.
 */
export const buySimulation = asyncHandler(async (req, res) => {
  const result = await analysisService.simulateBuy(
    currentUser(req).userId,
    Number(req.body.portfolioId),
    String(req.body.symbol),
    Number(req.body.amount),
  );
  ok(res, result);
});

/**
 * POST /api/analysis/sell-simulation — read-only simulation.
 * Body: { holdingId, pct }. Never mutates database state.
 */
export const sellSimulation = asyncHandler(async (req, res) => {
  const result = await analysisService.simulateSell(
    currentUser(req).userId,
    Number(req.body.holdingId),
    Number(req.body.pct),
  );
  ok(res, result);
});

/**
 * POST /api/analysis/:id/refresh — invoke the sp_refresh_portfolio_analysis
 * stored procedure (in-database snapshot recomputation). Owner-scoped.
 */
export const refreshSnapshot = asyncHandler(async (req, res) => {
  const result = await analysisService.refreshPortfolioAnalysisViaProcedure(
    currentUser(req).userId,
    Number(req.params["id"]),
    currentUser(req).role === "ADMIN",
  );
  ok(res, result, 201);
});

/** GET /api/analysis/correlation/:symbol — candidate vs portfolio correlation. */
export const correlation = asyncHandler(async (req, res) => {
  const value = await analysisService.correlationWithPortfolio(
    currentUser(req).userId,
    String(req.params["symbol"]),
  );
  ok(res, { correlation: value });
});
