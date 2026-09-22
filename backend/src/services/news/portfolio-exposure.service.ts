/**
 * Portfolio exposure service (Intelligence Engine, Phase 2).
 *
 * Answers "how much of THIS user's money touches THIS stock / sector?" using
 * the EXISTING holdings, portfolios, watchlists and stock_prices tables.
 *
 * Methodology (exposure ≠ risk contribution):
 *   portfolio_weight(stock) = Σ(quantity × latest_close for that stock)
 *                           / Σ(quantity × latest_close over all holdings)
 *   sector_weight(sector)   = value of holdings in that sector / total value
 *   user_aggregate_weight   = value of the stock across ALL of the user's
 *                             portfolios / total value across ALL portfolios
 *
 * This is ALLOCATION only. It never claims risk contribution or predicted
 * price movement — that belongs to later phases.
 *
 * Prices: the latest close per stock comes from the existing stock_prices
 * table via the same LATERAL pattern the stock catalogue uses (no new
 * market-data provider, no duplicated Yahoo logic). `price_as_of` records the
 * price date used so the UI can show freshness honestly.
 */
import { Prisma } from "@prisma/client";
import type { Decimal as DecimalJsLike } from "@prisma/client/runtime/library.js";
import { prisma } from "../../utils/prisma.js";

export interface HoldingExposure {
  portfolioId: number;
  stockId: number;
  symbol: string;
  sector: string;
  quantity: number;
  latestPrice: number | null;
  priceAsOf: string | null;
  marketValue: number;
  portfolioWeight: number | null; // 0..1; null when portfolio value unknown
}

export interface PortfolioExposure {
  portfolioId: number;
  portfolioName: string;
  totalValue: number;
  stalePrices: boolean;
  priceAsOf: string | null;
  byStock: Map<number, HoldingExposure>;
  bySector: Map<string, { weight: number; value: number }>;
}

/** Latest close + price_date per stock (single indexed row per stock). */
export async function latestClosesFor(stockIds: number[]): Promise<Map<number, { close: number; date: string }>> {
  const out = new Map<number, { close: number; date: string }>();
  if (stockIds.length === 0) return out;
  const rows = await prisma.$queryRaw<Array<{ stock_id: number; close_price: DecimalJsLike; price_date: Date }>>(
    Prisma.sql`
      SELECT DISTINCT ON (sp.stock_id)
             sp.stock_id, sp.close_price, sp.price_date
      FROM stock_prices sp
      WHERE sp.stock_id IN (${Prisma.join(stockIds)})
      ORDER BY sp.stock_id, sp.price_date DESC
    `,
  );
  for (const r of rows) {
    out.set(r.stock_id, { close: Number(r.close_price), date: r.price_date.toISOString().slice(0, 10) });
  }
  return out;
}

/**
 * Full exposure snapshot for one user across all their portfolios plus their
 * watchlist. Watchlist entries carry quantity 0 and market value 0 — they are
 * "watching, not owning".
 */
export async function getUserPortfolioExposure(userId: number): Promise<{
  portfolios: PortfolioExposure[];
  watchlistStockIds: Set<number>;
  userAggregateByStock: Map<number, { value: number; weight: number | null }>;
  priceAsOf: string | null;
  stalePrices: boolean;
}> {
  const [portfolios, watchlist] = await Promise.all([
    prisma.portfolios.findMany({
      where: { user_id: userId },
      select: { portfolio_id: true, name: true },
      orderBy: { portfolio_id: "asc" },
    }),
    prisma.watchlists.findMany({ where: { user_id: userId }, select: { stock_id: true } }),
  ]);

  const portfolioIds = portfolios.map((p) => p.portfolio_id);
  const holdings = portfolioIds.length
    ? await prisma.holdings.findMany({
        where: { portfolio_id: { in: portfolioIds } },
        select: {
          portfolio_id: true,
          stock_id: true,
          quantity: true,
          stocks: { select: { symbol: true, sector: true } },
        },
      })
    : [];

  const stockIds = Array.from(new Set([...holdings.map((h) => h.stock_id), ...watchlist.map((w) => w.stock_id)]));
  const closes = await latestClosesFor(stockIds);

  const priceDates = Array.from(closes.values()).map((c) => c.date).sort();
  const priceAsOf: string | null = priceDates.length > 0 ? priceDates[priceDates.length - 1]! : null;
  const today = new Date().toISOString().slice(0, 10);
  const stalePrices = priceAsOf !== null && priceAsOf < today;

  const portfoliosOut: PortfolioExposure[] = [];
  const aggregateValueByStock = new Map<number, number>();
  let grandTotal = 0;

  for (const p of portfolios) {
    const ph = holdings.filter((h) => h.portfolio_id === p.portfolio_id);
    const byStock = new Map<number, HoldingExposure>();
    const bySector = new Map<string, { weight: number; value: number }>();
    let total = 0;
    const raws: Array<{ h: (typeof ph)[number]; value: number }> = [];

    for (const h of ph) {
      const close = closes.get(h.stock_id)?.close ?? null;
      const value = close === null ? 0 : Number(h.quantity) * close;
      raws.push({ h, value });
      total += value;
      if (close !== null) {
        aggregateValueByStock.set(h.stock_id, (aggregateValueByStock.get(h.stock_id) ?? 0) + value);
      }
    }
    grandTotal += total;

    for (const { h, value } of raws) {
      const close = closes.get(h.stock_id);
      const entry: HoldingExposure = {
        portfolioId: p.portfolio_id,
        stockId: h.stock_id,
        symbol: h.stocks.symbol,
        sector: h.stocks.sector,
        quantity: Number(h.quantity),
        latestPrice: close?.close ?? null,
        priceAsOf: close?.date ?? null,
        marketValue: value,
        portfolioWeight: total > 0 ? value / total : null,
      };
      byStock.set(h.stock_id, entry);
      const sec = bySector.get(h.stocks.sector) ?? { weight: 0, value: 0 };
      sec.value += value;
      sec.weight = total > 0 ? sec.value / total : 0;
      bySector.set(h.stocks.sector, sec);
    }

    portfoliosOut.push({
      portfolioId: p.portfolio_id,
      portfolioName: p.name,
      totalValue: total,
      stalePrices,
      priceAsOf,
      byStock,
      bySector,
    });
  }

  const userAggregateByStock = new Map<number, { value: number; weight: number | null }>();
  for (const [stockId, value] of aggregateValueByStock) {
    userAggregateByStock.set(stockId, {
      value,
      weight: grandTotal > 0 ? value / grandTotal : null,
    });
  }

  return {
    portfolios: portfoliosOut,
    watchlistStockIds: new Set(watchlist.map((w) => w.stock_id)),
    userAggregateByStock,
    priceAsOf,
    stalePrices,
  };
}
