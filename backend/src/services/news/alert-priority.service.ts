/**
 * Alert priority layer (Feature B).
 *
 * BLENDS two deterministic engines — it replaces neither:
 *   1. event-importance (multi-signal, exposure-agnostic), and
 *   2. Phase 3's impact priority (relevance × severity × confidence × exposure).
 *
 * The final priority (WATCH/LOW/MEDIUM/HIGH/CRITICAL) is what the existing
 * `alerts` table stores; dedup (user+event+exposure kind) and the stock
 * cooldown in alert-delivery.service.ts are untouched. Same event from three
 * providers = ONE event = at most ONE alert per user, with multiple evidence
 * sources — never three alerts.
 *
 * Advice-safe: CRITICAL means "review urgently", never "sell".
 */

import type { Importance } from "./event-importance.service.js";

export type FinalPriority = "WATCH" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface PriorityBlendInput {
  /** Multi-signal event importance (event-importance.service). */
  eventImportance: Importance;
  /** Importance score 0..1 with component breakdown available upstream. */
  importanceScore: number;
  /** Phase 3 impact priority derived from the user's exposure row. */
  impactPriority: "CRITICAL" | "HIGH" | "MEDIUM" | "WATCHLIST" | "LOW";
  /** Portfolio weight of the affected stock (0..1) or null. */
  portfolioWeight: number | null;
  /** True when the impact row is a DIRECT_HOLDING. */
  isDirectHolding: boolean;
}

const RANK: Record<FinalPriority, number> = { WATCH: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const IMPACT_RANK: Record<PriorityBlendInput["impactPriority"], number> = {
  LOW: 1, WATCHLIST: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4,
};

/**
 * Blend rule (explainable):
 *   base          = rank(impact priority)   — exposure-aware floor
 *   importance    = rank(event importance)  — event-intrinsic signal
 *   direct boost  = +1 when the user directly holds the stock AND
 *                   importance ≥ HIGH (a severe event on an owned stock
 *                   deserves urgency even at modest weight)
 *   exposure cap  = a CRITICAL final priority additionally requires either
 *                   importance CRITICAL, or (HIGH importance + direct holding)
 *   floor         = WATCH for watchlist/sector rows that pass relevance —
 *                   never silently drop surfaced rows
 */
export function blendPriority(input: PriorityBlendInput): { priority: FinalPriority; rationale: string } {
  const impact = IMPACT_RANK[input.impactPriority];
  const importance = RANK[input.eventImportance === "WATCH" ? "LOW" : input.eventImportance];

  // Non-owned rows (watchlist/sector) inherit Phase 3's contract: they surface
  // as WATCH/MEDIUM at most — a watched stock can never outrank an owned one.
  const ceiling = input.isDirectHolding ? RANK.CRITICAL : RANK.MEDIUM;

  let score = Math.min(Math.max(impact, importance), ceiling);
  const reasons: string[] = [`impact=${input.impactPriority}`, `event importance=${input.eventImportance}`];

  if (input.isDirectHolding && (input.eventImportance === "HIGH" || input.eventImportance === "CRITICAL")) {
    score = Math.max(score, RANK.MEDIUM + 1);
    reasons.push("direct holding of an affected stock with a HIGH+ importance event");
  }
  if (input.portfolioWeight !== null && input.portfolioWeight >= 0.15) {
    reasons.push(`significant portfolio weight ${(input.portfolioWeight * 100).toFixed(1)}%`);
  }

  // CRITICAL gate: needs intrinsic CRITICAL importance, or HIGH + direct.
  if (score >= RANK.CRITICAL && !(input.eventImportance === "CRITICAL" || (input.eventImportance === "HIGH" && input.isDirectHolding))) {
    score = RANK.HIGH;
    reasons.push("critical gated to high (no intrinsic critical importance)");
  }

  const priority = (Object.keys(RANK) as FinalPriority[]).find((k) => RANK[k] === score) ?? "LOW";
  return { priority, rationale: reasons.join("; ") };
}

/** Map the final priority onto the alerts.severity CHECK values. */
export function priorityToAlertSeverity(priority: FinalPriority): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  switch (priority) {
    case "CRITICAL": return "CRITICAL";
    case "HIGH": return "HIGH";
    case "MEDIUM": return "MEDIUM";
    default: return "LOW";
  }
}
