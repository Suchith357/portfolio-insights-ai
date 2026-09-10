import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DemoDataBadge, SectionHeader, StatCard } from "@/components/common/data-display";
import { CardsSkeleton, EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { ErrorState as Forbidden } from "@/components/common/states";
import { formatCurrency, formatDateTime, formatDate } from "@/lib/format";
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
        <DemoDataBadge />
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
              sub={`${stats.data.activeUsers} active · ${stats.data.suspendedUsers} suspended`}
            />
            <StatCard label="Portfolios" value={String(stats.data.totalPortfolios)} />
            <StatCard label="Holdings" value={String(stats.data.totalHoldings)} />
            <StatCard label="Transactions" value={String(stats.data.totalTransactions)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Stocks in catalogue" value={String(stats.data.totalStocks)} />
            <StatCard label="Alerts published" value={String(stats.data.totalAlerts)} />
          </div>
        </>
      ) : null}

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="stocks">Stock catalogue</TabsTrigger>
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
                    <th className="px-4 py-3 font-medium">Status</th>
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
                      <td className="px-4 py-3">
                        <span
                          className={
                            u.status === "ACTIVE"
                              ? "rounded-full border border-gain/40 bg-gain/10 px-2 py-0.5 text-[11px] font-semibold text-gain"
                              : "rounded-full border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive"
                          }
                        >
                          {u.status}
                        </span>
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
            description="Reference data the analytics engine reads. Prices are synthetic demo values."
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
                    <th className="px-4 py-3 font-medium">Demo price</th>
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
                      <td className="num px-4 py-3">{formatCurrency(s.lastPrice)}</td>
                      <td className="num px-4 py-3">₹{s.marketCapCr.toLocaleString("en-IN")} Cr</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
                    <th className="px-4 py-3 font-medium">IP</th>
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
                      <td className="num px-4 py-3 text-xs text-muted-foreground">{entry.ip}</td>
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
