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
  /** Latest price available in the demo dataset (not a live market quote). */
  lastPrice: number;
  previousClose: number;
  marketCapCr: number;
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
}

export interface AuditLogEntry {
  id: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  createdAt: string;
  ip: string;
}

/* ---------- Analytics engine outputs (computed, never AI-generated) ---------- */

export interface HoldingView extends Holding {
  stock: Stock;
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
  riskScore: number;
  diversificationScore: number;
  topConcentrationPct: number;
  topConcentrationSymbol: string | null;
  annualisedVolatilityPct: number;
  sectorAllocation: SectorAllocation[];
  holdingCount: number;
}

export interface PortfolioView {
  portfolio: Portfolio;
  holdings: HoldingView[];
  metrics: PortfolioMetrics;
}

export interface StockRiskProfile {
  volatilityPct: number;
  maxDrawdownPct: number;
  return1yPct: number | null;
  return3yPct: number | null;
  return5yPct: number | null;
  riskBand: "Low" | "Moderate" | "High" | "Very High";
}

export interface SimulationDelta {
  label: string;
  before: number;
  after: number;
  unit: "score" | "pct" | "currency";
  betterWhenLower?: boolean;
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
