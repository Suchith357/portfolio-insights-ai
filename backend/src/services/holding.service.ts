import { prisma } from "../utils/prisma.js";
import { toHoldingDto, type HoldingDto } from "../utils/mappers.js";
import { notFound } from "../utils/http.js";
import { recordAudit } from "../utils/audit.js";

/** Holdings are always scoped through an owned portfolio. */
export async function listAllHoldings(userId: number): Promise<HoldingDto[]> {
  const rows = await prisma.holdings.findMany({
    where: { portfolios: { user_id: userId } },
    include: { stocks: { select: { symbol: true } } },
    orderBy: { holding_id: "asc" },
  });
  return rows.map((h) => toHoldingDto(h, h.stocks.symbol));
}

export async function listPortfolioHoldings(userId: number, portfolioId: number): Promise<HoldingDto[]> {
  const portfolio = await prisma.portfolios.findUnique({ where: { portfolio_id: portfolioId } });
  if (!portfolio || portfolio.user_id !== userId) {
    throw notFound("We couldn't find that portfolio.");
  }
  const rows = await prisma.holdings.findMany({
    where: { portfolio_id: portfolioId },
    include: { stocks: { select: { symbol: true } } },
    orderBy: { holding_id: "asc" },
  });
  return rows.map((h) => toHoldingDto(h, h.stocks.symbol));
}

export async function getHolding(userId: number, holdingId: number): Promise<HoldingDto> {
  const row = await prisma.holdings.findFirst({
    where: { holding_id: holdingId, portfolios: { user_id: userId } },
    include: { stocks: { select: { symbol: true } } },
  });
  if (!row) {
    throw notFound("We couldn't find that holding.");
  }
  return toHoldingDto(row, row.stocks.symbol);
}

/** Manual removal of a position. The transaction history stays intact. */
export async function deleteHolding(userId: number, holdingId: number): Promise<void> {
  const row = await prisma.holdings.findFirst({
    where: { holding_id: holdingId, portfolios: { user_id: userId } },
    include: { stocks: { select: { symbol: true } } },
  });
  if (!row) {
    throw notFound("We couldn't find that holding.");
  }

  await prisma.holdings.delete({ where: { holding_id: row.holding_id } });

  await recordAudit({
    userId,
    action: "HOLDING_DELETE",
    entityType: "HOLDING",
    entityId: row.holding_id,
    details: `Removed position in ${row.stocks.symbol}.`,
  });
}
