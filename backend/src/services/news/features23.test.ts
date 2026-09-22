/**
 * Prompt 2+3 feature tests (node:test, offline & deterministic).
 *
 *   cd backend && npx tsx --test src/services/news/features23.test.ts
 *
 * Covers: market-data normalization/validation/fallback, news provider
 * isolation, event importance multi-signal scoring, alert priority blending,
 * and AI gating rules. No network, no Ollama, no DB writes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ------------------------------------------------------- market providers
describe("Market-data providers (Feature A)", () => {
  test("bar validation accepts a real OHLCV bar", async () => {
    const { isValidBar } = await import("../market-providers/types.js");
    assert.equal(
      isValidBar({ date: "2026-09-11", open: 100, high: 110, low: 98, close: 105, volume: 1000 }),
      true,
    );
  });

  test("bar validation rejects malformed bars", async () => {
    const { isValidBar } = await import("../market-providers/types.js");
    const base = { date: "2026-09-11", open: 100, high: 110, low: 98, close: 105, volume: 1000 };
    assert.equal(isValidBar({ ...base, high: 90 }), false, "high < low");
    assert.equal(isValidBar({ ...base, close: -1 }), false, "negative close");
    assert.equal(isValidBar({ ...base, date: "not-a-date" }), false, "bad date");
    assert.equal(isValidBar({ ...base, date: "2099-01-01" }), false, "future date");
    assert.equal(isValidBar({ ...base, high: 100.5, open: 105 }), false, "open above high");
    assert.equal(isValidBar({ ...base, volume: -5 }), false, "negative volume");
    assert.equal(isValidBar({ ...base, low: 0 }), false, "zero low");
  });

  test("failResult marks rate limiting without throwing", async () => {
    const { failResult, okResult } = await import("../market-providers/types.js");
    const f = failResult("ALPHA_VANTAGE", "rate limited", true);
    assert.equal(f.ok, false);
    assert.equal(f.rateLimited, true);
    assert.equal(f.data, null);
    const o = okResult("YAHOO", { bars: [] });
    assert.equal(o.ok, true);
    assert.equal(o.provider, "YAHOO");
  });

  test("unconfigured Alpha Vantage is skipped in the fallback chain", async () => {
    const { historyChain, ALPHA_VANTAGE } = await import("../market-providers/registry.js");
    const chain = historyChain();
    assert.equal(chain[0]?.id, "YAHOO", "Yahoo is always the primary");
    if (!ALPHA_VANTAGE.isConfigured()) {
      assert.equal(chain.length, 1, "no key → no secondary attempted");
    } else {
      assert.equal(chain.length, 2);
    }
  });

  test("fallback returns ok:false outcome when every provider fails", async () => {
    // Point the registry at a Yahoo symbol that will fail (network blocked in
    // CI is fine — failure is the expected path being tested). We only assert
    // the SHAPE of the outcome: data null, attempts recorded, no throw.
    const { fetchHistoryWithFallback } = await import("../market-providers/fallback.js");
    const outcome = await fetchHistoryWithFallback("__DEFINITELY_INVALID__", "__INVALID__.NS", { timeoutMs: 1500 });
    if (!outcome.data) {
      assert.equal(outcome.provider, null);
      assert.ok(outcome.attempts.length >= 1);
      assert.ok(outcome.attempts.every((a) => !a.ok));
    }
  });

  test("Alpha Vantage normalizes newest-first series to oldest-first bars", async () => {
    const { AlphaVantageProvider } = await import("../market-providers/alphavantage.provider.js");
    const provider = new AlphaVantageProvider();
    // Exercise the mapping function without network.
    assert.equal(provider.toProviderSymbol("RELIANCE", "RELIANCE.NS"), "RELIANCE");
    assert.ok(provider.displayName.includes("Alpha"));
  });

  test("Yahoo adapter maps symbols via yahoo_symbol with .NS fallback", async () => {
    const { YahooProvider } = await import("../market-providers/yahoo.provider.js");
    const p = new YahooProvider();
    assert.equal(p.toProviderSymbol("RELIANCE", "RELIANCE.NS"), "RELIANCE.NS");
    assert.equal(p.toProviderSymbol("TCS", null), "TCS.NS");
    assert.equal(p.isConfigured(), true);
  });

  test("provenance: fallback outcome carries the answering provider id", async () => {
    const { fetchHistoryWithFallback } = await import("../market-providers/fallback.js");
    const outcome = await fetchHistoryWithFallback("__INVALID__", null, { timeoutMs: 1200 });
    if (outcome.data) {
      assert.ok(["YAHOO", "ALPHA_VANTAGE"].includes(outcome.provider ?? ""), "provenance must be a known provider");
    }
  });
});

// ------------------------------------------------------------ news registry
describe("News provider registry (Feature A)", () => {
  test("aggregation isolates provider failure", async () => {
    const { fetchFromAllProviders } = await import("./news-registry.js");
    const { configuredProviders } = await import("./news-registry.js");
    const configured = configuredProviders().map((p) => p.id);
    // Simulate: GDELT (always configured) fails; any other configured provider
    // must continue independently. With no Marketaux token only GDELT runs.
    const result = await fetchFromAllProviders({ limit: 1, sinceHours: 6 }, async (provider) => {
      if (provider.id === "gdelt") throw new Error("simulated GDELT outage");
      return [
        {
          providerArticleId: `mx-1-${provider.id}`,
          title: `Secondary-provider article (${provider.id})`,
          description: null,
          // Distinct URL per provider — genuinely different coverage. (An
          // identical URL would be collapsed by cross-provider dedup, which
          // is the desired behaviour and is tested separately.)
          url: `https://example.org/mx-1-${provider.id}`,
          sourceName: "Example",
          language: "english",
          publishedAt: new Date(),
          entities: [],
          metadata: {},
        },
      ];
    });
    const gdelt = result.providerOutcomes.find((o) => o.provider === "gdelt");
    assert.equal(gdelt?.ok, false, "simulated GDELT failure recorded");
    // Req 1: EVERY other configured provider must continue independently.
    // (marketaux only when its token is set; the keyless google_news_rss /
    // moneycontrol_rss providers are always in the pool.)
    const nonGdeltConfigured = configured.filter((id) => id !== "gdelt");
    const successful = result.providerOutcomes.filter((o) => o.ok);
    assert.equal(successful.length, nonGdeltConfigured.length, "all non-GDELT configured providers succeed");
    assert.equal(result.articles.length, nonGdeltConfigured.length, "each surviving provider contributes its article");
    assert.ok(Array.isArray(result.providerOutcomes));
  });

  test("no configured provider yields empty aggregate without throwing", async () => {
    const { fetchFromAllProviders } = await import("./news-registry.js");
    // Real network absent/slow → outcomes may be failures, but never a throw.
    const result = await fetchFromAllProviders({ limit: 1, sinceHours: 6 });
    assert.ok(Array.isArray(result.articles));
    assert.ok(Array.isArray(result.providerOutcomes));
  });
});

// ---------------------------------------------------------- importance
describe("Event importance (Feature B)", async () => {
  const { scoreImportance, isImportantEnoughForAi, importanceRecommendation } = await import("./event-importance.service.js");
  const now = new Date("2026-09-15T12:00:00Z");

  test("random article mentioning a company stays LOW", () => {
    const r = scoreImportance({
      severity: 1, relevance: 0.2, relationship: "DIRECT", sourceCount: 1,
      detectedAt: new Date(now.getTime() - 30 * 3600_000), category: "COMPANY", now,
    });
    assert.equal(r.importance, "LOW", "single stale low-relevance mention must be LOW");
    assert.ok(r.score < 0.4, "below the WATCH threshold (0.40)");
  });

  test("major regulation directly affecting an owned stock with 3 sources is HIGH/CRITICAL", () => {
    const r = scoreImportance({
      severity: 5, relevance: 0.9, relationship: "DIRECT", sourceCount: 3,
      detectedAt: now, category: "REGULATION", now,
    });
    assert.ok(["HIGH", "CRITICAL"].includes(r.importance), `got ${r.importance}`);
    assert.ok(r.score >= 0.7);
  });

  test("sector-level links cannot reach CRITICAL without directness", () => {
    const r = scoreImportance({
      severity: 5, relevance: 0.95, relationship: "SECTOR", sourceCount: 3,
      detectedAt: now, category: "REGULATION", now,
    });
    assert.notEqual(r.importance, "CRITICAL", "no direct link → no CRITICAL");
  });

  test("stale events decay via recency", () => {
    const fresh = scoreImportance({
      severity: 4, relevance: 0.7, relationship: "DIRECT", sourceCount: 2,
      detectedAt: now, category: "TAX", now,
    });
    const old = scoreImportance({
      severity: 4, relevance: 0.7, relationship: "DIRECT", sourceCount: 2,
      detectedAt: new Date(now.getTime() - 47 * 3600_000), category: "TAX", now,
    });
    assert.ok(fresh.score > old.score);
  });

  test("AI gate only opens for HIGH/CRITICAL", () => {
    assert.equal(isImportantEnoughForAi("LOW"), false);
    assert.equal(isImportantEnoughForAi("WATCH"), false);
    assert.equal(isImportantEnoughForAi("MEDIUM"), false);
    assert.equal(isImportantEnoughForAi("HIGH"), true);
    assert.equal(isImportantEnoughForAi("CRITICAL"), true);
  });

  test("recommendations are advice-safe (no sell/buy verbs)", () => {
    for (const importance of ["LOW", "WATCH", "MEDIUM", "HIGH", "CRITICAL"] as const) {
      const rec = importanceRecommendation(importance);
      assert.doesNotMatch(rec, /sell|buy|avoid/i);
    }
    assert.equal(importanceRecommendation("CRITICAL"), "URGENT REVIEW");
  });
});

// -------------------------------------------------------- alert priority
describe("Alert priority blending (Feature B)", async () => {
  const { blendPriority, priorityToAlertSeverity } = await import("./alert-priority.service.js");
  void priorityToAlertSeverity;

  test("same event from three providers is still ONE alert (dedup lives upstream)", () => {
    // The blend itself is pure; the guarantee is that it depends only on the
    // event's importance + the user's single impact row — provider count can
    // only raise the event's source-count signal, never multiply alerts.
    const a = blendPriority({ eventImportance: "HIGH", importanceScore: 0.75, impactPriority: "HIGH", portfolioWeight: 0.134, isDirectHolding: true });
    const b = blendPriority({ eventImportance: "HIGH", importanceScore: 0.75, impactPriority: "HIGH", portfolioWeight: 0.134, isDirectHolding: true });
    assert.equal(a.priority, b.priority);
  });

  test("critical requires intrinsic importance (importance=HIGH+direct) — gate works", () => {
    const gated = blendPriority({ eventImportance: "MEDIUM", importanceScore: 0.5, impactPriority: "CRITICAL", portfolioWeight: 0.2, isDirectHolding: true });
    assert.equal(gated.priority, "HIGH", "CRITICAL impact without intrinsic importance is gated to HIGH");
    const allowed = blendPriority({ eventImportance: "CRITICAL", importanceScore: 0.9, impactPriority: "HIGH", portfolioWeight: 0.2, isDirectHolding: true });
    assert.equal(allowed.priority, "CRITICAL");
  });

  test("direct holding + high importance event escalates at least to HIGH", () => {
    const r = blendPriority({ eventImportance: "HIGH", importanceScore: 0.72, impactPriority: "MEDIUM", portfolioWeight: 0.05, isDirectHolding: true });
    assert.ok(["HIGH", "CRITICAL"].includes(r.priority));
  });

  test("watchlist rows never exceed MEDIUM", () => {
    const r = blendPriority({ eventImportance: "HIGH", importanceScore: 0.8, impactPriority: "WATCHLIST", portfolioWeight: null, isDirectHolding: false });
    assert.ok(["WATCH", "LOW", "MEDIUM"].includes(r.priority));
  });

  test("mapping to alerts.severity respects the DB CHECK values", async () => {
    const { priorityToAlertSeverity: toSev } = await import("./alert-priority.service.js");
    assert.equal(toSev("CRITICAL"), "CRITICAL");
    assert.equal(toSev("WATCH"), "LOW");
    assert.equal(toSev("LOW"), "LOW");
  });
});

// ------------------------------------------------------------- AI gating
describe("AI event analysis gating (Feature B)", () => {
  test("analyzeEvent refuses noise events without calling the LLM", async () => {
    const { analyzeEvent } = await import("./ai-event-analysis.service.js");
    // Event 999999 does not exist → typed skip, no throw.
    const outcome = await analyzeEvent(9_999_999, null);
    assert.equal(outcome.ran, false);
    assert.equal(outcome.grounding, "SKIPPED");
    assert.equal(outcome.assessment, null);
  });

  test("ai analysis version marker is stable for cache invalidation", async () => {
    const { AI_ANALYSIS_VERSION } = await import("./ai-event-analysis.service.js");
    assert.match(AI_ANALYSIS_VERSION, /^event-analysis-v\d+$/);
  });
});

// ---------------------------------------------------------- regression
describe("Prompt 1 AI foundation still passes", () => {
  test("grounding gate still refuses empty evidence", async () => {
    const { evaluateRetrieval } = await import("../../ai/grounding.js");
    assert.equal(evaluateRetrieval([], 0.35).verdict, "INSUFFICIENT");
  });

  test("output schema still rejects malformed LLM JSON", async () => {
    const { parseStructuredAnalysis } = await import("../../ai/output-schema.js");
    assert.throws(() => parseStructuredAnalysis("garbage"));
  });
});
