/**
 * Event importance scoring (Feature B).
 *
 * Deterministic, explainable, multi-signal — NOT sentiment. A random article
 * mentioning RELIANCE stays LOW; a major regulatory action directly affecting
 * RELIANCE with multiple independent sources becomes HIGH/CRITICAL.
 *
 * Score ∈ [0,1] = Σ (signal × weight); every component is reported so the UI
 * can show WHY an event received its importance.
 *
 *   severity    0.30  event severity (1..5 → 0.2..1.0)
 *   directness  0.20  DIRECT entity link = 1.0, SECTOR = 0.5, MACRO = 0.25
 *   relevance   0.15  best entity-match confidence/relevance (0..1)
 *   sources     0.15  independent source count: 1→0, 2→0.5, 3+→1
 *   recency     0.10  linear decay over 48 h from detection
 *   category    0.10  policy/tax/regulation/geo > earnings > company > other
 *
 * Thresholds: ≥0.85 DIRECT → CRITICAL; ≥0.70 HIGH; ≥0.50 MEDIUM; ≥0.40 WATCH; else LOW
 * (a single stale low-relevance mention of a company is LOW, not WATCH).
 */

export type Importance = "WATCH" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ImportanceInput {
  /** Event severity 1..5 (null → neutral 0.4). */
  severity: number | null;
  /** Best entity-match relevance/confidence (0..1, null → 0). */
  relevance: number | null;
  /** Strongest relationship among the event's entity links. */
  relationship: "DIRECT" | "SECTOR" | "MACRO" | "COMPETITOR" | "SUPPLIER" | "CUSTOMER" | "OTHER" | string;
  /** Count of distinct source names reporting the event. */
  sourceCount: number;
  /** Event detection time (drives recency decay). */
  detectedAt: Date;
  /** Now (injectable for tests). */
  now?: Date;
  category: string;
}

export interface ImportanceComponent {
  name: string;
  weight: number;
  raw: number; // 0..1 signal strength before weighting
  contribution: number;
  detail: string;
}

export interface ImportanceResult {
  score: number;
  importance: Importance;
  components: ImportanceComponent[];
}

const DIRECT_RELATIONSHIPS = new Set(["DIRECT"]);
const SECTOR_RELATIONSHIPS = new Set(["SECTOR"]);

function categoryWeight(category: string): { raw: number; detail: string } {
  const c = category.toUpperCase();
  if (["POLICY", "TAX", "SUBSIDY", "REGULATION", "GEOPOLITICAL", "GOVERNMENT"].includes(c)) {
    return { raw: 1, detail: `${c} events carry high materiality by category` };
  }
  if (["EARNINGS", "CORPORATE_ACTION"].includes(c)) return { raw: 0.8, detail: `${c} events are material company events` };
  if (["MACRO", "COMMODITY"].includes(c)) return { raw: 0.7, detail: `${c} events move markets indirectly` };
  if (c === "SECTOR") return { raw: 0.6, detail: "sector-level event" };
  if (c === "COMPANY") return { raw: 0.5, detail: "company-specific event" };
  return { raw: 0.3, detail: "uncategorised/general event" };
}

function directnessRaw(relationship: string): { raw: number; detail: string } {
  if (DIRECT_RELATIONSHIPS.has(relationship)) return { raw: 1, detail: "direct company link" };
  if (SECTOR_RELATIONSHIPS.has(relationship)) return { raw: 0.5, detail: "sector-level link only" };
  return { raw: 0.25, detail: "indirect/macro relationship" };
}

export function scoreImportance(input: ImportanceInput): ImportanceResult {
  const now = input.now ?? new Date();

  const severityRaw = input.severity === null ? 0.4 : Math.min(1, Math.max(0.2, input.severity / 5));
  const severity: ImportanceComponent = {
    name: "severity", weight: 0.3, raw: severityRaw, contribution: severityRaw * 0.3,
    detail: `event severity ${input.severity ?? "unrated"}/5`,
  };

  const d = directnessRaw(input.relationship);
  const directness: ImportanceComponent = { name: "directness", weight: 0.2, raw: d.raw, contribution: d.raw * 0.2, detail: d.detail };

  const relevanceRaw = Math.min(1, Math.max(0, input.relevance ?? 0));
  const relevance: ImportanceComponent = {
    name: "relevance", weight: 0.15, raw: relevanceRaw, contribution: relevanceRaw * 0.15,
    detail: `best entity match ${(relevanceRaw * 100).toFixed(0)}%`,
  };

  const sourcesRaw = input.sourceCount >= 3 ? 1 : input.sourceCount === 2 ? 0.5 : 0;
  const sources: ImportanceComponent = {
    name: "sources", weight: 0.15, raw: sourcesRaw, contribution: sourcesRaw * 0.15,
    detail: `${input.sourceCount} independent source${input.sourceCount === 1 ? "" : "s"}`,
  };

  const hoursOld = Math.max(0, (now.getTime() - input.detectedAt.getTime()) / 3_600_000);
  const recencyRaw = Math.min(1, Math.max(0, 1 - hoursOld / 48));
  const recency: ImportanceComponent = {
    name: "recency", weight: 0.1, raw: recencyRaw, contribution: recencyRaw * 0.1,
    detail: `detected ${hoursOld.toFixed(1)} h ago`,
  };

  const cat = categoryWeight(input.category);
  const category: ImportanceComponent = { name: "category", weight: 0.1, raw: cat.raw, contribution: cat.raw * 0.1, detail: cat.detail };

  const components = [severity, directness, relevance, sources, recency, category];
  const score = components.reduce((s, c) => s + c.contribution, 0);
  const isDirect = DIRECT_RELATIONSHIPS.has(input.relationship);

  let importance: Importance;
  if (score >= 0.85 && isDirect) importance = "CRITICAL";
  else if (score >= 0.7) importance = "HIGH";
  else if (score >= 0.5) importance = "MEDIUM";
  else if (score >= 0.4) importance = "WATCH";
  else importance = "LOW";

  return { score: Math.round(score * 1000) / 1000, importance, components };
}

/** Events that earn AI analysis / urgent-review alerts. */
export function isImportantEnoughForAi(importance: Importance): boolean {
  return importance === "HIGH" || importance === "CRITICAL";
}

/** Human label for the alert card's "Recommendation" line — advice-safe. */
export function importanceRecommendation(importance: Importance): string {
  switch (importance) {
    case "CRITICAL":
      return "URGENT REVIEW";
    case "HIGH":
      return "CLOSE MONITORING";
    case "MEDIUM":
      return "REVIEW WHEN CONVENIENT";
    case "WATCH":
      return "ON THE WATCHLIST";
    default:
      return "NO ACTION SUGGESTED";
  }
}
