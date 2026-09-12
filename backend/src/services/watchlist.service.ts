import { prisma } from "../utils/prisma.js";
import { toWatchlistDto, type WatchlistItemDto } from "../utils/mappers.js";
import { conflict, notFound } from "../utils/http.js";
import { recordAudit } from "../utils/audit.js";
import { getStockRiskProfile } from "./analytics.service.js";
import { requireStockBySymbol } from "./stock.service.js";

function stockIdLabel(stockId: number): string {
  return `stock #${stockId}`;
}

/**
 * Watchlist rows enriched with stock metadata and the analytics-engine risk
 * profile computed from stock_prices, so the watchlist page never depends on
 * client-side demo data in API mode.
 */
export async function listWatchlist(userId: number) {
  const rows = await prisma.watchlists.findMany({
    where: { user_id: userId },
    include: { stocks: true },
    orderBy: { added_at: "desc" },
  });

  const stockIds = rows.map((w) => w.stock_id);
  const prices = stockIds.length
    ? await prisma.stock_prices.findMany({
        where: { stock_id: { in: stockIds } },
        orderBy: [{ stock_id: "asc" }, { price_date: "asc" }],
        select: { stock_id: true, price_date: true, close_price: true },
      })
    : [];

  const seriesByStock = new Map<number, Array<{ date: string; close: number }>>();
  for (const p of prices) {
    let arr = seriesByStock.get(p.stock_id);
    if (!arr) {
      arr = [];
      seriesByStock.set(p.stock_id, arr);
    }
    arr.push({ date: p.price_date.toISOString().slice(0, 10), close: Number(p.close_price) });
  }

  return rows.map((w) => {
    const s = w.stocks;
    const series = seriesByStock.get(w.stock_id) ?? [];
    const last = series[series.length - 1]?.close ?? 0;
    const prev = series[series.length - 2]?.close ?? last;
    return {
      ...toWatchlistDto(w, s.symbol),
      stock: {
        id: String(s.stock_id),
        symbol: s.symbol,
        name: s.company_name,
        sector: s.sector,
        exchange: s.exchange,
        currency: "INR" as const,
        lastPrice: last,
        previousClose: prev,
        marketCapCr: s.market_cap === null ? 0 : Number(s.market_cap),
        risk:
          series.length >= 2
            ? getStockRiskProfile(series)
            : {
                volatilityPct: 0,
                maxDrawdownPct: 0,
                return1yPct: null,
                return3yPct: null,
                return5yPct: null,
                riskBand: "Low" as const,
              },
      },
    };
  });
}

export async function addToWatchlist(userId: number, symbol: string): Promise<WatchlistItemDto> {
  const stock = await requireStockBySymbol(symbol);

  const existing = await prisma.watchlists.findFirst({
    where: { user_id: userId, stock_id: stock.stock_id },
  });
  if (existing) {
    throw conflict("That stock is already on your watchlist.");
  }

  const row = await prisma.watchlists.create({
    data: { user_id: userId, stock_id: stock.stock_id },
    include: { stocks: { select: { symbol: true } } },
  });

  await recordAudit({
    userId,
    action: "WATCHLIST_ADD",
    entityType: "WATCHLIST",
    entityId: row.watchlist_id,
    details: `Added ${stock.symbol} to watchlist.`,
  });

  return toWatchlistDto(row, stock.symbol);
}

/** Removes one watchlist row by its own id, scoped to the owner. */
export async function removeByWatchlistId(userId: number, watchlistId: number): Promise<void> {
  const match = await prisma.watchlists.findFirst({ where: { watchlist_id: watchlistId, user_id: userId } });
  if (!match) throw notFound("That stock is not on your watchlist.");

  await prisma.watchlists.delete({ where: { watchlist_id: match.watchlist_id } });

  await recordAudit({
    userId,
    action: "WATCHLIST_REMOVE",
    entityType: "WATCHLIST",
    entityId: match.watchlist_id,
    details: `Removed ${stockIdLabel(match.stock_id)} from watchlist.`,
  });
}
