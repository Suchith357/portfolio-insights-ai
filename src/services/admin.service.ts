/**
 * Admin — maps to `/api/admin`.
 * Route visibility is a UX concern only; the backend must enforce the ADMIN
 * role on every one of these endpoints.
 */
import { ADMIN_USER_LIST, DEMO_AUDIT_LOG, STOCKS } from "@/lib/demo-data";
import type { AuditLogEntry, Stock, User } from "@/types";
import { delay } from "./api-client";
import { db } from "./demo-store";

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
  const store = db();
  return delay({
    totalUsers: ADMIN_USER_LIST.length,
    totalPortfolios: store.portfolios.length,
    totalHoldings: store.holdings.length,
    totalTransactions: store.transactions.length,
    totalAlerts: store.alerts.length,
    totalStocks: STOCKS.length,
    activeUsers: ADMIN_USER_LIST.filter((u) => u.status === "ACTIVE").length,
    suspendedUsers: ADMIN_USER_LIST.filter((u) => u.status === "SUSPENDED").length,
  });
}

export async function listUsers(): Promise<User[]> {
  return delay(ADMIN_USER_LIST);
}

export async function listManagedStocks(): Promise<Stock[]> {
  return delay(STOCKS);
}

export async function listAuditLog(): Promise<AuditLogEntry[]> {
  return delay(DEMO_AUDIT_LOG);
}
