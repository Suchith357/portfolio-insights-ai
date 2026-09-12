import { useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import {
  AiDisclaimer,
  AiInsightCard,
  DeltaTable,
  DemoDataBadge,
  PnlText,
  ScoreMeter,
  SectionHeader,
  StatCard,
} from "@/components/common/data-display";
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/common/states";
import { PriceAreaChart } from "@/components/charts/charts";
import { formatCurrency, formatNumber, formatPct } from "@/lib/format";
import { explainSellSimulation } from "@/lib/ai-insights";
import { getPriceHistory } from "@/lib/demo-data";
import { simulateSell } from "@/lib/analytics";
import { USE_DEMO_DATA } from "@/services/api-client";
import * as analysisService from "@/services/analysis.service";
import * as stockService from "@/services/stock.service";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import * as portfolioService from "@/services/portfolio.service";
import type { SellRecommendation } from "@/types";

export const Route = createFileRoute("/_app/holdings/$id")({
  head: () => ({
    meta: [
      { title: "Holding analysis — PortfolioIQ" },
      {
        name: "description",
        content:
          "Exposure, invested value, P&L and a non-executing sell simulation for a single holding, computed by the PortfolioIQ analytics engine.",
      },
      { property: "og:title", content: "Holding analysis — PortfolioIQ" },
      {
        property: "og:description",
        content: "Review one position's contribution to portfolio risk and simulate trimming it without placing a trade.",
      },
    ],
  }),
  component: HoldingAnalysisPage,
});

const RECOMMENDATION_STYLES: Record<SellRecommendation, string> = {
  HOLD: "border-gain/40 bg-gain/10 text-gain",
  REVIEW: "border-warning/50 bg-warning/15 text-warning",
  "CONSIDER REDUCING": "border-destructive/60 bg-destructive/15 text-destructive",
};

function HoldingAnalysisPage() {
  const { id } = Route.useParams();
  const { user } = useAuth();
  const [pct, setPct] = useState(25);

  const holdingsQuery = useQuery({
    queryKey: ["holdings", "all", user?.id],
    queryFn: () => portfolioService.getAllHoldings(user!.id),
    enabled: !!user,
  });

  const holding = holdingsQuery.data?.find((h) => h.id === id) ?? null;

  const portfolioQuery = useQuery({
    queryKey: ["portfolio", holding?.portfolioId],
    queryFn: () => portfolioService.getPortfolioView(holding!.portfolioId),
    enabled: !!holding,
  });

  const view = portfolioQuery.data;
  const holdingView = view?.holdings.find((h) => h.id === id) ?? null;

  const simulation = useMemo(() => {
    if (!view || !holdingView) return null;
    // In API mode the sell simulation is computed by the backend analytics
    // engine (read-only); sync computation here would duplicate it.
    if (!USE_DEMO_DATA) return null;
    return simulateSell(view.holdings, id, pct);
  }, [view, holdingView, id, pct]);

  const serverSimulation = useQuery({
    queryKey: ["sell-simulation", id, pct],
    queryFn: () => analysisService.runSellSimulation(view?.holdings ?? [], id, pct),
    enabled: !USE_DEMO_DATA && !!view && !!holdingView,
    placeholderData: keepPreviousData,
  });
  const activeSimulation = USE_DEMO_DATA ? simulation : (serverSimulation.data ?? null);

  // Price history comes from the backend stock_prices table via the API —
  // the demo generator only covers its own 30-symbol universe.
  const pricesQuery = useQuery({
    queryKey: ["stock-prices", holdingView?.symbol],
    queryFn: () => stockService.getStockPrices(holdingView!.symbol),
    enabled: !!holdingView && !USE_DEMO_DATA,
  });
  const priceSeries = useMemo(() => {
    if (USE_DEMO_DATA) return holdingView ? getPriceHistory(holdingView.symbol).slice(-52) : [];
    return (pricesQuery.data ?? []).slice(-52);
  }, [holdingView, pricesQuery.data]);

  if (holdingsQuery.isLoading || (holding && portfolioQuery.isLoading)) {
    return <CardsSkeleton count={4} />;
  }

  if (holdingsQuery.isError || portfolioQuery.isError) {
    return (
      <ErrorState
        title="We couldn't load this holding"
        description="Please try again in a moment."
        onRetry={() => {
          holdingsQuery.refetch();
          portfolioQuery.refetch();
        }}
      />
    );
  }

  if (!holding || !holdingView || !view || !activeSimulation) {
    return (
      <EmptyState
        title="Holding not found"
        description="This position no longer exists in your portfolios, or it belongs to another account."
        action={
          <Button asChild size="sm" variant="outline">
            <Link to="/portfolios">Back to portfolios</Link>
          </Button>
        }
      />
    );
  }

  // Risk comes from the backend analytics engine over real dataset prices.
  const risk = holdingView.risk;
  const sectorPct =
    view.metrics.sectorAllocation.find((s) => s.sector === holdingView.stock.sector)?.pct ?? 0;
  const insight = explainSellSimulation(holdingView.symbol, pct, activeSimulation);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Button asChild size="sm" variant="ghost" className="-ml-2">
            <Link to="/portfolios/$id" params={{ id: view.portfolio.id }}>
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              {view.portfolio.name}
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">
            {holdingView.symbol}{" "}
            <span className="text-base font-normal text-muted-foreground">{holdingView.stock.name}</span>
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{holdingView.stock.sector}</Badge>
            <Badge variant="outline">{holdingView.stock.exchange}</Badge>
            <Badge variant="outline">Risk band: {risk.riskBand}</Badge>
          </div>
        </div>
        <DemoDataBadge />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Current value"
          value={formatCurrency(holdingView.currentValue)}
          sub={`${formatNumber(holdingView.quantity, 2)} units @ ${formatCurrency(holdingView.stock.lastPrice)}`}
        />
        <StatCard
          label="Invested"
          value={formatCurrency(holdingView.invested)}
          sub={`Avg buy ${formatCurrency(holdingView.avgBuyPrice)}`}
        />
        <StatCard
          label="Unrealised P&L"
          value={formatCurrency(holdingView.pnl)}
          trend={holdingView.pnlPct}
          tone={holdingView.pnl >= 0 ? "gain" : "loss"}
        />
        <StatCard
          label="Portfolio weight"
          value={`${holdingView.allocationPct.toFixed(1)}%`}
          sub={`${holdingView.stock.sector} sector at ${sectorPct.toFixed(1)}%`}
          tone={holdingView.allocationPct > 25 ? "warning" : "default"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <ScoreMeter
          label="Portfolio risk score"
          score={view.metrics.riskScore}
          betterWhenLower
          hint="Weighted volatility, concentration and drawdown exposure."
        />
        <ScoreMeter
          label="Portfolio diversification"
          score={view.metrics.diversificationScore}
          hint="Spread across stocks and sectors."
        />
        <div className="panel space-y-2 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Stock risk figures</p>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">Volatility</dt>
            <dd className="num text-right">{risk.volatilityPct.toFixed(1)}%</dd>
            <dt className="text-muted-foreground">Max drawdown</dt>
            <dd className="num text-right text-loss">{risk.maxDrawdownPct.toFixed(1)}%</dd>
            <dt className="text-muted-foreground">1Y return</dt>
            <dd className="num text-right">{risk.return1yPct === null ? "—" : formatPct(risk.return1yPct)}</dd>
            <dt className="text-muted-foreground">3Y return (p.a.)</dt>
            <dd className="num text-right">{risk.return3yPct === null ? "—" : formatPct(risk.return3yPct)}</dd>
          </dl>
        </div>
      </div>

      <div className="panel p-4">
        <SectionHeader title="Price history" description="Last 52 weeks of demo closing prices." />
        <div className="mt-4">
          <PriceAreaChart data={priceSeries} height={240} />
        </div>
      </div>

      <div className="panel space-y-4 p-4">
        <SectionHeader
          title="Sell simulation"
          description="Model trimming this position and see how the portfolio profile would change."
          action={
            <span
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-semibold tracking-wide",
                RECOMMENDATION_STYLES[activeSimulation.recommendation],
              )}
            >
              {activeSimulation.recommendation}
            </span>
          }
        />

        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            This is a simulation only. Nothing is sold, no transaction is recorded and your holdings stay exactly as
            they are.
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label htmlFor="sell-pct" className="text-sm font-medium">
              Portion to sell
            </label>
            <span className="num text-sm font-semibold">{pct}%</span>
          </div>
          <Slider
            id="sell-pct"
            min={5}
            max={100}
            step={5}
            value={[pct]}
            onValueChange={(v) => setPct(v[0] ?? 25)}
            aria-label="Percentage of this holding to simulate selling"
          />
          <div className="flex flex-wrap gap-2 pt-1">
            {[10, 25, 50, 75, 100].map((p) => (
              <Button key={p} size="sm" variant={p === pct ? "default" : "outline"} onClick={() => setPct(p)}>
                {p}%
              </Button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            label="Simulated proceeds"
            value={formatCurrency(activeSimulation.proceeds)}
            sub={`${formatNumber((holdingView.quantity * pct) / 100, 2)} units`}
          />
          <div className="panel p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Realised P&L if executed
            </p>
            <p className="mt-2 text-2xl font-semibold">
              <PnlText value={activeSimulation.realisedPnl} />
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Not booked — hypothetical only.</p>
          </div>
          <StatCard
            label="Remaining weight"
            value={`${(holdingView.allocationPct * (1 - pct / 100)).toFixed(1)}%`}
            sub={`From ${holdingView.allocationPct.toFixed(1)}% today`}
          />
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">Before / after comparison</h3>
          <DeltaTable deltas={activeSimulation.deltas} />
        </div>

        <div className="space-y-3">
          <AiInsightCard insight={insight} />
          <ul className="space-y-1.5 text-sm text-muted-foreground">
            {activeSimulation.reasons.map((r) => (
              <li key={r} className="flex gap-2">
                <span className="text-primary">•</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
          <AiDisclaimer />
        </div>
      </div>
    </div>
  );
}
