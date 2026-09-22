/**
 * Persistent risk snapshots (Intelligence Engine, Phase 7).
 *
 * Daily derived risk metrics per portfolio, stored in portfolio_risk_snapshots
 * (migration 2026_09_16_benchmarks_risk_snapshots.sql). Rules:
 *
 *  - IDEMPOTENT: UNIQUE(portfolio_id, snapshot_date, calculation_version)
 *    with ON CONFLICT DO NOTHING — re-running never duplicates or overwrites.
 *  - NEVER deletes legitimate history. Test rows must be removed explicitly
 *    by whoever planted them, by snapshot_id.
 *  - One portfolio's failure never blocks the others.
 *  - Calculation version travels WITH every row (risk-v1).
 */

import { prisma } from "../utils/prisma.js";
import { recordAudit } from "../utils/audit.js";
import { getRiskOverview, RISK_MODEL_VERSION } from "./news/quantitative-risk.service.js";
import { benchmarkPerformance } from "./benchmark-performance.service.js";

export const SNAPSHOT_JOB_VERSION = "risk-v1";

export interface SnapshotSummary {
  portfoliosProcessed: number;
  snapshotsWritten: number;
  duplicatesSkipped: number;
  failures: number;
  failureReasons: string[];
  calculationVersion: string;
}

/** Write today's snapshot for one portfolio. Returns "written" | "exists" | "failed". */
async function snapshotPortfolio(
  portfolioId: number,
  userId: number,
  snapshotDate: string,
): Promise<"written" | "exists" | "failed"> {
  try {
    const holdings = await prisma.holdings.findMany({
      where: { portfolio_id: portfolioId },
      select: { stock_id: true, quantity: true, stocks: { select: { symbol: true, sector: true } } },
    });
    if (holdings.length === 0) return "failed"; // nothing to snapshot; not an error
    const rows = holdings.map((h) => ({
      stock_id: h.stock_id,
      symbol: h.stocks.symbol,
      sector: h.stocks.sector,
      quantity: Number(h.quantity),
    }));

    const overview = await getRiskOverview(portfolioId, rows);
    const bench = await benchmarkPerformance(portfolioId, rows);

    const num = (v: { value: number | null } | null | undefined): number | null =>
      v && v.value !== null && Number.isFinite(v.value) ? v.value : null;

    // ON CONFLICT DO NOTHING keeps the FIRST snapshot for a day — snapshots
    // are historical records, never overwritten.
    const result = await prisma.$executeRaw`
      INSERT INTO portfolio_risk_snapshots
        (portfolio_id, snapshot_date, calculation_version, volatility, downside_deviation,
         sharpe, sortino, calmar, max_drawdown, var_95, var_99, cvar_95,
         beta, alpha, hhi, effective_positions, diversification_ratio,
         benchmark_symbol, observation_count, data_source, priced_as_of)
      VALUES
        (${portfolioId}, ${snapshotDate}::date, ${SNAPSHOT_JOB_VERSION},
         ${num(overview.portfolio.volatilityPctAnn)}, ${num(overview.portfolio.downsideDeviationPctAnn)},
         ${num(overview.portfolio.sharpe)}, ${num(overview.portfolio.sortino)}, ${num(overview.portfolio.calmar)},
         ${num(overview.portfolio.maxDrawdownPct)}, ${num(overview.portfolio.var95Day1Pct)},
         ${num(overview.portfolio.var99Day1Pct)}, ${num(overview.portfolio.cvar95Day1Pct)},
         ${num(bench.metrics.beta)}, ${num(bench.metrics.alphaPctAnn)},
         ${overview.concentration.hhi}, ${overview.concentration.effectiveN},
         ${overview.diversificationRatio.value},
         ${bench.benchmark?.symbol ?? null}, ${bench.provenance.observationCount},
         ${overview.provenance.dataSource}, ${overview.provenance.latestDataDate}::date)
      ON CONFLICT (portfolio_id, snapshot_date, calculation_version) DO NOTHING`;

    if (result > 0) {
      await recordAudit({
        userId,
        action: "RISK_SNAPSHOT_WRITTEN",
        entityType: "PORTFOLIO",
        entityId: portfolioId,
        details: `Daily risk snapshot (${SNAPSHOT_JOB_VERSION}) for ${snapshotDate}.`,
      });
      return "written";
    }
    return "exists";
  } catch (error) {
    console.error(`[risk-snapshots] portfolio ${portfolioId} failed:`, error instanceof Error ? error.message : error);
    return "failed";
  }
}

/**
 * Run snapshots for ALL portfolios for a given date (default today).
 * Idempotent: safe to run repeatedly; failures are isolated and reported.
 */
export async function runDailySnapshots(snapshotDate = new Date().toISOString().slice(0, 10)): Promise<SnapshotSummary> {
  const portfolios = await prisma.portfolios.findMany({
    select: { portfolio_id: true, user_id: true },
    orderBy: { portfolio_id: "asc" },
  });
  const summary: SnapshotSummary = {
    portfoliosProcessed: 0,
    snapshotsWritten: 0,
    duplicatesSkipped: 0,
    failures: 0,
    failureReasons: [],
    calculationVersion: SNAPSHOT_JOB_VERSION,
  };
  for (const p of portfolios) {
    summary.portfoliosProcessed += 1;
    const outcome = await snapshotPortfolio(p.portfolio_id, p.user_id, snapshotDate);
    if (outcome === "written") summary.snapshotsWritten += 1;
    else if (outcome === "exists") summary.duplicatesSkipped += 1;
    else summary.failures += 1;
  }
  return summary;
}

/** Read-side: full snapshot history for one portfolio (ascending). */
export async function snapshotHistory(portfolioId: number, limit = 180) {
  const rows = await prisma.portfolio_risk_snapshots.findMany({
    where: { portfolio_id: portfolioId, calculation_version: SNAPSHOT_JOB_VERSION },
    orderBy: { snapshot_date: "asc" },
    take: limit,
  });
  return rows.map((r) => ({
    snapshotDate: r.snapshot_date.toISOString().slice(0, 10),
    calculationVersion: r.calculation_version,
    volatilityPctAnn: r.volatility === null ? null : Number(r.volatility),
    sharpe: r.sharpe === null ? null : Number(r.sharpe),
    maxDrawdownPct: r.max_drawdown === null ? null : Number(r.max_drawdown),
    var95Day1Pct: r.var_95 === null ? null : Number(r.var_95),
    beta: r.beta === null ? null : Number(r.beta),
    alphaPctAnn: r.alpha === null ? null : Number(r.alpha),
    hhi: r.hhi === null ? null : Number(r.hhi),
    effectivePositions: r.effective_positions === null ? null : Number(r.effective_positions),
    diversificationRatio: r.diversification_ratio === null ? null : Number(r.diversification_ratio),
    benchmarkSymbol: r.benchmark_symbol,
    observationCount: r.observation_count,
    dataSource: r.data_source,
    pricedAsOf: r.priced_as_of ? r.priced_as_of.toISOString().slice(0, 10) : null,
  }));
}

/** Admin diagnostics. */
export async function snapshotStatus() {
  const [count, distinctPortfolios, latest] = await Promise.all([
    prisma.portfolio_risk_snapshots.count(),
    prisma.portfolio_risk_snapshots.groupBy({ by: ["portfolio_id"], _count: { snapshot_id: true } }),
    prisma.portfolio_risk_snapshots.findFirst({ orderBy: { snapshot_date: "desc" }, select: { snapshot_date: true, calculation_version: true } }),
  ]);
  return {
    totalSnapshots: count,
    portfoliosWithSnapshots: distinctPortfolios.length,
    latestSnapshotDate: latest?.snapshot_date.toISOString().slice(0, 10) ?? null,
    calculationVersion: latest?.calculation_version ?? SNAPSHOT_JOB_VERSION,
  };
}

export { RISK_MODEL_VERSION };
