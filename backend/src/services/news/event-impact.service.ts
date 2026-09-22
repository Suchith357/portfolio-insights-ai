/**
 * Event-impact service (Intelligence Engine, Phase 2).
 *
 * Turns Phase 1's stock/sector-linked events into PERSONALIZED intelligence:
 *
 *   EVENT → AFFECTED STOCK/SECTOR → USER HOLDINGS/WATCHLIST → EXPOSURE → IMPACT
 *
 * Design rules:
 *  - Deterministic, explainable scoring. Relevance is a sum of named
 *    components (stored in the explanation); direction/severity follow
 *    explicit rules; confidence is confidence ABOUT RELEVANCE, never about
 *    future returns.
 *  - Exposure types are evidence-backed only: DIRECT_HOLDING requires a real
 *    holding; WATCHLIST requires a watchlist row; SECTOR_EXPOSURE requires
 *    the event's sector linkage plus ownership in that sector. Users with no
 *    connection to an event get NO impact row — nothing is fabricated.
 *  - Idempotent: the functional unique index uq_intel_impact_dedup
 *    (event, user, portfolio, stock, exposure_type with COALESCE) makes
 *    processing safely re-runnable. We find-then-create/update so Prisma
 *    can target the functional index.
 *  - Retention: an event that produced at least one user impact is material
 *    and is promoted to permanent (expires_at → NULL); noise stays temporary
 *    and expires via the Phase 1 cleanup.
 *  - Single-flight lock + per-event error isolation: one malformed event
 *    never stops the batch or crashes the server.
 */
import { prisma } from "../../utils/prisma.js";
import { recordAudit } from "../../utils/audit.js";
import {
  getUserPortfolioExposure,
  type PortfolioExposure,
} from "./portfolio-exposure.service.js";

export type ExposureType =
  | "DIRECT_HOLDING"
  | "WATCHLIST"
  | "SECTOR_EXPOSURE"
  | "INDIRECT_EXPOSURE"
  | "MACRO_EXPOSURE"
  | "COMPETITOR_EXPOSURE"
  | "SUPPLIER_EXPOSURE"
  | "CUSTOMER_EXPOSURE"
  | "UNKNOWN";

export type Direction = "POSITIVE" | "NEGATIVE" | "MIXED" | "UNCERTAIN" | "NEUTRAL";
export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AlertCandidate =
  | "CRITICAL_ALERT"
  | "HIGH_ALERT"
  | "MEDIUM_ALERT"
  | "WATCHLIST_ALERT"
  | "NO_ALERT";

export interface ProcessSummary {
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  startedAt: string;
  finishedAt: string;
  eventsConsidered: number;
  eventsProcessed: number;
  eventsFailed: number;
  impactsCreated: number;
  impactsUpdated: number;
  eventsPromoted: number;
  failures: string[];
}

let processing = false;

/** True while an exposure-processing run is in flight. */
export function isExposureProcessing(): boolean {
  return processing;
}

// ---------------------------------------------------------------------------
// Scoring primitives (deterministic + explainable)
// ---------------------------------------------------------------------------

/**
 * Relevance = sum of transparent components (0..1). Components are echoed
 * into the impact explanation so the score is never a mystery.
 */
function relevanceScore(parts: {
  eventEvidence: number | null; // event/entity match confidence 0..1
  owned: boolean;
  watched: boolean;
  sectorOwned: boolean;
  severityNum: number | null; // 1..5
  recencyDays: number;
}): { score: number; parts: string[] } {
  const used: string[] = [];
  let score = 0;

  if (parts.owned) {
    score += 0.35;
    used.push("user holds the affected stock (+0.35)");
  } else if (parts.watched) {
    score += 0.2;
    used.push("stock is on the user's watchlist (+0.20)");
  } else if (parts.sectorOwned) {
    score += 0.12;
    used.push("user owns other stocks in the affected sector (+0.12)");
  }

  const ev = Math.min(1, parts.eventEvidence ?? 0.3);
  score += ev * 0.3;
  used.push(`event→stock evidence ${(ev * 100).toFixed(0)}% (up to +0.30)`);

  if (parts.severityNum !== null) {
    const sev = Math.min(0.2, (Math.max(0, parts.severityNum) / 5) * 0.2);
    score += sev;
    used.push(`event severity ${parts.severityNum}/5 (+${sev.toFixed(2)})`);
  }

  if (parts.recencyDays <= 2) {
    score += 0.1;
    used.push("recent event (+0.10)");
  }

  return { score: Math.min(1, Number(score.toFixed(4))), parts: used };
}

/**
 * Direction from provider sentiment when available; otherwise UNCERTAIN —
 * a forced POSITIVE/NEGATIVE from keywords would be a guess, and guesses
 * are exactly what this phase must not present.
 */
function deriveDirection(sentimentLabel: string | null): Direction {
  if (sentimentLabel === "POSITIVE") return "POSITIVE";
  if (sentimentLabel === "NEGATIVE") return "NEGATIVE";
  if (sentimentLabel === "NEUTRAL") return "NEUTRAL";
  return "UNCERTAIN";
}

/** Severity: event strength is the base; direct ownership is one amplifier. */
function deriveSeverity(eventSeverity: number | null, exposureType: ExposureType): Severity {
  let num = eventSeverity ?? 1;
  if (exposureType === "DIRECT_HOLDING") num += 1;
  if (num >= 4.5) return "CRITICAL";
  if (num >= 3.5) return "HIGH";
  if (num >= 2) return "MEDIUM";
  return "LOW";
}

/** Structured alert decision — the foundation, not the final alert engine. */
function alertDecision(
  severity: Severity,
  exposureType: ExposureType,
  relevance: number,
  confidence: number,
): AlertCandidate {
  if (exposureType === "DIRECT_HOLDING" && relevance >= 0.45 && confidence >= 0.4) {
    if (severity === "CRITICAL") return "CRITICAL_ALERT";
    if (severity === "HIGH") return "HIGH_ALERT";
    if (severity === "MEDIUM") return "MEDIUM_ALERT";
    return "NO_ALERT";
  }
  if (exposureType === "WATCHLIST" && relevance >= 0.35 && confidence >= 0.35) {
    return "WATCHLIST_ALERT";
  }
  return "NO_ALERT";
}

/** Confidence about relevance (mapping quality), NOT about returns. */
function confidenceFromEvidence(evidence: number | null, hasSentiment: boolean): number {
  const base = Math.min(1, evidence ?? 0.3);
  return Number(Math.min(1, base + (hasSentiment ? 0.1 : 0)).toFixed(4));
}

function roundWeight(w: number | null): number | null {
  return w === null ? null : Number(w.toFixed(4)); // 4 dp — honest precision only
}

// ---------------------------------------------------------------------------
// Per-event processing
// ---------------------------------------------------------------------------

interface EventWithEntities {
  event_id: number;
  category: string;
  title: string;
  summary: string | null;
  detected_at: Date;
  severity: number | null;
  relevance: number | null;
  confidence: number | null;
  /** Prisma returns Prisma Decimal for numeric columns — callers map first. */
  event_entities: Array<{
    stock_id: number | null;
    entity_name: string;
    relationship_type: string;
    direction: string | null;
    relevance: number | null;
  }>;
}

/**
 * Per-stock direction: provider/entity sentiment first (Marketaux path),
 * then the event-entity link's direction, else UNCERTAIN. Never guessed
 * from keywords alone.
 */
function directionForStock(
  sentiments: Map<number, string | null>,
  stockId: number,
  entityDirection: string | null,
): Direction {
  const s = sentiments.get(stockId) ?? null;
  if (s === "POSITIVE" || s === "NEGATIVE" || s === "NEUTRAL") return s;
  if (entityDirection === "POSITIVE" || entityDirection === "NEGATIVE" || entityDirection === "NEUTRAL") {
    return entityDirection;
  }
  return "UNCERTAIN";
}

/**
 * Provider sentiment per affected stock for an event: the event's
 * source_article_ids (JSON) point back to the ephemeral articles whose
 * matched-entity rows carry sentiment labels (Marketaux path). Events
 * from GDELT have no sentiment → empty map → direction stays UNCERTAIN.
 */
async function sentimentByStock(eventId: number): Promise<Map<number, string | null>> {
  const event = await prisma.intelligence_news_events.findUnique({
    where: { event_id: eventId },
    select: { source_article_ids: true },
  });
  const raw = event?.source_article_ids;
  const ids = Array.isArray(raw)
    ? raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  const out = new Map<number, string | null>();
  if (ids.length === 0) return out;

  const entities = await prisma.intelligence_news_entities.findMany({
    where: { article_id: { in: ids }, stock_id: { not: null }, sentiment_label: { not: null } },
    select: { stock_id: true, sentiment_label: true },
  });
  for (const e of entities) {
    if (e.stock_id === null || e.sentiment_label === null) continue;
    if (!out.has(e.stock_id)) out.set(e.stock_id, e.sentiment_label);
  }
  return out;
}

async function processEvent(
  event: EventWithEntities,
  sentiments: Map<number, string | null>,
): Promise<{ created: number; updated: number }> {
  // Non-admin users with at least one portfolio or watchlist entry.
  const users = await prisma.users.findMany({
    where: { role: { not: "ADMIN" } },
    select: { user_id: true },
  });

  const recencyDays = Math.max(0, (Date.now() - event.detected_at.getTime()) / 86_400_000);
  let created = 0;
  let updated = 0;

  for (const u of users) {
    const exposure = await getUserPortfolioExposure(u.user_id);
    if (exposure.portfolios.length === 0 && exposure.watchlistStockIds.size === 0) continue;

    // Event → affected stocks (one entry per stock, strongest evidence wins).
    const entityByStock = new Map<number, (typeof event.event_entities)[number]>();
    for (const ee of event.event_entities) {
      if (ee.stock_id === null) continue;
      const prev = entityByStock.get(ee.stock_id);
      if (!prev || (ee.relevance ?? 0) > (prev.relevance ?? 0)) entityByStock.set(ee.stock_id, ee);
    }

    for (const [stockId, ee] of entityByStock) {
      const isSectorMatch = ee.relationship_type === "SECTOR";
      const sentimentLabel = sentiments.get(stockId) ?? null;
      const direction = directionForStock(sentiments, stockId, ee.direction);
      const confidence = confidenceFromEvidence(ee.relevance ?? event.relevance ?? null, sentimentLabel !== null);

      // USER-AGGREGATE view (dedup across portfolios happens naturally: one
      // row per portfolio below + this user-level row when the stock is held
      // in more than one portfolio).
      const agg = exposure.userAggregateByStock.get(stockId);
      const watchedAnywhere = exposure.watchlistStockIds.has(stockId);
      const ownedAnywhere = (agg?.value ?? 0) > 0;

      // ---- per-portfolio rows ------------------------------------------------
      // Evidence hierarchy: a SECTOR relationship means the event names the
      // SECTOR, not the company. Claiming "HDFC Bank directly affected" from
      // "banking regulations" would fabricate evidence — so sector-linked
      // events NEVER produce DIRECT_HOLDING rows; they produce a
      // SECTOR_EXPOSURE row (user-level, sector weights below).
      for (const p of isSectorMatch ? [] : exposure.portfolios) {
        const owned = p.byStock.has(stockId);
        const sector = p.byStock.get(stockId)?.sector ?? null;

        if (owned) {
          const holding = p.byStock.get(stockId)!;
          const weight = roundWeight(holding.portfolioWeight);
          const sectorWeight = sector ? roundWeight(p.bySector.get(sector)?.weight ?? null) : null;
          const relevance = relevanceScore({
            eventEvidence: ee.relevance ?? event.relevance ?? null,
            owned: true,
            watched: false,
            sectorOwned: false,
            severityNum: event.severity,
            recencyDays,
          });
          const severity = deriveSeverity(event.severity, "DIRECT_HOLDING");
          const alert = alertDecision(severity, "DIRECT_HOLDING", relevance.score, confidence);
          const explanation =
            `Event "${event.title.slice(0, 140)}" was linked to ${holding.symbol} with ` +
            `${(confidence * 100).toFixed(0)}% mapping confidence. You hold ${holding.symbol} at ` +
            `${((weight ?? 0) * 100).toFixed(1)}% of ${p.portfolioName}` +
            (sectorWeight !== null ? ` (${sector} is ${((sectorWeight ?? 0) * 100).toFixed(1)}% of the portfolio)` : "") +
            `. Relevance: ${relevance.parts.join("; ")}. Exposure uses the latest available price` +
            (exposure.priceAsOf ? ` (as of ${exposure.priceAsOf})` : "") +
            `. Direction ${direction} is evidence-based — not a price prediction.`;

          const key = { eventId: event.event_id, userId: u.user_id, portfolioId: p.portfolioId, stockId, exposureType: "DIRECT_HOLDING" as const };
          const existing = await prisma.intelligence_portfolio_impacts.findFirst({
            where: { event_id: key.eventId, user_id: key.userId, portfolio_id: key.portfolioId, stock_id: key.stockId, exposure_type: key.exposureType },
            select: { impact_id: true },
          });
          if (existing) {
            await prisma.intelligence_portfolio_impacts.update({
              where: { impact_id: existing.impact_id },
              data: {
                portfolio_weight: weight,
                sector_weight: sectorWeight,
                direction,
                impact_severity: severity,
                alert_candidate: alert,
                relevance: relevance.score,
                confidence,
                explanation,
                price_as_of: exposure.priceAsOf ? new Date(`${exposure.priceAsOf}T00:00:00Z`) : null,
              },
            });
            updated += 1;
          } else {
            await prisma.intelligence_portfolio_impacts.create({
              data: {
                event_id: event.event_id,
                user_id: u.user_id,
                portfolio_id: p.portfolioId,
                stock_id: stockId,
                exposure_type: "DIRECT_HOLDING",
                portfolio_weight: weight,
                sector_weight: sectorWeight,
                direction,
                impact_severity: severity,
                alert_candidate: alert,
                relevance: relevance.score,
                confidence,
                explanation,
                price_as_of: exposure.priceAsOf ? new Date(`${exposure.priceAsOf}T00:00:00Z`) : null,
              },
            });
            created += 1;
          }
        }
        // Portfolios without the holding contribute no row for DIRECT events;
        // sector linkage is handled by the user-level row below.
      }

      // ---- user-level rows (watchlist / sector exposure) ---------------------
      const userLevelTypes: Array<{ type: ExposureType; sector: string | null; sectorWeight: number | null; relevance: number; parts: string[] }> = [];

      if (!ownedAnywhere && watchedAnywhere) {
        const relevance = relevanceScore({
          eventEvidence: ee.relevance ?? event.relevance ?? null,
          owned: false,
          watched: true,
          sectorOwned: false,
          severityNum: event.severity,
          recencyDays,
        });
        userLevelTypes.push({ type: "WATCHLIST", sector: null, sectorWeight: null, relevance: relevance.score, parts: relevance.parts });
      }

      if (isSectorMatch) {
        // SECTOR events: the event's entity names the sector; a user has
        // sector exposure when they own ANY stock in that sector. The
        // affected sector name is the entity_name from the event entity.
        const sectorName = ee.entity_name.toLowerCase();
        for (const p of exposure.portfolios) {
          const sec = p.bySector.get(sectorName) ?? p.bySector.get(ee.entity_name);
          if (!sec || sec.weight <= 0) continue;
          const relevance = relevanceScore({
            eventEvidence: ee.relevance ?? event.relevance ?? null,
            owned: false,
            watched: false,
            sectorOwned: true,
            severityNum: event.severity,
            recencyDays,
          });
          userLevelTypes.push({
            type: "SECTOR_EXPOSURE",
            sector: ee.entity_name,
            sectorWeight: roundWeight(sec.weight),
            relevance: relevance.score,
            parts: relevance.parts,
          });
          break; // one user-level sector row per event is enough
        }
      }

      for (const ul of userLevelTypes) {
        const severity = deriveSeverity(event.severity, ul.type);
        const alert =
          ul.type === "WATCHLIST"
            ? alertDecision(severity, "WATCHLIST", ul.relevance, confidence)
            : "NO_ALERT";
        const symbolRow = await prisma.stocks.findUnique({
          where: { stock_id: stockId },
          select: { symbol: true },
        });
        const symbol = symbolRow?.symbol ?? `stock ${stockId}`;
        const explanation =
          ul.type === "WATCHLIST"
            ? `Event "${event.title.slice(0, 140)}" was linked to ${symbol}. You are watching ${symbol} — portfolio exposure 0%, but this may be relevant to your watchlist. Relevance: ${ul.parts.join("; ")}.`
            : `Event "${event.title.slice(0, 140)}" is linked to the ${ul.sector} sector. Your portfolio holds ${ul.sector} stocks (${((ul.sectorWeight ?? 0) * 100).toFixed(1)}% of value) — indirect sector exposure. Relevance: ${ul.parts.join("; ")}.`;

        const existing = await prisma.intelligence_portfolio_impacts.findFirst({
          where: { event_id: event.event_id, user_id: u.user_id, portfolio_id: null, stock_id: stockId, exposure_type: ul.type },
          select: { impact_id: true },
        });
        if (existing) {
          await prisma.intelligence_portfolio_impacts.update({
            where: { impact_id: existing.impact_id },
            data: {
              sector_weight: ul.sectorWeight,
              user_aggregate_weight: roundWeight(agg?.weight ?? null),
              direction,
              impact_severity: severity,
              alert_candidate: alert,
              relevance: ul.relevance,
              confidence,
              explanation,
              price_as_of: exposure.priceAsOf ? new Date(`${exposure.priceAsOf}T00:00:00Z`) : null,
            },
          });
          updated += 1;
        } else {
          await prisma.intelligence_portfolio_impacts.create({
            data: {
              event_id: event.event_id,
              user_id: u.user_id,
              portfolio_id: null,
              stock_id: stockId,
              exposure_type: ul.type,
              sector_weight: ul.sectorWeight,
              user_aggregate_weight: roundWeight(agg?.weight ?? null),
              direction,
              impact_severity: severity,
              alert_candidate: alert,
              relevance: ul.relevance,
              confidence,
              explanation,
              price_as_of: exposure.priceAsOf ? new Date(`${exposure.priceAsOf}T00:00:00Z`) : null,
            },
          });
          created += 1;
        }
      }
    }
  }

  return { created, updated };
}

/**
 * Processes recent non-expired events into portfolio impacts.
 * Idempotent, bounded (limit), error-isolated per event.
 */
export async function processRecentEvents(limit = 25, userId?: number): Promise<ProcessSummary> {
  if (processing) throw new Error("An exposure-processing run is already in progress.");
  processing = true;
  const startedAt = new Date();
  const summary: ProcessSummary = {
    status: "SUCCESS",
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    eventsConsidered: 0,
    eventsProcessed: 0,
    eventsFailed: 0,
    impactsCreated: 0,
    impactsUpdated: 0,
    eventsPromoted: 0,
    failures: [],
  };

  try {
    const events = await prisma.intelligence_news_events.findMany({
      where: {
        OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
      },
      orderBy: { detected_at: "desc" },
      take: Math.min(100, Math.max(1, limit)),
      include: {
        event_entities: {
          select: {
            stock_id: true,
            entity_name: true,
            relationship_type: true,
            direction: true,
            relevance: true,
          },
        },
      },
    });
    summary.eventsConsidered = events.length;

    for (const event of events) {
      try {
        // Map Prisma Decimals to plain numbers for the scoring functions.
        const eventPlain = {
          ...event,
          relevance: event.relevance === null ? null : Number(event.relevance),
          confidence: event.confidence === null ? null : Number(event.confidence),
          event_entities: event.event_entities.map((ee) => ({
            ...ee,
            relevance: ee.relevance === null ? null : Number(ee.relevance),
          })),
        };
        const sentiments = await sentimentByStock(event.event_id);
        const { created, updated } = await processEvent(eventPlain, sentiments);
        summary.impactsCreated += created;
        summary.impactsUpdated += updated;
        summary.eventsProcessed += 1;

        // Material events (they produced user impacts) become permanent so
        // impacts never dangle when the ephemeral raw layer expires. The
        // lifecycle also advances NEW/UPDATED → PROCESSED (impacts built).
        if (created + updated > 0 && event.severity !== null && event.severity >= 2) {
          await prisma.intelligence_news_events.update({
            where: { event_id: event.event_id },
            data: {
              expires_at: null,
              status: event.status === "NEW" || event.status === "UPDATED" ? "PROCESSED" : undefined,
            },
          });
          summary.eventsPromoted += 1;
        } else if (created + updated > 0) {
          // Low-severity but user-relevant: advance lifecycle without promoting.
          await prisma.intelligence_news_events.update({
            where: { event_id: event.event_id },
            data: { status: event.status === "NEW" || event.status === "UPDATED" ? "PROCESSED" : undefined },
          });
        }
      } catch (error) {
        summary.eventsFailed += 1;
        summary.failures.push(
          `event ${event.event_id}: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`,
        );
      }
    }

    if (summary.eventsFailed > 0) summary.status = summary.eventsProcessed > 0 ? "PARTIAL" : "FAILED";
    summary.finishedAt = new Date().toISOString();
    return summary;
  } catch (error) {
    summary.status = "FAILED";
    summary.failures.push(error instanceof Error ? error.message : String(error));
    summary.finishedAt = new Date().toISOString();
    return summary;
  } finally {
    processing = false;
  }
}

export interface ImpactDto {
  id: string;
  eventId: string;
  eventTitle: string;
  eventCategory: string;
  eventDetectedAt: string;
  exposureType: string;
  portfolioId: string | null;
  portfolioName: string | null;
  stockId: string | null;
  symbol: string | null;
  stockSector: string | null;
  portfolioWeightPct: number | null;
  sectorWeightPct: number | null;
  userAggregateWeightPct: number | null;
  direction: string | null;
  severity: string;
  alertCandidate: string;
  relevance: number | null;
  confidence: number | null;
  explanation: string;
  priceAsOf: string | null;
  detectedAt: string;
}

/** A user's own impacts (ownership enforced by the caller passing userId). */
export async function getUserImpacts(
  userId: number,
  options: { severity?: string; direction?: string; exposureType?: string; limit?: number } = {},
): Promise<ImpactDto[]> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 25));
  const rows = await prisma.intelligence_portfolio_impacts.findMany({
    where: {
      user_id: userId,
      ...(options.severity ? { impact_severity: options.severity } : {}),
      ...(options.direction ? { direction: options.direction } : {}),
      ...(options.exposureType ? { exposure_type: options.exposureType } : {}),
    },
    orderBy: [{ impact_severity: "asc" }, { relevance: "desc" }, { created_at: "desc" }],
    take: limit,
    include: {
      event: { select: { title: true, category: true, detected_at: true } },
      portfolio: { select: { name: true } },
      stock: { select: { symbol: true, sector: true } },
    },
  });
  const severityRank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  return rows
    .map((r) => ({
      id: String(r.impact_id),
      eventId: String(r.event_id),
      eventTitle: r.event.title,
      eventCategory: r.event.category,
      eventDetectedAt: r.event.detected_at.toISOString(),
      exposureType: r.exposure_type,
      portfolioId: r.portfolio_id === null ? null : String(r.portfolio_id),
      portfolioName: r.portfolio?.name ?? null,
      stockId: r.stock_id === null ? null : String(r.stock_id),
      symbol: r.stock?.symbol ?? null,
      stockSector: r.stock?.sector ?? null,
      portfolioWeightPct: r.portfolio_weight === null ? null : Number(r.portfolio_weight) * 100,
      sectorWeightPct: r.sector_weight === null ? null : Number(r.sector_weight) * 100,
      userAggregateWeightPct: r.user_aggregate_weight === null ? null : Number(r.user_aggregate_weight) * 100,
      direction: r.direction,
      severity: r.impact_severity,
      alertCandidate: r.alert_candidate,
      relevance: r.relevance === null ? null : Number(r.relevance),
      confidence: r.confidence === null ? null : Number(r.confidence),
      explanation: r.explanation ?? "",
      priceAsOf: r.price_as_of?.toISOString().slice(0, 10) ?? null,
      detectedAt: r.detected_at.toISOString(),
    }))
    .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) || (b.relevance ?? 0) - (a.relevance ?? 0));
}

/** System-wide view for admins. */
export async function getSystemImpacts(limit = 50): Promise<Array<ImpactDto & { userEmail: string }>> {
  const rows = await prisma.intelligence_portfolio_impacts.findMany({
    orderBy: { created_at: "desc" },
    take: Math.min(200, Math.max(1, limit)),
    include: {
      event: { select: { title: true, category: true, detected_at: true } },
      portfolio: { select: { name: true } },
      stock: { select: { symbol: true, sector: true } },
      user: { select: { email: true } },
    },
  });
  return rows.map((r) => ({
    userEmail: r.user?.email ?? "unknown",
    id: String(r.impact_id),
    eventId: String(r.event_id),
    eventTitle: r.event.title,
    eventCategory: r.event.category,
    eventDetectedAt: r.event.detected_at.toISOString(),
    exposureType: r.exposure_type,
    portfolioId: r.portfolio_id === null ? null : String(r.portfolio_id),
    portfolioName: r.portfolio?.name ?? null,
    stockId: r.stock_id === null ? null : String(r.stock_id),
    symbol: r.stock?.symbol ?? null,
    stockSector: r.stock?.sector ?? null,
    portfolioWeightPct: r.portfolio_weight === null ? null : Number(r.portfolio_weight) * 100,
    sectorWeightPct: r.sector_weight === null ? null : Number(r.sector_weight) * 100,
    userAggregateWeightPct: r.user_aggregate_weight === null ? null : Number(r.user_aggregate_weight) * 100,
    direction: r.direction,
    severity: r.impact_severity,
    alertCandidate: r.alert_candidate,
    relevance: r.relevance === null ? null : Number(r.relevance),
    confidence: r.confidence === null ? null : Number(r.confidence),
    explanation: r.explanation ?? "",
    priceAsOf: r.price_as_of?.toISOString().slice(0, 10) ?? null,
    detectedAt: r.detected_at.toISOString(),
  }));
}

/** Audit helper for manual runs (called from the admin controller). */
export async function auditExposureRun(userId: number, summary: ProcessSummary): Promise<void> {
  await recordAudit({
    userId,
    action: "INTELLIGENCE_EXPOSURE",
    entityType: "INTELLIGENCE",
    details: `Exposure processing (${summary.status}): considered=${summary.eventsConsidered} processed=${summary.eventsProcessed} failed=${summary.eventsFailed} impacts +${summary.impactsCreated}/~${summary.impactsUpdated} events promoted=${summary.eventsPromoted}.`,
  });
}

export type { PortfolioExposure };
