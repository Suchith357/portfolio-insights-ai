/** Portfolios / holdings / transactions — maps to `/api/portfolios`, `/api/holdings`, `/api/transactions`. */
import { buildHoldingViews, metricsForHoldings } from "@/lib/analytics";
import type { Holding, Portfolio, PortfolioView, Transaction, TransactionType } from "@/types";
import { ApiError, delay } from "./api-client";
import { db, nextId, persist } from "./demo-store";

export async function listPortfolios(userId: string): Promise<Portfolio[]> {
  return delay(db().portfolios.filter((p) => p.userId === userId));
}

export async function getPortfolioView(portfolioId: string): Promise<PortfolioView> {
  const portfolio = db().portfolios.find((p) => p.id === portfolioId);
  if (!portfolio) throw new ApiError("We couldn't find that portfolio.", 404);
  const holdings = db().holdings.filter((h) => h.portfolioId === portfolioId);
  return delay({
    portfolio,
    holdings: buildHoldingViews(holdings),
    metrics: metricsForHoldings(holdings),
  });
}

export async function getAllHoldings(userId: string): Promise<Holding[]> {
  const ids = new Set(db().portfolios.filter((p) => p.userId === userId).map((p) => p.id));
  return delay(db().holdings.filter((h) => ids.has(h.portfolioId)));
}

export async function getAggregateView(userId: string) {
  const holdings = await getAllHoldings(userId);
  return {
    holdings: buildHoldingViews(holdings),
    metrics: metricsForHoldings(holdings),
    raw: holdings,
  };
}

export async function createPortfolio(input: { userId: string; name: string; description: string }): Promise<Portfolio> {
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

export async function updatePortfolio(id: string, patch: { name: string; description: string }): Promise<Portfolio> {
  const p = db().portfolios.find((x) => x.id === id);
  if (!p) throw new ApiError("We couldn't find that portfolio.", 404);
  p.name = patch.name.trim();
  p.description = patch.description.trim();
  persist();
  return delay(p, 350);
}

export async function deletePortfolio(id: string): Promise<void> {
  const store = db();
  store.portfolios = store.portfolios.filter((p) => p.id !== id);
  store.holdings = store.holdings.filter((h) => h.portfolioId !== id);
  store.transactions = store.transactions.filter((t) => t.portfolioId !== id);
  persist();
  await delay(null, 350);
}

export async function listTransactions(portfolioId?: string): Promise<Transaction[]> {
  const all = db().transactions;
  const rows = portfolioId ? all.filter((t) => t.portfolioId === portfolioId) : all;
  return delay([...rows].sort((a, b) => +new Date(b.executedAt) - +new Date(a.executedAt)));
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
 * Records a REAL transaction and updates holdings.
 * Simulations never call this — see `analysis.service.ts`.
 */
export async function recordTransaction(input: RecordTransactionInput): Promise<Transaction> {
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

export async function deleteHolding(holdingId: string): Promise<void> {
  const store = db();
  store.holdings = store.holdings.filter((h) => h.id !== holdingId);
  persist();
  await delay(null, 300);
}
