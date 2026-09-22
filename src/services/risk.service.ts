/**
 * Quantitative risk + scenario services (Phase 4/5) — maps to
 * /api/intelligence/risk|analogues|scenarios. Backend verifies ownership.
 */
import { apiRequest } from "./api-client";

export interface RiskMetric {
  value: number | null;
  unit: string;
  available: boolean;
  reason: string | null;
}

export interface Contributor {
  stockId: string;
  symbol: string;
  sector: string;
  weightPct: number;
  riskContributionPctOfVol: number | null;
  pctContribution: number | null;
  marginalRisk: number | null;
  standaloneVolPct: number | null;
  ranking: "High" | "Moderate" | "Low" | null;
}

export interface RiskOverview {
  assumptions: {
    riskFreeRatePct: number;
    targetReturnPct: number;
    varConfidence: number;
    tradingDaysPerYear: number;
    modelVersion: string;
  };
  provenance: {
    dataSource: string;
    latestDataDate: string | null;
    windowDays: number | null;
    observationDays: number;
    holdings: number;
  };
  /** Owning portfolio identity echoed by the backend. */
  portfolioMeta: { portfolioId: string; name: string };
  portfolio: {
    volatilityPctAnn: RiskMetric;
    downsideDeviationPctAnn: RiskMetric;
    maxDrawdownPct: RiskMetric;
    drawdownDurationDays: RiskMetric;
    sharpe: RiskMetric;
    sortino: RiskMetric;
    calmar: RiskMetric;
    annualisedReturnPct: RiskMetric;
    var95Day1Pct: RiskMetric;
    var99Day1Pct: RiskMetric;
    cvar95Day1Pct: RiskMetric;
    beta: RiskMetric;
    alphaPctAnn: RiskMetric;
  };
  concentration: {
    largestWeightPct: number | null;
    top3Pct: number | null;
    top5Pct: number | null;
    hhi: number | null;
    effectiveN: number | null;
  };
  diversificationRatio: RiskMetric;
  correlation: {
    averagePairwise: number | null;
    highest: { a: string; b: string; correlation: number } | null;
    lowest: { a: string; b: string; correlation: number } | null;
    pairs: Array<{ a: string; b: string; correlation: number }>;
    clusters: Array<{ symbols: string[]; averageCorrelation: number }>;
    observationDays: number;
  } | null;
  contributors: Contributor[];
  drawdownSeries: Array<{ date: string; drawdownPct: number }>;
}

export interface PerformanceAttribution {
  provenance: { latestDataDate: string | null; windowDays: number; observationDays: number };
  portfolioReturnPct: number | null;
  contributors: Array<{ symbol: string; sector: string; weightPct: number; holdingReturnPct: number | null; contributionPctPoints: number | null; pnlInr: number | null }>;
  detractors: Array<{ symbol: string; sector: string; weightPct: number; holdingReturnPct: number | null; contributionPctPoints: number | null; pnlInr: number | null }>;
  bySector: Array<{ sector: string; contributionPctPoints: number | null }>;
  note: string;
}

export interface RiskHistory {
  rolling: {
    series: Array<{ date: string; volPctAnn: number; sharpe: number | null }>;
    trend: "INCREASING" | "DECREASING" | "STABLE" | "UNKNOWN";
  };
  provenance: { latestDataDate: string | null; observationDays: number };
  portfolio: { portfolioId: string; name: string };
}

export interface AnalogueResult {
  targetEventId: number;
  analogues: Array<{
    eventId: number;
    title: string;
    category: string;
    severity: number | null;
    direction: string | null;
    detectedAt: string;
    similarity: number;
    matchedOn: string[];
    affectedSymbols: string[];
    reaction: Array<{
      window: number;
      sampleSize: number;
      medianPct: number | null;
      meanPct: number | null;
      bestPct: number | null;
      worstPct: number | null;
      available: boolean;
      reason: string | null;
    }>;
  }>;
  quality: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  qualityReason: string;
  disclaimer: string;
}

export interface ScenarioShock {
  stockId?: number;
  sector?: string;
  shockPct: number;
}

export interface ScenarioImpact {
  baselineValue: number;
  scenarioValue: number;
  valueDelta: number;
  portfolioImpactPct: number;
  lines: Array<{ symbol: string; weightPct: number; shockPct: number; contributionPctPoints: number }>;
  bySector: Array<{ sector: string; weightPct: number; contributionPctPoints: number }>;
}

export interface StressRun {
  name: string;
  description: string;
  impact: ScenarioImpact;
}

export interface WhatIfResult {
  kind: "ADD_POSITION" | "REMOVE_POSITION" | "REBALANCE";
  baseline: { totalValue: number; concentration: { largestPct: number; top3Pct: number; hhi: number; effectiveN: number }; volatilityPctAnn: number | null };
  scenario: { totalValue: number; concentration: { largestPct: number; top3Pct: number; hhi: number; effectiveN: number }; volatilityPctAnn: number | null; newOrChangedPosition: { symbol: string; quantity: number; weightPct: number } | null };
  deltas: { valueDelta: number; hhiDelta: number; effectiveNDelta: number; largestWeightDeltaPct: number; volatilityDeltaPct: number | null };
  sectorShift: Array<{ sector: string; beforePct: number; afterPct: number }>;
  assumptions: string[];
  disclaimer: string;
  pricedAsOf: string | null;
}

export interface ScenarioComparison {
  baselineLabel: string;
  scenarios: Array<{ label: string; impactPct: number; valueAfter: number }>;
  current: { value: number; hhi: number | null; volatilityPctAnn: number | null };
  disclaimer: string;
}

export async function getRiskOverview(portfolioId: string | number): Promise<RiskOverview> {
  return apiRequest<RiskOverview>(`/intelligence/risk/overview?portfolioId=${portfolioId}`);
}

export async function getRiskAttribution(portfolioId: string | number): Promise<{ attribution: PerformanceAttribution }> {
  return apiRequest<{ attribution: PerformanceAttribution }>(`/intelligence/risk/attribution?portfolioId=${portfolioId}`);
}

export async function getRiskCorrelation(portfolioId: string | number): Promise<{ correlation: RiskOverview["correlation"]; provenance: { latestDataDate: string | null; observationDays: number } }> {
  return apiRequest(`/intelligence/risk/correlation?portfolioId=${portfolioId}`);
}

export async function getRiskHistory(portfolioId: string | number): Promise<RiskHistory> {
  return apiRequest<RiskHistory>(`/intelligence/risk/history?portfolioId=${portfolioId}`);
}

export async function getStressSuite(portfolioId: string | number): Promise<{ runs: StressRun[]; disclaimer: string }> {
  return apiRequest(`/intelligence/risk/stress?portfolioId=${portfolioId}`);
}

export async function getAnalogues(eventId: string | number): Promise<AnalogueResult> {
  return apiRequest<AnalogueResult>(`/intelligence/analogues/${eventId}`);
}

export async function analyzeScenario(portfolioId: string | number, shocks: ScenarioShock[]): Promise<{ impact: ScenarioImpact; disclaimer: string; pricedAsOf: string | null }> {
  return apiRequest("/intelligence/scenarios/analyze", { method: "POST", body: JSON.stringify({ portfolioId: Number(portfolioId), shocks }) });
}

export async function compareScenarios(portfolioId: string | number, scenarios: Array<{ label: string; shocks: ScenarioShock[] }>): Promise<ScenarioComparison> {
  return apiRequest("/intelligence/scenarios/compare", { method: "POST", body: JSON.stringify({ portfolioId: Number(portfolioId), scenarios }) });
}

export async function runWhatIf(body: { kind: "ADD_POSITION"; portfolioId: string | number; stockId: number; amount: number } | { kind: "REMOVE_POSITION"; portfolioId: string | number; stockId: number } | { kind: "REBALANCE"; portfolioId: string | number; stockId: number; targetWeightPct: number }): Promise<WhatIfResult> {
  return apiRequest("/intelligence/scenarios/what-if", {
    method: "POST",
    body: JSON.stringify({ ...body, portfolioId: Number(body.portfolioId) }),
  });
}

// ---------------------------------------------------------------------------
// Phase 6/7/8 — event intelligence, benchmark, snapshots, transaction performance
// ---------------------------------------------------------------------------

export interface SuggestedScenario {
  kind: "STOCK" | "SECTOR" | "MARKET";
  label: string;
  rationale: string;
  basis: "HISTORICAL_EVIDENCE" | "EVENT_CHARACTERISTICS" | "SYSTEM_STRESS_DEFAULT";
  shockPct: number;
  stockId?: number;
  symbol?: string;
  sector?: string;
}

export interface EventIntelligencePackage {
  modelVersion: string;
  event: { eventId: string; title: string; category: string; summary: string | null; detectedAt: string; severity: number | null; confidence: number | null; direction: string | null; status: string };
  affectedEntities: Array<{ stockId: string | null; symbol: string | null; entityName: string; relationshipType: string; matchConfidence: string | null; direction: string | null }>;
  affectedSectors: string[];
  myExposure: { ownedStockIds: string[]; watchlistStockIds: string[]; holdingsExposedValue: number | null; holdingsTotalValue: number | null; exposurePctOfPortfolio: number | null; reason: string | null };
  historicalAnalogues: AnalogueResult | null;
  suggestedScenarios: SuggestedScenario[];
  evidenceNote: string | null;
  disclaimer: string;
}

export async function getEventIntelligence(eventId: string | number, portfolioId?: string | number): Promise<EventIntelligencePackage> {
  const qs = portfolioId !== undefined ? `?portfolioId=${encodeURIComponent(portfolioId)}` : "";
  return apiRequest<EventIntelligencePackage>(`/intelligence/events/${eventId}/intelligence${qs}`);
}

export async function runEventScenario(eventId: string | number, portfolioId: string | number, shocks: ScenarioShock[]): Promise<{ impact: ScenarioImpact; pricedAsOf: string | null; disclaimer: string }> {
  return apiRequest(`/intelligence/events/${eventId}/scenario`, { method: "POST", body: JSON.stringify({ portfolioId, shocks }), headers: { "Content-Type": "application/json" } });
}

export interface PortfolioIntelligenceSummary {
  modelVersion: string;
  portfolioId: string;
  portfolioName: string;
  generatedAt: string;
  statements: Array<{ text: string; evidence: string }>;
  provenance: { eventsConsidered: number; recentEventWindowDays: number; holdings: number };
}

export async function getPortfolioIntelligenceSummary(portfolioId: string | number): Promise<PortfolioIntelligenceSummary> {
  return apiRequest<PortfolioIntelligenceSummary>(`/intelligence/portfolio-summary?portfolioId=${encodeURIComponent(portfolioId)}`);
}

export interface BenchmarkPerformance {
  modelVersion: string;
  benchmark: { symbol: string; name: string } | null;
  provenance: { observationCount: number; firstDate: string | null; lastDate: string | null; dataSource: string; riskFreeRatePct: number; annualisation: string };
  metrics: {
    benchmarkReturnPctAnn: RiskMetric; portfolioReturnPctAnn: RiskMetric; excessReturnPctAnn: RiskMetric;
    beta: RiskMetric; alphaPctAnn: RiskMetric; trackingErrorPctAnn: RiskMetric; informationRatio: RiskMetric;
    upsideCapturePct: RiskMetric; downsideCapturePct: RiskMetric;
  };
}

export async function getBenchmarkPerformance(portfolioId: string | number): Promise<BenchmarkPerformance> {
  const data = await apiRequest<{ performance: BenchmarkPerformance }>(`/intelligence/risk/benchmark?portfolioId=${encodeURIComponent(portfolioId)}`);
  return data.performance;
}

export interface RiskSnapshot {
  snapshotDate: string; calculationVersion: string; volatilityPctAnn: number | null; sharpe: number | null;
  maxDrawdownPct: number | null; var95Day1Pct: number | null; beta: number | null; alphaPctAnn: number | null;
  hhi: number | null; effectivePositions: number | null; diversificationRatio: number | null;
  benchmarkSymbol: string | null; observationCount: number | null; dataSource: string | null; pricedAsOf: string | null;
}

export async function getRiskSnapshots(portfolioId: string | number): Promise<RiskSnapshot[]> {
  const data = await apiRequest<{ snapshots: RiskSnapshot[] }>(`/intelligence/risk/snapshots?portfolioId=${encodeURIComponent(portfolioId)}`);
  return data.snapshots;
}

export interface TxPerformance {
  modelVersion: string;
  realized: Array<{ date: string; stockId: string; qty: number; proceeds: number; cost: number; pnl: number }>;
  realizedPnl: number;
  unrealizedPnl: number | null;
  totalPnl: number | null;
  turnover: { buyValue: number | null; sellValue: number | null; totalTurnover: number | null; transactionCount: number; buyCount: number; sellCount: number; averageHoldingDays: number | null };
  holdingPeriods: Array<{ stockId: string; symbol: string; sector: string; firstPurchaseDate: string | null; holdingDays: number | null; investedCapital: number | null; currentValue: number | null; unrealizedPnl: number | null; returnPct: number | null; annualizedReturnPct: number | null; note: string | null }>;
  attribution: {
    view: string;
    byStock: Array<{ stockId: string; symbol: string; realizedPnl: number; unrealizedPnl: number | null; totalPnl: number | null }>;
    bySector: Array<{ sector: string; realizedPnl: number; unrealizedPnl: number | null; totalPnl: number | null }>;
  };
  limitations: string[];
}

export async function getTxPerformance(portfolioId: string | number): Promise<TxPerformance> {
  const data = await apiRequest<{ performance: TxPerformance }>(`/intelligence/performance/transactions?portfolioId=${encodeURIComponent(portfolioId)}`);
  return data.performance;
}

export interface HealthScore {
  version: string;
  label: string;
  score: number | null;
  band: "STRONG" | "MODERATE" | "CONCENTRATED-RISK" | "N/A";
  components: Array<{ name: string; weight: number; score: number | null; detail: string }>;
  note: string;
}

export async function getHealthScore(portfolioId: string | number): Promise<HealthScore> {
  const data = await apiRequest<{ health: HealthScore }>(`/intelligence/health-score?portfolioId=${encodeURIComponent(portfolioId)}`);
  return data.health;
}
