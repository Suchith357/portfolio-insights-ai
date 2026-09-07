import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AiDisclaimer,
  AiInsightCard,
  DemoDataBadge,
  PnlText,
  ScoreMeter,
  SectionHeader,
  StatCard,
} from "@/components/common/data-display";
import { CardsSkeleton, EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { AllocationBars, SectorDonut } from "@/components/charts/charts";
import { offlineExplainer } from "@/lib/ai-insights";
import { formatCurrency, formatDate } from "@/lib/format";
import * as portfolioService from "@/services/portfolio.service";

export const Route = createFileRoute("/_app/portfolios/$id")({
  head: () => ({
    meta: [
      { title: "Portfolio detail — PortfolioIQ" },
      {
        name: "description",
        content: "Holdings, sector allocation, risk and diversification breakdown for a single portfolio.",
      },
      { property: "og:title", content: "Portfolio detail — PortfolioIQ" },
      { property: "og:description", content: "Holdings, allocation and risk breakdown for this portfolio." },
    ],
  }),
  component: PortfolioDetail,
});

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`panel p-4 sm:p-5 ${className}`}>{children}</section>;
}

function PortfolioDetail() {
  const { id } = Route.useParams();

  const view = useQuery({
    queryKey: ["portfolio-view", id],
    queryFn: () => portfolioService.getPortfolioView(id),
  });

  const transactions = useQuery({
    queryKey: ["transactions", id],
    queryFn: () => portfolioService.listTransactions(id),
  });

  const backLink = (
    <Button asChild variant="ghost" size="sm" className="-ml-2">
      <Link to="/portfolios">
        <ArrowLeft className="mr-1.5 h-4 w-4" />
        Back to portfolios
      </Link>
    </Button>
  );

  if (view.isLoading) {
    return (
      <div className="space-y-4">
        {backLink}
        <CardsSkeleton />
        <div className="panel">
          <TableSkeleton />
        </div>
      </div>
    );
  }

  if (view.isError || !view.data) {
    return (
      <div className="space-y-4">
        {backLink}
        <ErrorState
          title="We couldn't open this portfolio"
          description="It may have been removed, or the analytics service didn't respond."
          onRetry={() => view.refetch()}
        />
      </div>
    );
  }

  const { portfolio, holdings, metrics } = view.data;
  const insights = offlineExplainer.explainPortfolio(metrics);
  const recent = (transactions.data ?? []).slice(0, 10);

  return (
    <div className="space-y-6">
      {backLink}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{portfolio.name}</h1>
          <p className="text-sm text-muted-foreground">
            {portfolio.description || "No description added."} · Created {formatDate(portfolio.createdAt)}
          </p>
        </div>
        <DemoDataBadge />
      </div>

      {metrics.holdingCount === 0 ? (
        <EmptyState
          title="This portfolio has no holdings"
          description="Record a buy transaction to see value, risk and diversification analytics for this portfolio."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Total value"
              value={formatCurrency(metrics.totalValue)}
              sub={`${metrics.holdingCount} positions`}
            />
            <StatCard label="Invested" value={formatCurrency(metrics.totalInvested)} sub="At cost" />
            <StatCard
              label="Unrealised P&L"
              value={formatCurrency(metrics.pnl)}
              trend={metrics.pnlPct}
              tone={metrics.pnl >= 0 ? "gain" : "loss"}
            />
            <StatCard
              label="Largest position"
              value={metrics.topConcentrationSymbol ?? "—"}
              sub={`${metrics.topConcentrationPct.toFixed(1)}% of value`}
              tone={metrics.topConcentrationPct > 25 ? "warning" : "default"}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ScoreMeter
              label="Risk score"
              score={metrics.riskScore}
              betterWhenLower
              hint={`Estimated annualised volatility ${metrics.annualisedVolatilityPct.toFixed(1)}% across the dataset.`}
            />
            <ScoreMeter
              label="Diversification score"
              score={metrics.diversificationScore}
              hint="Higher means value is spread across more positions and sectors."
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <SectionHeader title="Sector allocation" description="Share of this portfolio's value by sector." />
              <div className="mt-2">
                <SectorDonut data={metrics.sectorAllocation} />
              </div>
            </Panel>
            <Panel>
              <SectionHeader title="Stock allocation" description="Positions by weight." />
              <div className="mt-2">
                <AllocationBars
                  data={[...holdings]
                    .sort((a, b) => b.allocationPct - a.allocationPct)
                    .map((h) => ({ label: h.symbol, value: h.allocationPct }))}
                />
              </div>
            </Panel>
          </div>

          <Panel>
            <SectionHeader title="Holdings" description="Every position recorded in this portfolio." />
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Stock</th>
                    <th className="py-2 pr-3 font-medium">Sector</th>
                    <th className="py-2 pr-3 font-medium">Qty</th>
                    <th className="py-2 pr-3 font-medium">Avg buy</th>
                    <th className="py-2 pr-3 font-medium">Price</th>
                    <th className="py-2 pr-3 font-medium">Value</th>
                    <th className="py-2 pr-3 font-medium">P&L</th>
                    <th className="py-2 font-medium">Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {[...holdings]
                    .sort((a, b) => b.allocationPct - a.allocationPct)
                    .map((h) => (
                      <tr key={h.id} className="border-b border-border/60 last:border-0">
                        <td className="py-2 pr-3">
                          <Link to="/holdings/$id" params={{ id: h.id }} className="font-medium hover:text-primary">
                            {h.symbol}
                          </Link>
                          <span className="block text-xs text-muted-foreground">{h.stock.name}</span>
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">{h.stock.sector}</td>
                        <td className="num py-2 pr-3">{h.quantity}</td>
                        <td className="num py-2 pr-3">{formatCurrency(h.avgBuyPrice)}</td>
                        <td className="num py-2 pr-3">{formatCurrency(h.stock.lastPrice)}</td>
                        <td className="num py-2 pr-3">{formatCurrency(h.currentValue)}</td>
                        <td className="py-2 pr-3">
                          <PnlText value={h.pnl} pct={h.pnlPct} />
                        </td>
                        <td className="num py-2">{h.allocationPct.toFixed(1)}%</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel>
            <SectionHeader title="AI insights" description="Plain-language explanation of the figures above." />
            <div className="mt-4 grid gap-3 lg:grid-cols-3">
              {insights.map((insight) => (
                <AiInsightCard key={insight.title} insight={insight} />
              ))}
            </div>
            <div className="mt-3">
              <AiDisclaimer />
            </div>
          </Panel>
        </>
      )}

      <Panel>
        <SectionHeader
          title="Recent transactions"
          description="Recorded trades for this portfolio — simulations are never included."
        />
        <div className="mt-3">
          {transactions.isLoading ? (
            <TableSkeleton rows={4} />
          ) : transactions.isError ? (
            <ErrorState
              title="Transactions unavailable"
              description="We couldn't load activity for this portfolio."
              onRetry={() => transactions.refetch()}
            />
          ) : recent.length === 0 ? (
            <EmptyState
              title="No transactions recorded"
              description="Buy and sell activity you record for this portfolio will appear here."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Type</th>
                    <th className="py-2 pr-3 font-medium">Stock</th>
                    <th className="py-2 pr-3 font-medium">Qty</th>
                    <th className="py-2 pr-3 font-medium">Price</th>
                    <th className="py-2 pr-3 font-medium">Value</th>
                    <th className="py-2 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((t) => (
                    <tr key={t.id} className="border-b border-border/60 last:border-0">
                      <td className="py-2 pr-3">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                            t.type === "BUY"
                              ? "border-gain/40 bg-gain/10 text-gain"
                              : "border-loss/40 bg-loss/10 text-loss"
                          }`}
                        >
                          {t.type}
                        </span>
                      </td>
                      <td className="py-2 pr-3 font-medium">{t.symbol}</td>
                      <td className="num py-2 pr-3">{t.quantity}</td>
                      <td className="num py-2 pr-3">{formatCurrency(t.price)}</td>
                      <td className="num py-2 pr-3">{formatCurrency(t.quantity * t.price)}</td>
                      <td className="py-2 text-muted-foreground">{formatDate(t.executedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
