import { prisma } from "../utils/prisma.js";
import { toStockDto, toStockDtoFromPrices, type StockDto } from "../utils/mappers.js";
import { notFound } from "../utils/http.js";
import {
  getStockRiskProfile,
  listSectorNames,
  type PricePoint,
  type StockRiskProfile,
} from "./analytics.service.js";

export interface StockQuery {
  search?: string;
  sector?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

const sortToOrderBy: Record<string, { symbol?: "asc" | "desc"; company_name?: "asc" | "desc" }> = {
  symbol: { symbol: "asc" },
  name: { company_name: "asc" },
};

export async function searchStocks(query: StockQuery = {}): Promise<Paginated<StockDto>> {
  const search = query.search?.trim() ?? "";
  const sector = query.sector?.trim() && query.sector !== "all" ? query.sector.trim() : undefined;
  const sort = query.sort ?? "symbol";
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 9));

  const where = {
    is_active: true,
    ...(sector ? { sector } : {}),
    ...(search
      ? {
          OR: [
            { symbol: { contains: search, mode: "insensitive" as const } },
            { company_name: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.stocks.count({ where }),
    prisma.stocks.findMany({
      where,
      orderBy: sort in sortToOrderBy ? sortToOrderBy[sort] : { symbol: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  // Latest two closes per listed stock (join through stock_prices) to enrich
  // the catalogue rows with lastPrice / previousClose.
  const stockIds = rows.map((r) => r.stock_id);
  const priceRows = await prisma.stock_prices.findMany({
    where: { stock_id: { in: stockIds } },
    orderBy: [{ stock_id: "asc" }, { price_date: "desc" }],
  });

  const latestByStock = new Map<number, { last: number; prev: number }>();
  for (const p of priceRows) {
    const entry = latestByStock.get(p.stock_id);
    if (!entry) {
      latestByStock.set(p.stock_id, { last: Number(p.close_price), prev: Number(p.close_price) });
    } else if (entry.prev === entry.last) {
      entry.prev = Number(p.close_price);
    }
  }

  const dtos = rows.map((r) => {
    const prices = latestByStock.get(r.stock_id) ?? { last: 0, prev: 0 };
    return toStockDto(r, prices.last, prices.prev);
  });

  // Per-stock risk profile straight from the analytics engine over the full
  // price series (priceRows above already carries every weekly close).
  const seriesByStock = new Map<number, PricePoint[]>();
  for (const p of priceRows) {
    let arr = seriesByStock.get(p.stock_id);
    if (!arr) {
      arr = [];
      seriesByStock.set(p.stock_id, arr);
    }
    arr.push({ date: p.price_date.toISOString().slice(0, 10), close: Number(p.close_price) });
  }
  const EMPTY_RISK: StockRiskProfile = {
    volatilityPct: 0,
    maxDrawdownPct: 0,
    return1yPct: null,
    return3yPct: null,
    return5yPct: null,
    riskBand: "Low",
  };
  const withRisk = dtos.map((d) => {
    const series = seriesByStock.get(Number(d.id));
    return { ...d, risk: series && series.length >= 2 ? getStockRiskProfile(series) : EMPTY_RISK };
  });

  // Price/sort options are computed in memory because they derive from the
  // latest close rather than a base-table column.
  if (sort === "price-desc" || sort === "price-asc" || sort === "mcap-desc") {
    withRisk.sort((a, b) =>
      sort === "price-asc" ? a.lastPrice - b.lastPrice : sort === "price-desc" ? b.lastPrice - a.lastPrice : b.marketCapCr - a.marketCapCr,
    );
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return { rows: withRisk, total, page: Math.min(page, pageCount), pageSize, pageCount };
}

export async function listSectors(): Promise<string[]> {
  const rows = await prisma.stocks.findMany({
    where: { is_active: true },
    select: { sector: true },
    distinct: ["sector"],
    orderBy: { sector: "asc" },
  });
  return listSectorNames(rows);
}

export async function getStockBySymbol(symbol: string): Promise<StockDto> {
  const stock = await prisma.stocks.findFirst({
    where: { symbol: symbol.toUpperCase() },
  });
  if (!stock) throw notFound("We couldn't find that stock.");

  const prices = await prisma.stock_prices.findMany({
    where: { stock_id: stock.stock_id },
    orderBy: { price_date: "desc" },
    take: 2,
    select: { close_price: true, price_date: true },
  });

  return toStockDtoFromPrices(stock, prices);
}

export async function getPriceHistory(symbol: string, limit?: number): Promise<PricePoint[]> {
  const stock = await prisma.stocks.findFirst({ where: { symbol: symbol.toUpperCase() } });
  if (!stock) throw notFound("We couldn't find that stock.");

  const prices = await prisma.stock_prices.findMany({
    where: { stock_id: stock.stock_id },
    orderBy: { price_date: "asc" },
    ...(limit ? { take: limit } : {}),
    select: { price_date: true, close_price: true },
  });

  return prices.map((p) => ({ date: p.price_date.toISOString().slice(0, 10), close: Number(p.close_price) }));
}

export async function getStockDetail(symbol: string): Promise<{
  stock: StockDto;
  history: PricePoint[];
  risk: StockRiskProfile;
}> {
  const stock = await getStockBySymbol(symbol);
  const history = await getPriceHistory(symbol);
  const risk = getStockRiskProfile(history);
  return { stock, history, risk };
}

export async function getStockRisk(symbol: string): Promise<StockRiskProfile> {
  const history = await getPriceHistory(symbol);
  if (history.length === 0) throw notFound("We couldn't find that stock.");
  return getStockRiskProfile(history);
}

/** Resolves a symbol to its row; throws a friendly 404 when missing. */
export async function requireStockBySymbol(symbol: string) {
  const stock = await prisma.stocks.findFirst({ where: { symbol: symbol.toUpperCase() } });
  if (!stock) throw notFound("We couldn't find that stock.");
  return stock;
}
