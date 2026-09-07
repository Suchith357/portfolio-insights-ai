import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Bell, Eye, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AiDisclaimer,
  AiInsightCard,
  DemoDataBadge,
  PnlText,
  ScoreMeter,
  SectionHeader,
  SeverityBadge,
  StatCard,
} from "@/components/common/data-display";
import { CardsSkeleton, EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { AllocationBars, PriceAreaChart, SectorDonut } from "@/components/charts/charts";
import { portfolioValueSeries } from "@/lib/analytics";
import { offlineExplainer } from "@/lib/ai-insights";
import { formatCurrency, formatDate } from "@/lib/format";
import { useAuth } from "@/hooks/use-auth";
import * as portfolioService from "@/services/portfolio.service";
import * as watchlistService from "@/services/watchlist.service";
import * as alertService from "@/services/alert.service";

export const Route = createFileRoute("/_app/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — PortfolioIQ" },
      {
        name: "description",
        content: "Portfolio value, return, risk score, diversification score and sector allocation at a glance.",
      },
      { property: "og:title", content: "Dashboard — PortfolioIQ" },
      { property: "og:description", content: "Your portfolio risk and diversification overview." },
    ],
  }),
  component: DashboardPage,
});

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`panel p-4 sm:p-5 ${className}`}>{children}</section>;
}

function DashboardPage() {
  const { user } = useAuth();
  const userId = user?.id ?? "";

  const overview = useQuery({
    queryKey: ["dashboard", "overview", userId],
    queryFn: () => portfolioService.getAggregateView(userId),
    enabled: !!userId,
  });

  const transactions = useQuery({
    queryKey: ["dashboard", "transactions"],
    queryFn: () => portfolioService.listTransactions(),
  });

  const watchlist = useQuery({
    queryKey: ["dashboard", "watchlist", userId],
    queryFn: () => watchlistService.listWatchlist(userId),
    enabled: !!userId,
  });

  const symbols = overview.data?.holdings.map((h) => h.symbol) ?? [];
  const alerts = useQuery({
    queryKey: ["dashboard", "alerts", symbols.join(",")],
    queryFn: () => alertService.listAlertsForSymbols(symbols),
    enabled: symbols.length > 0,
  });

  if (overview.isLoading) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <CardsSkeleton />
        <div className="panel">
          <LoadingBlock label="Loading portfolio analytics" />
        </div>
      </div>
    );
  }

  if (overview.isError || !overview.data) {
    return (
      <div className="p-4 sm:p-6">
        <ErrorState
          title="We couldn't load your dashboard"
          description="The portfolio analytics service didn't respond. Please try again."
          onRetry={() => overview.refetch()}
        />
      </div>
    );
  }

  const { holdings, metrics, raw } = overview.data;
  const insights = offlineExplainer.explainPortfolio(metrics);
  const valueSeries = portfolioValueSeries(raw);
  const topHoldings = [...holdings].sort((a, b) => b.allocationPct - a.allocationPct).slice(0, 8);
  const recentTransactions = (transactions.data ?? []).slice(0, 6);
  const topAlerts = (alerts.data ?? []).slice(0, 4);

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Welcome back{user?.name ? `, ${user.name.split(" ")[0]}` : ""}
          </h1>
          <p className="text-sm text-muted-foreground">
            A combined view of every portfolio in your workspace.
          </p>
        </div>
        <DemoDataBadge className="sm:hidden" />
      </div>

      {metrics.holdingCount === 0 ? (
        <EmptyState
          title="No holdings yet"
          description="Create a portfolio and record your first transaction to see risk, diversification and allocation analytics here."
          action={
            <Button asChild size="sm">
              <Link to="/portfolios">Go to portfolios</Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Total portfolio value"
              value={formatCurrency(metrics.totalValue)}
              sub={`${metrics.holdingCount} positions`}
            />
            <StatCard label="Total invested" value={formatCurrency(metrics.totalInvested)} sub="At cost" />
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

          <Panel>
            <SectionHeader
              title="Portfolio performance"
              description="Value of current holdings across the last 52 weeks of dataset prices."
              action={<DemoDataBadge className="hidden sm:inline-flex" />}
            />
            <div className="mt-4">
              <PriceAreaChart data={valueSeries} height={260} />
            </div>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <SectionHeader title="Sector allocation" description="Share of portfolio value by sector." />
              <div className="mt-2">
                <SectorDonut data={metrics.sectorAllocation} />
              </div>
            </Panel>
            <Panel>
              <SectionHeader title="Stock allocation" description="Largest positions by weight." />
              <div className="mt-2">
                <AllocationBars
                  data={topHoldings.map((h) => ({ label: h.symbol, value: h.allocationPct }))}
                />
              </div>
            </Panel>
          </div>

          <Panel>
            <SectionHeader
              title="AI insights"
              description="Plain-language explanation of the figures computed above."
            />
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

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <SectionHeader
            title="Recent transactions"
            description="Recorded trades — simulations are never included."
            action={
              <Button asChild variant="ghost" size="sm">
                <Link to="/portfolios">View all</Link>
              </Button>
            }
          />
          <div className="mt-3">
            {transactions.isLoading ? (
              <LoadingBlock label="Loading transactions" />
            ) : transactions.isError ? (
              <ErrorState
                title="Transactions unavailable"
                description="We couldn't load your recent activity."
                onRetry={() => transactions.refetch()}
              />
            ) : recentTransactions.length === 0 ? (
              <EmptyState
                title="No transactions recorded"
                description="Buy and sell activity you record will appear here."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[460px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Type</th>
                      <th className="py-2 pr-3 font-medium">Stock</th>
                      <th className="py-2 pr-3 font-medium">Qty</th>
                      <th className="py-2 pr-3 font-medium">Value</th>
                      <th className="py-2 font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentTransactions.map((t) => (
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

        <div className="space-y-4">
          <Panel>
            <SectionHeader
              title="Alerts"
              description="Sample risk and news events touching your holdings."
              action={
                <Button asChild variant="ghost" size="sm">
                  <Link to="/alerts">View all</Link>
                </Button>
              }
            />
            <div className="mt-3 space-y-3">
              {alerts.isLoading ? (
                <LoadingBlock label="Loading alerts" />
              ) : topAlerts.length === 0 ? (
                <EmptyState
                  title="No alerts for your holdings"
                  description="Events affecting stocks you own will be listed here."
                  icon={<Bell className="h-5 w-5" />}
                />
              ) : (
                topAlerts.map((a) => (
                  <div key={a.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-medium leading-snug">{a.headline}</p>
                      <SeverityBadge severity={a.severity} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {a.symbol} · {a.eventType} · {formatDate(a.createdAt)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </Panel>

          <Panel>
            <SectionHeader
              title="Watchlist"
              description="Stocks you are tracking."
              action={
                <Button asChild variant="ghost" size="sm">
                  <Link to="/watchlist">Manage</Link>
                </Button>
              }
            />
            <div className="mt-3">
              {watchlist.isLoading ? (
                <LoadingBlock label="Loading watchlist" />
              ) : (watchlist.data ?? []).length === 0 ? (
                <EmptyState
                  title="Watchlist is empty"
                  description="Add stocks from the explorer to keep an eye on them."
                  icon={<Eye className="h-5 w-5" />}
                />
              ) : (
                <ul className="divide-y divide-border/60 text-sm">
                  {(watchlist.data ?? []).map((w) => (
                    <li key={w.id} className="flex items-center justify-between py-2">
                      <Link
                        to="/stocks/$symbol"
                        params={{ symbol: w.symbol }}
                        className="font-medium hover:text-primary"
                      >
                        {w.symbol}
                      </Link>
                      <span className="text-xs text-muted-foreground">Added {formatDate(w.addedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>
        </div>
      </div>

      {metrics.holdingCount > 0 && (
        <Panel>
          <SectionHeader title="Holdings summary" description="Every position across your portfolios." />
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Stock</th>
                  <th className="py-2 pr-3 font-medium">Sector</th>
                  <th className="py-2 pr-3 font-medium">Qty</th>
                  <th className="py-2 pr-3 font-medium">Value</th>
                  <th className="py-2 pr-3 font-medium">P&L</th>
                  <th className="py-2 font-medium">Weight</th>
                </tr>
              </thead>
              <tbody>
                {topHoldings.map((h) => (
                  <tr key={h.id} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pr-3">
                      <Link
                        to="/holdings/$id"
                        params={{ id: h.id }}
                        className="font-medium hover:text-primary"
                      >
                        {h.symbol}
                      </Link>
                      <span className="block text-xs text-muted-foreground">{h.stock.name}</span>
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">{h.stock.sector}</td>
                    <td className="num py-2 pr-3">{h.quantity}</td>
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
      )}

      {metrics.holdingCount === 0 && (
        <div className="hidden">
          <Inbox />
        </div>
      )}
    </div>
  );
}
