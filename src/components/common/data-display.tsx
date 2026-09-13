import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock, Info, Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { dataAge, formatCurrency, formatPct } from "@/lib/format";
import type { AiInsight } from "@/lib/ai-insights";
import type { Severity, SimulationDelta } from "@/types";
import { apiRequest } from "@/services/api-client";

/** Backend freshness payload shared by /analysis/overview meta and /analysis/market-freshness. */
export interface MarketFreshness {
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  running: boolean;
  dataSourceMix: { yahoo: number; demo: number };
}

/**
 * Platform-wide market-data freshness (header badge). Cached for a minute;
 * the backend computes it from three indexed lookups. Goes through the authed
 * API client — the endpoint requires a valid session.
 */
export function useMarketFreshnessQuery() {
  return useQuery({
    queryKey: ["market-freshness"],
    queryFn: () => apiRequest<MarketFreshness>("/analysis/market-freshness"),
    staleTime: 60_000,
    retry: 1,
  });
}

export function DemoDataBadge({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning",
            className,
          )}
        >
          <Info className="h-3 w-3" aria-hidden />
          Demo Data
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Synthetic sample prices and sample news for development. Not live market data.
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Provenance-aware market-data badge for pages whose figures come from the
 * platform's stored dataset. Replaces the old hard-coded "Demo Data" badge:
 * it reflects what the backend actually serves (Yahoo-synced real prices vs
 * legacy synthetic rows) and the freshness of the last sync.
 *
 * Pass `freshness` when the page already has it (e.g. /analysis/overview
 * meta) — otherwise the component fetches it itself.
 */
export function MarketDataBadge({
  freshness,
  className,
}: {
  freshness?: MarketFreshness | null;
  className?: string;
}) {
  const query = useMarketFreshnessQuery();
  const data = freshness ?? query.data;

  if (!data) {
    // Unknown (query still loading or endpoint failed) — honest neutral chip.
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground",
          className,
        )}
      >
        <Clock className="h-3 w-3" aria-hidden />
        Market data
      </span>
    );
  }

  const { lastSyncAt, lastSyncStatus, dataSourceMix } = data;
  const allYahoo = dataSourceMix.demo === 0 && dataSourceMix.yahoo > 0;
  const allDemo = dataSourceMix.yahoo === 0 && dataSourceMix.demo > 0;
  const age = dataAge(lastSyncAt);

  if (allDemo) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning",
              className,
            )}
          >
            <Info className="h-3 w-3" aria-hidden />
            Demo Data
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          Synthetic sample prices for development. Not live market data.
        </TooltipContent>
      </Tooltip>
    );
  }

  const label = allYahoo
    ? age.level === "none"
      ? "Live dataset"
      : age.level === "current" || age.level === "recent"
        ? "Live data"
        : "Stale data"
    : "Mixed data";
  const tone =
    allYahoo && age.level !== "stale"
      ? "border-gain/40 bg-gain/10 text-gain"
      : allYahoo
        ? "border-warning/50 bg-warning/10 text-warning"
        : "border-info/40 bg-info/10 text-info";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            tone,
            className,
          )}
        >
          <Clock className="h-3 w-3" aria-hidden />
          {label}
          {lastSyncStatus && lastSyncStatus !== "SUCCESS" && lastSyncStatus !== "RUNNING"
            ? ` (${lastSyncStatus.toLowerCase()})`
            : ""}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {dataSourceMix.yahoo > 0 && dataSourceMix.demo > 0
          ? `${dataSourceMix.yahoo} stocks on live Yahoo Finance data, ${dataSourceMix.demo} still on legacy demo prices.`
          : "Prices refresh from Yahoo Finance roughly every 45 minutes on the server."}
        {lastSyncAt
          ? ` Last completed sync ${age.label}${lastSyncStatus ? ` (${lastSyncStatus.toLowerCase()})` : ""}.`
          : " No completed sync recorded yet."}
        {data.running ? " A refresh is running right now." : ""}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Data-freshness badge: distinguishes current / recent / stale / unavailable
 * market data from the backend's own sync timestamps. Never claims "live".
 */
export function FreshnessBadge({
  syncedAt,
  status,
  className,
}: {
  syncedAt: string | null | undefined;
  status?: string | null;
  className?: string;
}) {
  const age = dataAge(syncedAt);
  const styles = {
    current: "border-gain/40 bg-gain/10 text-gain",
    recent: "border-info/40 bg-info/10 text-info",
    stale: "border-warning/50 bg-warning/10 text-warning",
    none: "border-border bg-muted text-muted-foreground",
  }[age.level];
  const label =
    age.level === "none"
      ? "No market data yet"
      : age.level === "current"
        ? `Market data: updated ${age.label}`
        : age.level === "recent"
          ? `Market data: ${age.label}`
          : `Stale data: last update ${age.label}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            styles,
            className,
          )}
        >
          <Clock className="h-3 w-3" aria-hidden />
          {label}
          {status && status !== "SUCCESS" ? ` (${status.toLowerCase()})` : ""}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Prices refresh from Yahoo Finance roughly every 45 minutes on the server. When the source is unavailable, the
        app keeps showing the most recent stored values and marks them stale — nothing is invented.
      </TooltipContent>
    </Tooltip>
  );
}

/** Small provenance chip: real (Yahoo) vs synthetic (demo) data source. */
export function DataSourceBadge({ dataSource, className }: { dataSource: string | null | undefined; className?: string }) {
  const real = dataSource === "YAHOO";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
            real ? "border-gain/40 bg-gain/10 text-gain" : "border-border bg-muted text-muted-foreground",
            className,
          )}
        >
          {real ? "Real data" : "Demo data"}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {real
          ? "Prices and fundamentals for this stock come from the free Yahoo Finance feed."
          : "This stock still carries synthetic demo prices; the market-data refresh has not replaced them yet."}
      </TooltipContent>
    </Tooltip>
  );
}

export function StatCard({
  label,
  value,
  sub,
  trend,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  trend?: number;
  tone?: "default" | "gain" | "loss" | "warning";
}) {
  const toneClass =
    tone === "gain" ? "text-gain" : tone === "loss" ? "text-loss" : tone === "warning" ? "text-warning" : "";
  return (
    <div className="panel p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("num mt-2 text-2xl font-semibold", toneClass)}>{value}</p>
      <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
        {typeof trend === "number" && (
          <span className={cn("num inline-flex items-center gap-0.5", trend >= 0 ? "text-gain" : "text-loss")}>
            {trend >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {formatPct(trend)}
          </span>
        )}
        {sub && <span>{sub}</span>}
      </div>
    </div>
  );
}

export function ScoreMeter({
  label,
  score,
  betterWhenLower = false,
  hint,
}: {
  label: string;
  /** null renders an explicit "insufficient data" state — never a fake 0. */
  score: number | null;
  betterWhenLower?: boolean;
  hint?: string;
}) {
  if (score === null) {
    return (
      <div className="panel p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="num mt-2 text-xl font-semibold text-muted-foreground">N/A</p>
        <p className="mt-2 text-xs text-muted-foreground">
          {hint ?? "Not yet measurable from the stored price history."}
        </p>
      </div>
    );
  }
  const good = betterWhenLower ? score < 45 : score > 60;
  const bad = betterWhenLower ? score > 70 : score < 35;
  return (
    <div className="panel p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p
          className={cn(
            "num text-xl font-semibold",
            good ? "text-gain" : bad ? "text-loss" : "text-warning",
          )}
        >
          {score.toFixed(1)}
          <span className="text-xs text-muted-foreground">/100</span>
        </p>
      </div>
      <Progress value={score} className="mt-3 h-2" />
      {hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const styles: Record<Severity, string> = {
    LOW: "border-border bg-muted text-muted-foreground",
    MEDIUM: "border-info/40 bg-info/10 text-info",
    HIGH: "border-warning/50 bg-warning/15 text-warning",
    CRITICAL: "border-destructive/60 bg-destructive/15 text-destructive",
  };
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide", styles[severity])}>
      {severity}
    </span>
  );
}

export function PnlText({ value, pct }: { value: number; pct?: number }) {
  const positive = value >= 0;
  return (
    <span className={cn("num font-medium", positive ? "text-gain" : "text-loss")}>
      {positive ? "+" : "−"}
      {formatCurrency(Math.abs(value))}
      {typeof pct === "number" && <span className="ml-1 text-xs">({formatPct(pct)})</span>}
    </span>
  );
}

export function AiInsightCard({ insight, compact = false }: { insight: AiInsight; compact?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-primary/25 bg-primary/5 p-4",
        compact && "p-3",
      )}
    >
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" aria-hidden />
        <p className="text-sm font-semibold">{insight.title}</p>
        <Badge variant="outline" className="ml-auto text-[10px] uppercase">
          AI explanation
        </Badge>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{insight.body}</p>
    </div>
  );
}

export function AiDisclaimer() {
  return (
    <p className="text-xs text-muted-foreground">
      AI insights explain figures produced by the analytics engine. They do not generate financial data and are not
      investment advice.
    </p>
  );
}

function formatDeltaValue(value: number | null, unit: SimulationDelta["unit"]) {
  if (value === null) return "N/A";
  if (unit === "currency") return formatCurrency(value, { compact: true });
  if (unit === "pct") return `${value.toFixed(2)}%`;
  return value.toFixed(1);
}

export function DeltaTable({ deltas }: { deltas: SimulationDelta[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Metric</th>
            <th className="py-2 pr-3 font-medium">Current</th>
            <th className="py-2 pr-3 font-medium">Simulated</th>
            <th className="py-2 font-medium">Change</th>
          </tr>
        </thead>
        <tbody>
          {deltas.map((d) => {
            if (d.before === null || d.after === null) {
              return (
                <tr key={d.label} className="border-b border-border/60 last:border-0">
                  <td className="py-2 pr-3">{d.label}</td>
                  <td className="num py-2 pr-3 text-muted-foreground">{formatDeltaValue(d.before, d.unit)}</td>
                  <td className="num py-2 pr-3">{formatDeltaValue(d.after, d.unit)}</td>
                  <td className="py-2 text-xs text-muted-foreground">Insufficient history</td>
                </tr>
              );
            }
            const diff = d.after - d.before;
            const improved = d.betterWhenLower ? diff < 0 : diff > 0;
            const neutral = Math.abs(diff) < 0.005;
            return (
              <tr key={d.label} className="border-b border-border/60 last:border-0">
                <td className="py-2 pr-3">{d.label}</td>
                <td className="num py-2 pr-3 text-muted-foreground">{formatDeltaValue(d.before, d.unit)}</td>
                <td className="num py-2 pr-3">{formatDeltaValue(d.after, d.unit)}</td>
                <td
                  className={cn(
                    "num py-2",
                    neutral ? "text-muted-foreground" : improved ? "text-gain" : "text-loss",
                  )}
                >
                  {neutral ? "—" : `${diff > 0 ? "+" : ""}${formatDeltaValue(diff, d.unit)}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}
