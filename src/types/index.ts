/**
 * PortfolioIQ domain types.
 *
 * These intentionally mirror *conceptual* entities only. The final relational
 * schema (ER diagram -> 3NF -> PostgreSQL/Prisma) is designed separately; these
 * shapes are what the REST API is expected to return and can be adjusted to the
 * final schema without touching UI components.
 */

export type Role = "USER" | "ADMIN";
export type AccountStatus = "ACTIVE" | "SUSPENDED";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: AccountStatus;
  createdAt: string;
}

export interface Sector {
  id: string;
  name: string;
}

export interface Stock {
  id: string;
  symbol: string;
  name: string;
  sector: string;
  exchange: string;
  currency: "INR";
  /** Latest stored price; null when no usable price row exists — never 0. */
  lastPrice: number | null;
  previousClose: number | null;
  /** Market cap in ₹ crore; null when the provider has no value — never 0. */
  marketCapCr: number | null;
  peRatio: number | null;
  dividendYield: number | null;
  /** Analytics-engine risk profile computed from the dataset's price history. */
  risk: StockRiskProfile;
  /** Provenance: 'DEMO' (synthetic seed) or 'YAHOO' (real market data). */
  dataSource?: string;
  /** Trading date of the latest stored price (YYYY-MM-DD); null = none. */
  lastPriceDate?: string | null;
  /** When fundamentals were last refreshed; null = never fetched. */
  fundamentalsUpdatedAt?: string | null;
  description?: string | null;
  industry?: string | null;
  isActive?: boolean;
}

export interface PricePoint {
  date: string;
  close: number;
}

export interface Holding {
  id: string;
  portfolioId: string;
  symbol: string;
  quantity: number;
  avgBuyPrice: number;
}

export type TransactionType = "BUY" | "SELL";

export interface Transaction {
  id: string;
  portfolioId: string;
  symbol: string;
  type: TransactionType;
  quantity: number;
  price: number;
  executedAt: string;
}

export interface ImportRow {
  symbol: string;
  quantity: number;
  price: number;
  date?: string;
}

export interface ImportError {
  row: number;
  symbol: string | null;
  reason: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  transactionsCreated: number;
  errors: ImportError[];
}

export interface Portfolio {
  id: string;
  userId: string;
  name: string;
  description: string;
  baseCurrency: "INR";
  createdAt: string;
}

export interface WatchlistItem {
  id: string;
  userId: string;
  symbol: string;
  addedAt: string;
  /** Stock metadata + analytics risk, attached by the backend in API mode. */
  stock?: Stock;
}

export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface Alert {
  id: string;
  symbol: string;
  headline: string;
  eventType: string;
  severity: Severity;
  createdAt: string;
  summary: string;
  source: string;
  whyItMatters: string;
  /** Req 3: plain-language meaning of the alert type (what/higher/lower/conclusion). */
  meaning?: {
    what: string;
    higherMeans: string;
    lowerMeans: string;
    conclusion: string;
  };
  /** True once the user has acknowledged the alert. */
  isRead?: boolean;
}

export interface AuditLogEntry {
  id: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  createdAt: string;
  details?: string;
}

/** Market-data freshness envelope attached to catalogue/list responses. */
export interface MarketDataMeta {
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  freshness?: {
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
    dataSourceMix: { yahoo: number; demo: number };
  };
}

export interface SimulationDelta {
  label: string;
  before: number | null;
  after: number | null;
  unit: "score" | "pct" | "currency";
  betterWhenLower?: boolean;
}

/* ---------- Analytics engine outputs (computed, never AI-generated) ---------- */

export interface HoldingView extends Holding {
  stock: Stock;
  risk: StockRiskProfile;
  invested: number;
  currentValue: number;
  pnl: number;
  pnlPct: number;
  allocationPct: number;
}

export interface SectorAllocation {
  sector: string;
  value: number;
  pct: number;
}

export interface PortfolioMetrics {
  totalValue: number;
  totalInvested: number;
  pnl: number;
  pnlPct: number;
  /** PortfolioIQ heuristic risk score; null when history is insufficient. */
  riskScore: number | null;
  diversificationScore: number;
  topConcentrationPct: number;
  topConcentrationSymbol: string | null;
  /** Portfolio-level (not weighted-average) annualised volatility in %. */
  annualisedVolatilityPct: number | null;
  maxDrawdownPct: number | null;
  /** 1Y simple return; 3Y/5Y are CAGR. null when history is short. */
  return1yPct: number | null;
  return3yPct: number | null;
  return5yPct: number | null;
  /** False when price history is too short for portfolio-level risk stats. */
  riskDataSufficient?: boolean;
  /** Provenance of the underlying prices: DEMO (synthetic) / YAHOO (real). */
  dataSourceMix?: { demo: number; yahoo: number };
  sectorAllocation: SectorAllocation[];
  holdingCount: number;
}

export interface PortfolioView {
  portfolio: Portfolio;
  holdings: HoldingView[];
  metrics: PortfolioMetrics;
}

export type RiskBand = "Low" | "Moderate" | "High" | "Very High" | "Insufficient Data";

export interface StockRiskProfile {
  /** Annualised volatility in %; null when history is too short to estimate. */
  volatilityPct: number | null;
  maxDrawdownPct: number | null;
  return1yPct: number | null;
  return3yPct: number | null;
  return5yPct: number | null;
  riskBand: RiskBand;
  /** Weekly observations behind this profile (min-sample gate). */
  observations?: number;
}

export interface AdminStats {
  totalUsers: number;
  userRoleUsers: number;
  adminUsers: number;
  totalPortfolios: number;
  totalHoldings: number;
  totalTransactions: number;
  totalAlerts: number;
  totalStocks: number;
  stocksUsingRealData: number;
  lastMarketDataSync: string | null;
  lastMarketDataStatus: string | null;
}

export interface AdminUserQuery {
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface MarketDataSyncStatus {
  running: boolean;
  last: {
    id: string;
    triggerType: string;
    mode: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    stocksProcessed: number;
    pricesUpserted: number;
    fundamentalsUpdated: number;
    failures: number;
    errorMessage: string | null;
  } | null;
}

export type FitClassification = "Strong Fit" | "Reasonable Fit" | "Weak Fit" | "Poor Fit";

export interface BuySimulationResult {
  before: PortfolioMetrics;
  after: PortfolioMetrics;
  deltas: SimulationDelta[];
  fitScore: number;
  classification: FitClassification;
  reasons: string[];
}

export type SellRecommendation = "HOLD" | "REVIEW" | "CONSIDER REDUCING";

export interface SellSimulationResult {
  before: PortfolioMetrics;
  after: PortfolioMetrics;
  deltas: SimulationDelta[];
  proceeds: number;
  realisedPnl: number;
  recommendation: SellRecommendation;
  reasons: string[];
}
