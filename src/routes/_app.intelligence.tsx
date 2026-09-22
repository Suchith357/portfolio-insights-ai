import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellRing,
  Brain,
  ChevronDown,
  ExternalLink,
  Eye,
  FlaskConical,
  HelpCircle,
  History,
  Minus,
  Newspaper,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MarketDataBadge, SectionHeader, SeverityBadge } from "@/components/common/data-display";
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/common/states";
import { formatDateTime, formatDate, formatCurrencyOrNull } from "@/lib/format";
import { Input } from "@/components/ui/input";

/** Inline INR delta for what-if results (keeps the +/− sign visible). */
function deltaInr(v: number): string {
  const s = formatCurrencyOrNull(v);
  return s === null ? "—" : v > 0 ? `+${s}` : s;
}
import * as intelligenceService from "@/services/intelligence.service";
import * as riskService from "@/services/risk.service";
import * as aiEventService from "@/services/ai-event.service";
import type { PortfolioImpact, EventDetail, IntelligenceAlert } from "@/services/intelligence.service";
import type { AnalogueResult } from "@/services/risk.service";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/intelligence")({
  head: () => ({
    meta: [
      { title: "Portfolio Intelligence — PortfolioIQ" },
      {
        name: "description",
        content:
          "News and market events mapped to your own holdings and watchlist, with transparent exposure, direction and confidence — never advice.",
      },
      { property: "og:title", content: "Portfolio Intelligence — PortfolioIQ" },
      {
        property: "og:description",
        content: "Portfolio-aware event intelligence: what happened, whether it touches your stocks, and why it may matter.",
      },
    ],
  }),
  component: IntelligencePage,
});

const DIRECTION_BADGE: Record<string, string> = {
  POSITIVE: "text-gain",
  NEGATIVE: "text-loss",
  MIXED: "text-warning",
  UNCERTAIN: "text-muted-foreground",
  NEUTRAL: "text-muted-foreground",
};

function DirectionIcon({ direction }: { direction: string | null }) {
  if (direction === "POSITIVE") return <TrendingUp className="h-4 w-4 text-gain" aria-hidden />;
  if (direction === "NEGATIVE") return <TrendingDown className="h-4 w-4 text-loss" aria-hidden />;
  if (direction === "MIXED") return <Minus className="h-4 w-4 text-warning" aria-hidden />;
  return <HelpCircle className="h-4 w-4 text-muted-foreground" aria-hidden />;
}

const EXPOSURE_LABEL: Record<string, string> = {
  DIRECT_HOLDING: "Direct holding",
  WATCHLIST: "On your watchlist",
  SECTOR_EXPOSURE: "Sector exposure",
  INDIRECT_EXPOSURE: "Indirect",
  MACRO_EXPOSURE: "Macro",
  COMPETITOR_EXPOSURE: "Competitor",
  SUPPLIER_EXPOSURE: "Supplier",
  CUSTOMER_EXPOSURE: "Customer",
  UNKNOWN: "Unconfirmed",
};

function confidenceLabel(confidence: number | null): string {
  if (confidence === null) return "Unknown";
  if (confidence >= 0.8) return "HIGH";
  if (confidence >= 0.55) return "MEDIUM";
  return "LOW";
}

function ImpactCard({ impact, onOpenEvent }: { impact: PortfolioImpact; onOpenEvent: (eventId: string) => void }) {
  const isWatchlist = impact.exposureType === "WATCHLIST";
  // Primary exposure depends on the row type: stock weight for holdings,
  // SECTOR weight for sector exposure (the affected basket), 0 for watchlist.
  const exposurePct =
    impact.exposureType === "SECTOR_EXPOSURE"
      ? (impact.sectorWeightPct ?? impact.userAggregateWeightPct ?? null)
      : (impact.portfolioWeightPct ?? impact.userAggregateWeightPct ?? impact.sectorWeightPct ?? (isWatchlist ? 0 : null));

  return (
    <article
      className={cn(
        "panel border-l-4 p-4",
        impact.severity === "CRITICAL"
          ? "border-l-destructive"
          : impact.severity === "HIGH"
            ? "border-l-warning"
            : impact.severity === "MEDIUM"
              ? "border-l-info"
              : "border-l-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={impact.severity as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"} />
        {impact.symbol && (
          <Link to="/stocks/$symbol" params={{ symbol: impact.symbol }} className="num text-sm font-semibold hover:underline">
            {impact.symbol}
          </Link>
        )}
        <Badge variant="outline" className="text-[10px]">
          {EXPOSURE_LABEL[impact.exposureType] ?? impact.exposureType}
        </Badge>
        {impact.eventCategory && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {impact.eventCategory.toLowerCase()}
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <DirectionIcon direction={impact.direction} />
          {impact.direction ?? "UNCERTAIN"}
        </span>
      </div>

      <h3 className="mt-2 line-clamp-2 text-sm font-medium">{impact.eventTitle}</h3>

      <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">{isWatchlist ? "Portfolio exposure" : "Your exposure"}</dt>
          <dd className="num mt-0.5 font-semibold">
            {exposurePct === null ? "N/A" : `${exposurePct.toFixed(1)}%`}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Portfolio</dt>
          <dd className="mt-0.5 font-medium">{impact.portfolioName ?? "All portfolios"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Relevance</dt>
          <dd className="num mt-0.5 font-medium">
            {impact.relevance === null ? "N/A" : `${Math.round(impact.relevance * 100)}%`}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Confidence</dt>
          <dd className="mt-0.5 font-medium">{confidenceLabel(impact.confidence)}</dd>
        </div>
      </dl>

      <p className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        <span className="font-semibold text-foreground">Why: </span>
        {impact.explanation}
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          Detected {formatDateTime(impact.eventDetectedAt)}
          {impact.priceAsOf ? ` · exposure priced as of ${impact.priceAsOf}` : " · exposure price unavailable"}
          . Descriptive analytics only — not investment advice.
        </p>
        <Button size="sm" variant="ghost" onClick={() => onOpenEvent(impact.eventId)}>
          View event evidence <ChevronDown className="ml-1 h-3.5 w-3.5 -rotate-90" aria-hidden />
        </Button>
      </div>
    </article>
  );
}

/** Priority alert row (Part E §1) — delivered intelligence alerts, unread first. */
function PriorityAlertRow({ alert, onOpen }: { alert: IntelligenceAlert; onOpen: (a: IntelligenceAlert) => void }) {
  return (
    <article
      className={cn(
        "panel border-l-4 p-4",
        alert.isRead ? "border-l-border" : alert.severity === "CRITICAL" ? "border-l-destructive" : "border-l-warning",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {!alert.isRead && <BellRing className="h-4 w-4 text-warning" aria-label="Unread" />}
        <SeverityBadge severity={alert.severity} />
        {alert.symbol && (
          <Link to="/stocks/$symbol" params={{ symbol: alert.symbol }} className="num text-sm font-semibold hover:underline">
            {alert.symbol}
          </Link>
        )}
        {alert.eventCategory && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {alert.eventCategory.toLowerCase()}
          </Badge>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(alert.createdAt)}</span>
      </div>
      <h3 className="mt-2 text-sm font-medium">{alert.title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{alert.message}</p>
      <div className="mt-2 flex items-center gap-2">
        {alert.eventId && (
          <Button size="sm" variant="ghost" onClick={() => onOpen(alert)}>
            View evidence
          </Button>
        )}
      </div>
    </article>
  );
}

function IntelligencePage() {
  const [severity, setSeverity] = useState<"all" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL">("all");
  const [exposureType, setExposureType] = useState<"all" | "DIRECT_HOLDING" | "WATCHLIST" | "SECTOR_EXPOSURE">("all");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const qc = useQueryClient();

  const impacts = useQuery({
    queryKey: ["intelligence", "impacts", severity, exposureType],
    queryFn: () =>
      intelligenceService.getMyImpacts({
        severity: severity === "all" ? undefined : severity,
        exposureType: exposureType === "all" ? undefined : exposureType,
        limit: 40,
      }),
  });

  const exposure = useQuery({
    queryKey: ["intelligence", "exposure"],
    queryFn: () => intelligenceService.getMyExposure(),
  });

  // Phase 3 sections
  const intelAlerts = useQuery({
    queryKey: ["intelligence", "alerts"],
    queryFn: () => intelligenceService.getMyIntelligenceAlerts(20),
  });
  const summary = useQuery({
    queryKey: ["intelligence", "summary"],
    queryFn: () => intelligenceService.getMySummary(),
  });
  const watchlistIds = new Set(exposure.data?.watchlistStockIds ?? []);
  const heldIds = new Set((exposure.data?.userAggregate ?? []).map((a) => a.stockId));

  const markRead = useMutation({
    mutationFn: (id: string) => intelligenceService.markIntelligenceAlertRead(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["intelligence", "alerts"] });
      void qc.invalidateQueries({ queryKey: ["intelligence", "summary"] });
    },
  });

  // Phase 6: evidence-backed portfolio-level intelligence summary.
  const portfoliosList = useQuery({
    queryKey: ["portfolios"],
    queryFn: () => import("@/services/portfolio.service").then((m) => m.listPortfolios("me")),
  });
  const [summaryPortfolioId, setSummaryPortfolioId] = useState("");
  const activeSummaryId = summaryPortfolioId || portfoliosList.data?.[0]?.id || "";
  const piSummary = useQuery({
    queryKey: ["intelligence", "portfolio-summary", activeSummaryId],
    queryFn: () => riskService.getPortfolioIntelligenceSummary(activeSummaryId),
    enabled: !!activeSummaryId,
  });

  const openEvent = (eventId: string | null) => {
    if (eventId) setSelectedEventId(eventId);
  };

  const impactList = impacts.data ?? [];
  const priorityAlerts = (intelAlerts.data ?? []).filter((a) => !a.isRead);
  const recentEvents = impactList;
  const watchlistImpacts = impactList.filter((i) => i.exposureType === "WATCHLIST");
  const sectorImpacts = impactList.filter((i) => i.exposureType === "SECTOR_EXPOSURE");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Brain className="h-6 w-6 text-primary" aria-hidden />
            Portfolio Intelligence
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            News and market events mapped to <strong>your</strong> holdings and watchlist. Exposure, direction and
            confidence are computed from PortfolioIQ's own data — they describe relevance, not predictions or advice.
          </p>
        </div>
        <MarketDataBadge />
      </div>

      {exposure.data && (
        <p className="text-xs text-muted-foreground">
          Exposure valued at latest stored prices
          {exposure.data.priceAsOf ? ` (${exposure.data.priceAsOf})` : ""}
          {exposure.data.stalePrices ? " — data is stale; latest available close was used." : "."} Total across{" "}
          {exposure.data.portfolios.length} portfolio{exposure.data.portfolios.length === 1 ? "" : "s"}:{" "}
          <span className="num font-medium text-foreground">
            ₹{exposure.data.portfolios.reduce((a, p) => a + p.totalValue, 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
          </span>
        </p>
      )}

      {selectedEventId && (
        <EventDetailPanel eventId={selectedEventId} onClose={() => setSelectedEventId(null)} />
      )}

      {/* 0. PORTFOLIO INTELLIGENCE SUMMARY (Phase 6) ------------------------- */}
      <section className="space-y-3">
        <SectionHeader
          title="Portfolio intelligence summary"
          description="Evidence-backed statements computed from your holdings, recent events and the risk engine. Every number traces to stored data."
        />
        <div className="flex items-center gap-2">
          <Select value={activeSummaryId} onValueChange={setSummaryPortfolioId}>
            <SelectTrigger className="h-8 w-52"><SelectValue placeholder="Portfolio" /></SelectTrigger>
            <SelectContent>
              {(portfoliosList.data ?? []).map((po: { id: string; name: string }) => (
                <SelectItem key={po.id} value={po.id}>{po.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {piSummary.data && <Badge variant="outline" className="text-[10px]">{piSummary.data.modelVersion}</Badge>}
        </div>
        {piSummary.isLoading ? (
          <CardsSkeleton count={1} />
        ) : piSummary.isError || !piSummary.data ? (
          <ErrorState title="Summary failed" onRetry={() => piSummary.refetch()} />
        ) : (
          <div className="panel space-y-2 p-4">
            {piSummary.data.statements.map((s, i) => (
              <div key={i} className="rounded-md bg-muted/30 px-3 py-2">
                <p className="text-sm">{s.text}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Evidence: {s.evidence}</p>
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">
              Window: last {piSummary.data.provenance.recentEventWindowDays} days · {piSummary.data.provenance.holdings} holdings · generated {formatDateTime(piSummary.data.generatedAt)}
            </p>
          </div>
        )}
      </section>

      {/* 1. PRIORITY ALERTS ------------------------------------------------- */}
      <section className="space-y-3">
        <SectionHeader
          title="Priority alerts"
          description="Delivered intelligence alerts for events that passed the relevance, severity and confidence gates. One alert per event — no news spam."
        />
        {intelAlerts.isLoading ? (
          <CardsSkeleton count={2} />
        ) : intelAlerts.isError ? (
          <ErrorState title="We couldn't load your intelligence alerts" onRetry={() => intelAlerts.refetch()} />
        ) : (intelAlerts.data ?? []).length === 0 ? (
          <EmptyState
            icon={<BellRing className="h-8 w-8" aria-hidden />}
            title="No intelligence alerts yet"
            description="When a material event touches your holdings, one prioritized alert appears here and in your Alerts page."
          />
        ) : (
          <div className="space-y-3">
            {(intelAlerts.data ?? []).map((a) => (
              <PriorityAlertRow key={a.id} alert={a} onOpen={(al) => openEvent(al.eventId)} />
            ))}
          </div>
        )}
      </section>

      {/* 2. RECENT EVENTS ---------------------------------------------------- */}
      <section className="space-y-3">
        <SectionHeader title="Recent events" description="Chronological feed of events mapped to your exposure." />
        <div className="flex flex-wrap items-center gap-3">
          <Select value={severity} onValueChange={(v) => setSeverity(v as typeof severity)}>
            <SelectTrigger className="w-40" aria-label="Filter by severity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              <SelectItem value="CRITICAL">Critical</SelectItem>
              <SelectItem value="HIGH">High</SelectItem>
              <SelectItem value="MEDIUM">Medium</SelectItem>
              <SelectItem value="LOW">Low</SelectItem>
            </SelectContent>
          </Select>
          <Select value={exposureType} onValueChange={(v) => setExposureType(v as typeof exposureType)}>
            <SelectTrigger className="w-48" aria-label="Filter by exposure type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All exposures</SelectItem>
              <SelectItem value="DIRECT_HOLDING">Direct holdings</SelectItem>
              <SelectItem value="WATCHLIST">Watchlist</SelectItem>
              <SelectItem value="SECTOR_EXPOSURE">Sector exposure</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {impacts.data ? `${impactList.length} impact(s)` : ""}
          </span>
        </div>
        {impacts.isLoading ? (
          <CardsSkeleton count={3} />
        ) : impacts.isError ? (
          <ErrorState title="We couldn't load your portfolio intelligence" onRetry={() => impacts.refetch()} />
        ) : recentEvents.length === 0 ? (
          <EmptyState
            icon={<Eye className="h-10 w-10" aria-hidden />}
            title="No portfolio-mapped events yet"
            description="When news linked to your holdings or watchlist is ingested and processed, it appears here. Admins can run mapping from the console."
          />
        ) : (
          <div className="space-y-4">
            {recentEvents.map((impact) => (
              <ImpactCard key={impact.id} impact={impact} onOpenEvent={openEvent} />
            ))}
          </div>
        )}
      </section>

      {/* 3 + 4. WATCHLIST & SECTOR/MACRO ------------------------------------ */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel space-y-3 p-4">
          <SectionHeader
            title="Watchlist intelligence"
            description="Events affecting stocks you monitor — not holdings. Relevant, not advice."
          />
          {watchlistImpacts.length === 0 ? (
            <EmptyState
              icon={<Eye className="h-6 w-6" aria-hidden />}
              title="No watchlist events"
              description="Events linked to watched stocks will appear here."
            />
          ) : (
            <ul className="space-y-2">
              {watchlistImpacts.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <SeverityBadge severity={i.severity as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"} />
                  {i.symbol && (
                    <Link to="/stocks/$symbol" params={{ symbol: i.symbol }} className="num font-medium hover:underline">
                      {i.symbol}
                    </Link>
                  )}
                  <span className="line-clamp-1 text-muted-foreground">{i.eventTitle}</span>
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => openEvent(i.eventId)}>
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel space-y-3 p-4">
          <SectionHeader
            title="Sector & macro events"
            description="Broader events that may indirectly touch your portfolio through sector exposure."
          />
          {sectorImpacts.length === 0 ? (
            <EmptyState
              icon={<Newspaper className="h-6 w-6" aria-hidden />}
              title="No sector-level events"
              description="Sector-linked events show as indirect exposure here — never as direct company claims."
            />
          ) : (
            <ul className="space-y-2">
              {sectorImpacts.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <SeverityBadge severity={i.severity as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"} />
                  <Badge variant="outline" className="text-[10px]">
                    {i.symbol ?? "sector"}
                  </Badge>
                  <span className="num font-medium">
                    {i.sectorWeightPct === null ? "N/A" : `${i.sectorWeightPct.toFixed(1)}% sector`}
                  </span>
                  <span className="line-clamp-1 text-muted-foreground">{i.eventTitle}</span>
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => openEvent(i.eventId)}>
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* 5. EXPOSURE SUMMARY ------------------------------------------------- */}
      <section className="panel space-y-3 p-4">
        <SectionHeader
          title="Exposure summary"
          description="Your per-stock exposure with relevant-event counts. Exposure is allocation, not risk contribution."
        />
        {summary.isLoading ? (
          <CardsSkeleton count={2} />
        ) : summary.isError ? (
          <ErrorState title="We couldn't load your exposure summary" onRetry={() => summary.refetch()} />
        ) : !summary.data || summary.data.stockSummaries.length === 0 ? (
          <EmptyState title="Nothing to summarise yet" description="Impacts appear once events are mapped to your holdings." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Stock</th>
                  <th className="px-3 py-2 font-medium">Exposure</th>
                  <th className="px-3 py-2 font-medium">Relevant events</th>
                  <th className="px-3 py-2 font-medium">Latest severity</th>
                  <th className="px-3 py-2 font-medium">Direction</th>
                </tr>
              </thead>
              <tbody>
                {summary.data.stockSummaries.map((s) => (
                  <tr key={s.stockId} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2">
                      <Link to="/stocks/$symbol" params={{ symbol: s.symbol }} className="num font-medium hover:underline">
                        {s.symbol}
                      </Link>
                      {watchlistIds.has(s.stockId) && !heldIds.has(s.stockId) && (
                        <Badge variant="outline" className="ml-2 text-[10px]">
                          watching
                        </Badge>
                      )}
                    </td>
                    <td className="num px-3 py-2">{s.exposurePct === null ? "N/A" : `${s.exposurePct.toFixed(1)}%`}</td>
                    <td className="num px-3 py-2">{s.relevantEvents}</td>
                    <td className="px-3 py-2">
                      {s.latestSeverity ? <SeverityBadge severity={s.latestSeverity as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"} /> : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <span className={cn("flex items-center gap-1", DIRECTION_BADGE[s.latestDirection ?? ""] ?? "text-muted-foreground")}>
                        <DirectionIcon direction={s.latestDirection} />
                        {s.latestDirection ?? "—"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {summary.data && (
          <p className="text-xs text-muted-foreground">
            {summary.data.alerts.unread} unread intelligence alert{summary.data.alerts.unread === 1 ? "" : "s"} of{" "}
            {summary.data.alerts.total} delivered.
          </p>
        )}
      </section>
    </div>
  );
}

/** Event detail (Part E): summary, evidence, affected entities, my exposure. */
function EventDetailPanel({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ["intelligence", "event", eventId],
    queryFn: () => intelligenceService.getEventDetail(eventId),
  });

  return (
    <section className="panel space-y-4 p-5" data-testid="event-detail">
      {detail.isLoading ? (
        <CardsSkeleton count={2} />
      ) : detail.isError || !detail.data ? (
        <ErrorState title="We couldn't load that event" onRetry={() => detail.refetch()} />
      ) : (
        <EventDetailBody d={detail.data} onClose={onClose} />
      )}
    </section>
  );
}

/**
 * Similar historical events (Phase 5A) — observed reactions with quality
 * classification. Descriptive only: never a prediction.
 */
/**
 * Phase 6: event intelligence package + one-click What-If. Composes the
 * orchestration API (exposure, analogues, suggested scenarios) and lets the
 * user run a suggested (or edited) shock through the existing scenario engine.
 */
function WhatIfPanel({ eventId }: { eventId: string }) {
  const portfolios = useQuery({
    queryKey: ["portfolios"],
    queryFn: () => import("@/services/portfolio.service").then((m) => m.listPortfolios("me")),
  });
  const [portfolioId, setPortfolioId] = useState("");
  const activeId = portfolioId || portfolios.data?.[0]?.id || "";
  const pkg = useQuery({
    queryKey: ["intelligence", "event-intel", eventId, activeId],
    queryFn: () => riskService.getEventIntelligence(eventId, activeId || undefined),
    enabled: !!activeId,
  });
  const [selected, setSelected] = useState<number | null>(null);
  const [shockPct, setShockPct] = useState("");
  const run = useMutation({
    mutationFn: (shocks: riskService.ScenarioShock[]) => riskService.runEventScenario(eventId, activeId, shocks),
  });

  if (portfolios.isLoading || pkg.isLoading) return null;
  if (pkg.isError || !pkg.data) return null;
  const p = pkg.data;
  const sc = selected !== null ? p.suggestedScenarios[selected] : undefined;

  const execute = () => {
    if (!sc) return;
    const shock: riskService.ScenarioShock =
      sc.kind === "SECTOR"
        ? { sector: sc.sector!, shockPct: Number(shockPct || sc.shockPct) }
        : { stockId: sc.stockId!, shockPct: Number(shockPct || sc.shockPct) };
    run.mutate([shock]);
  };

  return (
    <div className="rounded-md border border-border/70 p-3" data-testid="what-if">
      <div className="flex flex-wrap items-center gap-2">
        <FlaskConical className="h-3.5 w-3.5 text-primary" aria-hidden />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What-if this happens?</span>
        <Badge variant="outline" className="ml-auto text-[10px]">{p.modelVersion}</Badge>
      </div>

      <div className="mt-2 grid gap-1 text-xs">
        <p>
          <span className="font-medium">My exposure: </span>
          {p.myExposure.exposurePctOfPortfolio !== null
            ? `${p.myExposure.exposurePctOfPortfolio}% of portfolio value in affected holdings`
            : p.myExposure.reason ?? "No holdings in the affected stocks."}
        </p>
        {p.evidenceNote && <p className="text-muted-foreground">{p.evidenceNote}</p>}
      </div>

      {p.suggestedScenarios.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {p.suggestedScenarios.map((s, i) => (
            <button
              key={s.label}
              type="button"
              onClick={() => {
                setSelected(i);
                setShockPct(String(s.shockPct));
                run.reset();
              }}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] transition",
                selected === i ? "border-primary bg-primary/10 text-primary" : "border-border/70 text-muted-foreground hover:border-primary/50",
              )}
              title={s.rationale}
            >
              {s.label}
              {s.basis === "HISTORICAL_EVIDENCE" && <span className="ml-1 text-[9px] text-warning">EVIDENCE</span>}
            </button>
          ))}
        </div>
      )}

      {sc && (
        <div className="mt-3 space-y-2">
          <p className="text-[11px] text-muted-foreground">
            {sc.basis === "HISTORICAL_EVIDENCE"
              ? "Level based on observed historical reactions to similar events — not a forecast."
              : sc.basis === "EVENT_CHARACTERISTICS"
                ? "Level suggested from the event's sector/entity characteristics — not a forecast."
                : "System stress assumption — not based on observed evidence, not a forecast."}{" "}
            You can edit the shock before running.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-24"
              value={shockPct}
              onChange={(e) => setShockPct((e.target as HTMLInputElement).value)}
              inputMode="numeric"
              aria-label="Shock percentage"
            />
            <span className="text-xs text-muted-foreground">%</span>
            <Select value={activeId} onValueChange={setPortfolioId}>
              <SelectTrigger className="h-8 w-44"><SelectValue placeholder="Portfolio" /></SelectTrigger>
              <SelectContent>
                {(portfolios.data ?? []).map((po: { id: string; name: string }) => (
                  <SelectItem key={po.id} value={po.id}>{po.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={execute} disabled={run.isPending || !activeId}>
              {run.isPending ? "Running…" : "Run What-If"}
            </Button>
          </div>
          {run.isError && (
            <p className="text-xs text-loss">{run.error instanceof Error ? run.error.message : "Scenario failed."}</p>
          )}
          {run.data && (
            <div className="rounded-md bg-muted/40 px-3 py-2 text-xs">
              <p>
                <span className="font-medium">Direct shock estimate: </span>
                <span className={cn("num font-semibold", run.data.impact.portfolioImpactPct >= 0 ? "text-gain" : "text-loss")}>
                  {run.data.impact.portfolioImpactPct >= 0 ? "+" : ""}{run.data.impact.portfolioImpactPct.toFixed(2)} pp
                </span>{" "}
                ({run.data.impact.valueDelta === null ? "—" : deltaInr(run.data.impact.valueDelta)}) · priced as of {run.data.pricedAsOf ?? "N/A"}
              </p>
              <p className="mt-1 text-muted-foreground">{run.data.disclaimer}</p>
            </div>
          )}
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">{p.disclaimer}</p>
    </div>
  );
}

/**
 * AI assessment (Prompt 2+3, Feature B). On-demand: the user explicitly asks
 * for the grounded AI reading. The backend gates the LLM behind the
 * deterministic importance score and the grounding gate — when either
 * refuses, this panel shows the honest reason instead of a fabricated claim.
 */
function AiAssessmentPanel({ eventId }: { eventId: string }) {
  const [opened, setOpened] = useState(false);
  const analyze = useMutation({
    mutationFn: () => aiEventService.analyzeEvent(eventId),
    onSuccess: () => setOpened(true),
  });
  const outcome = analyze.data;
  const a = outcome?.assessment ?? null;

  if (!opened) {
    return (
      <div className="rounded-md border border-dashed px-3 py-2">
        <p className="text-xs text-muted-foreground">
          AI assessment (optional): a locally-run, evidence-grounded reading of this event. It only runs when the
          event passes the importance gate, and every claim must cite retrieved evidence — otherwise it refuses to
          answer. Not a prediction; never investment advice.
        </p>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => analyze.mutate()} disabled={analyze.isPending}>
          {analyze.isPending ? "Analysing…" : "Run AI assessment"}
        </Button>
        {analyze.isError && (
          <p className="mt-1 text-xs text-loss">AI assessment failed: {(analyze.error as Error).message}</p>
        )}
      </div>
    );
  }

  if (!a) {
    return (
      <div className="rounded-md bg-muted/40 px-3 py-2 text-xs">
        <span className="font-semibold">No AI assessment: </span>
        {outcome?.reason ?? "unavailable"}. The deterministic analysis above remains the authoritative view.
      </div>
    );
  }

  const dirBadge =
    a.direction === "POSITIVE" ? "text-gain" : a.direction === "NEGATIVE" ? "text-loss" : "text-muted-foreground";

  return (
    <div className="rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">AI assessment</h3>
        <Badge variant="outline" className="text-[10px]">importance {a.importance}</Badge>
        <Badge variant="outline" className={cn("text-[10px]", dirBadge)}>{a.direction.toLowerCase()}</Badge>
        <Badge variant="outline" className="text-[10px]">{a.recommendation}</Badge>
        {a.affectedStock && <Badge variant="outline" className="text-[10px]">{a.affectedStock}</Badge>}
      </div>
      <p className="mt-2 text-sm">{a.eventSummary}</p>
      <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
        <p><span className="font-medium text-foreground">Why it matters: </span>{a.whyItMatters}</p>
        <p><span className="font-medium text-foreground">Portfolio impact: </span>{a.portfolioImpact}</p>
        {a.keyFactors.length > 0 && (
          <p><span className="font-medium text-foreground">Key factors: </span>{a.keyFactors.join(" · ")}</p>
        )}
        {a.whatToMonitor.length > 0 && (
          <p><span className="font-medium text-foreground">What to monitor: </span>{a.whatToMonitor.join(" · ")}</p>
        )}
        {a.evidence.length > 0 && (
          <p>
            <span className="font-medium text-foreground">Evidence: </span>
            {a.evidence.map((e) => `[${e.evidenceId}] ${e.title} — ${e.source}`).join(" | ")}
          </p>
        )}
        <p className="text-[11px] opacity-80">
          Evidence coverage {(a.confidence * 100).toFixed(0)}% · generated locally by Qwen3-4B from the retrieved
          evidence only · may/uncertain language by design · not investment advice.
        </p>
      </div>
    </div>
  );
}

function AnaloguesPanel({ eventId }: { eventId: string }) {
  const analogues = useQuery({
    queryKey: ["intelligence", "analogues", eventId],
    queryFn: () => riskService.getAnalogues(eventId),
  });

  if (analogues.isLoading) return null;
  if (analogues.isError || !analogues.data || analogues.data.analogues.length === 0) return null;
  const data: AnalogueResult = analogues.data;

  return (
    <div className="rounded-md border border-border/70 p-3" data-testid="analogues">
      <div className="flex flex-wrap items-center gap-2">
        <History className="h-3.5 w-3.5 text-primary" aria-hidden />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Similar historical events ({data.analogues.length})
        </span>
        <Badge
          variant="outline"
          className={cn(
            "ml-auto text-[10px]",
            data.quality === "HIGH" ? "border-gain/40 text-gain" : data.quality === "MEDIUM" ? "border-warning/50 text-warning" : "text-muted-foreground",
          )}
        >
          {data.quality} quality
        </Badge>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{data.qualityReason}</p>
      <ul className="mt-2 space-y-2">
        {data.analogues.map((a) => (
          <li key={a.eventId} className="rounded-md bg-muted/30 px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-[10px]">{a.category.toLowerCase()}</Badge>
              <span className="line-clamp-1">{a.title}</span>
              <span className="num ml-auto text-[11px] text-muted-foreground">
                similarity {Math.round(a.similarity * 100)}%
              </span>
            </div>
            {a.matchedOn.length > 0 && (
              <p className="mt-1 text-[11px] text-muted-foreground">Matched on: {a.matchedOn.join(", ")}</p>
            )}
            <div className="mt-1.5 flex flex-wrap gap-2">
              {a.reaction.map((r) => (
                <span key={r.window} className="rounded bg-background/60 px-2 py-0.5 text-[11px]">
                  {r.window}D: {r.available ? (
                    <>
                      median <span className={cn("num font-semibold", (r.medianPct ?? 0) >= 0 ? "text-gain" : "text-loss")}>
                        {(r.medianPct ?? 0) >= 0 ? "+" : ""}{r.medianPct?.toFixed(1)}%
                      </span>
                      <span className="text-muted-foreground"> ({r.sampleSize} obs)</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">{r.reason ?? "unavailable"}</span>
                  )}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-muted-foreground">{data.disclaimer}</p>
    </div>
  );
}

function EventDetailBody({ d, onClose }: { d: EventDetail; onClose: () => void }) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{d.category}</Badge>
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {d.status.toLowerCase()}
            </Badge>
            {d.severity !== null && (
              <Badge variant="outline" className="text-[10px]">
                severity {d.severity}/5
              </Badge>
            )}
            {d.materialUpdates > 0 && (
              <Badge variant="outline" className="text-[10px] text-warning">
                {d.materialUpdates} material update{d.materialUpdates === 1 ? "" : "s"}
              </Badge>
            )}
          </div>
          <h2 className="mt-2 text-lg font-semibold leading-snug">{d.title}</h2>
          {d.summary && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{d.summary}</p>}
          <p className="mt-1 text-xs text-muted-foreground">
            Detected {formatDateTime(d.detectedAt)}
            {d.eventTime ? ` · published ${formatDateTime(d.eventTime)}` : ""} · {d.evidence.articles.length} linked
            source{d.evidence.articles.length === 1 ? "" : "s"}
            {d.articleCount > d.evidence.articles.length
              ? ` (${d.articleCount - d.evidence.articles.length} expired under retention)`
              : ""}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* WHAT HAPPENED + AFFECTED */}
        <div className="space-y-4">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Affected companies</h3>
            {d.affectedStocks.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">No specific companies linked.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {d.affectedStocks.map((s) => (
                  <li key={s.stockId + (s.symbol ?? "")} className="flex flex-wrap items-center gap-2 text-sm">
                    {s.symbol && (
                      <Link to="/stocks/$symbol" params={{ symbol: s.symbol }} className="num font-medium hover:underline">
                        {s.symbol}
                      </Link>
                    )}
                    <Badge variant="outline" className="text-[10px]">
                      {s.relationshipType === "SECTOR" ? "sector link" : "direct link"}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      {s.matchConfidence ?? "UNRATED"} match
                    </Badge>
                    <span className="text-xs text-muted-foreground">“{s.entityName}”</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Affected sectors</h3>
            {d.affectedSectors.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">None recorded.</p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {d.affectedSectors.map((sec) => (
                  <Badge key={sec} variant="outline" className="text-[10px]">
                    {sec}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Your exposure</h3>
            {d.myImpacts.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                No connection to your holdings or watchlist was found for this event.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {d.myImpacts.map((i) => (
                  <li key={i.impactId} className="rounded-md bg-muted/40 px-3 py-2 text-xs">
                    <span className="font-medium">{EXPOSURE_LABEL[i.exposureType] ?? i.exposureType}</span>
                    {i.portfolioName ? ` · ${i.portfolioName}` : " · all portfolios"} ·{" "}
                    <span className="num">
                      {i.portfolioWeightPct !== null
                        ? `${i.portfolioWeightPct.toFixed(1)}% of portfolio`
                        : i.sectorWeightPct !== null
                          ? `${i.sectorWeightPct.toFixed(1)}% sector weight`
                          : "weight unavailable"}
                    </span>{" "}
                    · direction {i.direction ?? "UNCERTAIN"} · severity {i.severity}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* SOURCE EVIDENCE */}
        <div className="space-y-4">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Source evidence ({d.evidence.articles.length})
            </h3>
            {d.evidence.articles.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Source articles have expired under the retention policy — this summary remains as event record.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {d.evidence.articles.map((a) => (
                  <li key={a.articleId} className="text-sm">
                    <a href={a.url} target="_blank" rel="noopener noreferrer" className="line-clamp-2 hover:underline">
                      {a.title} <ExternalLink className="inline h-3 w-3" aria-hidden />
                    </a>
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      · {a.sourceName ?? "unknown source"} · {formatDate(a.publishedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-md bg-muted/40 px-3 py-2 text-xs">
            <span className="font-semibold text-foreground">Confidence: </span>
            {confidenceLabel(d.confidence)} — this describes how strongly the event maps to the affected stocks, not a
            prediction of any price move. No future performance is implied.
          </div>
          <AiAssessmentPanel eventId={d.eventId} />
          <AnaloguesPanel eventId={d.eventId} />
          <WhatIfPanel eventId={d.eventId} />
        </div>
      </div>
    </>
  );
}
