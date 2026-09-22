/**
 * Intelligence retention/cleanup service (Phase 1).
 *
 * Deletes ONLY expired ephemeral intelligence rows — never any existing
 * PortfolioIQ data. Idempotent: running it twice in a row is a no-op the
 * second time. Every run returns the counts it removed (0 when nothing
 * expired) and errors are contained so a cleanup failure can never crash
 * the application or interfere with the market-data scheduler.
 */
import { prisma } from "../../utils/prisma.js";

export interface CleanupSummary {
  ranAt: string;
  articlesDeleted: number;
  entitiesDeleted: number;
  eventsDeleted: number;
  eventEntitiesDeleted: number;
  errors: string[];
}

/**
 * Purge ephemeral intelligence rows past their expires_at.
 *
 *  - intelligence_news_articles: expires_at is NOT NULL → deleteMany on it.
 *    Entity rows are removed by the same predicate and by article CASCADE.
 *  - intelligence_news_events: expires_at may be NULL (a later phase may
 *    promote events to permanent); only rows with a past expires_at go.
 *    Event-entity rows cascade with their event.
 *
 * Note: entity rows whose article expired are swept here explicitly (the
 * FK CASCADE already covers this on article delete — the explicit sweep
 * makes the count observable for status reporting).
 */
export async function cleanupExpiredIntelligenceData(): Promise<CleanupSummary> {
  const summary: CleanupSummary = {
    ranAt: new Date().toISOString(),
    articlesDeleted: 0,
    entitiesDeleted: 0,
    eventsDeleted: 0,
    eventEntitiesDeleted: 0,
    errors: [],
  };

  const now = new Date();

  try {
    summary.eventEntitiesDeleted += (
      await prisma.intelligence_event_entities.deleteMany({
        where: { event: { expires_at: { lt: now, not: null } } },
      })
    ).count;
  } catch (error) {
    summary.errors.push(`event_entities: ${errorMessage(error)}`);
  }

  try {
    summary.eventsDeleted += (
      await prisma.intelligence_news_events.deleteMany({
        where: { expires_at: { not: null, lt: now } },
      })
    ).count;
  } catch (error) {
    summary.errors.push(`events: ${errorMessage(error)}`);
  }

  try {
    // Entity rows tied to expired articles (CASCADE would remove them with
    // the article; we sweep first so the deleted count is observable).
    summary.entitiesDeleted += (
      await prisma.intelligence_news_entities.deleteMany({
        where: { article: { expires_at: { lt: now } } },
      })
    ).count;
  } catch (error) {
    summary.errors.push(`news_entities: ${errorMessage(error)}`);
  }

  try {
    summary.articlesDeleted += (
      await prisma.intelligence_news_articles.deleteMany({
        where: { expires_at: { lt: now } },
      })
    ).count;
  } catch (error) {
    summary.errors.push(`news_articles: ${errorMessage(error)}`);
  }

  if (summary.errors.length > 0) {
    console.error("[intelligence] cleanup partial errors:", summary.errors.join(" | "));
  }
  return summary;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : String(error);
}
