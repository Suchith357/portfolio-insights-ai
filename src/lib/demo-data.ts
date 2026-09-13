/**
 * DEMO DATA ONLY.
 *
 * Nothing in this file is live market or news data. Every price series is
 * synthetic and deterministic (seeded PRNG) so the UI is stable across renders.
 * A real ingestion layer (market data + news provider) replaces this module
 * behind `src/services/*` without any UI change.
 */
import type {
  Alert,
  AuditLogEntry,
  Holding,
  Portfolio,
  PricePoint,
  Stock,
  Transaction,
  User,
  WatchlistItem,
} from "@/types";
import { annualisedVolatility, maxDrawdown, riskBand, trailingReturn } from "@/lib/stats";

export const DEMO_DATA_NOTICE =
  "Demo data — synthetic prices and sample news for development only. Not live market data.";

export const SECTORS = [
  "Information Technology",
  "Banking & Financials",
  "Energy",
  "FMCG",
  "Pharmaceuticals",
  "Automobile",
  "Metals",
  "Telecom",
  "Infrastructure",
] as const;

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface StockSeed {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  vol: number;
  drift: number;
  marketCapCr: number;
}

const STOCK_SEEDS: StockSeed[] = [
  { symbol: "TCS", name: "Tata Consultancy Services", sector: "Information Technology", price: 3890, vol: 0.2, drift: 0.09, marketCapCr: 1420000 },
  { symbol: "INFY", name: "Infosys Limited", sector: "Information Technology", price: 1585, vol: 0.24, drift: 0.08, marketCapCr: 658000 },
  { symbol: "WIPRO", name: "Wipro Limited", sector: "Information Technology", price: 512, vol: 0.27, drift: 0.04, marketCapCr: 268000 },
  { symbol: "HCLTECH", name: "HCL Technologies", sector: "Information Technology", price: 1620, vol: 0.23, drift: 0.11, marketCapCr: 439000 },
  { symbol: "HDFCBANK", name: "HDFC Bank", sector: "Banking & Financials", price: 1678, vol: 0.19, drift: 0.07, marketCapCr: 1280000 },
  { symbol: "ICICIBANK", name: "ICICI Bank", sector: "Banking & Financials", price: 1142, vol: 0.21, drift: 0.13, marketCapCr: 803000 },
  { symbol: "SBIN", name: "State Bank of India", sector: "Banking & Financials", price: 798, vol: 0.28, drift: 0.12, marketCapCr: 712000 },
  { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank", sector: "Banking & Financials", price: 1755, vol: 0.22, drift: 0.03, marketCapCr: 349000 },
  { symbol: "BAJFINANCE", name: "Bajaj Finance", sector: "Banking & Financials", price: 6890, vol: 0.31, drift: 0.1, marketCapCr: 426000 },
  { symbol: "RELIANCE", name: "Reliance Industries", sector: "Energy", price: 2895, vol: 0.23, drift: 0.1, marketCapCr: 1958000 },
  { symbol: "ONGC", name: "Oil & Natural Gas Corp", sector: "Energy", price: 268, vol: 0.3, drift: 0.06, marketCapCr: 337000 },
  { symbol: "NTPC", name: "NTPC Limited", sector: "Energy", price: 356, vol: 0.26, drift: 0.14, marketCapCr: 345000 },
  { symbol: "ITC", name: "ITC Limited", sector: "FMCG", price: 438, vol: 0.17, drift: 0.08, marketCapCr: 548000 },
  { symbol: "HINDUNILVR", name: "Hindustan Unilever", sector: "FMCG", price: 2452, vol: 0.16, drift: 0.02, marketCapCr: 576000 },
  { symbol: "NESTLEIND", name: "Nestle India", sector: "FMCG", price: 2320, vol: 0.15, drift: 0.05, marketCapCr: 223000 },
  { symbol: "SUNPHARMA", name: "Sun Pharmaceutical", sector: "Pharmaceuticals", price: 1712, vol: 0.24, drift: 0.15, marketCapCr: 410000 },
  { symbol: "CIPLA", name: "Cipla Limited", sector: "Pharmaceuticals", price: 1495, vol: 0.22, drift: 0.11, marketCapCr: 120000 },
  { symbol: "DRREDDY", name: "Dr. Reddy's Laboratories", sector: "Pharmaceuticals", price: 1268, vol: 0.25, drift: 0.07, marketCapCr: 105000 },
  { symbol: "MARUTI", name: "Maruti Suzuki India", sector: "Automobile", price: 11250, vol: 0.24, drift: 0.09, marketCapCr: 353000 },
  { symbol: "TATAMOTORS", name: "Tata Motors", sector: "Automobile", price: 968, vol: 0.36, drift: 0.16, marketCapCr: 356000 },
  { symbol: "M&M", name: "Mahindra & Mahindra", sector: "Automobile", price: 2845, vol: 0.29, drift: 0.18, marketCapCr: 353000 },
  { symbol: "TATASTEEL", name: "Tata Steel", sector: "Metals", price: 148, vol: 0.34, drift: 0.05, marketCapCr: 185000 },
  { symbol: "HINDALCO", name: "Hindalco Industries", sector: "Metals", price: 645, vol: 0.33, drift: 0.09, marketCapCr: 145000 },
  { symbol: "JSWSTEEL", name: "JSW Steel", sector: "Metals", price: 912, vol: 0.31, drift: 0.07, marketCapCr: 223000 },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", sector: "Telecom", price: 1485, vol: 0.25, drift: 0.19, marketCapCr: 885000 },
  { symbol: "IDEA", name: "Vodafone Idea", sector: "Telecom", price: 14.2, vol: 0.62, drift: -0.12, marketCapCr: 98000 },
  { symbol: "LT", name: "Larsen & Toubro", sector: "Infrastructure", price: 3564, vol: 0.22, drift: 0.16, marketCapCr: 489000 },
  { symbol: "ADANIPORTS", name: "Adani Ports & SEZ", sector: "Infrastructure", price: 1385, vol: 0.4, drift: 0.14, marketCapCr: 299000 },
  { symbol: "ULTRACEMCO", name: "UltraTech Cement", sector: "Infrastructure", price: 10890, vol: 0.21, drift: 0.12, marketCapCr: 314000 },
  { symbol: "DLF", name: "DLF Limited", sector: "Infrastructure", price: 786, vol: 0.35, drift: 0.13, marketCapCr: 194000 },
];

/** Risk profile for the synthetic demo series (same formulas as the backend engine). */
function demoRiskProfile(symbol: string): Stock["risk"] {
  const series = getPriceHistory(symbol);
  const vol = annualisedVolatility(series);
  return {
    volatilityPct: vol,
    maxDrawdownPct: maxDrawdown(series),
    return1yPct: trailingReturn(series, 1),
    return3yPct: trailingReturn(series, 3),
    return5yPct: trailingReturn(series, 5),
    riskBand: riskBand(vol),
    observations: series.length,
  };
}

const seedBySymbol = new Map(STOCK_SEEDS.map((s) => [s.symbol, s]));

export const STOCKS: Stock[] = STOCK_SEEDS.map((s, i) => ({
  id: `stk_${i + 1}`,
  symbol: s.symbol,
  name: s.name,
  sector: s.sector,
  exchange: "NSE",
  currency: "INR",
  lastPrice: s.price,
  previousClose: +(s.price * (1 - (mulberry32(hash(s.symbol))() - 0.5) * 0.03)).toFixed(2),
  marketCapCr: s.marketCapCr,
  peRatio: null,
  dividendYield: null,
  dataSource: "DEMO",
  lastPriceDate: null,
  fundamentalsUpdatedAt: null,
  risk: demoRiskProfile(s.symbol),
}));

/** 5 years of synthetic weekly closes, deterministic per symbol. */
export function getPriceHistory(symbol: string): PricePoint[] {
  const seed = seedBySymbol.get(symbol);
  if (!seed) return [];
  const rand = mulberry32(hash(symbol));
  const weeks = 52 * 5;
  const dt = 1 / 52;
  const points: PricePoint[] = [];
  // Walk backwards from today's price using a seeded GBM, then reverse.
  let price = seed.price;
  const end = new Date("2026-09-01T00:00:00Z");
  for (let i = 0; i < weeks; i++) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i * 7);
    points.push({ date: d.toISOString().slice(0, 10), close: +price.toFixed(2) });
    const shock = (rand() + rand() + rand() + rand() - 2) * 0.9;
    const step = Math.exp((seed.drift - (seed.vol * seed.vol) / 2) * dt + seed.vol * Math.sqrt(dt) * shock);
    price = Math.max(price / step, 0.5);
  }
  return points.reverse();
}

export const DEMO_USERS: (User & { password: string })[] = [
  {
    id: "usr_1",
    name: "Suchith R",
    email: "user@portfolioiq.dev",
    role: "USER",
    status: "ACTIVE",
    createdAt: "2026-01-14T09:12:00Z",
    password: "demo1234",
  },
  {
    id: "usr_2",
    name: "Platform Admin",
    email: "admin@portfolioiq.dev",
    role: "ADMIN",
    status: "ACTIVE",
    createdAt: "2025-11-02T06:40:00Z",
    password: "admin1234",
  },
];

export const ADMIN_USER_LIST: User[] = [
  ...DEMO_USERS.map(({ password: _password, ...u }) => u),
  { id: "usr_3", name: "Ananya Iyer", email: "ananya@example.com", role: "USER", status: "ACTIVE", createdAt: "2026-02-03T11:00:00Z" },
  { id: "usr_4", name: "Rahul Menon", email: "rahul@example.com", role: "USER", status: "SUSPENDED", createdAt: "2026-02-21T15:30:00Z" },
  { id: "usr_5", name: "Priya Sharma", email: "priya@example.com", role: "USER", status: "ACTIVE", createdAt: "2026-03-09T08:05:00Z" },
  { id: "usr_6", name: "Karthik Nair", email: "karthik@example.com", role: "USER", status: "ACTIVE", createdAt: "2026-04-17T13:45:00Z" },
  { id: "usr_7", name: "Meera Joshi", email: "meera@example.com", role: "ADMIN", status: "ACTIVE", createdAt: "2026-05-02T10:20:00Z" },
  { id: "usr_8", name: "Arjun Verma", email: "arjun@example.com", role: "USER", status: "ACTIVE", createdAt: "2026-06-11T17:10:00Z" },
  { id: "usr_9", name: "Divya Rao", email: "divya@example.com", role: "USER", status: "ACTIVE", createdAt: "2026-07-08T09:55:00Z" },
  { id: "usr_10", name: "Nikhil Gupta", email: "nikhil@example.com", role: "USER", status: "SUSPENDED", createdAt: "2026-08-19T12:35:00Z" },
];

export const DEMO_PORTFOLIOS: Portfolio[] = [
  {
    id: "pf_1",
    userId: "usr_1",
    name: "Core Long Term",
    description: "Buy-and-hold large caps held for 5+ years.",
    baseCurrency: "INR",
    createdAt: "2026-01-20T10:00:00Z",
  },
  {
    id: "pf_2",
    userId: "usr_1",
    name: "Tactical Growth",
    description: "Higher-beta positions reviewed every quarter.",
    baseCurrency: "INR",
    createdAt: "2026-04-05T10:00:00Z",
  },
];

export const DEMO_HOLDINGS: Holding[] = [
  { id: "hld_1", portfolioId: "pf_1", symbol: "TCS", quantity: 45, avgBuyPrice: 3320 },
  { id: "hld_2", portfolioId: "pf_1", symbol: "INFY", quantity: 120, avgBuyPrice: 1410 },
  { id: "hld_3", portfolioId: "pf_1", symbol: "HDFCBANK", quantity: 90, avgBuyPrice: 1590 },
  { id: "hld_4", portfolioId: "pf_1", symbol: "RELIANCE", quantity: 40, avgBuyPrice: 2510 },
  { id: "hld_5", portfolioId: "pf_1", symbol: "ITC", quantity: 300, avgBuyPrice: 402 },
  { id: "hld_6", portfolioId: "pf_1", symbol: "SUNPHARMA", quantity: 55, avgBuyPrice: 1480 },
  { id: "hld_7", portfolioId: "pf_2", symbol: "TATAMOTORS", quantity: 180, avgBuyPrice: 1042 },
  { id: "hld_8", portfolioId: "pf_2", symbol: "BHARTIARTL", quantity: 70, avgBuyPrice: 1180 },
  { id: "hld_9", portfolioId: "pf_2", symbol: "ADANIPORTS", quantity: 60, avgBuyPrice: 1495 },
  { id: "hld_10", portfolioId: "pf_2", symbol: "DLF", quantity: 110, avgBuyPrice: 690 },
];

export const DEMO_TRANSACTIONS: Transaction[] = [
  { id: "txn_1", portfolioId: "pf_1", symbol: "TCS", type: "BUY", quantity: 25, price: 3210, executedAt: "2026-01-22T04:15:00Z" },
  { id: "txn_2", portfolioId: "pf_1", symbol: "TCS", type: "BUY", quantity: 20, price: 3457, executedAt: "2026-03-11T05:02:00Z" },
  { id: "txn_3", portfolioId: "pf_1", symbol: "INFY", type: "BUY", quantity: 120, price: 1410, executedAt: "2026-02-02T06:30:00Z" },
  { id: "txn_4", portfolioId: "pf_1", symbol: "HDFCBANK", type: "BUY", quantity: 110, price: 1575, executedAt: "2026-02-14T04:50:00Z" },
  { id: "txn_5", portfolioId: "pf_1", symbol: "HDFCBANK", type: "SELL", quantity: 20, price: 1702, executedAt: "2026-06-19T07:20:00Z" },
  { id: "txn_6", portfolioId: "pf_1", symbol: "RELIANCE", type: "BUY", quantity: 40, price: 2510, executedAt: "2026-03-28T05:45:00Z" },
  { id: "txn_7", portfolioId: "pf_1", symbol: "ITC", type: "BUY", quantity: 300, price: 402, executedAt: "2026-04-15T09:10:00Z" },
  { id: "txn_8", portfolioId: "pf_1", symbol: "SUNPHARMA", type: "BUY", quantity: 55, price: 1480, executedAt: "2026-05-06T04:35:00Z" },
  { id: "txn_9", portfolioId: "pf_2", symbol: "TATAMOTORS", type: "BUY", quantity: 180, price: 1042, executedAt: "2026-04-09T06:05:00Z" },
  { id: "txn_10", portfolioId: "pf_2", symbol: "BHARTIARTL", type: "BUY", quantity: 70, price: 1180, executedAt: "2026-05-21T05:15:00Z" },
  { id: "txn_11", portfolioId: "pf_2", symbol: "ADANIPORTS", type: "BUY", quantity: 60, price: 1495, executedAt: "2026-06-30T08:00:00Z" },
  { id: "txn_12", portfolioId: "pf_2", symbol: "DLF", type: "BUY", quantity: 110, price: 690, executedAt: "2026-07-24T04:25:00Z" },
];

export const DEMO_WATCHLIST: WatchlistItem[] = [
  { id: "wl_1", userId: "usr_1", symbol: "ICICIBANK", addedAt: "2026-06-02T10:00:00Z" },
  { id: "wl_2", userId: "usr_1", symbol: "LT", addedAt: "2026-07-13T10:00:00Z" },
  { id: "wl_3", userId: "usr_1", symbol: "MARUTI", addedAt: "2026-08-01T10:00:00Z" },
  { id: "wl_4", userId: "usr_1", symbol: "CIPLA", addedAt: "2026-08-22T10:00:00Z" },
];

export const DEMO_ALERTS: Alert[] = [
  {
    id: "alr_1",
    symbol: "ADANIPORTS",
    headline: "Regulatory review announced for two container terminals",
    eventType: "Regulatory",
    severity: "CRITICAL",
    createdAt: "2026-09-05T09:20:00Z",
    summary:
      "A port authority has opened a compliance review covering concession terms at two terminals. Timeline and financial impact are not yet disclosed.",
    source: "Demo newswire",
    whyItMatters:
      "Regulatory reviews can affect revenue visibility. This position is one of the larger weights in your Tactical Growth portfolio, so portfolio-level impact is above average.",
  },
  {
    id: "alr_2",
    symbol: "TATAMOTORS",
    headline: "Monthly volume update below street expectations",
    eventType: "Operational",
    severity: "HIGH",
    createdAt: "2026-09-04T11:05:00Z",
    summary: "Reported wholesale volumes came in lower month-on-month, driven by a softer passenger-vehicle mix.",
    source: "Demo newswire",
    whyItMatters:
      "Volume trends feed directly into revenue estimates. Combined with the stock's high historical volatility, indicators suggest elevated short-term uncertainty for this holding.",
  },
  {
    id: "alr_3",
    symbol: "TCS",
    headline: "Large multi-year deal signed in European banking",
    eventType: "Business Update",
    severity: "LOW",
    createdAt: "2026-09-03T07:45:00Z",
    summary: "A multi-year managed services agreement was announced; contract value was not disclosed.",
    source: "Demo newswire",
    whyItMatters:
      "Order-book additions support revenue visibility. This is your single largest holding, so sentiment here moves overall portfolio value meaningfully.",
  },
  {
    id: "alr_4",
    symbol: "SUNPHARMA",
    headline: "Facility inspection observations issued",
    eventType: "Regulatory",
    severity: "MEDIUM",
    createdAt: "2026-09-01T14:10:00Z",
    summary: "Inspection observations were issued for a manufacturing facility; the company says remediation is underway.",
    source: "Demo newswire",
    whyItMatters:
      "Observations can delay approvals for products made at the site. Your exposure here is moderate relative to total portfolio value.",
  },
  {
    id: "alr_5",
    symbol: "HDFCBANK",
    headline: "Deposit growth commentary from quarterly update",
    eventType: "Earnings",
    severity: "LOW",
    createdAt: "2026-08-29T06:30:00Z",
    summary: "The quarterly business update reported steady deposit growth and stable asset quality metrics.",
    source: "Demo newswire",
    whyItMatters: "Stable funding trends reduce uncertainty for a core holding in your Core Long Term portfolio.",
  },
  {
    id: "alr_6",
    symbol: "DLF",
    headline: "Sector-wide input cost pressure reported",
    eventType: "Sector",
    severity: "MEDIUM",
    createdAt: "2026-08-27T12:00:00Z",
    summary: "Industry commentary points to higher input costs across real estate and construction.",
    source: "Demo newswire",
    whyItMatters:
      "You hold three Infrastructure-linked names, so sector-wide pressure affects more than one position at the same time.",
  },
];

export const DEMO_AUDIT_LOG: AuditLogEntry[] = [
  { id: "aud_1", actor: "user@portfolioiq.dev", action: "AUTH_LOGIN", entity: "Session", entityId: "sess_8891", createdAt: "2026-09-06T08:12:00Z" },
  { id: "aud_2", actor: "user@portfolioiq.dev", action: "PORTFOLIO_CREATE", entity: "Portfolio", entityId: "pf_2", createdAt: "2026-09-06T08:15:00Z" },
  { id: "aud_3", actor: "user@portfolioiq.dev", action: "TRANSACTION_CREATE", entity: "Transaction", entityId: "txn_12", createdAt: "2026-09-05T10:41:00Z" },
  { id: "aud_4", actor: "admin@portfolioiq.dev", action: "USER_SUSPEND", entity: "User", entityId: "usr_10", createdAt: "2026-09-05T09:02:00Z" },
  { id: "aud_5", actor: "admin@portfolioiq.dev", action: "STOCK_UPDATE", entity: "Stock", entityId: "stk_28", createdAt: "2026-09-04T16:28:00Z" },
  { id: "aud_6", actor: "ananya@example.com", action: "WATCHLIST_ADD", entity: "WatchlistItem", entityId: "wl_31", createdAt: "2026-09-04T11:19:00Z" },
  { id: "aud_7", actor: "rahul@example.com", action: "AUTH_LOGIN_FAILED", entity: "Session", entityId: "-", createdAt: "2026-09-03T19:55:00Z" },
  { id: "aud_8", actor: "admin@portfolioiq.dev", action: "ROLE_UPDATE", entity: "User", entityId: "usr_7", createdAt: "2026-09-02T13:37:00Z" },
];
