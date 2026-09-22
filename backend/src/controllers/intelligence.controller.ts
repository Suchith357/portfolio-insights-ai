/**
 * Intelligence admin endpoints (Phase 1) — mounted under /api/admin and
 * therefore behind requireAuth + requireAdmin (see admin.routes.ts).
 *
 *   GET  /api/admin/intelligence/news/status
 *   GET  /api/admin/intelligence/news/recent
 *   GET  /api/admin/intelligence/events/recent
 *   POST /api/admin/intelligence/news/fetch
 *   POST /api/admin/intelligence/news/cleanup
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.js";
import { ok } from "../utils/http.js";
import { recordAudit } from "../utils/audit.js";
import { currentUser } from "../middleware/auth.js";
import * as statusService from "../services/news/intelligence-status.js";
import { benchmarkStatus } from "../services/benchmark.service.js";
import { snapshotStatus } from "../services/risk-snapshot.service.js";

/** Phase 7 diagnostics payload for the risk-status endpoint. */
async function benchmarkStatusPayload() {
  try {
    const s = await benchmarkStatus();
    return { available: s.priceCount > 0, symbol: s.benchmark, priceCount: s.priceCount, oldestDate: s.oldestDate, latestDate: s.latestDate, reason: s.priceCount > 0 ? null : "Benchmark row exists but no prices have been synced yet." };
  } catch (e) {
    return { available: false, symbol: null, priceCount: 0, oldestDate: null, latestDate: null, reason: e instanceof Error ? e.message : "Benchmark status unavailable" };
  }
}

async function snapshotStatusPayload() {
  try {
    return await snapshotStatus();
  } catch (e) {
    return { totalSnapshots: 0, portfoliosWithSnapshots: 0, latestSnapshotDate: null, calculationVersion: "risk-v1", error: e instanceof Error ? e.message : "Snapshot status unavailable" };
  }
}
import { runIngest, isIngestRunning } from "../services/news/news-ingest.js";
import { cleanupExpiredIntelligenceData } from "../services/news/intelligence-cleanup.js";
import * as exposureService from "../services/news/event-impact.service.js";
import { isExposureProcessing } from "../services/news/event-impact.service.js";
import { deliverAlerts, isAlertDeliveryRunning } from "../services/news/alert-delivery.service.js";

export const getStatus = asyncHandler(async (_req, res) => {
  ok(res, await statusService.getIntelligenceStatus());
});

const recentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const getRecentNews = asyncHandler(async (req, res) => {
  const { limit } = recentQuerySchema.parse(req.query);
  const articles = await prismaSafeArticles(limit);
  ok(res, articles);
});

async function prismaSafeArticles(limit: number) {
  const { prisma } = await import("../utils/prisma.js");
  const rows = await prisma.intelligence_news_articles.findMany({
    orderBy: { published_at: "desc" },
    take: limit,
    include: {
      entities: {
        where: { stock_id: { not: null } },
        select: {
          matched_symbol: true,
          entity_name: true,
          sentiment_label: true,
          sentiment_score: true,
          relevance_score: true,
        },
      },
    },
  });
  return rows.map((r) => ({
    id: r.article_id,
    provider: r.provider,
    title: r.title,
    description: r.description,
    url: r.url,
    sourceName: r.source_name,
    language: r.language,
    publishedAt: r.published_at.toISOString(),
    fetchedAt: r.fetched_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    processingStatus: r.processing_status,
    matchedStocks: r.entities.map((e) => ({
      symbol: e.matched_symbol,
      entityName: e.entity_name,
      sentimentLabel: e.sentiment_label,
      sentimentScore: e.sentiment_score === null ? null : Number(e.sentiment_score),
      relevanceScore: e.relevance_score === null ? null : Number(e.relevance_score),
    })),
  }));
}

export const getRecentEvents = asyncHandler(async (req, res) => {
  const { limit } = recentQuerySchema.parse(req.query);
  const { prisma } = await import("../utils/prisma.js");
  const rows = await prisma.intelligence_news_events.findMany({
    orderBy: { detected_at: "desc" },
    take: limit,
    include: {
      event_entities: {
        select: { stock_id: true, entity_name: true, relationship_type: true, direction: true, relevance: true },
      },
    },
  });
  ok(
    res,
    rows.map((r) => ({
      id: r.event_id,
      category: r.category,
      title: r.title,
      summary: r.summary,
      detectedAt: r.detected_at.toISOString(),
      eventTime: r.event_time?.toISOString() ?? null,
      severity: r.severity,
      confidence: r.confidence === null ? null : Number(r.confidence),
      relevance: r.relevance === null ? null : Number(r.relevance),
      status: r.status,
      sourceArticleIds: r.source_article_ids ?? null,
      expiresAt: r.expires_at?.toISOString() ?? null,
      entities: r.event_entities.map((e) => ({
        stockId: e.stock_id,
        entityName: e.entity_name,
        relationshipType: e.relationship_type,
        direction: e.direction,
        relevance: e.relevance === null ? null : Number(e.relevance),
      })),
    })),
  );
});

/** Manual fetch (ADMIN only). Single-flight; 202 when one is already running. */
export const triggerFetch = asyncHandler(async (req: Request, res: Response) => {
  const querySchema = z.object({ companyScans: z.coerce.number().int().min(0).max(38).default(0) });
  const { companyScans } = querySchema.parse(req.query);

  if (isIngestRunning()) {
    ok(res, { started: false, message: "A news fetch is already running." }, 202);
    return;
  }
  const userId = currentUser(req).userId;
  // Fire-and-forget: providers can take seconds; report acceptance now.
  void runIngest({ trigger: "MANUAL", companyScans })
    .then((summary) => {
      void recordAudit({
        userId,
        action: "INTELLIGENCE_FETCH",
        entityType: "INTELLIGENCE",
        details: `Manual news fetch via ${summary.provider}: fetched=${summary.fetched} stored=${summary.stored} dupes=${summary.duplicates} events=${summary.eventsCreated} failures=${summary.failures}.`,
      });
    })
    .catch((error) => {
      console.error("[intelligence] manual fetch failed:", error instanceof Error ? error.message : error);
    });
  ok(res, { started: true, message: `News fetch started (${companyScans} company scans).` }, 202);
});

/**
 * Exposure processing (ADMIN only) — maps recent events to user portfolios.
 * Idempotent + bounded; one event failing never fails the batch.
 */
export const triggerExposureProcess = asyncHandler(async (req: Request, res: Response) => {
  const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) });
  const { limit } = querySchema.parse(req.query);
  if (isExposureProcessing()) {
    ok(res, { started: false, message: "An exposure-processing run is already in progress." }, 202);
    return;
  }
  // Bounded and fast enough to run inline (events × users, both small).
  const summary = await exposureService.processRecentEvents(limit);
  await exposureService.auditExposureRun(currentUser(req).userId, summary);
  ok(res, summary, summary.status === "FAILED" ? 500 : 200);
});

/**
 * Alert delivery (ADMIN only, Phase 3) — promotes alert candidates into real
 * alerts rows. Idempotent (same event never duplicates), bounded, audited.
 */
export const triggerAlertDelivery = asyncHandler(async (req: Request, res: Response) => {
  const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(300).default(100) });
  const { limit } = querySchema.parse(req.query);
  if (isAlertDeliveryRunning()) {
    ok(res, { started: false, message: "An alert-delivery run is already in progress." }, 202);
    return;
  }
  const summary = await deliverAlerts(limit);
  await recordAudit({
    userId: currentUser(req).userId,
    action: "INTELLIGENCE_ALERT_GENERATED",
    entityType: "INTELLIGENCE",
    details: `Manual alert delivery (${summary.status}): candidates=${summary.candidatesConsidered} created=${summary.alertsCreated} dup-skipped=${summary.skippedDuplicate} cooldown-skipped=${summary.skippedCooldown} failures=${summary.failures.length}.`,
  });
  ok(res, summary, summary.status === "FAILED" ? 500 : 200);
});

export const getSystemImpacts = asyncHandler(async (req: Request, res: Response) => {
  const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
  const { limit } = querySchema.parse(req.query);
  const impacts = await exposureService.getSystemImpacts(limit);
  ok(res, impacts);
});

/** Manual cleanup (ADMIN only) — synchronous; expired-row purge is fast. */
export const triggerCleanup = asyncHandler(async (req: Request, res: Response) => {
  const summary = await cleanupExpiredIntelligenceData();
  await recordAudit({
    userId: currentUser(req).userId,
    action: "INTELLIGENCE_CLEANUP",
    entityType: "INTELLIGENCE",
    details: `Manual intelligence cleanup: articles=${summary.articlesDeleted} entities=${summary.entitiesDeleted} events=${summary.eventsDeleted} event_entities=${summary.eventEntitiesDeleted}${summary.errors.length > 0 ? ` errors=${summary.errors.length}` : ""}.`,
  });
  ok(res, summary);
});

// ---------------------------------------------------------------------------
// Phase 4/5 — quantitative diagnostics (ADMIN only, no user portfolio data)
// ---------------------------------------------------------------------------

/** Risk-engine data availability: aligned-observation coverage across the universe. */
export const riskStatus = asyncHandler(async (_req: Request, res: Response) => {
  const { prisma } = await import("../utils/prisma.js");
  const [priceSpan, perStockCounts, eventCount] = await Promise.all([
    prisma.$queryRaw<Array<{ min_d: Date | null; max_d: Date | null }>>`
      SELECT MIN(price_date) AS min_d, MAX(price_date) AS max_d FROM stock_prices`,
    prisma.$queryRaw<Array<{ obs: number; stocks: number }>>`
      SELECT cnt AS obs, COUNT(*)::int AS stocks FROM (
        SELECT stock_id, COUNT(*)::int AS cnt FROM stock_prices GROUP BY stock_id
      ) x GROUP BY cnt ORDER BY cnt DESC LIMIT 5`,
    prisma.intelligence_news_events.count(),
  ]);
  ok(res, {
    riskModelVersion: "v1",
    benchmark: await benchmarkStatusPayload(),
    snapshots: await snapshotStatusPayload(),
    priceSpan: {
      oldest: priceSpan[0]?.min_d?.toISOString().slice(0, 10) ?? null,
      latest: priceSpan[0]?.max_d?.toISOString().slice(0, 10) ?? null,
    },
    observationsPerStockTop5: perStockCounts.map((r) => ({ observations: r.obs, stocks: r.stocks })),
    analogueEvents: eventCount,
    scenarioEngine: { status: "READY", note: "Stateless on-demand calculations; no cached runs." },
  });
});

/** Analogue-engine diagnostics: event counts available for matching. */
export const analogueStatus = asyncHandler(async (_req: Request, res: Response) => {
  const { prisma } = await import("../utils/prisma.js");
  const [total, withEntities, earliest] = await Promise.all([
    prisma.intelligence_news_events.count(),
    prisma.intelligence_event_entities.groupBy({ by: ["event_id"], _count: { event_entity_id: true } }),
    prisma.intelligence_news_events.findFirst({ orderBy: { detected_at: "asc" }, select: { detected_at: true } }),
  ]);
  ok(res, {
    totalEvents: total,
    eventsWithEntities: withEntities.length,
    earliestEvent: earliest?.detected_at.toISOString() ?? null,
    note: "Analogue matching uses stored events only; the corpus grows as the news pipeline runs.",
  });
});
