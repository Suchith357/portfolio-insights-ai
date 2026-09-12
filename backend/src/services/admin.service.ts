import { prisma } from "../utils/prisma.js";
import { toStockDto, toUserDto, type StockDto, type UserDto } from "../utils/mappers.js";

export interface AdminStats {
  totalUsers: number;
  totalPortfolios: number;
  totalHoldings: number;
  totalTransactions: number;
  totalAlerts: number;
  totalStocks: number;
  activeUsers: number;
  suspendedUsers: number;
}

export async function getStats(): Promise<AdminStats> {
  const [users, portfolios, holdings, transactions, alerts, stocks] = await Promise.all([
    prisma.users.count(),
    prisma.portfolios.count(),
    prisma.holdings.count(),
    prisma.transactions.count(),
    prisma.alerts.count(),
    prisma.stocks.count(),
  ]);

  const roleGroups = await prisma.users.groupBy({ by: ["role"], _count: true });

  return {
    totalUsers: users,
    totalPortfolios: portfolios,
    totalHoldings: holdings,
    totalTransactions: transactions,
    totalAlerts: alerts,
    totalStocks: stocks,
    activeUsers: roleGroups.find((r) => r.role === "USER")?._count ?? 0,
    suspendedUsers: 0, // account status lives as an app-level flag; roles only in DB
  };
}

export async function listUsers(userId: number, search: string): Promise<UserDto[]> {
  const term = search.trim();
  const rows = await prisma.users.findMany({
    where: term
      ? {
          OR: [
            { name: { contains: term, mode: "insensitive" as const } },
            { email: { contains: term, mode: "insensitive" as const } },
            { role: { contains: term, mode: "insensitive" as const } },
          ],
        }
      : {},
    orderBy: { user_id: "asc" },
  });
  return rows.map(toUserDto);
}

export async function listManagedStocks(): Promise<StockDto[]> {
  const stocks = await prisma.stocks.findMany({ orderBy: { symbol: "asc" } });

  const priceRows = await prisma.stock_prices.findMany({
    orderBy: [{ stock_id: "asc" }, { price_date: "desc" }],
    select: { stock_id: true, close_price: true },
  });

  const latest = new Map<number, number>();
  const prev = new Map<number, number>();
  for (const p of priceRows) {
    if (!latest.has(p.stock_id)) {
      latest.set(p.stock_id, Number(p.close_price));
    } else if (!prev.has(p.stock_id)) {
      prev.set(p.stock_id, Number(p.close_price));
    }
  }

  return stocks.map((s) =>
    toStockDto(s, latest.get(s.stock_id) ?? 0, prev.get(s.stock_id) ?? latest.get(s.stock_id) ?? 0),
  );
}

export async function listAuditLogs() {
  const rows = await prisma.audit_logs.findMany({
    orderBy: { created_at: "desc" },
    take: 200,
    include: { users: { select: { email: true } } },
  });
  return rows.map((r) => ({
    id: String(r.audit_id),
    actor: r.users?.email ?? "system",
    action: r.action,
    entity: r.entity_type,
    entityId: r.entity_id === null ? "" : String(r.entity_id),
    createdAt: r.created_at.toISOString(),
    ip: "recorded", // request IPs are not persisted by design
  }));
}
