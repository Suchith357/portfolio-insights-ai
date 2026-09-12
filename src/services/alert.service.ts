/** News & risk alerts — maps to `/api/alerts` on the Express backend. */
import type { Alert } from "@/types";
import { USE_DEMO_DATA, apiRequest, delay } from "./api-client";
import { db } from "./demo-store";

export async function listAlerts(): Promise<Alert[]> {
  if (USE_DEMO_DATA) {
    return delay([...db().alerts].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)));
  }
  return apiRequest<Alert[]>("/alerts");
}

export async function listAlertsForSymbols(symbols: string[]): Promise<Alert[]> {
  const rows = await listAlerts();
  const set = new Set(symbols);
  return rows.filter((a) => a.symbol !== null && set.has(a.symbol));
}

export async function markAlertRead(id: string): Promise<Alert> {
  return apiRequest<Alert>(`/alerts/${id}/read`, { method: "PATCH" });
}

export async function markAllAlertsRead(): Promise<{ updated: number }> {
  return apiRequest<{ updated: number }>("/alerts/read-all", { method: "PATCH" });
}
