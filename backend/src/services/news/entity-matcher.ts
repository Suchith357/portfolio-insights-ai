/**
 * Entity matching (Intelligence Engine, Phase 1).
 *
 * Associates normalized articles with the EXISTING 38-stock universe using:
 *   1. provider-reported entities (e.g. Marketaux tickers + sentiment)
 *   2. company-name phrase match against title/snippet
 *   3. symbol word-boundary match (title/snippet)
 *   4. conservative sector-word match (relationship SECTOR, low confidence)
 *
 * An article is only linked to a stock on positive evidence; nothing is
 * fabricated. The stocks table structure is NOT modified — matching runs on
 * an in-memory alias index built from existing columns (symbol, company_name,
 * yahoo_symbol) plus a small static alias list for well-known names.
 */
import { prisma } from "../../utils/prisma.js";

export interface StockMatch {
  stockId: number;
  symbol: string;
  matchedValue: string;
  /** How the match was established — kept on the entity row for auditability. */
  basis: "PROVIDER_SYMBOL" | "PROVIDER_NAME" | "NAME_TEXT" | "SYMBOL_TEXT" | "SECTOR_TEXT";
  /** 0..1 heuristic confidence (provider evidence > text evidence). */
  confidence: number;
  /**
   * Phase 3 explainable tier derived from the basis: provider tickers are
   * VERY_HIGH, exact company names / verified aliases HIGH, contextual text
   * matches MEDIUM, generic sector keywords LOW. LOW matches never become
   * direct-relationship claims downstream.
   */
  matchConfidence: "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW";
  sentimentScore: number | null;
  sentimentLabel: string | null;
  relevanceScore: number | null;
}

/** Numeric basis → tier mapping (single source of truth for the label). */
export function matchConfidenceTier(basis: StockMatch["basis"]): StockMatch["matchConfidence"] {
  switch (basis) {
    case "PROVIDER_SYMBOL":
      return "VERY_HIGH"; // provider ticker — strongest evidence
    case "PROVIDER_NAME":
    case "NAME_TEXT":
      return "HIGH"; // exact company name or verified alias
    case "SYMBOL_TEXT":
      return "MEDIUM"; // strong contextual textual match
    case "SECTOR_TEXT":
      return "LOW"; // generic keyword — indirect only
  }
}

export interface StockAliasIndex {
  bySymbol: Map<string, number>;
  byCompanyName: Map<string, number>;
  /** Lowercased alias phrase → stock id. */
  byAlias: Map<string, number>;
  bySector: Map<string, number[]>;
  stocks: Array<{ stockId: number; symbol: string; companyName: string; sector: string }>;
}

/** Well-known short-name aliases for the existing universe (symbol-keyed). */
const KNOWN_ALIASES: Record<string, string[]> = {
  RELIANCE: ["ril", "reliance industries", "reliance"],
  TCS: ["tata consultancy services", "tcs"],
  INFY: ["infosys"],
  HDFCBANK: ["hdfc bank", "hdfcbank"],
  ICICIBANK: ["icici bank", "icicibank"],
  SBIN: ["state bank of india", "sbi"],
  ITC: ["itc"],
  HINDUNILVR: ["hindustan unilever", "hul"],
  SUNPHARMA: ["sun pharma", "sun pharmaceutical"],
  DRREDDY: ["dr reddy", "dr. reddy", "dr reddy's laboratories"],
  TATAMOTORS: ["tata motors", "tmpv"],
  "M&M": ["mahindra & mahindra", "mahindra and mahindra", "m&m"],
  TATASTEEL: ["tata steel"],
  JSWSTEEL: ["jsw steel"],
  BHARTIARTL: ["bharti airtel", "airtel"],
  LT: ["larsen & toubro", "larsen and toubro", "l&t"],
  ADANIPORTS: ["adani ports", "adani"],
  ULTRACEMCO: ["ultratech cement", "ultratech"],
  MARUTI: ["maruti suzuki", "maruti"],
  KOTAKBANK: ["kotak mahindra bank", "kotak bank", "kotak"],
  BAJFINANCE: ["bajaj finance"],
  CIPLA: ["cipla"],
  ONGC: ["oil and natural gas", "ongc"],
  NTPC: ["ntpc"],
  HINDALCO: ["hindalco"],
  WIPRO: ["wipro"],
  HCLTECH: ["hcl tech", "hcl technologies", "hcltech"],
  NESTLEIND: ["nestle india", "nestlé india"],
  DLF: ["dlf"],
  IDEA: ["vodafone idea", "vi"],
  TATAPOWER: ["tata power"],
  TITAN: ["titan company", "titan"],
  ASIANPAINT: ["asian paints"],
  BAJAJFINSV: ["bajaj finserv"],
  ADANIENT: ["adani enterprises", "adani group"],
  COALINDIA: ["coal india"],
  GRASIM: ["grasim"],
  HEROMOTOCO: ["hero motocorp", "hero moto"],
};

/** Build the alias index from the EXISTING stocks table (read-only). */
export async function buildStockAliasIndex(): Promise<StockAliasIndex> {
  const stocks = await prisma.stocks.findMany({
    where: { is_active: true },
    select: { stock_id: true, symbol: true, company_name: true, sector: true, yahoo_symbol: true },
  });

  const idx: StockAliasIndex = {
    bySymbol: new Map(),
    byCompanyName: new Map(),
    byAlias: new Map(),
    bySector: new Map(),
    stocks: [],
  };

  for (const s of stocks) {
    const rec = { stockId: s.stock_id, symbol: s.symbol, companyName: s.company_name, sector: s.sector };
    idx.stocks.push(rec);
    idx.bySymbol.set(s.symbol.toUpperCase(), s.stock_id);
    idx.byCompanyName.set(s.company_name.toLowerCase(), s.stock_id);
    const yahooBase = (s.yahoo_symbol ?? "").split(".")[0]?.toUpperCase();
    if (yahooBase) idx.bySymbol.set(yahooBase, s.stock_id);
    const aliases = KNOWN_ALIASES[s.symbol] ?? [];
    for (const alias of aliases) idx.byAlias.set(alias.toLowerCase(), s.stock_id);
    const sectorKey = s.sector.toLowerCase();
    const arr = idx.bySector.get(sectorKey) ?? [];
    arr.push(s.stock_id);
    idx.bySector.set(sectorKey, arr);
  }
  return idx;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phrasePresent(haystackLower: string, phrase: string): boolean {
  const p = phrase.toLowerCase().replace(/\s+/g, " ").trim();
  if (p.length < 3) return false;
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(p)}([^a-z0-9]|$)`);
  return re.test(haystackLower);
}

/**
 * Match one article's text + provider entities to stocks.
 * Returns at most `maxMatches` highest-confidence StockMatch rows.
 */
export function matchArticleToStocks(
  article: { title: string; description: string | null; entities: Array<{
    name: string; symbol: string | null; relevanceScore: number | null;
    sentimentScore: number | null; sentimentLabel: string | null;
  }> },
  idx: StockAliasIndex,
  maxMatches = 8,
): StockMatch[] {
  const textLower = `${article.title} ${article.description ?? ""}`
    .toLowerCase()
    .replace(/\s+/g, " ");
  const byStock = new Map<number, StockMatch>();

  const upsert = (
    stockId: number,
    matchedValue: string,
    basis: StockMatch["basis"],
    confidence: number,
    sentimentScore: number | null,
    sentimentLabel: string | null,
    relevanceScore: number | null,
  ) => {
    const prev = byStock.get(stockId);
    if (!prev || confidence > prev.confidence) {
      const stock = idx.stocks.find((s) => s.stockId === stockId);
      if (!stock) return;
      byStock.set(stockId, {
        stockId,
        symbol: stock.symbol,
        matchedValue,
        basis,
        confidence,
        matchConfidence: matchConfidenceTier(basis),
        sentimentScore,
        sentimentLabel,
        relevanceScore,
      });
    }
  };

  // 1) Provider entities (strongest evidence).
  for (const e of article.entities) {
    const symbolKey = (e.symbol ?? "").split(".")[0]?.toUpperCase();
    if (symbolKey && idx.bySymbol.has(symbolKey)) {
      upsert(
        idx.bySymbol.get(symbolKey)!,
        e.name,
        "PROVIDER_SYMBOL",
        0.95,
        e.sentimentScore,
        e.sentimentLabel,
        e.relevanceScore,
      );
      continue;
    }
    const nameKey = e.name.toLowerCase();
    if (idx.byCompanyName.has(nameKey)) {
      upsert(idx.byCompanyName.get(nameKey)!, e.name, "PROVIDER_NAME", 0.85, e.sentimentScore, e.sentimentLabel, e.relevanceScore);
      continue;
    }
    for (const [alias, stockId] of idx.byAlias) {
      if (nameKey.includes(alias)) {
        upsert(stockId, e.name, "PROVIDER_NAME", 0.7, e.sentimentScore, e.sentimentLabel, e.relevanceScore);
        break;
      }
    }
  }

  // 2) Company-name phrases present in the text.
  for (const [name, stockId] of idx.byCompanyName) {
    if (phrasePresent(textLower, name)) upsert(stockId, name, "NAME_TEXT", 0.6, null, null, null);
  }

  // 3) Symbol token present in the text (word-boundary, uppercase only).
  for (const [symbol, stockId] of idx.bySymbol) {
    if (symbol.length < 2) continue;
    const re = new RegExp(`(^|[^A-Z0-9])${escapeRegex(symbol)}([^A-Z0-9]|$)`);
    if (re.test(textLower.toUpperCase())) upsert(stockId, symbol, "SYMBOL_TEXT", 0.5, null, null, null);
  }

  // 4) Sector mention (weak, indirect evidence only).
  for (const [sector, stockIds] of idx.bySector) {
    if (sector.length >= 4 && phrasePresent(textLower, sector)) {
      for (const stockId of stockIds.slice(0, 6)) {
        upsert(stockId, sector, "SECTOR_TEXT", 0.25, null, null, null);
      }
    }
  }

  return Array.from(byStock.values())
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxMatches);
}
