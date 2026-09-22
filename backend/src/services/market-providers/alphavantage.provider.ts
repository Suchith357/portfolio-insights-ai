/**
 * Alpha Vantage market-data provider (Feature A — optional secondary).
 *
 * Free tier reality (verified against current API docs):
 *  - TIME_SERIES_DAILY: ~25 requests/day, 5 requests/minute on the free key.
 *  - OVERVIEW (fundamentals): shares the same daily budget.
 *  - Data is END-OF-DAY; no intraday quotes on the free tier.
 *
 * Cost contract: the provider is fully OPTIONAL. Without ALPHA_VANTAGE_API_KEY
 * it is skipped everywhere; with a key it only serves as FALLBACK when Yahoo
 * fails — it never becomes a mandatory dependency and never adds latency when
 * unconfigured. Failures return MarketDataResult{ok:false}; nothing throws
 * into the sync path and no value is ever fabricated.
 */

import { env } from "../../utils/env.js";
import { failResult, okResult, type FundamentalData, type MarketDataResult, type HistoricalPrice, type MarketQuote } from "./types.js";
import type { MarketDataProvider } from "./registry.js";

const BASE = "https://www.alphavantage.co/query";
const DEFAULT_TIMEOUT_MS = 12_000;

interface AvTimeSeriesDaily {
  "Time Series (Daily)"?: Record<string, Record<string, string>>;
  "Meta Data"?: Record<string, string>;
  "Error Message"?: string;
  "Note"?: string;
  "Information"?: string;
}

interface AvOverview {
  Name?: string;
  Sector?: string;
  Industry?: string;
  Description?: string;
  MarketCapitalization?: string;
  PERatio?: string;
  DividendYield?: string;
  "Error Message"?: string;
  Note?: string;
  Information?: string;
}

function num(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export class AlphaVantageProvider implements MarketDataProvider {
  readonly id = "ALPHA_VANTAGE" as const;
  readonly displayName = "Alpha Vantage";

  isConfigured(): boolean {
    return env.alphaVantageApiKey !== null;
  }

  configurationIssues(): string[] {
    return env.alphaVantageApiKey === null
      ? ["ALPHA_VANTAGE_API_KEY is not set — provider unavailable (optional)."]
      : [];
  }

  /** Alpha Vantage NSE symbols are plain tickers (RELIANCE), no suffix. */
  toProviderSymbol(internalSymbol: string, _yahooSymbol: string | null): string {
    return internalSymbol;
  }

  private async get<T>(params: Record<string, string>, timeoutMs: number): Promise<MarketDataResult<T>> {
    const key = env.alphaVantageApiKey;
    if (!key) return failResult<T>(this.id, "ALPHA_VANTAGE_API_KEY is not configured");
    const url = `${BASE}?${new URLSearchParams({ ...params, apikey: key }).toString()}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429) return failResult<T>(this.id, "rate limited by Alpha Vantage", true);
      if (!res.ok) return failResult<T>(this.id, `HTTP ${res.status}`);
      const body = (await res.json()) as T & { "Error Message"?: string; Note?: string; Information?: string };
      if (body["Error Message"]) return failResult<T>(this.id, `provider error: ${body["Error Message"].slice(0, 160)}`);
      if (body.Note || body.Information) {
        // Free-tier quota / rate notice — transient, back off.
        return failResult<T>(this.id, `quota/rate notice: ${(body.Note ?? body.Information ?? "").slice(0, 160)}`, true);
      }
      return okResult(this.id, body);
    } catch (error) {
      const msg = (error as Error).name === "TimeoutError" ? "request timed out" : (error as Error).message;
      return failResult<T>(this.id, msg);
    }
  }

  async fetchHistory(
    providerSymbol: string,
    opts: { range?: string; interval?: string; timeoutMs?: number } = {},
  ): Promise<MarketDataResult<{ bars: HistoricalPrice[]; quote: MarketQuote }>> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const res = await this.get<AvTimeSeriesDaily>(
      { function: "TIME_SERIES_DAILY", symbol: providerSymbol, outputsize: (opts.range ?? "10d") === "2y" ? "full" : "compact" },
      timeoutMs,
    );
    if (!res.ok || !res.data) return { ok: false, provider: this.id, asOf: res.asOf, data: null, error: res.error, rateLimited: res.rateLimited };

    const series = res.data["Time Series (Daily)"];
    if (!series) return failResult(this.id, "no daily series in provider response");

    // Provider returns newest-first; normalize to our oldest-first bar shape.
    const entries = Object.entries(series).sort(([a], [b]) => (a < b ? -1 : 1));
    const bars: HistoricalPrice[] = [];
    let lastClose: number | null = null;
    for (const [date, row] of entries) {
      const open = num(row["1. open"]);
      const high = num(row["2. high"]);
      const low = num(row["3. low"]);
      const close = num(row["4. close"]);
      const volume = num(row["5. volume"]);
      if (open === null || high === null || low === null || close === null) continue; // skip malformed rows
      bars.push({ date, open, high, low, close, volume });
      lastClose = close;
    }
    if (bars.length === 0) return failResult(this.id, "series present but contained no usable bars");

    const latest = bars[bars.length - 1]!;
    const quote: MarketQuote = {
      price: latest.close,
      previousClose: lastClose !== null && bars.length > 1 ? bars[bars.length - 2]!.close : null,
      currency: "INR",
      marketState: "CLOSED", // EOD data on the free tier — never claim live
      name: res.data["Meta Data"]?.["2. Symbol"] ?? null,
    };
    return okResult(this.id, { bars, quote });
  }

  async fetchFundamentals(providerSymbol: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<MarketDataResult<FundamentalData>> {
    const res = await this.get<AvOverview>({ function: "OVERVIEW", symbol: providerSymbol }, timeoutMs);
    if (!res.ok || !res.data) return { ok: false, provider: this.id, asOf: res.asOf, data: null, error: res.error, rateLimited: res.rateLimited };
    const overview = res.data;
    if (!overview.Name && !overview.Sector) return failResult(this.id, "empty OVERVIEW payload");
    const divRaw = num(overview.DividendYield);
    return okResult(this.id, {
      sector: overview.Sector ?? null,
      industry: overview.Industry ?? null,
      description: overview.Description ?? null,
      marketCapCr: num(overview.MarketCapitalization) === null ? null : num(overview.MarketCapitalization)! / 1e7,
      peRatio: num(overview.PERatio),
      // AV reports yield as a fraction (0.0042 = 0.42%) — normalize to percent.
      dividendYieldPct: divRaw === null ? null : divRaw > 1.5 ? divRaw : divRaw * 100,
      financials: null, // AV OVERVIEW carries no annual statements — honest null
    });
  }
}
