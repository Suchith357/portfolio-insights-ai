import { prisma } from "../utils/prisma.js";
import { badRequest, notFound } from "../utils/http.js";
import { recordAudit } from "../utils/audit.js";

export interface ImportRow {
  symbol: string;
  quantity: number;
  price: number;
  date?: string;
}

export interface ImportError {
  row: number;
  symbol: string | null;
  reason: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  transactionsCreated: number;
  errors: ImportError[];
}

const QUANTITY_EPSILON = 0.0001;

/**
 * Imports holdings for one owned portfolio.
 *
 * Every valid row becomes a BUY transaction plus an upsert of the holding
 * (weighted-average price when the position already exists). All rows commit
 * in a single database transaction so a failure cannot leave the portfolio
 * half-imported. Invalid rows are skipped with an explicit reason — nothing
 * is silently discarded.
 */
export async function importHoldings(
  userId: number,
  portfolioId: number,
  rows: ImportRow[],
): Promise<ImportResult> {
  const portfolio = await prisma.portfolios.findUnique({ where: { portfolio_id: portfolioId } });
  if (!portfolio || portfolio.user_id !== userId) {
    throw notFound("We couldn't find that portfolio.");
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw badRequest("No rows were provided to import.");
  }
  if (rows.length > 500) {
    throw badRequest("Import is limited to 500 rows per file.");
  }

  const errors: ImportError[] = [];
  const valid: ImportRow[] = [];

  rows.forEach((row, index) => {
    const rowNo = index + 1;
    const symbol = typeof row.symbol === "string" ? row.symbol.trim().toUpperCase() : "";
    if (!symbol) {
      errors.push({ row: rowNo, symbol: null, reason: "Missing symbol." });
      return;
    }
    const quantity = Number(row.quantity);
    const price = Number(row.price);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push({ row: rowNo, symbol, reason: "Quantity must be a number greater than 0." });
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      errors.push({ row: rowNo, symbol, reason: "Price must be a number greater than 0." });
      return;
    }
    if (row.date !== undefined && Number.isNaN(new Date(row.date).getTime())) {
      errors.push({ row: rowNo, symbol, reason: "The date column is not a valid date." });
      return;
    }
    valid.push({ symbol, quantity, price, date: row.date });
  });

  if (valid.length === 0) {
    return { imported: 0, skipped: rows.length, transactionsCreated: 0, errors };
  }

  // One catalogue lookup for all symbols; unknown symbols are skipped.
  const symbols = [...new Set(valid.map((r) => r.symbol))];
  const stocks = await prisma.stocks.findMany({ where: { symbol: { in: symbols } } });
  const stockIdBySymbol = new Map(stocks.map((s) => [s.symbol, s.stock_id]));

  const importable: Array<ImportRow & { stockId: number }> = [];
  for (const [index, row] of valid.entries()) {
    const stockId = stockIdBySymbol.get(row.symbol);
    if (stockId === undefined) {
      errors.push({
        row: rows.indexOf(row) + 1 > 0 ? findOriginalRowNo(rows, row) : index + 1,
        symbol: row.symbol,
        reason: "This symbol is not in the PortfolioIQ stock catalogue.",
      });
      continue;
    }
    importable.push({ ...row, stockId });
  }

  if (importable.length === 0) {
    return { imported: 0, skipped: rows.length, transactionsCreated: 0, errors };
  }

  const created = await prisma.$transaction(async (tx) => {
    let transactionsCreated = 0;
    for (const row of importable) {
      const holding = await tx.holdings.findFirst({
        where: { portfolio_id: portfolioId, stock_id: row.stockId },
      });

      if (holding) {
        const oldQty = Number(holding.quantity);
        const oldAvg = Number(holding.average_buy_price);
        const totalQty = oldQty + row.quantity;
        const weightedAvg = (oldQty * oldAvg + row.quantity * row.price) / totalQty;
        await tx.holdings.update({
          where: { holding_id: holding.holding_id },
          data: { quantity: totalQty, average_buy_price: weightedAvg },
        });
      } else {
        await tx.holdings.create({
          data: {
            portfolio_id: portfolioId,
            stock_id: row.stockId,
            quantity: row.quantity,
            average_buy_price: row.price,
          },
        });
      }

      await tx.transactions.create({
        data: {
          portfolio_id: portfolioId,
          stock_id: row.stockId,
          transaction_type: "BUY",
          quantity: row.quantity,
          price: row.price,
          transaction_date: row.date ? new Date(row.date) : new Date(),
        },
      });
      transactionsCreated += 1;
    }
    return transactionsCreated;
  });

  await recordAudit({
    userId,
    action: "IMPORT_HOLDINGS",
    entityType: "PORTFOLIO",
    entityId: portfolioId,
    details: `CSV import: ${created} positions imported into "${portfolio.name}" (${errors.length} rows skipped).`,
  });

  return {
    imported: importable.length,
    skipped: rows.length - importable.length,
    transactionsCreated: created,
    errors,
  };
}

/** Finds the original 1-based row number of a row (valid rows keep order). */
function findOriginalRowNo(all: ImportRow[], row: ImportRow): number {
  const idx = all.indexOf(row);
  return idx + 1;
}
