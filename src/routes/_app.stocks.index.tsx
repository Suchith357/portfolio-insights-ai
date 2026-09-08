import { useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRight, Search, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DemoDataBadge } from "@/components/common/data-display";
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/common/states";
import { formatCurrency, formatPct } from "@/lib/format";
import { getStockRiskProfile } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import * as stockService from "@/services/stock.service";

export const Route = createFileRoute("/_app/stocks/")({
  head: () => ({
    meta: [
      { title: "Stock Explorer — PortfolioIQ" },
      {
        name: "description",
        content:
          "Search, filter and sort the PortfolioIQ demo stock universe with sector, price, volatility and drawdown information.",
      },
      { property: "og:title", content: "Stock Explorer — PortfolioIQ" },
      {
        property: "og:description",
        content: "Browse the demo stock universe and open any symbol for full risk and return analysis.",
      },
    ],
  }),
  component: StocksPage,
});

type SortKey = "symbol" | "name" | "price-desc" | "price-asc" | "mcap-desc";

function StocksPage() {
  const [search, setSearch] = useState("");
  const [sector, setSector] = useState("all");
  const [sort, setSort] = useState<SortKey>("symbol");
  const [page, setPage] = useState(1);

  const sectors = useMemo(() => stockService.listSectors(), []);

  const query = useQuery({
    queryKey: ["stocks", search, sector, sort, page],
    queryFn: () => stockService.searchStocks({ search, sector, sort, page, pageSize: 9 }),
    placeholderData: keepPreviousData,
  });

  const data = query.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Stock Explorer</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Browse the demo stock universe, compare sectors and historical risk, then open a symbol to analyse it
            against your own portfolio.
          </p>
        </div>
        <DemoDataBadge />
      </div>

      <div className="panel grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative sm:col-span-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search by symbol or company name"
            aria-label="Search stocks"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <Select
          value={sector}
          onValueChange={(v) => {
            setSector(v);
            setPage(1);
          }}
        >
          <SelectTrigger aria-label="Filter by sector">
            <SelectValue placeholder="Sector" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sectors</SelectItem>
            {sectors.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger aria-label="Sort stocks">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="symbol">Symbol (A–Z)</SelectItem>
            <SelectItem value="name">Company name (A–Z)</SelectItem>
            <SelectItem value="price-desc">Price (high to low)</SelectItem>
            <SelectItem value="price-asc">Price (low to high)</SelectItem>
            <SelectItem value="mcap-desc">Market cap (high to low)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {query.isLoading ? (
        <CardsSkeleton count={6} />
      ) : query.isError ? (
        <ErrorState
          title="We couldn't load the stock list"
          description="The stock service didn't respond. Please try again."
          onRetry={() => query.refetch()}
        />
      ) : !data || data.rows.length === 0 ? (
        <EmptyState
          title="No stocks match your search"
          description="Try a different symbol, company name or sector filter."
          icon={<SearchX className="h-5 w-5" />}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSearch("");
                setSector("all");
                setPage(1);
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.rows.map((s) => {
              const change = s.lastPrice - s.previousClose;
              const changePct = s.previousClose ? (change / s.previousClose) * 100 : 0;
              const risk = getStockRiskProfile(s.symbol);
              return (
                <article key={s.id} className="panel flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        to="/stocks/$symbol"
                        params={{ symbol: s.symbol }}
                        className="num font-semibold hover:text-primary"
                      >
                        {s.symbol}
                      </Link>
                      <p className="truncate text-sm text-muted-foreground">{s.name}</p>
                    </div>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {s.sector}
                    </Badge>
                  </div>

                  <div className="flex items-baseline gap-2">
                    <span className="num text-lg font-semibold">{formatCurrency(s.lastPrice)}</span>
                    <span className={cn("num text-xs font-medium", change >= 0 ? "text-gain" : "text-loss")}>
                      {change >= 0 ? "+" : "−"}
                      {formatCurrency(Math.abs(change))} ({formatPct(changePct)})
                    </span>
                  </div>

                  <dl className="grid grid-cols-3 gap-2 border-t border-border/60 pt-3 text-xs">
                    <div>
                      <dt className="text-muted-foreground">Volatility</dt>
                      <dd className="num mt-0.5 font-medium">{risk.volatilityPct.toFixed(1)}%</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Max drawdown</dt>
                      <dd className="num mt-0.5 font-medium text-loss">{risk.maxDrawdownPct.toFixed(1)}%</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Risk band</dt>
                      <dd className="mt-0.5 font-medium">{risk.riskBand}</dd>
                    </div>
                  </dl>

                  <Button asChild size="sm" variant="outline" className="mt-auto w-full">
                    <Link to="/stocks/$symbol" params={{ symbol: s.symbol }}>
                      View details
                      <ArrowRight className="ml-1.5 h-4 w-4" />
                    </Link>
                  </Button>
                </article>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>
              Showing {(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} of{" "}
              {data.total} demo stocks
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={data.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span className="num text-xs">
                Page {data.page} / {data.pageCount}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={data.page >= data.pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
