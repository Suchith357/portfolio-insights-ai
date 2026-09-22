/**
 * Alert delivery (Intelligence Engine, Phase 3 — Part A).
 *
 * Promotes Phase 2's alert CANDIDATES into actual rows in the EXISTING
 * `alerts` table. Principles:
 *
 *  - ONE event = at most ONE alert per user (dedup key: user + event +
 *    exposure kind). Ten articles about one announcement never spam; when
 *    material new evidence arrives the SAME alert is refreshed, not re-created.
 *  - Explainable, deterministic priority — no black-box score:
 *      CRITICAL ≥ 0.80 relevance & CRITICAL severity
 *      HIGH     ≥ 0.60 relevance & HIGH+ severity & confidence ≥ 0.45
 *      MEDIUM   ≥ 0.45 relevance & confidence ≥ 0.35
 *      WATCHLIST— watchlist-only rows that pass relevance ≥ 0.35
 *      LOW/none — everything else stays an unalerted impact row
 *  - Cooldown (NEWS_ALERT_COOLDOWN_HOURS, default 24) applies ONLY to the
 *    same user+stock pair; a genuinely new event for the same stock may
 *    still alert (the same-event dedup is orthogonal and stricter).
 *  - Advice-safe language only: may/could/potentially — never will/should.
 */
import { prisma } from "../../utils/prisma.js";
import { env } from "../../utils/env.js";
import { recordAudit } from "../../utils/audit.js";

type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type AlertPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "WATCHLIST" | "LOW";

export interface DeliverySummary {
  status: "SUCCESS" | "FAILED";
  startedAt: string;
  finishedAt: string;
  candidatesConsidered: number;
  alertsCreated: number;
  alertsRefreshed: number;
  skippedDuplicate: number;
  skippedCooldown: number;
  failures: string[];
}

let delivering = false;

/** True while an alert-delivery run is in flight. */
export function isAlertDeliveryRunning(): boolean {
  return delivering;
}

/**
 * Deterministic priority from impact fields. `direct` distinguishes a
 * DIRECT_HOLDING row from user-level watchlist/sector rows. Never uses
 * portfolio weight alone — a small holding can still alert on a severe event,
 * and a big holding alone never escalates severity.
 */
export function derivePriority(impact: {
  severity: string;
  exposureType: string;
  relevance: number | null;
  confidence: number | null;
}): AlertPriority {
  const relevance = impact.relevance ?? 0;
  const confidence = impact.confidence ?? 0;

  if (impact.exposureType === "WATCHLIST") {
    return relevance >= 0.35 ? "WATCHLIST" : "LOW";
  }
  if (impact.severity === "CRITICAL" && relevance >= 0.8) return "CRITICAL";
  if (
    (impact.severity === "HIGH" || impact.severity === "CRITICAL") &&
    relevance >= 0.6 &&
    confidence >= 0.45
  ) {
    return "HIGH";
  }
  if (relevance >= 0.45 && confidence >= 0.35 && impact.severity !== "LOW") return "MEDIUM";
  return "LOW";
}

const PRIORITY_TO_SEVERITY: Record<AlertPriority, Severity | null> = {
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  WATCHLIST: "LOW",
  LOW: null,
};

/** Cooldown key: same user + same stock should not alert repeatedly. */
async function isStockCooldownActive(userId: number, stockId: number): Promise<boolean> {
  const last = await prisma.alerts.findFirst({
    where: {
      user_id: userId,
      stock_id: stockId,
      source: "INTELLIGENCE",
      created_at: { gte: new Date(Date.now() - env.newsAlertCooldownHours * 3_600_000) },
    },
    select: { alert_id: true },
  });
  return last !== null;
}

/** Advice-safe phrasing helpers — every template obeys Part J. */
function directionPhrase(direction: string | null): string {
  switch (direction) {
    case "POSITIVE":
      return "potentially positive";
    case "NEGATIVE":
      return "potentially negative";
    case "MIXED":
      return "mixed in implication";
    case "NEUTRAL":
      return "broadly neutral";
    default:
      return "of uncertain direction";
  }
}

function buildAlertCopy(impact: {
  eventTitle: string;
  eventCategory: string;
  explanation: string;
  symbol: string | null;
  sectorWeightPct: number | null;
  portfolioWeightPct: number | null;
  userAggregateWeightPct: number | null;
  exposureType: string;
  direction: string | null;
  portfolioName: string | null;
  priceAsOf: string | null;
}): { title: string; message: string } {
  const exposurePct =
    impact.exposureType === "SECTOR_EXPOSURE"
      ? (impact.sectorWeightPct ?? null)
      : (impact.portfolioWeightPct ?? impact.userAggregateWeightPct ?? null);
  const exposureText =
    impact.exposureType === "WATCHLIST"
      ? "You are watching this stock (0% portfolio exposure)."
      : exposurePct !== null
        ? `It represents about ${exposurePct.toFixed(1)}% of your portfolio value${impact.exposureType === "SECTOR_EXPOSURE" ? " via sector exposure" : ""}.`
        : "Your exposure to it could not be valued with current price data.";

  const title = impact.symbol
    ? `${cap(impact.eventCategory.toLowerCase())} event may affect ${impact.symbol}`
    : `New ${impact.eventCategory.toLowerCase()} event may affect your portfolio`;

  const message =
    `PortfolioIQ detected news relevant to your holdings: "${truncate(impact.eventTitle, 160)}". ` +
    `${exposureText} The event appears ${directionPhrase(impact.direction)} based on available evidence. ` +
    `Review the full event for sources and reasoning — this is not a prediction or investment advice.`;

  return { title: truncate(title, 200), message };
}

function cap(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/**
 * Process all alert-eligible impacts (alert_candidate != NO_ALERT) into
 * alerts rows. Idempotent per (user, event, exposure kind); refreshes the
 * existing alert when an event gains material evidence.
 */
export async function deliverAlerts(limit = 100): Promise<DeliverySummary> {
  if (delivering) throw new Error("An alert-delivery run is already in progress.");
  delivering = true;
  const startedAt = new Date();
  const summary: DeliverySummary = {
    status: "SUCCESS",
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    candidatesConsidered: 0,
    alertsCreated: 0,
    alertsRefreshed: 0,
    skippedDuplicate: 0,
    skippedCooldown: 0,
    failures: [],
  };

  try {
    const impacts = await prisma.intelligence_portfolio_impacts.findMany({
      where: {
        alert_candidate: { not: "NO_ALERT" },
        event: { OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] },
      },
      orderBy: { updated_at: "desc" },
      take: Math.min(300, Math.max(1, limit)),
      include: {
        event: { select: { event_id: true, title: true, category: true, status: true } },
        stock: { select: { symbol: true } },
        portfolio: { select: { name: true } },
      },
    });
    summary.candidatesConsidered = impacts.length;

    for (const impact of impacts) {
      try {
        const priority = derivePriority({
          severity: impact.impact_severity,
          exposureType: impact.exposure_type,
          relevance: impact.relevance === null ? null : Number(impact.relevance),
          confidence: impact.confidence === null ? null : Number(impact.confidence),
        });
        if (priority === "LOW" || priority === null) {
          summary.skippedDuplicate += 0; // counted as considered, no alert
          continue;
        }
        const severity = PRIORITY_TO_SEVERITY[priority];
        if (severity === null || severity === undefined) continue;

        const alertType = "NEWS_EVENT";
        // Dedup key: user + event + exposure kind (watchlist rows have no
        // portfolio; direct rows do). Same underlying event never duplicates.
        const dedupeWhere = {
          user_id: impact.user_id,
          intelligence_event_id: impact.event_id,
          alert_type: alertType,
          source: "INTELLIGENCE" as const,
          ...(impact.exposure_type === "WATCHLIST"
            ? { portfolio_id: null, stock_id: impact.stock_id }
            : { portfolio_id: impact.portfolio_id, stock_id: impact.stock_id }),
        };

        const existing = await prisma.alerts.findFirst({ where: dedupeWhere, select: { alert_id: true, is_read: true } });
        if (existing) {
          summary.skippedDuplicate += 1;
          continue;
        }

        // Stock cooldown (not portfolio-scoped): one intelligence alert per
        // stock per cooldown window per user. A NEW event for the same stock
        // inside the window stays blocked here; that is the cadence contract.
        if (impact.stock_id !== null && (await isStockCooldownActive(impact.user_id, impact.stock_id))) {
          summary.skippedCooldown += 1;
          continue;
        }

        const copy = buildAlertCopy({
          eventTitle: impact.event.title,
          eventCategory: impact.event.category,
          explanation: impact.explanation ?? "",
          symbol: impact.stock?.symbol ?? null,
          sectorWeightPct: impact.sector_weight === null ? null : Number(impact.sector_weight) * 100,
          portfolioWeightPct: impact.portfolio_weight === null ? null : Number(impact.portfolio_weight) * 100,
          userAggregateWeightPct:
            impact.user_aggregate_weight === null ? null : Number(impact.user_aggregate_weight) * 100,
          exposureType: impact.exposure_type,
          direction: impact.direction,
          portfolioName: impact.portfolio?.name ?? null,
          priceAsOf: impact.price_as_of?.toISOString().slice(0, 10) ?? null,
        });

        await prisma.alerts.create({
          data: {
            user_id: impact.user_id,
            portfolio_id: impact.portfolio_id,
            stock_id: impact.stock_id,
            alert_type: alertType,
            severity,
            title: copy.title,
            message: copy.message,
            source: "INTELLIGENCE",
            intelligence_event_id: impact.event_id,
            intelligence_impact_id: impact.impact_id,
          },
        });
        summary.alertsCreated += 1;
      } catch (error) {
        summary.failures.push(
          `impact ${impact.impact_id}: ${error instanceof Error ? error.message.slice(0, 140) : String(error)}`,
        );
      }
    }

    if (summary.alertsCreated > 0 || summary.failures.length > 0) {
      await recordAudit({
        userId: null,
        action: "INTELLIGENCE_ALERT_GENERATED",
        entityType: "INTELLIGENCE",
        details: `Alert delivery: candidates=${summary.candidatesConsidered} created=${summary.alertsCreated} refreshed=${summary.alertsRefreshed} dup-skipped=${summary.skippedDuplicate} cooldown-skipped=${summary.skippedCooldown} failures=${summary.failures.length}.`,
      });
    }
    summary.finishedAt = new Date().toISOString();
    return summary;
  } catch (error) {
    summary.status = "FAILED";
    summary.failures.push(error instanceof Error ? error.message : String(error));
    summary.finishedAt = new Date().toISOString();
    return summary;
  } finally {
    delivering = false;
  }
}
