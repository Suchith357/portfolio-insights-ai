/**
 * Stocks — maps to `/api/stocks` on the Express backend. Live data comes from
 * the PostgreSQL stock_prices tables (synthetic dataset); no live quotes.
 * Demo mode keeps the original in-browser dataset.
 */
import { STOCKS, getPriceHistory } from "@/lib/demo-data";
import { getStockRiskProfile } from "@/lib/analytics";
import type { PricePoint, Stock, StockRiskProfile } from "@/types";
import { ApiError, USE_DEMO_DATA, apiRequest, apiRequestWithMeta, delay } from "./api-client";

export interface StockQuery {
  search?: string;
  sector?: string;
  sort?: "symbol" | "name" | "price-desc" | "price-asc" | "mcap-desc";
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

export async function searchStocks(query: StockQuery = {}): Promise<Paginated<Stock>> {
  if (USE_DEMO_DATA) {
    const { search = "", sector = "all", sort = "symbol", page = 1, pageSize = 9 } = query;
    const term = search.trim().toLowerCase();
    let rows = STOCKS.filter(
      (s) =>
        (sector === "all" || s.sector === sector) &&
        (term === "" || s.symbol.toLowerCase().includes(term) || s.name.toLowerCase().includes(term)),
    );
    rows = [...rows].sort((a, b) => {
      switch (sort) {
        case "name":
          return a.name.localeCompare(b.name);
        case "price-desc":
          return b.lastPrice - a.lastPrice;
        case "price-asc":
          return a.lastPrice - b.lastPrice;
        case "mcap-desc":
          return b.marketCapCr - a.marketCapCr;
        default:
          return a.symbol.localeCompare(b.symbol);
      }
    });
    const total = rows.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), pageCount);
    return delay({
      rows: rows.slice((safePage - 1) * pageSize, safePage * pageSize),
      total,
      page: safePage,
      pageSize,
      pageCount,
    });
  }
  const params = new URLSearchParams();
  if (query.search) params.set("search", query.search);
  if (query.sector && query.sector !== "all") params.set("sector", query.sector);
  if (query.sort) params.set("sort", query.sort);
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  const qs = params.toString();
  // Backend returns the page as { data: Stock[], meta: { total, page,
  // pageSize, pageCount } }; remap it to the frontend's { rows, ... } shape.
  const { data, meta } = await apiRequestWithMeta<Stock[]>(`/stocks${qs ? `?${qs}` : ""}`);
  return {
    rows: data ?? [],
    total: meta?.total ?? 0,
    page: meta?.page ?? 1,
    pageSize: meta?.pageSize ?? 9,
    pageCount: meta?.pageCount ?? 1,
  };
}

export async function getStockBySymbol(symbol: string): Promise<Stock> {
  if (USE_DEMO_DATA) {
    const stock = STOCKS.find((s) => s.symbol === symbol.toUpperCase());
    if (!stock) throw new ApiError("We couldn't find that stock.", 404);
    return delay(stock);
  }
  return apiRequest<Stock>(`/stocks/${encodeURIComponent(symbol.toUpperCase())}`);
}

export async function getStockDetail(
  symbol: string,
): Promise<{ stock: Stock; history: PricePoint[]; risk: StockRiskProfile }> {
  if (USE_DEMO_DATA) {
    const stock = await getStockBySymbol(symbol);
    return {
      stock,
      history: getPriceHistory(stock.symbol),
      risk: getStockRiskProfile(stock.symbol),
    };
  }
  return apiRequest(`/stocks/${encodeURIComponent(symbol.toUpperCase())}`);
}

export async function listSectors(): Promise<string[]> {
  if (USE_DEMO_DATA) return [...new Set(STOCKS.map((s) => s.sector))].sort();
  return apiRequest<string[]>("/stocks/sectors");
}

/** Historical closing prices for one symbol (dataset data, not live quotes). */
export async function getStockPrices(symbol: string): Promise<PricePoint[]> {
  if (USE_DEMO_DATA) return getPriceHistory(symbol.toUpperCase());
  return apiRequest<PricePoint[]>(`/stocks/${encodeURIComponent(symbol.toUpperCase())}/prices`);
}
