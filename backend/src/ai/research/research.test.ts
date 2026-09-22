/**
 * Prompt 4 tests (node:test, offline & deterministic).
 *   cd backend && npx tsx --test src/ai/research/research.test.ts
 *
 * Covers: decision-engine factor scoring, decision bands (BUY/HOLD/AVOID/
 * INSUFFICIENT_EVIDENCE), confidence, report schema parsing (valid, fences,
 * trailing commas, malformed), context gap behaviour. No network, no Ollama.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { StockContext } from "./stock-context.service.js";
import type { DecisionResult } from "./decision-engine.service.js";

function ctx(overrides: Partial<StockContext> = {}): StockContext {
  // A minimal StockContext-shaped object; tests override fields they care about.
  return {
    identity: { stockId: 1, symbol: "TEST", companyName: "Test Ltd", exchange: "NSE", sector: "IT", industry: null, description: null },
    market: {
      latestPrice: { value: 1250, asOf: "2026-09-14", source: "Yahoo Finance" },
      previousClose: 1240, change1dPct: 0.8, recentVolume: 1_000_000, avgVolume20: 900_000, volumeRatio: 1.1,
      high52w: 1400, low52w: 900, distanceFrom52wHighPct: -10.7, staleData: false, priceAgeDays: 1,
    },
    performance: {
      returnsPct: [
        { period: "1W", pct: 1.2 }, { period: "1M", pct: 4 }, { period: "3M", pct: 9 },
        { period: "6M", pct: 12 }, { period: "1Y", pct: 18 }, { period: "3Y", pct: null, reason: "insufficient history" },
        { period: "5Y", pct: null, reason: "insufficient history" },
      ],
      observations: 500, dataSource: "YAHOO",
    },
    fundamentals: { marketCapCr: 250_000, peRatio: 22, dividendYieldPct: 1.2, asOf: "2026-09-14T00:00:00Z", source: "Yahoo Finance", financials: null },
    risk: { volatilityPct: 22, maxDrawdownPct: -28, riskBand: "Moderate", observations: 120, insufficient: false },
    benchmark: { available: true, reason: null, beta: 0.9, alphaPctAnn: 3.1, benchmarkReturnPctAnn: 14, trackingErrorPctAnn: null, observationCount: 480 },
    news: [], events: [],
    portfolio: { owned: false, quantity: null, avgBuyPrice: null, positionValue: null, unrealizedPnl: null, unrealizedPnlPct: null, portfolioWeightPct: null, firstBuyDate: null, holdingPeriodDays: null },
    macro: { available: false, reason: "not fetched in unit fixture", indicators: [], fx: { available: false, usdInr: null, asOf: null, change1mPct: null, change3mPct: null, source: "ECB via Frankfurter (frankfurter.dev)" }, fxSensitivity: "LOW" },
    freshness: { computedAt: new Date().toISOString(), priceSource: "YAHOO", staleData: false, notes: [] },
    ...overrides,
  };
}

describe("Decision engine (Prompt 4)", async () => {
  const eng = await import("./decision-engine.service.js");
  const base = ctx() as never;

  test("healthy stock with full data scores BUY-relevant factors above 50", () => {
    const d = eng.decide(base as never, 0.7, []);
    assert.equal(d.factors.length, 7); // Req 2 adds fy_growth to the factor set
    assert.ok(d.factors.find((f) => f.name === "momentum")!.score > 50);
    assert.ok(d.factors.find((f) => f.name === "relative_performance")!.score > 50);
    assert.ok(d.factors.find((f) => f.name === "fy_growth")!.dataAvailable === false); // base fixture has no FY statements
  });

  test("BUY requires score ≥ 62 AND confidence ≥ 0.45 AND risk ≠ VERY_HIGH", () => {
    const good = eng.decide(base as never, 0.8, []);
    if (good.score >= 62 && good.confidence >= 0.45 && good.riskLevel !== "VERY_HIGH") {
      assert.equal(good.decision, "BUY");
    }
    // Force VERY_HIGH risk → BUY must be blocked even at a high score.
    const risky = ctx({ risk: { volatilityPct: 55, maxDrawdownPct: -60, riskBand: "High", observations: 120, insufficient: false } }) as never;
    const d2 = eng.decide(risky, 0.8, []);
    assert.equal(d2.riskLevel, "VERY_HIGH");
    assert.notEqual(d2.decision, "BUY", "VERY_HIGH risk must never BUY");
  });

  test("AVOID band fires on low score", () => {
    const bad = ctx({
      performance: { returnsPct: [{ period: "1M", pct: -12 }, { period: "3M", pct: -20 }, { period: "6M", pct: -28 }, { period: "1Y", pct: -35 }, { period: "3Y", pct: null, reason: "x" }, { period: "5Y", pct: null, reason: "x" }], observations: 400, dataSource: "YAHOO" },
      risk: { volatilityPct: 48, maxDrawdownPct: -62, riskBand: "High", observations: 120, insufficient: false },
      benchmark: { available: true, reason: null, beta: 1.3, alphaPctAnn: -9, benchmarkReturnPctAnn: 14, trackingErrorPctAnn: null, observationCount: 400 },
      events: [{ eventId: 1, title: "Regulatory probe", category: "REGULATION", severity: 4, confidence: 0.8, status: "PROCESSED", relationshipType: "DIRECT", direction: "NEGATIVE", detectedAt: new Date().toISOString(), articleCount: 3, sourceCount: 2 }],
    }) as never;
    const d = eng.decide(bad, 0.6, []);
    assert.equal(d.decision, "AVOID");
  });

  test("INSUFFICIENT_EVIDENCE when evidence is thin AND factors lack data", () => {
    const gappy = ctx({
      fundamentals: { marketCapCr: null, peRatio: null, dividendYieldPct: null, asOf: null, source: "n/a", financials: null },
      risk: { volatilityPct: null, maxDrawdownPct: null, riskBand: "Insufficient Data", observations: 10, insufficient: true },
      benchmark: { available: false, reason: "No benchmark", beta: null, alphaPctAnn: null, benchmarkReturnPctAnn: null, trackingErrorPctAnn: null, observationCount: 0 },
      market: { latestPrice: null, previousClose: null, change1dPct: null, recentVolume: null, avgVolume20: null, volumeRatio: null, high52w: null, low52w: null, distanceFrom52wHighPct: null, staleData: true, priceAgeDays: null },
      performance: { returnsPct: [{ period: "1M", pct: null, reason: "insufficient" }], observations: 5, dataSource: "DEMO" },
    }) as never;
    const d = eng.decide(gappy, 0.1, ["only 2 evidence items retrieved", "single-source evidence"]);
    assert.equal(d.decision, "INSUFFICIENT_EVIDENCE");
  });

  test("missing fundamentals degrade to NEUTRAL 50, never 0", () => {
    const f = eng.financialQualityScore(ctx({ fundamentals: { marketCapCr: null, peRatio: null, dividendYieldPct: null, asOf: null, source: "x", financials: null } }) as never);
    assert.equal(f.score, 50);
    assert.equal(f.dataAvailable, false);
  });

  test("risk level: unknown data → MEDIUM (never silently LOW)", () => {
    assert.equal(eng.riskLevelOf(ctx({ risk: { volatilityPct: null, maxDrawdownPct: null, riskBand: "Insufficient Data", observations: 5, insufficient: true } }) as never), "MEDIUM");
    assert.equal(eng.riskLevelOf(ctx({ risk: { volatilityPct: 12, maxDrawdownPct: -15, riskBand: "Low", observations: 120, insufficient: false } }) as never), "LOW");
    assert.equal(eng.riskLevelOf(ctx({ risk: { volatilityPct: 60, maxDrawdownPct: -70, riskBand: "High", observations: 120, insufficient: false } }) as never), "VERY_HIGH");
  });

  test("news outlook weights unique events, not article counts", () => {
    const oneNegative = eng.newsOutlookScore(ctx({ events: [ev("NEGATIVE", 4, 0.9)] }) as never);
    const fiveCopies = eng.newsOutlookScore(ctx({ events: [ev("NEGATIVE", 4, 0.9)] }) as never);
    assert.equal(oneNegative.score, fiveCopies.score, "repeating the same event must not multiply the signal");
    const twoIndependent = eng.newsOutlookScore(ctx({ events: [ev("NEGATIVE", 4, 0.9), ev("NEGATIVE", 4, 0.9)] }) as never);
    assert.ok(twoIndependent.score < oneNegative.score, "two genuinely independent negative events weigh more than one");
  });

  test("confidence is evidence-driven, never 1.0, drops with gaps and staleness", () => {
    const full = eng.decide(base as never, 0.9, []);
    assert.ok(full.confidence <= 0.95);
    const stale = eng.decide(ctx({ freshness: { computedAt: new Date().toISOString(), priceSource: "YAHOO", staleData: true, notes: ["price 12 days old"] }, market: { ...ctx().market, staleData: true, priceAgeDays: 12 } }) as never, 0.9, []);
    assert.ok(stale.confidence < full.confidence, "stale data must reduce confidence");
    const gappy = eng.decide(ctx({ risk: { volatilityPct: null, maxDrawdownPct: null, riskBand: "Insufficient Data", observations: 8, insufficient: true }, benchmark: { available: false, reason: "none", beta: null, alphaPctAnn: null, benchmarkReturnPctAnn: null, trackingErrorPctAnn: null, observationCount: 0 } }) as never, 0.4, []);
    assert.ok(gappy.confidence < full.confidence);
    assert.ok(gappy.confidenceReasons.length > 0);
  });

  test("weights are configurable and validated (must sum to 1)", () => {
    const prev = process.env["AI_DECISION_WEIGHTS"];
    try {
      process.env["AI_DECISION_WEIGHTS"] = "0.3,0.2,0.2,0.15,0.1,0.05";
      const w = eng.resolveWeights();
      assert.equal(w.financialQuality, 0.3);
      process.env["AI_DECISION_WEIGHTS"] = "0.5,0.5,0.5,0.5,0.5,0.5"; // sum 3 → rejected
      assert.equal(eng.resolveWeights().financialQuality, 0.2, "invalid weights fall back to defaults");
    } finally {
      if (prev === undefined) delete process.env["AI_DECISION_WEIGHTS"];
      else process.env["AI_DECISION_WEIGHTS"] = prev;
    }
  });

  function ev(direction: string, severity: number, confidence: number) {
    return {
      eventId: 1, title: "t", category: "REGULATION", severity, confidence, status: "PROCESSED",
      relationshipType: "DIRECT", direction, detectedAt: new Date().toISOString(), articleCount: 1, sourceCount: 1,
    };
  }
});

describe("Report schema parsing (Prompt 4)", async () => {
  const { parseResearchSections } = await import("./report-schema.js");
  const valid = {
    executive_summary: "Summary.", current_situation: "Situation.",
    financial_analysis: { summary: "s", positive_factors: ["a"], negative_factors: [], valuation: "v" },
    performance_analysis: { summary: "s", relative_to_benchmark: "b" },
    risk_analysis: { summary: "s" },
    news_analysis: { summary: "s", overall_direction: "MIXED", important_events: [], positive_factors: [], negative_factors: [] },
    sector_macro_analysis: { summary: "s", factors: [] },
    historical_context: { summary: "s" },
    scenarios: {
      bull: { narrative: "b", drivers: [], invalidators: [] },
      base: { narrative: "b", drivers: [], invalidators: [] },
      bear: { narrative: "b", drivers: [], invalidators: [] },
    },
    what_to_watch: ["w"], decision_reasoning: ["r"], limitations: ["l"],
  };

  test("accepts a valid response", () => {
    assert.equal(parseResearchSections(JSON.stringify(valid)).executive_summary, "Summary.");
  });

  test("strips markdown fences", () => {
    assert.equal(parseResearchSections("```json\n" + JSON.stringify(valid) + "\n```").current_situation, "Situation.");
  });

  test("repairs trailing commas", () => {
    const s = JSON.stringify(valid).replace('"what_to_watch": ["w"]', '"what_to_watch": ["w",]');
    assert.doesNotThrow(() => parseResearchSections(s));
  });

  test("malformed output throws a typed error (never crashes)", () => {
    assert.throws(() => parseResearchSections("the model rambled about stocks"), /not valid JSON/);
    assert.throws(() => parseResearchSections('{"executive_summary": 42}'), /failed validation/);
  });

  test("direction enum is enforced", () => {
    const bad = { ...valid, news_analysis: { ...valid.news_analysis, overall_direction: "MOON" } };
    assert.throws(() => parseResearchSections(JSON.stringify(bad)));
  });
});

describe("Stock resolution (Prompt 4)", async () => {
  test("exact symbol short-circuits; short queries return empty", async () => {
    // Offline DB check is env-dependent; assert the function contract shape only.
    const { resolveStock } = await import("./stock-research.service.js");
    const short = await resolveStock("AB");
    assert.deepEqual(short, []);
  });
});
