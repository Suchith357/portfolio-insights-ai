/**
 * Intelligence (Phase 2 + Phase 3) — maps to /api/intelligence.
 * The backend scopes every query to the authenticated user.
 */
import { apiRequest } from "./api-client";

export interface PortfolioImpact {
  id: string;
  eventId: string;
  eventTitle: string;
  eventCategory: string;
  eventDetectedAt: string;
  exposureType: "DIRECT_HOLDING" | "WATCHLIST" | "SECTOR_EXPOSURE" | string;
  portfolioId: string | null;
  portfolioName: string | null;
  stockId: string | null;
  symbol: string | null;
  stockSector: string | null;
  portfolioWeightPct: number | null;
  sectorWeightPct: number | null;
  userAggregateWeightPct: number | null;
  direction: "POSITIVE" | "NEGATIVE" | "MIXED" | "UNCERTAIN" | "NEUTRAL" | null;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  alertCandidate: string;
  relevance: number | null;
  confidence: number | null;
  explanation: string;
  priceAsOf: string | null;
  detectedAt: string;
}

export interface ExposureSnapshot {
  priceAsOf: string | null;
  stalePrices: boolean;
  portfolios: Array<{
    portfolioId: string;
    portfolioName: string;
    totalValue: number;
    priceAsOf: string | null;
    stalePrices: boolean;
    holdings: Array<{
      stockId: string;
      symbol: string;
      sector: string;
      quantity: number;
      latestPrice: number | null;
      priceAsOf: string | null;
      marketValue: number;
      portfolioWeightPct: number | null;
    }>;
    sectors: Array<{ sector: string; weightPct: number; value: number }>;
  }>;
  userAggregate: Array<{ stockId: string; value: number; weightPct: number | null }>;
  watchlistStockIds: string[];
}

export interface ImpactsQuery {
  severity?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | undefined;
  direction?: "POSITIVE" | "NEGATIVE" | "MIXED" | "UNCERTAIN" | "NEUTRAL" | undefined;
  exposureType?: string | undefined;
  portfolioId?: number | undefined;
  stockId?: number | undefined;
  limit?: number | undefined;
}

export async function getMyImpacts(query: ImpactsQuery = {}): Promise<PortfolioImpact[]> {
  const params = new URLSearchParams();
  if (query.severity) params.set("severity", query.severity);
  if (query.direction) params.set("direction", query.direction);
  if (query.exposureType) params.set("exposureType", query.exposureType);
  if (query.portfolioId !== undefined) params.set("portfolioId", String(query.portfolioId));
  if (query.stockId !== undefined) params.set("stockId", String(query.stockId));
  params.set("limit", String(query.limit ?? 25));
  return apiRequest<PortfolioImpact[]>(`/intelligence/portfolio/impacts?${params.toString()}`);
}

export async function getMyExposure(): Promise<ExposureSnapshot> {
  return apiRequest<ExposureSnapshot>("/intelligence/portfolio/exposure");
}

/* -------------------------------------------------------------------------- */
/* Phase 3                                                                    */
/* -------------------------------------------------------------------------- */

export interface IntelligenceAlert {
  id: string;
  title: string;
  message: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  alertType: string;
  symbol: string | null;
  isRead: boolean;
  createdAt: string;
  eventId: string | null;
  eventCategory: string | null;
}

export interface EventDetail {
  eventId: string;
  category: string;
  title: string;
  summary: string | null;
  detectedAt: string;
  eventTime: string | null;
  updatedAt: string;
  status: string;
  severity: number | null;
  relevance: number | null;
  confidence: number | null;
  materialUpdates: number;
  articleCount: number;
  affectedStocks: Array<{
    stockId: string;
    symbol: string | null;
    entityName: string;
    relationshipType: string;
    matchConfidence: string | null;
    direction: string | null;
    relevance: number | null;
  }>;
  affectedSectors: string[];
  evidence: {
    articles: Array<{
      articleId: number;
      title: string;
      url: string;
      sourceName: string | null;
      publishedAt: string;
    }>;
    sources: string[];
    articleCount: number;
  };
  myImpacts: Array<{
    impactId: string;
    exposureType: string;
    portfolioName: string | null;
    portfolioWeightPct: number | null;
    sectorWeightPct: number | null;
    direction: string | null;
    severity: string;
    explanation: string;
  }>;
}

export interface StockIntelligence {
  stockId: string;
  symbol: string;
  recentEventCount: number;
  latest: {
    eventId: string;
    title: string;
    category: string;
    relationshipType: string;
    severity: number | null;
    direction: string | null;
    confidence: number | null;
    status: string;
    detectedAt: string;
  } | null;
  events: Array<{
    eventId: string;
    title: string;
    category: string;
    relationshipType: string;
    severity: number | null;
    direction: string | null;
    confidence: number | null;
    status: string;
    detectedAt: string;
  }>;
}

export interface IntelligenceSummary {
  alerts: { total: number; unread: number };
  stockSummaries: Array<{
    stockId: string;
    symbol: string;
    exposurePct: number | null;
    relevantEvents: number;
    latestSeverity: string | null;
    latestDirection: string | null;
  }>;
}

export async function getMyIntelligenceAlerts(limit = 50): Promise<IntelligenceAlert[]> {
  return apiRequest<IntelligenceAlert[]>(`/intelligence/alerts?limit=${limit}`);
}

export async function markIntelligenceAlertRead(id: string): Promise<{ alertId: string; alreadyRead: boolean }> {
  return apiRequest<{ alertId: string; alreadyRead: boolean }>(`/intelligence/alerts/${id}/read`, {
    method: "POST",
  });
}

export async function getEventDetail(eventId: string): Promise<EventDetail> {
  return apiRequest<EventDetail>(`/intelligence/events/${eventId}`);
}

export async function getStockIntelligence(stockId: string, limit = 5): Promise<StockIntelligence> {
  return apiRequest<StockIntelligence>(`/intelligence/stocks/${stockId}?limit=${limit}`);
}

export async function getMySummary(): Promise<IntelligenceSummary> {
  return apiRequest<IntelligenceSummary>("/intelligence/summary");
}
