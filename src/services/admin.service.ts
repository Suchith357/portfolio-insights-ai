/**
 * Admin — maps to `/api/admin` on the Express backend.
 * Route visibility is a UX concern only; the backend enforces the ADMIN role
 * on every one of these endpoints.
 */
import { ADMIN_USER_LIST, DEMO_AUDIT_LOG, STOCKS } from "@/lib/demo-data";
import type { AdminStats, AuditLogEntry, Stock, User } from "@/types";
import { USE_DEMO_DATA, apiRequest, delay } from "./api-client";
import { db } from "./demo-store";

export type { AdminStats };

export async function getStats(): Promise<AdminStats> {
  if (USE_DEMO_DATA) {
    const store = db();
    return delay({
      totalUsers: ADMIN_USER_LIST.length,
      userRoleUsers: ADMIN_USER_LIST.filter((u) => u.role === "USER").length,
      adminUsers: ADMIN_USER_LIST.filter((u) => u.role === "ADMIN").length,
      totalPortfolios: store.portfolios.length,
      totalHoldings: store.holdings.length,
      totalTransactions: store.transactions.length,
      totalAlerts: store.alerts.length,
      totalStocks: STOCKS.length,
      stocksUsingRealData: 0,
      lastMarketDataSync: null,
      lastMarketDataStatus: null,
    });
  }
  return apiRequest<AdminStats>("/admin/stats");
}

export async function listUsers(): Promise<User[]> {
  if (USE_DEMO_DATA) return delay(ADMIN_USER_LIST);
  return apiRequest<User[]>("/admin/users");
}

export async function listManagedStocks(): Promise<Stock[]> {
  if (USE_DEMO_DATA) return delay(STOCKS);
  return apiRequest<Stock[]>("/admin/stocks");
}

export async function listAuditLog(): Promise<AuditLogEntry[]> {
  if (USE_DEMO_DATA) return delay(DEMO_AUDIT_LOG);
  return apiRequest<AuditLogEntry[]>("/admin/audit-logs");
}

/** Shape of GET /api/admin/market-data/status. */
export interface MarketDataSyncStatus {
  running: boolean;
  last: {
    id: string;
    triggerType: string;
    mode: string;
    status: "SUCCESS" | "PARTIAL" | "FAILED";
    startedAt: string;
    finishedAt: string | null;
    stocksProcessed: number;
    pricesUpserted: number;
    fundamentalsUpdated: number;
    failures: number;
    errorMessage: string | null;
  } | null;
}

/** Latest market-data sync state (ADMIN only). */
export async function getMarketDataStatus(): Promise<MarketDataSyncStatus> {
  return apiRequest<MarketDataSyncStatus>("/admin/market-data/status");
}

/** Triggers a manual refresh (ADMIN only); returns 202 with acceptance info. */
export async function triggerMarketDataSync(
  mode: "LATEST" | "FULL" = "LATEST",
  confirm = false,
): Promise<{ started: boolean; message: string }> {
  return apiRequest<MarketDataSyncStarted>(
    `/admin/market-data/sync?mode=${mode}${confirm ? "&confirm=true" : ""}`,
    { method: "POST" },
  );
}

interface MarketDataSyncStarted {
  started: boolean;
  message: string;
}

// ============================================================================
// Intelligence Engine — Phase 1 news foundation (ADMIN only endpoints)
// ============================================================================

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
  };
  lastCleanup: { ranAt: string; articlesDeleted: number; eventsDeleted: number } | null;
}

export interface IntelligenceNewsArticle {
  id: number;
  provider: string;
  title: string;
  description: string | null;
  url: string;
  sourceName: string | null;
  language: string | null;
  publishedAt: string;
  fetchedAt: string;
  expiresAt: string;
  processingStatus: string;
  matchedStocks: Array<{
    symbol: string | null;
    entityName: string;
    sentimentLabel: string | null;
    sentimentScore: number | null;
    relevanceScore: number | null;
  }>;
}

export interface IntelligenceEvent {
  id: number;
  category: string;
  title: string;
  summary: string | null;
  detectedAt: string;
  eventTime: string | null;
  severity: number | null;
  confidence: number | null;
  relevance: number | null;
  status: string;
  expiresAt: string | null;
  entities: Array<{
    stockId: number | null;
    entityName: string;
    relationshipType: string;
    direction: string | null;
    relevance: number | null;
  }>;
}

export async function getIntelligenceStatus(): Promise<IntelligenceStatus> {
  return apiRequest<IntelligenceStatus>("/admin/intelligence/news/status");
}

export async function getIntelligenceRecentNews(limit = 20): Promise<IntelligenceNewsArticle[]> {
  return apiRequest<IntelligenceNewsArticle[]>(`/admin/intelligence/news/recent?limit=${limit}`);
}

export async function getIntelligenceRecentEvents(limit = 20): Promise<IntelligenceEvent[]> {
  return apiRequest<IntelligenceEvent[]>(`/admin/intelligence/events/recent?limit=${limit}`);
}

/** Manual news fetch (ADMIN only); 202 acceptance — poll status for results. */
export async function triggerIntelligenceFetch(companyScans = 0): Promise<{ started: boolean; message: string }> {
  return apiRequest(`/admin/intelligence/news/fetch?companyScans=${companyScans}`, { method: "POST" });
}

export async function triggerIntelligenceCleanup(): Promise<{
  ranAt: string;
  articlesDeleted: number;
  entitiesDeleted: number;
  eventsDeleted: number;
  eventEntitiesDeleted: number;
  errors: string[];
}> {
  return apiRequest("/admin/intelligence/news/cleanup", { method: "POST" });
}
