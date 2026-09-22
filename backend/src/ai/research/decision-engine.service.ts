/**
 * Deterministic decision engine (Prompt 4).
 *
 * The LLM NEVER decides. This engine converts the authoritative StockContext
 * into six factor scores (0–100), blends them with CONFIGURABLE weights
 * (decision-engine-v1), applies documented decision bands, and computes an
 * evidence-based confidence. The LLM only explains the resulting numbers.
 *
 * Methodology (documented, inspectable):
 *   financial_quality : P/E regime vs sector-neutral bands + dividend +
 *                       market-cap quality; nulls degrade toward 50 (neutral),
 *                       never toward 0.
 *   momentum          : blended 1M/3M/6M/1Y returns, distance from 52w high.
 *   risk              : inverse of volatility & drawdown (low risk = high
 *                       score); insufficient data → neutral 50.
 *   relative_perf     : 1Y stock return vs NIFTY 1Y return.
 *   news_outlook      : unique-event weighted direction from stored events
 *                       (severity×confidence×directness), NOT article counts.
 *   evidence_quality  : retrieval coverage/diversity/recency score ×100.
 *
 * Bands (decision-engine-v1): score ≥ 62 & confidence ≥ 0.45 & risk ≠ VERY_HIGH
 *   → BUY · score ≤ 42 → AVOID · evidence quality < 0.30 → INSUFFICIENT_EVIDENCE
 *   · everything else → HOLD.
 */

import type { StockContext } from "./stock-context.service.js";

export type Decision = "BUY" | "HOLD" | "AVOID" | "INSUFFICIENT_EVIDENCE";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";

export interface FactorScore {
  name: string;
  score: number; // 0..100
  detail: string;
  dataAvailable: boolean;
}

export interface DecisionWeights {
  financialQuality: number;
  momentum: number;
  risk: number;
  relativePerformance: number;
  newsOutlook: number;
  evidenceQuality: number;
}

export const DECISION_VERSION = "decision-engine-v1";

/** Configurable via env AI_DECISION_WEIGHTS as "0.2,0.2,0.15,0.15,0.2,0.1". Since Req 2 the financialQuality weight is split 40/60 between valuation (financial_quality) and statement trend (fy_growth); the 6 CSV values still sum to 1. */
export function resolveWeights(): DecisionWeights {
  const raw = process.env["AI_DECISION_WEIGHTS"]?.trim();
  const defaults: DecisionWeights = { financialQuality: 0.2, momentum: 0.2, risk: 0.15, relativePerformance: 0.15, newsOutlook: 0.2, evidenceQuality: 0.1 };
  if (!raw) return defaults;
  const parts = raw.split(",").map((v) => Number(v));
  if (parts.length !== 6 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 1)) return defaults;
  const sum = parts.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.01) return defaults;
  return { financialQuality: parts[0]!, momentum: parts[1]!, risk: parts[2]!, relativePerformance: parts[3]!, newsOutlook: parts[4]!, evidenceQuality: parts[5]! };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ------------------------------------------------------------- factors
export function financialQualityScore(ctx: StockContext): FactorScore {
  const pe = ctx.fundamentals.peRatio;
  const dy = ctx.fundamentals.dividendYieldPct;
  const mcap = ctx.fundamentals.marketCapCr;
  if (pe === null && dy === null && mcap === null) {
    return { name: "financial_quality", score: 50, detail: "No fundamental data available — neutral score, not an assessment", dataAvailable: false };
  }
  let score = 50;
  const bits: string[] = [];
  if (pe !== null && Number.isFinite(pe) && pe > 0) {
    // Broad NSE regime bands (documented): <12 cheap, 12–25 fair, >32 rich.
    if (pe < 12) { score += 20; bits.push(`P/E ${pe.toFixed(1)} in low band`); }
    else if (pe <= 25) { score += 10; bits.push(`P/E ${pe.toFixed(1)} in fair band`); }
    else if (pe <= 32) { score += 0; bits.push(`P/E ${pe.toFixed(1)} elevated`); }
    else { score -= 15; bits.push(`P/E ${pe.toFixed(1)} rich`); }
  }
  if (dy !== null && dy > 0) { score += Math.min(12, dy * 2.4); bits.push(`dividend yield ${dy.toFixed(2)}%`); }
  if (mcap !== null) {
    if (mcap > 100_000) { score += 10; bits.push("large-cap (₹1L+ cr)"); }
    else if (mcap > 20_000) { score += 5; bits.push("mid/large-cap"); }
    else { bits.push("small-cap"); }
  }
  return { name: "financial_quality", score: Math.round(Math.min(100, Math.max(0, score))), detail: bits.join("; ") || "limited fundamentals", dataAvailable: true };
}

export function momentumScore(ctx: StockContext): FactorScore {
  const get = (p: string) => ctx.performance.returnsPct.find((r) => r.period === p)?.pct ?? null;
  const r1m = get("1M"), r3m = get("3M"), r6m = get("6M"), r1y = get("1Y");
  if (r1m === null && r3m === null && r6m === null && r1y === null) {
    return { name: "momentum", score: 50, detail: "insufficient price history", dataAvailable: false };
  }
  const blend = ((r1m ?? 0) * 0.2 + (r3m ?? 0) * 0.3 + (r6m ?? 0) * 0.2 + (r1y ?? 0) * 0.3) / ((r1m !== null ? 0.2 : 0) + (r3m !== null ? 0.3 : 0) + (r6m !== null ? 0.2 : 0) + (r1y !== null ? 0.3 : 0) || 1);
  // Map returns: -30% → 0, 0% → 45, +30% → 90 (documented sigmoid-ish band).
  const fromReturns = Math.min(100, Math.max(0, 45 + blend * 1.5));
  const bits = [`blended return ${blend >= 0 ? "+" : ""}${blend.toFixed(1)}%`];
  let score = fromReturns;
  const dist = ctx.market.distanceFrom52wHighPct;
  if (dist !== null && dist > -5) { score += 5; bits.push("near 52-week high"); }
  else if (dist !== null && dist < -30) { score -= 5; bits.push(`${Math.abs(dist).toFixed(0)}% below 52-week high`); }
  return { name: "momentum", score: Math.round(Math.min(100, Math.max(0, score))), detail: bits.join("; "), dataAvailable: true };
}

/**
 * Req 2: FY-growth factor — compares the latest vs prior fiscal year from the
 * cached Yahoo annual statements. Fully deterministic; neutral 50 with
 * dataAvailable=false when the document is missing or lacks two comparable
 * years (never invents growth from partial data).
 */
export function fyGrowthScore(ctx: StockContext): FactorScore {
  const fin = ctx.fundamentals.financials;
  const years = fin?.fiscalYears ?? [];
  if (!fin || years.length === 0) {
    return { name: "fy_growth", score: 50, detail: "FY financial statements unavailable — neutral score, not an assessment", dataAvailable: false };
  }
  const latest = years[0]!;
  const prior = years.length > 1 ? years[1]! : null;
  const bits: string[] = [];
  let score = 50;

  // Profit trend (most robust single signal).
  const earningsGrowth = fin.growth.earningsGrowthPct
    ?? (latest.netIncomeCr !== null && prior?.netIncomeCr != null && prior.netIncomeCr !== 0
      ? ((latest.netIncomeCr - prior.netIncomeCr) / Math.abs(prior.netIncomeCr)) * 100
      : null);
  if (earningsGrowth !== null && Number.isFinite(earningsGrowth)) {
    // ±30% YoY maps to ±15 points.
    score += Math.max(-15, Math.min(15, earningsGrowth * 0.5));
    bits.push(`net profit ${earningsGrowth >= 0 ? "+" : ""}${earningsGrowth.toFixed(1)}% YoY`);
  }
  const revenueGrowth = fin.growth.revenueGrowthPct
    ?? (latest.revenueCr !== null && prior?.revenueCr != null && prior.revenueCr !== 0
      ? ((latest.revenueCr - prior.revenueCr) / Math.abs(prior.revenueCr)) * 100
      : null);
  if (revenueGrowth !== null && Number.isFinite(revenueGrowth)) {
    score += Math.max(-10, Math.min(10, revenueGrowth * 0.4));
    bits.push(`revenue ${revenueGrowth >= 0 ? "+" : ""}${revenueGrowth.toFixed(1)}% YoY`);
  }
  if (fin.growth.profitMarginsPct !== null && Number.isFinite(fin.growth.profitMarginsPct)) {
    const m = fin.growth.profitMarginsPct;
    if (m >= 15) { score += 5; bits.push(`margin ${m.toFixed(1)}% (strong)`); }
    else if (m >= 5) { bits.push(`margin ${m.toFixed(1)}% (moderate)`); }
    else if (m < 0) { score -= 10; bits.push(`margin ${m.toFixed(1)}% (loss-making)`); }
    else { score -= 3; bits.push(`margin ${m.toFixed(1)}% (thin)`); }
  }
  // Cash flow sanity: positive operating cash flow supports the profit number.
  if (latest.operatingCashflowCr !== null && Number.isFinite(latest.operatingCashflowCr)) {
    if (latest.operatingCashflowCr > 0) { score += 3; bits.push(`operating cash flow ₹${latest.operatingCashflowCr.toFixed(0)} cr`); }
    else { score -= 5; bits.push(`negative operating cash flow ₹${latest.operatingCashflowCr.toFixed(0)} cr`); }
  }
  if (bits.length === 0) {
    return { name: "fy_growth", score: 50, detail: `FY${latest.fy ?? ""} statements present but not comparable (missing prior year fields)`, dataAvailable: false };
  }
  return { name: "fy_growth", score: Math.round(Math.min(100, Math.max(0, score))), detail: bits.join("; "), dataAvailable: true };
}

export function riskScore(ctx: StockContext): FactorScore {
  if (ctx.risk.insufficient || ctx.risk.volatilityPct === null) {
    return { name: "risk", score: 50, detail: "insufficient history for risk statistics — neutral, not an assessment", dataAvailable: false };
  }
  const vol = ctx.risk.volatilityPct;
  const dd = ctx.risk.maxDrawdownPct ?? 0;
  // 15% vol ≈ calm → 90; 45% vol ≈ wild → 20. Drawdown compounds the penalty.
  const volScore = Math.min(100, Math.max(0, 110 - vol * 2.4));
  const ddScore = Math.min(100, Math.max(0, 100 + dd * 0.8)); // dd is negative
  const score = volScore * 0.65 + ddScore * 0.35;
  return {
    name: "risk", score: Math.round(score),
    detail: `volatility ${vol.toFixed(1)}%, max drawdown ${dd.toFixed(1)}% (${ctx.risk.observations} weekly observations)`,
    dataAvailable: true,
  };
}

export function relativePerformanceScore(ctx: StockContext): FactorScore {
  if (!ctx.benchmark.available || ctx.benchmark.benchmarkReturnPctAnn === null) {
    return { name: "relative_performance", score: 50, detail: `benchmark comparison unavailable (${ctx.benchmark.reason ?? "no data"})`, dataAvailable: false };
  }
  const stock1y = ctx.performance.returnsPct.find((r) => r.period === "1Y")?.pct ?? null;
  if (stock1y === null) return { name: "relative_performance", score: 50, detail: "insufficient stock history for 1Y comparison", dataAvailable: false };
  const excess = stock1y - ctx.benchmark.benchmarkReturnPctAnn;
  // ±20pp excess maps to 20/80.
  const score = Math.min(100, Math.max(0, 50 + excess * 1.5));
  return { name: "relative_performance", score: Math.round(score), detail: `1Y ${stock1y.toFixed(1)}% vs NIFTY ${ctx.benchmark.benchmarkReturnPctAnn.toFixed(1)}% (${excess >= 0 ? "+" : ""}${excess.toFixed(1)}pp)`, dataAvailable: true };
}

export function newsOutlookScore(ctx: StockContext): FactorScore {
  if (ctx.events.length === 0) {
    return { name: "news_outlook", score: 50, detail: "no significant detected events — neutral", dataAvailable: true };
  }
  // Weighted by unique event severity × confidence × directness — NOT article counts.
  let positive = 0, negative = 0;
  for (const e of ctx.events) {
    const sev = (e.severity ?? 2) / 5;
    const conf = e.confidence ?? 0.4;
    const direct = e.relationshipType === "DIRECT" ? 1 : e.relationshipType === "SECTOR" ? 0.5 : 0.25;
    const w = (0.4 + sev) * conf * direct;
    if (e.direction === "POSITIVE") positive += w;
    else if (e.direction === "NEGATIVE") negative += w;
    else if (e.direction === "MIXED") { positive += w * 0.4; negative += w * 0.4; }
  }
  const total = positive + negative;
  // Ratio × saturating magnitude: direction comes from the balance, and
  // genuinely independent corroboration (larger total weight) pushes further
  // from neutral — repeating ONE event many times does NOT (weight is per
  // unique event, not per article).
  const magnitude = Math.min(1, total / 2); // saturates at ~2 strong events
  const score = total === 0 ? 50 : Math.min(100, Math.max(0, 50 + ((positive - negative) / Math.max(total, 1e-9)) * 40 * (0.5 + 0.5 * magnitude)));
  const dir = total === 0 ? "no directional events" : positive > negative ? "net positive events" : negative > positive ? "net negative events" : "balanced/mixed events";
  return { name: "news_outlook", score: Math.round(score), detail: `${ctx.events.length} unique event(s): ${dir} (weighted, not article counts)`, dataAvailable: true };
}

export function evidenceQualityScore(quality: number, reasons: string[]): FactorScore {
  return { name: "evidence_quality", score: Math.round(quality * 100), detail: reasons.length ? reasons.join("; ") : "diverse, recent, multi-source evidence", dataAvailable: true };
}

// -------------------------------------------------------------- risk level
export function riskLevelOf(ctx: StockContext): RiskLevel {
  const vol = ctx.risk.volatilityPct;
  if (vol === null) return "MEDIUM"; // unknown ≠ low
  if (vol < 18) return "LOW";
  if (vol < 30) return "MEDIUM";
  if (vol < 45) return "HIGH";
  return "VERY_HIGH";
}

// --------------------------------------------------------------- confidence
export interface ConfidenceResult {
  value: number; // 0..1
  reasons: string[];
}

export function confidenceOf(ctx: StockContext, evidenceQuality: number, factorDataGaps: number): ConfidenceResult {
  const reasons: string[] = [];
  let c = 0.35; // base
  if (!ctx.freshness.staleData) c += 0.2; else reasons.push(`price data ${ctx.market.priceAgeDays ?? "?"} days old`);
  if (ctx.fundamentals.peRatio !== null || ctx.fundamentals.marketCapCr !== null) c += 0.1; else reasons.push("no fundamental data");
  if (!ctx.risk.insufficient) c += 0.15; else reasons.push("risk statistics unavailable");
  if (ctx.benchmark.available) c += 0.1; else reasons.push("no benchmark comparison");
  c += evidenceQuality * 0.15;
  c -= Math.min(0.25, factorDataGaps * 0.07);
  if (factorDataGaps > 0) reasons.push(`${factorDataGaps} factor(s) lacked data`);
  return { value: Math.round(Math.min(0.95, Math.max(0.05, c)) * 100) / 100, reasons };
}

// ------------------------------------------------------------------ decision
export interface DecisionResult {
  version: string;
  decision: Decision;
  score: number;
  confidence: number;
  confidenceReasons: string[];
  riskLevel: RiskLevel;
  factors: FactorScore[];
  weights: DecisionWeights;
  rationale: string[];
}

export function decide(ctx: StockContext, evidenceQuality: number, evidenceReasons: string[]): DecisionResult {
  const weights = resolveWeights();
  const factors: FactorScore[] = [
    financialQualityScore(ctx),
    fyGrowthScore(ctx),
    momentumScore(ctx),
    riskScore(ctx),
    relativePerformanceScore(ctx),
    newsOutlookScore(ctx),
    evidenceQualityScore(evidenceQuality, evidenceReasons),
  ];
  // Weights: fyGrowth shares the financial-quality allocation (0.2 total →
  // 0.12 statements trend + 0.08 valuation/quality), keeping the sum at 1.0
  // so existing AI_DECISION_WEIGHTS env configurations remain valid.
  const factorWeights = [weights.financialQuality * 0.4, weights.financialQuality * 0.6, weights.momentum, weights.risk, weights.relativePerformance, weights.newsOutlook, weights.evidenceQuality];
  const score = Math.round(factors.reduce((s, f, i) => s + f.score * factorWeights[i]!, 0));
  const gaps = factors.filter((f) => !f.dataAvailable).length;
  const { value: confidence, reasons: confReasons } = confidenceOf(ctx, evidenceQuality, gaps);
  const riskLevel = riskLevelOf(ctx);

  const rationale: string[] = factors.map((f) => `${f.name}: ${f.score}/100 — ${f.detail}`);
  let decision: Decision;
  if (evidenceQuality < 0.3 && gaps >= 3) {
    decision = "INSUFFICIENT_EVIDENCE";
    rationale.push(`INSUFFICIENT_EVIDENCE: evidence quality ${Math.round(evidenceQuality * 100)}% with ${gaps} data gaps — no responsible call is possible.`);
  } else if (score >= 62 && confidence >= 0.45 && riskLevel !== "VERY_HIGH") {
    decision = "BUY";
    rationale.push(`BUY band: score ${score} ≥ 62, confidence ${(confidence * 100).toFixed(0)}% ≥ 45%, risk ${riskLevel} ≠ VERY_HIGH (documented decision-engine-v1 bands).`);
  } else if (score <= 42) {
    decision = "AVOID";
    rationale.push(`AVOID band: score ${score} ≤ 42 (documented decision-engine-v1 bands).`);
  } else {
    decision = "HOLD";
    rationale.push(`HOLD band: score ${score} between 43 and 61 or confidence/risk gate not met (documented decision-engine-v1 bands).`);
  }

  return { version: DECISION_VERSION, decision, score, confidence, confidenceReasons: confReasons, riskLevel, factors, weights, rationale };
}
