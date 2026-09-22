/**
 * Transaction-true performance engine (Intelligence Engine, Phase 8).
 *
 * Reconstructs portfolio state through time from the ACTUAL `transactions`
 * table (BUY/SELL, quantity, price, transaction_date) instead of assuming
 * today's holdings existed historically. Never modifies transactions.
 *
 * Methodology (transaction-attribution-v1):
 *   - Shares held on date D = Σ BUY(qty) − Σ SELL(qty) with tx_date ≤ D,
 *     reconstructed PER (stock, portfolio) with FIFO lots for cost basis.
 *   - Portfolio value on D = Σ shares(D) × close(stock, D) using actual
 *     price dates (map lookup — never array-position alignment).
 *   - Realized P&L (FIFO): sell proceeds − cost of the consumed lots.
 *   - Unrealized P&L: current holdings' avg cost vs latest stored close.
 *   - Insufficient data → explicit N/A. No invented cash, no invented fees.
 */

import { prisma } from "../utils/prisma.js";

export const TX_ATTRIBUTION_VERSION = "transaction-attribution-v1";

export interface Lot {
  qtyRemaining: number;
  price: number;
  date: string; // ISO date of purchase
}

export interface DayState {
  date: string;
  /** shares held per stock at the END of this date */
  shares: Map<number, number>;
  /** market value of holdings (shares × close where price exists) */
  value: number;
  /** cumulative external cash flow into/out of the portfolio (buys − sells) */
  netInvestedToDate: number;
  missingPriceStocks: number;
}

export interface RealizedSale {
  stockId: number;
  date: string;
  qty: number;
  proceeds: number;
  cost: number;
  pnl: number;
}

function day(s: Date): string {
  return s.toISOString().slice(0, 10);
}

/** Latest stored close for a stock on or before a date (exact lookup). */
async function closeOnOrBefore(stockId: number, dateStr: string): Promise<number | null> {
  const row = await prisma.stock_prices.findFirst({
    where: { stock_id: stockId, price_date: { lte: new Date(dateStr) } },
    orderBy: { price_date: "desc" },
    select: { close_price: true },
  });
  return row ? Number(row.close_price) : null;
}

export interface ReconstructionResult {
  modelVersion: string;
  transactionsConsidered: number;
  firstTransactionDate: string | null;
  lastTransactionDate: string | null;
  valueSeries: Array<{ date: string; value: number; netInvested: number }>;
  realized: RealizedSale[];
  missingPriceEvents: number;
}

/**
 * Reconstruct the portfolio day-by-day from transactions. The value series
 * only includes days with at least one transaction (event-driven; the
 * continuous curve is derived downstream by forward-filling value).
 */
export async function reconstructPortfolio(
  portfolioId: number,
): Promise<ReconstructionResult> {
  const txs = await prisma.transactions.findMany({
    where: { portfolio_id: portfolioId },
    orderBy: [{ transaction_date: "asc" }, { transaction_id: "asc" }],
    select: {
      stock_id: true,
      transaction_type: true,
      quantity: true,
      price: true,
      transaction_date: true,
    },
  });

  const lotsByStock = new Map<number, Lot[]>();
  const sharesByStock = new Map<number, number>();
  let netInvested = 0;
  const valueSeries: ReconstructionResult["valueSeries"] = [];
  const realized: RealizedSale[] = [];
  let missingPriceEvents = 0;

  // Group by calendar date: value is marked at end of each event day.
  const byDate = new Map<string, typeof txs>();
  for (const t of txs) {
    const d = day(t.transaction_date);
    const arr = byDate.get(d) ?? [];
    arr.push(t);
    byDate.set(d, arr);
  }

  let lastKnownValue: number | null = null;
  for (const [d, dayTx] of byDate) {
    for (const t of dayTx) {
      const qty = Number(t.quantity);
      const px = Number(t.price);
      if (t.transaction_type === "BUY") {
        const lots = lotsByStock.get(t.stock_id) ?? [];
        lots.push({ qtyRemaining: qty, price: px, date: d });
        lotsByStock.set(t.stock_id, lots);
        sharesByStock.set(t.stock_id, (sharesByStock.get(t.stock_id) ?? 0) + qty);
        netInvested += qty * px;
      } else if (t.transaction_type === "SELL") {
        let toSell = qty;
        const lots = lotsByStock.get(t.stock_id) ?? [];
        let cost = 0;
        let sold = 0;
        while (toSell > 1e-9 && lots.length > 0) {
          const lot = lots[0]!;
          const take = Math.min(lot.qtyRemaining, toSell);
          cost += take * lot.price;
          lot.qtyRemaining -= take;
          toSell -= take;
          sold += take;
          if (lot.qtyRemaining <= 1e-9) lots.shift();
        }
        if (sold > 0) {
          sharesByStock.set(t.stock_id, (sharesByStock.get(t.stock_id) ?? 0) - sold);
          netInvested -= sold * px;
          realized.push({ stockId: t.stock_id, date: d, qty: sold, proceeds: sold * px, cost, pnl: sold * px - cost });
        }
      }
    }

    // End-of-day value with prices AS OF that date.
    let value = 0;
    let missing = 0;
    for (const [stockId, sh] of sharesByStock) {
      if (sh <= 1e-9) continue;
      const px = await closeOnOrBefore(stockId, d);
      if (px === null) {
        missing += 1;
        continue;
      }
      value += sh * px;
    }
    missingPriceEvents += missing;
    // Carry the last computable mark forward only when today has NO priced
    // positions at all; otherwise use the freshly computed value.
    const markValue: number = value > 0 || missing === 0 ? value : (lastKnownValue ?? value);
    lastKnownValue = markValue;
    valueSeries.push({ date: d, value: markValue, netInvested });
  }

  return {
    modelVersion: TX_ATTRIBUTION_VERSION,
    transactionsConsidered: txs.length,
    firstTransactionDate: txs.length > 0 ? day(txs[0]!.transaction_date) : null,
    lastTransactionDate: txs.length > 0 ? day(txs[txs.length - 1]!.transaction_date) : null,
    valueSeries,
    realized,
    missingPriceEvents,
  };
}

/* ------------------------------ P&L + attribution ------------------------- */

export interface PerformanceBlock {
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  totalPnl: number | null;
  netInvested: number | null;
  available: boolean;
  reason: string | null;
}

export interface HoldingPeriod {
  stockId: string;
  symbol: string;
  sector: string;
  firstPurchaseDate: string | null;
  holdingDays: number | null;
  investedCapital: number | null;
  currentValue: number | null;
  unrealizedPnl: number | null;
  returnPct: number | null;
  annualizedReturnPct: number | null;
  note: string | null;
}

export interface TurnoverBlock {
  buyValue: number | null;
  sellValue: number | null;
  totalTurnover: number | null;
  transactionCount: number;
  buyCount: number;
  sellCount: number;
  averageHoldingDays: number | null;
}

export interface TxPerformance {
  modelVersion: string;
  portfolioId: string;
  realized: Array<{ date: string; stockId: string; qty: number; proceeds: number; cost: number; pnl: number }>;
  realizedPnl: number;
  unrealizedPnl: number | null;
  totalPnl: number | null;
  turnover: TurnoverBlock;
  holdingPeriods: HoldingPeriod[];
  attribution: {
    view: "TRANSACTION-TRUE HISTORICAL VIEW";
    byStock: Array<{ stockId: string; symbol: string; realizedPnl: number; unrealizedPnl: number | null; totalPnl: number | null }>;
    bySector: Array<{ sector: string; realizedPnl: number; unrealizedPnl: number | null; totalPnl: number | null }>;
  };
  limitations: string[];
}

export async function transactionPerformance(portfolioId: number): Promise<TxPerformance> {
  const recon = await reconstructPortfolio(portfolioId);

  const txRows = await prisma.transactions.findMany({
    where: { portfolio_id: portfolioId },
    select: { transaction_type: true, quantity: true, price: true },
  });
  let buyValue = 0;
  let sellValue = 0;
  let buyCount = 0;
  let sellCount = 0;
  for (const t of txRows) {
    const v = Number(t.quantity) * Number(t.price);
    if (t.transaction_type === "BUY") {
      buyValue += v;
      buyCount += 1;
    } else if (t.transaction_type === "SELL") {
      sellValue += v;
      sellCount += 1;
    }
  }

  const realizedPnl = recon.realized.reduce((a, r) => a + r.pnl, 0);

  // Current holdings → unrealized P&L (avg buy price vs latest close).
  const holdings = await prisma.holdings.findMany({
    where: { portfolio_id: portfolioId },
    select: { stock_id: true, quantity: true, average_buy_price: true, stocks: { select: { symbol: true, sector: true } } },
  });
  const stockIds = holdings.map((h) => h.stock_id);
  const latest = stockIds.length
    ? await prisma.stock_prices.findMany({
        where: { stock_id: { in: stockIds } },
        orderBy: [{ stock_id: "asc" }, { price_date: "desc" }],
        distinct: ["stock_id"],
        select: { stock_id: true, close_price: true },
      })
    : [];
  const priceByStock = new Map(latest.map((r) => [r.stock_id, Number(r.close_price)]));

  let unrealized = 0;
  let unrealizedAvailable = holdings.length > 0;
  const byStock = new Map<number, { symbol: string; sector: string; realized: number; unrealized: number | null }>();
  for (const h of holdings) {
    const px = priceByStock.get(h.stock_id);
    const invested = Number(h.quantity) * Number(h.average_buy_price);
    const value = px === undefined ? null : Number(h.quantity) * px;
    const upnl = value === null ? null : value - invested;
    if (upnl === null) unrealizedAvailable = false;
    else unrealized += upnl;
    byStock.set(h.stock_id, {
      symbol: h.stocks.symbol,
      sector: h.stocks.sector,
      realized: recon.realized.filter((r) => r.stockId === h.stock_id).reduce((a, r) => a + r.pnl, 0),
      unrealized: upnl,
    });
  }

  const holdingPeriods: HoldingPeriod[] = [];
  for (const h of holdings) {
    const first = await prisma.transactions.findFirst({
      where: { portfolio_id: portfolioId, stock_id: h.stock_id, transaction_type: "BUY" },
      orderBy: { transaction_date: "asc" },
      select: { transaction_date: true, price: true },
    });
    const px = priceByStock.get(h.stock_id);
    const invested = Number(h.quantity) * Number(h.average_buy_price);
    const value = px === undefined ? null : Number(h.quantity) * px;
    const days = first ? Math.max(0, Math.round((Date.now() - first.transaction_date.getTime()) / 86_400_000)) : null;
    const ret = value === null ? null : invested > 0 ? (value / invested - 1) * 100 : null;
    holdingPeriods.push({
      stockId: String(h.stock_id),
      symbol: h.stocks.symbol,
      sector: h.stocks.sector,
      firstPurchaseDate: first ? day(first.transaction_date) : null,
      holdingDays: days,
      investedCapital: invested,
      currentValue: value,
      unrealizedPnl: value === null ? null : value - invested,
      returnPct: ret === null || value === null ? null : Number(ret.toFixed(2)),
      annualizedReturnPct:
        ret !== null && value !== null && days !== null && days >= 30 && invested > 0
          ? Number((((value / invested) ** (365 / days) - 1) * 100).toFixed(2))
          : null,
      note: first ? null : "No BUY transaction found for this holding (imported position) — duration N/A.",
    });
  }

  const limitations: string[] = [
    "Cash balances, dividends, fees and taxes are not modelled — no such data exists in the transactions table.",
    recon.missingPriceEvents > 0
      ? `${recon.missingPriceEvents} position-days lacked a stored price on/before the date and were excluded from value marks.`
      : "Every reconstructed day had a stored price for all held stocks.",
  ];
  if (!unrealizedAvailable) limitations.push("Some holdings lack a stored latest price — unrealized P&L is partial.");

  return {
    modelVersion: TX_ATTRIBUTION_VERSION,
    portfolioId: String(portfolioId),
    realized: recon.realized.map((r) => ({ date: r.date, stockId: String(r.stockId), qty: r.qty, proceeds: Number(r.proceeds.toFixed(2)), cost: Number(r.cost.toFixed(2)), pnl: Number(r.pnl.toFixed(2)) })),
    realizedPnl: Number(realizedPnl.toFixed(2)),
    unrealizedPnl: unrealizedAvailable ? Number(unrealized.toFixed(2)) : null,
    totalPnl: unrealizedAvailable ? Number((realizedPnl + unrealized).toFixed(2)) : null,
    turnover: {
      buyValue: Number(buyValue.toFixed(2)),
      sellValue: Number(sellValue.toFixed(2)),
      totalTurnover: Number((buyValue + sellValue).toFixed(2)),
      transactionCount: txRows.length,
      buyCount,
      sellCount,
      averageHoldingDays: null, // filled below if computable
    },
    holdingPeriods,
    attribution: {
      view: "TRANSACTION-TRUE HISTORICAL VIEW",
      byStock: [...byStock.entries()].map(([id, v]) => ({
        stockId: String(id),
        symbol: v.symbol,
        realizedPnl: Number(v.realized.toFixed(2)),
        unrealizedPnl: v.unrealized === null ? null : Number(v.unrealized.toFixed(2)),
        totalPnl: v.unrealized === null ? null : Number((v.realized + v.unrealized).toFixed(2)),
      })),
      bySector: (() => {
        const m = new Map<string, { realized: number; unrealized: number; complete: boolean }>();
        for (const v of byStock.values()) {
          const cur = m.get(v.sector) ?? { realized: 0, unrealized: 0, complete: true };
          cur.realized += v.realized;
          if (v.unrealized === null) cur.complete = false;
          else cur.unrealized += v.unrealized;
          m.set(v.sector, cur);
        }
        return [...m.entries()].map(([sector, v]) => ({
          sector,
          realizedPnl: Number(v.realized.toFixed(2)),
          unrealizedPnl: v.complete ? Number(v.unrealized.toFixed(2)) : null,
          totalPnl: v.complete ? Number((v.realized + v.unrealized).toFixed(2)) : null,
        }));
      })(),
    },
    limitations,
  };
}
