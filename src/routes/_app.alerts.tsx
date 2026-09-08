import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BellOff, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
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
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/common/states";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import * as alertService from "@/services/alert.service";
import * as portfolioService from "@/services/portfolio.service";
import type { Severity } from "@/types";

export const Route = createFileRoute("/_app/alerts")({
  head: () => ({
    meta: [
      { title: "Alerts — PortfolioIQ" },
      {
        name: "description",
        content:
          "Sample risk and news events for the demo stock universe, ranked by severity and matched to your holdings.",
      },
      { property: "og:title", content: "Alerts — PortfolioIQ" },
      { property: "og:description", content: "Severity-ranked sample events affecting the stocks you hold." },
    ],
  }),
  component: AlertsPage,
});

const SEVERITY_RANK: Record<Severity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

const SEVERITY_ACCENT: Record<Severity, string> = {
  LOW: "border-l-border",
  MEDIUM: "border-l-info",
  HIGH: "border-l-warning",
  CRITICAL: "border-l-destructive",
};

function AlertsPage() {
  const { user } = useAuth();
  const userId = user?.id ?? "";
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState<"all" | Severity>("all");
  const [scope, setScope] = useState<"all" | "holdings">("all");

  const alerts = useQuery({
    queryKey: ["alerts"],
    queryFn: () => alertService.listAlerts(),
  });

  const holdings = useQuery({
    queryKey: ["dashboard", "holdings", userId],
    queryFn: () => portfolioService.getAggregateView(userId),
    enabled: !!userId,
  });

  const exposure = useMemo(() => {
    const map = new Map<string, number>();
    for (const h of holdings.data?.holdings ?? []) {
      map.set(h.symbol, (map.get(h.symbol) ?? 0) + h.allocationPct);
    }
    return map;
  }, [holdings.data]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (alerts.data ?? [])
      .filter((a) => (severity === "all" ? true : a.severity === severity))
      .filter((a) => (scope === "all" ? true : exposure.has(a.symbol)))
      .filter(
        (a) =>
          term === "" ||
          a.symbol.toLowerCase().includes(term) ||
          a.headline.toLowerCase().includes(term) ||
          a.eventType.toLowerCase().includes(term),
      )
      .sort(
        (a, b) =>
          SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
          +new Date(b.createdAt) - +new Date(a.createdAt),
      );
  }, [alerts.data, search, severity, scope, exposure]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Sample risk and news events for the demo universe. Each event shows its severity, why it matters and your
            exposure to the stock involved.
          </p>
        </div>
        <DemoDataBadge />
      </div>

      <div className="panel grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative sm:col-span-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search by symbol, headline or event type"
            aria-label="Search alerts"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={severity} onValueChange={(v) => setSeverity(v as "all" | Severity)}>
          <SelectTrigger aria-label="Filter by severity">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            <SelectItem value="CRITICAL">Critical</SelectItem>
            <SelectItem value="HIGH">High</SelectItem>
            <SelectItem value="MEDIUM">Medium</SelectItem>
            <SelectItem value="LOW">Low</SelectItem>
          </SelectContent>
        </Select>
        <Select value={scope} onValueChange={(v) => setScope(v as "all" | "holdings")}>
          <SelectTrigger aria-label="Filter by exposure">
            <SelectValue placeholder="Scope" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All demo stocks</SelectItem>
            <SelectItem value="holdings">Only stocks I hold</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {alerts.isLoading ? (
        <CardsSkeleton count={4} />
      ) : alerts.isError ? (
        <ErrorState
          title="We couldn't load alerts"
          description="The alerts service didn't respond. Please try again."
          onRetry={() => alerts.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No alerts match these filters"
          description="Clear the filters to see every sample event in the demo dataset."
          icon={<BellOff className="h-5 w-5" />}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSearch("");
                setSeverity("all");
                setScope("all");
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {rows.map((a) => {
            const pct = exposure.get(a.symbol);
            return (
              <article key={a.id} className={cn("panel border-l-4 p-4", SEVERITY_ACCENT[a.severity])}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="num font-semibold">{a.symbol}</span>
                      <Badge variant="outline" className="text-[10px] uppercase">
                        {a.eventType}
                      </Badge>
                      <SeverityBadge severity={a.severity} />
                    </div>
                    <h2 className="mt-1.5 font-medium">{a.headline}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{a.summary}</p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <p className="num">{formatDateTime(a.createdAt)}</p>
                    <p className="mt-1">{a.source}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3 text-xs">
                  <span className="text-muted-foreground">Why it matters:</span>
                  <span className="text-foreground">{a.whyItMatters}</span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {typeof pct === "number"
                    ? `Your exposure: ${pct.toFixed(1)}% of portfolio value.`
                    : "You currently hold no position in this stock."}
                </p>
              </article>
            );
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Alerts are synthetic sample events used for development. They are not live news and are not investment advice.
      </p>
    </div>
  );
}
