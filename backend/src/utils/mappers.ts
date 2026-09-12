/**
 * Row → API DTO mappers.
 *
 * The database uses snake_case columns with numeric IDs; the frontend expects
 * camelCase fields with string IDs. Mapping lives here so services stay clean.
 * Password hashes are never included in any mapper output.
 */
import type { users, stocks, stock_prices } from "@prisma/client";

type StockRow = stocks;
type PriceRow = Pick<stock_prices, "close_price" | "price_date">;

export function serialize<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (typeof v === "bigint") return Number(v);
      if (v && typeof v === "object" && typeof (v as { toNumber?: unknown }).toNumber === "function") {
        return (v as { toNumber: () => number }).toNumber();
      }
      return v;
    }),
  );
}

export function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export interface UserDto {
  id: string;
  name: string;
  email: string;
  role: "USER" | "ADMIN";
  status: "ACTIVE" | "SUSPENDED";
  createdAt: string;
}

export function toUserDto(u: users): UserDto {
  return {
    id: String(u.user_id),
    name: u.name,
    email: u.email,
    role: u.role === "ADMIN" ? "ADMIN" : "USER",
    status: "ACTIVE",
    createdAt: u.created_at.toISOString(),
  };
}

export interface StockDto {
  id: string;
  symbol: string;
  name: string;
  sector: string;
  exchange: string;
  currency: "INR";
  lastPrice: number;
  previousClose: number;
  marketCapCr: number;
  peRatio: number | null;
  dividendYield: number | null;
  description: string | null;
  industry: string | null;
  isActive: boolean;
}

export function toStockDto(s: StockRow, lastClose: unknown, prevClose: unknown): StockDto {
  const last = toNumber(lastClose);
  const prev = toNumber(prevClose, last);
  return {
    id: String(s.stock_id),
    symbol: s.symbol,
    name: s.company_name,
    sector: s.sector,
    exchange: s.exchange,
    currency: "INR",
    lastPrice: last,
    previousClose: prev,
    marketCapCr: s.market_cap === null ? 0 : toNumber(s.market_cap),
    peRatio: s.pe_ratio === null ? null : toNumber(s.pe_ratio),
    dividendYield: s.dividend_yield === null ? null : toNumber(s.dividend_yield),
    description: s.description,
    industry: s.industry,
    isActive: s.is_active,
  };
}

/** Builds a minimal DTO when only the two latest closes are needed. */
export function toStockDtoFromPrices(s: StockRow, prices: PriceRow[]): StockDto {
  const latest = prices[0]?.close_price ?? 0;
  const prev = prices[1]?.close_price ?? prices[0]?.close_price ?? 0;
  return toStockDto(s, latest, prev);
}

export interface PortfolioDto {
  id: string;
  userId: string;
  name: string;
  description: string;
  baseCurrency: "INR";
  createdAt: string;
}

export function toPortfolioDto(p: {
  portfolio_id: number;
  user_id: number;
  name: string;
  description: string | null;
  created_at: Date;
}): PortfolioDto {
  return {
    id: String(p.portfolio_id),
    userId: String(p.user_id),
    name: p.name,
    description: p.description ?? "",
    baseCurrency: "INR",
    createdAt: p.created_at.toISOString(),
  };
}

export interface HoldingDto {
  id: string;
  portfolioId: string;
  stockId: string;
  symbol: string;
  quantity: number;
  avgBuyPrice: number;
  addedAt: string;
}

export function toHoldingDto(h: {
  holding_id: number;
  portfolio_id: number;
  stock_id: number;
  quantity: unknown;
  average_buy_price: unknown;
  created_at: Date;
}, symbol: string): HoldingDto {
  return {
    id: String(h.holding_id),
    portfolioId: String(h.portfolio_id),
    stockId: String(h.stock_id),
    symbol,
    quantity: toNumber(h.quantity),
    avgBuyPrice: toNumber(h.average_buy_price),
    addedAt: h.created_at.toISOString(),
  };
}

export interface TransactionDto {
  id: string;
  portfolioId: string;
  stockId: string;
  symbol: string;
  type: "BUY" | "SELL";
  quantity: number;
  price: number;
  executedAt: string;
}

export function toTransactionDto(t: {
  transaction_id: number;
  portfolio_id: number;
  stock_id: number;
  transaction_type: string;
  quantity: unknown;
  price: unknown;
  transaction_date: Date;
}, symbol: string): TransactionDto {
  return {
    id: String(t.transaction_id),
    portfolioId: String(t.portfolio_id),
    stockId: String(t.stock_id),
    symbol,
    type: t.transaction_type === "SELL" ? "SELL" : "BUY",
    quantity: toNumber(t.quantity),
    price: toNumber(t.price),
    executedAt: t.transaction_date.toISOString(),
  };
}

export interface WatchlistItemDto {
  id: string;
  userId: string;
  stockId: string;
  symbol: string;
  addedAt: string;
}

export function toWatchlistDto(w: {
  watchlist_id: number;
  user_id: number;
  stock_id: number;
  added_at: Date;
}, symbol: string): WatchlistItemDto {
  return {
    id: String(w.watchlist_id),
    userId: String(w.user_id),
    stockId: String(w.stock_id),
    symbol,
    addedAt: w.added_at.toISOString(),
  };
}

export interface AlertDto {
  id: string;
  userId: string;
  portfolioId: string | null;
  stockId: string | null;
  symbol: string | null;
  headline: string;
  eventType: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  createdAt: string;
  summary: string;
  source: string;
  whyItMatters: string;
  isRead: boolean;
}

/** Maps the alert row plus optional joined stock row to the API shape. */
export function toAlertDto(
  a: {
    alert_id: number;
    user_id: number;
    portfolio_id: number | null;
    stock_id: number | null;
    alert_type: string;
    severity: string;
    title: string;
    message: string;
    is_read: boolean;
    created_at: Date;
  },
  symbol: string | null,
): AlertDto {
  return {
    id: String(a.alert_id),
    userId: String(a.user_id),
    portfolioId: a.portfolio_id === null ? null : String(a.portfolio_id),
    stockId: a.stock_id === null ? null : String(a.stock_id),
    symbol,
    headline: a.title,
    eventType: a.alert_type,
    severity: (["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(a.severity)
      ? a.severity
      : "LOW") as AlertDto["severity"],
    createdAt: a.created_at.toISOString(),
    summary: a.message,
    source: "PortfolioIQ engine",
    whyItMatters:
      a.portfolio_id !== null
        ? "This event is linked to one of your portfolios, so it may affect your measured risk and diversification."
        : "This event is linked to a stock on your radar; review its impact on your exposure.",
    isRead: a.is_read,
  };
}
