import { useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DemoDataBadge, SeverityBadge } from "@/components/common/data-display";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { formatCurrency, formatDate, formatPct } from "@/lib/format";
import { getStock, getStockRiskProfile } from "@/lib/analytics";
import { STOCKS } from "@/lib/demo-data";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import * as watchlistService from "@/services/watchlist.service";
import * as alertService from "@/services/alert.service";

export const Route = createFileRoute("/_app/watchlist")({
  head: () => ({
    meta: [
      { title: "Watchlist — PortfolioIQ" },
      {
        name: "description",
        content: "Track stocks you are considering, with demo prices, volatility, drawdown and open alerts.",
      },
      { property: "og:title", content: "Watchlist — PortfolioIQ" },
      {
        property: "og:description",
        content: "Stocks you are watching before committing capital, with risk figures from the analytics engine.",
      },
    ],
  }),
  component: WatchlistPage,
});

function WatchlistPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [addSymbol, setAddSymbol] = useState("");
  const [error, setError] = useState<string | null>(null);

  const watchlist = useQuery({
    queryKey: ["watchlist", user?.id],
    queryFn: () => watchlistService.listWatchlist(user!.id),
    enabled: !!user,
  });

  const symbols = useMemo(() => (watchlist.data ?? []).map((w) => w.symbol), [watchlist.data]);

  const alerts = useQuery({
    queryKey: ["alerts", "watchlist", symbols.join(",")],
    queryFn: () => alertService.listAlertsForSymbols(symbols),
    enabled: symbols.length > 0,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["watchlist"] });

  const add = useMutation({
    mutationFn: (symbol: string) => watchlistService.addToWatchlist(user!.id, symbol),
    onSuccess: () => {
      setAddSymbol("");
      setError(null);
      invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => watchlistService.removeFromWatchlist(id),
    onSuccess: invalidate,
  });

  const available = STOCKS.filter((s) => !symbols.includes(s.symbol));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Watchlist</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Stocks you are tracking before committing capital. Risk figures come from the analytics engine on the demo
            price history.
          </p>
        </div>
        <DemoDataBadge />
      </div>

      <div className="panel flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-56 flex-1 space-y-1.5">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground" htmlFor="wl-add">
            Add a stock
          </label>
          <Select value={addSymbol} onValueChange={setAddSymbol}>
            <SelectTrigger id="wl-add">
              <SelectValue placeholder="Select a symbol" />
            </SelectTrigger>
            <SelectContent>
              {available.map((s) => (
                <SelectItem key={s.symbol} value={s.symbol}>
                  {s.symbol} — {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button disabled={!addSymbol || add.isPending} onClick={() => add.mutate(addSymbol)}>
          <Plus className="mr-1.5 h-4 w-4" />
          {add.isPending ? "Adding…" : "Add to watchlist"}
        </Button>
        {error && <p className="w-full text-xs text-destructive">{error}</p>}
      </div>

      {watchlist.isLoading ? (
        <TableSkeleton rows={4} />
      ) : watchlist.isError ? (
        <ErrorState
          title="We couldn't load your watchlist"
          description="Please try again in a moment."
          onRetry={() => watchlist.refetch()}
        />
      ) : !watchlist.data || watchlist.data.length === 0 ? (
        <EmptyState
          title="Your watchlist is empty"
          description="Add stocks you want to keep an eye on. They will show live demo prices, risk band and any open alerts."
          icon={<Eye className="h-5 w-5" />}
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/stocks">Browse stocks</Link>
            </Button>
          }
        />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Symbol</th>
                <th className="px-4 py-3 font-medium">Price</th>
                <th className="px-4 py-3 font-medium">Day change</th>
                <th className="px-4 py-3 font-medium">Volatility</th>
                <th className="px-4 py-3 font-medium">Risk band</th>
                <th className="px-4 py-3 font-medium">Alerts</th>
                <th className="px-4 py-3 font-medium">Added</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {watchlist.data.map((item) => {
                // API mode: the backend attaches stock metadata + analytics risk.
                // Demo mode: resolve from the in-browser dataset.
                const stock = item.stock ?? getStock(item.symbol);
                const risk = item.stock?.risk ?? getStockRiskProfile(item.symbol);
                const change = stock ? stock.lastPrice - stock.previousClose : 0;
                const changePct = stock && stock.previousClose ? (change / stock.previousClose) * 100 : 0;
                const stockAlerts = (alerts.data ?? []).filter((a) => a.symbol === item.symbol);
                const worst = stockAlerts[0];
                return (
                  <tr key={item.id} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-3">
                      <Link
                        to="/stocks/$symbol"
                        params={{ symbol: item.symbol }}
                        className="num font-medium hover:text-primary"
                      >
                        {item.symbol}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">{stock?.name ?? "Unknown stock"}</p>
                    </td>
                    <td className="num px-4 py-3">{stock ? formatCurrency(stock.lastPrice) : "—"}</td>
                    <td className={cn("num px-4 py-3", change >= 0 ? "text-gain" : "text-loss")}>
                      {formatPct(changePct)}
                    </td>
                    <td className="num px-4 py-3">{risk.volatilityPct.toFixed(1)}%</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="text-[10px]">
                        {risk.riskBand}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      {worst ? (
                        <span className="flex items-center gap-2">
                          <SeverityBadge severity={worst.severity} />
                          <span className="text-xs text-muted-foreground">{stockAlerts.length}</span>
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">None</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(item.addedAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${item.symbol} from watchlist`}
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(item.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
