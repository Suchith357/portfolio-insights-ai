/**
 * PortfolioIQ analytics engine (backend).
 *
 * Every number surfaced by the API is produced here — deterministic, auditable
 * formulas over price history loaded from PostgreSQL. The AI layer only
 * *explains* these outputs; it never produces figures.
 *
 * Statistical properties of this implementation:
 *  - All series maths aligns by DATE, never by array position. Holdings whose
 *    price histories start at different dates (or have gaps) are intersected
 *    on their common trading dates before any portfolio-level statistic is
 *    computed.
 *  - Insufficient data is a distinct state: volatility is null, risk is
 *    "Insufficient Data" — never zero and never "Low". Missing financial
 *    fields stay null and the UI renders them as N/A.
 *  - The risk/diversification scores are PortfolioIQ analytical heuristics
 *    (documented inline), not official industry standards.
 */
import { prisma } from "../utils/prisma.js";

export interface PricePoint {
  date: string;
  close: number;
}

export interface SectorAllocation {
  sector: string;
  value: number;
  pct: number;
}

export type RiskBand = "Low" | "Moderate" | "High" | "Very High" | "Insufficient Data";

export interface PortfolioMetrics {
  totalValue: number;
  totalInvested: number;
  pnl: number;
  pnlPct: number;
  riskScore: number | null;
  diversificationScore: number;
  topConcentrationPct: number;
  topConcentrationSymbol: string | null;
  annualisedVolatilityPct: number | null;
  maxDrawdownPct: number | null;
  return1yPct: number | null;
  return3yPct: number | null;
  return5yPct: number | null;
  /** True when history is too short for portfolio-level risk statistics. */
  riskDataSufficient: boolean;
  /** Provenance of the underlying prices: DEMO (synthetic) or YAHOO (real). */
  dataSourceMix: { demo: number; yahoo: number };
  sectorAllocation: SectorAllocation[];
  holdingCount: number;
}

export interface StockRiskProfile {
  volatilityPct: number | null;
  maxDrawdownPct: number | null;
  return1yPct: number | null;
  return3yPct: number | null;
  return5yPct: number | null;
  riskBand: RiskBand;
  /** Weeks of weekly closes behind the profile (min observations gate). */
  observations: number;
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
  previousClose: number;
  dataSource: string;
  lastPriceDate: string | null;
}

/** Minimum weekly observations before portfolio-level risk stats are trusted. */
const MIN_WEEKS_FOR_RISK = 8;

/* ------------------------------- date helpers ------------------------------ */

/** Derives a Monday-anchored ISO week key from a YYYY-MM-DD date string. */
function weekKeyOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay();
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

/**
 * Groups an arbitrary-dated close series into Monday-anchored ISO weeks,
 * taking the LAST available close within each week. Series must already be
 * sorted ascending by date.
 */
function toWeeklyCloses(series: PricePoint[]): PricePoint[] {
  const byWeek = new Map<string, PricePoint>();
  for (const p of series) {
    const key = weekKeyOf(p.date);
    byWeek.set(key, p); // later entries overwrite earlier ones
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, p]) => p);
}

/**
 * Aligns several close series on their COMMON dates. Returns per-series
 * arrays restricted to the intersection of all date sets, plus the shared
 * date list — the foundation for date-correct portfolio maths.
 */
function alignSeries(seriesList: PricePoint[][]): { dates: string[]; aligned: number[][] } {
  if (seriesList.length === 0) return { dates: [], aligned: [] };
  const shorter = [...seriesList].sort((a, b) => a.length - b.length)[0]!;
  const common = new Set(shorter.map((p) => p.date));
  for (const s of seriesList) {
    const dates = new Set(s.map((p) => p.date));
    for (const d of common) {
      if (!dates.has(d)) common.delete(d);
    }
    if (common.size === 0) break;
  }
  const sortedDates = [...common].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mapOf = (s: PricePoint[]) => new Map(s.map((p) => [p.date, p.close]));
  const maps = seriesList.map(mapOf);
  return {
    dates: sortedDates,
    aligned: maps.map((m) => sortedDates.map((d) => m.get(d)!)),
  };
}

/* ------------------------------ series stats ------------------------------- */

/** Weekly returns from an ascending close series (strictly by adjacent rows). */
export function weeklyReturns(series: PricePoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!.close;
    if (prev > 0) out.push(series[i]!.close / prev - 1);
  }
  return out;
}

/** Annualised volatility of a weekly close series; null when too few points. */
export function annualisedVolatility(series: PricePoint[]): number | null {
  const r = weeklyReturns(series);
  if (r.length < MIN_WEEKS_FOR_RISK - 1) return null;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  const vol = Math.sqrt(variance) * Math.sqrt(52) * 100;
  return Number.isFinite(vol) ? vol : null;
}

export function maxDrawdown(series: PricePoint[]): number | null {
  if (series.length < 2) return null;
  let peak = -Infinity;
  let worst = 0;
  for (const p of series) {
    peak = Math.max(peak, p.close);
    worst = Math.min(worst, peak > 0 ? p.close / peak - 1 : 0);
  }
  return worst * 100;
}

/**
 * Trailing return. `years === 1` returns the simple total return; longer
 * horizons are annualised (CAGR). null when the series is too short or the
 * start price is unusable.
 */
function trailingReturn(series: PricePoint[], years: number): number | null {
  const weeks = Math.round(52 * years);
  if (series.length <= weeks) return null;
  const start = series[series.length - 1 - weeks]!.close;
  const end = series[series.length - 1]!.close;
  if (start <= 0) return null;
  const total = end / start;
  const value = (years === 1 ? total : Math.pow(total, 1 / years)) - 1;
  return Number.isFinite(value) ? value * 100 : null;
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
  const r = num / Math.sqrt(dx * dy);
  return Number.isFinite(r) ? r : null;
}

export function riskBand(volatilityPct: number | null): RiskBand {
  if (volatilityPct === null) return "Insufficient Data";
  if (volatilityPct < 18) return "Low";
  if (volatilityPct < 26) return "Moderate";
  if (volatilityPct < 38) return "High";
  return "Very High";
}

/**
 * Trims a mixed-provenance series to its latest homogeneous-source segment.
 * Synthetic weekly DEMO bars and real daily YAHOO bars must never be blended:
 * the junction would fabricate a huge single return and poison every
 * statistic (e.g. 500%+ "volatility"). YAHOO is preferred when present.
 */
export function latestHomogeneousSegment(series: PricePoint[], sourceByDate?: Map<string, string>): PricePoint[] {
  if (!sourceByDate || sourceByDate.size === 0 || series.length === 0) return series;
  // Walk back from the newest bar and find where the source flips.
  // Default of 0 means "no flip found → the whole series is homogeneous".
  const newestSource = sourceByDate.get(series[series.length - 1]!.date);
  let cut = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    if (sourceByDate.get(series[i]!.date) !== newestSource) {
      cut = i + 1;
      break;
    }
  }
  return series.slice(cut);
}

export function getStockRiskProfile(
  series: PricePoint[],
  sourceByDate?: Map<string, string>,
): StockRiskProfile {
  const usable = latestHomogeneousSegment(series, sourceByDate);
  const weekly = toWeeklyCloses(usable);
  const vol = annualisedVolatility(weekly);
  return {
    volatilityPct: vol,
    maxDrawdownPct: maxDrawdown(weekly),
    return1yPct: trailingReturn(weekly, 1),
    return3yPct: trailingReturn(weekly, 3),
    return5yPct: trailingReturn(weekly, 5),
    riskBand: riskBand(vol),
    observations: weekly.length,
  };
}

/* ----------------------------- portfolio maths ----------------------------- */

function clamp(min: number, max: number, v: number) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Diversification score (0-100): 70% weight on the Herfindahl-Hirschman index
 * of stock weights, 30% on sector-level HHI. Higher = better spread.
 * PortfolioIQ heuristic — not an industry-standard index.
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
 * Risk score (0-100): portfolio volatility (60%), largest-position weight
 * (25%), portfolio drawdown (15%). Null volatility (insufficient history)
 * propagates to a null score — missing data is never treated as "low risk".
 * PortfolioIQ heuristic — not an industry-standard index.
 */
function riskScore(
  volPct: number | null,
  topWeight: number,
  drawdownPct: number | null,
): number | null {
  if (volPct === null || drawdownPct === null) return null;
  const volPart = clamp(0, 100, ((volPct - 10) / 40) * 100);
  const concPart = clamp(0, 100, ((topWeight - 0.1) / 0.5) * 100);
  const ddPart = clamp(0, 100, (Math.abs(drawdownPct) / 60) * 100);
  const score = clamp(0, 100, volPart * 0.6 + concPart * 0.25 + ddPart * 0.15);
  return Number.isFinite(score) ? score : null;
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
      riskScore: null,
      diversificationScore: 0,
      topConcentrationPct: 0,
      topConcentrationSymbol: null,
      annualisedVolatilityPct: null,
      maxDrawdownPct: null,
      return1yPct: null,
      return3yPct: null,
      return5yPct: null,
      riskDataSufficient: false,
      dataSourceMix: { demo: 0, yahoo: 0 },
      sectorAllocation: [],
      holdingCount: 0,
    };
  }

  const weights = priced.map((p) => p.value / totalValue);
  const sectorWeights = sectors.map((s) => s.pct / 100);
  const topIdx = weights.indexOf(Math.max(...weights));

  // ---- Portfolio-level volatility from DATE-ALIGNED blended weekly closes.
  // Every holding's series is intersected on common dates; the blended series
  // is Σ weightᵢ · closeᵢ(t) — a genuine portfolio-level return series, not a
  // weighted average of individual volatilities.
  const seriesList = priced.map((p) => historyBySymbol.get(p.symbol) ?? []);
  const { dates, aligned } = alignSeries(seriesList);
  const datedSeries: PricePoint[][] = aligned.map((closes) =>
    closes.map((close, i) => ({ date: dates[i]!, close })),
  );
  const weeklyPerHolding = datedSeries.map(toWeeklyCloses);
  const blendedWeekly: PricePoint[] = [];
  if (weeklyPerHolding.length > 0) {
    const minLen = Math.min(...weeklyPerHolding.map((s) => s.length));
    const startIdx = weeklyPerHolding.map((s) => s.length - minLen);
    for (let i = 0; i < minLen; i++) {
      let value = 0;
      let date = "";
      let usable = true;
      for (let j = 0; j < weeklyPerHolding.length; j++) {
        const point = weeklyPerHolding[j]![startIdx[j]! + i];
        if (!point) {
          usable = false;
          break;
        }
        value += point.close * (weights[j] ?? 0);
        date = point.date;
      }
      if (usable) blendedWeekly.push({ date, close: value });
    }
  }
  const portfolioVol = annualisedVolatility(blendedWeekly);
  const portfolioDd = maxDrawdown(blendedWeekly);
  const portfolioReturns = trailingReturn(blendedWeekly, 1);
  const portfolio3y = trailingReturn(blendedWeekly, 3);
  const portfolio5y = trailingReturn(blendedWeekly, 5);

  // Provenance mix of the latest closes feeding these metrics.
  const dataSourceMix = { demo: 0, yahoo: 0 };
  for (const p of priced) {
    const src = metaBySymbol.get(p.symbol)?.dataSource ?? "DEMO";
    if (src === "YAHOO") dataSourceMix.yahoo += 1;
    else dataSourceMix.demo += 1;
  }

  const topSymbol = priced[topIdx]?.symbol ?? null;
  const topWeight = weights[topIdx] ?? 0;

  return {
    totalValue,
    totalInvested,
    pnl: totalValue - totalInvested,
    pnlPct: totalInvested > 0 ? ((totalValue - totalInvested) / totalInvested) * 100 : 0,
    riskScore: riskScore(portfolioVol, topWeight, portfolioDd),
    diversificationScore: diversificationScore(weights, sectorWeights),
    topConcentrationPct: topWeight * 100,
    topConcentrationSymbol: topSymbol,
    annualisedVolatilityPct: portfolioVol,
    maxDrawdownPct: portfolioDd,
    return1yPct: portfolioReturns,
    return3yPct: portfolio3y,
    return5yPct: portfolio5y,
    riskDataSufficient: portfolioVol !== null,
    dataSourceMix,
    sectorAllocation: sectors,
    holdingCount: priced.length,
  };
}

/**
 * Current-holdings historical simulation: applies today's quantities to the
 * DATE-ALIGNED price history (intersection of common dates). This is a
 * hypothetical curve — today's holdings did not necessarily exist historically
 * — and the UI labels it as such.
 */
export function portfolioValueSeries(
  positions: PositionInput[],
  metaBySymbol: Map<string, StockMeta>,
  historyBySymbol: Map<string, PricePoint[]>,
  weeks = 156,
): PricePoint[] {
  const seriesList = positions
    .map((p) => historyBySymbol.get(p.symbol) ?? [])
    .filter((s) => s.length > 0);
  if (seriesList.length === 0) return [];

  const weights = new Map(positions.map((p) => [p.symbol, p.quantity]));
  const { dates, aligned } = alignSeries(seriesList);

  const out: PricePoint[] = [];
  const from = Math.max(0, dates.length - weeks);
  for (let i = from; i < dates.length; i++) {
    let total = 0;
    for (let j = 0; j < positions.length; j++) {
      const close = aligned[j]?.[i];
      if (close === undefined) return out.length > 0 ? out : [];
      const qty = weights.get(positions[j]!.symbol) ?? 0;
      total += close * qty;
    }
    out.push({ date: dates[i]!, close: Number(total.toFixed(2)) });
  }
  return out;
}

/**
 * Candidate stock weekly returns vs DATE-ALIGNED blended portfolio weekly
 * returns. null when overlapping history is insufficient.
 */
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

  // Align the candidate with the blended portfolio series by date.
  const seriesList = positions.map((p) => historyBySymbol.get(p.symbol) ?? []);
  const candidateAligned = alignSeries([candidateHistory, ...seriesList]);
  if (candidateAligned.dates.length < 27) return null;

  const weights = positions.map((p) => {
    const meta = metaBySymbol.get(p.symbol);
    return meta ? (p.quantity * meta.lastPrice) / metrics.totalValue : 0;
  });

  const blended: number[] = [];
  const cand: number[] = [];
  for (let i = 1; i < candidateAligned.dates.length; i++) {
    const candPrev = candidateAligned.aligned[0]![i - 1]!;
    const candNow = candidateAligned.aligned[0]![i]!;
    if (candPrev <= 0) continue;
    cand.push(candNow / candPrev - 1);
    let sum = 0;
    for (let j = 0; j < seriesList.length; j++) {
      const prev = candidateAligned.aligned[j + 1]![i - 1]!;
      const now = candidateAligned.aligned[j + 1]![i]!;
      sum += (weights[j] ?? 0) * (prev > 0 ? now / prev - 1 : 0);
    }
    blended.push(sum);
  }
  return correlation(cand, blended);
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

/** Loads risk profiles for a symbol → series map (analysis context helper). */
export function buildRiskProfiles(historyBySymbol: Map<string, PricePoint[]>): Map<string, StockRiskProfile> {
  const out = new Map<string, StockRiskProfile>();
  for (const [symbol, series] of historyBySymbol) {
    out.set(symbol, getStockRiskProfile(series));
  }
  return out;
}

/** Latest DB timestamp across price rows for a stock set — freshness probe. */
export async function latestPriceDateFor(stockIds: number[]): Promise<string | null> {
  if (stockIds.length === 0) return null;
  const row = await prisma.stock_prices.findFirst({
    where: { stock_id: { in: stockIds } },
    orderBy: { price_date: "desc" },
    select: { price_date: true },
  });
  return row ? row.price_date.toISOString().slice(0, 10) : null;
}
