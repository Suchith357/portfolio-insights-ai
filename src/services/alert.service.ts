/** News & risk alerts — maps to `/api/alerts`. Sample events, not live news. */
import type { Alert } from "@/types";
import { delay } from "./api-client";
import { db } from "./demo-store";

export async function listAlerts(): Promise<Alert[]> {
  return delay([...db().alerts].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)));
}

export async function listAlertsForSymbols(symbols: string[]): Promise<Alert[]> {
  const set = new Set(symbols);
  const rows = await listAlerts();
  return rows.filter((a) => set.has(a.symbol));
}
