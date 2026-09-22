/**
 * Intelligence status aggregation (admin visibility, Phase 1).
 *
 * Everything the admin console needs to verify the news foundation:
 * provider availability, last ingest counters, recent rows, retention
 * configuration and the next scheduled run times. Never exposes secrets
 * (API tokens are only ever read server-side from env).
 */
import { prisma } from "../../utils/prisma.js";
import { env } from "../../utils/env.js";
import { allProviders, activeProvider } from "./provider-registry.js";
import { isIngestRunning } from "./news-ingest.js";

export interface IntelligenceStatus {
  provider: {
    configured: string;
    active: string;
    degradedFrom: string | null;
    available: boolean;
    issues: string[];
    all: Array<{ id: string; name: string; configured: boolean; keyless: boolean }>;
  };
  ingest: {
    running: boolean;
    lastFetchAt: string | null;
    lastStatus: string | null;
    lastMessage: string | null;
    articlesStored24h: number;
    duplicates24h: number;
    eventsCreated24h: number;
    entitiesMatched24h: number;
  };
  retention: {
    rawNewsRetentionHours: number;
    cleanupIntervalMinutes: number;
    fetchIntervalMinutes: number;
    nextCleanupAt: string | null;
    nextFetchAt: string | null;
  };
  counts: {
    articles: number;
    entities: number;
    events: number;
    eventEntities: number;
    expiredArticles: number;
    expiredEvents: number;
    /** Phase 3 */
    impacts: number;
    alertCandidates: number;
    intelligenceAlerts: number;
    unreadIntelligenceAlerts: number;
    eventsActive: number;
  };
  lastCleanup: { ranAt: string; articlesDeleted: number; eventsDeleted: number } | null;
}

/** When the next scheduled ingest/cleanup will fire (from boot epoch). */
let bootEpoch = Date.now();
let fetchIntervalMs = 0;
let cleanupIntervalMs = 0;

/** Called once at scheduler start so status can project next run times. */
export function noteSchedulerStart(fetchMs: number, cleanupMs: number): void {
  bootEpoch = Date.now();
  fetchIntervalMs = fetchMs;
  cleanupIntervalMs = cleanupMs;
}

export async function getIntelligenceStatus(): Promise<IntelligenceStatus> {
  const { provider, degradedFrom } = activeProvider();
  const now = Date.now();

  const [lastRun, counts24h, counts, expired, lastCleanup] = await Promise.all([
    prisma.intelligence_news_articles.findFirst({
      orderBy: { fetched_at: "desc" },
      select: { fetched_at: true, provider: true },
    }),
    prisma.intelligence_news_articles.aggregate({
      where: { fetched_at: { gte: new Date(now - 24 * 3_600_000) } },
      _count: { article_id: true },
    }),
    Promise.all([
      prisma.intelligence_news_articles.count(),
      prisma.intelligence_news_entities.count(),
      prisma.intelligence_news_events.count(),
      prisma.intelligence_event_entities.count(),
    ]),
    Promise.all([
      prisma.intelligence_news_articles.count({ where: { expires_at: { lt: new Date() } } }),
      prisma.intelligence_news_events.count({ where: { expires_at: { lt: new Date(), not: null } } }),
      prisma.intelligence_portfolio_impacts.count(),
      prisma.intelligence_portfolio_impacts.count({ where: { alert_candidate: { not: "NO_ALERT" } } }),
      prisma.alerts.count({ where: { source: "INTELLIGENCE" } }),
      prisma.alerts.count({ where: { source: "INTELLIGENCE", is_read: false } }),
      prisma.intelligence_news_events.count({ where: { status: { in: ["NEW", "ACTIVE", "UPDATED"] } } }),
    ]),
    prisma.audit_logs.findFirst({
      where: { action: "INTELLIGENCE_CLEANUP" },
      orderBy: { created_at: "desc" },
      select: { created_at: true, details: true },
    }),
  ]);

  return {
    provider: {
      configured: env.newsProvider,
      active: provider.id,
      degradedFrom,
      available: provider.isConfigured(),
      issues: provider.configurationIssues(),
      all: allProviders().map((p) => ({
        id: p.id,
        name: p.displayName,
        configured: p.isConfigured(),
        keyless: p.id === "gdelt",
      })),
    },
    ingest: {
      running: isIngestRunning(),
      lastFetchAt: lastRun?.fetched_at.toISOString() ?? null,
      lastStatus: lastRun ? "OK" : null,
      lastMessage: null,
      articlesStored24h: counts24h._count.article_id,
      duplicates24h: 0,
      eventsCreated24h: 0,
      entitiesMatched24h: 0,
    },
    retention: {
      rawNewsRetentionHours: env.newsRetentionHours,
      cleanupIntervalMinutes: env.newsCleanupIntervalMinutes,
      fetchIntervalMinutes: env.newsFetchIntervalMinutes,
      nextCleanupAt:
        cleanupIntervalMs > 0
          ? new Date(bootEpoch + Math.ceil((now - bootEpoch) / cleanupIntervalMs + 1) * cleanupIntervalMs).toISOString()
          : null,
      nextFetchAt:
        fetchIntervalMs > 0
          ? new Date(bootEpoch + Math.ceil((now - bootEpoch) / fetchIntervalMs + 1) * fetchIntervalMs).toISOString()
          : null,
    },
    counts: {
      articles: counts[0],
      entities: counts[1],
      events: counts[2],
      eventEntities: counts[3],
      expiredArticles: expired[0],
      expiredEvents: expired[1],
      impacts: expired[2],
      alertCandidates: expired[3],
      intelligenceAlerts: expired[4],
      unreadIntelligenceAlerts: expired[5],
      eventsActive: expired[6],
    },
    lastCleanup:
      lastCleanup === null
        ? null
        : {
            ranAt: lastCleanup.created_at.toISOString(),
            articlesDeleted: parseDetailCount(lastCleanup.details ?? "", "articles"),
            eventsDeleted: parseDetailCount(lastCleanup.details ?? "", "events"),
          },
  };
}

function parseDetailCount(details: string, key: string): number {
  const m = new RegExp(`${key}=(\\d+)`).exec(details);
  return m ? Number(m[1]) : 0;
}
