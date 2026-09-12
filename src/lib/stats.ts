/**
 * Pure price-series statistics shared by the analytics engine and the demo
 * dataset. Dependency-free by design: both `analytics.ts` (which knows about
 * demo data) and `demo-data.ts` (which must not import the engine) can use it
 * without creating a circular import.
 */
import type { PricePoint, StockRiskProfile } from "@/types";

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

export function trailingReturn(series: PricePoint[], years: number): number | null {
  const weeks = Math.round(52 * years);
  if (series.length <= weeks) return null;
  const start = series[series.length - 1 - weeks]!.close;
  const end = series[series.length - 1]!.close;
  if (start <= 0) return null;
  const total = end / start;
  return ((years === 1 ? total : Math.pow(total, 1 / years)) - 1) * 100;
}

export function riskBand(volatilityPct: number): StockRiskProfile["riskBand"] {
  if (volatilityPct < 18) return "Low";
  if (volatilityPct < 26) return "Moderate";
  if (volatilityPct < 38) return "High";
  return "Very High";
}
