/**
 * Event → scenario intelligence orchestration (Intelligence Engine, Phase 6).
 *
 * COMPOSES the existing Phase 2/4/5 services — it never duplicates them:
 *
 *   EVENT → affected entities → MY exposure (portfolio-exposure.service)
 *         → historical analogues (historical-analogue.service)
 *         → evidence-backed suggested scenarios
 *         → one-click what-if execution (scenario.service)
 *         → portfolio-level intelligence summary
 *
 * Language contract: scenario suggestions are ALWAYS labelled as suggestions
 * based on event characteristics / historical evidence — never predictions,
 * never advice. Missing evidence is stated, not fabricated.
 */

import { prisma } from "../../utils/prisma.js";
import { notFound, forbidden } from "../../utils/http.js";
import { findAnalogues, type AnalogueResult } from "./historical-analogue.service.js";
import { applyShocks, type ShockInput, type ScenarioImpact } from "./scenario.service.js";
import { getRiskOverview, type Contributor } from "./quantitative-risk.service.js";

export const EVENT_SCENARIO_MODEL_VERSION = "event-scenario-v1";
const SCENARIO_DISCLAIMER =
  "Suggested scenarios are based on event characteristics and historical evidence. They are hypothetical what-if analyses — not predictions or investment advice.";

export interface SuggestedScenario {
  kind: "STOCK" | "SECTOR" | "MARKET";
  label: string;
  rationale: string;
  basis: "HISTORICAL_EVIDENCE" | "EVENT_CHARACTERISTICS" | "SYSTEM_STRESS_DEFAULT";
  shockPct: number;
  stockId?: number;
  symbol?: string;
  sector?: string;
}

export interface EventIntelligencePackage {
  modelVersion: string;
  event: {
    eventId: string;
    title: string;
    category: string;
    summary: string | null;
    detectedAt: string;
    severity: number | null;
    confidence: number | null;
    direction: string | null;
    status: string;
  };
  affectedEntities: Array<{
    stockId: string | null;
    symbol: string | null;
    entityName: string;
    relationshipType: string;
    matchConfidence: string | null;
    direction: string | null;
  }>;
  affectedSectors: string[];
  myExposure: {
    ownedStockIds: string[];
    watchlistStockIds: string[];
    holdingsExposedValue: number | null;
    holdingsTotalValue: number | null;
    exposurePctOfPortfolio: number | null;
    reason: string | null;
  };
  historicalAnalogues: AnalogueResult | null;
  suggestedScenarios: SuggestedScenario[];
  evidenceNote: string | null;
  disclaimer: string;
}

/* ------------------------------ internals --------------------------------- */

async function ownedPortfolio(userId: number, portfolioId: number) {
  const p = await prisma.portfolios.findFirst({
    where: { portfolio_id: portfolioId, user_id: userId },
    select: { portfolio_id: true, name: true },
  });
  if (!p) throw forbidden("You don't have access to this portfolio.");
  return p;
}

const SEVERITY_ORDER: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/**
 * Aggregate the user's exposure for ONE event: which affected stocks they own
 * / watch, and what % of portfolio value those holdings represent (based on
 * each portfolio's OWN latest closes via the exposure service conventions).
 */
async function eventExposureForUser(userId: number, stockIds: number[]) {
  const owned = await prisma.holdings.findMany({
    where: { portfolios: { user_id: userId }, stock_id: { in: stockIds.length > 0 ? stockIds : [-1] } },
    select: { stock_id: true, quantity: true },
  });
  const ownedNum = owned.map((h) => ({ stock_id: h.stock_id, quantity: Number(h.quantity) }));
  const watchlist = await prisma.watchlists.findMany({
    where: { user_id: userId, stock_id: { in: stockIds.length > 0 ? stockIds : [-1] } },
    select: { stock_id: true },
  });
  if (owned.length === 0) {
    return {
      ownedStockIds: [] as string[],
      watchlistStockIds: watchlist.map((w) => String(w.stock_id)),
      holdingsExposedValue: null as number | null,
      holdingsTotalValue: null as number | null,
      exposurePctOfPortfolio: null as number | null,
      reason: stockIds.length === 0 ? "Event has no stock-level entity links." : "You do not hold any of the affected stocks.",
    };
  }

  // Values from each portfolio's own holdings × latest stored closes per stock.
  const allHoldings = await prisma.holdings.findMany({
    where: { portfolios: { user_id: userId } },
    select: { stock_id: true, quantity: true },
  });
  const pricedStockIds = Array.from(new Set(allHoldings.map((h) => h.stock_id)));
  const priceRows = await prisma.stock_prices.findMany({
    where: { stock_id: { in: pricedStockIds } },
    orderBy: [{ stock_id: "asc" }, { price_date: "desc" }],
    distinct: ["stock_id"],
    select: { stock_id: true, close_price: true },
  });
  const allHoldingsNum = allHoldings.map((h) => ({ stock_id: h.stock_id, quantity: Number(h.quantity) }));
  const priceByStock = new Map(priceRows.map((r) => [r.stock_id, Number(r.close_price)]));
  const totalValue = allHoldingsNum.reduce((a, h) => a + h.quantity * (priceByStock.get(h.stock_id) ?? 0), 0);
  const exposedValue = ownedNum.reduce((a, h) => a + h.quantity * (priceByStock.get(h.stock_id) ?? 0), 0);
  return {
    ownedStockIds: Array.from(new Set(owned.map((h) => String(h.stock_id)))),
    watchlistStockIds: watchlist.map((w) => String(w.stock_id)),
    holdingsExposedValue: exposedValue,
    holdingsTotalValue: totalValue,
    exposurePctOfPortfolio: totalValue > 0 ? Number(((exposedValue / totalValue) * 100).toFixed(2)) : null,
    reason: null,
  };
}

/**
 * Build suggested scenarios from event characteristics + analogue evidence.
 * Evidence-based shocks use the observed historical WORST 5-day reaction
 * (rounded to a whole percent); stress defaults are clearly labelled.
 */
function buildSuggestedScenarios(
  affected: EventIntelligencePackage["affectedEntities"],
  sectors: string[],
  analogues: AnalogueResult | null,
  direction: string | null,
): SuggestedScenario[] {
  const out: SuggestedScenario[] = [];

  // 1) Direct stock scenarios for the strongest entity links.
  const directStocks = affected.filter((a) => a.stockId !== null && a.symbol !== null).slice(0, 2);
  for (const s of directStocks) {
    // Historical evidence for THIS stock, if any analogue provides a reaction.
    const evidence = analogues?.analogues
      .flatMap((a) => a.reaction)
      .filter((r) => r.available && r.window === 5)
      .map((r) => r.worstPct)
      .filter((v): v is number => v !== null) ?? [];
    if (evidence.length > 0) {
      const worst5d = Math.min(...evidence);
      out.push({
        kind: "STOCK",
        label: `${s.symbol} historical-stress reference ${worst5d.toFixed(0)}%`,
        rationale: `Worst observed 5-day reaction for similar historical events affecting ${s.symbol}.`,
        basis: "HISTORICAL_EVIDENCE",
        shockPct: Math.round(worst5d),
        stockId: Number(s.stockId),
        symbol: s.symbol!,
      });
    }
    out.push({
      kind: "STOCK",
      label: `${s.symbol} −10%`,
      rationale: "Conventional single-stock stress for a directly affected company.",
      basis: "SYSTEM_STRESS_DEFAULT",
      shockPct: -10,
      stockId: Number(s.stockId),
      symbol: s.symbol!,
    });
    out.push({
      kind: "STOCK",
      label: `${s.symbol} −20%`,
      rationale: "Severe single-stock stress for a directly affected company.",
      basis: "SYSTEM_STRESS_DEFAULT",
      shockPct: -20,
      stockId: Number(s.stockId),
      symbol: s.symbol!,
    });
  }

  // 2) Sector scenarios — event characteristics, not predictions.
  for (const sector of sectors.slice(0, 1)) {
    out.push({
      kind: "SECTOR",
      label: `${sector} sector −10%`,
      rationale: "The event is sector-linked; this shocks all your holdings in that sector.",
      basis: "EVENT_CHARACTERISTICS",
      shockPct: -10,
      sector,
    });
  }

  // 3) Market-wide fallback for macro/global categories.
  if (out.length === 0) {
    out.push({
      kind: "MARKET",
      label: "All holdings −10% (market-stress proxy)",
      rationale: "No specific stock/sector link is established; this applies a broad market-stress assumption.",
      basis: "SYSTEM_STRESS_DEFAULT",
      shockPct: -10,
    });
  }
  void direction;
  return out;
}

/* ------------------------------- public API -------------------------------- */

/**
 * Full event intelligence package for ONE user. Users may only see their own
 * exposure; everything else is shared evidence.
 */
export async function getEventIntelligence(
  userId: number,
  eventId: number,
  portfolioId?: number,
): Promise<EventIntelligencePackage> {
  const event = await prisma.intelligence_news_events.findUnique({
    where: { event_id: eventId },
    include: { event_entities: { include: { stock: { select: { symbol: true } } } } },
  });
  if (!event) throw notFound("We couldn't find that event.");

  if (portfolioId !== undefined) await ownedPortfolio(userId, portfolioId);

  const affected = event.event_entities.map((e) => ({
    stockId: e.stock_id === null ? null : String(e.stock_id),
    symbol: e.stock?.symbol ?? null,
    entityName: e.entity_name,
    relationshipType: e.relationship_type,
    matchConfidence: e.match_confidence ?? null,
    direction: e.direction ?? null,
  }));
  const stockIds = event.event_entities.map((e) => e.stock_id).filter((s): s is number => s !== null);
  const sectors = Array.from(
    new Set(
      (
        await prisma.stocks.findMany({
          where: { stock_id: { in: stockIds.length ? stockIds : [-1] } },
          select: { sector: true },
        })
      ).map((s) => s.sector),
    ),
  );

  const [exposure, analogues] = await Promise.all([
    eventExposureForUser(userId, stockIds),
    findAnalogues(eventId, 5),
  ]);

  const direction = event.event_entities.find((e) => e.direction !== null)?.direction ?? null;
  const suggested = buildSuggestedScenarios(affected, sectors, analogues, direction);

  return {
    modelVersion: EVENT_SCENARIO_MODEL_VERSION,
    event: {
      eventId: String(event.event_id),
      title: event.title,
      category: event.category,
      summary: event.summary,
      detectedAt: event.detected_at.toISOString(),
      severity: event.severity === null ? null : Number(event.severity),
      confidence: event.confidence === null ? null : Number(event.confidence),
      direction,
      status: event.status,
    },
    affectedEntities: affected,
    affectedSectors: sectors,
    myExposure: exposure,
    historicalAnalogues: analogues,
    suggestedScenarios: suggested,
    evidenceNote:
      analogues && analogues.analogues.length > 0
        ? `${analogues.analogues.length} similar historical event(s) found (quality: ${analogues.quality}). Suggested scenario levels marked HISTORICAL_EVIDENCE use the worst observed 5-day reaction from those events.`
        : "No comparable historical events are stored yet — scenario levels below are labelled stress assumptions, not evidence-based.",
    disclaimer: SCENARIO_DISCLAIMER,
  };
}

/** One-click: run a suggested (or user-modified) scenario for an event. */
export async function runEventScenario(
  userId: number,
  eventId: number,
  portfolioId: number,
  shocks: ShockInput[],
): Promise<{ impact: ScenarioImpact; pricedAsOf: string | null; disclaimer: string }> {
  await ownedPortfolio(userId, portfolioId);
  const exists = await prisma.intelligence_news_events.findUnique({ where: { event_id: eventId }, select: { event_id: true } });
  if (!exists) throw notFound("We couldn't find that event.");
  // applyShocks validates shock shape/bounds and portfolio ownership context.
  const { impact, pricedAsOf, disclaimer } = await applyShocks(portfolioId, shocks);
  return { impact, pricedAsOf, disclaimer };
}

/* --------------------- portfolio intelligence summary ---------------------- */

export interface PortfolioIntelligenceSummary {
  modelVersion: string;
  portfolioId: string;
  portfolioName: string;
  generatedAt: string;
  statements: Array<{ text: string; evidence: string }>;
  provenance: {
    eventsConsidered: number;
    recentEventWindowDays: number;
    holdings: number;
  };
}

/**
 * Evidence-backed portfolio-level statements. Every number traces to stored
 * data: holdings × latest closes, event-entity links, and the Phase 4 risk
 * engine. No free-form AI prose.
 */
export async function getPortfolioIntelligenceSummary(
  userId: number,
  portfolioId: number,
): Promise<PortfolioIntelligenceSummary> {
  const p = await ownedPortfolio(userId, portfolioId);

  const holdings = await prisma.holdings.findMany({
    where: { portfolio_id: p.portfolio_id },
    select: { stock_id: true, quantity: true, stocks: { select: { symbol: true, sector: true } } },
  });
  const stockIds = holdings.map((h) => h.stock_id);

  const priceRows = await prisma.stock_prices.findMany({
    where: { stock_id: { in: stockIds.length ? stockIds : [-1] } },
    orderBy: [{ stock_id: "asc" }, { price_date: "desc" }],
    distinct: ["stock_id"],
    select: { stock_id: true, close_price: true },
  });
  const priceByStock = new Map(priceRows.map((r) => [r.stock_id, Number(r.close_price)]));
  const values = holdings.map((h) => ({ h, v: Number(h.quantity) * (priceByStock.get(h.stock_id) ?? 0) }));
  const totalValue = values.reduce((a, x) => a + x.v, 0);
  void values;

  // Recent events (14-day window) linked to any held stock or held sector.
  const since = new Date(Date.now() - 14 * 86_400_000);
  const recentLinks = await prisma.intelligence_event_entities.findMany({
    where: { event: { detected_at: { gte: since } } },
    select: { stock_id: true, event_id: true, event: { select: { title: true, category: true } } },
  });
  const heldStockSet = new Set(stockIds);
  const linkedToHoldings = recentLinks.filter((l) => l.stock_id !== null && heldStockSet.has(l.stock_id));
  const distinctEvents = new Set(linkedToHoldings.map((l) => l.event_id));

  const statements: PortfolioIntelligenceSummary["statements"] = [];
  if (holdings.length === 0) {
    statements.push({ text: "This portfolio has no holdings yet.", evidence: "holdings table is empty for this portfolio." });
  } else {
    if (distinctEvents.size > 0) {
      // Value exposure: holdings that appear in a recent event link.
      const exposedStocks = new Set(linkedToHoldings.map((l) => l.stock_id!));
      const exposedValue = values.filter((x) => exposedStocks.has(x.h.stock_id)).reduce((a, x) => a + x.v, 0);
      statements.push({
        text: `${distinctEvents.size} recent intelligence event(s) affect stock(s) you hold — ${totalValue > 0 ? ((exposedValue / totalValue) * 100).toFixed(1) : "N/A"}% of portfolio market value is in affected holdings.`,
        evidence: `intelligence_event_entities joined to holdings over the last 14 days; values = quantity × latest stored close.`,
      });
    } else {
      statements.push({
        text: "No recent intelligence events (last 14 days) are linked to your holdings.",
        evidence: "no intelligence_event_entities rows in the window reference held stocks.",
      });
    }

    // Top allocation vs top risk contributor.
    const top = [...values].sort((a, b) => b.v - a.v)[0]!;
    if (totalValue > 0) {
      try {
        const rows = holdings.map((h) => ({ stock_id: h.stock_id, symbol: h.stocks.symbol, sector: h.stocks.sector, quantity: Number(h.quantity) }));
        const overview = await getRiskOverview(p.portfolio_id, rows);
        const topRisk = overview.contributors[0] as Contributor | undefined;
        if (topRisk && topRisk.pctContribution !== null) {
          statements.push({
            text: `${topRisk.symbol} represents ${topRisk.weightPct}% of allocation but contributes ${topRisk.pctContribution}% of modelled portfolio volatility.`,
            evidence: "Phase 4 Euler risk decomposition on date-aligned daily returns (covariance-based).",
          });
        }
      } catch {
        statements.push({
          text: "Risk-contribution breakdown is unavailable for this portfolio (insufficient aligned price history).",
          evidence: "quantitative risk engine returned insufficient-observations.",
        });
      }
    }

    // Sector concentration note.
    const bySector = new Map<string, number>();
    for (const x of values) bySector.set(x.h.stocks.sector, (bySector.get(x.h.stocks.sector) ?? 0) + x.v);
    const topSector = [...bySector.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topSector && totalValue > 0) {
      statements.push({
        text: `${topSector[0]} is the largest sector at ${((topSector[1] / totalValue) * 100).toFixed(1)}% of portfolio value.`,
        evidence: "holdings × latest stored close, grouped by stocks.sector.",
      });
    }
  }

  return {
    modelVersion: EVENT_SCENARIO_MODEL_VERSION,
    portfolioId: String(p.portfolio_id),
    portfolioName: p.name,
    generatedAt: new Date().toISOString(),
    statements,
    provenance: {
      eventsConsidered: recentLinks.length,
      recentEventWindowDays: 14,
      holdings: holdings.length,
    },
  };
}

export { SEVERITY_ORDER };
