/**
 * Macro & FX context providers (free/trusted provider expansion).
 *
 * Two auxiliary data sources that DO NOT fit the price-history MarketDataProvider
 * contract (they supply no OHLC bars) but materially improve Deep AI Research:
 *
 *  1. WorldBankMacroProvider — Reserve-Bank-grade macro indicators for India
 *     (CPI inflation, GDP growth, real interest rate, official USD/INR rate)
 *     from the World Bank Indicators API. Official documentation states API
 *     keys are "no longer necessary"; the API is free and open.
 *     https://datahelpdesk.worldbank.org/knowledgebase/articles/889392
 *
 *  2. FrankfurterFxProvider — USD/INR reference rates published by the
 *     European Central Bank, served through the open-source Frankfurter API
 *     (no key, free). https://api.frankfurter.dev  (docs: frankfurter.dev)
 *
 * Design rules (same as the rest of the provider layer):
 *  - failure is DATA (ok:false + reason), never an exception that can crash
 *    research or ingestion;
 *  - every value keeps [source, asOf] provenance — the LLM quotes it, never
 *    invents it;
 *  - responses are cached in-process with a TTL appropriate to the data's
 *    update cadence (World Bank updates annually/quarterly, ECB daily), which
 *    also keeps request volumes polite;
 *  - missing/null observations stay null — nothing is interpolated.
 */

import { aiConfig } from "../../ai/config.js";

export interface MacroIndicator {
  code: string;
  label: string;
  unit: string;
  latestYear: string | null;
  latestValue: number | null;
  previousYear: string | null;
  previousValue: number | null;
  source: string;
}

export interface MacroSnapshot {
  ok: boolean;
  reason?: string;
  indicators: MacroIndicator[];
  fetchedAt: string;
}

export interface FxSnapshot {
  ok: boolean;
  reason?: string;
  usdInr: number | null;
  asOf: string | null;
  change1mPct: number | null;
  change3mPct: number | null;
  source: string;
  fetchedAt: string;
}

/** World Bank indicator codes — curated to what the research prompt can use. */
const WB_INDICATORS: Array<{ code: string; label: string; unit: string }> = [
  { code: "FP.CPI.TOTL.ZG", label: "CPI inflation (annual %)", unit: "%" },
  { code: "NY.GDP.MKTP.KD.ZG", label: "GDP growth (annual %)", unit: "%" },
  { code: "FR.INR.RINR", label: "Real interest rate (%)", unit: "%" },
];

const WB_BASE = "https://api.worldbank.org/v2/country/IND/indicator";
const FX_BASE = "https://api.frankfurter.dev/v1";

/** Simple monotonic TTL cache so one research run never hammers an open API. */
const cache = new Map<string, { at: number; value: unknown }>();
function cacheGet<T>(key: string, ttlMs: number): T | null {
  const hit = cache.get(key) as { at: number; value: unknown } | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  return null;
}
function cacheSet(key: string, value: { at: number; value: unknown }): void {
  cache.set(key, value);
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * World Bank macro snapshot. Normalises the [meta, rows] wire shape and keeps
 * only the two most recent NON-NULL observations per indicator (the API
 * returns nulls for the current, not-yet-published year).
 */
export async function fetchWorldBankMacro(timeoutMs = 10_000): Promise<MacroSnapshot> {
  const TTL = 24 * 60 * 60 * 1000; // annual/quarterly series — one refresh/day is generous
  const cached = cacheGet<MacroSnapshot>("wb-macro", TTL);
  if (cached) return cached;
  const fetchedAt = new Date().toISOString();
  try {
    const results = await Promise.all(
      WB_INDICATORS.map(async ({ code, label, unit }) => {
        const url = `${WB_BASE}/${code}?format=json&per_page=8`;
        const payload = (await fetchJson(url, timeoutMs)) as [unknown, Array<{ date?: string; value?: number | null }>];
        const rows = Array.isArray(payload?.[1]) ? payload[1] : [];
        const usable = rows
          .filter((r) => typeof r.date === "string" && typeof r.value === "number" && Number.isFinite(r.value))
          .sort((a, b) => String(b.date).localeCompare(String(a.date)))
          .slice(0, 2);
        return {
          code,
          label,
          unit,
          latestYear: usable[0]?.date ?? null,
          latestValue: usable[0] ? Number(usable[0].value) : null,
          previousYear: usable[1]?.date ?? null,
          previousValue: usable[1] ? Number(usable[1].value) : null,
          source: "World Bank (data.worldbank.org)",
        } satisfies MacroIndicator;
      }),
    );
    const filled = results.filter((r) => r.latestValue !== null);
    if (filled.length === 0) {
      const snap: MacroSnapshot = { ok: false, reason: "World Bank returned no usable observations", indicators: [], fetchedAt };
      return snap;
    }
    const snap: MacroSnapshot = { ok: true, indicators: filled, fetchedAt };
    cacheSet("wb-macro", { at: Date.now(), value: snap });
    return snap;
  } catch (err) {
    return { ok: false, reason: `World Bank macro unavailable: ${(err as Error).message}`, indicators: [], fetchedAt };
  }
}

/**
 * Frankfurter (ECB) USD/INR snapshot: latest rate + deterministic 1M/3M
 * percentage changes computed from the ECB timeseries.
 */
export async function fetchUsdInr(timeoutMs = 10_000): Promise<FxSnapshot> {
  const TTL = 6 * 60 * 60 * 1000; // ECB publishes daily — 6h cache is polite and fresh
  const cached = cacheGet<FxSnapshot>("fx-usdinr", TTL);
  if (cached) return cached;
  const fetchedAt = new Date().toISOString();
  const source = "ECB via Frankfurter (frankfurter.dev)";
  try {
    const latestPayload = (await fetchJson(`${FX_BASE}/latest?base=USD&symbols=INR`, timeoutMs)) as {
      date?: string;
      rates?: { INR?: number };
    };
    const usdInr = typeof latestPayload.rates?.INR === "number" && Number.isFinite(latestPayload.rates.INR) ? latestPayload.rates.INR : null;
    if (usdInr === null) {
      return { ok: false, reason: "Frankfurter returned no USD/INR rate", usdInr: null, asOf: latestPayload.date ?? null, change1mPct: null, change3mPct: null, source, fetchedAt };
    }
    // Timeseries for the trailing ~100 calendar days → 1M/3M changes.
    const start = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
    const ts = (await fetchJson(`${FX_BASE}/${start}..?base=USD&symbols=INR`, timeoutMs)) as {
      rates?: Record<string, { INR?: number }>;
    };
    const points = Object.entries(ts.rates ?? {})
      .filter(([, v]) => typeof v.INR === "number")
      .map(([date, v]) => ({ date, rate: Number(v.INR) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const pctOver = (days: number): number | null => {
      if (points.length < 5) return null;
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      const before = [...points].reverse().find((p) => p.date <= cutoff);
      return before && before.rate > 0 ? ((usdInr - before.rate) / before.rate) * 100 : null;
    };
    const snap: FxSnapshot = {
      ok: true,
      usdInr,
      asOf: latestPayload.date ?? null,
      change1mPct: pctOver(30),
      change3mPct: pctOver(91),
      source,
      fetchedAt,
    };
    cacheSet("fx-usdinr", { at: Date.now(), value: snap });
    return snap;
  } catch (err) {
    return { ok: false, reason: `Frankfurter FX unavailable: ${(err as Error).message}`, usdInr: null, asOf: null, change1mPct: null, change3mPct: null, source, fetchedAt };
  }
}

/**
 * Deterministic FX-sensitivity hint by sector (a mapping, NOT a computed
 * score): IT/services earn in USD; energy imports crude priced in USD;
 * consumer/financial businesses are predominantly domestic.
 */
export function sectorFxSensitivity(sector: string | null): "HIGH" | "MODERATE" | "LOW" {
  const s = (sector ?? "").toLowerCase();
  if (/(information\s*technology|technology|it\s*services)/.test(s)) return "HIGH";
  if (/(energy|oil|gas|utilities|materials)/.test(s)) return "MODERATE";
  return "LOW";
}

/** Combined convenience fetch for the research context (both fail-isolated). */
export async function fetchMacroContext(): Promise<{ macro: MacroSnapshot; fx: FxSnapshot }> {
  const timeoutMs = aiConfig.probeTimeoutMs * 8; // bounded, generous for cold TLS
  const [macro, fx] = await Promise.all([fetchWorldBankMacro(timeoutMs), fetchUsdInr(timeoutMs)]);
  return { macro, fx };
}

/** Test hook: clear the module cache between unit tests. */
export function clearMacroCacheForTests(): void {
  cache.clear();
}
