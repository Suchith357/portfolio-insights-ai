/**
 * Yahoo market-data provider adapter (Feature A).
 *
 * WRAPS the existing, working `market-data.provider.ts` implementation — no
 * duplicated HTTP/crumb/rate-limit logic, no behavioural change to the Yahoo
 * pipeline. This adapter exists only so the sync layer can treat every
 * provider uniformly and fall back when Yahoo fails.
 */

import {
  fetchFundamentals as yahooFetchFundamentals,
  fetchHistory as yahooFetchHistory,
  RateLimitError,
} from "../market-data.provider.js";
import { failResult, okResult, type FundamentalData, type MarketDataResult } from "./types.js";
import type { MarketDataProvider } from "./registry.js";

export class YahooProvider implements MarketDataProvider {
  readonly id = "YAHOO" as const;
  readonly displayName = "Yahoo Finance";

  isConfigured(): boolean {
    return true; // keyless free provider — always configured
  }

  configurationIssues(): string[] {
    return [];
  }

  /** Yahoo uses SYMBOL.NS for NSE equities. */
  toProviderSymbol(internalSymbol: string, yahooSymbol: string | null): string {
    return yahooSymbol ?? `${internalSymbol}.NS`;
  }

  async fetchHistory(
    providerSymbol: string,
    opts: { range?: string; interval?: string; timeoutMs?: number } = {},
  ): Promise<MarketDataResult<{ bars: import("./types.js").HistoricalPrice[]; quote: import("./types.js").MarketQuote }>> {
    try {
      const history = await yahooFetchHistory(providerSymbol, opts);
      return okResult(this.id, history);
    } catch (error) {
      return failResult(this.id, error instanceof Error ? error.message : String(error), error instanceof RateLimitError);
    }
  }

  async fetchFundamentals(providerSymbol: string, timeoutMs?: number): Promise<MarketDataResult<FundamentalData>> {
    const data = await yahooFetchFundamentals(providerSymbol, timeoutMs);
    if (!data) return failResult(this.id, "fundamentals unavailable (crumb session or provider response failed)");
    return okResult(this.id, data);
  }
}
