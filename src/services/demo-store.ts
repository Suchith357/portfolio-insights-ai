/**
 * Local, browser-side stand-in for the PostgreSQL database.
 *
 * It exists only so the UI can be exercised end-to-end before the Express API
 * and Prisma schema land. It is deliberately isolated behind the service layer.
 */
import {
  DEMO_ALERTS,
  DEMO_HOLDINGS,
  DEMO_PORTFOLIOS,
  DEMO_TRANSACTIONS,
  DEMO_WATCHLIST,
} from "@/lib/demo-data";
import type { Alert, Holding, Portfolio, Transaction, WatchlistItem } from "@/types";

interface DemoDb {
  portfolios: Portfolio[];
  holdings: Holding[];
  transactions: Transaction[];
  watchlist: WatchlistItem[];
  alerts: Alert[];
}

const STORAGE_KEY = "portfolioiq.demo-db.v1";

function seed(): DemoDb {
  return {
    portfolios: structuredClone(DEMO_PORTFOLIOS),
    holdings: structuredClone(DEMO_HOLDINGS),
    transactions: structuredClone(DEMO_TRANSACTIONS),
    watchlist: structuredClone(DEMO_WATCHLIST),
    alerts: structuredClone(DEMO_ALERTS),
  };
}

let cache: DemoDb | null = null;

export function db(): DemoDb {
  if (cache) return cache;
  if (typeof window === "undefined") {
    cache = seed();
    return cache;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as DemoDb) : seed();
  } catch {
    cache = seed();
  }
  return cache;
}

export function persist() {
  if (typeof window === "undefined" || !cache) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* storage full or unavailable — demo data simply won't persist */
  }
}

export function resetDemoDb() {
  cache = seed();
  persist();
}

export function nextId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}
