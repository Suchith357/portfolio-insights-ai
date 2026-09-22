/**
 * Deep AI stock research orchestrator (Prompt 4).
 *
 *   resolve symbol → authoritative context (DB + engines)
 *     → multi-query RAG → deterministic decision engine
 *     → grounding gate → Qwen3-4B (narrative only) → validated report
 *
 * Guarantees:
 *  - The decision comes from decision-engine.service.ts, never from the LLM.
 *  - INSUFFICIENT_EVIDENCE is a first-class outcome (thin retrieval + data gaps).
 *  - Stale market data is labelled and lowers confidence.
 *  - Fingerprint cache: same stock + same evidence fingerprint reuses the
 *    cached report for AI_RESEARCH_CACHE_MINUTES (default 60); a changed
 *    evidence fingerprint (new material news/events) invalidates it.
 *  - AI unavailable → typed UNAVAILABLE result; nothing crashes.
 */

import { prisma } from "../../utils/prisma.js";
import { aiConfig } from "../config.js";
import { chat, LlmError } from "../llm.js";
import { probeServer } from "../embedding.js";
import { vectorStore } from "../vector-store.js";
import { buildStockContext, type StockContext } from "./stock-context.service.js";
import { retrieveResearchEvidence } from "./research-retrieval.service.js";
import { decide, type DecisionResult } from "./decision-engine.service.js";
import { buildResearchPrompt, RESEARCH_SYSTEM } from "./research-prompts.js";
import { parseResearchSections, ResearchOutputError, type ResearchLlmSections } from "./report-schema.js";
import { createHash } from "node:crypto";

export const RESEARCH_VERSION = "stock-research-v1";

/** Req 8: one beginner-friendly explanation block per key metric. */
export interface MetricExplanation {
  metric: string;
  value: string;
  meaning: string;
  higherMeans: string;
  lowerMeans: string;
  interpretation: string;
}

/**
 * Deterministic metric explanations for the report. Every value is quoted
 * from the authoritative context; when a metric is unavailable the value is
 * "not available" — never a fabricated number.
 */
function metricExplanations(ctx: StockContext, decision: DecisionResult): MetricExplanation[] {
  const out: MetricExplanation[] = [];
  const fmt = (v: number | null | undefined, suffix: string, digits = 1): string =>
    typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(digits)}${suffix}` : "not available";

  out.push({
    metric: "P/E ratio",
    value: ctx.fundamentals.peRatio === null ? "not available" : `${ctx.fundamentals.peRatio.toFixed(1)}×`,
    meaning: "How many rupees investors pay for each ₹1 of the company's annual earnings.",
    higherMeans: "the market expects more growth (or the price is expensive)",
    lowerMeans: "the price is cheaper relative to earnings (or growth is not expected)",
    interpretation:
      ctx.fundamentals.peRatio === null
        ? "No earnings data — valuation cannot be judged from P/E."
        : ctx.fundamentals.peRatio < 12
          ? "P/E is in the low band — the market is pricing this stock cheaply relative to earnings."
          : ctx.fundamentals.peRatio <= 25
            ? "P/E is in the fair band (12–25) — broadly typical pricing for Indian large caps."
            : "P/E is elevated — investors are paying a premium; the price depends on that growth materialising.",
  });
  if (ctx.risk.volatilityPct !== null) {
    out.push({
      metric: "Volatility (annualised)",
      value: `${ctx.risk.volatilityPct.toFixed(1)}%`,
      meaning: "How widely the price swings around its trend over a year.",
      higherMeans: "larger swings — bigger upsides and downsides",
      lowerMeans: "calmer, more predictable price movement",
      interpretation:
        ctx.risk.volatilityPct < 18
          ? "Relatively calm for an equity."
          : ctx.risk.volatilityPct < 30
            ? "Moderate swings — typical for Indian mid/large caps."
            : "High swings — position size matters more than usual.",
    });
  }
  if (ctx.risk.maxDrawdownPct !== null) {
    out.push({
      metric: "Maximum drawdown",
      value: `${ctx.risk.maxDrawdownPct.toFixed(1)}%`,
      meaning: "The worst peak-to-trough fall in the stored history.",
      higherMeans: "(closer to 0) shallower historical falls",
      lowerMeans: "(more negative) deeper historical falls — holders sat through them",
      interpretation: `At its worst point, the stock fell ${Math.abs(ctx.risk.maxDrawdownPct).toFixed(0)}% from a peak before recovering (if it did). Past falls do not bound future ones.`,
    });
  }
  const r1y = ctx.performance.returnsPct.find((r) => r.period === "1Y")?.pct ?? null;
  out.push({
    metric: "1-year return",
    value: fmt(r1y, "%", 1),
    meaning: "Total price change over the last year (excluding dividends).",
    higherMeans: "stronger past performance",
    lowerMeans: "weaker past performance",
    interpretation:
      r1y === null
        ? "Insufficient price history to compute a 1-year return."
        : r1y >= 0
          ? "The stock gained value over the past year."
          : "The stock lost value over the past year.",
  });
  if (ctx.benchmark.available && ctx.benchmark.beta !== null) {
    out.push({
      metric: "Beta vs NIFTY 50",
      value: ctx.benchmark.beta.toFixed(2),
      meaning: "How strongly the stock tends to move when the overall market moves.",
      higherMeans: "the stock amplifies market moves (more market-sensitive)",
      lowerMeans: "the stock dampens market moves (more defensive)",
      interpretation:
        ctx.benchmark.beta >= 1.2
          ? "Moves noticeably harder than the index in the same direction."
          : ctx.benchmark.beta <= 0.8
            ? "Moves less than the index — comparatively defensive."
            : "Moves roughly in line with the index.",
    });
  }
  out.push({
    metric: "Decision score",
    value: `${decision.score}/100`,
    meaning: "PortfolioIQ's blended factor score (valuation, growth, momentum, risk, news, evidence quality).",
    higherMeans: "factors align more positively",
    lowerMeans: "factors align more negatively",
    interpretation:
      decision.decision === "BUY"
        ? "Score in the BUY band with acceptable risk — evidence leans supportive."
        : decision.decision === "AVOID"
          ? "Score in the AVOID band — evidence leans unfavourable."
          : decision.decision === "INSUFFICIENT_EVIDENCE"
            ? "Too little reliable data to score responsibly."
            : "Middle band — evidence is mixed or the risk gate blocked a stronger call.",
  });
  out.push({
    metric: "Confidence",
    value: `${(decision.confidence * 100).toFixed(0)}%`,
    meaning: "How complete and trustworthy the underlying data was — NOT how certain the future is.",
    higherMeans: "more complete, fresher, multi-source data",
    lowerMeans: "gaps, staleness or thin evidence reduced the analysis's footing",
    interpretation:
      decision.confidenceReasons.length > 0
        ? `Reduced by: ${decision.confidenceReasons.slice(0, 3).join("; ")}.`
        : "Data coverage was good across all factors.",
  });
  return out;
}

export interface ResearchReport {
  stock: { symbol: string; companyName: string };
  recommendation: {
    decision: "BUY" | "HOLD" | "AVOID" | "INSUFFICIENT_EVIDENCE";
    score: number;
    confidence: number;
    riskLevel: string;
    version: string;
  };
  executive_summary: string;
  current_situation: string;
  /** Req 8: deterministic beginner-friendly explanations (never LLM-authored). */
  metric_explanations: MetricExplanation[];
  financial_analysis: ResearchLlmSections["financial_analysis"] & { financial_quality: number };
  performance_analysis: ResearchLlmSections["performance_analysis"] & { periods: StockContext["performance"]["returnsPct"] };
  risk_analysis: ResearchLlmSections["risk_analysis"] & {
    volatility: number | null; drawdown: number | null; beta: number | null; var: number | null; cvar: number | null;
  };
  news_analysis: ResearchLlmSections["news_analysis"];
  sector_macro_analysis: ResearchLlmSections["sector_macro_analysis"];
  historical_context: ResearchLlmSections["historical_context"] & { available: boolean; sample_size: number };
  scenarios: ResearchLlmSections["scenarios"];
  what_to_watch: string[];
  decision_reasoning: string[];
  /** Deterministic position block — present only in PORTFOLIO mode. */
  portfolio_context?:
    | {
        owned: true;
        quantity: number | null;
        avgBuyPrice: number | null;
        positionValue: number | null;
        portfolioWeightPct: number | null;
        unrealizedPnlPct: number | null;
        holdingPeriodDays: number | null;
        qualitativeSummary: string;
      }
    | { owned: false; qualitativeSummary: string };
  evidence: Array<{ id: string; title: string; source: string; url: string | null; published_at: string | null; relevance: number }>;
  limitations: string[];
  meta: {
    version: string;
    mode: "BUY" | "PORTFOLIO";
    cached: boolean;
    generatedAt: string;
    evidenceQuality: number;
    llmMs: number | null;
    factors: DecisionResult["factors"];
    weights: DecisionResult["weights"];
    confidenceReasons: string[];
    dataQualityNotes: string[];
  };
}

export type ResearchOutcome =
  | { status: "OK"; report: ResearchReport }
  | { status: "UNAVAILABLE"; reason: string }
  | { status: "NOT_FOUND"; reason: string };

// --------------------------------------------------------------- caching
interface CacheEntry {
  version: string;
  fingerprint: string;
  generatedAt: string;
  report: ResearchReport;
}
const cache = new Map<string, CacheEntry>(); // key: symbol|mode|userId (bounded)

function fingerprintOf(evidenceIds: string[], latestArticleId: number | null, latestEventId: number | null, priceDate: string | null): string {
  return createHash("sha256").update(`${evidenceIds.join("|")}:${latestArticleId}:${latestEventId}:${priceDate}`).digest("hex").slice(0, 24);
}

function cacheTtlMinutes(): number {
  const n = Number(process.env["AI_RESEARCH_CACHE_MINUTES"]);
  return Number.isFinite(n) && n >= 0 ? Math.min(1440, n) : 60;
}

// -------------------------------------------------------------- resolution
/** Resolve a possibly ambiguous natural-language mention to our stock universe. */
export async function resolveStock(query: string): Promise<Array<{ symbol: string; companyName: string }> | null> {
  const q = query.toUpperCase().trim();
  const bySymbol = await prisma.stocks.findMany({
    where: { OR: [{ symbol: q }, { yahoo_symbol: { startsWith: q } }] },
    select: { symbol: true, company_name: true },
    take: 5,
  });
  if (bySymbol.length > 0) return bySymbol.map((s) => ({ symbol: s.symbol, companyName: s.company_name }));
  const words = query.trim();
  if (words.length < 3) return [];
  const byName = await prisma.stocks.findMany({
    where: { company_name: { contains: words, mode: "insensitive" } },
    select: { symbol: true, company_name: true },
    take: 6,
  });
  return byName.map((s) => ({ symbol: s.symbol, companyName: s.company_name })); // >1 ⇒ ambiguous, caller must ask
}

// ---------------------------------------------------------------- pipeline
export async function analyzeStockDeep(input: {
  symbol: string;
  userId: number | null;
  mode: "BUY" | "PORTFOLIO";
  question?: string;
}): Promise<ResearchOutcome> {
  // 0) Resolve the stock FIRST — a pure DB lookup, independent of AI state.
  //    An unknown symbol must 404 even when the local AI runtime is down.
  const stock = await prisma.stocks.findFirst({
    where: { symbol: input.symbol.toUpperCase() },
    select: { stock_id: true, symbol: true, company_name: true },
  });
  if (!stock) return { status: "NOT_FOUND", reason: `Unknown symbol ${input.symbol}.` };

  if (!aiConfig.enabled || aiConfig.runtime === "NONE") {
    return { status: "UNAVAILABLE", reason: "The AI module is disabled by configuration (AI_ENABLED/AI_RUNTIME)." };
  }
  const models = await probeServer();
  if (!models.reachable) {
    return { status: "UNAVAILABLE", reason: "The local AI runtime is unreachable. Start Ollama and try again — all other PortfolioIQ features work without it." };
  }
  if (!vectorStore.exists || vectorStore.size === 0) {
    vectorStore.ensureLoaded(); // restart resilience (same fix as ai/service.ts)
  }
  if (!vectorStore.exists || vectorStore.size === 0) {
    return { status: "UNAVAILABLE", reason: "The AI knowledge index is empty — an administrator must build it first (POST /api/admin/ai/index/rebuild)." };
  }

  // 1) Authoritative context.
  const ctx = await buildStockContext(stock.symbol, input.userId, input.mode);

  // 2) Multi-query retrieval + deterministic decision.
  const evidence = await retrieveResearchEvidence(stock.symbol, stock.company_name, input.question);
  const decision = decide(ctx, evidence.qualityScore, evidence.qualityReasons);

  // 3) Cache lookup (fingerprint = evidence set + latest article/event + price date).
  const key = `${stock.symbol}|${input.mode}|${input.userId ?? 0}`;
  const latestArticle = ctx.news[0]?.articleId ?? null;
  const latestEvent = ctx.events[0]?.eventId ?? null;
  const fp = fingerprintOf(evidence.merged.map((e) => e.documentId), latestArticle, latestEvent, ctx.market.latestPrice?.asOf ?? null);
  const hit = cache.get(key);
  const ttl = cacheTtlMinutes();
  if (hit && hit.version === RESEARCH_VERSION && hit.fingerprint === fp && Date.now() - new Date(hit.generatedAt).getTime() < ttl * 60_000) {
    return { status: "OK", report: { ...hit.report, meta: { ...hit.report.meta, cached: true } } };
  }

  // 4) INSUFFICIENT_EVIDENCE: do NOT call the LLM for a confident report.
  if (decision.decision === "INSUFFICIENT_EVIDENCE") {
    const report = skeletonReport(ctx, decision, evidence, input.mode);
    return { status: "OK", report };
  }

  // 5) Grounded generation (narrative sections only).
  const prompt = buildResearchPrompt({
    ctx,
    decision,
    evidence: evidence.merged,
    mode: input.mode,
    userQuestion: input.question ?? `Provide a deep research analysis of ${stock.company_name} (${stock.symbol}) and explain the ${decision.decision} assessment.`,
  });
  const llmStart = Date.now();
  let raw: string;
  // LLM JSON output is stochastic: ~1-in-N generations arrives malformed or
  // truncated even with a correct prompt contract. A transport failure means
  // the model/endpoint is genuinely down (retries just double the wait), but
  // a PARSE failure is a bad dice roll — one retry of the same grounded
  // prompt is the honest fix. This is the background-job path, so the retry
  // costs seconds, not a user's attention.
  const attemptChat = async (): Promise<string> =>
    // The research JSON contract is large: budget ~3500 output tokens inside an
    // 8192-token window (system ≈ 550 + prompt ≈ 1400 + output ≈ 2700 observed
    // ⇒ ~4.7k of 8192; 4B q4 + 8k KV ≈ 3.7 GB VRAM, fits a 6 GB GPU). A lower
    // cap truncates the JSON mid-object; a 240 s wall covers cold starts.
    chat(RESEARCH_SYSTEM, prompt, { maxTokens: 3500, numCtx: 8192, temperature: 0.2, timeoutMs: 240_000 });
  try {
    // The research JSON contract is large: budget ~2500 output tokens inside an
    // 8192-token window (prompt ≈ 2.3k tokens; 4B q4 + 8k KV ≈ 3.7 GB VRAM, fits
    // a 6 GB GPU). A 240 s wall covers slow first-generation on cold start.
    raw = await attemptChat();
  } catch (err) {
    const reason = err instanceof LlmError ? err.message : "LLM generation failed";
    console.error(`[research] generation failed: ${reason}`);
    return { status: "UNAVAILABLE", reason };
  }
  const llmMs = Date.now() - llmStart;

  let sections: ResearchLlmSections;
  try {
    sections = parseResearchSections(raw);
  } catch (err) {
    if (err instanceof ResearchOutputError) {
      console.error(`[research] first generation unparseable (${err.message}) — retrying once`);
      try {
        raw = await attemptChat();
      } catch (retryErr) {
        const reason = retryErr instanceof LlmError ? retryErr.message : "LLM generation failed";
        console.error(`[research] retry generation failed: ${reason}`);
        return { status: "UNAVAILABLE", reason };
      }
      try {
        sections = parseResearchSections(raw);
      } catch (retryParseErr) {
        const reason = retryParseErr instanceof ResearchOutputError ? retryParseErr.message : "unparseable response";
        console.error(`[research] ${reason} (after retry)`);
        return { status: "UNAVAILABLE", reason: `The model produced a malformed research response (${reason}). Please retry.` };
      }
    } else {
      const reason = "unparseable response";
      console.error(`[research] ${reason}`);
      return { status: "UNAVAILABLE", reason: `The model produced a malformed research response (${reason}). Please retry.` };
    }
  }

  const report = assembleReport(ctx, decision, evidence, sections, input.mode, llmMs);
  cache.set(key, { version: RESEARCH_VERSION, fingerprint: fp, generatedAt: new Date().toISOString(), report });
  if (cache.size > 100) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].generatedAt.localeCompare(b[1].generatedAt))[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return { status: "OK", report };
}

// ---------------------------------------------------------------- assembly
function skeletonReport(
  ctx: StockContext,
  decision: DecisionResult,
  evidence: Awaited<ReturnType<typeof retrieveResearchEvidence>>,
  mode: "BUY" | "PORTFOLIO",
): ResearchReport {
  const base = assembleReport(ctx, decision, evidence, mode === "PORTFOLIO" ? emptySections : emptySections, mode, null);
  base.executive_summary =
    `Insufficient evidence for a responsible ${ctx.identity.symbol} assessment. The knowledge index holds too little relevant, recent, diverse material and ${decision.factors.filter((f) => !f.dataAvailable).length} quantitative factor(s) lack data. PortfolioIQ refuses to guess.`;
  base.limitations = [
    ...base.limitations,
    ...evidence.qualityReasons.map((r) => `Evidence gap: ${r}`),
    ...decision.factors.filter((f) => !f.dataAvailable).map((f) => `Data gap: ${f.name} — ${f.detail}`),
  ];
  return base;
}

const emptySections: ResearchLlmSections = {
  executive_summary: "",
  current_situation: "",
  financial_analysis: { summary: "", positive_factors: [], negative_factors: [], valuation: "" },
  performance_analysis: { summary: "", relative_to_benchmark: "" },
  risk_analysis: { summary: "" },
  news_analysis: { summary: "", overall_direction: "UNCERTAIN", important_events: [], positive_factors: [], negative_factors: [] },
  sector_macro_analysis: { summary: "", factors: [] },
  historical_context: { summary: "" },
  scenarios: {
    bull: { narrative: "", drivers: [], invalidators: [] },
    base: { narrative: "", drivers: [], invalidators: [] },
    bear: { narrative: "", drivers: [], invalidators: [] },
  },
  what_to_watch: [],
  decision_reasoning: [],
  limitations: [],
};

function assembleReport(
  ctx: StockContext,
  decision: DecisionResult,
  evidence: Awaited<ReturnType<typeof retrieveResearchEvidence>>,
  sections: ResearchLlmSections,
  mode: "BUY" | "PORTFOLIO",
  llmMs: number | null,
): ResearchReport {
  const limitations = [
    ...sections.limitations,
    ...ctx.freshness.notes,
    ...(ctx.benchmark.available ? [] : [`Benchmark comparison unavailable: ${ctx.benchmark.reason}.`]),
    "Analysis is evidence-based decision support, not personalized financial advice; past performance does not guarantee future results.",
  ];
  return {
    stock: { symbol: ctx.identity.symbol, companyName: ctx.identity.companyName },
    recommendation: {
      decision: decision.decision,
      score: decision.score,
      confidence: decision.confidence,
      riskLevel: decision.riskLevel,
      version: decision.version,
    },
    // Req 8: deterministic, beginner-friendly explanations for every key
    // metric. Computed HERE (never by the LLM) so the meaning, direction and
    // a neutral possible-read accompany each number in the UI.
    metric_explanations: metricExplanations(ctx, decision),
    executive_summary: sections.executive_summary,
    current_situation: sections.current_situation,
    financial_analysis: { ...sections.financial_analysis, financial_quality: decision.factors[0]?.score ?? 50 },
    performance_analysis: { ...sections.performance_analysis, periods: ctx.performance.returnsPct },
    risk_analysis: {
      ...sections.risk_analysis,
      volatility: ctx.risk.volatilityPct,
      drawdown: ctx.risk.maxDrawdownPct,
      beta: ctx.benchmark.beta,
      var: null, // stock-level historical VaR is computed by the engine on demand; not fabricated here
      cvar: null,
    },
    news_analysis: sections.news_analysis,
    sector_macro_analysis: sections.sector_macro_analysis,
    historical_context: { ...sections.historical_context, available: ctx.events.length > 0, sample_size: ctx.events.length },
    scenarios: sections.scenarios,
    what_to_watch: sections.what_to_watch,
    decision_reasoning: decision.rationale,
    // Deterministic portfolio position block (never LLM-authored): shown in
    // PORTFOLIO mode so "is this good for MY portfolio" is answerable from the
    // report itself, with a neutral qualitative summary when owned.
    portfolio_context:
      mode === "PORTFOLIO" && ctx.portfolio.owned
        ? {
            owned: true,
            quantity: ctx.portfolio.quantity,
            avgBuyPrice: ctx.portfolio.avgBuyPrice,
            positionValue: ctx.portfolio.positionValue,
            portfolioWeightPct: ctx.portfolio.portfolioWeightPct,
            unrealizedPnlPct: ctx.portfolio.unrealizedPnlPct,
            holdingPeriodDays: ctx.portfolio.holdingPeriodDays,
            qualitativeSummary: `You hold ${ctx.portfolio.quantity} shares of ${ctx.identity.symbol} — ${ctx.portfolio.portfolioWeightPct?.toFixed(1) ?? "?"}% of your portfolio — at an average buy price of ₹${ctx.portfolio.avgBuyPrice?.toFixed(2) ?? "?"}. This analysis addresses suitability for your existing position; the deterministic factors already include your portfolio's context, and the AI narrative explains them.`,
          }
        : mode === "PORTFOLIO"
          ? { owned: false, qualitativeSummary: `You do not currently hold ${ctx.identity.symbol}. This analysis treats it as a POTENTIAL INVESTMENT; no portfolio exposure was fabricated.` }
          : undefined,
    evidence: evidence.merged.map((e, i) => ({
      id: `E${i + 1}`,
      title: e.title,
      source: e.source,
      url: e.sourceUrl ?? null,
      published_at: e.publishedAt ?? null,
      relevance: Math.round(e.score * 1000) / 1000,
    })),
    limitations,
    meta: {
      version: RESEARCH_VERSION,
      mode,
      cached: false,
      generatedAt: new Date().toISOString(),
      evidenceQuality: evidence.qualityScore,
      llmMs,
      factors: decision.factors,
      weights: decision.weights,
      confidenceReasons: decision.confidenceReasons,
      dataQualityNotes: ctx.freshness.notes,
    },
  };
}

/** Test/diagnostic visibility. */
export function cacheSize(): number {
  return cache.size;
}
