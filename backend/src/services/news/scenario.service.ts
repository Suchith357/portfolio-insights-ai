/**
 * Scenario / stress engine (Intelligence Engine, Phase 5B).
 *
 * WHAT-IF analysis only — never a prediction. Every result carries the
 * disclaimer. Deterministic arithmetic over the user's OWN holdings and
 * stored prices:
 *
 *  - Direct stock shock:  Δportfolio = weight × shock  (LABELLED
 *    "DIRECT SHOCK ESTIMATE" — second-order effects are not modelled).
 *  - Market shock: every holding shocked equally (an equal-weight market
 *    proxy; the DB has no benchmark series, so beta-based scaling is not
 *    claimed).
 *  - Sector shock: all holdings in the affected sector shocked together.
 *  - Position add/remove/rebalance: recompute weights, then recompute
 *    concentration + covariance-based volatility delta on the same
 *    aligned-return matrices.
 *  - Input validation: finite numbers only, shock ∈ [-100, +500]%,
 *    amounts ∈ (0, 1e9], stock/sector must exist, portfolio ownership is
 *    verified by the CALLER before invocation.
 */
import { prisma } from "../../utils/prisma.js";
import { loadAlignedSeries, TRADING_DAYS_UNSAFE } from "./quantitative-risk.service.js";

const DISCLAIMER =
  "Scenario analysis is hypothetical and does not predict future returns. Direct-shock estimates ignore second-order effects.";

/* ------------------------------- validation -------------------------------- */

export class ScenarioValidationError extends Error {}

function assertFinite(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ScenarioValidationError(`${name} must be a finite number.`);
  return n;
}

function assertShockPct(value: unknown, name = "shockPct"): number {
  const n = assertFinite(value, name);
  if (n < -100 || n > 500) throw new ScenarioValidationError(`${name} must be between -100% and +500%.`);
  return n;
}

function assertAmount(value: unknown, name = "amount"): number {
  const n = assertFinite(value, name);
  if (n <= 0 || n > 1_000_000_000) throw new ScenarioValidationError(`${name} must be between 0 and 1,000,000,000.`);
  return n;
}

/* ------------------------------ shared helpers ------------------------------ */

interface HoldingRow {
  stock_id: number;
  symbol: string;
  sector: string;
  quantity: number;
}

async function loadHoldings(portfolioId: number): Promise<HoldingRow[]> {
  const rows = await prisma.holdings.findMany({
    where: { portfolio_id: portfolioId },
    select: { stock_id: true, quantity: true, stocks: { select: { symbol: true, sector: true } } },
    orderBy: { stock_id: "asc" },
  });
  return rows.map((r) => ({
    stock_id: r.stock_id,
    symbol: r.stocks.symbol,
    sector: r.stocks.sector,
    // Decimal → number for arithmetic; holdings are finite 4-dp values.
    quantity: Number(r.quantity),
  }));
}

function latestClosesFrom(bundle: { closes: number[][]; symbols: string[] }): Map<number, number> {
  const out = new Map<number, number>();
  bundle.symbols.forEach((sid, i) => {
    const series = bundle.closes[i];
    if (series && series.length > 0) out.set(Number(sid), series[series.length - 1]!);
  });
  return out;
}

function weightsFrom(holdings: HoldingRow[], prices: Map<number, number>): Map<number, number> {
  let total = 0;
  const values = holdings.map((h) => {
    const v = h.quantity * (prices.get(h.stock_id) ?? 0);
    total += v;
    return v;
  });
  const out = new Map<number, number>();
  holdings.forEach((h, i) => out.set(h.stock_id, total > 0 ? values[i]! / total : 0));
  return out;
}

/** Covariance-based annualised volatility for an arbitrary weight vector. */
async function portfolioVolatility(stockIds: number[], weights: Map<number, number>): Promise<number | null> {
  const bundle = await loadAlignedSeries(stockIds);
  const t = bundle.returns[0]?.length ?? 0;
  if (t < 30) return null;
  const idx = new Map(bundle.symbols.map((s, i) => [Number(s), i]));
  const n = stockIds.length;
  // Column means / covariance over aligned returns.
  const cols = stockIds.map((id) => bundle.returns[idx.get(id)!] ?? []);
  const means = cols.map((c) => c.reduce((a, b) => a + b, 0) / Math.max(1, c.length));
  const cov: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const a = cols[i]!;
      const b = cols[j]!;
      const tt = Math.min(a.length, b.length);
      let s = 0;
      for (let k = 1; k <= tt; k++) {
        s += (a[a.length - k]! - means[i]!) * (b[b.length - k]! - means[j]!);
      }
      const c = tt > 1 ? s / (tt - 1) : 0;
      cov[i]![j] = c;
      cov[j]![i] = c;
    }
  }
  const w = stockIds.map((id) => weights.get(id) ?? 0);
  let variance = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) variance += w[i]! * cov[i]![j]! * w[j]!;
  }
  const daily = Math.sqrt(Math.max(0, variance));
  return Number((daily * Math.sqrt(TRADING_DAYS_UNSAFE) * 100).toFixed(4));
}

function hhiOf(weights: Map<number, number>): number {
  let sum = 0;
  for (const w of weights.values()) sum += w;
  if (sum <= 0) return 0;
  let hhi = 0;
  for (const w of weights.values()) hhi += (w / sum) ** 2;
  return hhi;
}

/* -------------------------------- shock types ------------------------------- */

export interface ShockInput {
  stockId?: number;
  sector?: string;
  shockPct: number;
}

export interface ScenarioImpact {
  baselineValue: number;
  scenarioValue: number;
  valueDelta: number;
  portfolioImpactPct: number;
  /** Largest affected position lines for the UI. */
  lines: Array<{ symbol: string; weightPct: number; shockPct: number; contributionPctPoints: number }>;
  bySector: Array<{ sector: string; weightPct: number; contributionPctPoints: number }>;
}

/**
 * Direct shock engine: portfolio impact = Σ weight × shock over shocked
 * positions. Current quantities and stored latest closes only.
 */
export async function applyShocks(portfolioId: number, shocks: ShockInput[]): Promise<{ impact: ScenarioImpact; disclaimer: string; pricedAsOf: string | null }> {
  if (!Array.isArray(shocks) || shocks.length === 0) throw new ScenarioValidationError("At least one shock is required.");
  if (shocks.length > 50) throw new ScenarioValidationError("Too many shocks (max 50).");

  const holdings = await loadHoldings(portfolioId);
  if (holdings.length === 0) throw new ScenarioValidationError("This portfolio has no holdings to shock.");

  const normalized = shocks.map((s) => ({
    stockId: s.stockId === undefined || s.stockId === null ? undefined : assertFinite(s.stockId, "stockId"),
    sector: typeof s.sector === "string" ? s.sector.trim().toLowerCase() : undefined,
    shockPct: assertShockPct(s.shockPct),
  }));
  for (const s of normalized) {
    if (s.stockId === undefined && !s.sector) throw new ScenarioValidationError("Each shock needs a stockId or a sector.");
    if (s.stockId !== undefined && !holdings.some((h) => h.stock_id === s.stockId)) {
      throw new ScenarioValidationError(`stockId ${s.stockId} is not held in this portfolio.`);
    }
    if (s.sector !== undefined && !holdings.some((h) => h.sector.toLowerCase() === s.sector)) {
      throw new ScenarioValidationError(`No holdings in sector "${s.sector}".`);
    }
  }

  const bundle = await loadAlignedSeries(holdings.map((h) => h.stock_id), 5);
  const prices = latestClosesFrom(bundle);
  const weights = weightsFrom(holdings, prices);
  const baselineValue = holdings.reduce((a, h) => a + h.quantity * (prices.get(h.stock_id) ?? 0), 0);

  let shockedValue = 0;
  const lines: ScenarioImpact["lines"] = [];
  const sectorAgg = new Map<string, { weightPct: number; contribution: number }>();
  for (const h of holdings) {
    const w = weights.get(h.stock_id) ?? 0;
    const shock = normalized.find((s) => (s.stockId !== undefined && s.stockId === h.stock_id) || (s.sector !== undefined && s.sector === h.sector.toLowerCase()));
    const pct = shock ? shock.shockPct / 100 : 0;
    const newValue = h.quantity * (prices.get(h.stock_id) ?? 0) * (1 + pct);
    shockedValue += newValue;
    const contribution = w * shockPctOf(shock) ;
    if (shock) {
      lines.push({
        symbol: h.symbol,
        weightPct: Number((w * 100).toFixed(2)),
        shockPct: shock.shockPct,
        contributionPctPoints: Number((contribution * 100).toFixed(2)),
      });
      const key = h.sector;
      const agg = sectorAgg.get(key) ?? { weightPct: 0, contribution: 0 };
      agg.weightPct += w * 100;
      agg.contribution += contribution * 100;
      sectorAgg.set(key, agg);
    }
  }

  const impact: ScenarioImpact = {
    baselineValue: Number(baselineValue.toFixed(2)),
    scenarioValue: Number(shockedValue.toFixed(2)),
    valueDelta: Number((shockedValue - baselineValue).toFixed(2)),
    portfolioImpactPct: baselineValue > 0 ? Number((((shockedValue - baselineValue) / baselineValue) * 100).toFixed(2)) : 0,
    lines: lines.sort((a, b) => Math.abs(b.contributionPctPoints) - Math.abs(a.contributionPctPoints)),
    bySector: [...sectorAgg.entries()].map(([sector, v]) => ({ sector, weightPct: Number(v.weightPct.toFixed(2)), contributionPctPoints: Number(v.contribution.toFixed(2)) })),
  };
  const asOf = bundle.latestDate;
  return { impact, disclaimer: DISCLAIMER, pricedAsOf: asOf };
}

function shockPctOf(shock: { shockPct: number } | undefined): number {
  return shock ? shock.shockPct / 100 : 0;
}

/* ------------------------------ portfolio what-if --------------------------- */

export type WhatIfKind = "ADD_POSITION" | "REMOVE_POSITION" | "REBALANCE";

export interface WhatIfResult {
  kind: WhatIfKind;
  baseline: {
    totalValue: number;
    concentration: { largestPct: number; top3Pct: number; hhi: number; effectiveN: number };
    volatilityPctAnn: number | null;
  };
  scenario: {
    totalValue: number;
    concentration: { largestPct: number; top3Pct: number; hhi: number; effectiveN: number };
    volatilityPctAnn: number | null;
    newOrChangedPosition: { symbol: string; quantity: number; weightPct: number } | null;
  };
  deltas: {
    valueDelta: number;
    hhiDelta: number;
    effectiveNDelta: number;
    largestWeightDeltaPct: number;
    volatilityDeltaPct: number | null;
  };
  sectorShift: Array<{ sector: string; beforePct: number; afterPct: number }>;
  assumptions: string[];
  disclaimer: string;
  pricedAsOf: string | null;
}

/** Concentration block from a weights map. */
function concOf(weights: Map<number, number>): { largestPct: number; top3Pct: number; hhi: number; effectiveN: number } {
  const arr = [...weights.values()].sort((a, b) => b - a);
  const hhi = arr.reduce((a, w) => a + w * w, 0);
  return {
    largestPct: Number(((arr[0] ?? 0) * 100).toFixed(2)),
    top3Pct: Number((arr.slice(0, 3).reduce((a, b) => a + b, 0) * 100).toFixed(2)),
    hhi: Number(hhi.toFixed(4)),
    effectiveN: hhi > 0 ? Number((1 / hhi).toFixed(2)) : 0,
  };
}

/** Sector weights from holdings + a weights map. */
function sectorWeights(holdings: HoldingRow[], weights: Map<number, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const h of holdings) {
    out.set(h.sector, (out.get(h.sector) ?? 0) + (weights.get(h.stock_id) ?? 0));
  }
  return out;
}

/**
 * Portfolio what-if: add ₹X of a stock (at its latest stored close),
 * remove an existing position, or rebalance one holding to a target weight
 * (cash-neutral across remaining holdings).
 */
export async function runWhatIf(
  portfolioId: number,
  input:
    | { kind: "ADD_POSITION"; stockId: number; amount: number }
    | { kind: "REMOVE_POSITION"; stockId: number }
    | { kind: "REBALANCE"; stockId: number; targetWeightPct: number },
): Promise<WhatIfResult> {
  const holdings = await loadHoldings(portfolioId);
  if (holdings.length === 0) throw new ScenarioValidationError("This portfolio has no holdings.");

  const bundle = await loadAlignedSeries(holdings.map((h) => h.stock_id), 5);
  const prices = latestClosesFrom(bundle);
  const baselineWeights = weightsFrom(holdings, prices);
  const baselineValue = holdings.reduce((a, h) => a + h.quantity * (prices.get(h.stock_id) ?? 0), 0);

  let scenarioHoldings = holdings.map((h) => ({ ...h }));
  let scenarioValue = baselineValue;
  const assumptions: string[] = ["Executed at the latest stored close; no slippage, taxes or fees are modelled."];

  if (input.kind === "ADD_POSITION") {
    const amount = assertAmount(input.amount);
    const price = prices.get(assertFinite(input.stockId, "stockId"));
    if (price === undefined) throw new ScenarioValidationError("Stock has no usable stored price.");
    const qty = amount / price;
    const existing = scenarioHoldings.find((h) => h.stock_id === input.stockId);
    if (existing) existing.quantity += qty;
    else scenarioHoldings.push({ stock_id: input.stockId, symbol: (await symbolFor(input.stockId)) ?? `#${input.stockId}`, sector: (await sectorFor(input.stockId)) ?? "Unknown", quantity: qty });
    assumptions.push(`₹${amount.toLocaleString("en-IN")} buys ${qty.toFixed(4)} units at ₹${price.toFixed(2)} (latest stored close).`);
    assumptions.push("If the stock is new to the portfolio, historical risk figures treat it as held over the full window (buy-and-hold simplification).");
  } else if (input.kind === "REMOVE_POSITION") {
    const sid = assertFinite(input.stockId, "stockId");
    if (!scenarioHoldings.some((h) => h.stock_id === sid)) throw new ScenarioValidationError("That stock is not held.");
    scenarioHoldings = scenarioHoldings.filter((h) => h.stock_id !== sid);
    if (scenarioHoldings.length === 0) throw new ScenarioValidationError("Cannot remove the only holding.");
    assumptions.push("Full position removed; proceeds are not reinvested (weights dilute to cash-neutral automatically).");
  } else {
    const sid = assertFinite(input.stockId, "stockId");
    const target = assertFinite(input.targetWeightPct, "targetWeightPct");
    if (target < 0 || target > 100) throw new ScenarioValidationError("targetWeightPct must be between 0 and 100.");
    if (!scenarioHoldings.some((h) => h.stock_id === sid)) throw new ScenarioValidationError("That stock is not held.");
    const targetW = target / 100;
    // Set target weight; scale every other holding proportionally so the
    // total stays 100% (cash-neutral rebalance).
    const otherBefore = [...baselineWeights.entries()].filter(([id]) => id !== sid).reduce((a, [, w]) => a + w, 0);
    for (const h of scenarioHoldings) {
      if (h.stock_id === sid) continue;
      const wBefore = baselineWeights.get(h.stock_id) ?? 0;
      const scale = otherBefore > 0 ? (1 - targetW) / otherBefore : 0;
      h.quantity = h.quantity * scale;
    }
    assumptions.push(`Rebalanced to ${target}% weight; all other positions scaled proportionally (cash-neutral).`);
  }

  const scenarioBundle = await loadAlignedSeries(scenarioHoldings.map((h) => h.stock_id), 5);
  const scenarioPrices = latestClosesFrom(scenarioBundle);
  const scenarioWeights = weightsFrom(scenarioHoldings, scenarioPrices);
  scenarioValue = scenarioHoldings.reduce((a, h) => a + h.quantity * (scenarioPrices.get(h.stock_id) ?? 0), 0);

  const [baseVol, scenVol] = await Promise.all([
    portfolioVolatility(holdings.map((h) => h.stock_id), baselineWeights),
    portfolioVolatility(scenarioHoldings.map((h) => h.stock_id), scenarioWeights),
  ]);

  const changed = scenarioHoldings.find((h) => {
    const before = holdings.find((b) => b.stock_id === h.stock_id);
    return !before || Math.abs(before.quantity - h.quantity) > 1e-9;
  });

  const baseSec = sectorWeights(holdings, baselineWeights);
  const scenSec = sectorWeights(scenarioHoldings, scenarioWeights);
  const sectorShift = [...new Set([...baseSec.keys(), ...scenSec.keys()])].map((s) => ({
    sector: s,
    beforePct: Number(((baseSec.get(s) ?? 0) * 100).toFixed(2)),
    afterPct: Number(((scenSec.get(s) ?? 0) * 100).toFixed(2)),
  }));

  const baseConc = concOf(baselineWeights);
  const scenConc = concOf(scenarioWeights);

  return {
    kind: input.kind,
    baseline: { totalValue: Number(baselineValue.toFixed(2)), concentration: baseConc, volatilityPctAnn: baseVol },
    scenario: {
      totalValue: Number(scenarioValue.toFixed(2)),
      concentration: scenConc,
      volatilityPctAnn: scenVol,
      newOrChangedPosition: changed
        ? {
            symbol: changed.symbol,
            quantity: Number(changed.quantity.toFixed(4)),
            weightPct: Number(((scenarioWeights.get(changed.stock_id) ?? 0) * 100).toFixed(2)),
          }
        : null,
    },
    deltas: {
      valueDelta: Number((scenarioValue - baselineValue).toFixed(2)),
      hhiDelta: Number((scenConc.hhi - baseConc.hhi).toFixed(4)),
      effectiveNDelta: Number((scenConc.effectiveN - baseConc.effectiveN).toFixed(2)),
      largestWeightDeltaPct: Number((scenConc.largestPct - baseConc.largestPct).toFixed(2)),
      volatilityDeltaPct: baseVol !== null && scenVol !== null ? Number((scenVol - baseVol).toFixed(2)) : null,
    },
    sectorShift,
    assumptions,
    disclaimer: DISCLAIMER,
    pricedAsOf: scenarioBundle.latestDate,
  };
}

async function symbolFor(stockId: number): Promise<string | null> {
  const s = await prisma.stocks.findUnique({ where: { stock_id: stockId }, select: { symbol: true } });
  return s?.symbol ?? null;
}

async function sectorFor(stockId: number): Promise<string | null> {
  const s = await prisma.stocks.findUnique({ where: { stock_id: stockId }, select: { sector: true } });
  return s?.sector ?? null;
}

/* ------------------------------ predefined stress --------------------------- */

export interface StressRun {
  name: string;
  description: string;
  impact: ScenarioImpact;
}

/** Predefined stress suite for one portfolio. */
export async function runStressSuite(portfolioId: number): Promise<{ runs: StressRun[]; disclaimer: string }> {
  const holdings = await loadHoldings(portfolioId);
  if (holdings.length === 0) throw new ScenarioValidationError("This portfolio has no holdings.");
  // Rank "largest" by MARKET VALUE (quantity × latest stored close), not by row
  // order — a small-quantity high-price stock can dominate a portfolio.
  const bundle = await loadAlignedSeries(holdings.map((h) => h.stock_id));
  const prices = latestClosesFrom(bundle);
  const valueOf = (h: HoldingRow) => h.quantity * (prices.get(h.stock_id) ?? 0);
  const valued = holdings.filter((h) => valueOf(h) > 0);
  if (valued.length === 0) throw new ScenarioValidationError("No priced holdings available for stress tests.");
  const largest = valued.reduce((top, h) => (valueOf(h) > valueOf(top) ? h : top), valued[0]!);
  const sectorValue = new Map<string, number>();
  for (const h of valued) sectorValue.set(h.sector, (sectorValue.get(h.sector) ?? 0) + valueOf(h));
  const biggestSector = [...sectorValue.entries()].sort((a, b) => b[1] - a[1])[0]![0];

  const defs: Array<{ name: string; description: string; shocks: ShockInput[] }> = [
    { name: "MARKET_CRASH_10", description: "Every holding −10% (equal-weight market proxy).", shocks: holdings.map((h) => ({ stockId: h.stock_id, shockPct: -10 })) },
    { name: "MARKET_CRASH_20", description: "Every holding −20%.", shocks: holdings.map((h) => ({ stockId: h.stock_id, shockPct: -20 })) },
    { name: "MARKET_CRASH_30", description: "Every holding −30%.", shocks: holdings.map((h) => ({ stockId: h.stock_id, shockPct: -30 })) },
    { name: "SECTOR_SHOCK_20", description: `All ${biggestSector} holdings −20%.`, shocks: [{ sector: biggestSector, shockPct: -20 }] },
    { name: "LARGEST_HOLDING_20", description: `Largest holding (${largest.symbol}) −20%.`, shocks: [{ stockId: largest.stock_id, shockPct: -20 }] },
  ];

  const runs: StressRun[] = [];
  for (const d of defs) {
    const { impact } = await applyShocks(portfolioId, d.shocks);
    runs.push({ name: d.name, description: d.description, impact });
  }
  return { runs, disclaimer: DISCLAIMER };
}

/* -------------------------------- comparison -------------------------------- */

export interface ScenarioComparison {
  baselineLabel: string;
  scenarios: Array<{ label: string; impactPct: number; valueAfter: number }>;
  current: { value: number; hhi: number | null; volatilityPctAnn: number | null };
  disclaimer: string;
}

/** Compare 2–3 shock scenarios + the untouched portfolio. */
export async function compareScenarios(portfolioId: number, scenarioShocks: Array<{ label: string; shocks: ShockInput[] }>): Promise<ScenarioComparison> {
  if (scenarioShocks.length < 2 || scenarioShocks.length > 3) {
    throw new ScenarioValidationError("Provide between 2 and 3 scenarios to compare.");
  }
  const holdings = await loadHoldings(portfolioId);
  if (holdings.length === 0) throw new ScenarioValidationError("This portfolio has no holdings.");
  const bundle = await loadAlignedSeries(holdings.map((h) => h.stock_id), 5);
  const prices = latestClosesFrom(bundle);
  const weights = weightsFrom(holdings, prices);
  const currentValue = holdings.reduce((a, h) => a + h.quantity * (prices.get(h.stock_id) ?? 0), 0);
  const currentVol = await portfolioVolatility(holdings.map((h) => h.stock_id), weights);

  const scenarios: ScenarioComparison["scenarios"] = [];
  for (const s of scenarioShocks) {
    const { impact } = await applyShocks(portfolioId, s.shocks);
    scenarios.push({ label: s.label.slice(0, 60), impactPct: impact.portfolioImpactPct, valueAfter: impact.scenarioValue });
  }
  return {
    baselineLabel: "Current portfolio",
    scenarios,
    current: { value: Number(currentValue.toFixed(2)), hhi: Number(hhiOf(weights).toFixed(4)), volatilityPctAnn: currentVol },
    disclaimer: DISCLAIMER,
  };
}
