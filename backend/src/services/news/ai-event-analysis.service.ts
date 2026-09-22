/**
 * AI event analysis (Feature B) — connects the Prompt 1 RAG foundation to the
 * intelligence pipeline.
 *
 * Contract:
 *  - The LLM is called ONLY for events passing the deterministic importance
 *    gate (HIGH/CRITICAL). One analysis per event, cached in
 *    intelligence_news_events.ai_analysis { version, at, assessment }.
 *  - The evidence package combines AUTHORITATIVE quantitative facts (current
 *    price, 5-day move, portfolio exposure — computed from PostgreSQL, never
 *    by the model) with RAG-retrieved evidence (cited [E1..]).
 *  - Insufficient retrieval → grounding gate refuses → the stored assessment
 *    carries NO unsupported AI claim (importance/direction still come from
 *    the deterministic engine).
 *  - AI unavailability NEVER breaks news ingestion: every failure path
 *    returns a typed result and the pipeline continues.
 */

import { prisma as prismaClient } from "../../utils/prisma.js";
import { scoreImportance, importanceRecommendation, type Importance } from "./event-importance.service.js";
import { query as aiQuery } from "../../ai/service.js";
import { vectorStore } from "../../ai/vector-store.js";
import type { RetrievedEvidence } from "../../ai/types.js";

export const AI_ANALYSIS_VERSION = "event-analysis-v1";

export interface EventAiAssessment {
  eventSummary: string;
  affectedStock: string | null;
  direction: "POSITIVE" | "NEGATIVE" | "MIXED" | "NEUTRAL" | "UNCERTAIN";
  importance: Importance;
  portfolioExposurePct: number | null;
  keyFactors: string[];
  portfolioImpact: string;
  whyItMatters: string;
  whatToMonitor: string[];
  confidence: number; // 0..1 evidence coverage reported by the model
  evidence: Array<{ evidenceId: string; title: string; source: string; url: string | null }>;
  sources: string[];
  recommendation: string; // advice-safe label, e.g. "CLOSE MONITORING"
}

export interface AiAnalysisOutcome {
  ran: boolean;
  reason: string;
  assessment: EventAiAssessment | null;
  grounding: "GROUNDED" | "INSUFFICIENT_EVIDENCE" | "UNAVAILABLE" | "SKIPPED";
}

interface EventRow {
  event_id: number;
  category: string;
  title: string;
  summary: string | null;
  severity: number | null;
  confidence: unknown;
  detected_at: Date;
  article_count: number;
  source_names: unknown;
}

// ------------------------------------------------------------- importance
/** Full importance evaluation for a stored event (relationship + sources from DB). */
export async function evaluateEventImportance(event: {
  event_id: number;
  category: string;
  severity: number | null;
  confidence: unknown;
  detected_at: Date;
  article_count?: number;
}): Promise<{ result: ReturnType<typeof scoreImportance>; sourceCount: number; relationship: string }> {
  const links = await prismaClient.intelligence_event_entities.findMany({
    where: { event_id: event.event_id },
    select: { relationship_type: true, relevance: true },
  });
  const bestRelevance = links.reduce((max, l) => Math.max(max, l.relevance === null ? 0 : Number(l.relevance)), 0);
  const relationship = links.some((l) => l.relationship_type === "DIRECT")
    ? "DIRECT"
    : links.some((l) => l.relationship_type === "SECTOR")
      ? "SECTOR"
      : links.length > 0
        ? (links[0]!.relationship_type as string)
        : "OTHER";

  const evidence = await prismaClient.intelligence_news_events.findUnique({
    where: { event_id: event.event_id },
    select: { source_names: true },
  });
  const sourceNames = Array.isArray(evidence?.source_names) ? (evidence!.source_names as unknown[]) : [];
  const sourceCount = Math.max(
    sourceNames.filter((s): s is string => typeof s === "string").length,
    event.article_count ?? 0,
  );

  const result = scoreImportance({
    severity: event.severity,
    relevance: bestRelevance || (event.confidence === null ? null : Number(event.confidence)),
    relationship,
    sourceCount,
    detectedAt: event.detected_at,
    category: event.category,
  });
  return { result, sourceCount, relationship };
}

// ---------------------------------------------------------- evidence pack
interface EvidencePack {
  quantitativeFacts: string[];
  question: string;
  exposurePct: number | null;
  affectedSymbol: string | null;
}

async function buildEvidencePack(event: EventRow, userId: number | null): Promise<EvidencePack> {
  const facts: string[] = [];
  let affectedSymbol: string | null = null;
  let exposurePct: number | null = null;

  const links = await prismaClient.intelligence_event_entities.findMany({
    where: { event_id: event.event_id },
    select: { stock_id: true, relationship_type: true },
    take: 5,
  });
  const directStockId = links.find((l) => l.stock_id !== null && l.relationship_type === "DIRECT")?.stock_id
    ?? links.find((l) => l.stock_id !== null)?.stock_id
    ?? null;

  if (directStockId !== null) {
    const stock = await prismaClient.stocks.findUnique({
      where: { stock_id: directStockId },
      select: { symbol: true, company_name: true, sector: true },
    });
    if (stock) {
      affectedSymbol = stock.symbol;
      const prices = await prismaClient.stock_prices.findMany({
        where: { stock_id: directStockId },
        orderBy: { price_date: "desc" },
        take: 6,
        select: { price_date: true, close_price: true },
      });
      if (prices.length >= 2) {
        const latest = prices[0]!;
        const weekAgo = prices[prices.length - 1]!;
        const move = ((Number(latest.close_price) - Number(weekAgo.close_price)) / Number(weekAgo.close_price)) * 100;
        facts.push(
          `${stock.symbol} (${stock.company_name}, ${stock.sector}) latest close ₹${Number(latest.close_price).toFixed(2)} on ${latest.price_date.toISOString().slice(0, 10)}; 5-session move ${move >= 0 ? "+" : ""}${move.toFixed(2)}%.`,
        );
      }
      if (userId !== null) {
        // Portfolio exposure: user-level aggregate weight of this stock (computed).
        const agg = await prismaClient.$queryRawUnsafe<Array<{ weight: number | null }>>(
          `SELECT w.weight FROM (
             SELECT SUM(h.quantity * sp.close_price) AS value
             FROM holdings h
             JOIN portfolios pf ON pf.portfolio_id = h.portfolio_id
             JOIN LATERAL (
               SELECT close_price FROM stock_prices
               WHERE stock_id = h.stock_id ORDER BY price_date DESC LIMIT 1
             ) sp ON TRUE
             WHERE pf.user_id = $1 AND h.stock_id = $2
           ) v
           CROSS JOIN LATERAL (
             SELECT SUM(h2.quantity * sp2.close_price) AS total
             FROM holdings h2
             JOIN portfolios pf2 ON pf2.portfolio_id = h2.portfolio_id
             JOIN LATERAL (
               SELECT close_price FROM stock_prices
               WHERE stock_id = h2.stock_id ORDER BY price_date DESC LIMIT 1
             ) sp2 ON TRUE
             WHERE pf2.user_id = $1
           ) t
           CROSS JOIN LATERAL (SELECT CASE WHEN t.total > 0 THEN v.value / t.total ELSE NULL END AS weight) w`,
          userId,
          directStockId,
        );
        const w = agg[0]?.weight;
        exposurePct = w === null || w === undefined ? null : Number(w) * 100;
        if (exposurePct !== null && Number.isFinite(exposurePct)) {
          facts.push(`This stock represents about ${exposurePct.toFixed(1)}% of the user's portfolio value (latest available prices).`);
        } else {
          facts.push("The user holds no measurable position in this stock.");
        }
      }
    }
  }
  facts.push(`Event category ${event.category}, severity ${event.severity ?? "unrated"}/5, ${event.article_count} supporting article(s).`);

  const question = `What happened and why might it matter${affectedSymbol ? ` for ${affectedSymbol}` : ""}: ${event.title}`;
  return { quantitativeFacts: facts, question, exposurePct, affectedSymbol };
}

// --------------------------------------------------------------- mapping
function directionFromEvent(event: EventRow, modelDirection: string | null): EventAiAssessment["direction"] {
  // Deterministic direction (provider sentiment) stays authoritative; the
  // model may only refine UNCERTAIN into a labelled reading, never override
  // facts with certainty.
  const allowed = ["POSITIVE", "NEGATIVE", "MIXED", "NEUTRAL", "UNCERTAIN"] as const;
  if (modelDirection && (allowed as readonly string[]).includes(modelDirection)) {
    return modelDirection as EventAiAssessment["direction"];
  }
  return "UNCERTAIN";
}

function evidenceFromRetrieval(retrieved: RetrievedEvidence[]): EventAiAssessment["evidence"] {
  return retrieved.map((e, i) => ({
    evidenceId: `E${i + 1}`,
    title: e.title,
    source: e.source,
    url: e.sourceUrl ?? null,
  }));
}

// ------------------------------------------------------------- analysis
export async function analyzeEvent(eventId: number, userId: number | null = null): Promise<AiAnalysisOutcome> {
  const event = await prismaClient.intelligence_news_events.findUnique({
    where: { event_id: eventId },
    select: {
      event_id: true, category: true, title: true, summary: true, severity: true,
      confidence: true, detected_at: true, article_count: true, source_names: true, ai_analysis: true,
    },
  });
  if (!event) return { ran: false, reason: "event not found", assessment: null, grounding: "SKIPPED" };

  // 1) Deterministic importance gate — the LLM is NOT called for noise.
  const { result: importance } = await evaluateEventImportance(event);
  if (!isImportant(importance.importance)) {
    return { ran: false, reason: `importance ${importance.importance} below HIGH — deterministic analysis only`, assessment: null, grounding: "SKIPPED" };
  }

  // 2) Cached?
  const cached = readCache(event.ai_analysis);
  if (cached) return { ran: false, reason: "cached analysis", assessment: cached, grounding: "GROUNDED" };

  // 3) AI subsystem ready? (news pipeline must keep working without it)
  if (!vectorStore.exists || vectorStore.size === 0) {
    return { ran: false, reason: "AI index empty — analysis unavailable (news pipeline unaffected)", assessment: null, grounding: "UNAVAILABLE" };
  }

  // 4) Evidence package (authoritative facts first).
  const pack = await buildEvidencePack(event as EventRow, userId);

  // 5) RAG + grounding + generation (service handles the refusal path).
  const aiResult = await aiQuery({
    question: pack.question,
    kind: "alert_analysis",
    stockSymbol: pack.affectedSymbol ?? undefined,
    quantitativeFacts: pack.quantitativeFacts,
  });

  const deterministic: EventAiAssessment = {
    eventSummary: event.summary ?? event.title,
    affectedStock: pack.affectedSymbol,
    direction: directionFromEvent(event as EventRow, null),
    importance: importance.importance,
    portfolioExposurePct: pack.exposurePct,
    keyFactors: [],
    portfolioImpact:
      pack.exposurePct !== null
        ? `About ${pack.exposurePct.toFixed(1)}% of portfolio value is exposed to the affected stock.`
        : "No measurable portfolio exposure to the affected stock.",
    whyItMatters: `The event is assessed ${importance.importance} by the deterministic engine (${importance.components.map((c) => c.detail).join("; ")}).`,
    whatToMonitor: ["Further official announcements", "Company response", "Price/volume reaction over the next sessions"],
    confidence: 0,
    evidence: [],
    sources: Array.isArray(event.source_names) ? (event.source_names as unknown[]).filter((s): s is string => typeof s === "string") : [],
    recommendation: importanceRecommendation(importance.importance),
  };

  if (aiResult.grounding !== "GROUNDED" || !aiResult.analysis) {
    // Grounding refused (insufficient evidence) or AI unavailable — store the
    // deterministic assessment WITHOUT any model claim. No fabrication.
    const reason = aiResult.grounding === "INSUFFICIENT_EVIDENCE"
      ? "insufficient retrieved evidence — no AI claim stored"
      : (aiResult.grounding === "UNAVAILABLE" ? (aiResult.unavailableReason ?? "AI unavailable") : "AI unavailable");
    await cacheAssessment(event.event_id, deterministic, reason);
    return { ran: false, reason, assessment: deterministic, grounding: aiResult.grounding };
  }

  // 6) Merge: model provides language + factors; engine keeps authority over
  //    direction/importance/exposure. Evidence IDs preserved for traceability.
  const a = aiResult.analysis;
  const assessment: EventAiAssessment = {
    ...deterministic,
    eventSummary: a.analysis.slice(0, 1200) || deterministic.eventSummary,
    keyFactors: a.key_factors.slice(0, 8),
    whyItMatters: deterministic.whyItMatters,
    whatToMonitor: deterministic.whatToMonitor,
    confidence: a.confidence,
    evidence: evidenceFromRetrieval(aiResult.evidence),
  };
  await cacheAssessment(event.event_id, assessment, null);
  return { ran: true, reason: "analysis generated", assessment, grounding: "GROUNDED" };
}

function isImportant(i: Importance): boolean {
  return i === "HIGH" || i === "CRITICAL";
}

// ------------------------------------------------------------- caching
function readCache(raw: unknown): EventAiAssessment | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { version?: string; assessment?: EventAiAssessment };
  return obj.version === AI_ANALYSIS_VERSION && obj.assessment ? obj.assessment : null;
}

async function cacheAssessment(eventId: number, assessment: EventAiAssessment, note: string | null): Promise<void> {
  try {
    await prismaClient.intelligence_news_events.update({
      where: { event_id: eventId },
      data: {
        ai_analysis: JSON.parse(
          JSON.stringify({
            version: AI_ANALYSIS_VERSION,
            at: new Date().toISOString(),
            note,
            assessment,
          }),
        ),
      },
    });
  } catch (error) {
    console.error(`[ai-event] failed to cache analysis for event ${eventId}:`, (error as Error).message);
  }
}
