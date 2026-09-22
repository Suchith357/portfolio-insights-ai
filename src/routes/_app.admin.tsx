import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarketDataBadge, SectionHeader, StatCard } from "@/components/common/data-display";
import { CardsSkeleton, EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { ErrorState as Forbidden } from "@/components/common/states";
import { formatCurrency, formatCurrencyOrNull, formatDateTime, formatDate } from "@/lib/format";
import { useAuth } from "@/hooks/use-auth";
import * as adminService from "@/services/admin.service";

export const Route = createFileRoute("/_app/admin")({
  head: () => ({
    meta: [
      { title: "Admin console — PortfolioIQ" },
      {
        name: "description",
        content: "Platform statistics, user accounts, managed stock catalogue and audit trail for PortfolioIQ administrators.",
      },
      { property: "og:title", content: "Admin console — PortfolioIQ" },
      {
        property: "og:description",
        content: "Administrator view of users, stock catalogue and audit history.",
      },
    ],
  }),
  component: AdminPage,
});

function AdminPage() {
  const { isAdmin, ready } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (ready && !isAdmin) navigate({ to: "/dashboard", replace: true });
  }, [ready, isAdmin, navigate]);

  if (!ready) return <CardsSkeleton count={4} />;

  if (!isAdmin) {
    return (
      <Forbidden
        variant="forbidden"
        title="Admin access required"
        description="This area is restricted to administrator accounts."
      />
    );
  }

  return <AdminConsole />;
}

function AdminConsole() {
  const [userQuery, setUserQuery] = useState("");
  const [stockQuery, setStockQuery] = useState("");
  const qc = useQueryClient();

  const stats = useQuery({ queryKey: ["admin", "stats"], queryFn: adminService.getStats });
  const [users, stocks, audit] = useQueries({
    queries: [
      { queryKey: ["admin", "users"], queryFn: adminService.listUsers },
      { queryKey: ["admin", "stocks"], queryFn: adminService.listManagedStocks },
      { queryKey: ["admin", "audit"], queryFn: adminService.listAuditLog },
    ],
  });

  const filteredUsers = (users.data ?? []).filter((u) =>
    `${u.name} ${u.email} ${u.role}`.toLowerCase().includes(userQuery.trim().toLowerCase()),
  );
  const filteredStocks = (stocks.data ?? []).filter((s) =>
    `${s.symbol} ${s.name} ${s.sector}`.toLowerCase().includes(stockQuery.trim().toLowerCase()),
  );

  const syncStatus = useQuery({
    queryKey: ["admin", "market-data"],
    queryFn: adminService.getMarketDataStatus,
    refetchInterval: 30000,
  });
  const triggerSync = useMutation({
    mutationFn: (mode: "LATEST" | "FULL") => adminService.triggerMarketDataSync(mode, mode === "FULL"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "market-data"] });
      window.setTimeout(() => void qc.invalidateQueries({ queryKey: ["admin", "market-data"] }), 5000);
    },
  });

  const intelStatus = useQuery({
    queryKey: ["admin", "intelligence", "status"],
    queryFn: adminService.getIntelligenceStatus,
    refetchInterval: 30000,
  });
  const intelNews = useQuery({
    queryKey: ["admin", "intelligence", "news"],
    queryFn: () => adminService.getIntelligenceRecentNews(12),
  });
  const intelEvents = useQuery({
    queryKey: ["admin", "intelligence", "events"],
    queryFn: () => adminService.getIntelligenceRecentEvents(10),
  });
  const intelFetch = useMutation({
    mutationFn: () => adminService.triggerIntelligenceFetch(6),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "intelligence", "status"] });
      window.setTimeout(() => void qc.invalidateQueries({ queryKey: ["admin", "intelligence"] }), 8000);
    },
  });
  const intelCleanup = useMutation({
    mutationFn: () => adminService.triggerIntelligenceCleanup(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "intelligence"] });
    },
  });

  const last = syncStatus.data?.last ?? null;
  const syncBadgeTone =
    !last || last.status === "FAILED"
      ? "text-loss"
      : last.status === "PARTIAL"
        ? "text-warning"
        : "text-gain";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Admin console</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Platform statistics, user accounts, the managed stock catalogue and the audit trail. Route visibility is a
            convenience only — the backend must enforce the ADMIN role on every endpoint.
          </p>
        </div>
        <MarketDataBadge />
      </div>

      {stats.isLoading ? (
        <CardsSkeleton count={4} />
      ) : stats.isError ? (
        <ErrorState title="We couldn't load platform statistics" onRetry={() => stats.refetch()} />
      ) : stats.data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Users"
              value={String(stats.data.totalUsers)}
              sub={`${stats.data.userRoleUsers} user role · ${stats.data.adminUsers} admin`}
            />
            <StatCard label="Portfolios" value={String(stats.data.totalPortfolios)} />
            <StatCard label="Holdings" value={String(stats.data.totalHoldings)} />
            <StatCard label="Transactions" value={String(stats.data.totalTransactions)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Stocks in catalogue"
              value={String(stats.data.totalStocks)}
              sub={`${stats.data.stocksUsingRealData} on real market data`}
            />
            <StatCard label="Alerts published" value={String(stats.data.totalAlerts)} />
            <StatCard
              label="Market data"
              value={stats.data.lastMarketDataSync ? formatDateTime(stats.data.lastMarketDataSync) : "No sync yet"}
              {...(stats.data.lastMarketDataStatus ? { sub: `Last sync: ${stats.data.lastMarketDataStatus.toLowerCase()}` } : {})}
            />
          </div>
        </>
      ) : null}

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="stocks">Stock catalogue</TabsTrigger>
          <TabsTrigger value="market-data">Market data</TabsTrigger>
          <TabsTrigger value="intelligence">Intelligence</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="space-y-4 pt-4">
          <SectionHeader title="User accounts" description="Roles and account status across the platform." />
          <Input
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
            placeholder="Search by name, email or role"
            aria-label="Search users"
            className="max-w-sm"
          />
          {users.isLoading ? (
            <TableSkeleton rows={5} />
          ) : users.isError ? (
            <ErrorState title="We couldn't load users" onRetry={() => users.refetch()} />
          ) : filteredUsers.length === 0 ? (
            <EmptyState title="No matching users" description="Try a different name, email or role." />
          ) : (
            <div className="panel overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">Email</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((u) => (
                    <tr key={u.id} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-3 font-medium">{u.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{u.email}</td>
                      <td className="px-4 py-3">
                        <Badge variant={u.role === "ADMIN" ? "default" : "outline"} className="text-[10px]">
                          {u.role}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(u.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="stocks" className="space-y-4 pt-4">
          <SectionHeader
            title="Managed stock catalogue"
            description="Reference data the analytics engine reads. Prices refresh from Yahoo Finance every ~45 minutes."
          />
          <Input
            value={stockQuery}
            onChange={(e) => setStockQuery(e.target.value)}
            placeholder="Search by symbol, name or sector"
            aria-label="Search stocks"
            className="max-w-sm"
          />
          {stocks.isLoading ? (
            <TableSkeleton rows={5} />
          ) : stocks.isError ? (
            <ErrorState title="We couldn't load the stock catalogue" onRetry={() => stocks.refetch()} />
          ) : filteredStocks.length === 0 ? (
            <EmptyState title="No matching stocks" description="Try a different symbol, company name or sector." />
          ) : (
            <div className="panel overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Symbol</th>
                    <th className="px-4 py-3 font-medium">Company</th>
                    <th className="px-4 py-3 font-medium">Sector</th>
                    <th className="px-4 py-3 font-medium">Exchange</th>
                    <th className="px-4 py-3 font-medium">Latest price</th>
                    <th className="px-4 py-3 font-medium">Market cap</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredStocks.map((s) => (
                    <tr key={s.id} className="border-b border-border/60 last:border-0">
                      <td className="num px-4 py-3 font-medium">{s.symbol}</td>
                      <td className="px-4 py-3 text-muted-foreground">{s.name}</td>
                      <td className="px-4 py-3">{s.sector}</td>
                      <td className="px-4 py-3 text-muted-foreground">{s.exchange}</td>
                      <td className="num px-4 py-3">{formatCurrencyOrNull(s.lastPrice)}</td>
                      <td className="num px-4 py-3">
                        {s.marketCapCr === null ? "N/A" : `₹${s.marketCapCr.toLocaleString("en-IN")} Cr`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="market-data" className="space-y-4 pt-4">
          <SectionHeader
            title="Market data pipeline"
            description="Prices and fundamentals refresh from Yahoo Finance every 45 minutes. One stock failing (e.g. no provider coverage) never aborts the run — it is recorded here."
          />
          {syncStatus.isLoading ? (
            <TableSkeleton rows={3} />
          ) : syncStatus.isError ? (
            <ErrorState title="We couldn't load sync status" onRetry={() => syncStatus.refetch()} />
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  onClick={() => triggerSync.mutate("LATEST")}
                  disabled={triggerSync.isPending || syncStatus.data?.running === true}
                >
                  {triggerSync.isPending
                    ? "Starting…"
                    : syncStatus.data?.running
                      ? "Sync running…"
                      : "Refresh now"}
                </Button>
                <span className="text-xs text-muted-foreground">
                  Fetches the latest ~10 trading days for all {stats.data?.totalStocks ?? 38} catalogue stocks.
                </span>
              </div>
              {!last ? (
                <EmptyState title="No sync recorded yet" description="The scheduler writes one row per run." />
              ) : (
                <div className="panel p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <Badge variant="outline" className="text-[10px]">
                      {last.triggerType} · {last.mode}
                    </Badge>
                    <span className={`num text-sm font-semibold ${syncBadgeTone}`}>{last.status}</span>
                    <span className="text-xs text-muted-foreground">
                      finished {last.finishedAt ? formatDateTime(last.finishedAt) : "—"}
                    </span>
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border/60 pt-4 text-sm sm:grid-cols-5">
                    {[
                      { label: "Stocks processed", value: String(last.stocksProcessed) },
                      { label: "Prices upserted", value: String(last.pricesUpserted) },
                      { label: "Fundamentals updated", value: String(last.fundamentalsUpdated) },
                      { label: "Failures", value: String(last.failures) },
                    ].map((s) => (
                      <div key={s.label}>
                        <dt className="text-xs text-muted-foreground">{s.label}</dt>
                        <dd className="num mt-0.5 font-medium">{s.value}</dd>
                      </div>
                    ))}
                  </dl>
                  {last.errorMessage && (
                    <p className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                      <span className="font-semibold">Failure detail:</span> {last.errorMessage}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="intelligence" className="space-y-4 pt-4">
          <SectionHeader
            title="News intelligence — Phase 1 foundation"
            description="Ephemeral news ingestion (deduplicated, TTL-bound, matched to the managed stock universe). Raw rows expire automatically; only structured events may outlive them."
          />
          {intelStatus.isLoading ? (
            <TableSkeleton rows={4} />
          ) : intelStatus.isError ? (
            <ErrorState title="We couldn't load intelligence status" onRetry={() => intelStatus.refetch()} />
          ) : intelStatus.data ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Badge
                  variant="outline"
                  className={`text-[10px] ${intelStatus.data.provider.available ? "text-gain" : "text-warning"}`}
                >
                  {intelStatus.data.provider.available
                    ? `Provider: ${intelStatus.data.provider.active}`
                    : "Provider unavailable"}
                </Badge>
                {intelStatus.data.provider.degradedFrom && (
                  <span className="text-xs text-warning">
                    degraded from {intelStatus.data.provider.degradedFrom} — {intelStatus.data.provider.issues.join(" ")}
                  </span>
                )}
                <Button
                  size="sm"
                  onClick={() => intelFetch.mutate()}
                  disabled={intelFetch.isPending || intelStatus.data.ingest.running}
                >
                  {intelFetch.isPending
                    ? "Starting…"
                    : intelStatus.data.ingest.running
                      ? "Fetch running…"
                      : "Fetch news now"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => intelCleanup.mutate()}
                  disabled={intelCleanup.isPending}
                >
                  {intelCleanup.isPending ? "Cleaning…" : "Run cleanup now"}
                </Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  label="Articles stored"
                  value={String(intelStatus.data.counts.articles)}
                  sub={`${intelStatus.data.counts.expiredArticles} awaiting cleanup`}
                />
                <StatCard
                  label="Matched entities"
                  value={String(intelStatus.data.counts.entities)}
                  sub="linked to catalogue stocks"
                />
                <StatCard
                  label="Basic events"
                  value={String(intelStatus.data.counts.events)}
                  sub={`${intelStatus.data.counts.expiredEvents} awaiting cleanup`}
                />
                <StatCard
                  label="Raw-news TTL"
                  value={`${intelStatus.data.retention.rawNewsRetentionHours}h`}
                  sub={`cleanup every ${intelStatus.data.retention.cleanupIntervalMinutes} min`}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Last fetch: {intelStatus.data.ingest.lastFetchAt ? formatDateTime(intelStatus.data.ingest.lastFetchAt) : "never"}
                {intelStatus.data.retention.nextFetchAt
                  ? ` · next scheduled: ${formatDateTime(intelStatus.data.retention.nextFetchAt)}`
                  : ""}
                {intelStatus.data.lastCleanup
                  ? ` · last cleanup ${formatDateTime(intelStatus.data.lastCleanup.ranAt)} removed ${intelStatus.data.lastCleanup.articlesDeleted} articles / ${intelStatus.data.lastCleanup.eventsDeleted} events`
                  : ""}
              </p>
              {intelNews.isLoading ? (
                <TableSkeleton rows={3} />
              ) : intelNews.isError ? (
                <ErrorState title="We couldn't load recent news" onRetry={() => intelNews.refetch()} />
              ) : (intelNews.data ?? []).length === 0 ? (
                <EmptyState
                  title="No news ingested yet"
                  description="Use “Fetch news now” or wait for the scheduled cycle."
                />
              ) : (
                <div className="panel overflow-x-auto">
                  <table className="w-full min-w-[680px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-3 font-medium">Published</th>
                        <th className="px-4 py-3 font-medium">Headline</th>
                        <th className="px-4 py-3 font-medium">Matched stocks</th>
                        <th className="px-4 py-3 font-medium">Expires</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(intelNews.data ?? []).map((a) => (
                        <tr key={a.id} className="border-b border-border/60 last:border-0">
                          <td className="px-4 py-3 text-xs text-muted-foreground">{formatDateTime(a.publishedAt)}</td>
                          <td className="px-4 py-3">
                            <a
                              href={a.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="line-clamp-1 hover:underline"
                            >
                              {a.title}
                            </a>
                            <span className="text-xs text-muted-foreground"> · {a.sourceName ?? a.provider}</span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1">
                              {a.matchedStocks.length === 0 ? (
                                <span className="text-xs text-muted-foreground">—</span>
                              ) : (
                                a.matchedStocks.map((m) => (
                                  <Badge key={`${a.id}-${m.symbol ?? m.entityName}`} variant="outline" className="text-[10px]">
                                    {m.symbol ?? m.entityName}
                                    {m.sentimentLabel ? ` · ${m.sentimentLabel.toLowerCase()}` : ""}
                                  </Badge>
                                ))
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">{formatDateTime(a.expiresAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {intelEvents.isError ? null : (intelEvents.data ?? []).length > 0 ? (
                <div className="panel p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Recent basic events</p>
                  <ul className="mt-2 space-y-2">
                    {(intelEvents.data ?? []).map((e) => (
                      <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge variant="outline" className="text-[10px]">{e.category}</Badge>
                        <span className="line-clamp-1">{e.title}</span>
                        <span className="text-xs text-muted-foreground">
                          severity {e.severity ?? "—"} · confidence {e.confidence !== null ? `${Math.round(e.confidence * 100)}%` : "—"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="audit" className="space-y-4 pt-4">
          <SectionHeader title="Audit log" description="Recorded administrative and account activity." />
          {audit.isLoading ? (
            <TableSkeleton rows={5} />
          ) : audit.isError ? (
            <ErrorState title="We couldn't load the audit log" onRetry={() => audit.refetch()} />
          ) : (audit.data ?? []).length === 0 ? (
            <EmptyState title="No audit entries yet" description="Administrative activity will be recorded here." />
          ) : (
            <div className="panel overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">When</th>
                    <th className="px-4 py-3 font-medium">Actor</th>
                    <th className="px-4 py-3 font-medium">Action</th>
                    <th className="px-4 py-3 font-medium">Entity</th>
                    <th className="px-4 py-3 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {(audit.data ?? []).map((entry) => (
                    <tr key={entry.id} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-3 text-xs text-muted-foreground">{formatDateTime(entry.createdAt)}</td>
                      <td className="px-4 py-3">{entry.actor}</td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-[10px]">
                          {entry.action}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {entry.entity} <span className="num text-xs">#{entry.entityId}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{entry.details || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
