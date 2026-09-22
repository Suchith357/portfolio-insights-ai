import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Activity, FlaskConical, Gauge, History, Scale } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarketDataBadge, SectionHeader, SeverityBadge, StatCard } from "@/components/common/data-display";
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/common/states";
import { formatCurrencyOrNull, formatDate } from "@/lib/format";
import { useAuth } from "@/hooks/use-auth";
import * as portfolioService from "@/services/portfolio.service";
import * as riskService from "@/services/risk.service";
import type { RiskMetric, StressRun, WhatIfResult, ScenarioComparison } from "@/services/risk.service";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/risk")({
  head: () => ({
    meta: [
      { title: "Risk Diagnosis — PortfolioIQ" },
      {
        name: "description",
        content:
          "Explainable quantitative risk: volatility, VaR, CVaR, Sharpe, risk contribution per holding, performance attribution, correlation clusters and what-if scenario analysis.",
      },
      { property: "og:title", content: "Risk Diagnosis — PortfolioIQ" },
      {
        property: "og:description",
        content: "WHY is my portfolio risky? Which holdings drive it? Where do returns come from? Evidence-based answers, not predictions.",
      },
    ],
  }),
  component: RiskPage,
});

const DISCLAIMER = "Descriptive analytics over historical stored prices. Nothing on this page predicts future returns or constitutes investment advice.";

function fmtMetric(m: RiskMetric | undefined, digits = 1): string {
  if (!m || !m.available || m.value === null) return "N/A";
  return m.value.toFixed(digits);
}

function MetricCard({ label, metric: m, digits = 1, explanation }: { label: string; metric: RiskMetric | undefined; digits?: number; explanation: string }) {
  return (
    <StatCard
      label={label}
      value={fmtMetric(m, digits)}
      sub={m && !m.available ? m.reason ?? "Unavailable" : explanation}
      tone={m?.available && m.value !== null && m.value < 0 ? "loss" : "default"}
    />
  );
}

function RiskPage() {
  const { user } = useAuth();
  const portfolios = useQuery({
    queryKey: ["portfolios", user?.id],
    queryFn: () => portfolioService.listPortfolios(user!.id),
    enabled: !!user,
  });
  const [portfolioId, setPortfolioId] = useState("");
  const activeId = portfolioId || portfolios.data?.[0]?.id || "";

  const overview = useQuery({
    queryKey: ["risk", "overview", activeId],
    queryFn: () => riskService.getRiskOverview(activeId),
    enabled: !!activeId,
  });
  const attribution = useQuery({
    queryKey: ["risk", "attribution", activeId],
    queryFn: () => riskService.getRiskAttribution(activeId),
    enabled: !!activeId,
  });
  const correlation = useQuery({
    queryKey: ["risk", "correlation", activeId],
    queryFn: () => riskService.getRiskCorrelation(activeId),
    enabled: !!activeId,
  });
  const history = useQuery({
    queryKey: ["risk", "history", activeId],
    queryFn: () => riskService.getRiskHistory(activeId),
    enabled: !!activeId,
  });
  const stress = useQuery({
    queryKey: ["risk", "stress", activeId],
    queryFn: () => riskService.getStressSuite(activeId),
    enabled: !!activeId,
  });
  // Phase 7/8: benchmark-relative performance, persistent snapshots, transaction-true P&L, health score.
  const benchmark = useQuery({
    queryKey: ["risk", "benchmark", activeId],
    queryFn: () => riskService.getBenchmarkPerformance(activeId),
    enabled: !!activeId,
  });
  const snapshots = useQuery({
    queryKey: ["risk", "snapshots", activeId],
    queryFn: () => riskService.getRiskSnapshots(activeId),
    enabled: !!activeId,
  });
  const txPerf = useQuery({
    queryKey: ["risk", "txperf", activeId],
    queryFn: () => riskService.getTxPerformance(activeId),
    enabled: !!activeId,
  });
  const health = useQuery({
    queryKey: ["risk", "health", activeId],
    queryFn: () => riskService.getHealthScore(activeId),
    enabled: !!activeId,
  });

  const data = overview.data;
  const provenance = data?.provenance;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Gauge className="h-6 w-6 text-primary" aria-hidden />
            Risk Diagnosis
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            WHY is my portfolio risky — and which holdings are responsible? Every figure is computed from stored daily
            closes with date-aligned covariance maths. Model {data?.assumptions.modelVersion ?? "—"} · risk-free
            assumption {data?.assumptions.riskFreeRatePct ?? "—"}% p.a. · VaR confidence{" "}
            {data ? Math.round(data.assumptions.varConfidence * 100) : "—"}%.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={activeId} onValueChange={setPortfolioId}>
            <SelectTrigger className="w-56" aria-label="Select portfolio">
              <SelectValue placeholder="Select portfolio" />
            </SelectTrigger>
            <SelectContent>
              {(portfolios.data ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <MarketDataBadge />
        </div>
      </div>

      {provenance && (
        <p className="text-xs text-muted-foreground">
          Calculated from {provenance.dataSource} daily closes through {provenance.latestDataDate ?? "—"} ·{" "}
          {provenance.observationDays} aligned observations
          {provenance.windowDays ? ` over a ${provenance.windowDays}-trading-day window` : ""} · {provenance.holdings}{" "}
          holding{provenance.holdings === 1 ? "" : "s"}
          {provenance.latestDataDate && provenance.latestDataDate < new Date().toISOString().slice(0, 10)
            ? " — data is stale; latest available close was used."
            : "."}
        </p>
      )}

      {overview.isLoading || portfolios.isLoading ? (
        <CardsSkeleton count={4} />
      ) : overview.isError ? (
        <ErrorState title="We couldn't load the risk engine" onRetry={() => overview.refetch()} />
      ) : !data ? (
        <EmptyState title="Select a portfolio" description="Choose a portfolio to diagnose its risk." />
      ) : !data.portfolio.volatilityPctAnn.available ? (
        <EmptyState
          icon={<Gauge className="h-10 w-10" aria-hidden />}
          title="Not enough data for this portfolio"
          description={data.portfolio.volatilityPctAnn.reason ?? "Insufficient aligned price history."}
        />
      ) : (
        <>
          {/* ---------------- TOTAL RISK ---------------- */}
          <section className="space-y-3">
            <SectionHeader
              title="Total risk"
              description="Covariance-based portfolio volatility (wᵀΣw) — never a weighted average of individual volatilities."
            />
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard label="Volatility (ann.)" metric={data.portfolio.volatilityPctAnn} explanation="√(wᵀΣw) annualised ×√252" />
              <MetricCard label="Downside deviation" metric={data.portfolio.downsideDeviationPctAnn} explanation="Volatility of returns below 0% daily target" />
              <MetricCard label="Max drawdown" metric={data.portfolio.maxDrawdownPct} explanation="Worst peak-to-trough fall" />
              <MetricCard label="Drawdown recovery" metric={data.portfolio.drawdownDurationDays} digits={0} explanation="Trading days from trough back to peak" />
              <MetricCard label="Sharpe ratio" metric={data.portfolio.sharpe} digits={2} explanation={`Excess return over ${data.assumptions.riskFreeRatePct}% p.a. assumption ÷ volatility`} />
              <MetricCard label="Sortino ratio" metric={data.portfolio.sortino} digits={2} explanation="Excess return ÷ downside deviation" />
              <MetricCard label="Calmar ratio" metric={data.portfolio.calmar} digits={2} explanation="Annualised return ÷ |max drawdown|" />
              <MetricCard label="Annualised return" metric={data.portfolio.annualisedReturnPct} explanation="Mean daily return × 252" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard label="95% 1-day historical VaR" metric={data.portfolio.var95Day1Pct} explanation="Worst daily loss at the 5th percentile of history — not a guaranteed maximum" />
              <MetricCard label="99% 1-day historical VaR" metric={data.portfolio.var99Day1Pct} explanation="Worst daily loss at the 1st percentile" />
              <MetricCard label="CVaR / Expected shortfall" metric={data.portfolio.cvar95Day1Pct} explanation="Average loss in the worst 5% of days" />
              <MetricCard label="Diversification ratio" metric={data.diversificationRatio} digits={2} explanation="Weighted standalone vol ÷ portfolio vol (>1 = diversification benefit)" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="Largest holding"
                value={data.concentration.largestWeightPct === null ? "N/A" : `${data.concentration.largestWeightPct.toFixed(1)}%`}
                sub="Top position weight"
              />
              <StatCard label="Top 3 concentration" value={data.concentration.top3Pct === null ? "N/A" : `${data.concentration.top3Pct.toFixed(1)}%`} />
              <StatCard label="HHI" value={data.concentration.hhi === null ? "N/A" : data.concentration.hhi.toFixed(3)} sub="Σ weight² — higher = more concentrated" />
              <StatCard label="Effective holdings" value={data.concentration.effectiveN === null ? "N/A" : data.concentration.effectiveN.toFixed(1)} sub="1 / HHI" />
            </div>
            <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">Beta / alpha: </span>
              {data.portfolio.beta.reason ?? "Unavailable"} The scenario lab below works entirely from your own stored
              holdings and prices, so it remains fully available.
            </p>
          </section>

          {/* ---------------- CONTRIBUTORS ---------------- */}
          <section className="space-y-3">
            <SectionHeader
              title="Why is my portfolio risky? — risk contributors"
              description="Percentage contribution to total volatility (exact Euler decomposition wᵢ(Σw)ᵢ/σ²). Contribution ≠ allocation: a small weight can drive large risk."
            />
            <div className="panel overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Stock</th>
                    <th className="px-4 py-3 font-medium">Allocation</th>
                    <th className="px-4 py-3 font-medium">% of total risk</th>
                    <th className="px-4 py-3 font-medium">Risk contribution (σ points)</th>
                    <th className="px-4 py-3 font-medium">Marginal risk</th>
                    <th className="px-4 py-3 font-medium">Standalone vol</th>
                    <th className="px-4 py-3 font-medium">Level</th>
                  </tr>
                </thead>
                <tbody>
                  {data.contributors.map((c) => (
                    <tr key={c.stockId} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-3">
                        <span className="num font-medium">{c.symbol}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{c.sector}</span>
                      </td>
                      <td className="num px-4 py-3">{c.weightPct.toFixed(1)}%</td>
                      <td className="num px-4 py-3 font-semibold">{c.pctContribution === null ? "N/A" : `${c.pctContribution.toFixed(1)}%`}</td>
                      <td className="num px-4 py-3">{c.riskContributionPctOfVol === null ? "N/A" : `${c.riskContributionPctOfVol.toFixed(2)}%`}</td>
                      <td className="num px-4 py-3">{c.marginalRisk === null ? "N/A" : c.marginalRisk.toFixed(3)}</td>
                      <td className="num px-4 py-3">{c.standaloneVolPct === null ? "N/A" : `${c.standaloneVolPct.toFixed(1)}%`}</td>
                      <td className="px-4 py-3">
                        {c.ranking && (
                          <Badge variant="outline" className={cn("text-[10px]", c.ranking === "High" ? "border-warning/50 text-warning" : c.ranking === "Moderate" ? "border-info/50 text-info" : "text-muted-foreground")}>
                            {c.ranking}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              Contribution column sums to ~100%. Marginal risk = ∂σ/∂wᵢ (annualised) — how much total volatility moves
              per unit change in that position's weight.
            </p>
          </section>

          {/* ---------------- CORRELATION ---------------- */}
          <section className="space-y-3">
            <SectionHeader
              title="Correlation & diversification"
              description="Date-aligned pairwise correlations of daily returns. High-correlation clusters mean several holdings tend to move together."
            />
            {correlation.data?.correlation ? (
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="panel space-y-3 p-4">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Average pairwise</p>
                      <p className="num text-lg font-semibold">{correlation.data.correlation.averagePairwise?.toFixed(2) ?? "N/A"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Observation days</p>
                      <p className="num text-lg font-semibold">{correlation.data.provenance.observationDays}</p>
                    </div>
                  </div>
                  {correlation.data.correlation.highest && (
                    <p className="text-sm">
                      <span className="text-muted-foreground">Strongest pair: </span>
                      <span className="num font-medium">
                        {correlation.data.correlation.highest.a} / {correlation.data.correlation.highest.b}
                      </span>{" "}
                      <span className="num">{correlation.data.correlation.highest.correlation.toFixed(2)}</span>
                    </p>
                  )}
                  {correlation.data.correlation.clusters.map((cl) => (
                    <div key={cl.symbols.join("-")} className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                      <span className="font-semibold">High-correlation cluster ({cl.symbols.length} holdings, avg {cl.averageCorrelation.toFixed(2)}): </span>
                      {cl.symbols.join(", ")}
                    </div>
                  ))}
                </div>
                <div className="panel p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Top correlated pairs</p>
                  <ul className="mt-2 space-y-1.5">
                    {correlation.data.correlation.pairs.slice(0, 8).map((p) => (
                      <li key={`${p.a}-${p.b}`} className="flex items-center gap-3 text-sm">
                        <span className="num w-40 truncate">
                          {p.a} / {p.b}
                        </span>
                        <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
                          <div className={cn("h-full", p.correlation >= 0.7 ? "bg-loss" : p.correlation >= 0.4 ? "bg-warning" : "bg-info")} style={{ width: `${Math.min(100, Math.abs(p.correlation) * 100)}%` }} />
                        </div>
                        <span className="num w-12 text-right">{p.correlation.toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <EmptyState title="Correlation unavailable" description="Fewer than 30 aligned daily observations or fewer than two holdings." />
            )}
          </section>

          {/* ---------------- TABS: attribution / history / stress ---------------- */}
          <Tabs defaultValue="attribution">
            <TabsList className="flex-wrap">
              <TabsTrigger value="attribution">Performance attribution</TabsTrigger>
              <TabsTrigger value="history">Risk trend</TabsTrigger>
              <TabsTrigger value="benchmark">Benchmark</TabsTrigger>
              <TabsTrigger value="snapshots">Risk history</TabsTrigger>
              <TabsTrigger value="transactions">Transaction performance</TabsTrigger>
              <TabsTrigger value="lab">Scenario Lab</TabsTrigger>
            </TabsList>

            {/* ---------------- Phase 8: health score ---------------- */}
            <TabsContent value="attribution" className="mt-4">
              {health.isLoading ? (
                <CardsSkeleton count={1} />
              ) : health.isError || !health.data ? (
                <ErrorState title="Health score failed" onRetry={() => health.refetch()} />
              ) : (
                <div className="panel mb-4 p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">{health.data.label}</p>
                    <Badge variant={health.data.band === "STRONG" ? "default" : health.data.band === "MODERATE" ? "secondary" : "destructive"}>
                      {health.data.band}
                    </Badge>
                    <span className="num text-2xl font-semibold">{health.data.score === null ? "N/A" : health.data.score.toFixed(1)}</span>
                    <span className="text-xs text-muted-foreground">version {health.data.version}</span>
                  </div>
                  <ul className="mt-3 space-y-1.5">
                    {health.data.components.map((c) => (
                      <li key={c.name} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span>
                          <span className="font-medium">{c.name}</span>
                          <span className="ml-2 text-xs text-muted-foreground">weight {(c.weight * 100).toFixed(0)}%</span>
                        </span>
                        <span className="num text-muted-foreground">{c.score === null ? "N/A" : c.score.toFixed(2)}</span>
                        <span className="w-full text-xs text-muted-foreground sm:w-auto sm:flex-1 sm:text-right">{c.detail}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-xs text-muted-foreground">{health.data.note}</p>
                </div>
              )}
            </TabsContent>

            <TabsContent value="attribution" className="mt-4 space-y-4">
              {attribution.isLoading ? (
                <CardsSkeleton count={2} />
              ) : attribution.isError || !attribution.data ? (
                <ErrorState title="Attribution failed" onRetry={() => attribution.refetch()} />
              ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="panel p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Top contributors</p>
                    {attribution.data.attribution.contributors.length === 0 ? (
                      <p className="mt-2 text-sm text-muted-foreground">No positive contributors in this window.</p>
                    ) : (
                      <ul className="mt-2 space-y-1.5">
                        {attribution.data.attribution.contributors.map((r) => (
                          <li key={r.symbol} className="flex items-center justify-between text-sm">
                            <span className="num font-medium">{r.symbol}</span>
                            <span className="num text-gain">
                              +{(r.contributionPctPoints ?? 0).toFixed(1)} pts
                              <span className="ml-2 text-xs text-muted-foreground">{formatCurrencyOrNull(r.pnlInr)}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="panel p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Top detractors</p>
                    {attribution.data.attribution.detractors.length === 0 ? (
                      <p className="mt-2 text-sm text-muted-foreground">No detractors in this window.</p>
                    ) : (
                      <ul className="mt-2 space-y-1.5">
                        {attribution.data.attribution.detractors.map((r) => (
                          <li key={r.symbol} className="flex items-center justify-between text-sm">
                            <span className="num font-medium">{r.symbol}</span>
                            <span className="num text-loss">
                              {(r.contributionPctPoints ?? 0).toFixed(1)} pts
                              <span className="ml-2 text-xs text-muted-foreground">{formatCurrencyOrNull(r.pnlInr)}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="panel p-4 lg:col-span-2">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">By sector</p>
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {attribution.data.attribution.bySector.map((s) => (
                        <li key={s.sector} className="rounded-md bg-muted/40 px-3 py-1.5 text-xs">
                          {s.sector}: <span className={cn("num font-semibold", (s.contributionPctPoints ?? 0) >= 0 ? "text-gain" : "text-loss")}>
                            {(s.contributionPctPoints ?? 0) >= 0 ? "+" : ""}
                            {(s.contributionPctPoints ?? 0).toFixed(1)} pts
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-3 text-[11px] text-muted-foreground">{attribution.data.attribution.note}</p>
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="history" className="mt-4">
              {history.isLoading ? (
                <CardsSkeleton count={1} />
              ) : history.isError || !history.data ? (
                <ErrorState title="Risk history failed" onRetry={() => history.refetch()} />
              ) : history.data.rolling.series.length === 0 ? (
                <EmptyState title="Not enough history for rolling risk" description="At least 40 aligned daily observations are required." />
              ) : (
                <div className="panel space-y-3 p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">30-day rolling volatility</p>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px]",
                        history.data.rolling.trend === "INCREASING" ? "border-warning/50 text-warning" : history.data.rolling.trend === "DECREASING" ? "border-gain/40 text-gain" : "text-muted-foreground",
                      )}
                    >
                      {history.data.rolling.trend}
                    </Badge>
                  </div>
                  <div className="flex h-32 items-end gap-0.5">
                    {history.data.rolling.series.map((s) => {
                      const max = Math.max(...history.data!.rolling.series.map((x) => x.volPctAnn));
                      return (
                        <div key={s.date} className="group relative flex-1" title={`${s.date}: ${s.volPctAnn}%`}>
                          <div className={cn("rounded-t", history.data!.rolling.trend === "INCREASING" ? "bg-warning/70" : "bg-info/70")} style={{ height: `${Math.max(4, (s.volPctAnn / (max || 1)) * 120)}px` }} />
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Trend compares the first and second half of the rolling series (10% band). Based on{" "}
                    {history.data.provenance.observationDays} aligned observations through {history.data.provenance.latestDataDate}.
                  </p>
                </div>
              )}
            </TabsContent>

            {/* ---------------- Phase 7: benchmark ---------------- */}
            <TabsContent value="benchmark" className="mt-4">
              {benchmark.isLoading ? (
                <CardsSkeleton count={2} />
              ) : benchmark.isError || !benchmark.data ? (
                <ErrorState title="Benchmark performance failed" onRetry={() => benchmark.refetch()} />
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant="outline">vs {benchmark.data.benchmark?.symbol ?? "no benchmark"}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {benchmark.data.provenance.observationCount} paired daily observations through {benchmark.data.provenance.lastDate} · source {benchmark.data.provenance.dataSource} · risk-free {benchmark.data.provenance.riskFreeRatePct}% assumption · {benchmark.data.modelVersion}
                    </span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {([
                      ["Beta", benchmark.data.metrics.beta, "Cov(Rp,Rm)/Var(Rm) vs NIFTY daily returns."],
                      ["Alpha (Jensen)", benchmark.data.metrics.alphaPctAnn, "Rp − [Rf + β(Rm − Rf)], annualised."],
                      ["Excess return", benchmark.data.metrics.excessReturnPctAnn, "Portfolio return minus benchmark return."],
                      ["Tracking error", benchmark.data.metrics.trackingErrorPctAnn, "Std-dev of active (portfolio − benchmark) daily returns."],
                      ["Information ratio", benchmark.data.metrics.informationRatio, "Excess return / tracking error."],
                      ["Upside capture", benchmark.data.metrics.upsideCapturePct, "Average portfolio return on benchmark up-days."],
                      ["Downside capture", benchmark.data.metrics.downsideCapturePct, "Average portfolio return on benchmark down-days."],
                    ] as const).map(([label, m, expl]) => (
                      <MetricCard key={label} label={label} metric={m as RiskMetric} explanation={expl} />
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Current-holdings view paired to the benchmark by exact date. Paired observations require both series to share the trading day — missing benchmark days reduce coverage.
                  </p>
                </div>
              )}
            </TabsContent>

            {/* ---------------- Phase 7: persistent snapshots ---------------- */}
            <TabsContent value="snapshots" className="mt-4">
              {snapshots.isLoading ? (
                <CardsSkeleton count={1} />
              ) : snapshots.isError || !snapshots.data ? (
                <ErrorState title="Risk history failed" onRetry={() => snapshots.refetch()} />
              ) : snapshots.data.length === 0 ? (
                <EmptyState
                  title="No stored snapshots yet"
                  description="A daily job records one snapshot per portfolio (idempotent, version risk-v1). Check back after the first run — historical rows are never overwritten."
                />
              ) : (
                <div className="panel space-y-3 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Stored daily risk snapshots</p>
                    <Badge variant="outline">{snapshots.data.length} rows · version risk-v1</Badge>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <th className="py-1.5 pr-3">Date</th>
                          <th className="py-1.5 pr-3">Vol %</th>
                          <th className="py-1.5 pr-3">Sharpe</th>
                          <th className="py-1.5 pr-3">MaxDD %</th>
                          <th className="py-1.5 pr-3">VaR95 %</th>
                          <th className="py-1.5 pr-3">Beta</th>
                          <th className="py-1.5 pr-3">HHI</th>
                          <th className="py-1.5 pr-3">Obs</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...snapshots.data].reverse().slice(0, 30).map((s) => (
                          <tr key={s.snapshotDate} className="border-t border-border/40">
                            <td className="py-1.5 pr-3 num">{s.snapshotDate}</td>
                            <td className="py-1.5 pr-3 num">{s.volatilityPctAnn === null ? "N/A" : s.volatilityPctAnn.toFixed(1)}</td>
                            <td className="py-1.5 pr-3 num">{s.sharpe === null ? "N/A" : s.sharpe.toFixed(2)}</td>
                            <td className="py-1.5 pr-3 num">{s.maxDrawdownPct === null ? "N/A" : s.maxDrawdownPct.toFixed(1)}</td>
                            <td className="py-1.5 pr-3 num">{s.var95Day1Pct === null ? "N/A" : s.var95Day1Pct.toFixed(2)}</td>
                            <td className="py-1.5 pr-3 num">{s.beta === null ? "N/A" : s.beta.toFixed(2)}</td>
                            <td className="py-1.5 pr-3 num">{s.hhi === null ? "N/A" : s.hhi.toFixed(3)}</td>
                            <td className="py-1.5 pr-3 num">{s.observationCount ?? "N/A"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-[11px] text-muted-foreground">Snapshots are derived records — historical rows are never overwritten or deleted. Beta/alpha populate once benchmark history exists.</p>
                </div>
              )}
            </TabsContent>

            {/* ---------------- Phase 8: transaction-true performance ---------------- */}
            <TabsContent value="transactions" className="mt-4">
              {txPerf.isLoading ? (
                <CardsSkeleton count={2} />
              ) : txPerf.isError || !txPerf.data ? (
                <ErrorState title="Transaction performance failed" onRetry={() => txPerf.refetch()} />
              ) : (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <StatCard label="Realized P&L (FIFO)" value={formatCurrencyOrNull(txPerf.data.realizedPnl) ?? "N/A"} sub={`${txPerf.data.realized.length} closed sale(s), transaction-true`} tone={txPerf.data.realizedPnl >= 0 ? "gain" : "loss"} />
                    <StatCard label="Unrealized P&L" value={txPerf.data.unrealizedPnl === null ? "N/A" : formatCurrencyOrNull(txPerf.data.unrealizedPnl) ?? "N/A"} sub="Current holdings at avg buy price vs latest close" tone={(txPerf.data.unrealizedPnl ?? 0) >= 0 ? "gain" : "loss"} />
                    <StatCard label="Total P&L" value={txPerf.data.totalPnl === null ? "N/A" : formatCurrencyOrNull(txPerf.data.totalPnl) ?? "N/A"} sub={txPerf.data.totalPnl === null ? "Partial — some holdings lack stored prices" : "Realized + unrealized"} tone={(txPerf.data.totalPnl ?? 0) >= 0 ? "gain" : "loss"} />
                  </div>
                  <div className="panel p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Turnover · {txPerf.data.turnover.transactionCount} transactions ({txPerf.data.turnover.buyCount} buys / {txPerf.data.turnover.sellCount} sells)</p>
                    <div className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
                      <p>Buy value: <span className="num">{formatCurrencyOrNull(txPerf.data.turnover.buyValue) ?? "N/A"}</span></p>
                      <p>Sell value: <span className="num">{formatCurrencyOrNull(txPerf.data.turnover.sellValue) ?? "N/A"}</span></p>
                      <p>Total turnover: <span className="num">{formatCurrencyOrNull(txPerf.data.turnover.totalTurnover) ?? "N/A"}</span></p>
                    </div>
                  </div>
                  <div className="panel p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Holding periods</p>
                    {txPerf.data.holdingPeriods.length === 0 ? (
                      <p className="mt-2 text-sm text-muted-foreground">No holdings.</p>
                    ) : (
                      <ul className="mt-2 space-y-1.5 text-sm">
                        {txPerf.data.holdingPeriods.map((h) => (
                          <li key={h.stockId} className="flex flex-wrap items-center justify-between gap-2">
                            <span className="num font-medium">{h.symbol}</span>
                            <span className="text-xs text-muted-foreground">
                              first buy {h.firstPurchaseDate ?? "N/A"} · {h.holdingDays === null ? "duration N/A" : `${h.holdingDays}d`} · {h.note ?? ""}
                            </span>
                            <span className={cn("num", (h.returnPct ?? 0) >= 0 ? "text-gain" : "text-loss")}>{h.returnPct === null ? "N/A" : `${h.returnPct > 0 ? "+" : ""}${h.returnPct}%`}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="panel p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">{txPerf.data.attribution.view}</p>
                    <ul className="mt-2 space-y-1.5 text-sm">
                      {txPerf.data.attribution.bySector.map((s) => (
                        <li key={s.sector} className="flex items-center justify-between">
                          <span>{s.sector}</span>
                          <span className="num">realized {s.realizedPnl >= 0 ? "+" : ""}{s.realizedPnl} · unrealized {s.unrealizedPnl === null ? "N/A" : `${s.unrealizedPnl >= 0 ? "+" : ""}${s.unrealizedPnl}`}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="panel p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Limitations</p>
                    <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-muted-foreground">
                      {txPerf.data.limitations.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="lab" className="mt-4">
              <ScenarioLab portfolioId={activeId} stressRuns={stress.data?.runs ?? null} stressLoading={stress.isLoading} stressError={stress.isError} />
            </TabsContent>
          </Tabs>

          <p className="text-xs text-muted-foreground">{DISCLAIMER}</p>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Scenario Lab (Phase 5B)                                                    */
/* -------------------------------------------------------------------------- */

function ScenarioLab({ portfolioId, stressRuns, stressLoading, stressError }: { portfolioId: string; stressRuns: StressRun[] | null; stressLoading: boolean; stressError: boolean }) {
  const holdingsQuery = useQuery({
    queryKey: ["risk", "overview", portfolioId],
    queryFn: () => riskService.getRiskOverview(portfolioId),
    enabled: !!portfolioId,
  });
  const contributors = holdingsQuery.data?.contributors ?? [];
  const [shockSymbol, setShockSymbol] = useState("");
  const [shockPct, setShockPct] = useState("-20");
  const [amount, setAmount] = useState("50000");
  const [whatIfResult, setWhatIfResult] = useState<WhatIfResult | null>(null);
  const [comparison, setComparison] = useState<ScenarioComparison | null>(null);
  const [labError, setLabError] = useState<string | null>(null);

  const analyze = useMutation({
    mutationFn: () => {
      const c = contributors.find((x) => x.symbol === shockSymbol);
      const pct = Number(shockPct);
      if (!c) throw new Error("Select a holding to shock.");
      if (!Number.isFinite(pct) || pct < -100 || pct > 500) throw new Error("Shock must be between -100% and +500%.");
      return riskService.analyzeScenario(portfolioId, [{ stockId: Number(c.stockId), shockPct: pct }]);
    },
    onSuccess: () => setLabError(null),
    onError: (e: Error) => setLabError(e.message),
  });

  const whatIf = useMutation({
    mutationFn: () => {
      const c = contributors.find((x) => x.symbol === shockSymbol);
      const amt = Number(amount);
      if (!c) throw new Error("Select a holding.");
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Amount must be greater than 0.");
      return riskService.runWhatIf({ kind: "ADD_POSITION", portfolioId, stockId: Number(c.stockId), amount: amt });
    },
    onSuccess: (r) => {
      setWhatIfResult(r);
      setLabError(null);
    },
    onError: (e: Error) => setLabError(e.message),
  });

  const compare = useMutation({
    mutationFn: () => {
      const c = contributors.find((x) => x.symbol === shockSymbol);
      if (!c) throw new Error("Select a holding.");
      return riskService.compareScenarios(portfolioId, [
        { label: "Mild shock −10%", shocks: [{ stockId: Number(c.stockId), shockPct: -10 }] },
        { label: `Severe shock ${shockPct}%`, shocks: [{ stockId: Number(c.stockId), shockPct: Number(shockPct) }] },
      ]);
    },
    onSuccess: (r) => {
      setComparison(r);
      setLabError(null);
    },
    onError: (e: Error) => setLabError(e.message),
  });

  const latest = analyze.data?.impact ?? null;
  const pricedAsOf = analyze.data?.pricedAsOf ?? whatIfResult?.pricedAsOf ?? null;

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Scenario Lab"
        description="Hypothetical what-if analysis on your own holdings. Scenario analysis is hypothetical and does not predict future returns."
      />
      <div className="panel grid gap-3 p-4 sm:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="lab-stock">Holding</Label>
          <Select value={shockSymbol} onValueChange={setShockSymbol}>
            <SelectTrigger id="lab-stock">
              <SelectValue placeholder="Select holding" />
            </SelectTrigger>
            <SelectContent>
              {contributors.map((c) => (
                <SelectItem key={c.stockId} value={c.symbol}>
                  {c.symbol} ({c.weightPct.toFixed(1)}%)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lab-shock">Shock %</Label>
          <Input id="lab-shock" inputMode="numeric" value={shockPct} onChange={(e) => setShockPct(e.target.value)} aria-invalid={!!labError} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lab-amount">What-if amount (₹)</Label>
          <Input id="lab-amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="flex items-end gap-2">
          <Button size="sm" disabled={analyze.isPending || !shockSymbol} onClick={() => analyze.mutate()}>
            {analyze.isPending ? "Running…" : "Run shock"}
          </Button>
          <Button size="sm" variant="outline" disabled={whatIf.isPending || !shockSymbol} onClick={() => whatIf.mutate()}>
            {whatIf.isPending ? "…" : "What-if add"}
          </Button>
          <Button size="sm" variant="outline" disabled={compare.isPending || !shockSymbol} onClick={() => compare.mutate()}>
            {compare.isPending ? "…" : "Compare"}
          </Button>
        </div>
        {labError && (
          <p className="sm:col-span-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">{labError}</p>
        )}
      </div>

      {pricedAsOf && (
        <p className="text-xs text-muted-foreground">
          Direct shock estimate using latest stored close ({pricedAsOf}). Second-order effects (correlated moves,
          sentiment spillover) are not modelled.
        </p>
      )}

      {latest && (
        <div className="panel space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Scale className="h-4 w-4 text-primary" aria-hidden />
            <span className="text-sm font-semibold">Direct shock estimate</span>
            <span className={cn("num text-lg font-bold", latest.portfolioImpactPct >= 0 ? "text-gain" : "text-loss")}>
              {latest.portfolioImpactPct >= 0 ? "+" : ""}
              {latest.portfolioImpactPct.toFixed(2)}%
            </span>
            <span className="num text-sm text-muted-foreground">
              {formatCurrencyOrNull(latest.baselineValue)} → {formatCurrencyOrNull(latest.scenarioValue)}
            </span>
          </div>
          <ul className="space-y-1">
            {latest.lines.map((l) => (
              <li key={l.symbol} className="flex items-center gap-3 text-sm">
                <span className="num w-24 font-medium">{l.symbol}</span>
                <span className="num w-24 text-muted-foreground">{l.weightPct.toFixed(1)}% weight</span>
                <span className="num w-20">{l.shockPct > 0 ? "+" : ""}{l.shockPct}%</span>
                <span className={cn("num font-semibold", l.contributionPctPoints >= 0 ? "text-gain" : "text-loss")}>
                  {l.contributionPctPoints >= 0 ? "+" : ""}
                  {l.contributionPctPoints.toFixed(2)} pts
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {whatIfResult && (
        <div className="panel space-y-3 p-4">
          <p className="text-sm font-semibold">What-if: add ₹{Number(amount).toLocaleString("en-IN")}</p>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">Largest weight</p>
              <p className="num font-medium">
                {whatIfResult.baseline.concentration.largestPct.toFixed(1)}% → {whatIfResult.scenario.concentration.largestPct.toFixed(1)}%
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">HHI</p>
              <p className="num font-medium">
                {whatIfResult.baseline.concentration.hhi.toFixed(3)} → {whatIfResult.scenario.concentration.hhi.toFixed(3)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Effective holdings</p>
              <p className="num font-medium">
                {whatIfResult.baseline.concentration.effectiveN.toFixed(1)} → {whatIfResult.scenario.concentration.effectiveN.toFixed(1)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Volatility (ann.)</p>
              <p className="num font-medium">
                {whatIfResult.baseline.volatilityPctAnn === null ? "N/A" : `${whatIfResult.baseline.volatilityPctAnn.toFixed(1)}%`}
                {" → "}
                {whatIfResult.scenario.volatilityPctAnn === null ? "N/A" : `${whatIfResult.scenario.volatilityPctAnn.toFixed(1)}%`}
              </p>
            </div>
          </div>
          <ul className="list-inside list-disc text-[11px] text-muted-foreground">
            {whatIfResult.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      )}

      {comparison && (
        <div className="panel space-y-2 p-4">
          <p className="text-sm font-semibold">Scenario comparison</p>
          <ul className="space-y-1.5">
            {comparison.scenarios.map((s) => (
              <li key={s.label} className="flex items-center justify-between text-sm">
                <span>{s.label}</span>
                <span className={cn("num font-semibold", s.impactPct >= 0 ? "text-gain" : "text-loss")}>
                  {s.impactPct >= 0 ? "+" : ""}
                  {s.impactPct.toFixed(2)}% · {formatCurrencyOrNull(s.valueAfter)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground">Baseline: {comparison.baselineLabel} · {formatCurrencyOrNull(comparison.current.value)}</p>
        </div>
      )}

      {/* Predefined stress suite */}
      <section className="space-y-3">
        <SectionHeader title="Predefined stress tests" description="Standard shock suites applied to your current holdings." />
        {stressLoading ? (
          <CardsSkeleton count={2} />
        ) : stressError ? (
          <ErrorState title="Stress suite failed" onRetry={() => void 0} />
        ) : (stressRuns ?? []).length === 0 ? (
          <EmptyState title="No stress runs" description="Load a portfolio to run the predefined stress suite." />
        ) : (
          <div className="panel overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Scenario</th>
                  <th className="px-4 py-3 font-medium">Description</th>
                  <th className="px-4 py-3 font-medium">Portfolio impact</th>
                  <th className="px-4 py-3 font-medium">Value after</th>
                </tr>
              </thead>
              <tbody>
                {(stressRuns ?? []).map((r) => (
                  <tr key={r.name} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-3 font-medium">{r.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{r.description}</td>
                    <td className={cn("num px-4 py-3 font-semibold", r.impact.portfolioImpactPct >= 0 ? "text-gain" : "text-loss")}>
                      {r.impact.portfolioImpactPct.toFixed(2)}%
                    </td>
                    <td className="num px-4 py-3">{formatCurrencyOrNull(r.impact.scenarioValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
