/**
 * Benchmark intelligence (Intelligence Engine, Phase 7).
 *
 * NIFTY 50 (^NSEI) daily history through the EXISTING Yahoo provider — no
 * second market-data system, no paid services. Benchmark failures are fully
 * isolated: they never break the stock sync and never fabricate prices.
 *
 * Everything here is additive:
 *   - ensureBenchmarks(): seed the single NIFTY row (idempotent)
 *   - syncBenchmark():    fetch/upsert recent bars (UNIQUE(benchmark,date))
 *   - benchmarkCloses():  read-side close series for beta/alpha
 *   - benchmarkStatus():  provenance for admin diagnostics
 */

import { prisma } from "../utils/prisma.js";
import { fetchHistory } from "./market-data.provider.js";

/** The one benchmark this phase supports. */
export const NIFTY_SYMBOL = "^NSEI";

interface EnsureResult {
  benchmarkId: number;
  created: boolean;
}

/** Idempotently ensure the NIFTY benchmark row exists. */
export async function ensureBenchmarks(): Promise<EnsureResult> {
  const existing = await prisma.benchmarks.findFirst({
    where: { symbol: NIFTY_SYMBOL, exchange: "NSE" },
    select: { benchmark_id: true },
  });
  if (existing) return { benchmarkId: existing.benchmark_id, created: false };
  const created = await prisma.benchmarks.create({
    data: { symbol: NIFTY_SYMBOL, name: "NIFTY 50", exchange: "NSE", data_source: "YAHOO" },
    select: { benchmark_id: true },
  });
  return { benchmarkId: created.benchmark_id, created: true };
}

export interface BenchmarkSyncSummary {
  benchmark: string;
  status: "SUCCESS" | "FAILED";
  barsUpserted: number;
  latestBarDate: string | null;
  reason: string | null;
}

/**
 * Pull recent ^NSEI bars through the existing Yahoo `fetchHistory` provider and
 * upsert them. Never throws on provider failure — the stock sync must not be
 * affected by a benchmark outage. Duplicate dates are handled by the
 * benchmark_prices UNIQUE(benchmark_id, price_date) constraint (upsert).
 */
export async function syncBenchmark(range = "2y"): Promise<BenchmarkSyncSummary> {
  const { benchmarkId } = await ensureBenchmarks();
  try {
    const { bars } = await fetchHistory(NIFTY_SYMBOL, { range, timeoutMs: 15_000 });
    if (bars.length === 0) {
      return { benchmark: NIFTY_SYMBOL, status: "FAILED", barsUpserted: 0, latestBarDate: null, reason: "Provider returned no usable bars" };
    }
    let upserted = 0;
    for (const b of bars) {
      await prisma.benchmark_prices.upsert({
        where: { benchmark_id_price_date: { benchmark_id: benchmarkId, price_date: new Date(b.date) } },
        create: {
          benchmark_id: benchmarkId,
          price_date: new Date(b.date),
          open_price: b.open,
          high_price: b.high,
          low_price: b.low,
          close_price: b.close,
          volume: b.volume === null ? null : BigInt(Math.round(b.volume)),
          data_source: "YAHOO",
        },
        update: {
          open_price: b.open,
          high_price: b.high,
          low_price: b.low,
          close_price: b.close,
          volume: b.volume === null ? null : BigInt(Math.round(b.volume)),
        },
      });
      upserted += 1;
    }
    const latest = bars[bars.length - 1]!;
    return { benchmark: NIFTY_SYMBOL, status: "SUCCESS", barsUpserted: upserted, latestBarDate: latest.date, reason: null };
  } catch (error) {
    // Isolation contract: log + report, never propagate.
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[benchmark] sync failed: ${reason}`);
    return { benchmark: NIFTY_SYMBOL, status: "FAILED", barsUpserted: 0, latestBarDate: null, reason };
  }
}

/** Read-side: ascending close series (YYYY-MM-DD → close) for one benchmark. */
export async function benchmarkCloses(
  benchmarkId: number,
  maxCalendarDays = 730,
): Promise<Array<{ date: string; close: number }>> {
  const rows = await prisma.benchmark_prices.findMany({
    where: {
      benchmark_id: benchmarkId,
      price_date: { gte: new Date(Date.now() - maxCalendarDays * 86_400_000) },
    },
    orderBy: { price_date: "asc" },
    select: { price_date: true, close_price: true },
  });
  return rows.map((r) => ({ date: r.price_date.toISOString().slice(0, 10), close: Number(r.close_price) }));
}

export async function activeBenchmark(): Promise<{ benchmarkId: number; symbol: string; name: string } | null> {
  const row = await prisma.benchmarks.findFirst({
    where: { is_active: true, symbol: NIFTY_SYMBOL },
    select: { benchmark_id: true, symbol: true, name: true },
  });
  return row ? { benchmarkId: row.benchmark_id, symbol: row.symbol, name: row.name } : null;
}

/** Admin diagnostics: availability + provenance of stored benchmark data. */
export async function benchmarkStatus(): Promise<{
  configured: boolean;
  benchmark: string | null;
  priceCount: number;
  oldestDate: string | null;
  latestDate: string | null;
  lastSync: { status: string | null; bars: number | null; reason: string | null };
}> {
  const bench = await activeBenchmark();
  if (!bench) return { configured: false, benchmark: null, priceCount: 0, oldestDate: null, latestDate: null, lastSync: { status: null, bars: null, reason: null } };
  const [count, oldest, latest] = await Promise.all([
    prisma.benchmark_prices.count({ where: { benchmark_id: bench.benchmarkId } }),
    prisma.benchmark_prices.findFirst({ where: { benchmark_id: bench.benchmarkId }, orderBy: { price_date: "asc" }, select: { price_date: true } }),
    prisma.benchmark_prices.findFirst({ where: { benchmark_id: bench.benchmarkId }, orderBy: { price_date: "desc" }, select: { price_date: true } }),
  ]);
  return {
    configured: true,
    benchmark: bench.symbol,
    priceCount: count,
    oldestDate: oldest?.price_date.toISOString().slice(0, 10) ?? null,
    latestDate: latest?.price_date.toISOString().slice(0, 10) ?? null,
    lastSync: { status: null, bars: null, reason: null },
  };
}
