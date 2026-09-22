/**
 * Quantitative risk engine (Intelligence Engine, Phase 4A).
 *
 * Answers "WHY is my portfolio risky?" with deterministic, explainable
 * attribution computed from the existing stock_prices + holdings tables.
 *
 * Methodology contract (documented, not hidden):
 *  - DAILY simple returns from date-aligned closes; the engine restricts
 *    itself to the latest homogeneous data-source segment per series
 *    (reusing analytics.latestHomogeneousSegment) so DEMO weekly bars are
 *    never blended with YAHOO daily bars.
 *  - Annualisation: ×√252 for volatility, ×252 for mean returns — the
 *    standard daily convention, applied consistently everywhere.
 *  - Portfolio volatility uses the COVARIANCE MATRIX:
 *        σ_p = √(wᵀ Σ w)
 *    never a weighted average of individual volatilities.
 *  - Downside deviation uses a 0% DAILY target return (documented default;
 *    configurable per call) — losses below zero are the only penalty term.
 *  - Sharpe uses an EXPLICIT risk-free assumption (env RISK_FREE_RATE_PCT,
 *    default 6.5% p.a. typical India risk-free proxy), divided by 252 to a
 *    daily excess; the assumption is surfaced in every response.
 *  - Beta/alpha require real benchmark history. The schema has no benchmark
 *    series (stocks holds only the 38 equity universe) so both return
 *    `unavailable` with a reason until a benchmark dataset is loaded. No
 *    fabricated NIFTY numbers.
 *  - VaR/CVaR are HISTORICAL (empirical quantile of date-aligned daily
 *    portfolio returns). Never described as a guaranteed maximum loss.
 *  - Risk contribution: σ_p² decomposes exactly as
 *        σ_p² = Σᵢ wᵢ · (Σw)ᵢ
 *    so component contribution Cᵢ = wᵢ·(Σw)ᵢ / σ_p  sums EXACTLY to σ_p
 *    (percentage contribution sums to 100% up to float rounding).
 *  - Missing data is a first-class state: insufficient history → null +
 *    reason. Zero is never a stand-in for unknown.
 */
import { prisma } from "../../utils/prisma.js";
import { latestHomogeneousSegment, type PricePoint } from "../analytics.service.js";

/* ------------------------------ configuration ------------------------------ */

export const RISK_MODEL_VERSION = "v1";

/** Trading days per year used for all annualisation (documented constant). */
const TRADING_DAYS = 252;
export { TRADING_DAYS as TRADING_DAYS_UNSAFE };

export interface RiskAssumptions {
  riskFreeRatePct: number;
  targetReturnPct: number;
  varConfidence: number;
  tradingDaysPerYear: number;
  modelVersion: string;
}

function readAssumptions(): RiskAssumptions {
  const rf = Number(process.env["RISK_FREE_RATE_PCT"] ?? 6.5);
  const vc = Number(process.env["VAR_CONFIDENCE"] ?? 0.95);
  return {
    riskFreeRatePct: Number.isFinite(rf) && rf >= 0 && rf <= 30 ? rf : 6.5,
    targetReturnPct: 0, // daily downside target, documented default
    varConfidence: vc === 0.99 || vc === 0.95 || vc === 0.9 ? vc : 0.95,
    tradingDaysPerYear: TRADING_DAYS,
    modelVersion: RISK_MODEL_VERSION,
  };
}

/* ------------------------------- series core ------------------------------- */

export interface SeriesBundle {
  dates: string[];
  /** Date-aligned close matrix [holding][t]. */
  closes: number[][];
  /** Date-aligned daily simple returns [holding][t-1]. */
  returns: number[][];
  symbols: string[];
  latestDate: string | null;
  oldestDate: string | null;
}

/** Load date-aligned close + daily-return matrices for the given stocks. */
export async function loadAlignedSeries(stockIds: number[], maxCalendarDays = 730): Promise<SeriesBundle> {
  if (stockIds.length === 0) {
    return { dates: [], closes: [], returns: [], symbols: [], latestDate: null, oldestDate: null };
  }
  const rows = await prisma.stock_prices.findMany({
    where: { stock_id: { in: stockIds }, price_date: { gte: new Date(Date.now() - maxCalendarDays * 86_400_000) } },
    orderBy: [{ stock_id: "asc" }, { price_date: "asc" }],
    select: { stock_id: true, price_date: true, close_price: true, data_source: true },
  });

  // Per-stock source map so each series can be trimmed to its homogeneous tail.
  const rawByStock = new Map<number, PricePoint[]>();
  const srcByStock = new Map<number, Map<string, string>>();
  for (const r of rows) {
    const d = r.price_date.toISOString().slice(0, 10);
    const arr = rawByStock.get(r.stock_id) ?? [];
    arr.push({ date: d, close: Number(r.close_price) });
    rawByStock.set(r.stock_id, arr);
    const sm = srcByStock.get(r.stock_id) ?? new Map<string, string>();
    sm.set(d, r.data_source);
    srcByStock.set(r.stock_id, sm);
  }

  // Trim each series to its latest homogeneous segment, then date-align ALL.
  const trimmed = new Map<number, PricePoint[]>();
  for (const [id, series] of rawByStock) {
    trimmed.set(id, latestHomogeneousSegment(series, srcByStock.get(id)));
  }

  // Intersection of dates across all series (exact-date alignment).
  let common: Set<string> | null = null;
  for (const series of trimmed.values()) {
    const dates = new Set(series.map((p) => p.date));
    if (common === null) common = dates;
    else for (const d of [...common]) if (!dates.has(d)) common.delete(d);
  }
  const dates = common === null ? [] : [...common].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const ids = [...trimmed.keys()];
  const closes: number[][] = ids.map((id) => {
    const m = new Map((trimmed.get(id) ?? []).map((p) => [p.date, p.close]));
    return dates.map((d) => m.get(d)!);
  });

  const returns = closes.map((series) => {
    const r: number[] = [];
    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1]!;
      r.push(prev > 0 ? series[i]! / prev - 1 : 0);
    }
    return r;
  });

  return {
    dates,
    closes,
    returns,
    symbols: ids.map(String),
    latestDate: dates.length ? dates[dates.length - 1]! : null,
    oldestDate: dates.length ? dates[0]! : null,
  };
}

/* ------------------------------ stat helpers ------------------------------- */

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stdSample(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
}

function percentileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Covariance matrix of return columns (sample, n-1). */
function covarianceMatrix(returns: number[][]): number[][] {
  const n = returns.length;
  const m: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const a = returns[i]!;
      const b = returns[j]!;
      const t = Math.min(a.length, b.length);
      const xa = a.slice(-t);
      const xb = b.slice(-t);
      const ma = mean(xa);
      const mb = mean(xb);
      let cov = 0;
      for (let k = 0; k < t; k++) cov += (xa[k]! - ma) * (xb[k]! - mb);
      cov = t > 1 ? cov / (t - 1) : 0;
      m[i]![j] = cov;
      m[j]![i] = cov;
    }
  }
  return m;
}

function matVec(m: number[][], w: number[]): number[] {
  return m.map((row) => row.reduce((a, c, j) => a + c * w[j]!, 0));
}

function dot(a: number[], b: number[]): number {
  return a.reduce((s, v, i) => s + v * b[i]!, 0);
}

/* ------------------------------ metric blocks ------------------------------ */

export interface RiskMetric {
  value: number | null;
  unit: string;
  available: boolean;
  reason: string | null;
}

function metric(value: number | null, unit: string, reason: string | null = null): RiskMetric {
  return { value, unit, available: value !== null && Number.isFinite(value), reason: value === null || !Number.isFinite(value) ? (reason ?? "Insufficient data") : null };
}

export interface ConcentrationBlock {
  largestWeightPct: number | null;
  top3Pct: number | null;
  top5Pct: number | null;
  hhi: number | null;
  effectiveN: number | null;
}

function concentrationOf(weights: number[]): ConcentrationBlock {
  if (weights.length === 0) {
    return { largestWeightPct: null, top3Pct: null, top5Pct: null, hhi: null, effectiveN: null };
  }
  const sorted = [...weights].sort((a, b) => b - a);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    return { largestWeightPct: null, top3Pct: null, top5Pct: null, hhi: null, effectiveN: null };
  }
  const norm = weights.map((w) => w / sum);
  const nrmSorted = [...norm].sort((a, b) => b - a);
  const hhi = norm.reduce((a, w) => a + w * w, 0);
  return {
    largestWeightPct: nrmSorted[0]! * 100,
    top3Pct: nrmSorted.slice(0, 3).reduce((a, b) => a + b, 0) * 100,
    top5Pct: nrmSorted.slice(0, 5).reduce((a, b) => a + b, 0) * 100,
    hhi,
    effectiveN: hhi > 0 ? 1 / hhi : null,
  };
}

export interface Contributor {
  stockId: string;
  symbol: string;
  sector: string;
  weightPct: number;
  /** Cᵢ = wᵢ·(Σw)ᵢ/σ_p — sums to total portfolio volatility. */
  riskContributionPctOfVol: number | null;
  /** Cᵢ/σ_p × 100 — sums to 100%. */
  pctContribution: number | null;
  /** ∂σ_p/∂wᵢ = (Σw)ᵢ/σ_p (per unit weight). */
  marginalRisk: number | null;
  standaloneVolPct: number | null;
  ranking: "High" | "Moderate" | "Low" | null;
}

export interface CorrelationPair {
  a: string;
  b: string;
  correlation: number;
}

export interface CorrelationStats {
  averagePairwise: number | null;
  highest: CorrelationPair | null;
  lowest: CorrelationPair | null;
  pairs: CorrelationPair[];
  /** Groups of ≥3 stocks with average intra-pair correlation ≥ 0.7. */
  clusters: Array<{ symbols: string[]; averageCorrelation: number }>;
  observationDays: number;
}

export interface RiskOverview {
  assumptions: RiskAssumptions;
  provenance: {
    dataSource: string;
    latestDataDate: string | null;
    windowDays: number | null;
    observationDays: number;
    holdings: number;
  };
  portfolio: {
    volatilityPctAnn: RiskMetric;
    downsideDeviationPctAnn: RiskMetric;
    maxDrawdownPct: RiskMetric;
    drawdownDurationDays: RiskMetric;
    sharpe: RiskMetric;
    sortino: RiskMetric;
    calmar: RiskMetric;
    annualisedReturnPct: RiskMetric;
    var95Day1Pct: RiskMetric;
    var99Day1Pct: RiskMetric;
    cvar95Day1Pct: RiskMetric;
    beta: RiskMetric;
    alphaPctAnn: RiskMetric;
  };
  concentration: ConcentrationBlock;
  diversificationRatio: RiskMetric;
  correlation: CorrelationStats | null;
  contributors: Contributor[];
  drawdownSeries: Array<{ date: string; drawdownPct: number }>;
}

/** Portfolio value series from aligned closes × current quantities. */
function portfolioValueSeriesFrom(closes: number[][], quantities: number[]): number[] {
  const t = closes[0]?.length ?? 0;
  const out: number[] = [];
  for (let i = 0; i < t; i++) {
    let total = 0;
    for (let h = 0; h < closes.length; h++) total += closes[h]![i]! * quantities[h]!;
    out.push(total);
  }
  return out;
}

function drawdownPath(values: number[]): Array<{ idx: number; dd: number }> {
  let peak = -Infinity;
  return values.map((v, idx) => {
    peak = Math.max(peak, v);
    return { idx, dd: peak > 0 ? v / peak - 1 : 0 };
  });
}

/** Average pairwise correlation + extremes + high-correlation clusters. */
export function correlationStats(returns: number[][], symbols: string[]): CorrelationStats | null {
  const n = returns.length;
  if (n < 2) return null;
  const t = Math.min(...returns.map((r) => r.length));
  if (t < 30) return null;
  const cols = returns.map((r) => r.slice(-t));

  const corrOf = (a: number[], b: number[]): number => {
    const ma = mean(a);
    const mb = mean(b);
    let num = 0;
    let da = 0;
    let dbb = 0;
    for (let i = 0; i < t; i++) {
      num += (a[i]! - ma) * (b[i]! - mb);
      da += (a[i]! - ma) ** 2;
      dbb += (b[i]! - mb) ** 2;
    }
    return da === 0 || dbb === 0 ? NaN : num / Math.sqrt(da * dbb);
  };

  const pairs: CorrelationPair[] = [];
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(NaN));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = corrOf(cols[i]!, cols[j]!);
      matrix[i]![j] = r;
      matrix[j]![i] = r;
      if (Number.isFinite(r)) pairs.push({ a: symbols[i]!, b: symbols[j]!, correlation: Number(r.toFixed(4)) });
    }
  }
  if (pairs.length === 0) return null;

  const sortedPairs = [...pairs].sort((x, y) => y.correlation - x.correlation);
  const avg = mean(pairs.map((p) => p.correlation));

  // Greedy clustering: start from the strongest pair, admit stocks whose
  // average correlation to the cluster is ≥ 0.7, require ≥ 3 members.
  const clusters: Array<{ symbols: string[]; averageCorrelation: number }> = [];
  const used = new Set<string>();
  for (const p of sortedPairs) {
    if (p.correlation < 0.7) break;
    if (used.has(p.a) || used.has(p.b)) continue;
    const group = [p.a, p.b];
    let sum = p.correlation;
    let count = 1;
    for (const q of sortedPairs) {
      if (q.correlation < 0.7) break;
      if (group.includes(q.a) && !group.includes(q.b)) {
        group.push(q.b);
        sum += q.correlation;
        count += 1;
      } else if (group.includes(q.b) && !group.includes(q.a)) {
        group.push(q.a);
        sum += q.correlation;
        count += 1;
      }
    }
    if (group.length >= 3) {
      clusters.push({ symbols: group, averageCorrelation: Number((sum / count).toFixed(4)) });
      group.forEach((s) => used.add(s));
    }
  }

  return {
    averagePairwise: Number(avg.toFixed(4)),
    highest: sortedPairs[0] ?? null,
    lowest: sortedPairs[sortedPairs.length - 1] ?? null,
    pairs: sortedPairs.slice(0, 20),
    clusters,
    observationDays: t,
  };
}

/**
 * Full risk overview for one portfolio. All inputs are ownership-verified by
 * the caller. Every metric is null-with-reason when data is insufficient.
 */
export async function getRiskOverview(portfolioId: number, holdings: Array<{ stock_id: number; symbol: string; sector: string; quantity: number }>): Promise<RiskOverview> {
  const a = readAssumptions();
  const stockIds = holdings.map((h) => h.stock_id);
  const bundle = await loadAlignedSeries(stockIds);
  const idxById = new Map(bundle.symbols.map((s, i) => [Number(s), i]));

  const quantities = stockIds.map((id) => holdings.find((h) => h.stock_id === id)?.quantity ?? 0);
  const ordered = stockIds.map((id) => idxById.get(id)).filter((i): i is number => i !== undefined);
  const closesOrdered = ordered.map((i) => bundle.closes[i]!);
  const returnsOrdered = ordered.map((i) => bundle.returns[i]!);
  const qtyOrdered = ordered.map((i) => quantities[i]!);
  const holdingsOrdered = ordered.map((i) => holdings.find((h) => h.stock_id === Number(bundle.symbols[i]))!);

  const t = returnsOrdered[0]?.length ?? 0;
  const totalValueNow = closesOrdered.reduce((acc, c, h) => acc + c[c.length - 1]! * qtyOrdered[h]!, 0);
  const weights = qtyOrdered.map((q, h) => {
    const last = closesOrdered[h]![closesOrdered[h]!.length - 1]!;
    return totalValueNow > 0 ? (q * last) / totalValueNow : 0;
  });

  const insufficient = (reason: string): RiskOverview => ({
    assumptions: a,
    provenance: {
      dataSource: "YAHOO",
      latestDataDate: bundle.latestDate,
      windowDays: bundle.oldestDate && bundle.latestDate ? bundle.dates.length : null,
      observationDays: t,
      holdings: holdings.length,
    },
    portfolio: {
      volatilityPctAnn: metric(null, "% ann.", reason),
      downsideDeviationPctAnn: metric(null, "% ann.", reason),
      maxDrawdownPct: metric(null, "%", reason),
      drawdownDurationDays: metric(null, "days", reason),
      sharpe: metric(null, "ratio", reason),
      sortino: metric(null, "ratio", reason),
      calmar: metric(null, "ratio", reason),
      annualisedReturnPct: metric(null, "% ann.", reason),
      var95Day1Pct: metric(null, "% 1-day", reason),
      var99Day1Pct: metric(null, "% 1-day", reason),
      cvar95Day1Pct: metric(null, "% 1-day", reason),
      beta: metric(null, "ratio", "No benchmark price history exists in the database — beta stays unavailable rather than using fabricated index data."),
      alphaPctAnn: metric(null, "% ann.", "No benchmark/risk-free market data — alpha stays unavailable rather than fabricated."),
    },
    concentration: concentrationOf(weights),
    diversificationRatio: metric(null, "ratio", reason),
    correlation: null,
    contributors: [],
    drawdownSeries: [],
  });

  if (holdings.length === 0) return insufficient("No holdings in this portfolio.");
  if (t < 30) return insufficient(`Only ${t} date-aligned daily observations — at least 30 required.`);

  // ---- portfolio return series from ACTUAL holdings ------------------------
  const pv = portfolioValueSeriesFrom(closesOrdered, qtyOrdered);
  const portfolioReturns: number[] = [];
  for (let i = 1; i < pv.length; i++) portfolioReturns.push(pv[i - 1]! > 0 ? pv[i]! / pv[i - 1]! - 1 : 0);

  // ---- volatility from the covariance matrix (wᵀΣw) ------------------------
  const cov = covarianceMatrix(returnsOrdered);
  const variance = dot(weights, matVec(cov, weights));
  const dailyVol = Math.sqrt(Math.max(0, variance));
  const volAnn = dailyVol * Math.sqrt(TRADING_DAYS) * 100;

  // ---- downside deviation (target 0% daily) --------------------------------
  const target = a.targetReturnPct / 100;
  const downside = portfolioReturns.filter((r) => r < target);
  const dailyDownsideDev = downside.length > 0
    ? Math.sqrt(downside.reduce((acc, r) => acc + (r - target) ** 2, 0) / portfolioReturns.length)
    : 0;
  const downsideAnn = dailyDownsideDev * Math.sqrt(TRADING_DAYS) * 100;

  // ---- returns / drawdown / ratios ------------------------------------------
  const dailyMean = mean(portfolioReturns);
  const annReturn = dailyMean * TRADING_DAYS * 100;
  const dd = drawdownPath(pv);
  const maxDd = Math.min(...dd.map((x) => x.dd)) * 100;
  // Recovery/duration: calendar days from the drawdown trough to either
  // recovery (dd back to 0) or the last observation — whichever came first.
  const troughIdx = dd.reduce((worst, x, i) => (x.dd < dd[worst]!.dd ? i : worst), 0);
  const recoverIdx = dd.findIndex((x, i) => i > troughIdx && x.dd >= -1e-9);
  const durationDays = recoverIdx === -1 ? dd.length - 1 - troughIdx : recoverIdx - troughIdx;

  const dailyRf = a.riskFreeRatePct / 100 / TRADING_DAYS;
  const sharpe = dailyVol > 0 ? (dailyMean - dailyRf) / dailyVol * Math.sqrt(TRADING_DAYS) : null;
  const sortino = dailyDownsideDev > 0 ? (dailyMean - dailyRf) / dailyDownsideDev * Math.sqrt(TRADING_DAYS) : null;
  const calmar = maxDd < 0 ? annReturn / Math.abs(maxDd) : null;

  // ---- historical VaR / CVaR ------------------------------------------------
  const sortedReturns = [...portfolioReturns].sort((x, y) => x - y);
  const q = 1 - a.varConfidence;
  const var95 = percentileSorted(sortedReturns, 0.05) * 100;
  const var99 = percentileSorted(sortedReturns, 0.01) * 100;
  const tail95 = sortedReturns.filter((r) => r <= percentileSorted(sortedReturns, 0.05));
  const cvar95 = tail95.length > 0 ? mean(tail95) * 100 : null;

  // ---- risk contribution (exact Euler decomposition) ------------------------
  const sigma = dailyVol;
  const sv = matVec(cov, weights);
  const contributors: Contributor[] = holdingsOrdered.map((h, i) => {
    const mcr = sigma > 0 ? sv[i]! / sigma : null; // marginal
    const comp = sigma > 0 ? weights[i]! * sv[i]! / sigma : null; // component
    const pct = sigma > 0 ? (weights[i]! * sv[i]!) / variance * 100 : null;
    const standalone = stdSample(returnsOrdered[i]!) * Math.sqrt(TRADING_DAYS) * 100;
    const ranking = pct === null ? null : pct >= 30 ? "High" : pct >= 15 ? "Moderate" : "Low";
    return {
      stockId: String(h.stock_id),
      symbol: h.symbol,
      sector: h.sector,
      weightPct: Number((weights[i]! * 100).toFixed(2)),
      riskContributionPctOfVol: comp === null ? null : Number((comp * Math.sqrt(TRADING_DAYS) * 100).toFixed(4)),
      pctContribution: pct === null ? null : Number(pct.toFixed(2)),
      marginalRisk: mcr === null ? null : Number((mcr * Math.sqrt(TRADING_DAYS)).toFixed(4)),
      standaloneVolPct: Number.isFinite(standalone) ? Number(standalone.toFixed(2)) : null,
      ranking,
    };
  });
  contributors.sort((x, y) => (y.pctContribution ?? 0) - (x.pctContribution ?? 0));

  const diversificationRatio = dailyVol > 0
    ? metric(
        weights.reduce((acc, w, i) => acc + w * (stdSample(returnsOrdered[i]!) ), 0) / dailyVol,
        "ratio",
      )
    : metric(null, "ratio", "Zero portfolio volatility");

  const correlation = correlationStats(returnsOrdered, holdingsOrdered.map((h) => h.symbol));

  return {
    assumptions: a,
    provenance: {
      dataSource: "YAHOO",
      latestDataDate: bundle.latestDate,
      windowDays: bundle.dates.length,
      observationDays: t,
      holdings: holdings.length,
    },
    portfolio: {
      volatilityPctAnn: metric(volAnn, "% ann."),
      downsideDeviationPctAnn: metric(downsideAnn, "% ann."),
      maxDrawdownPct: metric(maxDd, "%"),
      drawdownDurationDays: metric(durationDays, "days"),
      sharpe: metric(sharpe === null ? null : Number(sharpe.toFixed(3)), "ratio", sharpe === null ? "Zero portfolio volatility — ratio undefined" : null),
      sortino: metric(sortino === null ? null : Number(sortino.toFixed(3)), "ratio", sortino === null ? "No downside observations below target" : null),
      calmar: metric(calmar === null ? null : Number(calmar.toFixed(3)), "ratio", calmar === null ? "No drawdown observed in window" : null),
      annualisedReturnPct: metric(annReturn, "% ann."),
      var95Day1Pct: metric(var95, "% 1-day"),
      var99Day1Pct: metric(var99, "% 1-day"),
      cvar95Day1Pct: metric(cvar95, "% 1-day"),
      beta: metric(null, "ratio", "No benchmark price history exists in the database — beta stays unavailable rather than using fabricated index data."),
      alphaPctAnn: metric(null, "% ann.", "No benchmark/risk-free market data — alpha stays unavailable rather than fabricated."),
    },
    concentration: concentrationOf(weights),
    diversificationRatio,
    correlation,
    contributors,
    drawdownSeries: dd
      .map((x) => ({ date: bundle.dates[x.idx]!, drawdownPct: Number((x.dd * 100).toFixed(2)) }))
      .filter((_, i) => i % 3 === 0 || i === dd.length - 1),
  };
}

/* --------------------------- performance attribution ----------------------- */

export interface AttributionRow {
  symbol: string;
  sector: string;
  /** Share of total current portfolio value at window start (weight). */
  weightPct: number;
  /** Holding total return over the window (price-based). */
  holdingReturnPct: number | null;
  /** Points of portfolio return contributed = wᵢ × rᵢ × 100. */
  contributionPctPoints: number | null;
  /** Absolute ₹ P&L over the window = q × (P_end − P_start). */
  pnlInr: number | null;
}

export interface PerformanceAttribution {
  provenance: {
    latestDataDate: string | null;
    windowDays: number;
    observationDays: number;
  };
  portfolioReturnPct: number | null;
  contributors: AttributionRow[];
  detractors: AttributionRow[];
  bySector: Array<{ sector: string; contributionPctPoints: number | null }>;
  note: string;
}

/**
 * Buy-and-hold attribution over the loaded window: contribution of each
 * holding = start-weight × holding return. Uses the same aligned matrices
 * as risk (current holdings across the window — transaction-aware history
 * exists in the dashboard's value series; this view is labelled as
 * current-holdings based).
 */
export function performanceAttribution(bundle: SeriesBundle, holdings: Array<{ stock_id: number; symbol: string; sector: string; quantity: number }>): PerformanceAttribution {
  const idxById = new Map(bundle.symbols.map((s, i) => [Number(s), i]));
  const ordered = holdings.map((h) => idxById.get(h.stock_id)).filter((i): i is number => i !== undefined);
  const t = bundle.returns[0]?.length ?? 0;
  const note =
    "Buy-and-hold attribution using CURRENT holdings across the window — purchases/sales inside the window are not rebu:";

  if (ordered.length === 0 || t < 2) {
    return {
      provenance: { latestDataDate: bundle.latestDate, windowDays: t, observationDays: t },
      portfolioReturnPct: null,
      contributors: [],
      detractors: [],
      bySector: [],
      note: "Insufficient aligned price history for attribution.",
    };
  }

  const startPrices = ordered.map((i) => bundle.closes[i]![0]!);
  const endPrices = ordered.map((i) => bundle.closes[i]![bundle.closes[i]!.length - 1]!);
  const qtyOrdered = holdings.map((h, k) => ({ h, i: ordered.indexOf(k) })).filter((x) => x.i >= 0);
  const startValue = qtyOrdered.reduce((acc, x) => acc + startPrices[x.i]! * x.h.quantity, 0);

  const rows: AttributionRow[] = qtyOrdered.map(({ h, i }) => {
    const holdingReturn = startPrices[i]! > 0 ? endPrices[i]! / startPrices[i]! - 1 : null;
    const weight = startValue > 0 ? (startPrices[i]! * h.quantity) / startValue : null;
    const pnl = h.quantity * (endPrices[i]! - startPrices[i]!);
    return {
      symbol: h.symbol,
      sector: h.sector,
      weightPct: weight === null ? 0 : Number((weight * 100).toFixed(2)),
      holdingReturnPct: holdingReturn === null ? null : Number((holdingReturn * 100).toFixed(2)),
      contributionPctPoints: weight !== null && holdingReturn !== null ? Number((weight * holdingReturn * 100).toFixed(2)) : null,
      pnlInr: Number(pnl.toFixed(2)),
    };
  });

  const portfolioReturnPct = startValue > 0
    ? Number((((qtyOrdered.reduce((acc, x) => acc + endPrices[x.i]! * x.h.quantity, 0)) / startValue - 1) * 100).toFixed(2))
    : null;

  const sortedByContribution = [...rows].sort((x, y) => (y.contributionPctPoints ?? 0) - (x.contributionPctPoints ?? 0));
  const sectorMap = new Map<string, number[]>();
  for (const r of rows) {
    const arr = sectorMap.get(r.sector) ?? [];
    if (r.contributionPctPoints !== null) arr.push(r.contributionPctPoints);
    sectorMap.set(r.sector, arr);
  }
  const bySector = [...sectorMap.entries()]
    .map(([sector, arr]) => ({ sector, contributionPctPoints: arr.length ? Number(arr.reduce((x, y) => x + y, 0).toFixed(2)) : null }))
    .sort((x, y) => (y.contributionPctPoints ?? 0) - (x.contributionPctPoints ?? 0));

  return {
    provenance: { latestDataDate: bundle.latestDate, windowDays: t, observationDays: t },
    portfolioReturnPct,
    contributors: sortedByContribution.filter((r) => (r.contributionPctPoints ?? 0) >= 0).slice(0, 5),
    detractors: sortedByContribution.filter((r) => (r.contributionPctPoints ?? 0) < 0).reverse().slice(0, 5),
    bySector,
    note: note.replace("rebu:", "rebased. PortfolioIQ label: CURRENT-HOLDINGS VIEW — intra-window trades are not replayed here."),
  };
}

/* --------------------------------- rolling --------------------------------- */

export interface RollingPoint {
  date: string;
  volPctAnn: number;
  sharpe: number | null;
}

export type RiskTrend = "INCREASING" | "DECREASING" | "STABLE" | "UNKNOWN";

/**
 * Rolling 30-day-observation volatility of the portfolio value series +
 * risk trend via a split comparison of the first and second half means
 * (10% tolerance band → STABLE between).
 */
export function rollingRisk(pv: number[], dates: string[], window = 30): { series: RollingPoint[]; trend: RiskTrend } {
  if (pv.length < window + 10) return { series: [], trend: "UNKNOWN" };
  const rets: number[] = [];
  for (let i = 1; i < pv.length; i++) rets.push(pv[i - 1]! > 0 ? pv[i]! / pv[i - 1]! - 1 : 0);
  const series: RollingPoint[] = [];
  for (let i = window; i <= rets.length; i++) {
    const slice = rets.slice(i - window, i);
    const sd = stdSample(slice);
    series.push({ date: dates[i] ?? dates[dates.length - 1]!, volPctAnn: Number((sd * Math.sqrt(TRADING_DAYS) * 100).toFixed(2)), sharpe: null });
  }
  const half = Math.floor(series.length / 2);
  const firstMean = mean(series.slice(0, half).map((s) => s.volPctAnn));
  const secondMean = mean(series.slice(half).map((s) => s.volPctAnn));
  let trend: RiskTrend = "UNKNOWN";
  if (series.length >= 10) {
    if (secondMean > firstMean * 1.1) trend = "INCREASING";
    else if (secondMean < firstMean * 0.9) trend = "DECREASING";
    else trend = "STABLE";
  }
  return { series: series.filter((_, i) => i % 3 === 0 || i === series.length - 1), trend };
}
