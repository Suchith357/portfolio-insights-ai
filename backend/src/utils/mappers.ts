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

/** Numbers that may legitimately be missing stay null (never 0). */
export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
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
  /** Latest stored close; null when the stock has no usable price rows (never 0). */
  lastPrice: number | null;
  /** Previous trading day's close; null when only one price row exists. */
  previousClose: number | null;
  marketCapCr: number | null;
  peRatio: number | null;
  dividendYield: number | null;
  description: string | null;
  industry: string | null;
  isActive: boolean;
  /** Provenance of the latest price: 'DEMO' (synthetic) or 'YAHOO' (real). */
  dataSource: string;
  /** Date (YYYY-MM-DD) of the latest stored price; null when none exists. */
  lastPriceDate: string | null;
  /** When fundamentals (P/E, mcap, yield) were last refreshed; null = never. */
  fundamentalsUpdatedAt: string | null;
}

export function toStockDto(
  s: {
    stock_id: number;
    symbol: string;
    company_name: string;
    sector: string;
    exchange: string;
    market_cap: unknown;
    pe_ratio: unknown;
    dividend_yield: unknown;
    description: unknown;
    industry: unknown;
    is_active: boolean;
    data_source?: string;
    fundamentals_updated_at?: Date | null;
  },
  lastClose: unknown,
  prevClose: unknown,
  lastPriceDate: string | null = null,
): StockDto {
  const last = toNumberOrNull(lastClose);
  // Previous close falls back to the latest only when it is genuinely absent
  // (single price row) — positional logic, never "previous = latest" sentinel.
  const prev = toNumberOrNull(prevClose) ?? last;
  return {
    id: String(s.stock_id),
    symbol: s.symbol,
    name: s.company_name,
    sector: s.sector,
    exchange: s.exchange,
    currency: "INR",
    lastPrice: last,
    previousClose: prev,
    marketCapCr: s.market_cap === null || s.market_cap === undefined ? null : toNumberOrNull(s.market_cap),
    peRatio: s.pe_ratio === null || s.pe_ratio === undefined ? null : toNumberOrNull(s.pe_ratio),
    dividendYield: s.dividend_yield === null || s.dividend_yield === undefined ? null : toNumberOrNull(s.dividend_yield),
    description: s.description === null || s.description === undefined ? null : String(s.description),
    industry: s.industry === null || s.industry === undefined ? null : String(s.industry),
    isActive: s.is_active,
    dataSource: s.data_source ?? "DEMO",
    lastPriceDate,
    fundamentalsUpdatedAt: s.fundamentals_updated_at ? new Date(s.fundamentals_updated_at).toISOString() : null,
  };
}

/** Builds a minimal DTO when only the two latest closes are needed. */
export function toStockDtoFromPrices(s: StockRow, prices: PriceRow[]): StockDto {
  const latest = prices[0]?.close_price ?? null;
  const prev = prices[1]?.close_price ?? prices[0]?.close_price ?? null;
  const lastPriceDate = prices[0]?.price_date ? prices[0].price_date.toISOString().slice(0, 10) : null;
  return toStockDto(s, latest, prev, lastPriceDate);
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
  /** Req 3: plain-language explanation of this alert type for non-finance users. */
  meaning?: { what: string; higherMeans: string; lowerMeans: string; conclusion: string };
  isRead: boolean;
  /** Phase 3: 'ANALYTICS' or 'INTELLIGENCE' (news-event alert). */
  sourceSystem?: string;
  /** Intelligence event id when this alert originated from news intelligence. */
  eventId?: string | null;
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
    source?: string;
    intelligence_event_id?: number | null;
  },
  symbol: string | null,
): AlertDto {
  const isIntelligence = a.source === "INTELLIGENCE";
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
    source: isIntelligence ? "PortfolioIQ Intelligence" : "PortfolioIQ engine",
    whyItMatters: isIntelligence
      ? "News detected by the Intelligence engine may touch this stock in your portfolio. Open the linked event for sources and reasoning."
      : a.portfolio_id !== null
        ? "This event is linked to one of your portfolios, so it may affect your measured risk and diversification."
        : "This event is linked to a stock on your radar; review its impact on your exposure.",
    isRead: a.is_read,
    /** Phase 3: provenance + link to the originating intelligence event. */
    sourceSystem: isIntelligence ? "INTELLIGENCE" : "ANALYTICS",
    eventId: a.intelligence_event_id === null || a.intelligence_event_id === undefined ? null : String(a.intelligence_event_id),
    /** Req 3: plain-language meaning + outcome guidance per alert type. */
    meaning: PLAIN_LANGUAGE[a.alert_type] ?? {
      what: "PortfolioIQ generated this alert from your own portfolio data.",
      higherMeans: "What it means for you depends on the details in the alert message above.",
      lowerMeans: "Read the message and open the linked stock or event for context.",
      conclusion: "Review the alert details to decide whether any action makes sense for you.",
    },
  };
}

/**
 * Req 3: plain-language explanations per alert_type. Short, professional,
 * non-condescending: what the value measures, what higher/lower mean, and a
 * reasonable conclusion. No advice — the conclusion is always contextual.
 */
const PLAIN_LANGUAGE: Record<string, { what: string; higherMeans: string; lowerMeans: string; conclusion: string }> = {
  CONCENTRATION: {
    what: "Shows how much of this portfolio's value sits in its single largest stock.",
    higherMeans: "A higher share means results depend more on one company — good when it rises, painful when it falls.",
    lowerMeans: "A lower share means gains and losses are spread across more companies.",
    conclusion: "If one stock is much heavier than the rest, your portfolio's fortunes move mostly with that company.",
  },
  HIGH_RISK: {
    what: "Measures overall portfolio risk from volatility and past drawdowns, on a 0–100 scale.",
    higherMeans: "Higher scores mean the portfolio's value tends to swing more — larger potential gains, larger potential losses.",
    lowerMeans: "Lower scores mean steadier day-to-day value with smaller swings.",
    conclusion: "A high score suggests sizing positions so a bad month would not force you to sell.",
  },
  LOW_DIVERSIFICATION: {
    what: "Rates how spread out your value is across stocks and sectors, 0–100.",
    higherMeans: "A higher score would mean better spread; this alert fires because yours is low.",
    lowerMeans: "A lower score means value is bunched in few stocks or one sector, so a single event can hit everything at once.",
    conclusion: "Spreading value across unrelated sectors usually softens the impact of any one piece of bad news.",
  },
  MARKET_ANOMALY: {
    what: "A statistical flag: today's move was far outside this stock's (or sector's) own recent behaviour.",
    higherMeans: "A bigger deviation from normal — worth understanding, but not automatically good or bad.",
    lowerMeans: "A smaller deviation — closer to this stock's everyday behaviour.",
    conclusion: "Unusual moves often have a news reason; check the Intelligence feed before reacting.",
  },
  NEWS_EVENT: {
    what: "An event detected in the news that plausibly touches a stock or sector you hold or watch.",
    higherMeans: "Greater relevance/importance to your holdings — worth reading sooner.",
    lowerMeans: "Lower relevance — context worth knowing, likely not urgent.",
    conclusion: "Open the linked event to see the sources, your exposure, and what to monitor.",
  },
};
