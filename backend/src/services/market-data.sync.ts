/**
 * Market-data sync service.
 *
 * Pulls real OHLCV + fundamentals from the free Yahoo Finance provider and
 * upserts them into the existing stocks / stock_prices tables. Design rules:
 *
 *  - Historical data is never wiped. Real bars are UPSERTed on the existing
 *    (stock_id, price_date) unique constraint; a FULL sync additionally
 *    removes synthetic ('DEMO') rows only inside the real-data window so
 *    synthetic and real values never mix within the same series.
 *  - Latest syncs (mode=LATEST) fetch only a small window (~10 days) per
 *    stock and never delete anything — cheap enough for a 30–60 min cadence
 *    against a free API.
 *  - Fundamentals (P/E, market cap, dividend yield, sector, industry,
 *    description) are best-effort; unavailable fields stay null. Stock
 *    identity fields (name, sector) fall back to existing DB values when the
 *    provider omits them.
 *  - Every run is recorded in market_data_syncs (status, counters, errors).
 *  - A single-flight lock prevents overlapping runs (cron + manual).
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/prisma.js";
import { recordAudit } from "../utils/audit.js";
import {
  fetchFundamentals,
  fetchHistory,
  RateLimitError,
} from "./market-data.provider.js";

export type SyncMode = "LATEST" | "FULL";

export interface SyncSummary {
  syncId: number;
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  stocksProcessed: number;
  pricesUpserted: number;
  fundamentalsUpdated: number;
  failures: number;
  skippedRateLimited: number;
  startedAt: string;
  finishedAt: string;
}

const BARS_PER_STOCK_FULL = 560; // ~2 years of trading days (reserved for future windowing)
const SYMBOL_CONCURRENCY = 4; // stay gentle on the free API
const INTER_SYMBOL_DELAY_MS = 150;

let running = false;

/** True while a sync is in flight; used by the manual-refresh endpoint. */
export function isSyncRunning(): boolean {
  return running;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}

interface StockSyncResult {
  symbol: string;
  yahooSymbol: string;
  bars: number;
  fundamentals: boolean;
  failed: boolean;
  rateLimited: boolean;
  /** What actually failed, for diagnostics. Null when the stock succeeded. */
  failureStage: "HISTORY" | "FUNDAMENTALS" | null;
  failureMessage: string | null;
}

function categoriseError(error: unknown): string {
  if (error instanceof RateLimitError) return "rate-limited by provider";
  const msg = error instanceof Error ? error.message : String(error);
  if (/delisted|No data found/i.test(msg)) return "symbol not covered by provider (delisted/renamed?)";
  if (/HTTP 4\d\d/.test(msg)) return `provider rejected request (${msg})`;
  if (/HTTP 5\d\d/.test(msg)) return `provider server error (${msg})`;
  if (/abort/i.test(msg)) return "request timed out";
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|network/i.test(msg)) return "network error reaching provider";
  return msg;
}

async function syncStock(
  stock: { stock_id: number; symbol: string; yahoo_symbol: string | null; company_name: string; sector: string },
  mode: SyncMode,
): Promise<StockSyncResult> {
  const yahooSymbol = stock.yahoo_symbol ?? `${stock.symbol}.NS`;
  const out: StockSyncResult = {
    symbol: stock.symbol,
    yahooSymbol,
    bars: 0,
    fundamentals: false,
    failed: false,
    rateLimited: false,
    failureStage: null,
    failureMessage: null,
  };

  let quote: import("./market-data.provider.js").ProviderQuote | null = null;
  try {
    const range = mode === "FULL" ? "2y" : "10d";
    const history = await fetchHistory(yahooSymbol, { range, interval: "1d" });
    quote = history.quote;
    if (history.bars.length > 0) {
      const windowStart = history.bars[0]!.date;
      const windowEnd = history.bars[history.bars.length - 1]!.date;

      if (mode === "FULL") {
        // Replace synthetic rows strictly inside the real-data window so the
        // two sources never interleave. Rows outside remain untouched.
        const deleted = await prisma.stock_prices.deleteMany({
          where: {
            stock_id: stock.stock_id,
            data_source: "DEMO",
            price_date: { gte: new Date(`${windowStart}T00:00:00Z`), lte: new Date(`${windowEnd}T00:00:00Z`) },
          },
        });
        void deleted;
      }

      const upserts = history.bars.map((b) =>
        prisma.stock_prices.upsert({
          where: {
            stock_id_price_date: { stock_id: stock.stock_id, price_date: new Date(`${b.date}T00:00:00Z`) },
          },
          create: {
            stock_id: stock.stock_id,
            price_date: new Date(`${b.date}T00:00:00Z`),
            open_price: b.open,
            high_price: b.high,
            low_price: b.low,
            close_price: b.close,
            volume: b.volume,
            data_source: "YAHOO",
          },
          update: {
            open_price: b.open,
            high_price: b.high,
            low_price: b.low,
            close_price: b.close,
            volume: b.volume,
            data_source: "YAHOO",
          },
        }),
      );
      await prisma.$transaction(upserts);
      out.bars = history.bars.length;
    }

    // Latest quote → keep the freshest close as an upsert for today too.
    if (quote && quote.price !== null && quote.price > 0) {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const lastBar = history.bars[history.bars.length - 1];
      const quoteDate = lastBar
        ? new Date(`${lastBar.date}T00:00:00Z`)
        : today;
      await prisma.stock_prices.upsert({
        where: { stock_id_price_date: { stock_id: stock.stock_id, price_date: quoteDate } },
        create: {
          stock_id: stock.stock_id,
          price_date: quoteDate,
          open_price: lastBar?.open ?? quote.price,
          high_price: lastBar?.high ?? quote.price,
          low_price: lastBar?.low ?? quote.price,
          close_price: quote.price,
          volume: lastBar?.volume ?? null,
          data_source: "YAHOO",
        },
        update: {
          close_price: quote.price,
          high_price: lastBar ? Math.max(lastBar.high, quote.price) : quote.price,
          low_price: lastBar ? Math.min(lastBar.low, quote.price) : quote.price,
          data_source: "YAHOO",
        },
      });
      out.bars += 1;
    }
  } catch (error) {
    out.failed = true;
    out.failureStage = "HISTORY";
    out.failureMessage = categoriseError(error);
    if (error instanceof RateLimitError) out.rateLimited = true;
    return out; // nothing else can succeed without price history
  }

  // Master-data updates: name from the quote meta; fundamentals best-effort.
  try {
    const update: Record<string, unknown> = {
      data_source: "YAHOO",
      yahoo_symbol: yahooSymbol,
    };
    if (quote?.name) update["company_name"] = quote.name;
    const fundamentals = await fetchFundamentals(yahooSymbol);
    if (fundamentals) {
      if (fundamentals.sector) update["sector"] = fundamentals.sector;
      if (fundamentals.industry) update["industry"] = fundamentals.industry;
      if (fundamentals.description) update["description"] = fundamentals.description;
      if (fundamentals.marketCapCr !== null) update["market_cap"] = fundamentals.marketCapCr;
      if (fundamentals.peRatio !== null) update["pe_ratio"] = fundamentals.peRatio;
      if (fundamentals.dividendYieldPct !== null) update["dividend_yield"] = fundamentals.dividendYieldPct / 100;
      update["fundamentals_updated_at"] = new Date();
      out.fundamentals = true;
    }
    await prisma.stocks.update({ where: { stock_id: stock.stock_id }, data: update });
  } catch (error) {
    // Prices may have been stored fine — record a soft failure for this stage.
    out.failureStage = "FUNDAMENTALS";
    out.failureMessage = categoriseError(error);
    if (error instanceof RateLimitError) out.rateLimited = true;
  }
  return out;
}

/**
 * Runs a market-data sync. Returns a summary; throws only on unexpected
 * internal errors (per-stock failures are contained, counted and logged).
 */
export async function runSync(trigger: "SCHEDULED" | "MANUAL" | "STARTUP", mode: SyncMode): Promise<SyncSummary> {
  if (running) throw new Error("A market-data sync is already running.");
  running = true;

  const sync = await prisma.market_data_syncs.create({
    data: { trigger_type: trigger, mode, status: "RUNNING" },
  });

  const startedAt = new Date();
  let stocksProcessed = 0;
  let pricesUpserted = 0;
  let fundamentalsUpdated = 0;
  let failures = 0;
  let skippedRateLimited = 0;
  const failureDetails: string[] = [];

  try {
    const stocks = await prisma.stocks.findMany({
      where: { is_active: true },
      select: { stock_id: true, symbol: true, yahoo_symbol: true, company_name: true, sector: true },
      orderBy: { stock_id: "asc" },
    });

    const results = await mapWithConcurrency(stocks, SYMBOL_CONCURRENCY, async (stock, i) => {
      // Small stagger to avoid bursting the free API.
      await new Promise((r) => setTimeout(r, i * INTER_SYMBOL_DELAY_MS));
      const r = await syncStock(stock, mode);
      stocksProcessed += 1;
      pricesUpserted += r.bars;
      if (r.fundamentals) fundamentalsUpdated += 1;
      if (r.rateLimited) skippedRateLimited += 1;
      if (r.failed || r.failureStage) {
        failures += 1;
        // Diagnostic log: internal symbol, provider symbol, stage, category.
        const line = `${r.symbol} (${r.yahooSymbol}) [${r.failureStage ?? "HISTORY"}]: ${r.failureMessage ?? "unknown error"}`;
        failureDetails.push(line);
        console.warn(`[market-data] FAIL ${line}`);
      }
      return r;
    });
    void results;

    const status: SyncSummary["status"] =
      failures === 0 ? "SUCCESS" : failures < stocksProcessed ? "PARTIAL" : "FAILED";

    await prisma.market_data_syncs.update({
      where: { sync_id: sync.sync_id },
      data: {
        status,
        finished_at: new Date(),
        stocks_processed: stocksProcessed,
        prices_upserted: pricesUpserted,
        fundamentals_updated: fundamentalsUpdated,
        failures,
        error_message:
          failureDetails.length > 0
            ? `${failureDetails.slice(0, 5).join(" | ")}${failureDetails.length > 5 ? ` | +${failureDetails.length - 5} more` : ""}`
            : null,
      },
    });

    return {
      syncId: sync.sync_id,
      status,
      stocksProcessed,
      pricesUpserted,
      fundamentalsUpdated,
      failures,
      skippedRateLimited,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  } catch (error) {
    const fatalMessage = error instanceof Error ? error.message : String(error);
    await prisma.market_data_syncs.update({
      where: { sync_id: sync.sync_id },
      data: { status: "FAILED", finished_at: new Date(), error_message: fatalMessage.slice(0, 500) },
    });
    throw error;
  } finally {
    running = false;
    // Audit trail for manual runs; scheduled runs are audited via the table.
    if (trigger === "MANUAL") {
      await recordAudit({
        action: "ADMIN_STOCK_UPDATE",
        entityType: "MARKET_DATA",
        entityId: sync.sync_id,
        details: `Manual market-data sync (${mode}): ${stocksProcessed} stocks, ${pricesUpserted} prices, ${failures} failures.`,
      });
    }
    void BARS_PER_STOCK_FULL;
  }
}

/** Latest completed sync row for freshness reporting. */
export async function lastSync() {
  return prisma.market_data_syncs.findFirst({
    where: { status: { not: "RUNNING" } },
    orderBy: { finished_at: "desc" },
  });
}

export interface MarketDataFreshness {
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  running: boolean;
  dataSourceMix: { yahoo: number; demo: number };
}

/**
 * Platform-wide market-data freshness: the last completed sync plus whether a
 * sync is in flight right now. Consumed by /api/analysis/overview (dashboard
 * badge), /api/stocks meta, and /api/stocks/freshness (header badge).
 */
export async function marketDataFreshness(): Promise<MarketDataFreshness> {
  // A RUNNING row older than this is an orphan from a killed process, not an
  // active sync (a real sync finishes in ~1 minute). Read-side guard: no rows
  // are modified.
  const runningCutoff = new Date(Date.now() - 15 * 60 * 1000);
  const [sync, running, mixResult] = await Promise.all([
    lastSync(),
    prisma.market_data_syncs.findFirst({
      where: { status: "RUNNING", started_at: { gte: runningCutoff } },
      orderBy: { started_at: "desc" },
      select: { sync_id: true },
    }),
    prisma.$queryRaw<Array<{ data_source: string; n: bigint }>>(
      Prisma.sql`SELECT data_source, COUNT(*)::bigint AS n FROM stocks WHERE is_active = true GROUP BY data_source`,
    ),
  ]);
  const mix = { yahoo: 0, demo: 0 };
  for (const row of mixResult) {
    if (row.data_source === "YAHOO") mix.yahoo = Number(row.n);
    else mix.demo += Number(row.n);
  }
  return {
    lastSyncAt: sync?.finished_at?.toISOString() ?? null,
    lastSyncStatus: sync?.status ?? null,
    running: running !== null,
    dataSourceMix: mix,
  };
}

/**
 * Starts the periodic background refresh. Returns a stop function. The first
 * run happens after a short delay so server startup never blocks on the
 * network; failures are logged and retried on the next tick.
 */
export function startScheduler(): () => void {
  const intervalMs = 45 * 60 * 1000; // 45 minutes — intentional cadence, do not change
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async (trigger: "SCHEDULED" | "STARTUP") => {
    try {
      const summary = await runSync(trigger, "LATEST");
      console.log(
        `[market-data] ${trigger} sync ${summary.status}: ${summary.pricesUpserted} prices, ${summary.fundamentalsUpdated} fundamentals, ${summary.failures} failures`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("already running")) return;
      console.error("[market-data] sync failed:", error instanceof Error ? error.message : error);
    }
  };

  // Startup run after 8s (let the server bind first), then the fixed cadence.
  setTimeout(() => void tick("STARTUP"), 8000);
  timer = setInterval(() => void tick("SCHEDULED"), intervalMs);

  return () => {
    if (timer) clearInterval(timer);
  };
}
