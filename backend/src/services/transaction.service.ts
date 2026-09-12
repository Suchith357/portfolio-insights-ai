import { prisma } from "../utils/prisma.js";
import { toTransactionDto, type TransactionDto } from "../utils/mappers.js";
import { badRequest, notFound } from "../utils/http.js";
import { recordAudit } from "../utils/audit.js";

export async function listAllTransactions(userId: number): Promise<TransactionDto[]> {
  const rows = await prisma.transactions.findMany({
    where: { portfolios: { user_id: userId } },
    include: { stocks: { select: { symbol: true } } },
    orderBy: [{ transaction_date: "desc" }, { transaction_id: "desc" }],
  });
  return rows.map((t) => toTransactionDto(t, t.stocks.symbol));
}

export async function listPortfolioTransactions(
  userId: number,
  portfolioId: number,
): Promise<TransactionDto[]> {
  const portfolio = await prisma.portfolios.findUnique({ where: { portfolio_id: portfolioId } });
  if (!portfolio || portfolio.user_id !== userId) {
    throw notFound("We couldn't find that portfolio.");
  }
  const rows = await prisma.transactions.findMany({
    where: { portfolio_id: portfolioId },
    include: { stocks: { select: { symbol: true } } },
    orderBy: [{ transaction_date: "desc" }, { transaction_id: "desc" }],
  });
  return rows.map((t) => toTransactionDto(t, t.stocks.symbol));
}

interface CreateInput {
  portfolioId: number;
  stockId?: number;
  symbol?: string;
  type: "BUY" | "SELL";
  quantity: number;
  price: number;
  executedAt?: string;
}

const QUANTITY_EPSILON = 0.0001;

/**
 * Records a real transaction and updates the holding atomically.
 *
 * BUY  → quantity up, average_buy_price = weighted average of old + new lots.
 * SELL → quantity down (rejected if it would go negative); the holding row is
 *        deleted when the position closes. History is never rewritten.
 */
export async function recordTransaction(userId: number, input: CreateInput): Promise<TransactionDto> {
  const portfolio = await prisma.portfolios.findUnique({ where: { portfolio_id: input.portfolioId } });
  if (!portfolio || portfolio.user_id !== userId) {
    throw notFound("We couldn't find that portfolio.");
  }

  const stock = input.stockId
    ? await prisma.stocks.findUnique({ where: { stock_id: input.stockId } })
    : await prisma.stocks.findFirst({
        where: { symbol: input.symbol?.toUpperCase() ?? "" },
      });
  if (!stock) throw notFound("We couldn't find that stock.");

  if (input.quantity <= 0) throw badRequest("Quantity must be greater than 0.");
  if (input.price <= 0) throw badRequest("Price must be greater than 0.");

  const transactionDate = input.executedAt ? new Date(input.executedAt) : new Date();
  if (Number.isNaN(transactionDate.getTime())) throw badRequest("The transaction date is not valid.");

  const result = await prisma.$transaction(async (tx) => {
    const holding = await tx.holdings.findFirst({
      where: { portfolio_id: portfolio.portfolio_id, stock_id: stock.stock_id },
    });

    if (input.type === "BUY") {
      if (holding) {
        const totalQty = Number(holding.quantity) + input.quantity;
        const weightedAvg =
          (Number(holding.quantity) * Number(holding.average_buy_price) + input.quantity * input.price) / totalQty;
        await tx.holdings.update({
          where: { holding_id: holding.holding_id },
          data: { quantity: totalQty, average_buy_price: weightedAvg },
        });
      } else {
        await tx.holdings.create({
          data: {
            portfolio_id: portfolio.portfolio_id,
            stock_id: stock.stock_id,
            quantity: input.quantity,
            average_buy_price: input.price,
          },
        });
      }
    } else {
      if (!holding) {
        throw badRequest("You don't hold this stock, so there is nothing to sell.");
      }
      const available = Number(holding.quantity);
      if (input.quantity > available + QUANTITY_EPSILON) {
        throw badRequest("You don't hold enough quantity to record this sale.");
      }
      const remaining = available - input.quantity;
      if (remaining <= QUANTITY_EPSILON) {
        await tx.holdings.delete({ where: { holding_id: holding.holding_id } });
      } else {
        await tx.holdings.update({
          where: { holding_id: holding.holding_id },
          data: { quantity: remaining },
        });
      }
    }

    return tx.transactions.create({
      data: {
        portfolio_id: portfolio.portfolio_id,
        stock_id: stock.stock_id,
        transaction_type: input.type,
        quantity: input.quantity,
        price: input.price,
        transaction_date: transactionDate,
      },
    });
  });

  await recordAudit({
    userId,
    action: "TRANSACTION_CREATE",
    entityType: "TRANSACTION",
    entityId: result.transaction_id,
    details: `${input.type} ${input.quantity} ${stock.symbol} @ ${input.price}.`,
  });

  return toTransactionDto(result, stock.symbol);
}
