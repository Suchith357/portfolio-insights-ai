/**
 * Market-data provider registry (Feature A — multi-provider architecture).
 *
 * Providers are independent, env-configurable modules behind one interface.
 * The registry exposes ordered fallback chains: the sync layer walks the
 * chain until a provider returns usable data, then records WHICH provider
 * answered (provenance) — it never silently overwrites good data with a
 * lower-quality source, and never fabricates values when all providers fail.
 */

import type {
  FundamentalData,
  HistoricalPrice,
  MarketQuote,
  MarketDataResult,
  ProviderId,
} from "./types.js";

/** The provider contract every market-data source implements. */
export interface MarketDataProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  /** True when the provider is usable right now (credentials present). */
  isConfigured(): boolean;
  /** Reasons the provider cannot be used; empty when usable. */
  configurationIssues(): string[];
  fetchHistory(
    providerSymbol: string,
    opts: { range?: string; interval?: string; timeoutMs?: number },
  ): Promise<MarketDataResult<{ bars: HistoricalPrice[]; quote: MarketQuote }>>;
  /** Best-effort fundamentals; providers without the capability return ok:false "not supported". */
  fetchFundamentals(providerSymbol: string, timeoutMs?: number): Promise<MarketDataResult<FundamentalData>>;
  /** Maps our internal symbol (e.g. RELIANCE) to the provider's symbol. */
  toProviderSymbol(internalSymbol: string, yahooSymbol: string | null): string;
}

import { YahooProvider } from "./yahoo.provider.js";
import { AlphaVantageProvider } from "./alphavantage.provider.js";

const YAHOO = new YahooProvider();
const ALPHA_VANTAGE = new AlphaVantageProvider();

/** All implemented providers, in default preference order (for diagnostics). */
export function allMarketProviders(): MarketDataProvider[] {
  return [YAHOO, ALPHA_VANTAGE];
}

/**
 * Fallback chain for price history: YAHOO first (existing primary), then any
 * configured secondary. Providers with missing credentials are skipped, not
 * attempted — a missing Alpha Vantage key must never add latency or errors.
 */
export function historyChain(): MarketDataProvider[] {
  const chain: MarketDataProvider[] = [YAHOO];
  if (ALPHA_VANTAGE.isConfigured()) chain.push(ALPHA_VANTAGE);
  return chain;
}

export { YAHOO, ALPHA_VANTAGE };
