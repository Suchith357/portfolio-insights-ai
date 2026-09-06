/**
 * Analysis & simulation — maps to `/api/analysis`.
 *
 * IMPORTANT: every function here is read-only. Simulations never write a
 * transaction and never change a holding.
 */
import { portfolioCorrelation, simulateBuy, simulateSell } from "@/lib/analytics";
import type { BuySimulationResult, Holding, SellSimulationResult } from "@/types";
import { delay } from "./api-client";

export async function runBuySimulation(
  holdings: Holding[],
  symbol: string,
  amount: number,
): Promise<BuySimulationResult> {
  return delay(simulateBuy(holdings, symbol, amount), 450);
}

export async function runSellSimulation(
  holdings: Holding[],
  holdingId: string,
  pct: number,
): Promise<SellSimulationResult> {
  return delay(simulateSell(holdings, holdingId, pct), 450);
}

export function correlationWithPortfolio(holdings: Holding[], symbol: string): number | null {
  return portfolioCorrelation(holdings, symbol);
}
