import { Prisma } from "@prisma/client";
import { prisma } from "../utils/prisma.js";
import { toStockDto, toUserDto, type StockDto, type UserDto } from "../utils/mappers.js";
import { lastSync } from "./market-data.sync.js";

export interface AdminStats {
  totalUsers: number;
  userRoleUsers: number;
  adminUsers: number;
  totalPortfolios: number;
  totalHoldings: number;
  totalTransactions: number;
  totalAlerts: number;
  totalStocks: number;
  stocksUsingRealData: number;
  lastMarketDataSync: string | null;
  lastMarketDataStatus: string | null;
}

/**
 * Admin stats. Every number is a real database count — there is no account
 * suspension concept in this schema, so no "suspendedUsers" figure is faked;
 * "userRoleUsers" is labelled exactly as what it counts (accounts with the
 * USER role) and the UI calls it that.
 */
export async function getStats(): Promise<AdminStats> {
  const [users, portfolios, holdings, transactions, alerts, stocks, roleGroups, realDataMix, sync] =
    await Promise.all([
      prisma.users.count(),
      prisma.portfolios.count(),
      prisma.holdings.count(),
      prisma.transactions.count(),
      prisma.alerts.count(),
      prisma.stocks.count(),
      prisma.users.groupBy({ by: ["role"], _count: true }),
      prisma.stocks.groupBy({ by: ["data_source"], _count: true, where: { is_active: true } }),
      lastSync(),
    ]);

  return {
    totalUsers: users,
    userRoleUsers: roleGroups.find((r) => r.role === "USER")?._count ?? 0,
    adminUsers: roleGroups.find((r) => r.role === "ADMIN")?._count ?? 0,
    totalPortfolios: portfolios,
    totalHoldings: holdings,
    totalTransactions: transactions,
    totalAlerts: alerts,
    totalStocks: stocks,
    stocksUsingRealData: realDataMix.find((r) => r.data_source === "YAHOO")?._count ?? 0,
    lastMarketDataSync: sync?.finished_at?.toISOString() ?? null,
    lastMarketDataStatus: sync?.status ?? null,
  };
}

export interface AdminUserQuery {
  search?: string;
  page?: number;
  pageSize?: number;
}

/** Server-side paginated user listing. */
export async function listUsers(_adminId: number, query: AdminUserQuery): Promise<{ rows: UserDto[]; total: number; page: number; pageSize: number; pageCount: number }> {
  const term = (query.search ?? "").trim();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
  const where = term
    ? {
        OR: [
          { name: { contains: term, mode: "insensitive" as const } },
          { email: { contains: term, mode: "insensitive" as const } },
          { role: { contains: term, mode: "insensitive" as const } },
        ],
      }
    : {};
  const [total, rows] = await Promise.all([
    prisma.users.count({ where }),
    prisma.users.findMany({
      where,
      orderBy: { user_id: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return { rows: rows.map(toUserDto), total, page: Math.min(page, pageCount), pageSize, pageCount };
}

/** Admin catalogue listing includes inactive rows (management view). */
export async function listManagedStocks(): Promise<StockDto[]> {
  const stocks = await prisma.stocks.findMany({ orderBy: { symbol: "asc" } });

  // Latest + previous close per stock in ONE query using a window function —
  // no full price-table scan into application memory.
  const priceRows = await prisma.$queryRaw<Array<{ stock_id: number; close_price: unknown; rn: bigint }>>(
    Prisma.sql`
      SELECT stock_id, close_price, ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY price_date DESC) AS rn
      FROM stock_prices
    `,
  );
  const latest = new Map<number, number>();
  const prev = new Map<number, number>();
  for (const p of priceRows) {
    const id = p.stock_id;
    if (p.rn === 1n) latest.set(id, Number(p.close_price));
    else if (p.rn === 2n && !prev.has(id)) prev.set(id, Number(p.close_price));
  }

  return stocks.map((s) =>
    toStockDto(
      s,
      latest.get(s.stock_id) ?? null,
      prev.get(s.stock_id) ?? latest.get(s.stock_id) ?? null,
    ),
  );
}

/**
 * Audit listing. IPs are NOT persisted by design (privacy + no column), so no
 * fake IP value is emitted — the UI omits the column instead.
 */
export async function listAuditLogs(page = 1, pageSize = 50) {
  const p = Math.max(1, page);
  const size = Math.min(100, Math.max(1, pageSize));
  const [total, rows] = await Promise.all([
    prisma.audit_logs.count(),
    prisma.audit_logs.findMany({
      orderBy: { created_at: "desc" },
      skip: (p - 1) * size,
      take: size,
      include: { users: { select: { email: true } } },
    }),
  ]);
  return {
    rows: rows.map((r) => ({
      id: String(r.audit_id),
      actor: r.users?.email ?? "system",
      action: r.action,
      entity: r.entity_type,
      entityId: r.entity_id === null ? "" : String(r.entity_id),
      createdAt: r.created_at.toISOString(),
      details: r.details ?? "",
    })),
    total,
    page: p,
    pageSize: size,
    pageCount: Math.max(1, Math.ceil(total / size)),
  };
}
