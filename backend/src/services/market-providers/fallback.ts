/**
 * Provider fallback orchestration (Feature A).
 *
 *   Yahoo ── success ──▶ normalize + validate + store (provenance=YAHOO)
 *      │ failure
 *      ▼
 *   next configured provider ── success ──▶ store (provenance=ALPHA_VANTAGE)
 *      │ failure
 *      ▼
 *   MarketDataResult{ok:false} — NO data invented, sync records the failure
 *
 * Data-quality gate: every bar passes isValidBar() BEFORE storage; a provider
 * payload that fails validation is treated as a provider failure, not stored
 * partially. Provenance is preserved per record via the data_source column.
 */

import { historyChain, type MarketDataProvider } from "./registry.js";
import { isValidBar, type FundamentalData, type HistoricalPrice, type MarketQuote, type MarketDataResult } from "./types.js";

export interface FallbackAttempt {
  provider: string;
  ok: boolean;
  error: string | null;
  /** Milliseconds the provider call took. */
  durationMs: number;
}

export interface FallbackOutcome {
  /** Null when every provider failed — callers store nothing and report honestly. */
  data: { bars: HistoricalPrice[]; quote: MarketQuote } | null;
  /** Provider that produced `data` (provenance for the data_source column). */
  provider: string | null;
  attempts: FallbackAttempt[];
}

export async function fetchHistoryWithFallback(
  internalSymbol: string,
  yahooSymbol: string | null,
  opts: { range?: string; timeoutMs?: number } = {},
): Promise<FallbackOutcome> {
  const attempts: FallbackAttempt[] = [];
  for (const provider of historyChain()) {
    const providerSymbol = provider.toProviderSymbol(internalSymbol, yahooSymbol);
    const started = Date.now();
    let result: MarketDataResult<{ bars: HistoricalPrice[]; quote: MarketQuote }>;
    try {
      result = await provider.fetchHistory(providerSymbol, { range: opts.range ?? "10d", timeoutMs: opts.timeoutMs });
    } catch (error) {
      result = { ok: false, provider: provider.id, asOf: new Date().toISOString(), data: null, error: (error as Error).message, rateLimited: false };
    }
    const durationMs = Date.now() - started;
    if (!result.ok || !result.data) {
      attempts.push({ provider: provider.id, ok: false, error: result.error ?? "unknown provider error", durationMs });
      continue; // try the next provider
    }
    // Data-quality gate before accepting a provider's answer.
    const validBars = result.data.bars.filter(isValidBar);
    if (validBars.length === 0) {
      attempts.push({ provider: provider.id, ok: false, error: "all returned bars failed sanity validation", durationMs });
      continue;
    }
    attempts.push({ provider: provider.id, ok: true, error: null, durationMs });
    return { data: { bars: validBars, quote: result.data.quote }, provider: provider.id, attempts };
  }
  return { data: null, provider: null, attempts };
}

export async function fetchFundamentalsWithFallback(
  internalSymbol: string,
  yahooSymbol: string | null,
  timeoutMs?: number,
): Promise<{ data: FundamentalData | null; provider: string | null; attempts: FallbackAttempt[] }> {
  const attempts: FallbackAttempt[] = [];
  for (const provider of historyChain()) {
    const providerSymbol = provider.toProviderSymbol(internalSymbol, yahooSymbol);
    const started = Date.now();
    let result: MarketDataResult<FundamentalData>;
    try {
      result = await provider.fetchFundamentals(providerSymbol, timeoutMs);
    } catch (error) {
      result = { ok: false, provider: provider.id, asOf: new Date().toISOString(), data: null, error: (error as Error).message, rateLimited: false };
    }
    const durationMs = Date.now() - started;
    if (!result.ok || !result.data) {
      attempts.push({ provider: provider.id, ok: false, error: result.error ?? "unknown provider error", durationMs });
      continue;
    }
    attempts.push({ provider: provider.id, ok: true, error: null, durationMs });
    return { data: result.data, provider: provider.id, attempts };
  }
  return { data: null, provider: null, attempts };
}

/** Diagnostics for the admin status endpoint. */
export function providerStatuses(): Array<{ id: string; displayName: string; configured: boolean; issues: string[] }> {
  return historyChain().map((p: MarketDataProvider) => ({
    id: p.id,
    displayName: p.displayName,
    configured: p.isConfigured(),
    issues: p.configurationIssues(),
  }));
}
