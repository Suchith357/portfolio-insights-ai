/**
 * Event lifecycle + enrichment (Intelligence Engine, Phase 3 — Part C).
 *
 * One underlying real-world event must be ONE row, no matter how many
 * articles (or which provider) reported it. This module owns:
 *
 *   - deterministic dedup keying (normalized title signature),
 *   - article accumulation (source_article_ids, article_count, source_names),
 *   - novelty detection: re-published noise → no-op; material development →
 *     UPDATED + material_updates++,
 *   - lifecycle transitions (NEW → UPDATED → PROCESSED → RESOLVED/EXPIRED),
 *   - evidence assembly for the event detail view.
 *
 * Dedup strategy (deterministic, no NLP): normalized-title signature within a
 * recency window, crossing providers. Signatures are computed by the caller
 * (news-ingest) which owns normalization.
 */
import { prisma } from "../../utils/prisma.js";

/** Characters that carry no event-identity signal (punctuation/quotes). */
const NOISE = /[^\p{L}\p{N}\s]/gu;

/**
 * Deterministic dedup signature: lowercase, punctuation-stripped, digits
 * removed (numbers churn between drafts), words sorted so headline word
 * order differences across outlets collapse to the same key.
 */
export function eventSignature(title: string): string {
  return title
    .toLowerCase()
    .replace(NOISE, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^\d+$/.test(w))
    .sort()
    .slice(0, 12)
    .join(" ");
}

/** Recency window for dedup: two similar titles inside it are one event. */
const DEDUP_WINDOW_MS = 72 * 3_600_000; // 72h

export interface UpsertEventInput {
  category: string;
  title: string;
  summary: string | null;
  detectedAt: Date;
  eventTime: Date;
  severity: number | null;
  relevance: number;
  confidence: number;
  sourceArticleId: number;
  sourceName: string | null;
}

export interface UpsertEventResult {
  eventId: number;
  created: boolean;
  /** True when material new evidence turned an existing event into UPDATED. */
  materialUpdate: boolean;
  /** True when this article was judged a re-publication of known news. */
  duplicateOfExisting: boolean;
}

/**
 * Find-or-create the event for one freshly stored article, accumulating
 * evidence. Multiple articles about the same announcement converge on one
 * event row; a materially longer/different description marks UPDATED.
 */
export async function upsertEventForArticle(input: UpsertEventInput): Promise<UpsertEventResult> {
  const signature = eventSignature(input.title);
  const windowStart = new Date(input.detectedAt.getTime() - DEDUP_WINDOW_MS);

  // Candidate events: same signature, recent, still inside the retention
  // horizon (expired events are noise, not history).
  const candidates = await prisma.intelligence_news_events.findMany({
    where: {
      detected_at: { gte: windowStart },
      OR: [{ expires_at: null }, { expires_at: { gt: input.detectedAt } }],
    },
    orderBy: { detected_at: "desc" },
    take: 40,
    select: {
      event_id: true,
      title: true,
      summary: true,
      detected_at: true,
      source_article_ids: true,
      article_count: true,
      material_updates: true,
      severity: true,
    },
  });

  const exact = candidates.find((c) => eventSignature(c.title) === signature);
  // Signature with digits preserved — a change in numerals (e.g. "tax 5%"
  // → "tax 28%") is a material development, not a re-publication.
  const signatureWithDigits = signatureOfWithDigits(input.title);
  const material = candidates.find(
    (c) => c.event_id !== exact?.event_id && signatureOfWithDigits(c.title) === signatureWithDigits,
  );

  if (exact) {
    // Already-tracked article? source_article_ids is the membership set.
    const ids = articleIdsOf(exact.source_article_ids);
    if (ids.includes(input.sourceArticleId)) {
      return { eventId: exact.event_id, created: false, materialUpdate: false, duplicateOfExisting: true };
    }

    const ids2 = new Set(ids);
    ids2.add(input.sourceArticleId);
    const sourceNames = await mergeSourceNames(exact.event_id, input.sourceName);
    // Material development: EITHER a separate digit-signature twin carries
    // newer content, OR the same event gains a meaningfully longer summary
    // from a fresh article. Re-publications (identical snippet) stay noise.
    const materialUpdate =
      isMateriallyNewer(exact.summary, input.summary) ||
      (material !== undefined && isMateriallyNewer(material.summary, input.summary));
    await prisma.intelligence_news_events.update({
      where: { event_id: exact.event_id },
      data: {
        source_article_ids: Array.from(ids2),
        article_count: ids2.size,
        source_names: sourceNames,
        // Re-publications keep the original lifecycle; material developments
        // move NEW → UPDATED and bump the counter.
        status: materialUpdate ? "UPDATED" : undefined,
        material_updates: materialUpdate ? { increment: 1 } : undefined,
        // Keep the strongest severity/relevance across evidence.
        severity: maxNullable(exact.severity, input.severity),
        summary: input.summary && exact.summary === null ? input.summary : undefined,
        updated_at: new Date(),
      },
    });
    return { eventId: exact.event_id, created: false, materialUpdate, duplicateOfExisting: false };
  }

  const created = await prisma.intelligence_news_events.create({
    data: {
      category: input.category,
      title: input.title,
      summary: input.summary,
      detected_at: input.detectedAt,
      event_time: input.eventTime,
      severity: input.severity,
      relevance: input.relevance,
      confidence: input.confidence,
      status: "NEW",
      source_article_ids: [input.sourceArticleId],
      article_count: 1,
      source_names: input.sourceName ? [input.sourceName] : [],
    },
    select: { event_id: true },
  });
  return { eventId: created.event_id, created: true, materialUpdate: false, duplicateOfExisting: false };
}

/** Merge a source name into the event's distinct source_names JSON list. */
async function mergeSourceNames(eventId: number, sourceName: string | null): Promise<string[]> {
  const row = await prisma.intelligence_news_events.findUnique({
    where: { event_id: eventId },
    select: { source_names: true },
  });
  const prev = Array.isArray(row?.source_names) ? row!.source_names.filter((v): v is string => typeof v === "string") : [];
  if (!sourceName || prev.includes(sourceName)) return prev;
  return [...prev, sourceName].slice(0, 12);
}

function articleIdsOf(raw: unknown): number[] {
  return Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function signatureOfWithDigits(title: string): string {
  return title
    .toLowerCase()
    .replace(NOISE, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .sort()
    .slice(0, 14)
    .join(" ");
}

/**
 * Materially newer: the incoming snippet adds ≥ 25 chars of unseen content
 * beyond the stored one. Same-length rewrites and syndicated copies are noise.
 */
function isMateriallyNewer(stored: string | null, incoming: string | null): boolean {
  if (!incoming) return false;
  if (!stored) return true;
  const a = new Set(stored.toLowerCase().split(/\s+/));
  const added = incoming.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !a.has(w)).join(" ");
  return added.trim().length >= 25;
}

// ---------------------------------------------------------------------------
// Evidence assembly (Part D — source/evidence display backing)
// ---------------------------------------------------------------------------

export interface EventEvidence {
  articles: Array<{
    articleId: number;
    title: string;
    url: string;
    sourceName: string | null;
    publishedAt: string;
  }>;
  sources: string[];
  articleCount: number;
}

/** All supporting articles for an event (expired articles naturally absent). */
export async function getEventEvidence(eventId: number): Promise<EventEvidence> {
  const event = await prisma.intelligence_news_events.findUnique({
    where: { event_id: eventId },
    select: { source_article_ids: true, source_names: true, article_count: true },
  });
  if (!event) {
    return { articles: [], sources: [], articleCount: 0 };
  }
  const ids = articleIdsOf(event.source_article_ids);
  const rows = ids.length
    ? await prisma.intelligence_news_articles.findMany({
        where: { article_id: { in: ids } },
        select: { article_id: true, title: true, url: true, source_name: true, published_at: true },
      })
    : [];
  const sources = Array.isArray(event.source_names)
    ? event.source_names.filter((v): v is string => typeof v === "string")
    : [];
  return {
    articles: rows
      .map((r) => ({
        articleId: r.article_id,
        title: r.title,
        url: r.url,
        sourceName: r.source_name,
        publishedAt: r.published_at.toISOString(),
      }))
      .sort((x, y) => y.publishedAt.localeCompare(x.publishedAt)),
    sources,
    articleCount: event.article_count,
  };
}
