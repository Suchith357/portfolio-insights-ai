import { useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import {
  AiDisclaimer,
  AiInsightCard,
  DeltaTable,
  DemoDataBadge,
  SeverityBadge,
  StatCard,
} from "@/components/common/data-display";
import { PriceAreaChart } from "@/components/charts/charts";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { SectionHeader } from "@/components/common/data-display";
import { formatCurrency, formatDate, formatPct } from "@/lib/format";
import { explainBuySimulation } from "@/lib/ai-insights";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import * as stockService from "@/services/stock.service";
import * as portfolioService from "@/services/portfolio.service";
import * as watchlistService from "@/services/watchlist.service";
import * as alertService from "@/services/alert.service";
import * as analysisService from "@/services/analysis.service";
import type { Holding } from "@/types";

export const Route = createFileRoute("/_app/stocks/$symbol")({
  head: () => ({
    meta: [
      { title: "Stock detail — PortfolioIQ" },
      {
        name: "description",
        content:
          "Price history, volatility, drawdown, trailing returns and a buy simulation that measures how a stock would fit your portfolio.",
      },
      { property: "og:title", content: "Stock detail — PortfolioIQ" },
      {
        property: "og:description",
        content: "Analyse a symbol against your own portfolio with PortfolioIQ's deterministic analytics engine.",
      },
    ],
  }),
  component: StockDetail,
});

const RANGES = [
  { key: "1Y", weeks: 52 },
  { key: "3Y", weeks: 156 },
  { key: "5Y", weeks: 260 },
] as const;

function StockDetail() {
  const { symbol } = Route.useParams();
  const upper = symbol.toUpperCase();
  const { user } = useAuth();
  const qc = useQueryClient();

  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("1Y");
  const [portfolioId, setPortfolioId] = useState<string>("");
  const [amount, setAmount] = useState("50000");
  const [amountError, setAmountError] = useState<string | null>(null);

  // Real BUY workflow (distinct from the simulation above it).
  const [buyPortfolioId, setBuyPortfolioId] = useState("");
  const [buyQty, setBuyQty] = useState("");
  const [buyPrice, setBuyPrice] = useState("");
  const [buyError, setBuyError] = useState<string | null>(null);
  const [buySuccess, setBuySuccess] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ["stock", upper],
    queryFn: () => stockService.getStockDetail(upper),
  });

  const portfolios = useQuery({
    queryKey: ["portfolios", user?.id],
    queryFn: () => portfolioService.listPortfolios(user!.id),
    enabled: !!user,
  });

  const activePortfolioId = portfolioId || portfolios.data?.[0]?.id || "";

  const portfolioView = useQuery({
    queryKey: ["portfolio-view", activePortfolioId],
    queryFn: () => portfolioService.getPortfolioView(activePortfolioId),
    enabled: !!activePortfolioId,
  });

  const watchlist = useQuery({
    queryKey: ["watchlist", user?.id],
    queryFn: () => watchlistService.listWatchlist(user!.id),
    enabled: !!user,
  });

  const alerts = useQuery({
    queryKey: ["alerts", upper],
    queryFn: () => alertService.listAlertsForSymbols([upper]),
  });

  const watchItem = watchlist.data?.find((w) => w.symbol === upper);

  const toggleWatch = useMutation({
    mutationFn: async () => {
      if (watchItem) await watchlistService.removeFromWatchlist(watchItem.id);
      else await watchlistService.addToWatchlist(user!.id, upper);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watchlist"] }),
  });

  const holdings: Holding[] = useMemo(
    () => (portfolioView.data?.holdings ?? []).map((h) => ({ ...h })),
    [portfolioView.data],
  );

  const simulation = useMutation({
    mutationFn: (value: number) =>
      analysisService.runBuySimulation(holdings, upper, value, activePortfolioId || undefined),
  });

  const activeBuyPortfolioId = buyPortfolioId || portfolios.data?.[0]?.id || "";

  function invalidateAfterTrade() {
    void qc.invalidateQueries({ queryKey: ["portfolio-view"] });
    void qc.invalidateQueries({ queryKey: ["portfolios"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
    void qc.invalidateQueries({ queryKey: ["transactions"] });
    void qc.invalidateQueries({ queryKey: ["holdings"] });
  }

  const recordBuy = useMutation({
    mutationFn: () =>
      portfolioService.recordTransaction({
        portfolioId: activeBuyPortfolioId,
        symbol: upper,
        type: "BUY",
        quantity: Number(buyQty),
        price: Number(buyPrice),
        executedAt: new Date().toISOString(),
      }),
    onSuccess: () => {
      setBuySuccess(`Recorded BUY of ${buyQty} ${upper} — the portfolio's holdings and analytics are updated.`);
      setBuyQty("");
      setBuyError(null);
      invalidateAfterTrade();
      window.setTimeout(() => setBuySuccess(null), 6000);
    },
    onError: (err: unknown) =>
      setBuyError(err instanceof Error ? err.message : "We couldn't record this purchase."),
  });

  function submitBuy(e: React.FormEvent) {
    e.preventDefault();
    setBuyError(null);
    const qty = Number(buyQty);
    const price = Number(buyPrice);
    if (!activeBuyPortfolioId) {
      setBuyError("Create a portfolio first, then add this stock to it.");
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      setBuyError("Quantity must be a number greater than 0.");
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      setBuyError("Price must be a number greater than 0.");
      return;
    }
    recordBuy.mutate();
  }

  const history = useMemo(() => {
    const all = detail.data?.history ?? [];
    const weeks = RANGES.find((r) => r.key === range)!.weeks;
    return all.slice(Math.max(0, all.length - weeks));
  }, [detail.data, range]);

  if (detail.isLoading) return <LoadingBlock label="Loading stock" />;
  if (detail.isError || !detail.data)
    return (
      <ErrorState
        title="We couldn't load that stock"
        description="The symbol may not exist in the demo dataset."
        onRetry={() => detail.refetch()}
      />
    );

  const { stock, risk } = detail.data;
  const change = stock.lastPrice - stock.previousClose;
  const changePct = stock.previousClose ? (change / stock.previousClose) * 100 : 0;
  const existing = holdings.find((h) => h.symbol === upper);
  const exposurePct = portfolioView.data?.holdings.find((h) => h.symbol === upper)?.allocationPct ?? 0;
  const correlation = holdings.length ? analysisService.correlationWithPortfolio(holdings, upper) : null;

  function runSimulation() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setAmountError("Enter an amount greater than 0.");
      return;
    }
    if (value > 100000000) {
      setAmountError("Keep the simulated amount under 10 crore.");
      return;
    }
    setAmountError(null);
    simulation.mutate(value);
  }

  return (
    <div className="space-y-6">
      <Link
        to="/stocks"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Stock Explorer
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="num text-2xl font-semibold tracking-tight">{stock.symbol}</h1>
            <Badge variant="outline">{stock.sector}</Badge>
            <Badge variant="outline">{stock.exchange}</Badge>
            <Badge variant="outline">{risk.riskBand} risk</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{stock.name}</p>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="num text-3xl font-semibold">{formatCurrency(stock.lastPrice)}</span>
            <span className={cn("num text-sm font-medium", change >= 0 ? "text-gain" : "text-loss")}>
              {change >= 0 ? "+" : "−"}
              {formatCurrency(Math.abs(change))} ({formatPct(changePct)})
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <DemoDataBadge />
          <Button
            variant={watchItem ? "secondary" : "outline"}
            size="sm"
            disabled={toggleWatch.isPending || !user}
            onClick={() => toggleWatch.mutate()}
          >
            {watchItem ? <EyeOff className="mr-1.5 h-4 w-4" /> : <Eye className="mr-1.5 h-4 w-4" />}
            {watchItem ? "Remove from watchlist" : "Add to watchlist"}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Market cap" value={`₹${stock.marketCapCr.toLocaleString("en-IN")} Cr`} />
        <StatCard label="Annualised volatility" value={`${risk.volatilityPct.toFixed(1)}%`} sub="5y weekly closes" />
        <StatCard
          label="Maximum drawdown"
          value={`${risk.maxDrawdownPct.toFixed(1)}%`}
          tone="loss"
          sub="Worst peak-to-trough"
        />
        <StatCard
          label="Your exposure"
          value={exposurePct > 0 ? `${exposurePct.toFixed(1)}%` : "None"}
          sub={existing ? `${existing.quantity} shares held` : "Not held in this portfolio"}
        />
      </div>

      <section className="panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Price history</h2>
            <p className="text-xs text-muted-foreground">Synthetic weekly closes — demo dataset, not live quotes.</p>
          </div>
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <Button
                key={r.key}
                size="sm"
                variant={range === r.key ? "secondary" : "ghost"}
                onClick={() => setRange(r.key)}
              >
                {r.key}
              </Button>
            ))}
          </div>
        </div>
        <div className="mt-4">
          <PriceAreaChart data={history} />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border/60 pt-4 text-sm sm:grid-cols-4">
          {[
            { label: "1-year return", value: risk.return1yPct },
            { label: "3-year return", value: risk.return3yPct },
            { label: "5-year return", value: risk.return5yPct },
          ].map((r) => (
            <div key={r.label}>
              <dt className="text-xs text-muted-foreground">{r.label}</dt>
              <dd
                className={cn(
                  "num mt-0.5 font-medium",
                  r.value == null ? "text-muted-foreground" : r.value >= 0 ? "text-gain" : "text-loss",
                )}
              >
                {r.value == null ? "Not enough data" : formatPct(r.value)}
              </dd>
            </div>
          ))}
          <div>
            <dt className="text-xs text-muted-foreground">Correlation with portfolio</dt>
            <dd className="num mt-0.5 font-medium">
              {correlation == null ? "Not enough data" : correlation.toFixed(2)}
            </dd>
          </div>
        </dl>
      </section>

      <section className="panel p-4">
        <SectionHeader
          title="Add to my portfolio"
          description="Record a real BUY. This creates a transaction and updates the holding — the simulation above never does."
        />
        {portfolios.isLoading ? (
          <div className="mt-3"><LoadingBlock label="Loading portfolios" /></div>
        ) : !portfolios.data || portfolios.data.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              title="No portfolio yet"
              description="Create a portfolio to add this stock to it."
              action={
                <Button asChild size="sm">
                  <Link to="/portfolios">Go to portfolios</Link>
                </Button>
              }
            />
          </div>
        ) : (
          <form onSubmit={submitBuy} className="mt-3 grid gap-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="buy-portfolio">Portfolio</Label>
              <Select value={activeBuyPortfolioId} onValueChange={setBuyPortfolioId}>
                <SelectTrigger id="buy-portfolio">
                  <SelectValue placeholder="Select portfolio" />
                </SelectTrigger>
                <SelectContent>
                  {portfolios.data.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="buy-qty">Quantity</Label>
              <Input
                id="buy-qty"
                inputMode="decimal"
                value={buyQty}
                onChange={(e) => setBuyQty(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="buy-price">Buy price (₹)</Label>
              <Input
                id="buy-price"
                inputMode="decimal"
                placeholder={String(stock.lastPrice)}
                value={buyPrice}
                onChange={(e) => setBuyPrice(e.target.value)}
              />
            </div>
            <div className="flex items-end">
              <Button type="submit" className="w-full" disabled={recordBuy.isPending}>
                {recordBuy.isPending ? "Recording…" : "Add to portfolio"}
              </Button>
            </div>
            {(buyError || buySuccess) && (
              <p
                className={`sm:col-span-4 rounded-md border px-3 py-2 text-sm ${
                  buyError
                    ? "border-destructive/50 bg-destructive/10 text-destructive"
                    : "border-gain/40 bg-gain/10 text-gain"
                }`}
                role="status"
              >
                {buyError ?? buySuccess}
              </p>
            )}
          </form>
        )}
      </section>

      <Tabs defaultValue="simulate">
        <TabsList>
          <TabsTrigger value="simulate">Analyse against my portfolio</TabsTrigger>
          <TabsTrigger value="alerts">Alerts ({alerts.data?.length ?? 0})</TabsTrigger>
        </TabsList>

        <TabsContent value="simulate" className="mt-4 space-y-4">
          <section className="panel space-y-4 p-4">
            <div>
              <h2 className="text-sm font-semibold">Buy simulation</h2>
              <p className="text-xs text-muted-foreground">
                Hypothetical only. Nothing is bought and no transaction or holding is changed.
              </p>
            </div>

            {portfolios.isLoading ? (
              <LoadingBlock label="Loading portfolios" />
            ) : !portfolios.data || portfolios.data.length === 0 ? (
              <EmptyState
                title="No portfolio to simulate against"
                description="Create a portfolio first, then come back to test how this stock would fit."
                action={
                  <Button asChild size="sm">
                    <Link to="/portfolios">Go to portfolios</Link>
                  </Button>
                }
              />
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="sim-portfolio">Portfolio</Label>
                    <Select value={activePortfolioId} onValueChange={setPortfolioId}>
                      <SelectTrigger id="sim-portfolio">
                        <SelectValue placeholder="Select portfolio" />
                      </SelectTrigger>
                      <SelectContent>
                        {portfolios.data.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sim-amount">Hypothetical amount (₹)</Label>
                    <Input
                      id="sim-amount"
                      inputMode="numeric"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      aria-invalid={!!amountError}
                    />
                    {amountError && <p className="text-xs text-destructive">{amountError}</p>}
                  </div>
                  <div className="flex items-end">
                    <Button className="w-full" onClick={runSimulation} disabled={simulation.isPending}>
                      {simulation.isPending ? "Simulating…" : "Run simulation"}
                    </Button>
                  </div>
                </div>

                {simulation.isError && (
                  <ErrorState
                    title="Simulation failed"
                    description="We couldn't complete the simulation. Please try again."
                    onRetry={() => runSimulation()}
                  />
                )}

                {simulation.data && (
                  <div className="space-y-4 border-t border-border/60 pt-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-xs",
                          simulation.data.fitScore >= 6
                            ? "border-gain/40 text-gain"
                            : "border-warning/50 text-warning",
                        )}
                      >
                        {simulation.data.classification}
                      </Badge>
                      <span className="num text-sm text-muted-foreground">
                        Fit score {simulation.data.fitScore.toFixed(1)}/10
                      </span>
                    </div>
                    <DeltaTable deltas={simulation.data.deltas} />
                    <AiInsightCard
                      insight={explainBuySimulation(upper, Number(amount), simulation.data)}
                    />
                    <AiDisclaimer />
                  </div>
                )}
              </>
            )}
          </section>
        </TabsContent>

        <TabsContent value="alerts" className="mt-4">
          {alerts.isLoading ? (
            <LoadingBlock label="Loading alerts" />
          ) : !alerts.data || alerts.data.length === 0 ? (
            <EmptyState
              title="No alerts for this stock"
              description="Sample events for this symbol will appear here when they exist in the demo dataset."
            />
          ) : (
            <ul className="space-y-3">
              {alerts.data.map((a) => (
                <li key={a.id} className="panel p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={a.severity} />
                    <span className="text-sm font-medium">{a.headline}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{formatDate(a.createdAt)}</span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{a.summary}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Why it matters: </span>
                    {a.whyItMatters}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
