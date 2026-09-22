/**
 * News ingest pipeline (Intelligence Engine, Phase 1 → Requirements 1–3).
 *
 *   FETCH (ALL providers, concurrently) → NORMALIZE → CROSS-PROVIDER DEDUP
 *     → RELEVANCE FILTER → STORE TEMPORARILY (72h TTL)
 *     → EXTRACT/MATCH ENTITIES → CREATE/ENRICH EVENT
 *     → (scheduler) PORTFOLIO EXPOSURE → ALERTS
 *
 * Guarantees:
 *  - MULTI-PROVIDER (Req 1): every configured provider is queried; one
 *    provider's 429/timeout/malformed payload never affects the others and
 *    never fails the run. Outcomes are logged per provider (Req 13).
 *  - Dedup happens at TWO layers: aggregator-level (same URL / same
 *    publisher+title across providers) and store-level (unique
 *    (provider, provider_article_id) — refreshes count skipped duplicates).
 *  - RELEVANCE (Req 2): India/finance relevance + recency scoring BEFORE
 *    storage keeps generic low-value articles out of the intelligence layer.
 *  - Raw rows are EPHEMERAL: expires_at = received_at + NEWS_RETENTION_HOURS
 *    (single configuration point: env.newsRetentionHours — 72h by default).
 *  - A single-flight lock prevents overlapping runs (scheduler + manual).
 */
import { prisma } from "../../utils/prisma.js";
import { env } from "../../utils/env.js";
import { fetchFromAllProviders } from "./news-registry.js";
import { buildStockAliasIndex, matchArticleToStocks } from "./entity-matcher.js";
import { categoriseArticle } from "./event-categoriser.js";
import { upsertEventForArticle } from "./event-lifecycle.service.js";
import { analyzeEvent } from "./ai-event-analysis.service.js";
import { appendDocuments } from "../../ai/indexer.js";
import { eventDocument } from "../../ai/document-builders.js";
import type { KnowledgeDocument } from "../../ai/types.js";
import { ProviderUnavailableError } from "./news-provider.js";
import type { NormalizedArticle } from "./news-provider.js";

export interface IngestSummary {
  provider: string;
  degradedFrom: string | null;
  status: "SUCCESS" | "PARTIAL" | "UNAVAILABLE" | "FAILED";
  startedAt: string;
  finishedAt: string;
  fetched: number;
  duplicates: number;
  stored: number;
  entitiesMatched: number;
  eventsCreated: number;
  failures: number;
  providerOutcomes: Array<{ provider: string; ok: boolean; count: number; error: string | null }>;
  /** Articles dropped by the relevance filter before storage (Req 2). */
  relevanceDropped: number;
  /** Human-readable reason when status is UNAVAILABLE/FAILED/PARTIAL. */
  message: string | null;
  /** Feature B: important events that received (or refused) AI analysis. */
  aiAnalyses?: number;
  /** Feature B: documents appended to the FAISS index this run. */
  aiIndexAppended?: number;
}

let running = false;

/** True while an ingest is in flight (manual endpoint + status use this). */
export function isIngestRunning(): boolean {
  return running;
}

/** Options for one pipeline run. */
export interface RunIngestOptions {
  trigger: "SCHEDULED" | "MANUAL" | "STARTUP";
  /** Also query per-company news for the largest-N stocks by market cap. */
  companyScans?: number;
}

// ---------------------------------------------------------------------------
// Req 2: relevance filtering — "fewer but more relevant" beats volume.
// ---------------------------------------------------------------------------

/** Tokens that indicate Indian-market / finance relevance. */
const FINANCE_TOKENS = [
  "stock", "share", "shares", "nifty", "sensex", "bse", "nse", "rupee", "₹",
  "profit", "revenue", "earnings", "quarter", "results", "dividend", "ipo",
  "brokerage", "investor", "investors", "market", "markets", "equity", "fii",
  "dii", "rbi", "sebi", "tariff", "regulation", "regulatory", "policy",
  "merger", "acquisition", "stake", "buyback", "guidance", "capex", "debt",
  "gdp", "inflation", "cpi", "rate", "rates", "crude", "commodity", "export",
  "imports", "bank", "banking", "sector", "index", "trading", "traded",
];

/** India-scoping tokens — the portfolio universe is NSE-listed companies. */
const INDIA_TOKENS = [
  "india", "indian", "mumbai", "delhi", "bengaluru", "nifty", "sensex",
  "rbi", "sebi", "gstin", "gst", "rupee", "inr", "new delhi", "maharashtra",
  "gujarat", "tamil", "karnataka", "nseso", ".ns", "ltd", "limited", "bharat",
];

function relevanceScore(a: NormalizedArticle): { score: number; reason: string } {
  const text = `${a.title} ${a.description ?? ""}`.toLowerCase();
  let score = 0;
  const financeHits = FINANCE_TOKENS.filter((t) => text.includes(t)).length;
  if (financeHits > 0) score += Math.min(0.5, financeHits * 0.15);
  const indiaHits = INDIA_TOKENS.filter((t) => text.includes(t)).length;
  if (indiaHits > 0) score += Math.min(0.3, indiaHits * 0.12);
  // Recency: fresher articles matter more for the 45-minute monitoring loop.
  const ageH = (Date.now() - a.publishedAt.getTime()) / 3_600_000;
  if (ageH <= 2) score += 0.25;
  else if (ageH <= 12) score += 0.15;
  else if (ageH <= 36) score += 0.05;
  // Known publisher domains carry more editorial signal than scrapers.
  if (a.sourceName && /\.(in|co\.in|indiatimes|moneycontrol|livemint|economictimes|business-standard|ndtv|reuters|bloomberg)/i.test(a.sourceName)) {
    score += 0.1;
  }
  const reason =
    financeHits > 0 || indiaHits > 0
      ? `finance=${financeHits} india=${indiaHits} age=${ageH.toFixed(1)}h`
      : `no finance/india signal (age=${ageH.toFixed(1)}h)`;
  return { score: Number(score.toFixed(2)), reason };
}

/** Market-wide feeds mix in generic world news — filter them. Scoped feeds
 *  (company/sector queries) are already targeted, so they skip the filter. */
export function isRelevantForMarketFeed(a: NormalizedArticle): boolean {
  return relevanceScore(a).score >= 0.3;
}

export async function runIngest(options: RunIngestOptions): Promise<IngestSummary> {
  if (running) {
    throw new Error("A news ingest is already running.");
  }
  running = true;
  const startedAt = new Date();

  const summary: IngestSummary = {
    provider: "aggregate",
    degradedFrom: null,
    status: "SUCCESS",
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    fetched: 0,
    duplicates: 0,
    stored: 0,
    entitiesMatched: 0,
    eventsCreated: 0,
    failures: 0,
    providerOutcomes: [],
    relevanceDropped: 0,
    message: null,
  };

  try {
    // Req 1: on STARTUP fetch only the last ~1 hour (configurable); scheduled
    // runs use the retention-window lookback. Both stay inside the TTL.
    const sinceHours = options.trigger === "STARTUP"
      ? env.newsStartupWindowHours
      : Math.max(6, env.newsRetentionHours);
    const fetchOpts = { limit: env.newsFetchLimit, sinceHours };

    console.log(
      `[intelligence] ${options.trigger} ingest started (providers=ALL concurrent, companyScans=${options.companyScans ?? 0}, window=${sinceHours}h)`,
    );

    // 1) Broad market feed from EVERY configured provider, concurrently.
    //    One provider's failure is logged + recorded; the run continues.
    console.log("[intelligence] fetching market feed via all providers");
    const market = await fetchFromAllProviders(fetchOpts);
    summary.providerOutcomes = market.providerOutcomes;
    summary.failures += market.providerOutcomes.filter((o) => !o.ok).length;
    const marketFailure = market.providerOutcomes.find((o) => !o.ok);
    if (marketFailure) summary.message = `market feed: ${marketFailure.provider}: ${marketFailure.error}`;

    // 2) Optional per-company scans (top N stocks by market cap). Each scan
    //    hits every provider concurrently; per-provider isolation applies.
    const batches: NormalizedArticle[][] = [];
    const marketFiltered: NormalizedArticle[] = [];
    for (const a of market.articles) {
      if (isRelevantForMarketFeed(a)) marketFiltered.push(a);
      else summary.relevanceDropped += 1;
    }
    batches.push(marketFiltered);
    console.log(
      `[intelligence] market feed: ${market.articles.length} raw → ${marketFiltered.length} relevant (${summary.relevanceDropped} dropped by relevance filter)`,
    );

    const companyScans = options.companyScans ?? 0;
    if (companyScans > 0) {
      const top = await prisma.stocks.findMany({
        where: { is_active: true },
        orderBy: { market_cap: "desc" },
        take: companyScans,
        select: { symbol: true, company_name: true },
      });
      for (const stock of top) {
        const res = await fetchFromAllProviders(fetchOpts, (p) =>
          p.fetchCompanyNews(stock.symbol, stock.company_name, fetchOpts),
        );
        summary.providerOutcomes.push(...res.providerOutcomes);
        summary.failures += res.providerOutcomes.filter((o) => !o.ok).length;
        batches.push(res.articles);
      }
    }

    // 3) Req 1: sector scans — the user holds stocks in these sectors, so
    //    sector-level news (policy, regulation, commodity moves) must be
    //    fetched even when the broad feed misses it. Failures here never stop
    //    the run (per-provider + per-query isolation).
    const heldSectors = await prisma.holdings.findMany({
      select: { stocks: { select: { sector: true } } },
      distinct: ["stock_id"],
    });
    const sectors = Array.from(new Set(heldSectors.map((h) => h.stocks?.sector).filter((s): s is string => Boolean(s)))).slice(0, 6);
    if (sectors.length > 0) {
      console.log(`[intelligence] sector scans: ${sectors.join(", ")}`);
      for (const sector of sectors) {
        const res = await fetchFromAllProviders(fetchOpts, (p) =>
          p.fetchSectorNews ? p.fetchSectorNews(sector, fetchOpts) : Promise.resolve([]),
        );
        summary.providerOutcomes.push(...res.providerOutcomes);
        summary.failures += res.providerOutcomes.filter((o) => !o.ok).length;
        if (res.articles.length > 0) batches.push(res.articles);
      }
    }

    const articles = batches.flat();
    summary.fetched = articles.length;

    if (articles.length > 0) {
      const aliasIndex = await buildStockAliasIndex();

      // Store-level dedup pre-check across ALL providers at once: keeps
      // expected duplicates from hitting the unique constraint per row.
      // Keyed by (provider, id) — cross-provider copies were already merged
      // by the aggregator (same URL/publisher+title → kept once).
      const existingKeys = new Set(
        (
          await prisma.intelligence_news_articles.findMany({
            where: { provider_article_id: { in: Array.from(new Set(articles.map((a) => a.providerArticleId))) } },
            select: { provider: true, provider_article_id: true },
          })
        ).map((r) => `${r.provider}:${r.provider_article_id}`),
      );

      for (const article of articles) {
        // Received instant is uniform per run — used for TTL arithmetic.
        const receivedAt = new Date();
        const expiresAt = new Date(receivedAt.getTime() + env.newsRetentionHours * 3_600_000);

        // Provenance: the ORIGIN provider survives aggregation via the
        // metadata stamp added by news-registry; fall back to "aggregate".
        const originProvider =
          typeof (article.metadata as Record<string, unknown> | undefined)?.originProvider === "string"
            ? ((article.metadata as Record<string, string>).originProvider as string)
            : "aggregate";

        // Store-level dedup: the aggregator already merged cross-provider
        // copies; this catches re-runs of the SAME origin article.
        if (existingKeys.has(`${originProvider}:${article.providerArticleId}`)) {
          summary.duplicates += 1;
          continue;
        }

        // DEDUPLICATE + STORE TEMPORARILY: unique (provider, provider_article_id).
        let stored;
        try {
          stored = await prisma.intelligence_news_articles.create({
            data: {
              provider: originProvider,
              provider_article_id: article.providerArticleId,
              title: article.title,
              description: article.description,
              url: article.url,
              source_name: article.sourceName,
              language: article.language,
              published_at: article.publishedAt,
              received_at: receivedAt,
              fetched_at: receivedAt,
              expires_at: expiresAt,
              processing_status: "PROCESSED",
              processed_at: receivedAt,
              raw_metadata: {
                ...(article.metadata as object | undefined),
              },
            },
            select: { article_id: true },
          });
          summary.stored += 1;
        } catch (error) {
          if (isUniqueViolation(error)) {
            summary.duplicates += 1; // already ingested — do not double-insert
          } else {
            summary.failures += 1;
            console.error("[intelligence] article store failed:", describe(error));
          }
          continue;
        }

        // EXTRACT / MATCH ENTITIES against the existing stock universe.
        const matches = matchArticleToStocks(
          { title: article.title, description: article.description, entities: article.entities },
          aliasIndex,
        );
        for (const match of matches) {
          await prisma.intelligence_news_entities.create({
            data: {
              article_id: stored.article_id,
              stock_id: match.stockId,
              matched_symbol: match.symbol,
              entity_name: match.matchedValue.slice(0, 200),
              entity_type: match.basis === "SECTOR_TEXT" ? "SECTOR" : "COMPANY",
              relevance_score: match.relevanceScore,
              sentiment_score: match.sentimentScore,
              sentiment_label: match.sentimentLabel,
              match_confidence: match.matchConfidence,
              provider_metadata: { basis: match.basis, confidence: match.confidence },
            },
          });
        }
        summary.entitiesMatched += matches.length;

        // CREATE OR ENRICH EVENT (Phase 3): one real-world announcement stays
        // ONE event row — further articles accumulate as evidence instead of
        // spawning duplicate events (see event-lifecycle.service.ts).
        if (matches.length > 0) {
          const categorised = categoriseArticle(article.title, article.description);
          const entitySentiments = matches
            .map((m) => m.sentimentScore)
            .filter((s): s is number => s !== null);
          const direction =
            entitySentiments.length > 0
              ? entitySentiments.reduce((a, b) => a + b, 0) / entitySentiments.length
              : null;
          const directionLabel =
            direction === null
              ? null
              : direction > 0.15
                ? "POSITIVE"
                : direction < -0.15
                  ? "NEGATIVE"
                  : "NEUTRAL";
          const eventResult = await upsertEventForArticle({
            category: categorised.category,
            title: article.title,
            summary: article.description,
            detectedAt: receivedAt,
            eventTime: article.publishedAt,
            severity: categorised.severity,
            relevance: Math.max(...matches.map((m) => m.confidence)),
            confidence: categorised.confidence,
            sourceArticleId: stored.article_id,
            sourceName: article.sourceName,
          });
          if (eventResult.created) summary.eventsCreated += 1;

          // Merge this article's matched stocks into the event's entity set
          // (idempotent per event+stock+relationship — no duplicate links).
          for (const match of matches) {
            const relationship = match.basis === "SECTOR_TEXT" ? "SECTOR" : "DIRECT";
            const existingLink = await prisma.intelligence_event_entities.findFirst({
              where: { event_id: eventResult.eventId, stock_id: match.stockId, relationship_type: relationship },
              select: { event_entity_id: true },
            });
            if (!existingLink) {
              await prisma.intelligence_event_entities.create({
                data: {
                  event_id: eventResult.eventId,
                  stock_id: match.stockId,
                  entity_name: match.matchedValue.slice(0, 200),
                  relationship_type: relationship,
                  relevance: match.confidence,
                  direction: directionLabel,
                  confidence: match.confidence,
                  match_confidence: match.matchConfidence,
                },
              });
            }
          }
        }
      }
    }

    const okOutcomes = summary.providerOutcomes.filter((o) => o.ok);
    if (summary.failures > 0 && summary.stored > 0) summary.status = "PARTIAL";
    else if (summary.failures > 0 && summary.stored === 0 && okOutcomes.length === 0) summary.status = "UNAVAILABLE";
    else if (summary.failures > 0) summary.status = "PARTIAL";

    // Req 13: compact per-provider run summary for the log reader.
    const failed = summary.providerOutcomes.filter((o) => !o.ok);
    console.log(
      `[intelligence] provider summary: ${okOutcomes.map((o) => `${o.provider}:${o.count}`).join(", ") || "none"}` +
        (failed.length > 0 ? ` | failed: ${failed.map((f) => `${f.provider} (${f.error ?? "unknown"})`).join(", ")}` : ""),
    );

    // Feature B: AI enrichment of important events + incremental RAG index
    // update. STRICTLY best-effort — every failure is caught and logged, the
    // news pipeline must keep working when Ollama/FAISS/LLM are unavailable.
    try {
      const enrichment = await enrichAfterIngest();
      summary.aiAnalyses = enrichment.analyses;
      summary.aiIndexAppended = enrichment.indexAppended;
      if (enrichment.note) summary.message = summary.message ? `${summary.message}; ${enrichment.note}` : enrichment.note;
    } catch (aiError) {
      console.warn(`[intelligence] post-ingest AI enrichment skipped: ${(aiError as Error).message}`);
    }

    summary.finishedAt = new Date().toISOString();
    return summary;
  } catch (error) {
    summary.status = "FAILED";
    summary.message = describe(error);
    summary.finishedAt = new Date().toISOString();
    console.error("[intelligence] ingest failed:", summary.message);
    return summary;
  } finally {
    running = false;
    void options;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Feature B post-ingest enrichment (all best-effort):
 *   1. score importance of events created/updated this run,
 *   2. run AI analysis on HIGH/CRITICAL events (grounded; refuses weakly),
 *   3. incrementally append the events as RAG documents.
 * Never throws into the ingest result path.
 */
async function enrichAfterIngest(): Promise<{ analyses: number; indexAppended: number; note: string | null }> {
  const notes: string[] = [];
  let analyses = 0;
  let indexAppended = 0;

  // Recent events touched by this run (bounded).
  const recent = await prisma.intelligence_news_events.findMany({
    orderBy: { detected_at: "desc" },
    take: 10,
    select: { event_id: true },
  });

  const importantDocs: KnowledgeDocument[] = [];
  for (const { event_id } of recent) {
    try {
      const outcome = await analyzeEvent(event_id, null);
      if (outcome.ran) analyses += 1;
      if (outcome.assessment && (outcome.assessment.importance === "HIGH" || outcome.assessment.importance === "CRITICAL")) {
        const ev = await prisma.intelligence_news_events.findUnique({
          where: { event_id },
          select: { event_id: true, category: true, title: true, summary: true, severity: true, relevance: true, confidence: true, detected_at: true, status: true },
        });
        if (ev) {
          const doc = eventDocument(ev);
          if (doc) importantDocs.push(doc);
        }
      }
    } catch (error) {
      notes.push(`event ${event_id}: ${(error as Error).message.slice(0, 80)}`);
    }
  }

  try {
    const append = await appendDocuments(importantDocs);
    indexAppended = append.appended;
    if (append.error) notes.push(`index: ${append.error}`);
  } catch (error) {
    notes.push(`index append failed: ${(error as Error).message.slice(0, 80)}`);
  }

  if (analyses > 0) console.log(`[intelligence] AI enrichment: ${analyses} event analysis request(s)`);
  return { analyses, indexAppended, note: notes.length ? `AI enrichment notes: ${notes.join("; ")}` : null };
}

function describe(error: unknown): string {
  if (error instanceof ProviderUnavailableError) {
    return `${error.providerId}: ${error.message}`;
  }
  // undici's network failures (TypeError: fetch failed) carry the real cause
  // (DNS failure, connection refused, ECONNRESET) in error.cause — surface it
  // so "fetch failed" never hides actionable information.
  if (error instanceof Error && error.message === "fetch failed" && "cause" in error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? cause.message : String(cause ?? "");
    return `network error: fetch failed (${causeMsg.slice(0, 120)})`;
  }
  return error instanceof Error ? error.message : String(error);
}
