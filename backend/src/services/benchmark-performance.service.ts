/**
 * Benchmark-relative performance (Intelligence Engine, Phase 7).
 *
 * Beta/alpha/tracking error/information ratio/upside-downside capture against
 * the stored NIFTY series. All math is on EXACT date-aligned daily returns
 * (intersection of dates — never array position). Insufficient data → explicit
 * N/A with a reason; nothing is fabricated. Assumes a 6.5% p.a. risk-free
 * rate (same documented assumption as the Phase 4 engine, configurable via
 * RISK_FREE_RATE_PCT).
 *
 * Calculation version: benchmark-v1
 */

import { activeBenchmark, benchmarkCloses } from "./benchmark.service.js";
import { loadAlignedSeries } from "./news/quantitative-risk.service.js";

export const BENCHMARK_MODEL_VERSION = "benchmark-v1";
const TRADING_DAYS = 252;

export interface BenchmarkMetric {
  value: number | null;
  unit: string;
  available: boolean;
  reason: string | null;
}

function m(value: number | null, unit: string, reason: string | null = null): BenchmarkMetric {
  return {
    value,
    unit,
    available: value !== null && Number.isFinite(value),
    reason: value === null || !Number.isFinite(value) ? (reason ?? "Insufficient data") : null,
  };
}

function r2(x: number | null): number | null {
  return x === null || !Number.isFinite(x) ? null : Number(x.toFixed(2));
}
function r4(x: number | null): number | null {
  return x === null || !Number.isFinite(x) ? null : Number(x.toFixed(4));
}

function mean(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export interface BenchmarkPerformance {
  modelVersion: string;
  benchmark: { symbol: string; name: string } | null;
  provenance: {
    observationCount: number;
    firstDate: string | null;
    lastDate: string | null;
    dataSource: string;
    riskFreeRatePct: number;
    annualisation: "daily returns × √252";
  };
  metrics: {
    benchmarkReturnPctAnn: BenchmarkMetric;
    portfolioReturnPctAnn: BenchmarkMetric;
    excessReturnPctAnn: BenchmarkMetric;
    beta: BenchmarkMetric;
    alphaPctAnn: BenchmarkMetric;
    trackingErrorPctAnn: BenchmarkMetric;
    informationRatio: BenchmarkMetric;
    upsideCapturePct: BenchmarkMetric;
    downsideCapturePct: BenchmarkMetric;
  };
}

/**
 * Portfolio returns here are the CURRENT-HOLDINGS weighted series (Phase 4
 * conventions); labelled as such by the callers. For each date present in BOTH
 * the portfolio series and the benchmark series we form the paired daily
 * return — exact-date intersection.
 */
export async function benchmarkPerformance(
  portfolioId: number,
  holdings: Array<{ stock_id: number; symbol: string; sector: string; quantity: number }>,
): Promise<BenchmarkPerformance> {
  const bench = await activeBenchmark();
  const rfPct = (() => {
    const rf = Number(process.env["RISK_FREE_RATE_PCT"] ?? 6.5);
    return Number.isFinite(rf) && rf >= 0 && rf <= 30 ? rf : 6.5;
  })();

  const unavailable = (reason: string): BenchmarkPerformance => ({
    modelVersion: BENCHMARK_MODEL_VERSION,
    benchmark: bench ? { symbol: bench.symbol, name: bench.name } : null,
    provenance: {
      observationCount: 0,
      firstDate: null,
      lastDate: null,
      dataSource: "YAHOO",
      riskFreeRatePct: rfPct,
      annualisation: "daily returns × √252" as const,
    },
    metrics: {
      benchmarkReturnPctAnn: m(null, "% ann.", reason),
      portfolioReturnPctAnn: m(null, "% ann.", reason),
      excessReturnPctAnn: m(null, "% ann.", reason),
      beta: m(null, "ratio", reason),
      alphaPctAnn: m(null, "% ann.", reason),
      trackingErrorPctAnn: m(null, "% ann.", reason),
      informationRatio: m(null, "ratio", reason),
      upsideCapturePct: m(null, "%", reason),
      downsideCapturePct: m(null, "%", reason),
    },
  });

  if (!bench) return unavailable("No benchmark is configured in the database.");
  const benchCloses = await benchmarkCloses(bench.benchmarkId);
  if (benchCloses.length < 31) {
    return unavailable(`Only ${benchCloses.length} benchmark observations stored — at least 30 paired returns required.`);
  }

  const bundle = await loadAlignedSeries(holdings.map((h) => h.stock_id));
  const idxById = new Map(bundle.symbols.map((s, i) => [Number(s), i]));
  const ordered = holdings.map((h) => idxById.get(h.stock_id)).filter((i): i is number => i !== undefined);
  if (ordered.length === 0) return unavailable("No priced holdings in this portfolio.");

  const dates = bundle.dates;
  if (dates.length < 31) {
    return unavailable(`Only ${dates.length} date-aligned portfolio observations — at least 30 required.`);
  }

  // Current-holdings weights from the LAST aligned closes.
  const qtyByHold = new Map(holdings.map((h) => [h.stock_id, h.quantity]));
  const lastCloses = ordered.map((i) => bundle.closes[i]![bundle.closes[i]!.length - 1] ?? 0);
  const values = ordered.map((i, k) => (qtyByHold.get(Number(bundle.symbols[i])) ?? 0) * lastCloses[k]!);
  const total = values.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return unavailable("Portfolio has no positive market value at the latest aligned close.");

  // Portfolio value series over the aligned dates (buy-and-hold weights).
  const pv: number[] = dates.map((_, t) =>
    ordered.reduce((acc, i, k) => {
      const c = bundle.closes[i]![t]!;
      const q = qtyByHold.get(Number(bundle.symbols[i])) ?? 0;
      return acc + c * q;
    }, 0),
  );
  const portReturns: number[] = [];
  for (let t = 1; t < pv.length; t++) portReturns.push(pv[t - 1]! > 0 ? pv[t]! / pv[t - 1]! - 1 : 0);
  const portReturnDates = dates.slice(1); // return[t] belongs to date[t]

  // Benchmark daily returns keyed by date for exact pairing.
  const benchByDate = new Map(benchCloses.map((p) => [p.date, p.close]));
  const benchReturnByDate = new Map<string, number>();
  for (let i = 1; i < benchCloses.length; i++) {
    const prev = benchCloses[i - 1]!.close;
    if (prev > 0) benchReturnByDate.set(benchCloses[i]!.date, benchCloses[i]!.close / prev - 1);
  }

  // Paired returns on the EXACT intersection of dates.
  const pairs: Array<{ rp: number; rb: number }> = [];
  for (let t = 0; t < portReturns.length; t++) {
    const d = portReturnDates[t]!;
    const rb = benchReturnByDate.get(d);
    if (rb !== undefined) pairs.push({ rp: portReturns[t]!, rb });
  }
  if (pairs.length < 30) {
    return unavailable(`Only ${pairs.length} date-aligned portfolio/benchmark return pairs — at least 30 required.`);
  }

  const rpArr = pairs.map((p) => p.rp);
  const rbArr = pairs.map((p) => p.rb);
  const meanP = mean(rpArr);
  const meanB = mean(rbArr);
  const varB = rbArr.reduce((a, x) => a + (x - meanB) ** 2, 0) / (rbArr.length - 1);
  const cov = pairs.reduce((a, p) => a + (p.rp - meanP) * (p.rb - meanB), 0) / (pairs.length - 1);

  const dailyRf = rfPct / 100 / TRADING_DAYS;
  const beta = varB > 0 ? cov / varB : null;
  const annP = meanP * TRADING_DAYS * 100;
  const annB = meanB * TRADING_DAYS * 100;

  // Jensen's alpha on annualised arithmetic means, same risk-free assumption.
  const alpha = beta === null ? null : annP - (rfPct + beta * (annB - rfPct));

  // Tracking error / IR from the active-return (rp − rb) series.
  const active = pairs.map((p) => p.rp - p.rb);
  const meanActive = mean(active);
  const te = active.length > 1 ? Math.sqrt(active.reduce((a, x) => a + (x - meanActive) ** 2, 0) / (active.length - 1)) : null;

  // Upside/downside capture vs the benchmark.
  const upPairs = pairs.filter((p) => p.rb > 0);
  const downPairs = pairs.filter((p) => p.rb < 0);
  const upCapture = upPairs.length >= 5 && meanB !== undefined
    ? (mean(upPairs.map((p) => p.rp)) / mean(upPairs.map((p) => p.rb))) * 100
    : null;
  const downCapture = downPairs.length >= 5
    ? (mean(downPairs.map((p) => p.rp)) / mean(downPairs.map((p) => p.rb))) * 100
    : null;

  const teAnn = te === null ? null : te * Math.sqrt(TRADING_DAYS) * 100;

  return {
    modelVersion: BENCHMARK_MODEL_VERSION,
    benchmark: { symbol: bench.symbol, name: bench.name },
    provenance: {
      observationCount: pairs.length,
      firstDate: portReturnDates[0] ?? null,
      lastDate: portReturnDates[portReturnDates.length - 1] ?? null,
      dataSource: "YAHOO",
      riskFreeRatePct: rfPct,
      annualisation: "daily returns × √252",
    },
    metrics: {
      benchmarkReturnPctAnn: m(r2(annB), "% ann."),
      portfolioReturnPctAnn: m(r2(annP), "% ann."),
      excessReturnPctAnn: m(r2(annP - annB), "% ann."),
      beta: m(r4(beta), "ratio", beta === null ? "Zero benchmark variance in window" : null),
      alphaPctAnn: m(r2(alpha), "% ann.", alpha === null ? "Beta unavailable — alpha cannot be computed" : null),
      trackingErrorPctAnn: m(r2(teAnn), "% ann.", teAnn === null ? "Need at least 2 paired returns" : null),
      informationRatio: m(teAnn && teAnn > 0 ? r4((annP - annB) / teAnn) : null, "ratio", teAnn && teAnn > 0 ? null : "Tracking error is zero/unavailable"),
      upsideCapturePct: m(r2(upCapture), "%", upCapture === null ? "Fewer than 5 benchmark up-days in window" : null),
      downsideCapturePct: m(r2(downCapture), "%", downCapture === null ? "Fewer than 5 benchmark down-days in window" : null),
    },
  };
}
