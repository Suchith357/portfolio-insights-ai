import { Prisma } from "@prisma/client";
import { prisma } from "../utils/prisma.js";
import { toStockDto, toStockDtoFromPrices, type StockDto } from "../utils/mappers.js";
import { notFound } from "../utils/http.js";
import {
  getStockRiskProfile,
  listSectorNames,
  type PricePoint,
  type StockRiskProfile,
} from "./analytics.service.js";
import { lastSync } from "./market-data.sync.js";

export interface StockQuery {
  search?: string;
  sector?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
  includeInactive?: boolean;
}

export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/** Sort options validated by the route's Zod schema. */
const SORTS = new Set(["symbol", "name", "price-desc", "price-asc", "mcap-desc"]);

export interface StockListMeta {
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  freshness: {
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
    dataSourceMix: { yahoo: number; demo: number };
  };
}

/**
 * Catalogue search — CORRECT global ordering before pagination.
 *
 * The previous implementation took a DB page first and sorted that page in
 * memory by latest price, which broke price/market-cap ordering across page
 * boundaries. Now a single window-function query ranks ALL active stocks by
 * their latest close (read via the (stock_id, price_date) unique index), and
 * pagination happens on that global order. Risk profiles are computed only
 * for the page's rows.
 */
export async function searchStocks(query: StockQuery = {}): Promise<{ result: Paginated<StockDto>; meta: StockListMeta }> {
  const search = query.search?.trim() ?? "";
  const sector = query.sector?.trim() && query.sector !== "all" ? query.sector.trim() : undefined;
  const sort = query.sort && SORTS.has(query.sort) ? query.sort : "symbol";
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 9));
  const offset = (page - 1) * pageSize;

  const searchClause = search
    ? `AND (s.symbol ILIKE ${`'%${search}%'`} OR s.company_name ILIKE ${`'%${search}%'`})`
    : "";
  const sectorClause = sector ? `AND s.sector = ${`'${sector.replace(/'/g, "''")}'`}` : "";
  const activeClause = query.includeInactive ? "" : "AND s.is_active = true";

  // SQL uses Prisma's parameter binding: values are inlined via template
  // fragments below, so build the whole statement with $queryRaw template.
  const orderBy =
  sort === "price-desc"
    ? `ORDER BY latest_close DESC NULLS LAST, symbol ASC`
    : sort === "price-asc"
      ? `ORDER BY latest_close ASC NULLS LAST, symbol ASC`
      : sort === "mcap-desc"
        ? `ORDER BY market_cap DESC NULLS LAST, symbol ASC`
        : sort === "name"
          ? `ORDER BY company_name ASC`
          : `ORDER BY symbol ASC`;

  const rowsResult = await prisma.$queryRaw<Array<{
    stock_id: number;
    symbol: string;
    company_name: string;
    sector: string;
    industry: string | null;
    exchange: string;
    description: string | null;
    market_cap: unknown;
    pe_ratio: unknown;
    dividend_yield: unknown;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
    yahoo_symbol: string | null;
    data_source: string;
    fundamentals_updated_at: Date | null;
    latest_close: number | null;
    prev_close: number | null;
    latest_date: Date | null;
  }>>(
    Prisma.sql`
      WITH ranked AS (
        SELECT
          s.*,
          lp.close_price AS latest_close,
          lp.prev_close  AS prev_close,
          lp.price_date  AS latest_date
        FROM stocks s
        LEFT JOIN LATERAL (
          -- Exactly ONE row per stock: the true latest close by price_date,
          -- plus the previous trading day's close via a correlated subquery.
          -- (LAG inside a LIMIT-2 lateral produced TWO rows per stock and a
          -- null prev on the newest row, which broke pagination and prices.)
          SELECT sp.close_price,
                 sp.price_date,
                 (
                   SELECT sp2.close_price
                   FROM stock_prices sp2
                   WHERE sp2.stock_id = sp.stock_id AND sp2.price_date < sp.price_date
                   ORDER BY sp2.price_date DESC
                   LIMIT 1
                 ) AS prev_close
          FROM stock_prices sp
          WHERE sp.stock_id = s.stock_id
          ORDER BY sp.price_date DESC
          LIMIT 1
        ) lp ON true
        WHERE 1=1 ${Prisma.raw(searchClause)} ${Prisma.raw(sectorClause)} ${Prisma.raw(activeClause)}
      )
      SELECT * FROM ranked
      ${Prisma.raw(orderBy)}
      LIMIT ${pageSize} OFFSET ${offset}
    `,
  );

  const countResult = await prisma.$queryRaw<Array<{ n: bigint }>>(
    Prisma.sql`
      SELECT COUNT(*)::bigint AS n FROM stocks s WHERE 1=1
      ${Prisma.raw(searchClause)} ${Prisma.raw(sectorClause)} ${Prisma.raw(activeClause)}
    `,
  );
  const total = Number(countResult[0]?.n ?? 0);

  const stockRows = rowsResult.map((r) => ({
    stock_id: r.stock_id,
    symbol: r.symbol,
    company_name: r.company_name,
    sector: r.sector,
    industry: r.industry,
    exchange: r.exchange,
    description: r.description,
    market_cap: r.market_cap,
    pe_ratio: r.pe_ratio,
    dividend_yield: r.dividend_yield,
    is_active: r.is_active,
    created_at: r.created_at,
    updated_at: r.updated_at,
    yahoo_symbol: r.yahoo_symbol,
    data_source: r.data_source,
    fundamentals_updated_at: r.fundamentals_updated_at,
    // Price fields MUST ride along — the DTO builder reads them from this
    // object. Dropping them here is what turned every latest price into 0.
    latest_close: r.latest_close,
    prev_close: r.prev_close,
    latest_date: r.latest_date,
  }));

  // Risk profiles for just this page (full series needed for accurate stats).
  const pageIds = stockRows.map((r) => r.stock_id);
  const priceRows = pageIds.length
    ? await prisma.stock_prices.findMany({
        where: { stock_id: { in: pageIds } },
        orderBy: [{ stock_id: "asc" }, { price_date: "asc" }],
        select: { stock_id: true, price_date: true, close_price: true, data_source: true },
      })
    : [];
  const seriesByStock = new Map<number, PricePoint[]>();
  const sourceByStock = new Map<number, Map<string, string>>();
  for (const p of priceRows) {
    const arr = seriesByStock.get(p.stock_id) ?? [];
    arr.push({ date: p.price_date.toISOString().slice(0, 10), close: Number(p.close_price) });
    seriesByStock.set(p.stock_id, arr);
    const srcMap = sourceByStock.get(p.stock_id) ?? new Map<string, string>();
    srcMap.set(p.price_date.toISOString().slice(0, 10), p.data_source);
    sourceByStock.set(p.stock_id, srcMap);
  }

  const withRisk: Array<StockDto & { risk: StockRiskProfile }> = stockRows.map((r) => {
    const series = seriesByStock.get(r.stock_id) ?? [];
    const risk = series.length >= 2 ? getStockRiskProfile(series, sourceByStock.get(r.stock_id)) : {
      volatilityPct: null,
      maxDrawdownPct: null,
      return1yPct: null,
      return3yPct: null,
      return5yPct: null,
      riskBand: "Insufficient Data" as const,
      observations: series.length,
    };
    const latestClose = (r as Record<string, unknown>)["latest_close"];
    const prevClose = (r as Record<string, unknown>)["prev_close"];
    const latestDate = (r as Record<string, unknown>)["latest_date"];
    // No 0 fallback for a genuinely missing price: null → the UI shows N/A.
    const lastCloseValue = latestClose === null || latestClose === undefined ? null : latestClose;
    const prevCloseValue = prevClose === null || prevClose === undefined ? null : prevClose;
    return {
      ...toStockDto(
        r,
        lastCloseValue,
        prevCloseValue ?? lastCloseValue,
        latestDate instanceof Date ? latestDate.toISOString().slice(0, 10) : null,
      ),
      risk,
    };
  });

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Freshness: last sync row + provenance mix across the visible universe.
  const sync = await lastSync();
  const mixResult = await prisma.$queryRaw<Array<{ data_source: string; n: bigint }>>(
    Prisma.sql`SELECT data_source, COUNT(*)::bigint AS n FROM stocks WHERE is_active = true GROUP BY data_source`,
  );
  const mix = { yahoo: 0, demo: 0 };
  for (const row of mixResult) {
    if (row.data_source === "YAHOO") mix.yahoo = Number(row.n);
    else mix.demo += Number(row.n);
  }

  return {
    result: { rows: withRisk, total, page: Math.min(page, pageCount), pageSize, pageCount },
    meta: {
      total,
      page: Math.min(page, pageCount),
      pageSize,
      pageCount,
      freshness: {
        lastSyncAt: sync?.finished_at?.toISOString() ?? null,
        lastSyncStatus: sync?.status ?? null,
        dataSourceMix: mix,
      },
    },
  };
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

/** Public catalogue exposes active stocks only — consistent everywhere. */
export async function requireActiveStockBySymbol(symbol: string) {
  const stock = await prisma.stocks.findFirst({
    where: { symbol: symbol.toUpperCase(), is_active: true },
  });
  if (!stock) throw notFound("We couldn't find that stock.");
  return stock;
}

export async function getStockBySymbol(symbol: string): Promise<StockDto> {
  const stock = await requireActiveStockBySymbol(symbol);

  const prices = await prisma.stock_prices.findMany({
    where: { stock_id: stock.stock_id },
    orderBy: { price_date: "desc" },
    take: 2,
    select: { close_price: true, price_date: true },
  });

  return toStockDtoFromPrices(stock, prices);
}

/**
 * Latest N closes in CHRONOLOGICAL order. Fetch the newest N descending
 * (index-backed), then reverse — the old "ORDER BY asc + take" version could
 * return the OLDEST records when a limit was supplied.
 */
export async function getPriceHistory(symbol: string, limit?: number): Promise<PricePoint[]> {
  const stock = await requireActiveStockBySymbol(symbol);

  const capped = limit ? Math.min(Math.max(1, Math.floor(limit)), 2600) : undefined;
  const prices = await prisma.stock_prices.findMany({
    where: { stock_id: stock.stock_id },
    orderBy: { price_date: "desc" },
    ...(capped ? { take: capped } : {}),
    select: { price_date: true, close_price: true, data_source: true },
  });

  const points = prices
    .slice()
    .reverse()
    .map((p) => ({ date: p.price_date.toISOString().slice(0, 10), close: Number(p.close_price) }));
  return points;
}

/** Provenance map (date → source) for one stock's price rows. */
async function getProvenanceMap(stockId: number): Promise<Map<string, string>> {
  const rows = await prisma.stock_prices.findMany({
    where: { stock_id: stockId },
    orderBy: { price_date: "asc" },
    select: { price_date: true, data_source: true },
  });
  return new Map(rows.map((r) => [r.price_date.toISOString().slice(0, 10), r.data_source]));
}

export async function getStockDetail(symbol: string): Promise<{
  stock: StockDto;
  history: PricePoint[];
  risk: StockRiskProfile;
  freshness: { lastPriceDate: string | null; dataSource: string };
}> {
  const stock = await requireActiveStockBySymbol(symbol);
  const history = await getPriceHistory(symbol);
  const risk = getStockRiskProfile(history, await getProvenanceMap(stock.stock_id));
  const lastPriceDate = history.length > 0 ? history[history.length - 1]!.date : null;
  return {
    // No 0 fallback: an empty history maps to null prices → UI shows N/A.
    stock: toStockDto(stock, history[history.length - 1]?.close ?? null, history[history.length - 2]?.close ?? null, lastPriceDate),
    history,
    risk,
    freshness: { lastPriceDate, dataSource: stock.data_source },
  };
}

export async function getStockRisk(symbol: string): Promise<StockRiskProfile> {
  const stock = await requireActiveStockBySymbol(symbol);
  const history = await getPriceHistory(symbol);
  if (history.length === 0) throw notFound("We couldn't find that stock.");
  return getStockRiskProfile(history, await getProvenanceMap(stock.stock_id));
}

/** Resolves an active symbol to its row; throws a friendly 404 when missing. */
export const requireStockBySymbol = requireActiveStockBySymbol;
