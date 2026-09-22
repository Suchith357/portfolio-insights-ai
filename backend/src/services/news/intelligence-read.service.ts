/**
 * Intelligence read models (Phase 3 — Parts D/E/F).
 *
 * User-facing views over the intelligence layer with strict ownership:
 * every query is scoped to the authenticated user. Event detail shows the
 * EVIDENCE (sources) and the user's OWN exposure; other users' impacts are
 * never reachable.
 */
import { prisma } from "../../utils/prisma.js";
import { getEventEvidence } from "./event-lifecycle.service.js";

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
  evidence: Awaited<ReturnType<typeof getEventEvidence>>;
  /** The requesting user's own exposure rows for this event (never others'). */
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

/** Full event detail for the event-detail view (user-scoped exposure). */
export async function getEventDetailForUser(eventId: number, userId: number): Promise<EventDetail | null> {
  const event = await prisma.intelligence_news_events.findUnique({
    where: { event_id: eventId },
    include: {
      event_entities: {
        include: { stock: { select: { stock_id: true, symbol: true } } },
        orderBy: { relevance: "desc" },
      },
    },
  });
  if (!event) return null;

  const [evidence, myImpacts] = await Promise.all([
    getEventEvidence(eventId),
    prisma.intelligence_portfolio_impacts.findMany({
      where: { event_id: eventId, user_id: userId },
      include: { portfolio: { select: { name: true } } },
      orderBy: { impact_id: "asc" },
    }),
  ]);

  const sectors = new Set<string>();
  for (const e of event.event_entities) {
    if (e.relationship_type === "SECTOR") sectors.add(e.entity_name);
  }

  return {
    eventId: String(event.event_id),
    category: event.category,
    title: event.title,
    summary: event.summary,
    detectedAt: event.detected_at.toISOString(),
    eventTime: event.event_time?.toISOString() ?? null,
    updatedAt: event.updated_at.toISOString(),
    status: event.status,
    severity: event.severity,
    relevance: event.relevance === null ? null : Number(event.relevance),
    confidence: event.confidence === null ? null : Number(event.confidence),
    materialUpdates: event.material_updates,
    articleCount: event.article_count,
    affectedStocks: event.event_entities
      .filter((e) => e.stock_id !== null)
      .map((e) => ({
        stockId: String(e.stock_id),
        symbol: e.stock?.symbol ?? null,
        entityName: e.entity_name,
        relationshipType: e.relationship_type,
        matchConfidence: e.match_confidence,
        direction: e.direction,
        relevance: e.relevance === null ? null : Number(e.relevance),
      })),
    affectedSectors: Array.from(sectors),
    evidence,
    myImpacts: myImpacts.map((i) => ({
      impactId: String(i.impact_id),
      exposureType: i.exposure_type,
      portfolioName: i.portfolio?.name ?? null,
      portfolioWeightPct: i.portfolio_weight === null ? null : Number(i.portfolio_weight) * 100,
      sectorWeightPct: i.sector_weight === null ? null : Number(i.sector_weight) * 100,
      direction: i.direction,
      severity: i.impact_severity,
      explanation: i.explanation ?? "",
    })),
  };
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

/** Recent intelligence for one stock (authenticated users; no exposure data). */
export async function getStockIntelligence(stockId: number, limit = 5): Promise<StockIntelligence | null> {
  const stock = await prisma.stocks.findUnique({
    where: { stock_id: stockId },
    select: { stock_id: true, symbol: true },
  });
  if (!stock) return null;

  const links = await prisma.intelligence_event_entities.findMany({
    where: {
      stock_id: stockId,
      event: { OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] },
    },
    orderBy: { event: { detected_at: "desc" } },
    take: Math.min(20, Math.max(1, limit)),
    include: {
      event: {
        select: {
          event_id: true,
          title: true,
          category: true,
          severity: true,
          confidence: true,
          status: true,
          detected_at: true,
        },
      },
    },
  });

  const events = links.map((l) => ({
    eventId: String(l.event.event_id),
    title: l.event.title,
    category: l.event.category,
    relationshipType: l.relationship_type,
    severity: l.event.severity,
    direction: l.direction,
    confidence: l.confidence === null ? null : Number(l.confidence),
    status: l.event.status,
    detectedAt: l.event.detected_at.toISOString(),
  }));

  return {
    stockId: String(stock.stock_id),
    symbol: stock.symbol,
    recentEventCount: events.length,
    latest: events[0] ?? null,
    events,
  };
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

/**
 * Exposure summary for the Intelligence page (Part E §5): per-stock exposure,
 * relevant-event count, latest severity/direction — computed from the user's
 * OWN impact rows only.
 */
export async function getIntelligenceSummary(userId: number): Promise<IntelligenceSummary> {
  const [alertsTotal, alertsUnread, impacts] = await Promise.all([
    prisma.alerts.count({ where: { user_id: userId, source: "INTELLIGENCE" } }),
    prisma.alerts.count({ where: { user_id: userId, source: "INTELLIGENCE", is_read: false } }),
    prisma.intelligence_portfolio_impacts.findMany({
      where: { user_id: userId, stock_id: { not: null } },
      include: { stock: { select: { stock_id: true, symbol: true } } },
    }),
  ]);

  interface Acc {
    symbol: string;
    exposure: number | null;
    events: Set<number>;
    latestSeverity: string | null;
    latestDirection: string | null;
    latestAt: Date;
  }
  const severityRank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const byStock = new Map<number, Acc>();

  for (const i of impacts) {
    if (i.stock_id === null || !i.stock) continue;
    const acc =
      byStock.get(i.stock_id) ??
      ({
        symbol: i.stock.symbol,
        exposure: null,
        events: new Set<number>(),
        latestSeverity: null,
        latestDirection: null,
        latestAt: new Date(0),
      } satisfies Acc);
    // Primary exposure: direct weight, else sector weight, else aggregate.
    const w =
      i.portfolio_weight !== null
        ? Number(i.portfolio_weight)
        : i.sector_weight !== null
          ? Number(i.sector_weight)
          : i.user_aggregate_weight !== null
            ? Number(i.user_aggregate_weight)
            : null;
    if (w !== null && (acc.exposure === null || w > acc.exposure)) acc.exposure = w;
    acc.events.add(i.event_id);
    const at = i.updated_at > i.detected_at ? i.updated_at : i.detected_at;
    if (at >= acc.latestAt) {
      acc.latestAt = at;
      acc.latestSeverity = i.impact_severity;
      acc.latestDirection = i.direction;
    }
    byStock.set(i.stock_id, acc);
  }

  return {
    alerts: { total: alertsTotal, unread: alertsUnread },
    stockSummaries: Array.from(byStock.entries())
      .map(([stockId, a]) => ({
        stockId: String(stockId),
        symbol: a.symbol,
        exposurePct: a.exposure === null ? null : Number((a.exposure * 100).toFixed(1)),
        relevantEvents: a.events.size,
        latestSeverity: a.latestSeverity,
        latestDirection: a.latestDirection,
      }))
      .sort((x, y) => (y.exposurePct ?? 0) - (x.exposurePct ?? 0)),
  };
}

/** The user's INTELLIGENCE-sourced alerts (notification-center view). */
export async function getUserIntelligenceAlerts(userId: number, limit = 50) {
  const rows = await prisma.alerts.findMany({
    where: { user_id: userId, source: "INTELLIGENCE" },
    include: {
      stocks: { select: { symbol: true } },
      intelligence_event: { select: { event_id: true, category: true, status: true } },
    },
    orderBy: [{ is_read: "asc" }, { created_at: "desc" }],
    take: Math.min(200, Math.max(1, limit)),
  });
  return rows.map((a) => ({
    id: String(a.alert_id),
    title: a.title,
    message: a.message,
    severity: a.severity,
    alertType: a.alert_type,
    symbol: a.stocks?.symbol ?? null,
    isRead: a.is_read,
    createdAt: a.created_at.toISOString(),
    eventId: a.intelligence_event_id === null ? null : String(a.intelligence_event_id),
    eventCategory: a.intelligence_event?.category ?? null,
  }));
}

/** Mark one of the user's OWN alerts read (ownership enforced). */
export async function markIntelligenceAlertRead(userId: number, alertId: number) {
  const alert = await prisma.alerts.findUnique({ where: { alert_id: alertId }, select: { alert_id: true, user_id: true, is_read: true } });
  if (!alert || alert.user_id !== userId) return null;
  if (alert.is_read) return { alertId: String(alert.alert_id), alreadyRead: true };
  await prisma.alerts.update({ where: { alert_id: alertId }, data: { is_read: true } });
  return { alertId: String(alert.alert_id), alreadyRead: false };
}
