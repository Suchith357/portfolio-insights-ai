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
import type { Holding, Portfolio, PortfolioView, PricePoint, Transaction, TransactionType } from "@/types";
import { ApiError, USE_DEMO_DATA, apiRequest, delay } from "./api-client";
import { db, nextId, persist } from "./demo-store";

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
 * including the 52-week value series (valueSeries), so the chart reflects real
 * dataset prices rather than the demo generator.
 * Demo mode: the same shapes are derived client-side from the demo store.
 */
export interface AggregateView {
  holdings: ReturnType<typeof buildHoldingViews>;
  metrics: ReturnType<typeof metricsForHoldings>;
  raw: Holding[];
  valueSeries: PricePoint[];
}

export async function getAggregateView(userId: string): Promise<AggregateView> {
  if (USE_DEMO_DATA) {
    const holdings = await getAllHoldings(userId);
    return {
      holdings: buildHoldingViews(holdings),
      metrics: metricsForHoldings(holdings),
      raw: holdings,
      valueSeries: portfolioValueSeries(holdings),
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
