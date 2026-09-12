import { prisma } from "../utils/prisma.js";
import { toPortfolioDto, type PortfolioDto } from "../utils/mappers.js";
import { notFound } from "../utils/http.js";
import { recordAudit } from "../utils/audit.js";

async function requireOwnedPortfolio(userId: number, portfolioId: number) {
  const portfolio = await prisma.portfolios.findUnique({ where: { portfolio_id: portfolioId } });
  if (!portfolio || portfolio.user_id !== userId) {
    // Both "missing" and "someone else's" collapse to 404 — no existence leak.
    throw notFound("We couldn't find that portfolio.");
  }
  return portfolio;
}

export async function listPortfolios(userId: number): Promise<PortfolioDto[]> {
  const rows = await prisma.portfolios.findMany({
    where: { user_id: userId },
    orderBy: { created_at: "asc" },
  });
  return rows.map(toPortfolioDto);
}

export async function getPortfolio(userId: number, portfolioId: number): Promise<PortfolioDto> {
  const portfolio = await requireOwnedPortfolio(userId, portfolioId);
  return toPortfolioDto(portfolio);
}

export async function createPortfolio(
  userId: number,
  input: { name: string; description?: string },
): Promise<PortfolioDto> {
  const portfolio = await prisma.portfolios.create({
    data: {
      user_id: userId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
    },
  });

  await recordAudit({
    userId,
    action: "PORTFOLIO_CREATE",
    entityType: "PORTFOLIO",
    entityId: portfolio.portfolio_id,
    details: `Created ${portfolio.name}.`,
  });

  return toPortfolioDto(portfolio);
}

export async function updatePortfolio(
  userId: number,
  portfolioId: number,
  patch: { name?: string; description?: string },
): Promise<PortfolioDto> {
  const portfolio = await requireOwnedPortfolio(userId, portfolioId);

  const updated = await prisma.portfolios.update({
    where: { portfolio_id: portfolio.portfolio_id },
    data: {
      name: patch.name?.trim(),
      description: patch.description !== undefined ? patch.description.trim() || null : undefined,
    },
  });

  await recordAudit({
    userId,
    action: "PORTFOLIO_UPDATE",
    entityType: "PORTFOLIO",
    entityId: portfolio.portfolio_id,
    details: `Updated ${updated.name}.`,
  });

  return toPortfolioDto(updated);
}

export async function deletePortfolio(userId: number, portfolioId: number): Promise<void> {
  const portfolio = await requireOwnedPortfolio(userId, portfolioId);

  // holdings / transactions / alerts / analyses cascade via FK (ON DELETE CASCADE).
  await prisma.portfolios.delete({ where: { portfolio_id: portfolio.portfolio_id } });

  await recordAudit({
    userId,
    action: "PORTFOLIO_DELETE",
    entityType: "PORTFOLIO",
    entityId: portfolio.portfolio_id,
    details: `Deleted ${portfolio.name}.`,
  });
}
