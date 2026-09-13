/**
 * Portfolios / holdings / transactions — maps to `/api/portfolios`,
 * `/api/holdings`, `/api/transactions`, `/api/analysis/overview` on the
 * Express backend.
 *
 * Portfolio views and aggregate dashboard metrics come from the backend
 * analytics engine, which reads real stock_prices from PostgreSQL. The
 * frontend analytics module is only used in offline demo mode.
 */
import { buildHoldingViews, metricsForHoldings, portfolioValueSeries } from "@/lib/analytics";
import type { Holding, ImportResult, Portfolio, PortfolioView, PricePoint, Transaction, TransactionType } from "@/types";
import { ApiError, USE_DEMO_DATA, apiRequest, apiRequestWithMeta, delay } from "./api-client";
import { db, nextId, persist } from "./demo-store";
import { STOCKS } from "@/lib/demo-data";
import { offlineExplainer } from "@/lib/ai-insights";

export async function listPortfolios(userId: string): Promise<Portfolio[]> {
  if (USE_DEMO_DATA) return delay(db().portfolios.filter((p) => p.userId === userId));
  // The backend resolves the user from the JWT.
  void userId;
  return apiRequest<Portfolio[]>("/portfolios");
}

export async function getPortfolioView(portfolioId: string): Promise<PortfolioView> {
  if (USE_DEMO_DATA) {
    const portfolio = db().portfolios.find((p) => p.id === portfolioId);
    if (!portfolio) throw new ApiError("We couldn't find that portfolio.", 404);
    const holdings = db().holdings.filter((h) => h.portfolioId === portfolioId);
    return delay({
      portfolio,
      holdings: buildHoldingViews(holdings),
      metrics: metricsForHoldings(holdings),
    });
  }
  return apiRequest<PortfolioView>(`/portfolios/${portfolioId}/analysis`);
}

export async function getAllHoldings(userId: string): Promise<Holding[]> {
  if (USE_DEMO_DATA) {
    const ids = new Set(db().portfolios.filter((p) => p.userId === userId).map((p) => p.id));
    return delay(db().holdings.filter((h) => ids.has(h.portfolioId)));
  }
  void userId;
  return apiRequest<Holding[]>("/holdings");
}

/**
 * Dashboard aggregate view.
 *
 * API mode: the backend analytics engine computes everything from PostgreSQL —
 * metrics, the AI explanation layer (insights) and the value series — plus a
 * `freshness` meta block describing the market-data sync state.
 * Demo mode: the same shapes are derived client-side from the demo store.
 */
export interface AggregateView {
  holdings: ReturnType<typeof buildHoldingViews>;
  metrics: ReturnType<typeof metricsForHoldings>;
  raw: Holding[];
  valueSeries: PricePoint[];
  insights: ReturnType<typeof offlineExplainer.explainPortfolio>;
}

export interface AggregateViewWithMeta {
  view: AggregateView;
  freshness: {
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
    running: boolean;
    dataSourceMix: { yahoo: number; demo: number };
  } | null;
}

export async function getAggregateViewWithMeta(userId: string): Promise<AggregateViewWithMeta> {
  if (USE_DEMO_DATA) {
    const view = await getAggregateView(userId);
    return { view, freshness: null };
  }
  const { data, meta } = await apiRequestWithMeta<AggregateView>("/analysis/overview");
  if (!data) throw new ApiError("The portfolio analytics service didn't respond.", 502);
  const freshness = (meta as { freshness?: AggregateViewWithMeta["freshness"] } | null)?.freshness ?? null;
  return { view: data, freshness };
}

export async function getAggregateView(userId: string): Promise<AggregateView> {
  if (USE_DEMO_DATA) {
    const holdings = await getAllHoldings(userId);
    return {
      holdings: buildHoldingViews(holdings),
      metrics: metricsForHoldings(holdings),
      raw: holdings,
      valueSeries: portfolioValueSeries(holdings),
      insights: offlineExplainer.explainPortfolio(metricsForHoldings(holdings)),
    };
  }
  return apiRequest<AggregateView>("/analysis/overview");
}

export async function createPortfolio(input: { userId: string; name: string; description: string }): Promise<Portfolio> {
  if (USE_DEMO_DATA) {
    const portfolio: Portfolio = {
      id: nextId("pf"),
      userId: input.userId,
      name: input.name.trim(),
      description: input.description.trim(),
      baseCurrency: "INR",
      createdAt: new Date().toISOString(),
    };
    db().portfolios.push(portfolio);
    persist();
    return delay(portfolio, 350);
  }
  void input.userId;
  return apiRequest<Portfolio>("/portfolios", {
    method: "POST",
    body: JSON.stringify({ name: input.name, description: input.description }),
  });
}

export async function updatePortfolio(id: string, patch: { name: string; description: string }): Promise<Portfolio> {
  if (USE_DEMO_DATA) {
    const p = db().portfolios.find((x) => x.id === id);
    if (!p) throw new ApiError("We couldn't find that portfolio.", 404);
    p.name = patch.name.trim();
    p.description = patch.description.trim();
    persist();
    return delay(p, 350);
  }
  return apiRequest<Portfolio>(`/portfolios/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deletePortfolio(id: string): Promise<void> {
  if (USE_DEMO_DATA) {
    const store = db();
    store.portfolios = store.portfolios.filter((p) => p.id !== id);
    store.holdings = store.holdings.filter((h) => h.portfolioId !== id);
    store.transactions = store.transactions.filter((t) => t.portfolioId !== id);
    persist();
    await delay(null, 350);
    return;
  }
  await apiRequest<{ deleted: boolean }>(`/portfolios/${id}`, { method: "DELETE" });
}

export async function listTransactions(portfolioId?: string): Promise<Transaction[]> {
  if (USE_DEMO_DATA) {
    const all = db().transactions;
    const rows = portfolioId ? all.filter((t) => t.portfolioId === portfolioId) : all;
    return delay([...rows].sort((a, b) => +new Date(b.executedAt) - +new Date(a.executedAt)));
  }
  const path = portfolioId ? `/transactions/portfolio/${portfolioId}` : "/transactions";
  return apiRequest<Transaction[]>(path);
}

export interface RecordTransactionInput {
  portfolioId: string;
  symbol: string;
  type: TransactionType;
  quantity: number;
  price: number;
  executedAt: string;
}

/**
 * Records a REAL transaction and updates holdings on the backend.
 * Simulations never call this — see `analysis.service.ts`.
 */
export async function recordTransaction(input: RecordTransactionInput): Promise<Transaction> {
  if (USE_DEMO_DATA) {
    const store = db();
    const holding = store.holdings.find((h) => h.portfolioId === input.portfolioId && h.symbol === input.symbol);

    if (input.type === "BUY") {
      if (holding) {
        const totalQty = holding.quantity + input.quantity;
        holding.avgBuyPrice = (holding.quantity * holding.avgBuyPrice + input.quantity * input.price) / totalQty;
        holding.quantity = totalQty;
      } else {
        store.holdings.push({
          id: nextId("hld"),
          portfolioId: input.portfolioId,
          symbol: input.symbol,
          quantity: input.quantity,
          avgBuyPrice: input.price,
        });
      }
    } else {
      if (!holding || holding.quantity < input.quantity) {
        throw new ApiError("You don't hold enough quantity to record this sale.", 400);
      }
      holding.quantity -= input.quantity;
      if (holding.quantity <= 0.0001) {
        store.holdings = store.holdings.filter((h) => h.id !== holding.id);
      }
    }

    const txn: Transaction = { id: nextId("txn"), ...input };
    store.transactions.push(txn);
    persist();
    return delay(txn, 350);
  }
  return apiRequest<Transaction>("/transactions", {
    method: "POST",
    body: JSON.stringify({
      portfolioId: input.portfolioId,
      symbol: input.symbol,
      type: input.type,
      quantity: input.quantity,
      price: input.price,
      executedAt: input.executedAt,
    }),
  });
}

export async function deleteHolding(holdingId: string): Promise<void> {
  if (USE_DEMO_DATA) {
    const store = db();
    store.holdings = store.holdings.filter((h) => h.id !== holdingId);
    persist();
    await delay(null, 300);
    return;
  }
  await apiRequest<{ deleted: boolean }>(`/holdings/${holdingId}`, { method: "DELETE" });
}

/**
 * CSV holdings import. The file is parsed client-side into typed rows; the
 * backend re-validates every row and writes holdings + BUY transactions
 * atomically. Invalid rows are skipped with explicit reasons.
 */
export async function importHoldings(portfolioId: string, rows: Array<{ symbol: string; quantity: number; price: number; date?: string }>): Promise<ImportResult> {
  if (USE_DEMO_DATA) {
    const store = db();
    let imported = 0;
    const errors: Array<{ row: number; symbol: string | null; reason: string }> = [];
    rows.forEach((row, i) => {
      const stock = STOCKS.find((s) => s.symbol === row.symbol.toUpperCase());
      if (!stock || row.quantity <= 0 || row.price <= 0) {
        errors.push({ row: i + 1, symbol: row.symbol || null, reason: !stock ? "Unknown symbol." : "Quantity and price must be greater than 0." });
        return;
      }
      const holding = store.holdings.find((h) => h.portfolioId === portfolioId && h.symbol === stock.symbol);
      if (holding) {
        const totalQty = holding.quantity + row.quantity;
        holding.avgBuyPrice = (holding.quantity * holding.avgBuyPrice + row.quantity * row.price) / totalQty;
        holding.quantity = totalQty;
      } else {
        store.holdings.push({ id: nextId("hld"), portfolioId, symbol: stock.symbol, quantity: row.quantity, avgBuyPrice: row.price });
      }
      store.transactions.push({ id: nextId("txn"), portfolioId, symbol: stock.symbol, type: "BUY", quantity: row.quantity, price: row.price, executedAt: row.date ?? new Date().toISOString() });
      imported += 1;
    });
    persist();
    return delay({ imported, skipped: rows.length - imported, transactionsCreated: imported, errors });
  }
  return apiRequest<ImportResult>(`/portfolios/${portfolioId}/import`, {
    method: "POST",
    body: JSON.stringify({ rows }),
  });
}
