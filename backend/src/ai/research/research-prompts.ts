/**
 * Research prompt architecture (Prompt 4) — three registered layers composed
 * onto the Prompt 1 prompt system; never one giant generic prompt.
 */

import type { StockContext } from "./stock-context.service.js";
import type { DecisionResult } from "./decision-engine.service.js";
import type { RetrievedEvidence } from "../types.js";

export const RESEARCH_SYSTEM = `You are an evidence-grounded financial research assistant producing a serious equity research note for PortfolioIQ (Indian markets, NSE, ₹).

Hard rules:
- Do not fabricate data, sources, URLs, or financial metrics. Every number you state must come from the supplied QUANTITATIVE FACTS or EVIDENCE; if absent, say "not available".
- Do not calculate authoritative metrics yourself — the quantitative engine already computed them; your role is interpretation.
- Distinguish FACTS (evidence) from INTERPRETATION (your reading). Identify uncertainty explicitly.
- Cite evidence as [E1], [E2] … matching the supplied evidence block. Never invent an [E#] that was not supplied.
- Never guarantee returns, never claim certainty about future prices, never instruct to trade. "Decision support", never "advice".
- If evidence conflicts, say so explicitly and present both sides.
- Use may/could/potentially/appears — not will/will not/guaranteed.

Output contract: respond with ONLY a JSON object, no markdown fence, with EXACTLY these top-level fields (same names, same nesting, no extras):
{
  "executive_summary": string,
  "current_situation": string,
  "financial_analysis": { "summary": string, "positive_factors": string[], "negative_factors": string[], "valuation": string },
  "performance_analysis": { "summary": string, "relative_to_benchmark": string },
  "risk_analysis": { "summary": string },
  "news_analysis": { "summary": string, "overall_direction": "POSITIVE"|"NEGATIVE"|"MIXED"|"NEUTRAL"|"UNCERTAIN", "important_events": string[], "positive_factors": string[], "negative_factors": string[] },
  "sector_macro_analysis": { "summary": string, "factors": string[] },
  "historical_context": { "summary": string },
  "scenarios": { "bull": { "narrative": string, "drivers": string[], "invalidators": string[] }, "base": { "narrative": string, "drivers": string[], "invalidators": string[] }, "bear": { "narrative": string, "drivers": string[], "invalidators": string[] } },
  "what_to_watch": string[],
  "decision_reasoning": string[],
  "limitations": string[]
}
Every field is REQUIRED (arrays may be empty). Do not rename fields and do not add wrappers like "stock" or "analysis".`;

/** Compact, provenance-carrying serialization of the authoritative context. */
export function serializeContextFacts(ctx: StockContext, mode: "BUY" | "PORTFOLIO"): string[] {
  const facts: string[] = [];
  facts.push(`${ctx.identity.companyName} (${ctx.identity.symbol}), ${ctx.identity.exchange}, sector ${ctx.identity.sector ?? "unknown"}${ctx.identity.industry ? `, industry ${ctx.identity.industry}` : ""}.`);
  if (ctx.market.latestPrice) {
    facts.push(`Latest price ₹${ctx.market.latestPrice.value.toFixed(2)} as of ${ctx.market.latestPrice.asOf} (source: ${ctx.market.latestPrice.source})${ctx.market.staleData ? ` — STALE by ${ctx.market.priceAgeDays} days` : ""}.`);
    if (ctx.market.change1dPct !== null) facts.push(`1-day change ${ctx.market.change1dPct >= 0 ? "+" : ""}${ctx.market.change1dPct.toFixed(2)}%.`);
    if (ctx.market.high52w !== null) facts.push(`52-week range ₹${ctx.market.low52w?.toFixed(2)}–₹${ctx.market.high52w.toFixed(2)}; currently ${ctx.market.distanceFrom52wHighPct?.toFixed(1)}% from the high.`);
  } else {
    facts.push("No market price available.");
  }
  for (const r of ctx.performance.returnsPct) {
    facts.push(r.pct === null ? `Return ${r.period}: not available (${r.reason}).` : `Return ${r.period}: ${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(2)}%.`);
  }
  const f = ctx.fundamentals;
  facts.push(`Fundamentals (updated ${f.asOf ?? "never"}, source ${f.source}): market cap ${f.marketCapCr !== null ? `₹${f.marketCapCr.toFixed(0)} cr` : "n/a"}, P/E ${f.peRatio !== null ? f.peRatio.toFixed(1) : "n/a"}, dividend yield ${f.dividendYieldPct !== null ? `${f.dividendYieldPct.toFixed(2)}%` : "n/a"}.`);
  // Req 2: fiscal-year statements (deterministic extraction from the cached
  // provider document — the LLM must quote, not compute, these numbers).
  const fin = f.financials;
  if (fin && fin.fiscalYears.length > 0) {
    for (const fy of fin.fiscalYears) {
      const parts = [
        fy.revenueCr !== null ? `revenue ₹${fy.revenueCr.toFixed(0)} cr` : null,
        fy.netIncomeCr !== null ? `net profit ₹${fy.netIncomeCr.toFixed(0)} cr` : null,
        fy.ebitdaCr !== null ? `EBITDA ₹${fy.ebitdaCr.toFixed(0)} cr` : null,
        fy.operatingCashflowCr !== null ? `operating cash flow ₹${fy.operatingCashflowCr.toFixed(0)} cr` : null,
        fy.freeCashflowCr !== null ? `free cash flow ₹${fy.freeCashflowCr.toFixed(0)} cr` : null,
      ].filter((x): x is string => x !== null);
      facts.push(`FY${fy.fy ?? "?"} (ending ${fy.periodEnd ?? "unknown"}, source ${fin.source ?? "YAHOO"}): ${parts.length > 0 ? parts.join(", ") : "statement fields unavailable"}.`);
    }
    const g = fin.growth;
    const growthBits = [
      g.revenueGrowthPct !== null ? `revenue ${g.revenueGrowthPct >= 0 ? "+" : ""}${g.revenueGrowthPct.toFixed(1)}% YoY` : null,
      g.earningsGrowthPct !== null ? `net profit ${g.earningsGrowthPct >= 0 ? "+" : ""}${g.earningsGrowthPct.toFixed(1)}% YoY` : null,
      g.profitMarginsPct !== null ? `profit margin ${g.profitMarginsPct.toFixed(1)}%` : null,
    ].filter((x): x is string => x !== null);
    if (growthBits.length > 0) facts.push(`FY-over-FY trend: ${growthBits.join(", ")}.`);
  } else {
    facts.push("Fiscal-year financial statements: NOT AVAILABLE from the provider — do not invent or estimate any annual figures.");
  }
  facts.push(ctx.risk.insufficient
    ? "Risk statistics unavailable (insufficient history) — do not invent them."
    : `Risk: volatility ${ctx.risk.volatilityPct?.toFixed(1)}%, max drawdown ${ctx.risk.maxDrawdownPct?.toFixed(1)}%, band ${ctx.risk.riskBand}.`);
  facts.push(ctx.benchmark.available
    ? `Benchmark (NIFTY 50): beta ${ctx.benchmark.beta?.toFixed(2) ?? "n/a"}, benchmark 1Y ${ctx.benchmark.benchmarkReturnPctAnn?.toFixed(1) ?? "n/a"}% (${ctx.benchmark.observationCount} paired observations).`
    : `Benchmark comparison unavailable: ${ctx.benchmark.reason}.`);
  // Provider-expansion context (World Bank macro + ECB/Frankfurter FX). Each
  // line carries its own source + year so the LLM cites provenance, and every
  // part degrades to an explicit "unavailable" line — never a fabricated value.
  if (ctx.macro.available && ctx.macro.indicators.length > 0) {
    const bits = ctx.macro.indicators.map((i) => `${i.label}: ${i.value.toFixed(1)}${i.unit} (${i.year})`).join(", ");
    facts.push(`India macro context — ${bits}. Source: ${ctx.macro.indicators[0]?.source ?? "World Bank"}.`);
    if (ctx.macro.fx.available && ctx.macro.fx.usdInr !== null) {
      const fx1m = ctx.macro.fx.change1mPct !== null ? `, 1M ${ctx.macro.fx.change1mPct >= 0 ? "+" : ""}${ctx.macro.fx.change1mPct.toFixed(1)}%` : "";
      facts.push(`USD/INR ₹${ctx.macro.fx.usdInr.toFixed(2)} as of ${ctx.macro.fx.asOf ?? "unknown"}${fx1m} (source: ${ctx.macro.fx.source}).`);
    } else {
      facts.push("USD/INR exchange rate: not available from the FX provider right now.");
    }
    facts.push(`Currency-sensitivity classification for this sector (mapping, not a score): ${ctx.macro.fxSensitivity}.`);
  } else {
    facts.push(`India macro/FX context: not available (${ctx.macro.reason ?? "provider unavailable"}) — do not invent macro figures.`);
  }
  facts.push(`News: ${ctx.news.length} recent matched article(s) (most recent ${ctx.news[0]?.publishedAt?.slice(0, 10) ?? "n/a"}).`);
  facts.push(`Events: ${ctx.events.length} unique detected event(s); severities ${ctx.events.map((e) => e.severity ?? "?").join(", ") || "none"}.`);
  if (mode === "PORTFOLIO") {
    facts.push(ctx.portfolio.owned
      ? `Portfolio context: user HOLDS ${ctx.portfolio.quantity} shares, avg buy ₹${ctx.portfolio.avgBuyPrice?.toFixed(2) ?? "?"}, position ₹${ctx.portfolio.positionValue?.toFixed(0) ?? "?"}, weight ${ctx.portfolio.portfolioWeightPct?.toFixed(1) ?? "?"}% of portfolio, unrealized P&L ${ctx.portfolio.unrealizedPnlPct?.toFixed(1) ?? "?"}%, held ${ctx.portfolio.holdingPeriodDays ?? "?"} days.`
      : "Portfolio context: the user does NOT own this stock — treat as a POTENTIAL INVESTMENT; do not fabricate exposure.");
  }
  for (const n of ctx.freshness.notes) facts.push(`Data-quality note: ${n}`);
  return facts;
}

export function serializeEvidence(evidence: RetrievedEvidence[]): string {
  return evidence
    .map((e, i) => `[E${i + 1}] (${e.documentType} | ${e.source}${e.publishedAt ? ` | ${e.publishedAt.slice(0, 10)}` : ""}) ${e.title}: ${e.snippet}`)
    .join("\n\n");
}

/** Compose the full user prompt: facts + evidence + decision + question. */
export function buildResearchPrompt(input: {
  ctx: StockContext;
  decision: DecisionResult;
  evidence: RetrievedEvidence[];
  mode: "BUY" | "PORTFOLIO";
  userQuestion: string;
}): string {
  const parts = [
    `QUANTITATIVE FACTS (authoritative — computed by PortfolioIQ's engine; quote, never recompute):\n${serializeContextFacts(input.ctx, input.mode).map((f) => `- ${f}`).join("\n")}`,
    `EVIDENCE (cite as [E#]; do not cite anything not listed):\n${serializeEvidence(input.evidence)}`,
    `DETERMINISTIC DECISION (already computed — explain, do not override): decision=${input.decision.decision}, score=${input.decision.score}/100, confidence=${input.decision.confidence}, risk=${input.decision.riskLevel}. Factor scores: ${input.decision.factors.map((f) => `${f.name} ${f.score}`).join(", ")}.`,
    `USER QUESTION: ${input.userQuestion}`,
    `MODE: ${input.mode === "PORTFOLIO" ? "portfolio-aware analysis (suitability for THIS user's portfolio, including their existing position)" : "standalone investment analysis (general attractiveness)"}.`,
  ];
  return parts.join("\n\n");
}
