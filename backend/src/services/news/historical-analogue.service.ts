/**
 * Historical analogue engine (Intelligence Engine, Phase 5A).
 *
 * "Have we seen something like this before?" — answered ONLY from stored
 * PortfolioIQ intelligence events + real market data. Nothing is fabricated:
 * no invented historical policy events, no hard-coded index values.
 *
 * Methodology (deterministic, explainable):
 *  - Similarity = weighted sum of transparent dimensions:
 *      category (0.30) + same affected stock (0.30) + sector overlap (0.20)
 *      + severity closeness (0.10) + direction match (0.10)
 *  - Only PAST events (detected before the target, ≥ 1 day earlier) match.
 *  - Reaction windows: median/mean/best/worst stock return 1D/5D/20D after
 *    the event's detection, computed from actual stock_prices closes.
 *  - Quality: HIGH needs ≥ 2 analogues with similarity ≥ 0.7; MEDIUM needs
 *    ≥ 2 with ≥ 0.5; LOW otherwise. A single vague match is never HIGH.
 *  - Disclaimers are part of the payload: historical medians describe the
 *    past and never predict.
 */
import { prisma } from "../../utils/prisma.js";

const SIM_WEIGHTS = {
  category: 0.3,
  sameStock: 0.3,
  sector: 0.2,
  severity: 0.1,
  direction: 0.1,
} as const;

const WINDOW_DAYS = { 1: 1, 5: 5, 20: 20 } as const;
export type ReactionWindow = keyof typeof WINDOW_DAYS;

export interface AnalogueMatch {
  eventId: number;
  title: string;
  category: string;
  severity: number | null;
  direction: string | null;
  detectedAt: string;
  similarity: number;
  /** Which dimensions contributed (explainability). */
  matchedOn: string[];
  affectedSymbols: string[];
  reaction: {
    window: ReactionWindow;
    sampleSize: number;
    medianPct: number | null;
    meanPct: number | null;
    bestPct: number | null;
    worstPct: number | null;
    available: boolean;
    reason: string | null;
  }[];
}

export interface AnalogueResult {
  targetEventId: number;
  analogues: AnalogueMatch[];
  quality: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  qualityReason: string;
  disclaimer: string;
}

interface EventRow {
  event_id: number;
  title: string;
  category: string;
  severity: number | null;
  detected_at: Date;
  event_entities: { stock_id: number | null; entity_name: string; relationship_type: string; direction: string | null }[];
}

/** Closes for one stock over [from, to]; ascending by date. */
async function closesBetween(stockId: number, from: Date, to: Date): Promise<Array<{ date: string; close: number }>> {
  const rows = await prisma.stock_prices.findMany({
    where: { stock_id: stockId, price_date: { gte: from, lte: to } },
    orderBy: { price_date: "asc" },
    select: { price_date: true, close_price: true },
  });
  return rows.map((r) => ({ date: r.price_date.toISOString().slice(0, 10), close: Number(r.close_price) }));
}

/**
 * Reaction of ONE stock after a reference date: the return from the last
 * close on/before the event to the close N trading observations later.
 * Uses TRADING observations (not calendar days) so holidays don't shift
 * the window; null when the window is incomplete.
 */
async function reactionAfter(stockId: number, reference: Date, tradingLag: number): Promise<{ pct: number | null; reason: string | null }> {
  const from = new Date(reference.getTime() - 7 * 86_400_000);
  const to = new Date(reference.getTime() + 40 * 86_400_000);
  const closes = await closesBetween(stockId, from, to);
  if (closes.length === 0) return { pct: null, reason: "No price data around the event date." };
  // Anchor: last close on/before the reference date.
  let anchorIdx = -1;
  const refKey = reference.toISOString().slice(0, 10);
  for (let i = 0; i < closes.length; i++) {
    if (closes[i]!.date <= refKey) anchorIdx = i;
    else break;
  }
  if (anchorIdx === -1) return { pct: null, reason: "No close on/before the event date." };
  const targetIdx = anchorIdx + tradingLag;
  if (targetIdx >= closes.length) return { pct: null, reason: "Price window after the event is incomplete." };
  const base = closes[anchorIdx]!.close;
  if (base <= 0) return { pct: null, reason: "Unusable base price." };
  return { pct: (closes[targetIdx]!.close / base - 1) * 100, reason: null };
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Deterministic similarity between two events (0..1). */
function similarity(target: EventRow, candidate: EventRow): { score: number; matchedOn: string[] } {
  let score = 0;
  const matchedOn: string[] = [];
  if (candidate.category === target.category && target.category !== "OTHER") {
    score += SIM_WEIGHTS.category;
    matchedOn.push(`category ${target.category}`);
  }
  const targetStocks = new Set(target.event_entities.map((e) => e.stock_id).filter((s): s is number => s !== null));
  const candStocks = new Set(candidate.event_entities.map((e) => e.stock_id).filter((s): s is number => s !== null));
  let stockOverlap = false;
  for (const s of targetStocks) {
    if (candStocks.has(s)) {
      stockOverlap = true;
      break;
    }
  }
  if (stockOverlap) {
    score += SIM_WEIGHTS.sameStock;
    matchedOn.push("affected stock");
  }
  // Sector overlap via entity names on SECTOR relationships (existing design:
  // sectors live as entity names, no sectors table).
  const targetSectors = new Set(
    target.event_entities.filter((e) => e.relationship_type === "SECTOR").map((e) => e.entity_name.toLowerCase()),
  );
  const candSectors = new Set(
    candidate.event_entities.filter((e) => e.relationship_type === "SECTOR").map((e) => e.entity_name.toLowerCase()),
  );
  let sectorHit = false;
  for (const s of targetSectors) {
    if (candSectors.has(s)) {
      sectorHit = true;
      break;
    }
  }
  if (sectorHit) {
    score += SIM_WEIGHTS.sector;
    matchedOn.push("sector");
  }
  if (target.severity !== null && candidate.severity !== null) {
    const closeness = 1 - Math.min(1, Math.abs(target.severity - candidate.severity) / 4);
    score += closeness * SIM_WEIGHTS.severity;
    if (closeness >= 0.75) matchedOn.push(`severity ${candidate.severity}/5`);
  }
  const targetDir = target.event_entities.find((e) => e.direction !== null)?.direction ?? null;
  const candDir = candidate.event_entities.find((e) => e.direction !== null)?.direction ?? null;
  if (targetDir !== null && candDir === targetDir) {
    score += SIM_WEIGHTS.direction;
    matchedOn.push(`direction ${targetDir}`);
  }
  return { score: Number(score.toFixed(4)), matchedOn };
}

/**
 * Find historical analogues for an event, with observed stock reactions.
 * Only events detected at least one day EARLIER qualify as history.
 */
export async function findAnalogues(eventId: number, limit = 5): Promise<AnalogueResult | null> {
  const target = await prisma.intelligence_news_events.findUnique({
    where: { event_id: eventId },
    include: { event_entities: { select: { stock_id: true, entity_name: true, relationship_type: true, direction: true } } },
  });
  if (!target) return null;

  const candidates = await prisma.intelligence_news_events.findMany({
    where: { event_id: { not: eventId }, detected_at: { lt: new Date(target.detected_at.getTime() - 86_400_000) } },
    include: { event_entities: { select: { stock_id: true, entity_name: true, relationship_type: true, direction: true } } },
    orderBy: { detected_at: "desc" },
    take: 100,
  });

  const scored = candidates
    .map((c) => ({ row: c, ...similarity(target as unknown as EventRow, c as unknown as EventRow) }))
    .filter((x) => x.score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(10, Math.max(1, limit)));

  const analogues: AnalogueMatch[] = [];
  for (const m of scored) {
    const stockIds = Array.from(new Set(m.row.event_entities.map((e) => e.stock_id).filter((s): s is number => s !== null)));
    const reaction: AnalogueMatch["reaction"] = [];
    for (const lag of [1, 5, 20] as ReactionWindow[]) {
      const pcts: number[] = [];
      let unavailable = 0;
      let reason: string | null = null;
      for (const sid of stockIds.slice(0, 3)) {
        const r = await reactionAfter(sid, m.row.detected_at, WINDOW_DAYS[lag]);
        if (r.pct !== null) pcts.push(r.pct);
        else {
          unavailable += 1;
          reason = r.reason;
        }
      }
      reaction.push({
        window: lag,
        sampleSize: pcts.length,
        medianPct: pcts.length ? Number(median(pcts).toFixed(2)) : null,
        meanPct: pcts.length ? Number((pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(2)) : null,
        bestPct: pcts.length ? Number(Math.max(...pcts).toFixed(2)) : null,
        worstPct: pcts.length ? Number(Math.min(...pcts).toFixed(2)) : null,
        available: pcts.length > 0,
        reason: pcts.length === 0 ? (reason ?? "Insufficient price history") : null,
      });
    }
    analogues.push({
      eventId: m.row.event_id,
      title: m.row.title,
      category: m.row.category,
      severity: m.row.severity,
      direction: m.row.event_entities.find((e) => e.direction !== null)?.direction ?? null,
      detectedAt: m.row.detected_at.toISOString(),
      similarity: m.score,
      matchedOn: m.matchedOn,
      affectedSymbols: stockIds.length ? [] : [],
      reaction,
    });
  }

  // Attach affected symbols after mapping ids → symbols (single query).
  if (analogues.length > 0) {
    const allIds = Array.from(
      new Set(scored.flatMap((m) => m.row.event_entities.map((e) => e.stock_id).filter((s): s is number => s !== null))),
    );
    const stockRows = allIds.length
      ? await prisma.stocks.findMany({ where: { stock_id: { in: allIds } }, select: { stock_id: true, symbol: true } })
      : [];
    const symById = new Map(stockRows.map((s) => [s.stock_id, s.symbol]));
    for (let i = 0; i < analogues.length; i++) {
      const ids = scored[i]!.row.event_entities.map((e) => e.stock_id).filter((s): s is number => s !== null);
      analogues[i]!.affectedSymbols = ids.map((id) => symById.get(id)).filter((s): s is string => s !== undefined);
    }
  }

  const strong = analogues.filter((a) => a.similarity >= 0.7).length;
  const moderate = analogues.filter((a) => a.similarity >= 0.5).length;
  let quality: AnalogueResult["quality"] = "NONE";
  let qualityReason = "No sufficiently similar historical events found.";
  if (strong >= 2) {
    quality = "HIGH";
    qualityReason = `${strong} analogues matched on multiple dimensions with similarity ≥ 0.7.`;
  } else if (moderate >= 2) {
    quality = "MEDIUM";
    qualityReason = `${moderate} analogues matched with similarity ≥ 0.5 — supporting evidence only.`;
  } else if (analogues.length === 1) {
    quality = "LOW";
    qualityReason = "Only one comparable event — a single vague match is never strong evidence.";
  } else if (analogues.length > 1) {
    quality = "LOW";
    qualityReason = "Matches are weakly similar — treat as context only.";
  }

  return {
    targetEventId: eventId,
    analogues,
    quality,
    qualityReason,
    disclaimer: "Historical analogues describe past reactions computed from stored events and real price data. Past performance does not guarantee future results.",
  };
}
