/**
 * PortfolioIQ analytics engine (backend mirror of the frontend formulas).
 *
 * Every number surfaced by the API is produced here — deterministic, auditable
 * formulas over price history loaded from PostgreSQL. The AI layer only
 * *explains* these outputs; it never produces figures.
 *
 * Note: this module is pure (no DB access) so it can be unit-tested and so the
 * dependency direction stays analytics ← services, AI ← analytics.
 */

export interface PricePoint {
  date: string;
  close: number;
}

export interface SectorAllocation {
  sector: string;
  value: number;
  pct: number;
}

export interface PortfolioMetrics {
  totalValue: number;
  totalInvested: number;
  pnl: number;
  pnlPct: number;
  riskScore: number;
  diversificationScore: number;
  topConcentrationPct: number;
  topConcentrationSymbol: string | null;
  annualisedVolatilityPct: number;
  maxDrawdownPct: number;
  return1yPct: number | null;
  return3yPct: number | null;
  return5yPct: number | null;
  sectorAllocation: SectorAllocation[];
  holdingCount: number;
}

export interface StockRiskProfile {
  volatilityPct: number;
  maxDrawdownPct: number;
  return1yPct: number | null;
  return3yPct: number | null;
  return5yPct: number | null;
  riskBand: "Low" | "Moderate" | "High" | "Very High";
}

export interface PositionInput {
  symbol: string;
  quantity: number;
  avgBuyPrice: number;
}

export interface StockMeta {
  symbol: string;
  sector: string;
  lastPrice: number;
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

export function getStockRiskProfile(series: PricePoint[]): StockRiskProfile {
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

function clamp(min: number, max: number, v: number) {
  return Math.min(max, Math.max(min, v));
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
 * Risk score (0-100): weighted portfolio volatility (60%), concentration in
 * the largest position (25%), and worst historical drawdown exposure (15%).
 */
function riskScore(volPct: number, topWeight: number, drawdownPct: number): number {
  const volPart = clamp(0, 100, ((volPct - 10) / 40) * 100);
  const concPart = clamp(0, 100, ((topWeight - 0.1) / 0.5) * 100);
  const ddPart = clamp(0, 100, (Math.abs(drawdownPct) / 60) * 100);
  return clamp(0, 100, volPart * 0.6 + concPart * 0.25 + ddPart * 0.15);
}

function sectorAllocationOf(
  positions: { sector: string; value: number }[],
  total: number,
): SectorAllocation[] {
  const map = new Map<string, number>();
  for (const p of positions) {
    map.set(p.sector, (map.get(p.sector) ?? 0) + p.value);
  }
  return [...map.entries()]
    .map(([sector, value]) => ({ sector, value, pct: total > 0 ? (value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}

export function computeMetrics(
  positions: PositionInput[],
  metaBySymbol: Map<string, StockMeta>,
  historyBySymbol: Map<string, PricePoint[]>,
): PortfolioMetrics {
  const priced = positions
    .map((p) => {
      const meta = metaBySymbol.get(p.symbol);
      if (!meta) return null;
      return {
        symbol: p.symbol,
        sector: meta.sector,
        value: p.quantity * meta.lastPrice,
        invested: p.quantity * p.avgBuyPrice,
      };
    })
    .filter((p): p is { symbol: string; sector: string; value: number; invested: number } => p !== null);

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
      maxDrawdownPct: 0,
      return1yPct: null,
      return3yPct: null,
      return5yPct: null,
      sectorAllocation: [],
      holdingCount: 0,
    };
  }

  const weights = priced.map((p) => p.value / totalValue);
  const sectorWeights = sectors.map((s) => s.pct / 100);

  const profiles = priced.map((p) => getStockRiskProfile(historyBySymbol.get(p.symbol) ?? []));
  const vols = profiles.map((pr) => pr.volatilityPct);
  const dds = profiles.map((pr) => pr.maxDrawdownPct);
  const weightedVol = weights.reduce((s, w, i) => s + w * (vols[i] ?? 0), 0);
  const weightedDd = weights.reduce((s, w, i) => s + w * (dds[i] ?? 0), 0);
  const topIdx = weights.indexOf(Math.max(...weights));

  // Portfolio-level trailing returns from the blended value series.
  const blended = blendValueSeries(
    priced.map((p, i) => ({ symbol: p.symbol, weight: weights[i] ?? 0 })),
    historyBySymbol,
  );
  const blendedProfile = getStockRiskProfile(blended);

  return {
    totalValue,
    totalInvested,
    pnl: totalValue - totalInvested,
    pnlPct: totalInvested > 0 ? ((totalValue - totalInvested) / totalInvested) * 100 : 0,
    riskScore: riskScore(weightedVol, weights[topIdx] ?? 0, weightedDd),
    diversificationScore: diversificationScore(weights, sectorWeights),
    topConcentrationPct: (weights[topIdx] ?? 0) * 100,
    topConcentrationSymbol: priced[topIdx]?.symbol ?? null,
    annualisedVolatilityPct: weightedVol,
    maxDrawdownPct: blendedProfile.maxDrawdownPct,
    return1yPct: blendedProfile.return1yPct,
    return3yPct: blendedProfile.return3yPct,
    return5yPct: blendedProfile.return5yPct,
    sectorAllocation: sectors,
    holdingCount: priced.length,
  };
}

/** Weighted blend of holding price series → portfolio value series. */
function blendValueSeries(
  entries: { symbol: string; weight: number }[],
  historyBySymbol: Map<string, PricePoint[]>,
): PricePoint[] {
  const series = entries
    .map((e) => ({ weight: e.weight, points: historyBySymbol.get(e.symbol) ?? [] }))
    .filter((s) => s.points.length > 0);
  if (series.length === 0) return [];
  const len = Math.min(...series.map((s) => s.points.length));
  const out: PricePoint[] = [];
  for (let i = 0; i < len; i++) {
    let total = 0;
    let date = "";
    for (const s of series) {
      const idx = s.points.length - len + i;
      const point = s.points[idx];
      if (!point) continue;
      total += point.close * s.weight;
      date = point.date;
    }
    out.push({ date, close: total });
  }
  return out;
}

export function portfolioValueSeries(
  positions: PositionInput[],
  metaBySymbol: Map<string, StockMeta>,
  historyBySymbol: Map<string, PricePoint[]>,
  weeks = 52,
): PricePoint[] {
  const series = positions
    .map((p) => ({ qty: p.quantity, points: historyBySymbol.get(p.symbol) ?? [] }))
    .filter((s) => s.points.length > 0);
  if (series.length === 0) return [];
  const len = Math.min(weeks, ...series.map((s) => s.points.length));
  const out: PricePoint[] = [];
  for (let i = len; i > 0; i--) {
    let total = 0;
    let date = "";
    for (const s of series) {
      const point = s.points[s.points.length - i];
      if (!point) continue;
      total += point.close * s.qty;
      date = point.date;
    }
    out.push({ date, close: Number(total.toFixed(2)) });
  }
  return out;
}

/** Candidate stock weekly returns vs weighted portfolio weekly returns. */
export function portfolioCorrelation(
  candidateSymbol: string,
  positions: PositionInput[],
  metaBySymbol: Map<string, StockMeta>,
  historyBySymbol: Map<string, PricePoint[]>,
): number | null {
  const candidateHistory = historyBySymbol.get(candidateSymbol);
  if (!candidateHistory || positions.length === 0) return null;

  const metrics = computeMetrics(positions, metaBySymbol, historyBySymbol);
  if (metrics.totalValue === 0) return null;

  const candidate = weeklyReturns(candidateHistory);
  const series = positions.map((p) => weeklyReturns(historyBySymbol.get(p.symbol) ?? []));
  const n = Math.min(candidate.length, ...series.map((s) => (s.length > 0 ? s.length : Number.MAX_SAFE_INTEGER)));
  if (!Number.isFinite(n) || n < 26) return null;

  const weights = positions.map((p) => {
    const meta = metaBySymbol.get(p.symbol);
    return meta ? (p.quantity * meta.lastPrice) / metrics.totalValue : 0;
  });

  const blended: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < series.length; j++) {
      const arr = series[j]!;
      const idx = arr.length - n + i;
      sum += (weights[j] ?? 0) * (arr[idx] ?? 0);
    }
    blended.push(sum);
  }
  return correlation(candidate.slice(-n), blended);
}

export function listSectorNames(sectorRows?: { sector: string }[]): string[] {
  if (sectorRows && sectorRows.length > 0) {
    return [...new Set(sectorRows.map((r) => r.sector))].sort();
  }
  return [];
}


/** Shared row type for query builders that touch the stocks table. */
export type StockRowForAnalytics = {
  symbol: string;
  sector: string;
};
