/**
 * Admin — maps to `/api/admin` on the Express backend.
 * Route visibility is a UX concern only; the backend enforces the ADMIN role
 * on every one of these endpoints.
 */
import { ADMIN_USER_LIST, DEMO_AUDIT_LOG, STOCKS } from "@/lib/demo-data";
import type { AdminStats, AuditLogEntry, Stock, User } from "@/types";
import { USE_DEMO_DATA, apiRequest, delay } from "./api-client";
import { db } from "./demo-store";

export type { AdminStats };

export async function getStats(): Promise<AdminStats> {
  if (USE_DEMO_DATA) {
    const store = db();
    return delay({
      totalUsers: ADMIN_USER_LIST.length,
      userRoleUsers: ADMIN_USER_LIST.filter((u) => u.role === "USER").length,
      adminUsers: ADMIN_USER_LIST.filter((u) => u.role === "ADMIN").length,
      totalPortfolios: store.portfolios.length,
      totalHoldings: store.holdings.length,
      totalTransactions: store.transactions.length,
      totalAlerts: store.alerts.length,
      totalStocks: STOCKS.length,
      stocksUsingRealData: 0,
      lastMarketDataSync: null,
      lastMarketDataStatus: null,
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

/** Shape of GET /api/admin/market-data/status. */
export interface MarketDataSyncStatus {
  running: boolean;
  last: {
    id: string;
    triggerType: string;
    mode: string;
    status: "SUCCESS" | "PARTIAL" | "FAILED";
    startedAt: string;
    finishedAt: string | null;
    stocksProcessed: number;
    pricesUpserted: number;
    fundamentalsUpdated: number;
    failures: number;
    errorMessage: string | null;
  } | null;
}

/** Latest market-data sync state (ADMIN only). */
export async function getMarketDataStatus(): Promise<MarketDataSyncStatus> {
  return apiRequest<MarketDataSyncStatus>("/admin/market-data/status");
}

/** Triggers a manual refresh (ADMIN only); returns 202 with acceptance info. */
export async function triggerMarketDataSync(
  mode: "LATEST" | "FULL" = "LATEST",
  confirm = false,
): Promise<{ started: boolean; message: string }> {
  return apiRequest<MarketDataSyncStarted>(
    `/admin/market-data/sync?mode=${mode}${confirm ? "&confirm=true" : ""}`,
    { method: "POST" },
  );
}

interface MarketDataSyncStarted {
  started: boolean;
  message: string;
}
