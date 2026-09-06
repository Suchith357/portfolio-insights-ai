import type { ReactNode } from "react";
import { Info, Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatCurrency, formatPct } from "@/lib/format";
import type { AiInsight } from "@/lib/ai-insights";
import type { Severity, SimulationDelta } from "@/types";

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
  score: number;
  betterWhenLower?: boolean;
  hint?: string;
}) {
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

function formatDeltaValue(value: number, unit: SimulationDelta["unit"]) {
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
