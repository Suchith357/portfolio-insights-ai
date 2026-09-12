/**
 * Admin — maps to `/api/admin` on the Express backend.
 * Route visibility is a UX concern only; the backend enforces the ADMIN role
 * on every one of these endpoints.
 */
import { ADMIN_USER_LIST, DEMO_AUDIT_LOG, STOCKS } from "@/lib/demo-data";
import type { AuditLogEntry, Stock, User } from "@/types";
import { USE_DEMO_DATA, apiRequest, delay } from "./api-client";
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
  if (USE_DEMO_DATA) {
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
  return apiRequest<AdminStats>("/admin/stats");
}

export async function listUsers(): Promise<User[]> {
  if (USE_DEMO_DATA) return delay(ADMIN_USER_LIST);
  return apiRequest<User[]>("/admin/users");
}

export async function listManagedStocks(): Promise<Stock[]> {
  if (USE_DEMO_DATA) return delay(STOCKS);
  return apiRequest<Stock[]>("/admin/stocks");
}

export async function listAuditLog(): Promise<AuditLogEntry[]> {
  if (USE_DEMO_DATA) return delay(DEMO_AUDIT_LOG);
  return apiRequest<AuditLogEntry[]>("/admin/audit-logs");
}
