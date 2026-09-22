/**
 * Rule-based event categorisation (Intelligence Engine, Phase 1).
 *
 * Derives a BASIC event record from a stored article that matched our stock
 * universe. Keyword heuristics only — no AI reasoning, no NLP beyond word
 * boundaries. An article that matches nothing maps to category OTHER with
 * low confidence; the event row records its evidence so later phases can
 * re-derive with better logic.
 */
export type EventCategory =
  | "COMPANY"
  | "GOVERNMENT"
  | "POLICY"
  | "TAX"
  | "SUBSIDY"
  | "REGULATION"
  | "MACRO"
  | "COMMODITY"
  | "GEOPOLITICAL"
  | "SECTOR"
  | "EARNINGS"
  | "CORPORATE_ACTION"
  | "OTHER";

interface Rule {
  category: EventCategory;
  severity: number;
  patterns: RegExp[];
}

/** Ordered rules; the first strong hit wins, otherwise fallbacks apply. */
const RULES: Rule[] = [
  {
    category: "EARNINGS",
    severity: 3,
    patterns: [
      /\b(q[1-4]\s*(fy\d{2,4})?\s*(results|earnings|profit|loss|revenue))\b/i,
      /\b(quarterly\s*(results|earnings|profit))\b/i,
      /\b(net profit|net loss)\b/i,
      /\b(earnings (call|report|season))\b/i,
    ],
  },
  {
    category: "CORPORATE_ACTION",
    severity: 3,
    patterns: [
      /\b(merger|acquisition|acquire[sd]?|stake (sale|purchase)|divest|spin-?off|demerger)\b/i,
      /\b(buyback|share (buyback|repurchase))\b/i,
      /\b(dividend (announcement|declared))\b/i,
      /\b(ipo|rights issue|fund ?rais(e|ing)|capital raise)\b/i,
    ],
  },
  {
    category: "REGULATION",
    severity: 3,
    patterns: [
      /\b(sebi|trai|rbi\s*(circular|norms|rules|penalty|fine)|regulat(or|ion|ory))\b/i,
      /\b(ban|banned|penalty|show-?cause notice)\b/i,
    ],
  },
  {
    category: "POLICY",
    severity: 3,
    patterns: [
      /\b(government (policy|scheme|approval)|union budget|policy (change|reform))\b/i,
      /\b( parliament (passes|approves|debates))\b/i,
    ],
  },
  {
    category: "TAX",
    severity: 3,
    patterns: [
      /\b(gst|customs duty|excise|import duty|tax (cut|hike|slab|rate))\b/i,
      /\b(capital gains tax|securities transaction tax)\b/i,
    ],
  },
  {
    category: "SUBSIDY",
    severity: 2,
    patterns: [/\b(subsid(y|ies)|incentive scheme|pl(i|f) scheme)\b/i],
  },
  {
    category: "GOVERNMENT",
    severity: 2,
    patterns: [
      /\b(ministry|minister|cabinet|govern(ment|or)[^.]{0,30}(announce|approve|order))\b/i,
      /\b(government (announce|approve|plan|launch))\b/i,
    ],
  },
  {
    category: "COMMODITY",
    severity: 2,
    patterns: [
      /\b(crude (oil)?|brent|wti)\b[^.]{0,40}\b(price[sd]?|rally|slump|surge|fall)\b/i,
      /\b(steel|aluminium|copper|cement|coal|gold|silver)\b[^.]{0,40}\b(price[sd]?|rally|slump|surge)\b/i,
    ],
  },
  {
    category: "GEOPOLITICAL",
    severity: 4,
    patterns: [
      /\b(war|sanction[sd]?|trade (war|ban)|conflict|missile|attack)\b/i,
      /\b(opec[+\s]?(cut|output|production))\b/i,
    ],
  },
  {
    category: "MACRO",
    severity: 3,
    patterns: [
      /\b(rbi|repo rate|cpi|inflation|gdp|iip|pmi|fiscal deficit|current account)\b/i,
      /\b(interest rate (cut|hike|pause))\b/i,
      /\b(rupee (falls|rises|slides|weakens|strengthens))\b/i,
    ],
  },
];

const SECTOR_HINTS =
  /\b(sectors?|industry|industries|banks?|it services?|pharma|autos?|cement|steel|fmcg|telecom|energy|oil & gas)\b/i;

export interface CategorisedEvent {
  category: EventCategory;
  severity: number;
  confidence: number;
}

export function categoriseArticle(title: string, description: string | null): CategorisedEvent {
  const text = `${title} ${description ?? ""}`;
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        return { category: rule.category, severity: rule.severity, confidence: 0.7 };
      }
    }
  }
  if (SECTOR_HINTS.test(text)) {
    return { category: "SECTOR", severity: 2, confidence: 0.45 };
  }
  return { category: "OTHER", severity: 1, confidence: 0.3 };
}
