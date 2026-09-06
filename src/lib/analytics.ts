/**
 * PortfolioIQ analytics engine.
 *
 * All numbers shown anywhere in the product are produced here — deterministic,
 * auditable formulas over holdings and price history. The AI layer only
 * *explains* these outputs; it never produces figures.
 *
 * This module is pure and framework-free so it can be moved verbatim into the
 * Express backend (`server/src/services/analytics.service.ts`) once the
 * PostgreSQL schema is finalised.
 */
import { STOCKS, getPriceHistory } from "@/lib/demo-data";
import type {
  BuySimulationResult,
  FitClassification,
  Holding,
  HoldingView,
  PortfolioMetrics,
  PricePoint,
  SectorAllocation,
  SellSimulationResult,
  SimulationDelta,
  Stock,
  StockRiskProfile,
} from "@/types";

const stockBySymbol = new Map(STOCKS.map((s) => [s.symbol, s]));

export function getStock(symbol: string): Stock | undefined {
  return stockBySymbol.get(symbol);
}

/* ------------------------------- price stats ------------------------------ */

export function weeklyReturns(series: PricePoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!.close;
    if (prev > 0) out.push(series[i]!.close / prev - 1);
  }
  return out;
}

export function annualisedVolatility(series: PricePoint[]): number {
  const r = weeklyReturns(series);
  if (r.length < 8) return 0;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance) * Math.sqrt(52) * 100;
}

export function maxDrawdown(series: PricePoint[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const p of series) {
    peak = Math.max(peak, p.close);
    worst = Math.min(worst, p.close / peak - 1);
  }
  return worst * 100;
}

function trailingReturn(series: PricePoint[], years: number): number | null {
  const weeks = Math.round(52 * years);
  if (series.length <= weeks) return null;
  const start = series[series.length - 1 - weeks]!.close;
  const end = series[series.length - 1]!.close;
  if (start <= 0) return null;
  const total = end / start;
  return ((years === 1 ? total : Math.pow(total, 1 / years)) - 1) * 100;
}

export function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 26) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i]! - mx) * (y[i]! - my);
    dx += (x[i]! - mx) ** 2;
    dy += (y[i]! - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export function riskBand(volatilityPct: number): StockRiskProfile["riskBand"] {
  if (volatilityPct < 18) return "Low";
  if (volatilityPct < 26) return "Moderate";
  if (volatilityPct < 38) return "High";
  return "Very High";
}

export function getStockRiskProfile(symbol: string): StockRiskProfile {
  const series = getPriceHistory(symbol);
  const vol = annualisedVolatility(series);
  return {
    volatilityPct: vol,
    maxDrawdownPct: maxDrawdown(series),
    return1yPct: trailingReturn(series, 1),
    return3yPct: trailingReturn(series, 3),
    return5yPct: trailingReturn(series, 5),
    riskBand: riskBand(vol),
  };
}

/* ----------------------------- portfolio maths ---------------------------- */

interface Position {
  symbol: string;
  quantity: number;
  avgBuyPrice: number;
}

export function buildHoldingViews(holdings: Holding[]): HoldingView[] {
  const enriched = holdings
    .map((h) => {
      const stock = stockBySymbol.get(h.symbol);
      if (!stock) return null;
      const invested = h.quantity * h.avgBuyPrice;
      const currentValue = h.quantity * stock.lastPrice;
      return {
        ...h,
        stock,
        invested,
        currentValue,
        pnl: currentValue - invested,
        pnlPct: invested > 0 ? ((currentValue - invested) / invested) * 100 : 0,
        allocationPct: 0,
      } as HoldingView;
    })
    .filter((h): h is HoldingView => h !== null);

  const total = enriched.reduce((s, h) => s + h.currentValue, 0);
  return enriched
    .map((h) => ({ ...h, allocationPct: total > 0 ? (h.currentValue / total) * 100 : 0 }))
    .sort((a, b) => b.currentValue - a.currentValue);
}

function sectorAllocationOf(positions: { symbol: string; value: number }[], total: number): SectorAllocation[] {
  const map = new Map<string, number>();
  for (const p of positions) {
    const sector = stockBySymbol.get(p.symbol)?.sector ?? "Unclassified";
    map.set(sector, (map.get(sector) ?? 0) + p.value);
  }
  return [...map.entries()]
    .map(([sector, value]) => ({ sector, value, pct: total > 0 ? (value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}

/**
 * Diversification score (0-100): 70% weight on the Herfindahl-Hirschman index
 * of stock weights, 30% on sector-level HHI. Higher = better spread.
 */
function diversificationScore(weights: number[], sectorWeights: number[]): number {
  if (weights.length === 0) return 0;
  const hhi = weights.reduce((s, w) => s + w * w, 0);
  const sectorHhi = sectorWeights.reduce((s, w) => s + w * w, 0);
  const stockPart = Math.max(0, 1 - hhi) * 100;
  const sectorPart = Math.max(0, 1 - sectorHhi) * 100;
  const countPenalty = Math.min(1, weights.length / 8);
  return clamp(0, 100, (stockPart * 0.7 + sectorPart * 0.3) * countPenalty);
}

/**
 * Risk score (0-100): weighted portfolio volatility (60%), concentration in the
 * largest position (25%), and worst historical drawdown exposure (15%).
 * Higher = riskier.
 */
function riskScore(volPct: number, topWeight: number, drawdownPct: number): number {
  const volPart = clamp(0, 100, ((volPct - 10) / 40) * 100);
  const concPart = clamp(0, 100, ((topWeight - 0.1) / 0.5) * 100);
  const ddPart = clamp(0, 100, (Math.abs(drawdownPct) / 60) * 100);
  return clamp(0, 100, volPart * 0.6 + concPart * 0.25 + ddPart * 0.15);
}

function clamp(min: number, max: number, v: number) {
  return Math.min(max, Math.max(min, v));
}

export function computeMetrics(positions: Position[]): PortfolioMetrics {
  const priced = positions
    .map((p) => {
      const stock = stockBySymbol.get(p.symbol);
      if (!stock) return null;
      return {
        symbol: p.symbol,
        value: p.quantity * stock.lastPrice,
        invested: p.quantity * p.avgBuyPrice,
      };
    })
    .filter((p): p is { symbol: string; value: number; invested: number } => p !== null);

  const totalValue = priced.reduce((s, p) => s + p.value, 0);
  const totalInvested = priced.reduce((s, p) => s + p.invested, 0);
  const sectors = sectorAllocationOf(priced, totalValue);

  if (totalValue === 0) {
    return {
      totalValue: 0,
      totalInvested,
      pnl: 0,
      pnlPct: 0,
      riskScore: 0,
      diversificationScore: 0,
      topConcentrationPct: 0,
      topConcentrationSymbol: null,
      annualisedVolatilityPct: 0,
      sectorAllocation: [],
      holdingCount: 0,
    };
  }

  const weights = priced.map((p) => p.value / totalValue);
  const sectorWeights = sectors.map((s) => s.pct / 100);
  const vols = priced.map((p) => getStockRiskProfile(p.symbol).volatilityPct);
  const dds = priced.map((p) => getStockRiskProfile(p.symbol).maxDrawdownPct);
  const weightedVol = weights.reduce((s, w, i) => s + w * vols[i]!, 0);
  const weightedDd = weights.reduce((s, w, i) => s + w * dds[i]!, 0);
  const topIdx = weights.indexOf(Math.max(...weights));

  return {
    totalValue,
    totalInvested,
    pnl: totalValue - totalInvested,
    pnlPct: totalInvested > 0 ? ((totalValue - totalInvested) / totalInvested) * 100 : 0,
    riskScore: riskScore(weightedVol, weights[topIdx]!, weightedDd),
    diversificationScore: diversificationScore(weights, sectorWeights),
    topConcentrationPct: weights[topIdx]! * 100,
    topConcentrationSymbol: priced[topIdx]!.symbol,
    annualisedVolatilityPct: weightedVol,
    sectorAllocation: sectors,
    holdingCount: priced.length,
  };
}

export function metricsForHoldings(holdings: Holding[]): PortfolioMetrics {
  return computeMetrics(holdings.map((h) => ({ symbol: h.symbol, quantity: h.quantity, avgBuyPrice: h.avgBuyPrice })));
}

/* ------------------------------- simulations ------------------------------ */

function deltas(before: PortfolioMetrics, after: PortfolioMetrics): SimulationDelta[] {
  return [
    { label: "Portfolio value", before: before.totalValue, after: after.totalValue, unit: "currency" },
    { label: "Risk score", before: before.riskScore, after: after.riskScore, unit: "score", betterWhenLower: true },
    { label: "Diversification score", before: before.diversificationScore, after: after.diversificationScore, unit: "score" },
    {
      label: "Largest position weight",
      before: before.topConcentrationPct,
      after: after.topConcentrationPct,
      unit: "pct",
      betterWhenLower: true,
    },
    {
      label: "Portfolio volatility (annualised)",
      before: before.annualisedVolatilityPct,
      after: after.annualisedVolatilityPct,
      unit: "pct",
      betterWhenLower: true,
    },
  ];
}

export function sectorExposure(metrics: PortfolioMetrics, sector: string): number {
  return metrics.sectorAllocation.find((s) => s.sector === sector)?.pct ?? 0;
}

export function portfolioCorrelation(holdings: Holding[], symbol: string): number | null {
  const candidate = weeklyReturns(getPriceHistory(symbol));
  const metrics = metricsForHoldings(holdings);
  if (metrics.totalValue === 0 || candidate.length === 0) return null;
  const series = holdings.map((h) => weeklyReturns(getPriceHistory(h.symbol)));
  const n = Math.min(candidate.length, ...series.map((s) => s.length));
  if (n < 26) return null;
  const weights = holdings.map((h) => {
    const st = stockBySymbol.get(h.symbol);
    return st ? (h.quantity * st.lastPrice) / metrics.totalValue : 0;
  });
  const blended: number[] = [];
  for (let i = 0; i < n; i++) {
    blended.push(series.reduce((s, arr, j) => s + weights[j]! * arr[arr.length - n + i]!, 0));
  }
  return correlation(candidate.slice(-n), blended);
}

/** Simulate buying `amount` worth of `symbol`. Never mutates real data. */
export function simulateBuy(holdings: Holding[], symbol: string, amount: number): BuySimulationResult {
  const stock = stockBySymbol.get(symbol);
  const before = metricsForHoldings(holdings);
  if (!stock || amount <= 0) {
    return { before, after: before, deltas: deltas(before, before), fitScore: 0, classification: "Poor Fit", reasons: [] };
  }
  const qty = amount / stock.lastPrice;
  const positions: Position[] = holdings.map((h) => ({ symbol: h.symbol, quantity: h.quantity, avgBuyPrice: h.avgBuyPrice }));
  const existing = positions.find((p) => p.symbol === symbol);
  if (existing) {
    const totalQty = existing.quantity + qty;
    existing.avgBuyPrice = (existing.quantity * existing.avgBuyPrice + amount) / totalQty;
    existing.quantity = totalQty;
  } else {
    positions.push({ symbol, quantity: qty, avgBuyPrice: stock.lastPrice });
  }
  const after = computeMetrics(positions);

  const divDelta = after.diversificationScore - before.diversificationScore;
  const riskDelta = after.riskScore - before.riskScore;
  const sectorAfter = sectorExposure(after, stock.sector);
  const corr = portfolioCorrelation(holdings, symbol);
  const profile = getStockRiskProfile(symbol);

  // Fit score (0-10): diversification gain, risk restraint, sector balance,
  // correlation benefit and standalone volatility.
  let score = 5;
  score += clamp(-2, 2, divDelta / 3);
  score -= clamp(-2, 2, riskDelta / 3);
  score -= clamp(0, 2, (sectorAfter - 30) / 15);
  if (corr !== null) score += clamp(-1.5, 1.5, (0.5 - corr) * 2);
  score -= clamp(0, 1.5, (profile.volatilityPct - 30) / 15);
  const fitScore = +clamp(0, 10, score).toFixed(1);

  const classification: FitClassification =
    fitScore >= 7.5 ? "Strong Fit" : fitScore >= 6 ? "Reasonable Fit" : fitScore >= 4 ? "Weak Fit" : "Poor Fit";

  const reasons: string[] = [];
  reasons.push(
    divDelta >= 0
      ? `Diversification improves by ${divDelta.toFixed(1)} points after this allocation.`
      : `Diversification falls by ${Math.abs(divDelta).toFixed(1)} points after this allocation.`,
  );
  reasons.push(
    riskDelta > 0
      ? `Portfolio risk score rises by ${riskDelta.toFixed(1)} points, largely from ${symbol}'s ${profile.volatilityPct.toFixed(1)}% historical volatility.`
      : `Portfolio risk score eases by ${Math.abs(riskDelta).toFixed(1)} points.`,
  );
  reasons.push(
    `${stock.sector} exposure moves from ${sectorExposure(before, stock.sector).toFixed(1)}% to ${sectorAfter.toFixed(1)}% of portfolio value.`,
  );
  if (corr !== null) {
    reasons.push(
      `Historical weekly-return correlation with your current portfolio is ${corr.toFixed(2)} — ${corr < 0.4 ? "relatively independent" : corr < 0.7 ? "moderately linked" : "closely linked"}.`,
    );
  } else {
    reasons.push("Correlation is not shown: insufficient overlapping price history in the dataset.");
  }
  return { before, after, deltas: deltas(before, after), fitScore, classification, reasons };
}

/** Simulate selling `pct`% of one holding. Never mutates real data. */
export function simulateSell(holdings: Holding[], holdingId: string, pct: number): SellSimulationResult {
  const before = metricsForHoldings(holdings);
  const target = holdings.find((h) => h.id === holdingId);
  const stock = target ? stockBySymbol.get(target.symbol) : undefined;
  if (!target || !stock) {
    return {
      before,
      after: before,
      deltas: deltas(before, before),
      proceeds: 0,
      realisedPnl: 0,
      recommendation: "HOLD",
      reasons: [],
    };
  }
  const soldQty = (target.quantity * pct) / 100;
  const remaining = holdings
    .map((h) => (h.id === holdingId ? { ...h, quantity: h.quantity - soldQty } : h))
    .filter((h) => h.quantity > 0.0001);
  const after = metricsForHoldings(remaining);
  const proceeds = soldQty * stock.lastPrice;
  const realisedPnl = soldQty * (stock.lastPrice - target.avgBuyPrice);

  const profile = getStockRiskProfile(target.symbol);
  const view = buildHoldingViews(holdings).find((h) => h.id === holdingId);
  const weight = view?.allocationPct ?? 0;
  const sectorBefore = sectorExposure(before, stock.sector);

  const reasons: string[] = [];
  let flags = 0;
  if (weight > 25) {
    flags += 2;
    reasons.push(`This position is ${weight.toFixed(1)}% of portfolio value — concentration is high relative to a balanced 8-10 stock portfolio.`);
  } else if (weight > 15) {
    flags += 1;
    reasons.push(`This position is ${weight.toFixed(1)}% of portfolio value — above average weight, worth monitoring.`);
  } else {
    reasons.push(`This position is ${weight.toFixed(1)}% of portfolio value, within a typical single-name weight.`);
  }
  if (profile.volatilityPct > 32) {
    flags += 1;
    reasons.push(`Historical volatility of ${profile.volatilityPct.toFixed(1)}% is in the high band; current indicators suggest elevated risk.`);
  }
  if (sectorBefore > 35) {
    flags += 1;
    reasons.push(`${stock.sector} already accounts for ${sectorBefore.toFixed(1)}% of the portfolio.`);
  }
  reasons.push(
    `Selling ${pct}% moves the risk score from ${before.riskScore.toFixed(1)} to ${after.riskScore.toFixed(1)} and diversification from ${before.diversificationScore.toFixed(1)} to ${after.diversificationScore.toFixed(1)}.`,
  );

  const recommendation = flags >= 3 ? "CONSIDER REDUCING" : flags >= 1 ? "REVIEW" : "HOLD";
  return { before, after, deltas: deltas(before, after), proceeds, realisedPnl, recommendation, reasons };
}

/** Synthetic portfolio value curve derived from holding price history. */
export function portfolioValueSeries(holdings: Holding[], weeks = 52): PricePoint[] {
  if (holdings.length === 0) return [];
  const series = holdings.map((h) => ({ qty: h.quantity, points: getPriceHistory(h.symbol) }));
  const len = Math.min(weeks, ...series.map((s) => s.points.length));
  const out: PricePoint[] = [];
  for (let i = len; i > 0; i--) {
    let total = 0;
    let date = "";
    for (const s of series) {
      const p = s.points[s.points.length - i]!;
      total += p.close * s.qty;
      date = p.date;
    }
    out.push({ date, close: +total.toFixed(2) });
  }
  return out;
}
