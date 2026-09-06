/** Watchlist — maps to `/api/watchlist`. */
import type { WatchlistItem } from "@/types";
import { ApiError, delay } from "./api-client";
import { db, nextId, persist } from "./demo-store";

export async function listWatchlist(userId: string): Promise<WatchlistItem[]> {
  return delay(db().watchlist.filter((w) => w.userId === userId));
}

export async function addToWatchlist(userId: string, symbol: string): Promise<WatchlistItem> {
  const store = db();
  if (store.watchlist.some((w) => w.userId === userId && w.symbol === symbol)) {
    throw new ApiError("That stock is already on your watchlist.", 409);
  }
  const item: WatchlistItem = { id: nextId("wl"), userId, symbol, addedAt: new Date().toISOString() };
  store.watchlist.push(item);
  persist();
  return delay(item, 250);
}

export async function removeFromWatchlist(id: string): Promise<void> {
  const store = db();
  store.watchlist = store.watchlist.filter((w) => w.id !== id);
  persist();
  await delay(null, 250);
}
