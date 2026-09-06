/** Stocks — maps to `/api/stocks`. Demo dataset only; no live quotes. */
import { STOCKS, getPriceHistory } from "@/lib/demo-data";
import { getStockRiskProfile } from "@/lib/analytics";
import type { PricePoint, Stock, StockRiskProfile } from "@/types";
import { ApiError, delay } from "./api-client";

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

export async function getStockBySymbol(symbol: string): Promise<Stock> {
  const stock = STOCKS.find((s) => s.symbol === symbol.toUpperCase());
  if (!stock) throw new ApiError("We couldn't find that stock.", 404);
  return delay(stock);
}

export async function getStockDetail(
  symbol: string,
): Promise<{ stock: Stock; history: PricePoint[]; risk: StockRiskProfile }> {
  const stock = await getStockBySymbol(symbol);
  return {
    stock,
    history: getPriceHistory(stock.symbol),
    risk: getStockRiskProfile(stock.symbol),
  };
}

export function listSectors(): string[] {
  return [...new Set(STOCKS.map((s) => s.sector))].sort();
}
