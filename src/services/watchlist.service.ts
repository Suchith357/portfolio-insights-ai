/** Watchlist — maps to `/api/watchlist` on the Express backend. */
import type { WatchlistItem } from "@/types";
import { ApiError, USE_DEMO_DATA, apiRequest, delay } from "./api-client";
import { db, nextId, persist } from "./demo-store";

export async function listWatchlist(userId: string): Promise<WatchlistItem[]> {
  if (USE_DEMO_DATA) return delay(db().watchlist.filter((w) => w.userId === userId));
  void userId; // backend resolves the user from the JWT
  return apiRequest<WatchlistItem[]>("/watchlist");
}

export async function addToWatchlist(userId: string, symbol: string): Promise<WatchlistItem> {
  if (USE_DEMO_DATA) {
    const store = db();
    if (store.watchlist.some((w) => w.userId === userId && w.symbol === symbol)) {
      throw new ApiError("That stock is already on your watchlist.", 409);
    }
    const item: WatchlistItem = { id: nextId("wl"), userId, symbol, addedAt: new Date().toISOString() };
    store.watchlist.push(item);
    persist();
    return delay(item, 250);
  }
  void userId;
  return apiRequest<WatchlistItem>("/watchlist", {
    method: "POST",
    body: JSON.stringify({ symbol: symbol.toUpperCase() }),
  });
}

export async function removeFromWatchlist(id: string): Promise<void> {
  if (USE_DEMO_DATA) {
    const store = db();
    store.watchlist = store.watchlist.filter((w) => w.id !== id);
    persist();
    await delay(null, 250);
    return;
  }
  // Backend watchlist rows are addressed by their own id.
  await apiRequest<{ deleted: boolean }>(`/watchlist/${id}`, { method: "DELETE" });
}
