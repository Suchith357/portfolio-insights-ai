import { prisma } from "../utils/prisma.js";
import { latestHomogeneousSegment } from "./analytics.service.js";
import { notFound, forbidden } from "../utils/http.js";
import { recordAudit } from "../utils/audit.js";
import { toHoldingDto, type HoldingDto } from "../utils/mappers.js";
import {
  computeMetrics,
  getStockRiskProfile as getStockRiskProfileFromSeries,
  portfolioCorrelation,
  portfolioValueSeries,
  type PortfolioMetrics,
  type PositionInput,
  type PricePoint,
  type StockMeta,
  type StockRiskProfile,
} from "./analytics.service.js";
import { explainBuySimulation, explainPortfolio, explainSellSimulation, type AiInsight } from "./ai.service.js";
import { generateAlertsSafely } from "./alert-generation.service.js";

export interface HoldingViewDto extends HoldingDto {
  stock: {
    id: string;
    symbol: string;
    name: string;
    sector: string;
    exchange: string;
    currency: "INR";
    lastPrice: number;
    previousClose: number;
    marketCapCr: number | null;
  };
  risk: StockRiskProfile;
  invested: number;
  currentValue: number;
  pnl: number;
  pnlPct: number;
  allocationPct: number;
}

export interface PortfolioViewDto {
  portfolio: {
    id: string;
    userId: string;
    name: string;
    description: string;
    baseCurrency: "INR";
    createdAt: string;
  };
  holdings: HoldingViewDto[];
  metrics: PortfolioMetrics;
  insights: AiInsight[];
  valueSeries: PricePoint[];
  analysisHistory: Array<{
    id: string;
    riskScore: number;
    diversificationScore: number;
    volatility: number;
    maxDrawdown: number;
    return1y: number | null;
    return3y: number | null;
    return5y: number | null;
    analyzedAt: string;
  }>;
}

export interface BuySimulationResult {
  before: PortfolioMetrics;
  after: PortfolioMetrics;
  deltas: Array<{
    label: string;
    before: number | null;
    after: number | null;
    unit: "score" | "pct" | "currency";
    betterWhenLower?: boolean;
  }>;
  fitScore: number;
  classification: "Strong Fit" | "Reasonable Fit" | "Weak Fit" | "Poor Fit";
  reasons: string[];
  insight: AiInsight;
}

export interface SellSimulationResult {
  before: PortfolioMetrics;
  after: PortfolioMetrics;
  deltas: BuySimulationResult["deltas"];
  proceeds: number;
  realisedPnl: number;
  recommendation: "HOLD" | "REVIEW" | "CONSIDER REDUCING";
  reasons: string[];
  insight: AiInsight;
}

/** Loads the holding rows of one owned portfolio as plain analytics inputs. */
async function loadPortfolioContext(userId: number, portfolioId: number) {
  const portfolio = await prisma.portfolios.findUnique({ where: { portfolio_id: portfolioId } });
  if (!portfolio || portfolio.user_id !== userId) {
    throw notFound("We couldn't find that portfolio.");
  }

  const holdings = await prisma.holdings.findMany({
    where: { portfolio_id: portfolioId },
    include: { stocks: true },
    orderBy: { holding_id: "asc" },
  });

  return { portfolio, holdings };
}

/** Builds symbol-keyed maps of stock metadata and price history. */
async function buildMarketData(symbols: string[]) {
  const unique = [...new Set(symbols)];
  const stocks = unique.length
    ? await prisma.stocks.findMany({ where: { symbol: { in: unique } } })
    : [];

  const metaBySymbol = new Map<string, StockMeta>();
  const stockIdToSymbol = new Map<number, string>();
  for (const s of stocks) {
    stockIdToSymbol.set(s.stock_id, s.symbol);
  }

  const prices = unique.length
    ? await prisma.stock_prices.findMany({
        where: { stock_id: { in: [...stockIdToSymbol.keys()] } },
        orderBy: [{ stock_id: "asc" }, { price_date: "asc" }],
        select: { stock_id: true, price_date: true, close_price: true, data_source: true },
      })
    : [];

  const historyBySymbol = new Map<string, PricePoint[]>();
  const sourceBySymbol = new Map<string, Map<string, string>>();
  for (const p of prices) {
    const symbol = stockIdToSymbol.get(p.stock_id);
    if (!symbol) continue;
    const arr = historyBySymbol.get(symbol) ?? [];
    arr.push({ date: p.price_date.toISOString().slice(0, 10), close: Number(p.close_price) });
    historyBySymbol.set(symbol, arr);
    const srcMap = sourceBySymbol.get(symbol) ?? new Map<string, string>();
    srcMap.set(p.price_date.toISOString().slice(0, 10), p.data_source);
    sourceBySymbol.set(symbol, srcMap);
  }
  // Mixed-provenance guard: synthetic weekly DEMO bars followed by real daily
  // YAHOO bars must never be blended — the junction fabricates returns. Keep
  // only each series' latest homogeneous segment (YAHOO when present).
  for (const [symbol, series] of historyBySymbol) {
    historyBySymbol.set(symbol, latestHomogeneousSegment(series, sourceBySymbol.get(symbol)));
  }

  // lastPrice / previousClose come from the tail of each series.
  const lastTwoBySymbol = new Map<string, { last: number; prev: number }>();
  for (const s of stocks) {
    const series = historyBySymbol.get(s.symbol) ?? [];
    const last = series[series.length - 1]?.close ?? 0;
    const prev = series[series.length - 2]?.close ?? last;
    lastTwoBySymbol.set(s.symbol, { last, prev });
    metaBySymbol.set(s.symbol, {
      symbol: s.symbol,
      sector: s.sector,
      lastPrice: last,
      previousClose: prev,
      dataSource: s.data_source,
      lastPriceDate: series.length > 0 ? (series[series.length - 1]?.date ?? null) : null,
    });
  }

  return { metaBySymbol, historyBySymbol, lastTwoBySymbol, stocks };
}

function toPositions(holdings: Array<{ stocks: { symbol: string }; quantity: unknown; average_buy_price: unknown }>): PositionInput[] {
  return holdings.map((h) => ({
    symbol: h.stocks.symbol,
    quantity: Number(h.quantity),
    avgBuyPrice: Number(h.average_buy_price),
  }));
}

function buildHoldingViews(
  holdings: ReturnType<typeof toPositions> extends never ? never : Array<{
    holding_id: number;
    portfolio_id: number;
    stock_id: number;
    quantity: unknown;
    average_buy_price: unknown;
    created_at: Date;
    stocks: { stock_id: number; symbol: string; company_name: string; sector: string; exchange: string; market_cap: unknown };
  }>,
  lastTwoBySymbol: Map<string, { last: number; prev: number }>,
  historyBySymbol?: Map<string, PricePoint[]>,
): HoldingViewDto[] {
  const views = holdings.map((h) => {
    const symbol = h.stocks.symbol;
    const prices = lastTwoBySymbol.get(symbol) ?? { last: 0, prev: 0 };
    const series = historyBySymbol?.get(symbol) ?? [];
    const quantity = Number(h.quantity);
    const avg = Number(h.average_buy_price);
    const invested = quantity * avg;
    const currentValue = quantity * prices.last;
    return {
      id: String(h.holding_id),
      portfolioId: String(h.portfolio_id),
      stockId: String(h.stock_id),
      symbol,
      quantity,
      avgBuyPrice: avg,
      addedAt: h.created_at.toISOString(),
      stock: {
        id: String(h.stocks.stock_id),
        symbol,
        name: h.stocks.company_name,
        sector: h.stocks.sector,
        exchange: h.stocks.exchange,
        currency: "INR" as const,
        lastPrice: prices.last,
        previousClose: prices.prev,
        marketCapCr: h.stocks.market_cap === null || h.stocks.market_cap === undefined ? null : Number(h.stocks.market_cap),
      },
      invested,
      currentValue,
      pnl: currentValue - invested,
      pnlPct: invested > 0 ? ((currentValue - invested) / invested) * 100 : 0,
      allocationPct: 0,
      risk: series.length >= 2
        ? getStockRiskProfileFromSeries(series)
        : {
            volatilityPct: null,
            maxDrawdownPct: null,
            return1yPct: null,
            return3yPct: null,
            return5yPct: null,
            riskBand: "Insufficient Data" as const,
            observations: series.length,
          },
    };
  });

  const total = views.reduce((s, h) => s + h.currentValue, 0);
  for (const v of views) {
    v.allocationPct = total > 0 ? (v.currentValue / total) * 100 : 0;
  }
  views.sort((a, b) => b.currentValue - a.currentValue);
  return views;
}

/**
 * GET /api/portfolios/:id/analysis (persistSnapshot=false) — read-only view.
 * POST /api/portfolios/:id/analyze (persistSnapshot=true) — also stores a
 * point-in-time snapshot in portfolio_analysis for the history feature.
 */
export async function analyzePortfolio(userId: number, portfolioId: number, persistSnapshot = false) {
  const { portfolio, holdings } = await loadPortfolioContext(userId, portfolioId);
  const positions = toPositions(holdings);
  const { metaBySymbol, historyBySymbol, lastTwoBySymbol, stocks } = await buildMarketData(
    positions.map((p) => p.symbol),
  );

  const metrics = computeMetrics(positions, metaBySymbol, historyBySymbol);
  const insights = explainPortfolio(metrics);
  const valueSeries = portfolioValueSeries(positions, metaBySymbol, historyBySymbol);

  // Analytical alert generation — deterministic, deduped against unread
  // copies, and best-effort so it can never fail the analysis request.
  const stockIdBySymbol = new Map(stocks.map((s) => [s.symbol, s.stock_id]));
  await generateAlertsSafely(userId, portfolio.portfolio_id, metrics, stockIdBySymbol);

  // Point-in-time snapshot for the analysis history feature. Only recorded
  // when the risk statistics are actually computable — an insufficient-data
  // analysis is never persisted as zeros (that would fake "low risk").
  const snapshot = persistSnapshot && metrics.riskDataSufficient
    ? await prisma.portfolio_analysis.create({
        data: {
          portfolio_id: portfolio.portfolio_id,
          risk_score: metrics.riskScore ?? 0,
          diversification_score: metrics.diversificationScore,
          volatility: metrics.annualisedVolatilityPct ?? 0,
          max_drawdown: metrics.maxDrawdownPct ?? 0,
          return_1y: metrics.return1yPct,
          return_3y: metrics.return3yPct,
          return_5y: metrics.return5yPct,
        },
      })
    : null;

  if (persistSnapshot) {
    await recordAudit({
      userId,
      action: "ANALYSIS_SNAPSHOT",
      entityType: "PORTFOLIO",
      entityId: portfolio.portfolio_id,
      details: `Analysis recorded for ${portfolio.name}.`,
    });
  }

  const history = await prisma.portfolio_analysis.findMany({
    where: { portfolio_id: portfolio.portfolio_id },
    orderBy: { analyzed_at: "desc" },
    take: 10,
  });

  return {
    portfolio: {
      id: String(portfolio.portfolio_id),
      userId: String(portfolio.user_id),
      name: portfolio.name,
      description: portfolio.description ?? "",
      baseCurrency: "INR" as const,
      createdAt: portfolio.created_at.toISOString(),
    },
    metrics,
    holdings: buildHoldingViews(holdings, lastTwoBySymbol, historyBySymbol),
    insights,
    valueSeries,
    analysisHistory: history.map((h) => ({
      id: String(h.analysis_id),
      riskScore: Number(h.risk_score),
      diversificationScore: Number(h.diversification_score),
      volatility: Number(h.volatility),
      maxDrawdown: Number(h.max_drawdown),
      return1y: h.return_1y === null ? null : Number(h.return_1y),
      return3y: h.return_3y === null ? null : Number(h.return_3y),
      return5y: h.return_5y === null ? null : Number(h.return_5y),
      analyzedAt: h.analyzed_at.toISOString(),
    })),
    snapshotId: snapshot ? String(snapshot.analysis_id) : null,
    stocksCatalogue: stocks.map((s) => ({ id: String(s.stock_id), symbol: s.symbol })),
  };
}

export async function getStockRiskProfile(symbol: string): Promise<StockRiskProfile> {
  const stock = await prisma.stocks.findFirst({ where: { symbol: symbol.toUpperCase() } });
  if (!stock) throw notFound("We couldn't find that stock.");

  const prices = await prisma.stock_prices.findMany({
    where: { stock_id: stock.stock_id },
    orderBy: { price_date: "asc" },
    select: { price_date: true, close_price: true, data_source: true },
  });
  const series: PricePoint[] = prices.map((p) => ({
    date: p.price_date.toISOString().slice(0, 10),
    close: Number(p.close_price),
  }));
  const sourceByDate = new Map(prices.map((p) => [p.price_date.toISOString().slice(0, 10), p.data_source]));
  return getStockRiskProfileFromSeries(series, sourceByDate);
}

/** Aggregated metrics across every portfolio the user owns (dashboard). */
export async function getAggregateMetrics(userId: number) {
  const holdings = await prisma.holdings.findMany({
    where: { portfolios: { user_id: userId } },
    include: { stocks: true },
    orderBy: { holding_id: "asc" },
  });

  const positions = toPositions(holdings);
  const { metaBySymbol, historyBySymbol, lastTwoBySymbol } = await buildMarketData(
    positions.map((p) => p.symbol),
  );

  const metrics = computeMetrics(positions, metaBySymbol, historyBySymbol);
  const insights = explainPortfolio(metrics);
  const valueSeries = portfolioValueSeries(positions, metaBySymbol, historyBySymbol);

  const views = buildHoldingViews(holdings, lastTwoBySymbol, historyBySymbol);
  return { metrics, holdings: views, insights, valueSeries };
}

/**
 * POST /api/analysis/buy-simulation
 * Pure computation over a hypothetical lot — no database writes anywhere.
 */
export async function simulateBuy(userId: number, portfolioId: number, symbol: string, amount: number): Promise<BuySimulationResult> {
  const { holdings } = await loadPortfolioContext(userId, portfolioId);
  const positions = toPositions(holdings);
  const upper = symbol.toUpperCase();

  const { metaBySymbol, historyBySymbol } = await buildMarketData(
    [...positions.map((p) => p.symbol), upper],
  );

  const before = computeMetrics(positions, metaBySymbol, historyBySymbol);

  const candidateStock = await prisma.stocks.findFirst({ where: { symbol: upper } });
  if (!candidateStock) throw notFound("We couldn't find that stock.");
  const candidateSeries = historyBySymbol.get(upper) ?? [];
  const lastPrice = candidateSeries[candidateSeries.length - 1]?.close ?? 0;
  if (lastPrice <= 0) throw notFound("No price history is available for that stock yet.");

  const qty = amount / lastPrice;
  const simulated: PositionInput[] = positions.map((p) => ({ ...p }));
  const existing = simulated.find((p) => p.symbol === upper);
  if (existing) {
    const totalQty = existing.quantity + qty;
    existing.avgBuyPrice = (existing.quantity * existing.avgBuyPrice + amount) / totalQty;
    existing.quantity = totalQty;
  } else {
    simulated.push({ symbol: upper, quantity: qty, avgBuyPrice: lastPrice });
  }

  const after = computeMetrics(simulated, metaBySymbol, historyBySymbol);

  const divDelta = after.diversificationScore - before.diversificationScore;
  const riskDelta =
    after.riskScore !== null && before.riskScore !== null ? after.riskScore - before.riskScore : 0;
  const sectorBefore = before.sectorAllocation.find((s) => s.sector === candidateStock.sector)?.pct ?? 0;
  const sectorAfter = after.sectorAllocation.find((s) => s.sector === candidateStock.sector)?.pct ?? 0;
  const corr = portfolioCorrelation(upper, positions, metaBySymbol, historyBySymbol);
  const profile = getStockRiskProfileFromSeries(candidateSeries);

  let score = 5;
  score += clamp(-2, 2, divDelta / 3);
  if (before.riskScore !== null && after.riskScore !== null) {
    score -= clamp(-2, 2, riskDelta / 3);
  }
  score -= clamp(0, 2, (sectorAfter - 30) / 15);
  if (corr !== null) score += clamp(-1.5, 1.5, (0.5 - corr) * 2);
  if (profile.volatilityPct !== null) {
    score -= clamp(0, 1.5, (profile.volatilityPct - 30) / 15);
  }
  const fitScore = Number(clamp(0, 10, score).toFixed(1));

  const classification: BuySimulationResult["classification"] =
    fitScore >= 7.5 ? "Strong Fit" : fitScore >= 6 ? "Reasonable Fit" : fitScore >= 4 ? "Weak Fit" : "Poor Fit";

  const reasons: string[] = [];
  reasons.push(
    divDelta >= 0
      ? `Diversification improves by ${divDelta.toFixed(1)} points after this allocation.`
      : `Diversification falls by ${Math.abs(divDelta).toFixed(1)} points after this allocation.`,
  );
  reasons.push(
    riskDelta > 0
      ? `Portfolio risk score rises by ${riskDelta.toFixed(1)} points, largely from ${upper}'s ${profile.volatilityPct !== null ? `${profile.volatilityPct.toFixed(1)}% historical volatility` : "profile"}.`
      : riskDelta < 0
        ? `Portfolio risk score eases by ${Math.abs(riskDelta).toFixed(1)} points.`
        : "Risk-score impact could not be measured: overlapping price history is still insufficient.",
  );
  reasons.push(
    `${candidateStock.sector} exposure moves from ${sectorBefore.toFixed(1)}% to ${sectorAfter.toFixed(1)}% of portfolio value.`,
  );
  if (corr !== null) {
    reasons.push(
      `Historical weekly-return correlation with your current portfolio is ${corr.toFixed(2)} — ${corr < 0.4 ? "relatively independent" : corr < 0.7 ? "moderately linked" : "closely linked"}.`,
    );
  } else {
    reasons.push("Correlation is not shown: insufficient overlapping price history in the dataset.");
  }

  return {
    before,
    after,
    deltas: buildDeltas(before, after),
    fitScore,
    classification,
    reasons,
    insight: explainBuySimulation(upper, amount, {
      classification,
      fitScore,
      after,
      before,
      reasons,
    }),
  };
}

/**
 * POST /api/analysis/sell-simulation
 * Pure computation over a hypothetical trim — no database writes anywhere.
 */
export async function simulateSell(userId: number, holdingId: number, pct: number): Promise<SellSimulationResult> {
  const holding = await prisma.holdings.findUnique({
    where: { holding_id: holdingId },
    include: { stocks: true, portfolios: { select: { user_id: true } } },
  });
  if (!holding || holding.portfolios.user_id !== userId) {
    throw notFound("We couldn't find that holding.");
  }

  const siblings = await prisma.holdings.findMany({
    where: { portfolio_id: holding.portfolio_id },
    include: { stocks: true },
    orderBy: { holding_id: "asc" },
  });

  const positions = toPositions(siblings);
  const { metaBySymbol, historyBySymbol } = await buildMarketData(positions.map((p) => p.symbol));
  const symbol = holding.stocks.symbol;

  const before = computeMetrics(positions, metaBySymbol, historyBySymbol);

  const soldQty = (Number(holding.quantity) * pct) / 100;
  const remaining = positions
    .map((p) => (p.symbol === symbol ? { ...p, quantity: p.quantity - soldQty } : p))
    .filter((p) => p.quantity > 0.0001);
  const after = computeMetrics(remaining, metaBySymbol, historyBySymbol);

  const lastPrice = metaBySymbol.get(symbol)?.lastPrice ?? 0;
  const proceeds = soldQty * lastPrice;
  const realisedPnl = soldQty * (lastPrice - Number(holding.average_buy_price));

  const profile = getStockRiskProfileFromSeries(historyBySymbol.get(symbol) ?? []);
  const totalValue = before.totalValue;
  const weight = totalValue > 0 ? ((Number(holding.quantity) * lastPrice) / totalValue) * 100 : 0;
  const sectorBefore = before.sectorAllocation.find((s) => s.sector === holding.stocks.sector)?.pct ?? 0;

  const reasons: string[] = [];
  let flags = 0;
  if (weight > 25) {
    flags += 2;
    reasons.push(
      `This position is ${weight.toFixed(1)}% of portfolio value — concentration is high relative to a balanced 8-10 stock portfolio.`,
    );
  } else if (weight > 15) {
    flags += 1;
    reasons.push(`This position is ${weight.toFixed(1)}% of portfolio value — above average weight, worth monitoring.`);
  } else {
    reasons.push(`This position is ${weight.toFixed(1)}% of portfolio value, within a typical single-name weight.`);
  }
  if (profile.volatilityPct !== null && profile.volatilityPct > 32) {
    flags += 1;
    reasons.push(
      `Historical volatility of ${profile.volatilityPct.toFixed(1)}% is in the high band; current indicators suggest elevated risk.`,
    );
  } else if (profile.volatilityPct === null) {
    reasons.push("Volatility could not be estimated for this stock: its stored price history is still too short.");
  }
  if (sectorBefore > 35) {
    flags += 1;
    reasons.push(`${holding.stocks.sector} already accounts for ${sectorBefore.toFixed(1)}% of the portfolio.`);
  }
  reasons.push(
    before.riskScore !== null && after.riskScore !== null
      ? `Selling ${pct}% moves the risk score from ${before.riskScore.toFixed(1)} to ${after.riskScore.toFixed(1)} and diversification from ${before.diversificationScore.toFixed(1)} to ${after.diversificationScore.toFixed(1)}.`
      : `Selling ${pct}% moves diversification from ${before.diversificationScore.toFixed(1)} to ${after.diversificationScore.toFixed(1)}; risk-score impact is not yet measurable from the stored history.`,
  );

  const recommendation: SellSimulationResult["recommendation"] =
    flags >= 3 ? "CONSIDER REDUCING" : flags >= 1 ? "REVIEW" : "HOLD";

  return {
    before,
    after,
    deltas: buildDeltas(before, after),
    proceeds,
    realisedPnl,
    recommendation,
    reasons,
    insight: explainSellSimulation(symbol, pct, { recommendation, proceeds, reasons }),
  };
}

export async function correlationWithPortfolio(userId: number, symbol: string): Promise<number | null> {
  const holdings = await prisma.holdings.findMany({
    where: { portfolios: { user_id: userId } },
    include: { stocks: true },
  });
  const positions = toPositions(holdings);
  if (positions.length === 0) return null;

  const { metaBySymbol, historyBySymbol } = await buildMarketData(
    [...positions.map((p) => p.symbol), symbol.toUpperCase()],
  );
  return portfolioCorrelation(symbol.toUpperCase(), positions, metaBySymbol, historyBySymbol);
}

function buildDeltas(before: PortfolioMetrics, after: PortfolioMetrics): BuySimulationResult["deltas"] {
  return [
    { label: "Portfolio value", before: before.totalValue, after: after.totalValue, unit: "currency" as const },
    { label: "Risk score", before: before.riskScore, after: after.riskScore, unit: "score" as const, betterWhenLower: true },
    {
      label: "Diversification score",
      before: before.diversificationScore,
      after: after.diversificationScore,
      unit: "score" as const,
    },
    {
      label: "Largest position weight",
      before: before.topConcentrationPct,
      after: after.topConcentrationPct,
      unit: "pct" as const,
      betterWhenLower: true,
    },
    {
      label: "Portfolio volatility (annualised)",
      before: before.annualisedVolatilityPct,
      after: after.annualisedVolatilityPct,
      unit: "pct" as const,
      betterWhenLower: true,
    },
  ];
}

function clamp(min: number, max: number, v: number) {
  return Math.min(max, Math.max(min, v));
}

/**
 * POST /api/analysis/:id/refresh — invoke the PostgreSQL stored procedure
 * sp_refresh_portfolio_analysis (see prisma/sql/2026_09_15_sp_refresh_portfolio_analysis.sql).
 *
 * The procedure recomputes a portfolio summary snapshot entirely in-database
 * from stock_prices x holdings and APPENDS one row to portfolio_analysis.
 * It never deletes or overwrites history. Ownership is enforced here: the
 * portfolio must belong to userId (admins may refresh any portfolio).
 */
export async function refreshPortfolioAnalysisViaProcedure(userId: number, portfolioId: number, isAdmin: boolean) {
  const portfolio = await prisma.portfolios.findUnique({ where: { portfolio_id: portfolioId } });
  if (!portfolio) throw notFound("Portfolio not found.");
  if (!isAdmin && portfolio.user_id !== userId) {
    throw forbidden("You don't have access to this portfolio.");
  }

  const before = await prisma.portfolio_analysis.count({ where: { portfolio_id: portfolioId } });

  // Parameters are bound ($1::int, $2::date) — no string interpolation.
  await prisma.$executeRawUnsafe(
    "CALL public.sp_refresh_portfolio_analysis($1::int, $2::date)",
    portfolioId,
    null,
  );

  const row = await prisma.portfolio_analysis.findFirst({
    where: { portfolio_id: portfolioId },
    orderBy: { analyzed_at: "desc" },
  });
  const after = await prisma.portfolio_analysis.count({ where: { portfolio_id: portfolioId } });

  await recordAudit({
    userId,
    action: "ANALYSIS_SNAPSHOT",
    entityType: "portfolio_analysis",
    entityId: portfolioId,
    details: `via=sp_refresh_portfolio_analysis appended=${after - before}`,
  });

  return { portfolioId, appended: after - before, snapshot: row };
}
