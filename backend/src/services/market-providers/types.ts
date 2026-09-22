/**
 * Normalized market-data types (Feature A — multi-provider architecture).
 *
 * The rest of PortfolioIQ never sees vendor wire formats: providers return
 * these shapes, the sync layer stores them with provenance. Every result is
 * a MarketDataResult so provider failure is DATA, not an exception path the
 * caller must guess at.
 */

export type ProviderId = "YAHOO" | "ALPHA_VANTAGE";

/** Latest quote snapshot. */
export interface MarketQuote {
  price: number | null;
  previousClose: number | null;
  currency: string | null;
  marketState: string | null;
  name: string | null;
}

/** One normalized daily OHLCV bar. */
export interface HistoricalPrice {
  date: string; // YYYY-MM-DD (exchange-local trading date)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface ProviderHistory {
  bars: HistoricalPrice[];
  quote: MarketQuote;
}

export interface FundamentalData {
  sector: string | null;
  industry: string | null;
  description: string | null;
  marketCapCr: number | null;
  peRatio: number | null;
  dividendYieldPct: number | null;
  /**
   * Req 2: last two fiscal years + growth stats (Yahoo annual statements).
   * null = provider supplied none — callers keep the previous cache.
   */
  financials: StockFinancials | null;
}

/** Shape of the cached FY-financials JSONB document (written by the Yahoo adapter). */
export interface StockFinancials {
  source: string;
  fetchedAt: string;
  fiscalYears: Array<{
    fy: number | null;
    periodEnd: string | null;
    revenueCr: number | null;
    netIncomeCr: number | null;
    ebitdaCr: number | null;
    operatingCashflowCr: number | null;
    freeCashflowCr: number | null;
  }>;
  growth: {
    earningsGrowthPct: number | null;
    revenueGrowthPct: number | null;
    profitMarginsPct: number | null;
    returnOnEquityPct: number | null;
    totalCashCr: number | null;
    totalDebtCr: number | null;
    ebitdaCr: number | null;
  };
}

/** Every provider call returns one of these; failures never throw past the provider layer. */
export interface MarketDataResult<T> {
  ok: boolean;
  provider: ProviderId;
  /** Provider-reported retrieval timestamp (ISO). */
  asOf: string;
  data: T | null;
  /** Human-readable failure reason when ok === false. */
  error: string | null;
  /** True when the provider signalled rate limiting (drives backoff). */
  rateLimited: boolean;
}

export function okResult<T>(provider: ProviderId, data: T): MarketDataResult<T> {
  return { ok: true, provider, asOf: new Date().toISOString(), data, error: null, rateLimited: false };
}

export function failResult<T>(provider: ProviderId, error: string, rateLimited = false): MarketDataResult<T> {
  return { ok: false, provider, asOf: new Date().toISOString(), data: null, error, rateLimited };
}

// ------------------------------------------------------------- validation
/** Reject clearly malformed bars BEFORE storage; NULL/omission beats invented data. */
export function isValidBar(b: HistoricalPrice): boolean {
  const finite = (v: number) => Number.isFinite(v);
  if (!b || typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return false;
  const d = new Date(`${b.date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 86_400_000) return false; // future-dated
  if (![b.open, b.high, b.low, b.close].every(finite)) return false;
  if (b.volume !== null && (!finite(b.volume) || b.volume < 0)) return false;
  if (b.close <= 0 || b.low <= 0) return false; // prices must be positive
  if (b.high < b.low) return false;
  if (b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close)) return false;
  return true;
}

/** Quote sanity: a tradable price is finite and positive. */
export function isValidQuote(q: MarketQuote | null): boolean {
  return q !== null && q.price !== null && Number.isFinite(q.price) && q.price > 0;
}
