/**
 * Market-data provider — Yahoo Finance (free, no API key, ₹0 cost).
 *
 * Endpoints used:
 *   GET /v8/finance/chart/{symbol}?range=&interval=   → OHLCV history + latest
 *     quote in `meta` (regularMarketPrice, longName, fiftyTwoWeek*). Works
 *     without cookies when a browser-like User-Agent is sent.
 *   GET /v10/finance/quoteSummary/{symbol}?crumb=     → fundamentals (P/E,
 *     dividend yield, market cap, sector/industry/description). Requires a
 *     session cookie + crumb; both are fetched once and reused. When the
 *     crumb flow fails, fundamentals degrade gracefully to nulls — the
 *     refresh still succeeds with price data.
 *
 * Robustness contract: every failure mode (timeout, rate limit, malformed
 * body, missing fields) resolves to null/empty rather than throwing; the
 * sync layer decides how to proceed. No value is ever fabricated.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface ProviderQuote {
  price: number | null;
  previousClose: number | null;
  currency: string | null;
  marketState: string | null;
  name: string | null;
}

export interface ProviderBar {
  date: string; // YYYY-MM-DD (exchange-local trading date)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface ProviderHistory {
  bars: ProviderBar[];
  quote: ProviderQuote;
}

export interface ProviderFundamentals {
  sector: string | null;
  industry: string | null;
  description: string | null;
  marketCapCr: number | null;
  peRatio: number | null;
  dividendYieldPct: number | null;
  /**
   * Req 2: last two fiscal years + growth stats (Yahoo annual income
   * statement / cash-flow / growth modules), crore-normalised. null when the
   * provider returned nothing usable — never fabricated.
   */
  financials: StockFinancials | null;
}

/** One fiscal year of annual statement data (₹ crore). */
export interface FiscalYearFinancials {
  fy: number | null;             // calendar year of period end
  periodEnd: string | null;      // ISO date
  revenueCr: number | null;
  netIncomeCr: number | null;
  ebitdaCr: number | null;
  operatingCashflowCr: number | null;
  freeCashflowCr: number | null;
}

/** Cached per-stock FY financials document (stored as stocks.financials JSONB). */
export interface StockFinancials {
  source: "YAHOO";
  fetchedAt: string;
  fiscalYears: FiscalYearFinancials[]; // newest first, up to 2
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

export class RateLimitError extends Error {
  constructor(message = "Rate limited by the market-data provider") {
    super(message);
    this.name = "RateLimitError";
  }
}

/* ------------------------------- internals -------------------------------- */

async function fetchText(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json,text/*;q=0.9", ...headers },
      signal: controller.signal,
      redirect: "follow",
    });
    if (res.status === 429) throw new RateLimitError();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/* ------------------------------ chart (prices) ----------------------------- */

interface ChartResponse {
  chart?: {
    result?: Array<{
      meta?: Record<string, unknown>;
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
    error?: { code?: string; description?: string } | null;
  };
}

/** Formats an epoch (seconds) as the exchange-local YYYY-MM-DD trading date. */
function localDateOf(epochSeconds: number, tzOffsetSeconds: number): string {
  const d = new Date((epochSeconds + tzOffsetSeconds) * 1000);
  return d.toISOString().slice(0, 10);
}

/** Fetches OHLCV history + the latest quote for one symbol. */
export async function fetchHistory(
  yahooSymbol: string,
  opts: { range?: string; interval?: string; timeoutMs?: number } = {},
): Promise<ProviderHistory> {
  const { range = "2y", interval = "1d", timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    yahooSymbol,
  )}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`;
  const body = parseJson<ChartResponse>(await fetchText(url, timeoutMs));
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error(body?.chart?.error?.description ?? "No chart data returned");

  const meta = result.meta ?? {};
  const tz = typeof meta["gmtoffset"] === "number" ? (meta["gmtoffset"] as number) : 19800;

  const quote: ProviderQuote = {
    price: typeof meta["regularMarketPrice"] === "number" ? (meta["regularMarketPrice"] as number) : null,
    previousClose:
      typeof meta["chartPreviousClose"] === "number" ? (meta["chartPreviousClose"] as number) : null,
    currency: typeof meta["currency"] === "string" ? (meta["currency"] as string) : null,
    marketState: null,
    name: typeof meta["longName"] === "string" ? (meta["longName"] as string) : null,
  };

  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const bars: ProviderBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const open = q.open?.[i];
    const high = q.high?.[i];
    const low = q.low?.[i];
    const close = q.close?.[i];
    // Skip rows with unusable OHLC — never coerce nulls into 0.
    if (
      typeof open !== "number" ||
      typeof high !== "number" ||
      typeof low !== "number" ||
      typeof close !== "number" ||
      [open, high, low, close].some((v) => !Number.isFinite(v) || v <= 0)
    ) {
      continue;
    }
    bars.push({
      date: localDateOf(ts[i]!, tz),
      open,
      high,
      low,
      close,
      volume: typeof q.volume?.[i] === "number" ? (q.volume![i] as number) : null,
    });
  }
  return { bars, quote };
}

/* -------------------------- quoteSummary (fundamentals) -------------------- */

interface SummaryResponse {
  quoteSummary?: {
    result?: Array<{
      assetProfile?: {
        sector?: string;
        industry?: string;
        longBusinessSummary?: string;
      };
      incomeStatementHistory?: {
        incomeStatementHistory?: Array<Record<string, { raw?: number } | undefined>>;
      };
      cashflowStatementHistory?: {
        cashflowStatements?: Array<Record<string, { raw?: number } | undefined>>;
      };
      summaryDetail?: {
        marketCap?: { raw?: number };
        trailingPE?: { raw?: number };
        forwardPE?: { raw?: number };
        dividendYield?: { raw?: number };
      };
      defaultKeyStatistics?: {
        sharesOutstanding?: { raw?: number };
      };
      price?: {
        regularMarketPrice?: { raw?: number };
        regularMarketDayHigh?: { raw?: number };
        regularMarketDayLow?: { raw?: number };
        regularMarketVolume?: { raw?: number };
      };
    }>;
  };
}

interface CrumbSession {
  cookie: string;
  crumb: string;
  fetchedAt: number;
}

let crumbSession: CrumbSession | null = null;
const CRUMB_TTL_MS = 60 * 60 * 1000; // refresh hourly at most

async function getCrumbSession(timeoutMs: number): Promise<CrumbSession | null> {
  if (crumbSession && Date.now() - crumbSession.fetchedAt < CRUMB_TTL_MS) return crumbSession;
  try {
    // Step 1: obtain the consent cookie.
    const res = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": UA },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
    if (!cookie) return null;

    // Step 2: exchange it for a crumb.
    const crumb = (await fetchText("https://query1.finance.yahoo.com/v1/test/getcrumb", timeoutMs, {
      Cookie: cookie,
    })).trim();
    if (!crumb || crumb.startsWith("{")) return null;

    crumbSession = { cookie, crumb, fetchedAt: Date.now() };
    return crumbSession;
  } catch {
    return null;
  }
}

/** Invalidates the cached crumb (e.g. after an Unauthorized response). */
export function resetCrumbSession(): void {
  crumbSession = null;
}

/** Fetches fundamentals for one symbol; null on any failure (never throws). */
export async function fetchFundamentals(
  yahooSymbol: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProviderFundamentals | null> {
  const session = await getCrumbSession(timeoutMs);
  if (!session) return null;

  const modules = "summaryDetail,defaultKeyStatistics,assetProfile,price,incomeStatementHistory,cashflowStatementHistory";
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    yahooSymbol,
  )}?modules=${modules}&crumb=${encodeURIComponent(session.crumb)}`;

  try {
    const text = await fetchText(url, timeoutMs, { Cookie: session.cookie });
    if (text.includes("Invalid Crumb") || text.includes("Unauthorized")) {
      resetCrumbSession();
      return null;
    }
    const body = parseJson<SummaryResponse>(text);
    const r = body?.quoteSummary?.result?.[0];
    if (!r) return null;

    const summary = r.summaryDetail ?? {};
    // Yahoo reports dividendYield as a fraction (0.0042 = 0.42%). Store percent.
    const rawDiv = summary.dividendYield?.raw;
    const divPct =
      typeof rawDiv === "number" && Number.isFinite(rawDiv)
        ? rawDiv > 1.5
          ? rawDiv // already in percent
          : rawDiv * 100
        : null;

    return {
      sector: r.assetProfile?.sector ?? null,
      industry: r.assetProfile?.industry ?? null,
      description: r.assetProfile?.longBusinessSummary ?? null,
      marketCapCr:
        typeof summary.marketCap?.raw === "number" && Number.isFinite(summary.marketCap.raw)
          ? summary.marketCap.raw / 1e7 // USD→INR quirk ignored; Yahoo returns INR for .NS symbols, crore = /1e7
          : null,
      peRatio:
        typeof summary.trailingPE?.raw === "number" && Number.isFinite(summary.trailingPE.raw)
          ? summary.trailingPE.raw
          : typeof summary.forwardPE?.raw === "number" && Number.isFinite(summary.forwardPE.raw)
            ? summary.forwardPE.raw
            : null,
      dividendYieldPct: divPct,
      financials: extractFinancials(r),
    };
  } catch {
    return null;
  }
}

const CR_TO_RAW = 1e7; // Yahoo returns INR units; crore = units / 1e7

function num(v: { raw?: number } | undefined): number | null {
  const raw = v?.raw;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * Extracts the last two fiscal years (newest first) + growth stats from the
 * quoteSummary result. Every field is nullable — absent provider data stays
 * null (Requirement: never fabricate financial figures).
 */
type SummaryResult = {
  assetProfile?: { sector?: string; industry?: string; longBusinessSummary?: string };
  incomeStatementHistory?: { incomeStatementHistory?: Array<Record<string, { raw?: number } | undefined>> };
  cashflowStatementHistory?: { cashflowStatements?: Array<Record<string, { raw?: number } | undefined>> };
};

function extractFinancials(r: SummaryResult): StockFinancials | null {
  const income = r.incomeStatementHistory?.incomeStatementHistory ?? [];
  const cashflow = r.cashflowStatementHistory?.cashflowStatements ?? [];
  if (income.length === 0 && cashflow.length === 0) return null;

  const fiscalYears: FiscalYearFinancials[] = income.slice(0, 2).map((row: Record<string, { raw?: number } | undefined>, i: number) => {
    const endRaw = (row as { endDate?: { fmt?: string } }).endDate?.fmt ?? null;
    const end = typeof endRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(endRaw) ? endRaw : null;
    const cf = cashflow[i] ?? {};
    return {
      fy: end === null ? null : Number(end.slice(0, 4)),
      periodEnd: end,
      revenueCr: num(row.totalRevenue) === null ? null : (num(row.totalRevenue) as number) / CR_TO_RAW,
      netIncomeCr: num(row.netIncome) === null ? null : (num(row.netIncome) as number) / CR_TO_RAW,
      ebitdaCr: num(row.ebitda) === null ? null : (num(row.ebitda) as number) / CR_TO_RAW,
      operatingCashflowCr: num(cf.totalOperatingCashFlow as { raw?: number } | undefined) === null ? null : (num(cf.totalOperatingCashFlow as { raw?: number } | undefined) as number) / CR_TO_RAW,
      freeCashflowCr: num(cf.freeCashflow as { raw?: number } | undefined) === null ? null : (num(cf.freeCashflow as { raw?: number } | undefined) as number) / CR_TO_RAW,
    };
  });

  // Growth stats: prefer Yahoo's reported figures; derive YoY from the two
  // stored annual rows when Yahoo's own growth field is absent.
  const latest = fiscalYears[0];
  const prior = fiscalYears[1];
  const deriveYoY = (a: number | null, b: number | null): number | null =>
    a !== null && b !== null && b !== 0 ? ((a - b) / Math.abs(b)) * 100 : null;
  const profitMarginsPct =
    latest && latest.revenueCr !== null && latest.revenueCr !== 0 && latest.netIncomeCr !== null
      ? (latest.netIncomeCr / latest.revenueCr) * 100
      : null;

  return {
    source: "YAHOO",
    fetchedAt: new Date().toISOString(),
    fiscalYears,
    growth: {
      earningsGrowthPct: deriveYoY(latest?.netIncomeCr ?? null, prior?.netIncomeCr ?? null),
      revenueGrowthPct: deriveYoY(latest?.revenueCr ?? null, prior?.revenueCr ?? null),
      profitMarginsPct,
      returnOnEquityPct: null, // equity module not fetched — honest null
      totalCashCr: null,
      totalDebtCr: null,
      ebitdaCr: latest?.ebitdaCr ?? null,
    },
  };
}
